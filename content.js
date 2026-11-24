/*
 * YTM Ward - Production Engine
 * Fix: "Whole Word" Matching (No more partial match false positives)
 */

let blockList = [];
let aiArtistList = [];
// lower-case name from the DB → name in original casing (for writing to the Whitelist)
let aiArtistNames = new Map();

// Whitelist: whitelist — all entries (artists + keywords + tracks), whitelistArtists — artists only
// (used to judge rows in lists where only the artist is known).
let whitelist = [];
let whitelistArtists = [];
let whitelistKeywords = [];
let whitelistTracks = new Set(); // track titles (lower-case) — compared exactly, not word-by-word
const WL_KEYS = ['whitelistedArtists', 'whitelistedKeywords', 'whitelistedTracks'];
const BL_KEYS = ['blockedArtists', 'blockedKeywords', 'blockedTracks'];
// Track that SoundProof judged AI by the auto-skip rules (lead threshold + minimum votes).
// Needed so the badge and "back" respect the decision even after repeated re-evaluations.
let soundproofFlag = null; // { artist, title }
function isSoundproofFlagged(song) {
    return !!soundproofFlag && !!song && soundproofFlag.title === song.title && soundproofFlag.artist === song.artist;
}

// SoundProof auto-skip rules (own implementation based on how they describe their behavior):
//  • no votes, or fewer than the minimum — we don't skip;
//  • a moderator-verified artist counts as "practically one hundred percent";
//  • lead = (AI − Human) / all votes; skip if AI wins and the lead ≥ threshold.
// Threshold and minimum votes are configured in the SoundProof card on the AI DB tab.
async function checkSoundproof(artist) {
    try {
        const st = await chrome.storage.local.get(['sourceEnabled', 'soundproofThreshold', 'soundproofMinVotes']);
        if (st.sourceEnabled && st.sourceEnabled.soundproof === false) return { skip: false };

        const threshold = Number.isFinite(st.soundproofThreshold) ? st.soundproofThreshold : 50;
        const minVotes = Number.isFinite(st.soundproofMinVotes) ? st.soundproofMinVotes : 3;

        const res = await chrome.runtime.sendMessage({ type: 'GET_SOUNDPROOF', artist });
        if (!res || !res.ok) return { skip: false };

        let { ai, human, verified } = res.data;
        if (verified) {
            if (ai > human) ai = 10000000; else human = 10000000;
        }
        const total = ai + human;
        if (total === 0 || total < minVotes || ai <= human) return { skip: false, ai, human };

        const lead = Math.round(((ai - human) / total) * 100);
        return { skip: lead >= threshold, lead, ai, human, threshold };
    } catch (e) {
        return { skip: false }; // network/extension reload — just don't interfere
    }
}

let lastProcessedSong = ""; 

// Defaults live in defaults.js (shared file for the popup and the engine).
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

// Entry text for comparison: title for a track (same as matched in the blocklist), otherwise the string itself.
function termText(item) {
    const v = (item && typeof item === 'object') ? item.title : item;
    return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

async function loadWhitelist() {
    const d = await chrome.storage.local.get(WL_KEYS);
    const toTerms = items => (items || []).map(termText).filter(Boolean);
    whitelistArtists = [...new Set(toTerms(d.whitelistedArtists))];
    whitelist = [...new Set([...whitelistArtists, ...toTerms(d.whitelistedKeywords)])];
    whitelistKeywords = [...new Set(toTerms(d.whitelistedKeywords))];
    whitelistTracks = new Set(toTerms(d.whitelistedTracks));
    console.log(`[YTM Ward] Whitelist: ${whitelist.length} terms, ${whitelistTracks.size} tracks.`);
}

// Removes entries from the given lists whose text matches one of texts (case-insensitive).
// Needed so Blocklist and Whitelist never contain the same entry at the same time.
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
    if (whitelistTracks.has(String(song.title || '').trim().toLowerCase())) return true;
    if (!whitelist.length) return false;
    return !!findWholeWordMatch((song.artist + " " + song.title).toLowerCase(), whitelist);
}

