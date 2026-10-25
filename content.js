/*
 * YTM Ward - Production Engine
 * Fix: "Whole Word" Matching (No more partial match false positives)
 */

let blockList = [];
let aiArtistList = [];
// lower-case имя из базы → имя в оригинальном регистре (для записи в Whitelist)
let aiArtistNames = new Map();

// Whitelist: whitelist — все записи (артисты + ключевые слова + треки), whitelistArtists — только артисты
// (по ним судим о строках в списках, где нам известен лишь артист).
let whitelist = [];
let whitelistArtists = [];
const WL_KEYS = ['whitelistedArtists', 'whitelistedKeywords', 'whitelistedTracks'];
const BL_KEYS = ['blockedArtists', 'blockedKeywords', 'blockedTracks'];
let lastProcessedSong = ""; 

const DEFAULT_AI_ACTIONS = { label: true, dislike: true, skipAi: false };
let aiActions = { ...DEFAULT_AI_ACTIONS };

let engineEnabled = true;

let dislikedTracksThisSession = new Set();
function trackKey(song) { return `${song.artist}||${song.title}`; }

const ACTION_DELAY_MS = 1000;
let pendingActionTimer = null;

console.log("[YTM Ward] Engine Started. Created by Spirit Flame (spiritflame@tutamail.com)");

