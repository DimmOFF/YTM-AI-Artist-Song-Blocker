const REMOTE_URL = 'https://zoundhub.com/api/artists/all';

async function fetchArtists() {
    const response = await fetch(REMOTE_URL, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
}

// Groq — используется вкладкой Info в попапе для проверки текущего
// исполнителя. Ключ приходит от пользователя (хранится в
// chrome.storage.local, вводится в Settings), сюда передаётся прямо в
// сообщении — background.js сам ключ не хранит.
// Результат кэшируется в popup.js (по артисту, на 30 дней) — сюда
// background.js попадает только при промахе кэша.
// llama-3.1-8b-instant отключена Groq 16.08.2026 — используем их официальную
// замену (openai/gpt-oss-20b): сопоставимая по скорости/размеру production-модель.
const GROQ_MODEL = 'openai/gpt-oss-20b';

// 503/429/529 — временные ошибки (перегрузка/рейт-лимит самого провайдера),
// имеет смысл повторить запрос с небольшой паузой. Остальные коды
// (400/401/403 и т.п.) повторять бессмысленно — там проблема в самом
// запросе/ключе.
const RETRYABLE_STATUSES = new Set([503, 429, 529]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = [600, 1500]; // паузы перед 2-й и 3-й попыткой

// NEW: собственные лимиты запросов (независимо от лимитов самого Groq) —
// 15 в минуту и 500 в день. Состояние живёт в chrome.storage.local, а не
// в памяти service worker'а — иначе оно бы слетало при каждой выгрузке
// воркера (MV3 выгружает неактивные воркеры очень часто).
const RPM_LIMIT = 15;
const RPD_LIMIT = 500;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Вытаскивает человекочитаемое message из тела ошибки API
// (OpenAI-совместимый формат: {"error": {"message": "...", ...}}),
// чтобы в попапе не показывать сырой JSON.
function extractErrorMessage(status, bodyText) {
    try {
        const parsed = JSON.parse(bodyText);
        if (parsed && parsed.error && parsed.error.message) {
            return parsed.error.message;
        }
    } catch (e) { /* тело не JSON — используем как есть */ }
    return bodyText ? bodyText.slice(0, 200) : `HTTP ${status}`;
}

// Проверяет и тут же расходует один запрос из лимита RPM/RPD.
// Кидает ошибку с err.rateLimited = 'minute' | 'day', если лимит исчерпан.
async function checkAndConsumeRateLimit() {
    const data = await chrome.storage.local.get(['groqRateLimit']);
    const now = Date.now();
    const minuteKey = Math.floor(now / 60000);
    const dayKey = new Date(now).toLocaleDateString('en-CA'); // локальная дата YYYY-MM-DD

    let rl = data.groqRateLimit || {};
    if (rl.minuteKey !== minuteKey) { rl.minuteKey = minuteKey; rl.minuteCount = 0; }
    if (rl.dayKey !== dayKey) { rl.dayKey = dayKey; rl.dayCount = 0; }

    if ((rl.minuteCount || 0) >= RPM_LIMIT) {
        const err = new Error(`Too many requests — please wait a moment (limit: ${RPM_LIMIT}/min).`);
        err.rateLimited = 'minute';
        throw err;
    }
    if ((rl.dayCount || 0) >= RPD_LIMIT) {
        const err = new Error(`Daily request limit reached (${RPD_LIMIT}/day) — try again tomorrow.`);
        err.rateLimited = 'day';
        throw err;
    }

    rl.minuteCount = (rl.minuteCount || 0) + 1;
    rl.dayCount = (rl.dayCount || 0) + 1;
    await chrome.storage.local.set({ groqRateLimit: rl });
}

async function callGroqOnce(apiKey, prompt) {
    const response = await fetch(
        'https://api.groq.com/openai/v1/chat/completions',
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: GROQ_MODEL,
                messages: [{ role: 'user', content: prompt }],
                response_format: { type: 'json_object' } // Groq вернёт строго JSON, без ```-обёртки
            })
        }
    );

    if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        const err = new Error(extractErrorMessage(response.status, errBody));
        err.status = response.status;
        throw err;
    }

    return response.json();
}

async function fetchGroqVerdict(apiKey, artist, title) {
    if (!apiKey) throw new Error('No Groq API key set');

    // Лимиты расходуем ОДИН раз на логическую проверку трека, а не на
    // каждую повторную попытку внутри неё — иначе один ретрай «съедал» бы
    // сразу несколько запросов из квоты.
    await checkAndConsumeRateLimit();

    const prompt = `Is ${artist} - ${title} AI singer? Return result in JSON {"isAI": true/false, "reason": "..."} in reason write 2-3 sentence short info about this Artist`;

    let data;
    let lastErr;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            data = await callGroqOnce(apiKey, prompt);
            lastErr = null;
            break;
        } catch (err) {
            lastErr = err;
            const isLastAttempt = attempt === MAX_ATTEMPTS;
            if (!RETRYABLE_STATUSES.has(err.status) || isLastAttempt) {
                throw err; // не временная ошибка, или попытки кончились
            }
            console.warn(`[YTM Ward] Groq ${err.status} — повтор ${attempt}/${MAX_ATTEMPTS - 1}...`);
            await sleep(RETRY_DELAY_MS[attempt - 1]);
        }
    }
    if (lastErr) throw lastErr;

    const rawText = data?.choices?.[0]?.message?.content || '';
    const cleaned = rawText.replace(/```json|```/g, '').trim();

    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch (e) {
        throw new Error('Groq вернул не-JSON ответ');
    }

    return {
        isAI: parsed.isAI === true,
        reason: typeof parsed.reason === 'string' ? parsed.reason : ''
    };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'FETCH_AI_ARTISTS') {
        fetchArtists()
            .then(data => sendResponse({ ok: true, data }))
            .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
        return true;
    }

    if (message && message.type === 'FETCH_GROQ_VERDICT') {
        fetchGroqVerdict(message.apiKey, message.artist, message.title)
            .then(data => sendResponse({ ok: true, data }))
            .catch(err => sendResponse({ ok: false, error: err.message || String(err), rateLimited: err.rateLimited || null }));
        return true;
    }
});