function isArtistTextWhitelisted(artistText) {
    if (!whitelistArtists.length) return false;
    return !!findWholeWordMatch(artistText.toLowerCase(), whitelistArtists);
}

// Click on the red badge: add the artists found in the AI database to the Whitelist
// and remove the same entries from the Blocklist.
// Names of AI artists from the database found in the artist string (in original casing).
function getAIMatchNames(artistText) {
    const lower = artistText.toLowerCase();
    const names = [];
    const seen = new Set();
    aiArtistList.forEach(term => {
        if (seen.has(term) || !matchesTerm(lower, term)) return;
        seen.add(term);
        names.push(aiArtistNames.get(term) || term);
    });
    return names;
}

async function addAIArtistsToWhitelist(artistText) {
    const names = getAIMatchNames(artistText);
    if (!names.length) return;

    const data = await chrome.storage.local.get(['whitelistedArtists']);
    const list = data.whitelistedArtists || [];
    const have = new Set(list.map(termText));
    const toAdd = names.filter(n => !have.has(n.toLowerCase()));
    if (toAdd.length) await chrome.storage.local.set({ whitelistedArtists: [...list, ...toAdd] });

    await removeFromLists(BL_KEYS, names);
    console.log(`[YTM Ward] ⚪ Whitelisted: ${names.join(', ')}`);
}

// Click on the white badge in the player: remove from the Whitelist every entry that makes the track white.
function wlKeysForScope(scope) {
    if (scope === 'artist') return ['whitelistedArtists'];
    if (scope === 'song') return ['whitelistedTracks'];
    if (scope === 'keyword') return ['whitelistedKeywords'];
    if (scope === 'both') return ['whitelistedArtists', 'whitelistedTracks'];
    return WL_KEYS;
}

async function removeSongFromWhitelist(song, scope = 'all') {
    const checkString = (song.artist + " " + song.title).toLowerCase();
    const titleLower = String(song.title || '').trim().toLowerCase();
    const keys = wlKeysForScope(scope);
    const data = await chrome.storage.local.get(keys);
    const update = {};
    keys.forEach(key => {
        const items = data[key] || [];
        const kept = items.filter(i => {
            const t = termText(i);
            if (!t) return true;
            return key === 'whitelistedTracks' ? t !== titleLower : !matchesTerm(checkString, t);
        });
        if (kept.length !== items.length) update[key] = kept;
    });
    if (Object.keys(update).length) await chrome.storage.local.set(update);
    console.log(`[YTM Ward] Removed from whitelist: "${song.artist} — ${song.title}"`);
}

// Click on the white badge in a list row: remove the artist (by row text) and the track (by title).
async function removeRowFromWhitelist(artistText, title, scope = 'both') {
    const lower = artistText.toLowerCase();
    const titleLower = String(title || '').trim().toLowerCase();
    const keys = wlKeysForScope(scope);
    const data = await chrome.storage.local.get(['whitelistedArtists', 'whitelistedTracks']);
    const update = {};

    if (keys.includes('whitelistedArtists')) {
        const artists = data.whitelistedArtists || [];
        const keptArtists = artists.filter(i => { const t = termText(i); return !t || !matchesTerm(lower, t); });
        if (keptArtists.length !== artists.length) update.whitelistedArtists = keptArtists;
    }

    if (keys.includes('whitelistedTracks') && titleLower) {
        const tracks = data.whitelistedTracks || [];
        const keptTracks = tracks.filter(i => termText(i) !== titleLower);
        if (keptTracks.length !== tracks.length) update.whitelistedTracks = keptTracks;
    }

    if (Object.keys(update).length) await chrome.storage.local.set(update);
}