function waitForElement(selector) {
    return new Promise(resolve => {
        if (document.querySelector(selector)) return resolve(document.querySelector(selector));
        const observer = new MutationObserver(() => {
            if (document.querySelector(selector)) {
                observer.disconnect();
                resolve(document.querySelector(selector));
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    });
}

function simulateClick(element) {
    ['mousedown', 'mouseup', 'click'].forEach(eventType => {
        element.dispatchEvent(new MouseEvent(eventType, {
            bubbles: true,
            cancelable: true,
            view: window
        }));
    });
}

function normalizeRemoteArtists(rawArray) {
    if (!Array.isArray(rawArray)) return [];
    return rawArray
        .map(item => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') {
                if (item.removed === true) return null;
                return item.name || item.artist || item.artist_name || item.artistName || item.title || null;
            }
            return null;
        })
        .filter(name => typeof name === 'string' && name.trim().length > 0);
}

async function loadAIActions() {
    const data = await chrome.storage.local.get(['aiActions']);
    aiActions = { ...DEFAULT_AI_ACTIONS, ...(data.aiActions || {}) };
    console.log("[YTM Ward] AI actions loaded:", aiActions);
}

async function loadEngineEnabled() {
    const data = await chrome.storage.local.get(['engineEnabled']);
    engineEnabled = data.engineEnabled !== false;
    console.log("[YTM Ward] Engine enabled:", engineEnabled);
}

function rebuildManualBlockList(localArtists, localKeywords, localTracks) {
    const trackTitles = localTracks.map(t => (typeof t === 'object' && t.title) ? t.title : t);
    const rawManual = [...localArtists, ...localKeywords, ...trackTitles];

    blockList = [...new Set(rawManual)]
        .filter(item => typeof item === 'string' && item.trim().length > 0)
        .map(s => s.toLowerCase())
        .sort();
}

// Текст записи для сравнения: у трека — title (так же, как матчится в блок-листе), иначе сама строка.
function termText(item) {
    const v = (item && typeof item === 'object') ? item.title : item;
    return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

async function loadWhitelist() {
    const d = await chrome.storage.local.get(WL_KEYS);
    const toTerms = items => (items || []).map(termText).filter(Boolean);
    whitelistArtists = [...new Set(toTerms(d.whitelistedArtists))];
    whitelist = [...new Set([...whitelistArtists, ...toTerms(d.whitelistedKeywords), ...toTerms(d.whitelistedTracks)])];
    console.log(`[YTM Ward] Whitelist: ${whitelist.length} terms.`);
}

// Удаляет из указанных списков записи, чей текст совпадает с одним из texts (без учёта регистра).
// Нужно, чтобы Blocklist и Whitelist не содержали одну и ту же запись одновременно.
async function removeFromLists(keys, texts) {
    const targets = new Set(texts.map(t => String(t || '').trim().toLowerCase()).filter(Boolean));
    if (!targets.size) return 0;
    const data = await chrome.storage.local.get(keys);
    const update = {};
    let removed = 0;
    for (const key of keys) {
        const items = data[key] || [];
        const kept = items.filter(i => !targets.has(termText(i)));
        if (kept.length !== items.length) {
            update[key] = kept;
            removed += items.length - kept.length;
        }
    }
    if (removed) await chrome.storage.local.set(update);
    return removed;
}

function isWhitelistedSong(song) {
    if (!whitelist.length) return false;
    return !!findWholeWordMatch((song.artist + " " + song.title).toLowerCase(), whitelist);
}

function isArtistTextWhitelisted(artistText) {
    if (!whitelistArtists.length) return false;
    return !!findWholeWordMatch(artistText.toLowerCase(), whitelistArtists);
}

// Клик по красному бейджу: добавляем в Whitelist найденных в AI-базе артистов
// и убираем такие же записи из Blocklist.
async function addAIArtistsToWhitelist(artistText) {
    const lower = artistText.toLowerCase();
    const names = [];
    const seen = new Set();
    aiArtistList.forEach(term => {
        if (seen.has(term) || !matchesTerm(lower, term)) return;
        seen.add(term);
        names.push(aiArtistNames.get(term) || term);
    });
    if (!names.length) return;

    const data = await chrome.storage.local.get(['whitelistedArtists']);
    const list = data.whitelistedArtists || [];
    const have = new Set(list.map(termText));
    const toAdd = names.filter(n => !have.has(n.toLowerCase()));
    if (toAdd.length) await chrome.storage.local.set({ whitelistedArtists: [...list, ...toAdd] });

    await removeFromLists(BL_KEYS, names);
    console.log(`[YTM Ward] ⚪ Whitelisted: ${names.join(', ')}`);
}

// Клик по белому бейджу в плеере: убираем из Whitelist все записи, из-за которых трек считается белым.
async function removeSongFromWhitelist(song) {
    const checkString = (song.artist + " " + song.title).toLowerCase();
    const data = await chrome.storage.local.get(WL_KEYS);
    const update = {};
    WL_KEYS.forEach(key => {
        const items = data[key] || [];
        const kept = items.filter(i => {
            const t = termText(i);
            return !t || !matchesTerm(checkString, t);
        });
        if (kept.length !== items.length) update[key] = kept;
    });
    if (Object.keys(update).length) await chrome.storage.local.set(update);
    console.log(`[YTM Ward] Removed from whitelist: "${song.artist} — ${song.title}"`);
}

// Клик по белому бейджу в строке списка: у строки известен только артист.
async function removeArtistTextFromWhitelist(artistText) {
    const lower = artistText.toLowerCase();
    const data = await chrome.storage.local.get(['whitelistedArtists']);
    const items = data.whitelistedArtists || [];
    const kept = items.filter(i => {
        const t = termText(i);
        return !t || !matchesTerm(lower, t);
    });
    if (kept.length !== items.length) await chrome.storage.local.set({ whitelistedArtists: kept });
}

async function onPlayerBadgeClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const song = getSongInfo();
    if (!song) return;
    if (isWhitelistedSong(song)) await removeSongFromWhitelist(song);
    else await addAIArtistsToWhitelist(song.artist);
}

async function refreshManualBlockList() {
    const localData = await chrome.storage.local.get(['blockedArtists', 'blockedKeywords', 'blockedTracks']);
    rebuildManualBlockList(localData.blockedArtists || [], localData.blockedKeywords || [], localData.blockedTracks || []);
    console.log(`[YTM Ward] Manual blocklist (local only): ${blockList.length} terms.`);
}

async function updateBlockList() {
    const localData = await chrome.storage.local.get(['blockedArtists', 'blockedKeywords', 'blockedTracks', 'sourceEnabled']);
    const localArtists = localData.blockedArtists || [];
    const localKeywords = localData.blockedKeywords || []; 
    const localTracks = localData.blockedTracks || []; 
    // Источник ZoundHub можно выключить на вкладке AI DB (по умолчанию включён)
    const zoundhubEnabled = !(localData.sourceEnabled && localData.sourceEnabled.zoundhub === false);
    
    let remoteArtists = [];
    try {
        if (!zoundhubEnabled) throw new Error('source disabled');
        const result = await chrome.runtime.sendMessage({ type: 'FETCH_AI_ARTISTS' });
        if (result && result.ok) {
            const data = result.data;
            let rawList;
            if (Array.isArray(data)) rawList = data;
            else if (data.artists && Array.isArray(data.artists)) rawList = data.artists;
            else if (data.data && Array.isArray(data.data)) rawList = data.data;
            else if (data.results && Array.isArray(data.results)) rawList = data.results;
            else if (data.items && Array.isArray(data.items)) rawList = data.items;
            else rawList = Object.values(data).flat();

            remoteArtists = normalizeRemoteArtists(rawList);
            console.log(`[YTM Ward] ZoundHub: fetch OK, ${remoteArtists.length} names after normalization.`);
        } else {
            console.warn(`[YTM Ward] ZoundHub: returned an error:`, result && result.error);
        }
    } catch (e) {
        console.warn("[YTM Ward] ZoundHub: failed with an error:", e);
    }

    aiArtistList = remoteArtists.map(s => s.toLowerCase());
    aiArtistNames = new Map();
    remoteArtists.forEach(name => { const k = name.toLowerCase(); if (!aiArtistNames.has(k)) aiArtistNames.set(k, name.trim()); });

    rebuildManualBlockList(localArtists, localKeywords, localTracks);
        
    console.log(`[YTM Ward] Manual blocklist: ${blockList.length} terms. AI database: ${aiArtistList.length} artists.`);
    scheduleScan();
}

function matchesTerm(text, term) {
    const safeTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${safeTerm}\\b`, 'i');
    return regex.test(text);
}

function findWholeWordMatch(text, list) {
    return list.find(term => matchesTerm(text, term));
}

function skipTrack(expectedSong) {
    hideBadgeImmediately();

    const songBeforeSkip = getSongInfo();

    if (expectedSong && songBeforeSkip && songBeforeSkip.title !== expectedSong.title) {
        console.log(`[YTM Ward] Трек уже сменился сам, пока ждали действия ("${expectedSong.title}" → "${songBeforeSkip.title}") — skip отменён.`);
        return;
    }

    const nextBtn = document.querySelector("ytmusic-player-bar .next-button");
    if (nextBtn) simulateClick(nextBtn);

    setTimeout(() => {
        const songNow = getSongInfo();
        if (songBeforeSkip && songNow && songNow.title !== songBeforeSkip.title) return;

        const video = document.querySelector("video");
        if (video && !video.ended) video.currentTime = video.duration || 99999;
    }, 500);
}

function isAlreadyDisliked(dislikeWrapper, actualBtn, song) {
    const domPressed = dislikeWrapper.getAttribute("aria-pressed") === "true" ||
                       actualBtn.getAttribute("aria-pressed") === "true";
    const memoryPressed = song ? dislikedTracksThisSession.has(trackKey(song)) : false;
    return domPressed || memoryPressed;
}

function handleDislikeAndSkip(song) {
    hideBadgeImmediately();

    const dislikeWrapper = document.querySelector(".middle-controls-buttons .dislike") || 
                           document.querySelector("ytmusic-player-bar .dislike");

    if (!dislikeWrapper) {
        console.log("[YTM Ward] Dislike button not found — performing a standard skip.");
        skipTrack();
        return;
    }

    const actualBtn = dislikeWrapper.querySelector("button") || dislikeWrapper;

    if (isAlreadyDisliked(dislikeWrapper, actualBtn, song)) {
        console.log("[YTM Ward] Already hit dislike — switching to the next track.");
        if (song) dislikedTracksThisSession.add(trackKey(song));
        skipTrack();
    } else {
        console.log("[YTM Ward] The dislike button hasn't been pressed — pressing it now.");
        simulateClick(actualBtn);
        if (song) dislikedTracksThisSession.add(trackKey(song));
    }
}

function extractArtistOnly(rawByline) {
    return rawByline.split(/\s*•\s*/)[0].trim();
}

function getBylineText(bylineEl) {
    // Бейдж "AI" лежит ВНУТРИ byline (prepend) — его текст "AI" нельзя
    // учитывать при распознавании артиста, иначе artist станет "AI<name>",
    // мэтч пропадёт, бейдж снимется, мэтч вернётся... = мигание.
    const badge = bylineEl.querySelector("#ytm-ward-ai-badge");
    if (!badge) return bylineEl.textContent.trim();
    const clone = bylineEl.cloneNode(true);
    clone.querySelector("#ytm-ward-ai-badge")?.remove();
    return clone.textContent.trim();
}

function getSongInfo() {
    const titleEl = document.querySelector("ytmusic-player-bar .title");
    const bylineEl = document.querySelector("ytmusic-player-bar .byline");
    if (!titleEl || !bylineEl) return null;

    const rawByline = getBylineText(bylineEl);
    const video = document.querySelector("video");

    return {
        title: titleEl.textContent.trim(),
        artist: extractArtistOnly(rawByline),
        rawByline,
        // NEW: YTM продолжает показывать title/byline последнего трека и на
        // паузе — это не баг страницы, но вкладке Info нужно знать реальное
        // состояние воспроизведения, а не только "какой трек загружен".
        isPaused: video ? video.paused : false
    };
}

// Красный бейдж — AI-артист из базы; белый с тёмной обводкой — артист в Whitelist.
// Размеры у обоих одинаковые (у красного обводка прозрачная), чтобы бейдж не «прыгал» при смене цвета.
function applyBadgeLook(badge, whitelisted) {
    const isSmall = badge.dataset.size === 'small';
    badge.dataset.wl = whitelisted ? '1' : '0';
    badge.title = whitelisted
        ? "В Whitelist. Нажмите, чтобы убрать"
        : "Найден в базе ZoundHub как вероятный AI-артист. Нажмите, чтобы добавить в Whitelist";
    badge.style.cssText = `
        display: inline-flex; align-items: center; justify-content: center;
        align-self: center; flex-shrink: 0;
        box-sizing: border-box; line-height: 1; white-space: nowrap; user-select: none;
        cursor: pointer;
        background: ${whitelisted ? '#fff' : '#ff2d2d'}; color: ${whitelisted ? '#111' : '#fff'};
        border: 1px solid ${whitelisted ? '#333' : 'transparent'};
        font-size: ${isSmall ? '9px' : '10px'}; font-weight: 800; letter-spacing: 0.5px;
        border-radius: ${isSmall ? '3px' : '4px'}; padding: 0 ${isSmall ? '5px' : '6px'};
        height: ${isSmall ? '14px' : '16px'};
        margin: 0 ${isSmall ? '6px' : '8px'} 0 0; vertical-align: middle;
        position: relative; top: -1px;
    `;
}

function makeBadgeElement(size /* 'normal' | 'small' */, whitelisted = false) {
    const badge = document.createElement("span");
    badge.textContent = "AI";
    badge.dataset.size = size === 'small' ? 'small' : 'normal';
    applyBadgeLook(badge, whitelisted);
    return badge;
}

function updateAIBadge(show, whitelisted = false) {
    const bylineEl = document.querySelector("ytmusic-player-bar .byline");
    if (!bylineEl) return;

    let badge = document.getElementById("ytm-ward-ai-badge");

    if (show) {
        if (!badge) {
            badge = makeBadgeElement('normal', whitelisted);
            badge.id = "ytm-ward-ai-badge";
            badge.addEventListener("click", onPlayerBadgeClick);
            bylineEl.prepend(badge);
        } else if (badge.dataset.wl !== (whitelisted ? '1' : '0')) {
            applyBadgeLook(badge, whitelisted);
        }
    } else if (badge) {
        badge.remove();
    }
}

function getRowArtistElement(row) {
    const byline = row.querySelector("yt-formatted-string.byline") || row.querySelector(".byline");
    if (byline) return byline;

    const secondaryCol = row.querySelector(".secondary-flex-columns .flex-column");
    if (secondaryCol) {
        return secondaryCol.querySelector("yt-formatted-string") || secondaryCol;
    }

    return null;
}

function getBadgesContainer(row) {
    return row.querySelector("#badges");
}

function scanRowsForBadges() {
    if (!engineEnabled || !aiArtistList.length) return;

    const rows = document.querySelectorAll(
        "ytmusic-responsive-list-item-renderer, ytmusic-two-row-item-renderer, ytmusic-player-queue-item"
    );

    rows.forEach(row => {
        const bylineEl = getRowArtistElement(row);
        if (!bylineEl) return;

        const artistLinks = Array.from(bylineEl.querySelectorAll("a"));
        let artistText;
        if (artistLinks.length) {
            artistText = artistLinks.map(a => a.textContent.trim()).join(", ");
        } else {
            // Тот же фикс, что в плеере: текст бейджа не должен попадать в artistText
            const clone = bylineEl.cloneNode(true);
            clone.querySelector(".ytm-ward-row-ai-badge")?.remove();
            artistText = extractArtistOnly(clone.textContent.trim());
        }
        if (!artistText) return;

        let isAI;
        if (row.dataset.ytmwardChecked === artistText) {
            isAI = row.dataset.ytmwardAi === '1';
        } else {
            isAI = !!findWholeWordMatch(artistText.toLowerCase(), aiArtistList);
            row.dataset.ytmwardChecked = artistText;
            row.dataset.ytmwardAi = isAI ? '1' : '0';
        }

        const shouldShow = isAI && aiActions.label;
        const isWhite = isArtistTextWhitelisted(artistText);
        let badge = row.querySelector(".ytm-ward-row-ai-badge");

        if (shouldShow && !badge) {
            badge = makeBadgeElement('small', isWhite);
            badge.classList.add("ytm-ward-row-ai-badge");
            // Клик по бейджу не должен запускать воспроизведение строки
            ['dblclick', 'mousedown'].forEach(type => badge.addEventListener(type, e => e.stopPropagation()));
            badge.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const text = row.dataset.ytmwardChecked;
                if (!text) return;
                if (badge.dataset.wl === '1') removeArtistTextFromWhitelist(text);
                else addAIArtistsToWhitelist(text);
            });

            const badgesContainer = getBadgesContainer(row);
            if (badgesContainer) {
                badgesContainer.appendChild(badge);
            } else {
                bylineEl.prepend(badge);
            }
        } else if (!shouldShow && badge) {
            badge.remove();
        } else if (badge && badge.dataset.wl !== (isWhite ? '1' : '0')) {
            applyBadgeLook(badge, isWhite);
        }
    });
}

function clearAllBadges() {
    const playerBadge = document.getElementById("ytm-ward-ai-badge");
    if (playerBadge) playerBadge.remove();
    document.querySelectorAll(".ytm-ward-row-ai-badge").forEach(b => b.remove());
}

function removeInjectedButtons() {
    const controls = document.getElementById("ytm-ward-controls");
    if (controls) controls.remove();
}

let scanTimer = null;
function scheduleScan() {
    if (!engineEnabled) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanRowsForBadges, 300);
}

function scheduleDislikeAndSkipCheck(song) {
    clearTimeout(pendingActionTimer);
    pendingActionTimer = setTimeout(() => {
        const current = getSongInfo();
        if (!current || current.title !== song.title) {
            console.log(`[YTM Ward] Track changed during the delay — action for "${song.title}" cancelled.`);
            return;
        }
        console.log(`[YTM Ward] 🤖 AI detected (Dislike AI and Skip, после ${ACTION_DELAY_MS}мs) — artist="${current.artist}"`);
        recordAIBlock();
        handleDislikeAndSkip(current);
    }, ACTION_DELAY_MS);
}

function scheduleManualBlockCheck(song, matchedTerm) {
    clearTimeout(pendingActionTimer);
    pendingActionTimer = setTimeout(() => {
        const current = getSongInfo();
        if (!current || current.title !== song.title) {
            console.log(`[YTM Ward] Track changed during the delay — action for "${song.title}" cancelled.`);
            return;
        }
       console.log(`[YTM Ward] 🛑 BLOCKED (manual list): term="${matchedTerm}" | artist="${current.artist}" | title="${current.title}"`);
       handleDislikeAndSkip(current);
    }, ACTION_DELAY_MS);
}

const SETTLE_DELAY_MS = 1000;
let settleTimer = null;
let settleTitle = null;

const BADGE_SETTLE_MS = 250;
let badgeTimer = null;

function scheduleBadgeUpdate() {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => {
        const song = getSongInfo();
        if (!song) return;
        const aiMatch = !!findWholeWordMatch(song.artist.toLowerCase(), aiArtistList);
        const whitelisted = isWhitelistedSong(song);
        updateAIBadge(aiMatch && aiActions.label, whitelisted);

        // NEW: текущий трек пишем в storage — его читает вкладка Info в попапе
        // (popup.js не имеет доступа к DOM страницы, только к chrome.storage).
        chrome.storage.local.set({
            nowPlaying: { artist: song.artist, title: song.title, aiMatch, whitelisted, isPaused: song.isPaused, updatedAt: Date.now() }
        });
    }, BADGE_SETTLE_MS);
}

// NEW: статистика для вкладки Info — считаем ТОЛЬКО авто-блокировки по
// AI-базе (не ручные Keywords/Songs/Artists), в момент, когда расширение
// САМО инициирует скип/дизлайк из-за обнаружения AI-исполнителя.
async function recordAIBlock() {
    const data = await chrome.storage.local.get(['stats']);
    const stats = data.stats || { totalBlocked: 0, dailyBlocked: {}, firstBlockedAt: null };

    const now = Date.now();
    const dayKey = new Date(now).toLocaleDateString('en-CA'); // YYYY-MM-DD по локальному времени

    stats.totalBlocked = (stats.totalBlocked || 0) + 1;
    stats.dailyBlocked = stats.dailyBlocked || {};
    stats.dailyBlocked[dayKey] = (stats.dailyBlocked[dayKey] || 0) + 1;
    if (!stats.firstBlockedAt) stats.firstBlockedAt = now;

    await chrome.storage.local.set({ stats });
}

function hideBadgeImmediately() {
    clearTimeout(badgeTimer);
    updateAIBadge(false);
}

// ===== «Назад» пропускает треки, которые расширение само бы скипнуло =====
// Проблема: на 5-м треке жмём «назад» → YTM включает 4-й (AI) → расширение его
// скипает вперёд → снова играет 5-й. Теперь после пользовательского клика по
// «назад» мы сами листаем назад, пока не встретим трек, который расширение
// не стало бы скипать (не AI / не в ручном бане), и останавливаемся на нём.
const BACK_SETTLE_MS = 700;      // ждём, пока title и byline нового трека обновятся согласованно
const BACK_TITLE_WAIT_MS = 3000; // сколько ждём смены трека после клика «назад»
const BACK_MAX_STEPS = 100;      // предохранитель от бесконечного цикла
let backSeekActive = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Резолвит новый song, как только title отличается от prevTitle; null — если не дождались.
function waitForTitleChange(prevTitle, timeoutMs) {
    return new Promise(resolve => {
        const started = Date.now();
        const tick = () => {
            const s = getSongInfo();
            if (s && s.title && s.title !== prevTitle) return resolve(s);
            if (Date.now() - started >= timeoutMs) return resolve(null);
            setTimeout(tick, 100);
        };
        tick();
    });
}

// Скипнуло бы расширение этот трек само? (ручной бан, либо AI при включённых
// Dislike AI and Skip / Skip AI). Если действия выключены — «назад» работает как обычно.
function wouldAutoHandle(song) {
    if (isWhitelistedSong(song)) return false; // Whitelist главнее любых блокировок
    const checkString = (song.artist + " " + song.title).toLowerCase();
    if (findWholeWordMatch(checkString, blockList)) return true;
    const aiMatch = findWholeWordMatch(song.artist.toLowerCase(), aiArtistList);
    return !!aiMatch && (aiActions.dislike || aiActions.skipAi);
}

async function backSeekFlow(originSong) {
    backSeekActive = true;
    clearTimeout(settleTimer);
    clearTimeout(pendingActionTimer);

    let moved = false;
    let wasMuted = null;
    try {
        const first = await waitForTitleChange(originSong.title, BACK_TITLE_WAIT_MS);
        // Title не изменился — YTM просто перемотал текущий трек в начало
        // (так он делает, если играло больше ~3 сек). Это не переход назад.
        if (!first) return;
        moved = true;

        // Глушим звук на время перемотки, чтобы AI-треки не проигрывались вслух
        const video = document.querySelector("video");
        if (video) { wasMuted = video.muted; video.muted = true; }

        for (let step = 0; step < BACK_MAX_STEPS; step++) {
            await sleep(BACK_SETTLE_MS);
            const song = getSongInfo();
            if (!song) break;

            if (!wouldAutoHandle(song)) {
                console.log(`[YTM Ward] ⏮ Back: stopped at "${song.artist} — ${song.title}"`);
                break;
            }

            const prevBtn = document.querySelector("ytmusic-player-bar .previous-button");
            if (!prevBtn) break;
            console.log(`[YTM Ward] ⏮ Back: "${song.artist} — ${song.title}" would be skipped — going back further.`);
            hideBadgeImmediately();
            simulateClick(prevBtn);

            const next = await waitForTitleChange(song.title, BACK_TITLE_WAIT_MS);
            if (!next) {
                // Дошли до начала очереди — дальше назад некуда. Обычная логика
                // ниже сама прогонит этот трек (и следующие AI) вперёд.
                console.log("[YTM Ward] ⏮ Back: reached the start of the queue.");
                break;
            }
        }
    } finally {
        if (wasMuted !== null) {
            const v = document.querySelector("video");
            if (v) v.muted = wasMuted;
        }
        backSeekActive = false;
        if (moved) {
            // Отдаём итоговый трек обычной логике (плашка и т.д.)
            lastProcessedSong = "";
            settleTitle = null;
            checkAndSkip();
            scheduleBadgeUpdate();
        }
    }
}

// Общая точка входа: запоминаем текущий трек ДО того, как YTM переключится, и запускаем перемотку.
function triggerBackSeek() {
    if (!engineEnabled || backSeekActive) return;
    const origin = getSongInfo();
    if (origin) backSeekFlow(origin);
}

// 1) Клик мышью по «назад». Только настоящие клики (isTrusted) — свои simulateClick из цикла выше игнорируем.
function onPlayerBarClick(e) {
    if (!e.isTrusted) return;
    if (!e.target.closest || !e.target.closest(".previous-button")) return;
    triggerBackSeek();
}

// 2) Горячая клавиша YTM «предыдущий трек» — Shift+P. По e.code, чтобы работало
// и на русской раскладке. В полях ввода (поиск и т.п.) не реагируем.
function onGlobalKeyDown(e) {
    if (!e.isTrusted || e.repeat) return;
    if (e.code !== "KeyP" || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    const t = (e.composedPath && e.composedPath()[0]) || e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    triggerBackSeek();
}

// 3) Медиа-клавиши и кнопки гарнитуры — событие шлёт mediasession-hook.js (MAIN world).
document.addEventListener("ytm-ward:prev-media", triggerBackSeek);


function checkAndSkip() {
    if (!engineEnabled || backSeekActive) return;

    const song = getSongInfo();
    if (!song) return;

    if (song.title !== settleTitle) {
        settleTitle = song.title;
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => processSettledSong(settleTitle), SETTLE_DELAY_MS);
    }
}

function processSettledSong(expectedTitle) {
    if (backSeekActive) return;
    const song = getSongInfo();
    if (!song || song.title !== expectedTitle) return;

    const aiMatch = !!findWholeWordMatch(song.artist.toLowerCase(), aiArtistList);
    const whitelisted = isWhitelistedSong(song);
    updateAIBadge(aiMatch && aiActions.label, whitelisted);

    if (song.title === lastProcessedSong) return;
    lastProcessedSong = song.title;

    // Whitelist главнее и ручного блок-листа, и AI-базы — никаких действий с таким треком
    if (whitelisted) return;

    const checkString = (song.artist + " " + song.title).toLowerCase();
    const manualTerm = findWholeWordMatch(checkString, blockList);

    if (manualTerm) {
        scheduleManualBlockCheck(song, manualTerm);
        return;
    }

    if (aiMatch) {
        if (aiActions.dislike) {
            // "Dislike AI and Skip" имеет приоритет — "Skip AI" при этом игнорируется
            scheduleDislikeAndSkipCheck(song);
        } else if (aiActions.skipAi) {
            // "Skip AI" — сразу, без задержки и без дизлайка
            console.log(`[YTM Ward] 🤖 AI detected (Skip AI, instantly) — artist="${song.artist}"`);
            recordAIBlock();
            skipTrack();
        }
    }
}

// NEW: кнопки "Ban Artist" / "Ban Song" в стиле Material Design —
// tonal-кнопка (M3 error container), пилюля, иконка + ripple-эффект по клику.

function ensureMaterialButtonStyles() {
    if (document.getElementById("ytm-ward-md-styles")) return;
    const style = document.createElement("style");
    style.id = "ytm-ward-md-styles";
    style.textContent = `
        .ytm-ward-md-btn {
            position: relative;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            height: 32px;
            padding: 0 14px 0 10px;
            border: none;
            border-radius: 16px;
            background: rgba(255, 82, 82, 0.16);
            color: #ffb4ab;
            font-family: "Roboto", "YouTube Sans", Arial, sans-serif;
            font-size: 12px;
            font-weight: 500;
            letter-spacing: 0.15px;
            line-height: 1;
            cursor: pointer;
            overflow: hidden;
            -webkit-tap-highlight-color: transparent;
            transition: background-color 150ms cubic-bezier(0.4,0,0.2,1),
                        box-shadow 150ms cubic-bezier(0.4,0,0.2,1);
        }
        .ytm-ward-md-btn:hover { background: rgba(255, 82, 82, 0.24); }
        .ytm-ward-md-btn:active { background: rgba(255, 82, 82, 0.32); }
        .ytm-ward-md-btn:focus-visible {
            outline: 2px solid #ffb4ab;
            outline-offset: 2px;
        }
        .ytm-ward-md-btn__icon {
            display: inline-flex;
            width: 16px; height: 16px;
            flex-shrink: 0;
        }
        .ytm-ward-md-btn__icon svg { width: 100%; height: 100%; display: block; }
        .ytm-ward-md-btn__ripple {
            position: absolute;
            border-radius: 50%;
            background: currentColor;
            opacity: 0.3;
            transform: scale(0);
            pointer-events: none;
        }
        .ytm-ward-md-btn__ripple.is-animating {
            animation: ytmWardRipple 450ms cubic-bezier(0.4,0,0.2,1);
        }
        @keyframes ytmWardRipple {
            to { transform: scale(2.5); opacity: 0; }
        }
    `;
    document.head.appendChild(style);
}

const BAN_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="5.5" y1="18.5" x2="18.5" y2="5.5"/></svg>`;

function spawnRipple(btn, event) {
    const ripple = btn.querySelector(".ytm-ward-md-btn__ripple");
    if (!ripple) return;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = (event ? event.clientX - rect.left : rect.width / 2) - size / 2;
    const y = (event ? event.clientY - rect.top : rect.height / 2) - size / 2;
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    ripple.classList.remove("is-animating");
    void ripple.offsetWidth; // reflow, чтобы анимация перезапускалась при повторных кликах
    ripple.classList.add("is-animating");
}

function createButton(label, iconSvg, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ytm-ward-md-btn";
    btn.innerHTML = `
        <span class="ytm-ward-md-btn__ripple"></span>
        <span class="ytm-ward-md-btn__icon">${iconSvg}</span>
        <span class="ytm-ward-md-btn__label">${label}</span>
    `;
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        spawnRipple(btn, e);
        onClick();
    });
    return btn;
}

