/*
 * YTM Ward - Production Engine
 * Fix: "Whole Word" Matching (No more partial match false positives)
 */

let blockList = [];
let aiArtistList = [];
let lastProcessedSong = ""; 

const DEFAULT_AI_ACTIONS = { label: true, dislike: true, skipAi: false };
let aiActions = { ...DEFAULT_AI_ACTIONS };

let engineEnabled = true;

let dislikedTracksThisSession = new Set();
function trackKey(song) { return `${song.artist}||${song.title}`; }

const ACTION_DELAY_MS = 2000;
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

async function updateBlockList() {
    const localData = await chrome.storage.local.get(['blockedArtists', 'blockedKeywords', 'blockedTracks']);
    const localArtists = localData.blockedArtists || [];
    const localKeywords = localData.blockedKeywords || []; 
    const localTracks = localData.blockedTracks || []; 
    
    let remoteArtists = [];
    try {
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
            console.log(`[YTM Ward] ZoundHub: fetch OK, ${remoteArtists.length} имён после нормализации.`);
        } else {
            console.warn(`[YTM Ward] ZoundHub: fetch вернул ошибку:`, result && result.error);
        }
    } catch (e) {
        console.warn("[YTM Ward] ZoundHub: fetch упал с ошибкой:", e);
    }

    aiArtistList = remoteArtists.map(s => s.toLowerCase());

    const trackTitles = localTracks.map(t => (typeof t === 'object' && t.title) ? t.title : t);
    const rawManual = [...localArtists, ...localKeywords, ...trackTitles];
    
    blockList = [...new Set(rawManual)]
        .filter(item => typeof item === 'string' && item.trim().length > 0)
        .map(s => s.toLowerCase())
        .sort(); 
        
    console.log(`[YTM Ward] Manual blocklist: ${blockList.length} terms. AI database: ${aiArtistList.length} artists.`);
    scheduleScan();
}