// Add a specific track (by title) to the Whitelist. The same track is removed from the Blocklist.
async function addTrackToWhitelist(title, artist) {
    const clean = String(title || '').trim();
    if (!clean) return;
    const data = await chrome.storage.local.get(['whitelistedTracks']);
    const list = data.whitelistedTracks || [];
    if (!list.some(i => termText(i) === clean.toLowerCase())) {
        await chrome.storage.local.set({ whitelistedTracks: [...list, { title: clean, artist: artist || '' }] });
    }
    await removeFromLists(['blockedTracks'], [clean]);
    console.log(`[YTM Ward] ⚪ Whitelisted track: "${clean}"`);
}

// ----- Choice menu: add to Whitelist by artist or by track -----
function closeWhitelistMenu() {
    const menu = document.getElementById("ytm-ward-wl-menu");
    if (menu) menu.remove();
    document.removeEventListener("mousedown", onWhitelistMenuOutside, true);
    document.removeEventListener("keydown", onWhitelistMenuKey, true);
    document.removeEventListener("scroll", onWhitelistMenuScroll, true);
    document.removeEventListener("wheel", onWhitelistMenuScroll, true);
    window.removeEventListener("resize", closeWhitelistMenu);
}

// The menu is positioned once (position: fixed), so on scroll it would "detach"
// from the badge. We close it on any page scroll, mouse wheel or window resize.
// YTM scrolls inside inner containers, so we listen in the capture phase on document.
function onWhitelistMenuScroll(e) {
    const menu = document.getElementById("ytm-ward-wl-menu");
    if (menu && e.target instanceof Node && menu.contains(e.target)) return;
    closeWhitelistMenu();
}

function onWhitelistMenuOutside(e) {
    const menu = document.getElementById("ytm-ward-wl-menu");
    if (menu && !menu.contains(e.target) && !(menu._anchor && menu._anchor.contains(e.target))) closeWhitelistMenu();
}

function onWhitelistMenuKey(e) {
    if (e.key === "Escape") closeWhitelistMenu();
}

// options: [{ kind, value, action }] — kind is the label ("Artist" / "Song"), value is what will be added.
function showWhitelistMenu(anchor, options, title = "Add to whitelist") {
    const existing = document.getElementById("ytm-ward-wl-menu");
    if (existing) {
        const sameAnchor = existing._anchor === anchor;
        closeWhitelistMenu();
        if (sameAnchor) return; // a second click on the badge closes the menu
    }

    const menu = document.createElement("div");
    menu._anchor = anchor;
    menu.id = "ytm-ward-wl-menu";
    menu.style.cssText = `
        position: fixed; z-index: 2147483647; box-sizing: border-box;
        min-width: 130px; padding: 4px; border-radius: 8px;
        background: #212121; color: #fff; border: 1px solid #444;
        box-shadow: 0 4px 16px rgba(0,0,0,0.6);
        font-family: "Roboto", "YouTube Sans", Arial, sans-serif; font-size: 12px;
    `;
    ['mousedown', 'click', 'dblclick'].forEach(type => menu.addEventListener(type, e => e.stopPropagation()));

    const head = document.createElement("div");
    head.textContent = title;
    head.style.cssText = "padding: 4px 8px 6px; color: #aaa; font-size: 11px; white-space: nowrap; user-select: none;";
    menu.appendChild(head);

    options.forEach(opt => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.style.cssText = `
            display: block; width: 100%; text-align: left; padding: 7px 8px; margin: 0;
            background: transparent; border: none; border-radius: 4px; color: #fff; cursor: pointer;
            font: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        `;
        btn.textContent = opt.kind;
        btn.title = opt.value; // what exactly will be added — in the tooltip
        btn.addEventListener("mouseenter", () => { btn.style.background = "#333"; });
        btn.addEventListener("mouseleave", () => { btn.style.background = "transparent"; });
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeWhitelistMenu();
            opt.action();
        });
        menu.appendChild(btn);
    });

    document.body.appendChild(menu);

    // Position: below the badge, or above it if it doesn't fit (player at the bottom of the screen)
    const r = anchor.getBoundingClientRect();
    const mh = menu.offsetHeight;
    const top = (r.bottom + 6 + mh > window.innerHeight) ? Math.max(4, r.top - mh - 6) : r.bottom + 6;
    const left = Math.min(Math.max(4, r.left), window.innerWidth - menu.offsetWidth - 4);
    menu.style.top = top + "px";
    menu.style.left = left + "px";

    document.addEventListener("mousedown", onWhitelistMenuOutside, true);
    document.addEventListener("keydown", onWhitelistMenuKey, true);
    document.addEventListener("scroll", onWhitelistMenuScroll, true);
    document.addEventListener("wheel", onWhitelistMenuScroll, { capture: true, passive: true });
    window.addEventListener("resize", closeWhitelistMenu);
}