function injectButtons() {
    if (!engineEnabled) return;
    if (document.getElementById("ytm-ward-controls")) return;

    ensureMaterialButtonStyles();

    const threeDots = document.querySelector("ytmusic-player-bar .middle-controls-buttons ytmusic-menu-renderer") ||
                      document.querySelector("ytmusic-player-bar ytmusic-menu-renderer");

    const targetParent = threeDots ? threeDots.parentNode : document.querySelector("ytmusic-player-bar .middle-controls-buttons");

    if (targetParent) {
        const container = document.createElement("div");
        container.id = "ytm-ward-controls";
        container.style.display = "inline-flex";
        container.style.alignItems = "center";
        container.style.gap = "6px";
        container.style.margin = "0 6px";

        container.appendChild(createButton("Ban Artist", BAN_ICON_SVG, () => {
            const song = getSongInfo();
            if (song) addToBlockList(song.artist, 'blockedArtists', song);
        }));

        container.appendChild(createButton("Ban Song", BAN_ICON_SVG, () => {
            const song = getSongInfo();
            if (song) addToBlockList(song, 'blockedTracks', song);
        }));

        if (threeDots && threeDots.nextSibling) {
            targetParent.insertBefore(container, threeDots.nextSibling);
        } else {
            targetParent.appendChild(container);
        }
    }
}

