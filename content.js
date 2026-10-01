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
            console.log(`[YTM Ward] ZoundHub: fetch OK, ${remoteArtists.length} names after normalization.`);
        } else {
            console.warn(`[YTM Ward] ZoundHub: returned an error:`, result && result.error);
        }
    } catch (e) {
        console.warn("[YTM Ward] ZoundHub: failed with an error:", e);
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
    hideBadgeImmediately();

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
    badge.title = "Found in the ZoundHub database as a likely AI artist";
    const isSmall = size === 'small';
    badge.style.cssText = `
        display: inline-flex; align-items: center; justify-content: center;
        background: #ff2d2d; color: #fff;
        font-size: ${isSmall ? '9px' : '10px'}; font-weight: 800; letter-spacing: 0.5px;
        line-height: 1;
        border-radius: ${isSmall ? '3px' : '4px'}; 
        padding: ${isSmall ? '2px 4px' : '3px 6px'}; /* Управляем высотой через паддинги */
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

function scheduleDislikeAndSkipCheck(song) {
    clearTimeout(pendingActionTimer);
    pendingActionTimer = setTimeout(() => {
        const current = getSongInfo();
        if (!current || current.title !== song.title) {
            console.log(`[YTM Ward] Track changed during the delay — action for "${song.title}" cancelled.`);
            return;
        }
        console.log(`[YTM Ward] 🤖 AI detected (Dislike AI and Skip, после ${ACTION_DELAY_MS}мs) — artist="${current.artist}"`);		 
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

const BADGE_SETTLE_MS = 60;
let badgeTimer = null;

function scheduleBadgeUpdate() {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => {
        const song = getSongInfo();
        if (!song) return;
        const aiMatch = !!findWholeWordMatch(song.artist.toLowerCase(), aiArtistList);
        updateAIBadge(aiMatch && aiActions.label);
    }, BADGE_SETTLE_MS);
}

function hideBadgeImmediately() {
    clearTimeout(badgeTimer);
    updateAIBadge(false);
}

function checkAndSkip() {
    if (!engineEnabled) return;

    const song = getSongInfo();
    if (!song) return;

    if (song.title !== settleTitle) {
        settleTitle = song.title;
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => processSettledSong(settleTitle), SETTLE_DELAY_MS);
    }
}

function processSettledSong(expectedTitle) {
    const song = getSongInfo();
    if (!song || song.title !== expectedTitle) return;

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
            console.log(`[YTM Ward] 🤖 AI detected (Skip AI, instantly) — artist="${song.artist}"`);
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
            if (song) addToBlockList(song.artist, 'blockedArtists');
        }));

        container.appendChild(createButton("Ban Song", BAN_ICON_SVG, () => {
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
        handleDislikeAndSkip(getSongInfo());
    }
}

async function init() {
    await Promise.all([updateBlockList(), loadAIActions(), loadEngineEnabled()]);
    const playerBar = await waitForElement("ytmusic-player-bar");
    injectButtons();
    checkAndSkip();
    scanRowsForBadges();

    const nextBtn = playerBar.querySelector(".next-button");
    const prevBtn = playerBar.querySelector(".previous-button");
    [nextBtn, prevBtn].forEach(btn => {
        if (btn) btn.addEventListener("click", hideBadgeImmediately, true);
    });

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
        new MutationObserver(() => scheduleBadgeUpdate())
            .observe(bylineNode, { characterData: true, subtree: true, childList: true });
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

    updateBlockList();
});