// "Remove from whitelist" menu: show only the options that actually have an entry.
// hits: { artist, song, keyword } — what exactly makes the track "white" right now.
function showRemoveMenu(anchor, hits, values, doRemove) {
    const options = [];
    if (hits.artist) options.push({ kind: "Artist", value: values.artist, action: () => doRemove('artist') });
    if (hits.song) options.push({ kind: "Song", value: values.song, action: () => doRemove('song') });
    if (hits.artist && hits.song) options.push({ kind: "Both", value: values.artist + " — " + values.song, action: () => doRemove('both') });
    if (hits.keyword) options.push({ kind: "Keyword", value: values.artist + " — " + values.song, action: () => doRemove('keyword') });
    if (!options.length) return;
    showWhitelistMenu(anchor, options, "Remove from whitelist");
}

async function onPlayerBadgeClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const song = getSongInfo();
    if (!song) return;
    if (isWhitelistedSong(song)) {
        const checkString = (song.artist + " " + song.title).toLowerCase();
        const hits = {
            artist: whitelistArtists.some(t => matchesTerm(checkString, t)),
            song: whitelistTracks.has(song.title.trim().toLowerCase()),
            keyword: whitelistKeywords.some(t => matchesTerm(checkString, t))
        };
        showRemoveMenu(e.currentTarget, hits, { artist: song.artist, song: song.title }, scope => removeSongFromWhitelist(song, scope));
        return;
    }
    const artistLabel = getAIMatchNames(song.artist).join(", ") || song.artist;
    showWhitelistMenu(e.currentTarget, [
        { kind: "Artist", value: artistLabel, action: () => addAIArtistsToWhitelist(song.artist) },
        { kind: "Song", value: song.title, action: () => addTrackToWhitelist(song.title, song.artist) }
    ]);
}