async function addToBlockList(term, listName, songAtClick) {
    if (!term) return;
    const targetList = listName || 'blockedArtists';
    
    const localData = await chrome.storage.local.get([targetList]);
    let list = localData[targetList] || [];
    
    const exists = list.some(item => {
        if (typeof term === 'string') return item === term;
        return item.title === term.title;
    });

    if (!exists) {
        list.push(term);
        const update = {};
        update[targetList] = list;
        await chrome.storage.local.set(update);
        // Бан и Whitelist взаимоисключающие: такая же запись в Whitelist убирается
        await removeFromLists(WL_KEYS, [termText(term)]);
        await refreshManualBlockList(); 
        const currentSong = getSongInfo();
        if (songAtClick && currentSong && currentSong.title === songAtClick.title) {
             handleDislikeAndSkip(getSongInfo());
        } else {
            scheduleScan(); 
        }
    }
}

async function init() {
    await Promise.all([updateBlockList(), loadAIActions(), loadEngineEnabled(), loadWhitelist()]);
    const playerBar = await waitForElement("ytmusic-player-bar");
    injectButtons();
    checkAndSkip();
    scanRowsForBadges();

    const nextBtn = playerBar.querySelector(".next-button");
    const prevBtn = playerBar.querySelector(".previous-button");
    [nextBtn, prevBtn].forEach(btn => {
        // Было hideBadgeImmediately: на каждый клик next/prev бейдж снимался
        // сразу, а через ~60мс ставился обратно = гарантированный блик.
        // Теперь просто ждём settle (250мс) и один раз выставляем итог.
        if (btn) btn.addEventListener("click", scheduleBadgeUpdate, true);
    });
    // Делегирование на весь player bar — не теряется, если YTM перерисует саму кнопку
    playerBar.addEventListener("click", onPlayerBarClick, true);
    document.addEventListener("keydown", onGlobalKeyDown, true);

    const observer = new MutationObserver(() => {
        checkAndSkip(); 
        if (engineEnabled && !document.getElementById("ytm-ward-controls")) injectButtons();
    });
    observer.observe(playerBar, { subtree: true, childList: true, attributes: true });

    const bodyObserver = new MutationObserver(() => scheduleScan());
    bodyObserver.observe(document.body, { childList: true, subtree: true });
    
    const titleNode = document.querySelector("ytmusic-player-bar .title");
    if (titleNode) {
        new MutationObserver(() => { checkAndSkip(); scheduleBadgeUpdate(); })
            .observe(titleNode, { characterData: true, subtree: true, childList: true });
    }

    const bylineNode = document.querySelector("ytmusic-player-bar .byline");
    if (bylineNode) {
        // Игнорируем собственные мутации бейджа (prepend/remove внутри byline),
        // иначе каждая наша вставка перезапускала бы scheduleBadgeUpdate = цикл/мигание.
        new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const n of m.addedNodes) {
                    if (n.nodeType === 1 && (n.id === "ytm-ward-ai-badge" || n.querySelector?.("#ytm-ward-ai-badge"))) return;
                }
                for (const n of m.removedNodes) {
                    if (n.nodeType === 1 && (n.id === "ytm-ward-ai-badge" || n.querySelector?.("#ytm-ward-ai-badge"))) return;
                }
                if (m.target?.id === "ytm-ward-ai-badge") return;
            }
            scheduleBadgeUpdate();
        })
            .observe(bylineNode, { characterData: true, subtree: true, childList: true });
    }

    // NEW: пауза/плей не меняют title/byline, поэтому их наблюдатели выше
    // тут не сработают — слушаем сам <video>, чтобы Now Playing на вкладке
    // Info отражал реальное состояние воспроизведения сразу, а не только
    // при следующей смене трека.
    const video = document.querySelector("video");
    if (video) {
        video.addEventListener("play", scheduleBadgeUpdate);
        video.addEventListener("pause", scheduleBadgeUpdate);
    }

    scheduleBadgeUpdate(); // выставить корректное состояние бейджа сразу при инициализации
}

