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
const btnRefresh = document.getElementById('btn-refresh');
const btnExport = document.getElementById('btn-export');
const btnImport = document.getElementById('btn-import');
const fileInput = document.getElementById('file-input');
const actionsRow = document.getElementById('actions-row');
const subtypeGroup = document.getElementById('subtype-group');
const subtypeRadios = document.querySelectorAll('input[name="subtype"]');
const subtypeOptions = document.querySelectorAll('.subtype-option');

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
const statTodayEl = document.getElementById('stat-today');
const statTotalEl = document.getElementById('stat-total');
const statSinceEl = document.getElementById('stat-since');

const DEFAULT_CACHE_SIZE = 100;
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней

// Master on/off switch
const engineToggle = document.getElementById('engine-toggle');

const DEFAULT_AI_ACTIONS = { label: true, dislike: false, skipAi: true };

let currentTab = 'info';
let currentSubType = 'keywords'; // keywords | songs | artists — выбирается радиокнопками внутри вкладки My Blocklist

const KEYS = {
    keywords: 'blockedKeywords',
    songs: 'blockedTracks',
    artists: 'blockedArtists'
};

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
    return entry;
}

async function saveCachedVerdict(artist, isAI, reason, checkedAt = Date.now()) {
    const data = await chrome.storage.local.get(['aiVerdictCache', 'cacheSize']);
    const cache = data.aiVerdictCache || {};
    const maxSize = data.cacheSize || DEFAULT_CACHE_SIZE;

    cache[artist.toLowerCase()] = { isAI, reason, checkedAt };
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
    inputArea.style.display = 'none';
    subtypeGroup.style.display = 'none'; // радиокнопки Keywords/Songs/Artists показываем только на My Blocklist
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
        fetchAIList(); 
        return;
    }

    // currentTab === 'blocklist'
    subtypeGroup.style.display = 'flex';
    inputArea.style.display = 'flex';
    const key = KEYS[currentSubType];
    
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
        chrome.storage.local.set({ blockedArtists: items }, () => {
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

        if (!isPlaying) {
            groqBox.innerHTML = '<div class="hint">Open YouTube Music to check the current artist.</div>';
            return;
        }

        const apiKey = res.groqApiKey;
        if (!apiKey) {
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

async function loadSocialLinks(artist, title, force) {
    const myId = ++socialRequestId;
    const stillRelevant = () => myId === socialRequestId && groqBox.querySelector('.groq-meta-row');

    // note — короткая подпись под иконками: чем закончился поиск ссылок.
    const attach = (links, note) => {
        if (!stillRelevant()) return;
        groqBox.querySelectorAll('.groq-social-row, .groq-social-note').forEach(el => el.remove());
        groqBox.appendChild(buildSocialLinks(artist, links));
        if (note) {
            const n = document.createElement('div');
            n.className = 'groq-social-note';
            n.textContent = note;
            groqBox.appendChild(n);
        }
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
            <span class="groq-verdict-badge ${badgeClass}">${badgeText}</span>
            ${fromCache ? '<span class="groq-cached-label">(cached)</span>' : ''}
            <button class="groq-refresh-btn" title="Ask Groq again and replace the cached answer">↻ Refresh</button>
        </div>
        <div class="groq-timestamp">Checked: ${escapeHtml(formatCheckedAt(checkedAt))}</div>
        <div>${escapeHtml(reason || 'No details provided.')}</div>
    `;

    groqBox.querySelector('.groq-refresh-btn').onclick = () => renderInfoTab(true);

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

function fetchAIList() {
    list.innerHTML = '<li style="justify-content:center; color:#888;">Checking Database...</li>';

    chrome.runtime.sendMessage({ type: 'FETCH_AI_ARTISTS' })
        .then(result => {
            if (!result || !result.ok) throw new Error((result && result.error) || 'Unknown error');
            return result.data;
        })
        .then(data => {
            let raw = [];
            if (Array.isArray(data)) raw = data;
            else if (data.artists) raw = data.artists;
            else if (data.data) raw = data.data;
            else if (data.results) raw = data.results;
            else if (data.items) raw = data.items;
            else raw = Object.values(data).flat();

            const names = raw
                .map(item => (typeof item === 'string') ? item : (item && item.removed !== true ? (item.name || item.artist || item.artist_name || item.artistName || item.title) : null))
                .filter(n => typeof n === 'string' && n.trim().length > 0);
            const count = names.length;
            
            list.innerHTML = `
                <li style="display:block; text-align:center; padding-top:60px; border-bottom:none; pointer-events:none;">
                    <div style="font-size:48px; font-weight:800; color:#ff4444; line-height:1;">${count}</div>
                    <div style="font-size:12px; font-weight:bold; color:#aaa; margin-top:5px; text-transform:uppercase; letter-spacing:1px;">AI Artists Tracked</div>
                    <div style="font-size:10px; color:#555; margin-top:20px;">Source: ZoundHub Database</div>
                </li>
            `;
            
            showStatus('Database Sync Active', '#4caf50');
        })
        .catch(e => {
            list.innerHTML = `<li style="justify-content:center; color:#ff4444;">Connection Failed: ${e.message}</li>`;
        });
}

function addItem() {
    const val = input.value.trim();
    if (!val) return;
    
    const key = KEYS[currentSubType];
    chrome.storage.local.get([key], (res) => {
        const items = res[key] || [];
        
        const newItem = (currentSubType === 'songs') 
            ? { title: val, artist: "Manual Entry" } 
            : val;

        const exists = items.some(i => getDisplayText(i) === getDisplayText(newItem));
        
        if (!exists) {
            items.push(newItem);
            chrome.storage.local.set({ [key]: items }, () => {
                input.value = '';
                render();
                showStatus('Added.');
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
        input.placeholder = `Add to ${currentSubType}...`;
        render();
    };
});

subtypeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
        if (!radio.checked) return;
        currentSubType = radio.value;
        subtypeOptions.forEach(opt => opt.classList.toggle('active', opt.dataset.value === currentSubType));
        input.value = '';
        input.placeholder = `Add to ${currentSubType}...`;
        render();
    });
});

addBtn.onclick = addItem;
input.addEventListener('keypress', e => { if(e.key === 'Enter') addItem(); });

btnRefresh.onclick = () => {
    if(currentTab === 'ai') fetchAIList();
    else render();
};

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
});

// Start
render();
loadEngineToggle();