// Track title in a list/queue row (album/artist cards have no track — returns '').
function getRowTitle(row) {
    if (row.tagName.toLowerCase() === "ytmusic-two-row-item-renderer") return "";
    const el = row.querySelector("yt-formatted-string.title") || row.querySelector(".song-title") || row.querySelector(".title");
    return el ? el.textContent.trim() : "";
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
    // The ZoundHub source can be turned off on the AI DB tab (on by default)
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

// Unicode-aware "whole word": \b in JS only sees ASCII, so Cyrillic
// and titles with brackets/signs at the edges (e.g. "Song (feat. X)") never matched.
// Previously a new RegExp with the unicode flag was created for EVERY term on EVERY call.
// With thousands of entries in the AI database and a hundred rows on the page this blocked the main thread
// for seconds (the YouTube Music UI froze on scroll and list loads).
// Now: a cheap includes() check first, and the regex (compiled once,
// cached) is built only for terms that actually occur in the text.
const termRegexCache = new Map();

function matchesTermLowered(lowerText, term) {
    if (!lowerText.includes(term.toLowerCase())) return false;

    let regex = termRegexCache.get(term);
    if (!regex) {
        const safeTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(`(?<![\\p{L}\\p{N}_])${safeTerm}(?![\\p{L}\\p{N}_])`, 'iu');
        if (termRegexCache.size > 20000) termRegexCache.clear(); // guard against unbounded growth
        termRegexCache.set(term, regex);
    }
    return regex.test(lowerText);
}

function matchesTerm(text, term) {
    return matchesTermLowered(text.toLowerCase(), term);
}

function findWholeWordMatch(text, list) {
    const lower = text.toLowerCase();
    return list.find(term => matchesTermLowered(lower, term));
}

function skipTrack(expectedSong) {
    hideBadgeImmediately();

    const songBeforeSkip = getSongInfo();

    if (expectedSong && songBeforeSkip && songBeforeSkip.title !== expectedSong.title) {
        console.log(`[YTM Ward] Track changed on its own while waiting for the action ("${expectedSong.title}" → "${songBeforeSkip.title}") — skip cancelled.`);
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

function handleDislikeAndSkip(song, forceSkip = false) {
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
        if (forceSkip) skipTrack();
    }
}

function extractArtistOnly(rawByline) {
    return rawByline.split(/\s*•\s*/)[0].trim();
}

function getBylineText(bylineEl) {
    // The "AI" badge sits INSIDE the byline (prepend) — its "AI" text must not
    // be taken into account when detecting the artist, otherwise artist becomes "AI<name>",
    // the match breaks, the badge is removed, the match returns... = flicker.
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
        // NEW: YTM keeps showing the last track's title/byline while
        // paused — that's not a page bug, but the Info tab needs the real
        // playback state, not just "which track is loaded".
        isPaused: video ? video.paused : false
    };
}

// Red badge — AI artist from the database; white with a dark outline — artist in the Whitelist.
// Both have the same size (the red one has a transparent outline) so the badge doesn't "jump" when the color changes.
function applyBadgeLook(badge, whitelisted) {
    const isSmall = badge.dataset.size === 'small';
    badge.dataset.wl = whitelisted ? '1' : '0';
    badge.title = whitelisted
        ? "In whitelist. Click to remove"
        : "Likely AI artist (ZoundHub). Click to add to whitelist";
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
            // Same fix as in the player: the badge text must not leak into artistText
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
        const rowTitle = getRowTitle(row);
        const isWhite = isArtistTextWhitelisted(artistText) || (!!rowTitle && whitelistTracks.has(rowTitle.toLowerCase()));
        let badge = row.querySelector(".ytm-ward-row-ai-badge");

        if (shouldShow && !badge) {
            badge = makeBadgeElement('small', isWhite);
            badge.classList.add("ytm-ward-row-ai-badge");
            // A click on the badge must not start playback of the row
            ['dblclick', 'mousedown'].forEach(type => badge.addEventListener(type, e => e.stopPropagation()));
            badge.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const text = row.dataset.ytmwardChecked;
                if (!text) return;
                const title = getRowTitle(row);
                if (badge.dataset.wl === '1') {
                    const hits = {
                        artist: isArtistTextWhitelisted(text),
                        song: !!title && whitelistTracks.has(title.toLowerCase())
                    };
                    showRemoveMenu(badge, hits, { artist: text, song: title }, scope => removeRowFromWhitelist(text, title, scope));
                    return;
                }
                if (!title) { addAIArtistsToWhitelist(text); return; } // no track (album/artist) — artist only
                showWhitelistMenu(badge, [
                    { kind: "Artist", value: getAIMatchNames(text).join(", ") || text, action: () => addAIArtistsToWhitelist(text) },
                    { kind: "Song", value: title, action: () => addTrackToWhitelist(title, text) }
                ]);
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
        console.log(`[YTM Ward] 🤖 AI detected (Dislike AI and Skip, after ${ACTION_DELAY_MS}ms) — artist="${current.artist}"`);
        recordAIBlock();
        handleDislikeAndSkip(current);
    }, ACTION_DELAY_MS);
}