if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'local') return;

    if (changes.engineEnabled) {
        engineEnabled = changes.engineEnabled.newValue !== false;
        console.log("[YTM Ward] Engine toggled:", engineEnabled);

        if (!engineEnabled) {
            clearTimeout(pendingActionTimer);
            clearAllBadges();
            removeInjectedButtons();
        } else {
            lastProcessedSong = ""; // пересчитать текущий трек с нуля после включения
            settleTitle = null;     // иначе checkAndSkip() решит, что title не менялся, и ничего не запустит
            injectButtons();
            checkAndSkip();
            scanRowsForBadges();
            scheduleBadgeUpdate();
        }
        return;
    }

    if (changes.aiActions) {
        loadAIActions().then(() => {
            // NEW: сброс "уже обработан" — иначе трек, который уже проверялся
            // при старых настройках, не пересчитается заново под новые
            lastProcessedSong = "";
            settleTitle = null; // иначе checkAndSkip() решит, что title не менялся, и ничего не запустит
            scheduleScan();
            checkAndSkip();
            scheduleBadgeUpdate();
        });
        return;
    }

    // Whitelist изменили (из попапа или кликом по бейджу): перечитываем и пересчитываем текущий трек.
    // Отложенное действие над треком отменяем — иначе трек, только что попавший в Whitelist, мог бы
    // успеть получить дизлайк/скип.
    if (changes.whitelistedArtists || changes.whitelistedKeywords || changes.whitelistedTracks) {
        loadWhitelist().then(() => {
            clearTimeout(pendingActionTimer);
            document.querySelectorAll('[data-ytmward-checked]').forEach(el => { delete el.dataset.ytmwardChecked; delete el.dataset.ytmwardAi; });
            lastProcessedSong = "";
            settleTitle = null;
            scheduleScan();
            checkAndSkip();
            scheduleBadgeUpdate();
        });
    }

    // NEW: раньше сюда попадал ЛЮБОЙ другой ключ storage (включая новые
    // nowPlaying/stats/groqApiKey) и это вызывало полный updateBlockList()
    // с сетевым запросом к ZoundHub. nowPlaying пишется на каждую смену
    // трека — так что без этого фильтра AI-база переcкачивалась бы заново
    // на каждый трек. Реагируем только на реальные изменения блок-листов.
    if (changes.blockedArtists || changes.blockedKeywords || changes.blockedTracks) {
        updateBlockList();
    }

    // Источник ZoundHub включили/выключили на вкладке AI DB: пересобираем
    // список и сбрасываем кэш «уже проверено» у строк и текущего трека.
    const prevZ = !(changes.sourceEnabled && changes.sourceEnabled.oldValue && changes.sourceEnabled.oldValue.zoundhub === false);
    const nextZ = !(changes.sourceEnabled && changes.sourceEnabled.newValue && changes.sourceEnabled.newValue.zoundhub === false);
    if (changes.sourceEnabled && prevZ !== nextZ) {
        updateBlockList().then(() => {
            document.querySelectorAll('[data-ytmward-checked]').forEach(el => { delete el.dataset.ytmwardChecked; delete el.dataset.ytmwardAi; });
            clearAllBadges();
            lastProcessedSong = "";
            settleTitle = null;
            scheduleScan();
            checkAndSkip();
            scheduleBadgeUpdate();
        });
    }
});
