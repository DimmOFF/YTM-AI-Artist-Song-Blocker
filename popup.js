/*
 * YTM Ward - Popup Script (Counter Version)
 * Created by Spirit Flame modified by DimmOFF
 */

// Версия берётся из manifest.json — вручную в popup.html её больше править не нужно
document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;

// DOM Elements
const tabs = document.querySelectorAll('.tab-btn');
const list = document.getElementById('list');
const input = document.getElementById('input');
const addBtn = document.getElementById('add');
const inputArea = document.getElementById('input-area');
const statusLabel = document.getElementById('status');
const sourcesPanel = document.getElementById('sources-panel');
const soundproofBox = document.getElementById('soundproof-box');
const btnExport = document.getElementById('btn-export');
const btnImport = document.getElementById('btn-import');
const fileInput = document.getElementById('file-input');
const actionsRow = document.getElementById('actions-row');
const subtypeGroup = document.getElementById('subtype-group');
const subtypeRadios = document.querySelectorAll('input[name="subtype"]');
const subtypeOptions = document.querySelectorAll('.subtype-option');
const modeGroup = document.getElementById('mode-group');
const modeBtns = document.querySelectorAll('.mode-btn');

// Settings tab elements
const settingsPanel = document.getElementById('settings-panel');
const optLabel = document.getElementById('opt-label');
const optDislike = document.getElementById('opt-dislike');
const optSkipAi = document.getElementById('opt-skip-ai');
const rowSkipAi = document.getElementById('row-skip-ai');

// Groq API key UI (Settings)
const groqKeyInput = document.getElementById('groq-key-input');
const groqKeySaveBtn = document.getElementById('groq-key-save');
const groqKeyClearBtn = document.getElementById('groq-key-clear');
const groqKeyGenerateBtn = document.getElementById('groq-key-generate');
const groqKeyInputRow = document.getElementById('groq-key-input-row');
const groqKeySavedRow = document.getElementById('groq-key-saved-row');
const cacheSizeRow = document.getElementById('cache-size-row');
const cacheSizeInput = document.getElementById('cache-size-input');

// Info tab elements
const infoPanel = document.getElementById('info-panel');
const infoTrackEl = document.getElementById('info-track');
const groqBox = document.getElementById('groq-box');
const socialBox = document.getElementById('social-box');
const statTodayEl = document.getElementById('stat-today');
const statTotalEl = document.getElementById('stat-total');
const statSinceEl = document.getElementById('stat-since');

const DEFAULT_CACHE_SIZE = 100;
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней

// Master on/off switch
const engineToggle = document.getElementById('engine-toggle');

const DEFAULT_AI_ACTIONS = { label: true, dislike: false, skipAi: true };

let currentTab = 'info';
let currentMode = 'block';       // block | white — переключатель Blocklist / Whitelist внутри вкладки My List
let currentSubType = 'keywords'; // keywords | songs | artists — выбирается радиокнопками внутри вкладки My List

const KEYS_BY_MODE = {
    block: {
        keywords: 'blockedKeywords',
        songs: 'blockedTracks',
        artists: 'blockedArtists'
    },
    white: {
        keywords: 'whitelistedKeywords',
        songs: 'whitelistedTracks',
        artists: 'whitelistedArtists'
    }
};
const BL_KEYS = Object.values(KEYS_BY_MODE.block);
const WL_KEYS = Object.values(KEYS_BY_MODE.white);

function currentKey() {
    return KEYS_BY_MODE[currentMode][currentSubType];
}

function updatePlaceholder() {
    input.placeholder = `Add to ${currentMode === 'white' ? 'whitelist' : 'blocklist'} (${currentSubType})...`;
}

// --- UTILS ---

function showStatus(msg, color = '#666') {
    if (!statusLabel) return;
    statusLabel.style.color = color;
    statusLabel.textContent = msg;
    setTimeout(() => { statusLabel.textContent = 'Ready.'; statusLabel.style.color = '#666'; }, 3000);
}

function getDisplayText(item) {
    if (typeof item === 'string') return item;
    if (item && item.title) return `${item.artist || 'Unknown'} - ${item.title}`;
    return JSON.stringify(item);
}