// Reaction to a blocked (manual list) track — the same action chosen
// in the settings for AI: dislike if it's on, otherwise skip if that's on.
function performConfiguredAction(song) {
    if (aiActions.dislike) handleDislikeAndSkip(song);
    else if (aiActions.skipAi) skipTrack();
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
       performConfiguredAction(current);
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
        const aiMatch = !!findWholeWordMatch(song.artist.toLowerCase(), aiArtistList) || isSoundproofFlagged(song);
        const whitelisted = isWhitelistedSong(song);
        updateAIBadge(aiMatch && aiActions.label, whitelisted);

        // NEW: write the current track to storage — the Info tab in the popup reads it
        // (popup.js has no access to the page DOM, only to chrome.storage).
        chrome.storage.local.set({
            nowPlaying: { artist: song.artist, title: song.title, aiMatch, whitelisted, isPaused: song.isPaused, updatedAt: Date.now() }
        });
    }, BADGE_SETTLE_MS);
}

// NEW: stats for the Info tab — count ONLY auto-blocks by the
// AI database (not manual Keywords/Songs/Artists), at the moment the extension
// ITSELF initiates a skip/dislike because an AI artist was detected.
async function recordAIBlock() {
    const data = await chrome.storage.local.get(['stats']);
    const stats = data.stats || { totalBlocked: 0, dailyBlocked: {}, firstBlockedAt: null };

    const now = Date.now();
    const dayKey = new Date(now).toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

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

// ===== "Back" skips tracks the extension itself would have skipped =====
// Problem: on track 5 we press "back" → YTM starts track 4 (AI) → the extension
// skips forward → track 5 plays again. Now, after a user click on
// "back" we walk back ourselves until we meet a track the extension
// would not skip (not AI / not manually banned), and stop there.
const BACK_SETTLE_MS = 700;      // wait until the new track's title and byline update consistently
const BACK_TITLE_WAIT_MS = 3000; // how long we wait for the track to change after a "back" click
const BACK_MAX_STEPS = 100;      // safeguard against an endless loop
let backSeekActive = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Resolves the new song as soon as title differs from prevTitle; null if it never came.
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

// Would the extension skip this track itself? (manual ban, or AI with
// Dislike AI and Skip / Skip AI enabled). If actions are off, "back" works as usual.
function wouldAutoHandle(song) {
    if (isWhitelistedSong(song)) return false; // Whitelist beats any blocks
    const manualBlocked = !!findWholeWordMatch((song.artist + " " + song.title).toLowerCase(), blockList);
    const aiMatch = findWholeWordMatch(song.artist.toLowerCase(), aiArtistList) || isSoundproofFlagged(song);
    return (manualBlocked || !!aiMatch) && (aiActions.dislike || aiActions.skipAi);
}

async function backSeekFlow(originSong) {
    backSeekActive = true;
    clearTimeout(settleTimer);
    clearTimeout(pendingActionTimer);

    let moved = false;
    let wasMuted = null;
    try {
        const first = await waitForTitleChange(originSong.title, BACK_TITLE_WAIT_MS);
        // Title didn't change — YTM just rewound the current track to the start
        // (that's what it does if it played for more than ~3 sec). This is not going back.
        if (!first) return;
        moved = true;

        // Mute while seeking back so AI tracks aren't played out loud
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
                // Reached the start of the queue — nowhere further back. The normal logic
                // below will push this track (and the next AI ones) forward itself.
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
            // Hand the final track to the normal logic (badge, etc.)
            lastProcessedSong = "";
            settleTitle = null;
            checkAndSkip();
            scheduleBadgeUpdate();
        }
    }
}

// Common entry point: remember the current track BEFORE YTM switches, then start seeking back.
function triggerBackSeek() {
    if (!engineEnabled || backSeekActive) return;
    const origin = getSongInfo();
    if (origin) backSeekFlow(origin);
}

