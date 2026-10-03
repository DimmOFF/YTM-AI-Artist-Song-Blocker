/*
 * YTM Ward - Popup Script (Counter Version)
 * Created by Spirit Flame modified by DimmOFF
 */

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

async function saveCachedVerdict(artist, isAI, reason) {
    const data = await chrome.storage.local.get(['aiVerdictCache', 'cacheSize']);
    const cache = data.aiVerdictCache || {};
    const maxSize = data.cacheSize || DEFAULT_CACHE_SIZE;

    cache[artist.toLowerCase()] = { isAI, reason, checkedAt: Date.now() };
    await chrome.storage.local.set({ aiVerdictCache: cache });
    await trimVerdictCache(maxSize);
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

function renderInfoTab() {
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
        const cached = await getCachedVerdict(requestedArtist);
        if (cached) {
            renderVerdict(requestedArtist, cached.isAI, cached.reason, true);
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
                    saveCachedVerdict(requestedArtist, isAI, reason); // не ждём — запись в фоне
                    renderVerdict(requestedArtist, isAI, reason, false);
                });
            })
            .catch(e => {
                renderGroqError(e.message);
            });
    });
}

function renderVerdict(artist, isAI, reason, fromCache) {
    groqBox.innerHTML = `
        <span class="groq-verdict-badge ${isAI ? 'is-ai' : 'not-ai'}">${isAI ? 'LIKELY AI' : 'LIKELY HUMAN'}</span>
        ${fromCache ? '<span style="font-size:10px; color:#666; margin-left:6px;">(cached)</span>' : ''}
        <div>${escapeHtml(reason || 'No details provided.')}</div>
    `;

    if (isAI) {
        const banBtn = document.createElement('button');
        banBtn.className = 'groq-ban-btn';
        banBtn.textContent = '🚫 Ban Artist';
        banBtn.onclick = () => banArtistFromInfo(artist, banBtn);
        groqBox.appendChild(banBtn);
    }
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
    retryBtn.onclick = () => renderInfoTab();
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