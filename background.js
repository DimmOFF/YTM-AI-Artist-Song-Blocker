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

// --- Ссылки на соцсети: MusicBrainz ---
// Groq выдумывал URL (несуществующие сайты и профили), поэтому ссылки
// берём из MusicBrainz — там их вносят и проверяют люди. Если артиста
// нет в базе (типично для AI-исполнителей), ссылок просто не будет.
const MB_BASE = 'https://musicbrainz.org/ws/2';
const MB_MIN_INTERVAL_MS = 1100; // правило MusicBrainz: не чаще 1 запроса в секунду
let mbNextSlot = 0;

// Хост → платформа (по домену ссылки из MusicBrainz).
const PLATFORM_HOSTS = {
    instagram:  ['instagram.com'],
    youtube:    ['youtube.com', 'youtu.be'],
    spotify:    ['spotify.com'],
    twitter:    ['x.com', 'twitter.com'],
    facebook:   ['facebook.com', 'fb.com'],
    tiktok:     ['tiktok.com'],
    soundcloud: ['soundcloud.com'],
    bandcamp:   ['bandcamp.com']
};

function platformOfUrl(urlStr) {
    let url;
    try { url = new URL(urlStr); } catch (e) { return null; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    for (const [platform, hosts] of Object.entries(PLATFORM_HOSTS)) {
        if (hosts.some(h => host === h || host.endsWith('.' + h))) return platform;
    }
    return null;
}

async function mbFetch(path) {
    const slot = Math.max(Date.now(), mbNextSlot);
    mbNextSlot = slot + MB_MIN_INTERVAL_MS;
    const wait = slot - Date.now();
    if (wait > 0) await sleep(wait);

    let response;
    for (let attempt = 1; attempt <= 2; attempt++) {
        response = await fetch(MB_BASE + path, { headers: { 'Accept': 'application/json' } });
        // 503/429 у MusicBrainz — временная перегрузка/лимит, один повтор
        if ((response.status === 503 || response.status === 429) && attempt === 1) {
            await sleep(2000);
            continue;
        }
        break;
    }
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        console.warn('[YTM Ward] MusicBrainz', response.status, path, body.slice(0, 200));
        throw new Error(`MusicBrainz HTTP ${response.status}`);
    }
    return response.json();
}