// Текст записи для сравнения: у трека — title (так же матчится в content.js), иначе сама строка.
function termText(item) {
    const v = (item && typeof item === 'object') ? item.title : item;
    return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

// Удаляет из указанных списков записи с таким же текстом (без учёта регистра).
// Blocklist и Whitelist не должны содержать одну и ту же запись одновременно.
async function removeFromLists(keys, text) {
    const target = String(text || '').trim().toLowerCase();
    if (!target) return 0;
    const data = await chrome.storage.local.get(keys);
    const update = {};
    let removed = 0;
    keys.forEach(key => {
        const items = data[key] || [];
        const kept = items.filter(i => termText(i) !== target);
        if (kept.length !== items.length) {
            update[key] = kept;
            removed += items.length - kept.length;
        }
    });
    if (removed) await chrome.storage.local.set(update);
    return removed;
}

function safeSort(items) {
    if (!Array.isArray(items)) return [];
    return items.sort((a, b) => {
        const textA = getDisplayText(a).toLowerCase();
        const textB = getDisplayText(b).toLowerCase();
        return textA.localeCompare(textB);
    });
}

// --- MASTER ON/OFF SWITCH ---

function loadEngineToggle() {
    chrome.storage.local.get(['engineEnabled'], (res) => {
        engineToggle.checked = res.engineEnabled !== false;
    });
}

engineToggle.addEventListener('change', () => {
    const enabled = engineToggle.checked;
    chrome.storage.local.set({ engineEnabled: enabled }, () => {
        showStatus(enabled ? 'Extension enabled.' : 'Extension disabled.', enabled ? '#4caf50' : '#ff4444');
    });
});

// --- SETTINGS TAB ---

// Skip AI визуально "выключен", когда Dislike AI and Skip включена —
// он всё равно игнорируется в этом случае (см. content.js: checkAndSkip).
function updateSkipAiAvailability() {
    const ignored = optDislike.checked;
    optSkipAi.disabled = ignored;
    rowSkipAi.classList.toggle('disabled', ignored);
}

function loadSettingsUI() {
    chrome.storage.local.get(['aiActions'], (res) => {
        const actions = { ...DEFAULT_AI_ACTIONS, ...(res.aiActions || {}) };
        optLabel.checked = actions.label;
        optDislike.checked = actions.dislike;
        optSkipAi.checked = actions.skipAi;
        updateSkipAiAvailability();
    });
    loadGroqKeyUI();
    loadCacheSizeUI();
}

function saveSettingsUI() {
    const actions = {
        label: optLabel.checked,
        dislike: optDislike.checked,
        skipAi: optSkipAi.checked
    };
    chrome.storage.local.set({ aiActions: actions }, () => {
        showStatus('Settings saved.', '#4caf50');
    });
}

optLabel.addEventListener('change', saveSettingsUI);
optSkipAi.addEventListener('change', saveSettingsUI);
optDislike.addEventListener('change', () => {
    updateSkipAiAvailability();
    saveSettingsUI();
});

// --- GROQ API KEY (Settings) ---

function loadGroqKeyUI() {
    chrome.storage.local.get(['groqApiKey'], (res) => {
        if (res.groqApiKey) {
            groqKeyInputRow.style.display = 'none';
            groqKeySavedRow.style.display = 'flex';
            groqKeyGenerateBtn.style.display = 'none'; // ключ уже есть — кнопка не нужна
            cacheSizeRow.style.display = 'flex';        // настройка кэша видна только если есть ключ
        } else {
            groqKeyInputRow.style.display = 'flex';
            groqKeySavedRow.style.display = 'none';
            groqKeyInput.value = '';
            groqKeyGenerateBtn.style.display = 'block';
            cacheSizeRow.style.display = 'none';
        }
    });
}

groqKeySaveBtn.onclick = () => {
    const key = groqKeyInput.value.trim();
    if (!key) {
        showStatus('Enter an API key first.', '#ff4444');
        return;
    }
    chrome.storage.local.set({ groqApiKey: key }, () => {
        loadGroqKeyUI();
        showStatus('Groq API key saved.', '#4caf50');
    });
};

groqKeyClearBtn.onclick = () => {
    chrome.storage.local.remove('groqApiKey', () => {
        loadGroqKeyUI();
        showStatus('Groq API key removed.', '#ff4444');
    });
};

groqKeyGenerateBtn.onclick = () => {
    window.open('https://console.groq.com/keys', '_blank');
};

// --- CACHE SIZE (Settings) ---

function loadCacheSizeUI() {
    chrome.storage.local.get(['cacheSize'], (res) => {
        cacheSizeInput.value = res.cacheSize || DEFAULT_CACHE_SIZE;
    });
}

cacheSizeInput.addEventListener('change', () => {
    let size = parseInt(cacheSizeInput.value, 10);
    if (!Number.isFinite(size) || size < 10) size = DEFAULT_CACHE_SIZE;
    cacheSizeInput.value = size;
    chrome.storage.local.set({ cacheSize: size }, () => {
        showStatus(`Cache size set to ${size} artists.`, '#4caf50');
        trimVerdictCache(size); // сразу подрезаем, если новый лимит меньше текущего размера кэша
    });
});

// --- VERDICT CACHE (artist-only key, 30 дней) ---

async function trimVerdictCache(maxSize) {
    const data = await chrome.storage.local.get(['aiVerdictCache']);
    const cache = data.aiVerdictCache || {};
    const keys = Object.keys(cache);
    if (keys.length <= maxSize) return;

    // убираем самые старые записи (по checkedAt), пока не впишемся в лимит
    keys.sort((a, b) => (cache[a].checkedAt || 0) - (cache[b].checkedAt || 0));
    const toRemove = keys.length - maxSize;
    for (let i = 0; i < toRemove; i++) delete cache[keys[i]];

    await chrome.storage.local.set({ aiVerdictCache: cache });
}

async function getCachedVerdict(artist) {
    const data = await chrome.storage.local.get(['aiVerdictCache']);
    const cache = data.aiVerdictCache || {};
    const entry = cache[artist.toLowerCase()];
    if (!entry) return null;
    if (Date.now() - entry.checkedAt > CACHE_MAX_AGE_MS) return null; // протухло, переспрашиваем
    if (entry.v !== 2) return null; // запись из старой версии (null тогда сохранялся как «human») — переспрашиваем
}

async function saveCachedVerdict(artist, isAI, reason, checkedAt = Date.now()) {
    const data = await chrome.storage.local.get(['aiVerdictCache', 'cacheSize']);
    const cache = data.aiVerdictCache || {};
    const maxSize = data.cacheSize || DEFAULT_CACHE_SIZE;

    cache[artist.toLowerCase()] = { isAI, reason, v: 2, checkedAt };
    await chrome.storage.local.set({ aiVerdictCache: cache });
    await trimVerdictCache(maxSize);
}

// --- ARTIST LINKS CACHE (MusicBrainz, 30 дней, независимо от вердикта) ---

const LINKS_CACHE_LIMIT = 500;

async function getCachedLinks(artist) {
    const data = await chrome.storage.local.get(['artistLinksCache']);
    const entry = (data.artistLinksCache || {})[artist.toLowerCase()];
    if (!entry || Date.now() - entry.checkedAt > CACHE_MAX_AGE_MS) return null;
    if (entry.v !== 2) return null; // запись до появления Wikidata — перезапрашиваем
    return entry;
}

async function saveCachedLinks(artist, links, found) {
    const data = await chrome.storage.local.get(['artistLinksCache']);
    const cache = data.artistLinksCache || {};
    cache[artist.toLowerCase()] = { links: links || {}, found: found !== false, v: 2, checkedAt: Date.now() };

    const keys = Object.keys(cache);
    if (keys.length > LINKS_CACHE_LIMIT) {
        keys.sort((a, b) => cache[a].checkedAt - cache[b].checkedAt);
        for (let i = 0; i < keys.length - LINKS_CACHE_LIMIT; i++) delete cache[keys[i]];
    }
    await chrome.storage.local.set({ artistLinksCache: cache });
}

// --- RENDERING ---

function render() {
    list.innerHTML = '';
    settingsPanel.style.display = 'none';
    infoPanel.style.display = 'none';
    list.style.display = '';
    sourcesPanel.style.display = 'none';
    inputArea.style.display = 'none';
    subtypeGroup.style.display = 'none'; // радиокнопки Keywords/Songs/Artists показываем только на My List
    modeGroup.style.display = 'none';    // переключатель Blocklist/Whitelist — тоже только на My List
    actionsRow.style.display = 'flex'; // по умолчанию видим, скрываем только на Settings

    if (currentTab === 'settings') {
        settingsPanel.style.display = 'block';
        list.style.display = 'none';
        actionsRow.style.display = 'none'; // MOD: на Settings кнопки не нужны
        loadSettingsUI();
        return;
    }

    if (currentTab === 'info') {
        infoPanel.style.display = 'block';
        list.style.display = 'none';
        actionsRow.style.display = 'none';
        renderInfoTab();
        return;
    }

    if (currentTab === 'ai') {
        inputArea.style.display = 'none';
        list.style.display = 'none';
        sourcesPanel.style.display = 'flex';
        renderSourcesPanel();
        return;
    }

    // currentTab === 'mylist'
    modeGroup.style.display = 'flex';
    subtypeGroup.style.display = 'flex';
    inputArea.style.display = 'flex';
    const key = currentKey();
    
    chrome.storage.local.get([key], (res) => {
        let items = res[key] || [];
        items = safeSort(items);
        
        list.innerHTML = '';
        if (items.length === 0) {
            list.innerHTML = '<li style="justify-content:center; color:#555;">List is empty.</li>';
            return;
        }

        items.forEach(item => {
            const li = document.createElement('li');
            li.innerHTML = `<span>${getDisplayText(item)}</span><span class="delete-btn">✖</span>`;
            
            li.querySelector('.delete-btn').onclick = () => {
                removeItem(key, item);
            };
            list.appendChild(li);
        });
    });
}

// --- INFO TAB ---

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatDuration(ms) {
    if (ms < 0) ms = 0;
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ${minutes % 60} min`;
    const days = Math.floor(hours / 24);
    return `${days} d ${hours % 24} h`;
}

function renderStats(stats) {
    stats = stats || {};
    const todayKey = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, локальная дата
    const dailyBlocked = stats.dailyBlocked || {};

    statTodayEl.textContent = dailyBlocked[todayKey] || 0;
    statTotalEl.textContent = stats.totalBlocked || 0;
    statSinceEl.textContent = stats.firstBlockedAt
        ? formatDuration(Date.now() - stats.firstBlockedAt)
        : 'No AI tracks blocked yet';
}

// Добавляет исполнителя в пользовательский блок-лист (Artists). Текущий
// трек НЕ скипается немедленно — по требованию вердикт Groq не должен
// влиять на поведение, только дать пользователю быстрый способ забанить.
function banArtistFromInfo(artist, btn) {
    chrome.storage.local.get(['blockedArtists'], (res) => {
        const items = res.blockedArtists || [];
        const exists = items.some(i => getDisplayText(i) === artist);

        if (exists) {
            showStatus('Already in blocklist.', '#ff4444');
            return;
        }

        items.push(artist);
        chrome.storage.local.set({ blockedArtists: items }, async () => {
            await removeFromLists(WL_KEYS, artist); // бан и Whitelist взаимоисключающие
            showStatus(`"${artist}" added to blocklist.`, '#4caf50');
            if (btn) { btn.disabled = true; btn.textContent = '✓ Banned'; }
        });
    });
}

// forceRefresh = true — игнорируем кэш и заново спрашиваем Groq (кнопка Refresh / Retry);
// новый ответ перезапишет запись в кэше вместе с новой меткой времени.
function renderInfoTab(forceRefresh = false) {
    chrome.storage.local.get(['nowPlaying', 'stats', 'groqApiKey'], async (res) => {
        const now = res.nowPlaying;
        const isPlaying = !!(now && now.artist && now.title && !now.isPaused);

        infoTrackEl.textContent = isPlaying ? `${now.artist} - ${now.title}` : 'Nothing is playing';
        renderStats(res.stats);
        renderSoundproofCard(isPlaying ? now.artist : null, forceRefresh);

        if (!isPlaying) {
            clearSocialBox();
            groqBox.innerHTML = '<div class="hint">Open YouTube Music to check the current artist.</div>';
            return;
        }

        const apiKey = res.groqApiKey;
        if (!apiKey) {
            clearSocialBox();
            groqBox.innerHTML = '<div class="hint">Artist info is not available. Add Groq API key in Settings.</div>';
            return;
        }

        const requestedArtist = now.artist;
        const requestedTitle = now.title;

        // Кэш — только по артисту (не по треку), на 30 дней. Если есть
        // свежая запись — сети вообще не касаемся.
        const cached = forceRefresh ? null : await getCachedVerdict(requestedArtist);
        if (cached) {
            renderVerdict(requestedArtist, requestedTitle, cached.isAI, cached.reason, true, cached.checkedAt, forceRefresh);
            return;
        }

        clearSocialBox();
        groqBox.innerHTML = `
            <div class="groq-loading">
                <span class="groq-spinner"></span>
                <span>Checking artist with Groq...</span>
            </div>
        `;

        chrome.runtime.sendMessage({ type: 'FETCH_GROQ_VERDICT', apiKey, artist: requestedArtist, title: requestedTitle })
            .then(result => {
                // Пока ждали ответ Groq, трек мог уже смениться — сверяем
                // перед выводом, иначе покажем вердикт не для того трека.
                chrome.storage.local.get(['nowPlaying'], (res2) => {
                    const np = res2.nowPlaying;
                    if (!np || np.artist !== requestedArtist || np.title !== requestedTitle) return;

                    if (!result || !result.ok) {
                        renderGroqError((result && result.error) || 'Unknown error');
                        return;
                    }

                    const { isAI, reason } = result.data;
                    const checkedAt = Date.now();
                    saveCachedVerdict(requestedArtist, isAI, reason, checkedAt); // не ждём — запись в фоне
                    renderVerdict(requestedArtist, requestedTitle, isAI, reason, false, checkedAt, forceRefresh);
                });
            })
            .catch(e => {
                renderGroqError(e.message);
            });
    });
}

function formatCheckedAt(ts) {
    if (!ts) return 'unknown';
    return new Date(ts).toLocaleString(undefined, {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

// Иконки соцсетей (простые inline-SVG, без внешних файлов).
const SOCIAL_ICONS = {
    website:    { title: 'Website',     svg: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>' },
    instagram:  { title: 'Instagram',   svg: '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17" cy="7" r="0.8" fill="currentColor"/>' },
    youtube:    { title: 'YouTube',     svg: '<rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/>' },
    spotify:    { title: 'Spotify',     svg: '<circle cx="12" cy="12" r="9"/><path d="M7 9.5c3.5-1 7-.7 10 1M7.5 12.5c3-.8 6-.5 8.5 1M8 15.3c2.5-.6 5-.4 7 .8"/>' },
    twitter:    { title: 'X / Twitter', svg: '<path d="M5 4l14 16M19 4L5 20"/>' },
    facebook:   { title: 'Facebook',    svg: '<circle cx="12" cy="12" r="9"/><path d="M13.5 20v-7h2.3l.4-2.7h-2.7V8.6c0-.8.3-1.3 1.4-1.3h1.4V5a14 14 0 0 0-2-.1c-2 0-3.4 1.2-3.4 3.4v2H9v2.7h2.3v7"/>' },
    tiktok:     { title: 'TikTok',      svg: '<path d="M14 4v10.5a3.5 3.5 0 1 1-3.5-3.5M14 4c.3 2.3 1.9 3.8 4.5 4"/>' },
    soundcloud: { title: 'SoundCloud',  svg: '<path d="M3 15v-3M6 16V10M9 16V8M12 16V7c3-1 6 .5 6.3 3.2C20.5 10 22 11.4 22 13.2c0 1.6-1.3 2.8-3 2.8H12"/>' },
    bandcamp:   { title: 'Bandcamp',    svg: '<path d="M3 17.5L8.5 6.5H21L15.5 17.5z"/>' }
};

// Платформы, для которых при отсутствии проверенной ссылки показываем
// иконку-поиск (ведёт на страницу результатов, а не на «угаданный» профиль).
const SEARCH_FALLBACKS = {
    instagram: (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q + ' instagram'),
    youtube:   (q) => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q),
    spotify:   (q) => 'https://open.spotify.com/search/' + encodeURIComponent(q),
    tiktok:    (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q + ' tiktok'),
    twitter:   (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q + ' twitter x'),
    facebook:  (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q + ' facebook')
};

// Фирменные цвета — для запасной (inline-SVG) иконки, если favicon не загрузился.
const SOCIAL_COLORS = {
    website: '#4caf50', instagram: '#e4405f', youtube: '#ff0000', spotify: '#1db954',
    twitter: '#ffffff', facebook: '#1877f2', tiktok: '#25f4ee', soundcloud: '#ff5500', bandcamp: '#629aa9'
};

function svgIconHtml(meta, color) {
    return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="${color || 'currentColor'}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${meta.svg}</svg>`;
}

// Проверенная ссылка → цветной favicon сайта (через сервис favicon Google;
// наружу уходит только домен, не весь URL). Если картинка не загрузилась
// (нет сети / блокировка) — подменяем цветной inline-SVG.
// Ссылка-поиск → серая пунктирная иконка без favicon.
function makeSocialAnchor(key, meta, href, isSearch) {
    const a = document.createElement('a');
    a.className = 'groq-social-link' + (isSearch ? ' search' : '');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = isSearch ? `Search: ${meta.title}` : href; // при наведении — полная ссылка

    if (isSearch) {
        a.innerHTML = svgIconHtml(meta);
        return a;
    }

    let host = '';
    try { host = new URL(href).hostname; } catch (e) { /* оставим SVG */ }

    const colorSvg = () => { a.innerHTML = svgIconHtml(meta, SOCIAL_COLORS[key]); };

    if (!host) { colorSvg(); return a; }

    const img = document.createElement('img');
    img.width = 16;
    img.height = 16;
    img.alt = meta.title;
    img.src = 'https://www.google.com/s2/favicons?sz=64&domain=' + encodeURIComponent(host);
    img.addEventListener('error', colorSvg, { once: true });
    a.appendChild(img);
    return a;
}

// verified — ссылки из MusicBrainz (сплошные иконки); для платформ без
// такой ссылки добавляем пунктирные иконки-поиск.
function buildSocialLinks(artist, verified) {
    const row = document.createElement('div');
    row.className = 'groq-social-row';
    verified = verified || {};

    for (const [key, meta] of Object.entries(SOCIAL_ICONS)) {
        const href = verified[key];
        if (typeof href === 'string' && /^https:\/\//i.test(href)) {
            row.appendChild(makeSocialAnchor(key, meta, href, false));
        }
    }
    for (const [key, makeUrl] of Object.entries(SEARCH_FALLBACKS)) {
        if (!verified[key]) row.appendChild(makeSocialAnchor(key, SOCIAL_ICONS[key], makeUrl(artist), true));
    }
    return row;
}

let socialRequestId = 0;

// Прячет карточку соцсетей и отменяет ещё не завершённые запросы ссылок.
function clearSocialBox() {
    socialRequestId++;
    socialBox.style.display = 'none';
    socialBox.innerHTML = '';
}

async function loadSocialLinks(artist, title, force) {
    const myId = ++socialRequestId;
    const stillRelevant = () => myId === socialRequestId && groqBox.querySelector('.groq-meta-row');

    // note — короткая подпись под иконками: чем закончился поиск ссылок.
    const attach = (links, note) => {
        if (!stillRelevant()) return;
        socialBox.innerHTML = '';
        socialBox.appendChild(buildSocialLinks(artist, links));
        if (note) {
            const n = document.createElement('div');
            n.className = 'groq-social-note';
            n.textContent = note;
            socialBox.appendChild(n);
        }
        socialBox.style.display = 'block';
    };

    const describe = (links, found) => {
        const count = Object.keys(links || {}).length;
        if (count) return '';
        return found ? 'MusicBrainz/Wikidata: artist found, but no social links on file' : 'MusicBrainz: artist not found';
    };

    const cached = force ? null : await getCachedLinks(artist);
    if (cached) { attach(cached.links, describe(cached.links, cached.found)); return; }

    chrome.runtime.sendMessage({ type: 'FETCH_ARTIST_LINKS', artist, title })
        .then(result => {
            if (!result || !result.ok) {
                // сбой сети/сервиса — не кэшируем, чтобы повторить при следующем открытии
                attach({}, 'Links lookup failed: ' + ((result && result.error) || 'no response'));
                return;
            }
            saveCachedLinks(artist, result.data.links, result.data.found);
            attach(result.data.links, describe(result.data.links, result.data.found));
        })
        .catch(e => attach({}, 'Links lookup failed: ' + (e && e.message ? e.message : e)));
}

function renderVerdict(artist, title, isAI, reason, fromCache, checkedAt, forceLinks) {
    // isAI: true → LIKELY AI, false → LIKELY HUMAN, null → UNKNOWN
    let badgeClass = 'unknown';
    let badgeText = 'UNKNOWN';
    if (isAI === true) { badgeClass = 'is-ai'; badgeText = 'LIKELY AI'; }
    else if (isAI === false) { badgeClass = 'not-ai'; badgeText = 'LIKELY HUMAN'; }

    groqBox.innerHTML = `
        <div class="groq-meta-row">
            <span class="src-pill src-groq">Groq</span>
            <span class="groq-verdict-badge ${badgeClass}">${badgeText}</span>
            ${fromCache ? '<span class="groq-cached-label">(cached)</span>' : ''}
            <button class="groq-refresh-btn" title="Ask Groq again and replace the cached answer">↻ Refresh</button>
        </div>
        <div class="groq-timestamp">Checked: ${escapeHtml(formatCheckedAt(checkedAt))}</div>
        <div>${escapeHtml(reason || 'No details provided.')}</div>
    `;

    groqBox.querySelector('.groq-refresh-btn').onclick = () => renderInfoTab(true);
    // Карточка соцсетей живёт отдельно от вердикта: сбрасываем старую, пока грузится новая
    socialBox.style.display = 'none';
    socialBox.innerHTML = '';

    if (isAI === true) {
        const banBtn = document.createElement('button');
        banBtn.className = 'groq-ban-btn';
        banBtn.textContent = '🚫 Ban Artist';
        banBtn.onclick = () => banArtistFromInfo(artist, banBtn);
        groqBox.appendChild(banBtn);
    }

    loadSocialLinks(artist, title, forceLinks); // иконки подгружаются отдельно и не задерживают вердикт
}

// Короткое человекочитаемое сообщение + кнопка Retry. background.js уже
// вытаскивает message из тела ошибки API (включая отдельные сообщения
// про превышение лимита запросов в минуту/день), так что сюда приходит
// уже готовый для показа текст, не сырой JSON.
function renderGroqError(message) {
    clearSocialBox();
    groqBox.innerHTML = `
        <div class="hint" style="color:#ff4444;">Groq check failed: ${escapeHtml(message)}</div>
    `;
    const retryBtn = document.createElement('button');
    retryBtn.className = 'groq-ban-btn';
    retryBtn.style.background = '#444';
    retryBtn.textContent = '↻ Retry';
    retryBtn.onclick = () => renderInfoTab(true);
    groqBox.appendChild(retryBtn);
}

// --- LOGIC ---

// --- AI DB: карточки источников ---

const SOURCES = [
    {
        id: 'zoundhub',
        pill: 'ZoundHub',
        name: 'ZoundHub',
        desc: 'Curated list of AI artists. Used for the AI badge and auto-skip.'
    },
    {
        id: 'soundproof',
        pill: 'SoundProof',
        name: 'Detect & Skip AI Music - SoundProof',
        desc: 'Community votes per artist. Shown on the Info tab and checked at track start (badge / auto-skip).'
    }
];

// Время жизни кэша SoundProof (настраивается в карточке на AI DB). 0 = кэш выключен.
const SP_TTL_OPTIONS = [
    { label: 'Off', ms: 0 },
    { label: '1H',  ms: 60 * 60 * 1000 },
    { label: '6H',  ms: 6 * 60 * 60 * 1000 },
    { label: '1D',  ms: 24 * 60 * 60 * 1000 },
    { label: '3D',  ms: 3 * 24 * 60 * 60 * 1000 },
    { label: '7D',  ms: 7 * 24 * 60 * 60 * 1000 }
];
const SP_TTL_DEFAULT_MS = 24 * 60 * 60 * 1000; // 1D

async function getSoundproofTtl() {
    const data = await chrome.storage.local.get(['soundproofCacheTtl']);
    const v = data.soundproofCacheTtl;
    return SP_TTL_OPTIONS.some(o => o.ms === v) ? v : SP_TTL_DEFAULT_MS;
}

async function getSourceEnabled() {
    const data = await chrome.storage.local.get(['sourceEnabled']);
    return { zoundhub: true, soundproof: true, ...(data.sourceEnabled || {}) };
}

async function setSourceEnabled(id, value) {
    const current = await getSourceEnabled();
    current[id] = value;
    await chrome.storage.local.set({ sourceEnabled: current });
}

function setStat(el, html, isError) {
    el.classList.toggle('error', !!isError);
    el.innerHTML = html;
}

// ZoundHub: количество записей в базе
function loadZoundhubStat(statEl) {
    setStat(statEl, 'Loading…');
    return chrome.runtime.sendMessage({ type: 'FETCH_AI_ARTISTS' })
        .then(result => {
            if (!result || !result.ok) throw new Error((result && result.error) || 'Unknown error');
            const data = result.data;
            let raw = [];
            if (Array.isArray(data)) raw = data;
            else if (data.artists) raw = data.artists;
            else if (data.data) raw = data.data;
            else if (data.results) raw = data.results;
            else if (data.items) raw = data.items;
            else raw = Object.values(data).flat();

            const count = raw
                .map(item => (typeof item === 'string') ? item : (item && item.removed !== true ? (item.name || item.artist || item.artist_name || item.artistName || item.title) : null))
                .filter(n => typeof n === 'string' && n.trim().length > 0).length;

            setStat(statEl, `Records in database: <b>${count.toLocaleString()}</b>`);
            showStatus('ZoundHub: database synced', '#4caf50');
        })
        .catch(e => setStat(statEl, 'Connection failed: ' + escapeHtml(e.message), true));
}

// SoundProof: записей «всей базы» нет (запрос идёт по одному артисту),
// поэтому показываем число закэшированных проверок.
async function loadSoundproofStat(statEl, extraNote) {
    const data = await chrome.storage.local.get(['soundproofCache']);
    const n = Object.keys(data.soundproofCache || {}).length;
    setStat(statEl, `Cached artist lookups: <b>${n}</b>` + (extraNote ? ` · ${extraNote}` : ''));
}

async function reloadSoundproof(statEl) {
    await chrome.storage.local.remove('soundproofCache');
    setStat(statEl, 'Cache cleared. Checking service…');

    const res = await chrome.storage.local.get(['nowPlaying']);
    const artist = res.nowPlaying && res.nowPlaying.artist;
    if (!artist) { await loadSoundproofStat(statEl, 'will refresh on the next track'); return; }

    try {
        await getSoundproof(artist, true);
        await loadSoundproofStat(statEl, 'service reachable');
        showStatus('SoundProof: reloaded', '#4caf50');
    } catch (e) {
        setStat(statEl, 'Connection failed: ' + escapeHtml(e.message), true);
    }
}

async function renderSourcesPanel() {
    const enabled = await getSourceEnabled();
    sourcesPanel.innerHTML = '';

    SOURCES.forEach(def => {
        const card = document.createElement('div');
        card.className = `source-card src-${def.id}` + (enabled[def.id] ? '' : ' disabled');
        card.innerHTML = `
            <input type="checkbox" title="Enable / disable this source" ${enabled[def.id] ? 'checked' : ''}>
            <div class="source-main">
                <span class="src-pill">${escapeHtml(def.pill)}</span>
                <div class="source-name">${escapeHtml(def.name)}</div>
                <div class="source-desc">${escapeHtml(def.desc)}</div>
                <div class="source-stat">…</div>
            </div>
            <button class="source-reload" title="Reload this source">↻</button>
        `;

        const checkbox = card.querySelector('input[type="checkbox"]');
        const statEl = card.querySelector('.source-stat');
        const reloadBtn = card.querySelector('.source-reload');

        checkbox.onchange = async () => {
            await setSourceEnabled(def.id, checkbox.checked);
            card.classList.toggle('disabled', !checkbox.checked);
            showStatus(`${def.pill}: ${checkbox.checked ? 'enabled' : 'disabled'}`, checkbox.checked ? '#4caf50' : '#ff4444');
        };

        reloadBtn.onclick = () => {
            if (def.id === 'zoundhub') loadZoundhubStat(statEl);
            else reloadSoundproof(statEl);
        };

        if (def.id === 'soundproof') {
            const row = document.createElement('div');
            row.className = 'source-ttl-row';
            row.innerHTML = '<span>Cache lifetime</span><select title="How long SoundProof answers are kept"></select>';
            const select = row.querySelector('select');
            SP_TTL_OPTIONS.forEach(o => {
                const opt = document.createElement('option');
                opt.value = String(o.ms);
                opt.textContent = o.label;
                select.appendChild(opt);
            });
            getSoundproofTtl().then(ms => { select.value = String(ms); });

            select.onchange = async () => {
                const ms = Number(select.value);
                await chrome.storage.local.set({ soundproofCacheTtl: ms });
                if (ms === 0) await chrome.storage.local.remove('soundproofCache'); // «Off» — старые ответы не держим
                const label = SP_TTL_OPTIONS.find(o => o.ms === ms).label;
                showStatus(`SoundProof cache: ${label}`, '#4caf50');
                loadSoundproofStat(statEl);
            };
            card.querySelector('.source-main').appendChild(row);

            // Правила автоскипа по голосам (по умолчанию 50% и 3 голоса)
            const rules = document.createElement('div');
            rules.className = 'source-ttl-row';
            rules.title = 'Lead = (AI votes − Human votes) / all votes. A 50% lead equals 75% AI votes. Verified artists always count as decisive.';
            rules.innerHTML = '<span>Auto-skip: AI lead ≥</span><input type="number" min="1" max="100" step="1" data-k="threshold"><span>% · min votes</span><input type="number" min="1" max="999" step="1" data-k="minVotes">';
            const thInput = rules.querySelector('[data-k="threshold"]');
            const mvInput = rules.querySelector('[data-k="minVotes"]');
            chrome.storage.local.get(['soundproofThreshold', 'soundproofMinVotes']).then(d => {
                thInput.value = Number.isFinite(d.soundproofThreshold) ? d.soundproofThreshold : 50;
                mvInput.value = Number.isFinite(d.soundproofMinVotes) ? d.soundproofMinVotes : 3;
            });
            const clampSave = (input, key, min, max, fallback) => {
                let v = Math.round(Number(input.value));
                if (!Number.isFinite(v)) v = fallback;
                v = Math.min(max, Math.max(min, v));
                input.value = v;
                chrome.storage.local.set({ [key]: v });
                showStatus('SoundProof: skip rule saved', '#4caf50');
            };
            thInput.onchange = () => clampSave(thInput, 'soundproofThreshold', 1, 100, 50);
            mvInput.onchange = () => clampSave(mvInput, 'soundproofMinVotes', 1, 999, 3);
            card.querySelector('.source-main').appendChild(rules);
        }

        sourcesPanel.appendChild(card);

        if (def.id === 'zoundhub') loadZoundhubStat(statEl);
        else loadSoundproofStat(statEl);
    });
}

// --- SoundProof (Info tab) ---

async function getSoundproof(artist, force) {
    const key = artist.toLowerCase().trim();
    const ttlMs = await getSoundproofTtl(); // срок берём из текущей настройки — смена применяется и к уже сохранённым ответам

    if (!force && ttlMs > 0) {
        const stored = await chrome.storage.local.get(['soundproofCache']);
        const entry = (stored.soundproofCache || {})[key];
        if (entry && Date.now() - entry.checkedAt < ttlMs) {
            return { data: entry.data, cached: true, checkedAt: entry.checkedAt };
        }
    }

    const ask = async (name) => {
        const res = await chrome.runtime.sendMessage({ type: 'FETCH_SOUNDPROOF', artist: name });
        if (!res || !res.ok) throw new Error((res && res.error) || 'No response');
        return res.data;
    };

    let data = await ask(artist);

    // «A, B» — у SoundProof ключом служит первый исполнитель из плеера.
    if (data.human + data.ai === 0 && artist.includes(',')) {
        const first = artist.split(/\s*,\s*/)[0];
        if (first && first.toLowerCase() !== key) {
            try {
                const d2 = await ask(first);
                if (d2.human + d2.ai > 0) data = d2;
            } catch (e) { /* оставляем исходный ответ */ }
        }
    }

    const checkedAt = Date.now();
    if (ttlMs === 0) return { data, cached: false, checkedAt }; // кэш выключен — ничего не сохраняем

    const stored = await chrome.storage.local.get(['soundproofCache']);
    const cache = stored.soundproofCache || {};
    cache[key] = { data, checkedAt };

    const keys = Object.keys(cache);
    if (keys.length > 500) {
        keys.sort((x, y) => cache[x].checkedAt - cache[y].checkedAt);
        for (let i = 0; i < keys.length - 500; i++) delete cache[keys[i]];
    }
    await chrome.storage.local.set({ soundproofCache: cache });

    return { data, cached: false, checkedAt };
}

let spRequestId = 0;
let spRenderedArtist = null;

async function renderSoundproofCard(artist, force) {
    const enabled = await getSourceEnabled();
    if (!artist || !enabled.soundproof) {
        spRequestId++;
        spRenderedArtist = null;
        soundproofBox.style.display = 'none';
        soundproofBox.innerHTML = '';
        return;
    }

    // Info перерисовывается и при смене статистики — не мигаем, если артист тот же.
    if (!force && spRenderedArtist === artist && soundproofBox.innerHTML) return;

    const myId = ++spRequestId;
    soundproofBox.style.display = 'block';
    soundproofBox.innerHTML = `
        <div class="groq-loading">
            <span class="src-pill src-soundproof">SoundProof</span>
            <span class="groq-spinner"></span>
            <span>Checking community votes...</span>
        </div>`;

    try {
        const { data, cached, checkedAt } = await getSoundproof(artist, force);
        if (myId !== spRequestId) return;
        spRenderedArtist = artist;
        drawSoundproof(artist, data, cached, checkedAt);
    } catch (e) {
        if (myId !== spRequestId) return;
        spRenderedArtist = null;
        soundproofBox.innerHTML = `
            <div class="groq-meta-row"><span class="src-pill src-soundproof">SoundProof</span></div>
            <div class="hint" style="color:#ff4444;">SoundProof check failed: ${escapeHtml(e.message)}</div>`;
    }
}

function drawSoundproof(artist, data, cached, checkedAt) {
    const { human, ai, verified, myVote } = data;
    const total = human + ai;

    let badgeClass = 'unknown', badgeText = 'NO DATA', pct = 0, isAI = false;
    if (verified) {
        isAI = ai > human;
        badgeClass = isAI ? 'is-ai' : 'not-ai';
        badgeText = isAI ? 'AI' : 'HUMAN';
        pct = total ? Math.round((Math.max(ai, human) / total) * 100) : 100;
    } else if (total > 0) {
        isAI = ai > human;
        pct = Math.round((Math.max(ai, human) / total) * 100);
        const lean = pct < 75 || total <= 5; // те же пороги, что описаны в README SoundProof
        badgeClass = lean ? (isAI ? 'lean-ai' : 'lean-human') : (isAI ? 'is-ai' : 'not-ai');
        badgeText = (lean ? 'LEAN ' : '') + (isAI ? 'AI' : 'HUMAN');
    }

    const humanPct = total ? (human / total) * 100 : 0;
    const aiPct = total ? (ai / total) * 100 : 0;

    soundproofBox.innerHTML = `
        <div class="groq-meta-row">
            <span class="src-pill src-soundproof">SoundProof</span>
            <span class="groq-verdict-badge ${badgeClass}">${badgeText}</span>
            ${cached ? '<span class="groq-cached-label">(cached)</span>' : ''}
            <span class="sp-vote-group">
                <button class="sp-vote-btn human${myVote === 'human' ? ' voted' : ''}" data-vote="human" ${verified ? 'disabled' : ''} title="${verified ? 'Voting is closed for verified artists' : 'Vote: this artist is human'}">Human</button>
                <button class="sp-vote-btn ai${myVote === 'ai' ? ' voted' : ''}" data-vote="ai" ${verified ? 'disabled' : ''} title="${verified ? 'Voting is closed for verified artists' : 'Vote: this artist is AI'}">AI</button>
            </span>
        </div>
        ${total === 0
            ? '<div class="hint">Nobody has voted on this artist yet.</div>'
            : `<div class="sp-bar"><div class="h" style="width:${humanPct}%"></div><div class="a" style="width:${aiPct}%"></div></div>
               <div class="sp-line"><span>Human <b>${human}</b></span><span><b>${pct}%</b> ${isAI ? 'AI' : 'Human'}</span><span>AI <b>${ai}</b></span></div>`}
        ${verified ? '<div class="sp-verified">✓ Verified by SoundProof moderators</div>' : ''}
        <div class="groq-timestamp" style="margin:6px 0 0;">Checked: ${escapeHtml(formatCheckedAt(checkedAt))}</div>
    `;

    soundproofBox.querySelectorAll('.sp-vote-btn').forEach(btn => {
        btn.onclick = () => castSoundproofVote(artist, btn.dataset.vote);
    });
}

// Голосование (только по клику). После голоса принудительно перечитываем статус,
// чтобы показать актуальные числа и выбранную кнопку.
function setVoteNote(text, isError) {
    let note = soundproofBox.querySelector('.sp-vote-note');
    if (!note) {
        note = document.createElement('div');
        const stamp = soundproofBox.querySelector('.groq-timestamp');
        soundproofBox.insertBefore(note, stamp || null);
    }
    note.className = 'sp-vote-note' + (isError ? ' error' : '');
    note.textContent = text;
}

async function castSoundproofVote(artist, vote) {
    const myId = ++spRequestId;
    soundproofBox.querySelectorAll('.sp-vote-btn').forEach(b => { b.disabled = true; });
    setVoteNote('Sending vote...', false);

    try {
        const res = await chrome.runtime.sendMessage({ type: 'SOUNDPROOF_VOTE', artist, vote });
        if (!res || !res.ok) throw new Error((res && res.error) || 'No response');

        const fresh = await getSoundproof(artist, true);
        if (myId !== spRequestId) return;
        drawSoundproof(artist, fresh.data, false, fresh.checkedAt);
        showStatus('SoundProof: vote sent', '#4caf50');
    } catch (e) {
        if (myId !== spRequestId) return;
        soundproofBox.querySelectorAll('.sp-vote-btn').forEach(b => { b.disabled = false; });
        setVoteNote('Vote failed: ' + e.message, true);
    }
}

function addItem() {
    const val = input.value.trim();
    if (!val) return;
    
    const key = currentKey();
    const mode = currentMode;
    chrome.storage.local.get([key], (res) => {
        const items = res[key] || [];
        
        const newItem = (currentSubType === 'songs') 
            ? { title: val, artist: "Manual Entry" } 
            : val;

        const exists = items.some(i => getDisplayText(i) === getDisplayText(newItem));
        
        if (!exists) {
            items.push(newItem);
            chrome.storage.local.set({ [key]: items }, async () => {
                // Whitelist ↔ Blocklist: запись не может быть в обоих списках сразу,
                // поэтому такая же запись удаляется из противоположного списка.
                const removed = await removeFromLists(mode === 'white' ? BL_KEYS : WL_KEYS, termText(newItem));
                input.value = '';
                render();
                if (removed) {
                    showStatus(mode === 'white' ? 'Added. Removed from blocklist.' : 'Added. Removed from whitelist.', '#4caf50');
                } else {
                    showStatus('Added.');
                }
            });
        } else {
            showStatus('Duplicate entry.', '#ff4444');
        }
    });
}

function removeItem(key, val) {
    chrome.storage.local.get([key], (res) => {
        let items = res[key] || [];
        items = items.filter(i => getDisplayText(i) !== getDisplayText(val));
        chrome.storage.local.set({ [key]: items }, render);
    });
}

// --- EVENTS ---

tabs.forEach(tab => {
    tab.onclick = () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentTab = tab.dataset.tab;
        input.value = '';
        updatePlaceholder();
        render();
    };
});

subtypeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
        if (!radio.checked) return;
        currentSubType = radio.value;
        subtypeOptions.forEach(opt => opt.classList.toggle('active', opt.dataset.value === currentSubType));
        input.value = '';
        updatePlaceholder();
        render();
    });
});

modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        currentMode = btn.dataset.mode;
        modeBtns.forEach(b => b.classList.toggle('active', b === btn));
        document.body.classList.toggle('mode-white', currentMode === 'white');
        input.value = '';
        updatePlaceholder();
        render();
    });
});

addBtn.onclick = addItem;
input.addEventListener('keypress', e => { if(e.key === 'Enter') addItem(); });

btnExport.onclick = () => {
    chrome.storage.local.get(null, (data) => {
        const blob = new Blob([JSON.stringify(data, null, 2)], {type : 'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'ytm-ward-backup.json';
        a.click();
        showStatus('Exported.');
    });
};

btnImport.onclick = () => fileInput.click();
fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const data = JSON.parse(event.target.result);
            chrome.storage.local.set(data, () => {
                render();
                loadEngineToggle();
                showStatus('Import Successful.', '#4caf50');
            });
        } catch(err) {
            showStatus('Invalid JSON File.', '#ff4444');
        }
    };
    reader.readAsText(file);
};

// NEW: content.js пишет nowPlaying/stats в storage на каждую смену трека —
// без этого слушателя Info-вкладка обновлялась только при переоткрытии
// попапа, а не "живьём", пока он уже открыт.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (currentTab === 'info' && (changes.nowPlaying || changes.stats)) {
        renderInfoTab();
    }
    // Список изменили снаружи (например, кликом по AI-бейджу на странице) — обновляем открытый My List
    if (currentTab === 'mylist' && [...BL_KEYS, ...WL_KEYS].some(k => changes[k])) {
        render();
    }
});

// Start
updatePlaceholder();
render();
loadEngineToggle();