function findWholeWordMatch(text, list) {
    return list.find(term => {
        const safeTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${safeTerm}\\b`, 'i');
        return regex.test(text);
    });
}

function skipTrack() {
    const songBeforeSkip = getSongInfo();

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
    const dislikeWrapper = document.querySelector(".middle-controls-buttons .dislike") || 
                           document.querySelector("ytmusic-player-bar .dislike");

    if (!dislikeWrapper) {
        console.log("[YTM Ward] Кнопка Dislike не найдена — выполняю обычный skip.");
        skipTrack();
        return;
    }

    const actualBtn = dislikeWrapper.querySelector("button") || dislikeWrapper;

    if (isAlreadyDisliked(dislikeWrapper, actualBtn, song)) {
        console.log("[YTM Ward] Dislike уже нажат — переключаю на следующий трек.");
        if (song) dislikedTracksThisSession.add(trackKey(song));
        skipTrack();
    } else {
        console.log("[YTM Ward] Dislike не нажат — нажимаю.");
        simulateClick(actualBtn);
        if (song) dislikedTracksThisSession.add(trackKey(song));
    }
}

function performDownvoteAndSkip(song) {
    const dislikeWrapper = document.querySelector(".middle-controls-buttons .dislike") || 
                           document.querySelector("ytmusic-player-bar .dislike");

    if (!dislikeWrapper) { skipTrack(); return; }

    const actualBtn = dislikeWrapper.querySelector("button") || dislikeWrapper;

    if (isAlreadyDisliked(dislikeWrapper, actualBtn, song)) {
        if (song) dislikedTracksThisSession.add(trackKey(song));
        skipTrack();
        return;
    }

    simulateClick(actualBtn);
    if (song) dislikedTracksThisSession.add(trackKey(song));

    let attempts = 0;
    const poll = setInterval(() => {
        attempts++;
        const success = dislikeWrapper.getAttribute("aria-pressed") === "true" || 
                        actualBtn.getAttribute("aria-pressed") === "true";
        
        if (success || attempts >= 20) { 
            clearInterval(poll);
            if (success) setTimeout(() => { skipTrack(); }, 2000); 
            else skipTrack();
        }
    }, 100);
}

function extractArtistOnly(rawByline) {
    return rawByline.split(/\s*•\s*/)[0].trim();
}

function getSongInfo() {
    const titleEl = document.querySelector("ytmusic-player-bar .title");
    const bylineEl = document.querySelector("ytmusic-player-bar .byline");
    if (!titleEl || !bylineEl) return null;

    const rawByline = bylineEl.textContent.trim();
    return {
        title: titleEl.textContent.trim(),
        artist: extractArtistOnly(rawByline),
        rawByline
    };
}

function makeBadgeElement(size /* 'normal' | 'small' */) {
    const badge = document.createElement("span");
    badge.textContent = "AI";
    badge.title = "Найден в базе ZoundHub как вероятный AI-артист";
    const isSmall = size === 'small';
    badge.style.cssText = `
        display: inline-flex; align-items: center; justify-content: center;
        background: #ff2d2d; color: #fff;
        font-size: ${isSmall ? '9px' : '10px'}; font-weight: 800; letter-spacing: 0.5px;
        border-radius: ${isSmall ? '3px' : '4px'}; padding: ${isSmall ? '1px 5px' : '2px 6px'};
        height: ${isSmall ? '12px' : '14px'};
        margin-right: ${isSmall ? '6px' : '8px'}; vertical-align: middle; flex-shrink: 0;
    `;
    return badge;
}

function updateAIBadge(show) {
    const bylineEl = document.querySelector("ytmusic-player-bar .byline");
    if (!bylineEl) return;

    let badge = document.getElementById("ytm-ward-ai-badge");

    if (show) {
        if (!badge) {
            badge = makeBadgeElement('normal');
            badge.id = "ytm-ward-ai-badge";
            bylineEl.insertAdjacentElement('beforebegin', badge);
        }
    } else if (badge) {
        badge.remove();
    }
}

function getRowArtistElement(row) {
    return row.querySelector("yt-formatted-string.byline") || row.querySelector(".byline");
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
        const artistText = artistLinks.length
            ? artistLinks.map(a => a.textContent.trim()).join(", ")
            : extractArtistOnly(bylineEl.textContent.trim());
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
        let badge = row.querySelector(".ytm-ward-row-ai-badge");

        if (shouldShow && !badge) {
            badge = makeBadgeElement('small');
            badge.classList.add("ytm-ward-row-ai-badge");

            const badgesContainer = getBadgesContainer(row);
            if (badgesContainer) {
                badgesContainer.appendChild(badge);
            } else {
                bylineEl.insertAdjacentElement('beforebegin', badge);
            }
        } else if (!shouldShow && badge) {
            badge.remove();
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

// NEW: планирует проверку "Dislike AI and Skip" через ACTION_DELAY_MS.
// Перед выполнением сверяет, что трек не сменился за время ожидания.
function scheduleDislikeAndSkipCheck(song) {
    clearTimeout(pendingActionTimer);
    pendingActionTimer = setTimeout(() => {
        const current = getSongInfo();
        if (!current || current.title !== song.title) {
            console.log(`[YTM Ward] Трек сменился за время задержки — действие для "${song.title}" отменено.`);
            return;
        }
        console.log(`[YTM Ward] 🤖 AI detected (Dislike AI and Skip, после ${ACTION_DELAY_MS}мс) — artist="${current.artist}"`);
        handleDislikeAndSkip(current);
    }, ACTION_DELAY_MS);
}

// Ручные блокировки — та же 2-секундная защита, что и раньше.
function scheduleManualBlockCheck(song, matchedTerm) {
    clearTimeout(pendingActionTimer);
    pendingActionTimer = setTimeout(() => {
        const current = getSongInfo();
        if (!current || current.title !== song.title) {
            console.log(`[YTM Ward] Трек сменился за время задержки — действие для "${song.title}" отменено.`);
            return;
        }
        console.log(`[YTM Ward] 🛑 BLOCKED (manual list): term="${matchedTerm}" | artist="${current.artist}" | title="${current.title}"`);
        performDownvoteAndSkip(current);
    }, ACTION_DELAY_MS);
}

const SETTLE_DELAY_MS = 1000;
let settleTimer = null;
let settleTitle = null;

function checkAndSkip() {
    if (!engineEnabled) return;

    const song = getSongInfo();
    if (!song) return;

    if (song.title !== settleTitle) {
        // Название изменилось (или это первая проверка) — перезапускаем таймер
        // ожидания устаканивания. Пока трек не "устоится", ничего не решаем.
        settleTitle = song.title;
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => processSettledSong(settleTitle), SETTLE_DELAY_MS);
    }
}

function processSettledSong(expectedTitle) {
    const song = getSongInfo();
    // Если трек уже снова сменился за время ожидания — этот вызов устарел,
    // его подхватит уже новый таймер из checkAndSkip().
    if (!song || song.title !== expectedTitle) return;

    // Плашку показываем сразу после устаканивания — не зависит от состояния кнопки дизлайка
    const aiMatch = !!findWholeWordMatch(song.artist.toLowerCase(), aiArtistList);
    updateAIBadge(aiMatch && aiActions.label);

    if (song.title === lastProcessedSong) return;
    lastProcessedSong = song.title;

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
            console.log(`[YTM Ward] 🤖 AI detected (Skip AI, немедленно) — artist="${song.artist}"`);
            skipTrack();
        }
    }
}

function createButton(text, onClick) {
    const btn = document.createElement("button");
    btn.innerText = text;
    btn.style.cssText = `
        background: rgba(255, 0, 0, 0.2); border: 1px solid #ff4444; color: #ffcccc; 
        border-radius: 4px; margin: 0 5px; padding: 6px 12px; cursor: pointer; 
        font-size: 11px; font-weight: 800; text-transform: uppercase; z-index: 9999;
    `;
    btn.onmouseenter = () => { btn.style.background = "#ff4444"; btn.style.color = "black"; };
    btn.onmouseleave = () => { btn.style.background = "rgba(255, 0, 0, 0.2)"; btn.style.color = "#ffcccc"; };
    btn.onclick = (e) => { e.stopPropagation(); onClick(); };
    return btn;
}

function injectButtons() {
    if (!engineEnabled) return;
    if (document.getElementById("ytm-ward-controls")) return;

    const threeDots = document.querySelector("ytmusic-player-bar .middle-controls-buttons ytmusic-menu-renderer") ||
                      document.querySelector("ytmusic-player-bar ytmusic-menu-renderer");

    const targetParent = threeDots ? threeDots.parentNode : document.querySelector("ytmusic-player-bar .middle-controls-buttons");

    if (targetParent) {
        const container = document.createElement("div");
        container.id = "ytm-ward-controls";
        container.style.display = "inline-flex";
        container.style.alignItems = "center";
        
        container.appendChild(createButton("🚫 ARTIST", () => {
            const song = getSongInfo();
            if (song) addToBlockList(song.artist, 'blockedArtists');
        }));
        
        container.appendChild(createButton("🚫 SONG", () => {
            const song = getSongInfo();
            if (song) addToBlockList(song, 'blockedTracks');
        }));

        if (threeDots && threeDots.nextSibling) {
            targetParent.insertBefore(container, threeDots.nextSibling);
        } else {
            targetParent.appendChild(container);
        }
    }
}

async function addToBlockList(term, listName) {
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
        await updateBlockList();
        performDownvoteAndSkip(getSongInfo());
    }
}

async function init() {
    await Promise.all([updateBlockList(), loadAIActions(), loadEngineEnabled()]);
    const playerBar = await waitForElement("ytmusic-player-bar");
    injectButtons();
    checkAndSkip();
    scanRowsForBadges();

    const observer = new MutationObserver(() => {
        checkAndSkip(); 
        if (engineEnabled && !document.getElementById("ytm-ward-controls")) injectButtons();
    });
    observer.observe(playerBar, { subtree: true, childList: true, attributes: true });

    const bodyObserver = new MutationObserver(() => scheduleScan());
    bodyObserver.observe(document.body, { childList: true, subtree: true });
    
    const titleNode = document.querySelector("ytmusic-player-bar .title");
    if (titleNode) {
        new MutationObserver(() => checkAndSkip())
            .observe(titleNode, { characterData: true, subtree: true, childList: true });
    }
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
        });
        return;
    }

    updateBlockList();
});