const luceneEscape = (str) => String(str).replace(/(["\\])/g, '\\$1');
const normName = (str) => String(str || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

// Ищем MBID исполнителя. Сначала по паре «трек + артист» (это снимает
// неоднозначность одноимённых групп), затем по одному имени — но только
// если среди точных совпадений ровно один кандидат.
async function findArtistMbid(artist, title) {
    const wanted = new Set([normName(artist)]);
    artist.split(/\s*(?:,|&|\bfeat\.?|\bx\b)\s*/i).forEach(p => p && wanted.add(normName(p)));

    if (title) {
        const q = `recording:"${luceneEscape(title)}" AND artist:"${luceneEscape(artist)}"`;
        const rec = await mbFetch(`/recording?query=${encodeURIComponent(q)}&fmt=json&limit=5`);
        for (const r of (rec.recordings || [])) {
            if ((r.score || 0) < 85) continue;
            for (const ac of (r['artist-credit'] || [])) {
                if (ac.artist && (wanted.has(normName(ac.artist.name)) || wanted.has(normName(ac.name)))) {
                    return ac.artist.id;
                }
            }
        }
    }

    const q2 = `artist:"${luceneEscape(artist)}"`;
    const res = await mbFetch(`/artist?query=${encodeURIComponent(q2)}&fmt=json&limit=5`);
    const exact = (res.artists || []).filter(a => (a.score || 0) >= 90 && normName(a.name) === normName(artist));
    return exact.length === 1 ? exact[0].id : null;
}

// --- Ссылки на соцсети: Wikidata (второй источник) ---
// Артист определяется через MusicBrainz (ссылка на Wikidata в его карточке
// или поиск по MBID, свойство P434), поэтому путаницы с однофамильцами нет.
// ID свойств Wikidata ниже проверяются на лету: при первом запуске
// запрашиваем их названия и шаблоны URL (P1630) и используем свойство, только
// если английское название совпало с ожидаемым. Неверный ID будет пропущен.
const WD_API = 'https://www.wikidata.org/w/api.php';

const WD_PROPS = {
    website:    { id: 'P856',  label: /official website/i, fallback: null },
    instagram:  { id: 'P2003', label: /instagram/i,        fallback: 'https://www.instagram.com/$1/' },
    twitter:    { id: 'P2002', label: /twitter|\bx\b/i,    fallback: 'https://x.com/$1' },
    facebook:   { id: 'P2013', label: /facebook/i,         fallback: 'https://www.facebook.com/$1' },
    tiktok:     { id: 'P7085', label: /tiktok/i,           fallback: 'https://www.tiktok.com/@$1' },
    youtube:    { id: 'P2397', label: /youtube/i,          fallback: 'https://www.youtube.com/channel/$1' },
    spotify:    { id: 'P1902', label: /spotify/i,          fallback: 'https://open.spotify.com/artist/$1' },
    soundcloud: { id: 'P3040', label: /soundcloud/i,       fallback: 'https://soundcloud.com/$1' },
    bandcamp:   { id: 'P3283', label: /bandcamp/i,         fallback: 'https://$1.bandcamp.com/' }
};

const WD_PROPS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function wdFetch(params) {
    const qs = new URLSearchParams({ ...params, format: 'json', origin: '*' });
    const response = await fetch(`${WD_API}?${qs}`, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) throw new Error(`Wikidata HTTP ${response.status}`);
    return response.json();
}

// Возвращает { key: { id, formatter } } только для проверенных свойств.
async function loadWdPropFormats() {
    const stored = await chrome.storage.local.get(['wdPropFormats']);
    const cached = stored.wdPropFormats;
    if (cached && Date.now() - cached.fetchedAt < WD_PROPS_TTL_MS) return cached.map;

    const ids = Object.values(WD_PROPS).map(p => p.id).join('|');
    const data = await wdFetch({ action: 'wbgetentities', ids, props: 'labels|claims', languages: 'en' });

    const map = {};
    for (const [key, def] of Object.entries(WD_PROPS)) {
        const ent = data.entities && data.entities[def.id];
        const label = ent && ent.labels && ent.labels.en && ent.labels.en.value;
        if (!label || !def.label.test(label)) {
            console.warn(`[YTM Ward] Wikidata ${def.id}: unexpected label "${label}" for ${key} — skipped`);
            continue;
        }
        const f = ent.claims && ent.claims.P1630 && ent.claims.P1630[0];
        const formatter = f && f.mainsnak && f.mainsnak.datavalue ? f.mainsnak.datavalue.value : null;
        map[key] = { id: def.id, formatter: typeof formatter === 'string' && formatter.includes('$1') ? formatter : null };
    }

    await chrome.storage.local.set({ wdPropFormats: { fetchedAt: Date.now(), map } });
    return map;
}

async function findQidByMbid(mbid) {
    const res = await wdFetch({ action: 'query', list: 'search', srsearch: `haswbstatement:P434=${mbid}`, srlimit: '2' });
    const hits = (res.query && res.query.search) || [];
    return hits.length === 1 && /^Q\d+$/.test(hits[0].title) ? hits[0].title : null; // неоднозначно — не берём
}

function wdStatementValues(claims, propId) {
    const list = (claims && claims[propId]) || [];
    const usable = list.filter(st =>
        st.rank !== 'deprecated' &&
        st.mainsnak && st.mainsnak.datavalue &&
        !(st.qualifiers && st.qualifiers.P582) // P582 — «дата окончания»: аккаунт уже не актуален
    );
    usable.sort((a, b) => (b.rank === 'preferred') - (a.rank === 'preferred'));
    return usable.map(st => st.mainsnak.datavalue.value).filter(v => typeof v === 'string');
}

async function fetchWikidataLinks(qid) {
    const formats = await loadWdPropFormats();
    const data = await wdFetch({ action: 'wbgetentities', ids: qid, props: 'claims' });
    const claims = data.entities && data.entities[qid] && data.entities[qid].claims;
    const links = {};
    if (!claims) return links;

    for (const [key, info] of Object.entries(formats)) {
        const values = wdStatementValues(claims, info.id);
        if (!values.length) continue;

        let url;
        if (key === 'website') {
            url = values[0];
        } else {
            const template = info.formatter || WD_PROPS[key].fallback;
            if (!template) continue;
            url = template.replace('$1', encodeURIComponent(values[0]));
        }

        if (!/^https?:\/\//i.test(url)) continue;
        if (key !== 'website' && platformOfUrl(url) !== key) continue; // ссылка должна вести на «свою» платформу
        links[key] = url.replace(/^http:\/\//i, 'https://');
    }
    return links;
}

async function fetchArtistLinks(artist, title) {
    const mbid = await findArtistMbid(artist, title);
    console.log('[YTM Ward] MusicBrainz lookup:', { artist, title, mbid });
    if (!mbid) return { links: {}, found: false };

    const data = await mbFetch(`/artist/${mbid}?inc=url-rels&fmt=json`);
    const links = {};
    let qid = null;
    for (const rel of (data.relations || [])) {
        const resource = rel.url && rel.url.resource;
        if (!resource) continue;

        if (rel.type === 'wikidata' && !qid) {
            const m = /\/(Q\d+)(?:[/?#]|$)/.exec(resource);
            if (m) qid = m[1];
        }
        if (rel.ended) continue;

        let key = platformOfUrl(resource);
        if (!key && rel.type === 'official homepage') key = 'website';
        if (key && !links[key]) links[key] = resource.replace(/^http:\/\//i, 'https://');
    }
    console.log('[YTM Ward] MusicBrainz relations:', (data.relations || []).length, '→ links:', links);

    // Второй источник: Wikidata дополняет только те платформы, которых нет в MusicBrainz.
    try {
        if (!qid) qid = await findQidByMbid(mbid);
        if (qid) {
            const wdLinks = await fetchWikidataLinks(qid);
            console.log('[YTM Ward] Wikidata', qid, '→ links:', wdLinks);
            for (const [key, url] of Object.entries(wdLinks)) {
                if (!links[key]) links[key] = url;
            }
        }
    } catch (e) {
        console.warn('[YTM Ward] Wikidata lookup failed:', e && e.message ? e.message : e);
    }

    return { links, found: true, mbid, qid };
}

async function fetchGroqVerdict(apiKey, artist, title) {
    if (!apiKey) throw new Error('No Groq API key set');

    // Лимиты расходуем ОДИН раз на логическую проверку трека, а не на
    // каждую повторную попытку внутри неё — иначе один ретрай «съедал» бы
    // сразу несколько запросов из квоты.
    await checkAndConsumeRateLimit();

    const prompt = `Determine if "${artist} - ${title}" is performed by an AI singer (or uses an AI-generated voice). 

Strictly adhere to these rules:
1. Be honest and factual. Do not guess, speculate, or make up information. If you cannot provide an accurate answer based on reliable knowledge, state that it is unknown.
2. Return your response ONLY as a valid JSON object with the following structure:
{
  "isAI": true | false | null,
  "reason": "..."
}

Rules for JSON fields:
- "isAI": set to true if confirmed AI singer, false if human, or null if you are unsure or lack verifiable data.
- "reason": Write a concise 2-3 sentence overview about this artist, clarifying whether the voice is AI-generated, human, or if the origin cannot be verified.`;

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

    // true / false / null — null («не уверен») больше не превращается в false.
    const isAI = parsed.isAI === true ? true : (parsed.isAI === false ? false : null);

    return {
        isAI,
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

    if (message && message.type === 'FETCH_ARTIST_LINKS') {
        fetchArtistLinks(message.artist, message.title)
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