// 1) Mouse click on "back". Only real clicks (isTrusted) — ignore our own simulateClick from the loop above.
function onPlayerBarClick(e) {
    if (!e.isTrusted) return;
    if (!e.target.closest || !e.target.closest(".previous-button")) return;
    triggerBackSeek();
}

// 2) YTM "previous track" hotkey — Shift+P. Checked by e.code so it works
// on the Russian layout too. We don't react inside input fields (search etc.).
function onGlobalKeyDown(e) {
    if (!e.isTrusted || e.repeat) return;
    if (e.code !== "KeyP" || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    const t = (e.composedPath && e.composedPath()[0]) || e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    triggerBackSeek();
}

// 3) Media keys and headset buttons — the event is sent by mediasession-hook.js (MAIN world).
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

async function processSettledSong(expectedTitle) {
    if (backSeekActive) return;
    const song = getSongInfo();
    if (!song || song.title !== expectedTitle) return;

    let aiMatch = !!findWholeWordMatch(song.artist.toLowerCase(), aiArtistList) || isSoundproofFlagged(song);
    const whitelisted = isWhitelistedSong(song);
    updateAIBadge(aiMatch && aiActions.label, whitelisted);

    if (song.title === lastProcessedSong) return;
    lastProcessedSong = song.title;

    // Whitelist beats both the manual blocklist and the AI database — no actions on such a track
    if (whitelisted) return;

    const checkString = (song.artist + " " + song.title).toLowerCase();
    const manualTerm = findWholeWordMatch(checkString, blockList);

    if (manualTerm) {
        scheduleManualBlockCheck(song, manualTerm);
        return;
    }

    // Second source: SoundProof votes. Ask only if ZoundHub doesn't know the artist
    // and the extension does anything with AI tracks at all (label or skip).
    if (!aiMatch && (aiActions.label || aiActions.dislike || aiActions.skipAi)) {
        const verdict = await checkSoundproof(song.artist);

        // While we waited for the answer the track may have changed (or "back" started) — then the decision is stale.
        const now = getSongInfo();
        if (backSeekActive || !now || now.title !== song.title) return;

        if (verdict.skip) {
            soundproofFlag = { artist: song.artist, title: song.title };
            aiMatch = true;
            updateAIBadge(aiActions.label, false);
            console.log(`[YTM Ward] 🗳️ SoundProof: AI by community votes — artist="${song.artist}" (${verdict.ai} AI vs ${verdict.human} Human, lead ${verdict.lead}% ≥ ${verdict.threshold}%)`);
        }
    }

    if (aiMatch) {
        if (aiActions.dislike) {
            // "Dislike AI and Skip" takes priority — "Skip AI" is ignored in that case
            scheduleDislikeAndSkipCheck(song);
        } else if (aiActions.skipAi) {
            // "Skip AI" — immediately, with no delay and no dislike
            console.log(`[YTM Ward] 🤖 AI detected (Skip AI, instantly) — artist="${song.artist}"`);
            recordAIBlock();
            skipTrack();
        }
    }
}

// NEW: "Ban Artist" / "Ban Song" buttons in Material Design style —
// tonal button (M3 error container), pill, icon + ripple effect on click.

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
    void ripple.offsetWidth; // reflow so the animation restarts on repeated clicks
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
        // Ban and Whitelist are mutually exclusive: the same entry is removed from the Whitelist
        await removeFromLists(WL_KEYS, [termText(term)]);
        await refreshManualBlockList(); 
        const currentSong = getSongInfo();
        if (songAtClick && currentSong && currentSong.title === songAtClick.title) {
            // Ban always removes the track now: dislike if that action is on, then skip.
            if (aiActions.dislike) handleDislikeAndSkip(currentSong, true);
            else skipTrack();
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
        // It used to be hideBadgeImmediately: on every next/prev click the badge was removed
        // at once and put back ~60ms later = guaranteed flicker.
        // Now we just wait for settle (250ms) and set the final state once.
        if (btn) btn.addEventListener("click", scheduleBadgeUpdate, true);
    });
    // Delegation on the whole player bar — survives YTM re-rendering the button itself
    playerBar.addEventListener("click", onPlayerBarClick, true);
    document.addEventListener("keydown", onGlobalKeyDown, true);

    // The progress bar and timer inside the player bar change every second, so we don't run
    // checkAndSkip on every mutation — mutations are coalesced into one call per 200ms.
    let checkQueued = false;
    const observer = new MutationObserver(() => {
        if (!checkQueued) {
            checkQueued = true;
            setTimeout(() => { checkQueued = false; checkAndSkip(); }, 200);
        }
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
        // Ignore our own badge mutations (prepend/remove inside the byline),
        // otherwise every insertion would restart scheduleBadgeUpdate = loop/flicker.
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

    // NEW: play/pause doesn't change title/byline, so the observers above won't
    // fire — listen to <video> itself so Now Playing in the Info tab
    // reflects the real playback state immediately, not only
    // on the next track change.
    const video = document.querySelector("video");
    if (video) {
        video.addEventListener("play", scheduleBadgeUpdate);
        video.addEventListener("pause", scheduleBadgeUpdate);
    }

    scheduleBadgeUpdate(); // set the correct badge state right away on init
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
            closeWhitelistMenu();
            removeInjectedButtons();
        } else {
            lastProcessedSong = ""; // re-check the current track from scratch after enabling
            settleTitle = null;     // otherwise checkAndSkip() thinks the title didn't change and does nothing
            injectButtons();
            checkAndSkip();
            scanRowsForBadges();
            scheduleBadgeUpdate();
        }
        return;
    }

    if (changes.aiActions) {
        clearTimeout(pendingActionTimer); // otherwise a scheduled dislike fires after the setting is turned off
        loadAIActions().then(() => {
            // NEW: reset "already processed" — otherwise a track already checked
            // under the old settings wouldn't be recomputed under the new ones
            lastProcessedSong = "";
            settleTitle = null; // otherwise checkAndSkip() thinks the title didn't change and does nothing
            scheduleScan();
            checkAndSkip();
            scheduleBadgeUpdate();
        });
        return;
    }

    // Whitelist changed (from the popup or a badge click): reload and re-check the current track.
    // Cancel any pending action — a track just added to the Whitelist could otherwise
    // still get a dislike/skip.
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

    // NEW: previously ANY other storage key (including the new
    // nowPlaying/stats/groqApiKey) landed here and triggered a full updateBlockList()
    // with a ZoundHub network request. nowPlaying is written on every track
    // change, so without this filter the AI database would be re-downloaded
    // on every track. React only to real block-list changes.
    if (changes.blockedArtists || changes.blockedKeywords || changes.blockedTracks) {
        updateBlockList();
    }

    // ZoundHub source toggled on the AI DB tab: rebuild the
    // list and drop the "already checked" cache for rows and the current track.
    const prevZ = !(changes.sourceEnabled && changes.sourceEnabled.oldValue && changes.sourceEnabled.oldValue.zoundhub === false);
    const nextZ = !(changes.sourceEnabled && changes.sourceEnabled.newValue && changes.sourceEnabled.newValue.zoundhub === false);
    // SoundProof source toggled or its skip rules changed — re-check the current track.
    const prevS = !(changes.sourceEnabled && changes.sourceEnabled.oldValue && changes.sourceEnabled.oldValue.soundproof === false);
    const nextS = !(changes.sourceEnabled && changes.sourceEnabled.newValue && changes.sourceEnabled.newValue.soundproof === false);
    if ((changes.sourceEnabled && prevS !== nextS) || changes.soundproofThreshold || changes.soundproofMinVotes) {
        soundproofFlag = null;
        clearTimeout(pendingActionTimer);
        updateAIBadge(false);
        lastProcessedSong = "";
        settleTimer && clearTimeout(settleTimer);
        settleTitle = null;
        checkAndSkip();
        scheduleBadgeUpdate();
    }

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
