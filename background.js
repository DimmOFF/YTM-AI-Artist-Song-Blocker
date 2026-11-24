const REMOTE_URL = 'https://zoundhub.com/data/artists-all.json';

async function fetchArtists() {
    const response = await fetch(REMOTE_URL, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
}

// Groq — used by the Info tab in the popup to check the current
// artist. The key comes from the user (stored in
// chrome.storage.local, entered in Settings) and is passed in here right in
// the message — background.js does not store the key itself.
// The result is cached in popup.js (per artist, for 30 days) — so
// background.js is only reached on a cache miss.
// llama-3.1-8b-instant was retired by Groq on 2026-08-16 — we use their official
// replacement (openai/gpt-oss-20b): a production model of comparable speed/size.
const GROQ_MODEL = 'openai/gpt-oss-20b';

// 503/429/529 — transient errors (provider overload/rate limit),
// worth retrying after a short pause. Other codes
// (400/401/403 etc.) are pointless to retry — the problem is in the
// request/key itself.
const RETRYABLE_STATUSES = new Set([503, 429, 529]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = [600, 1500]; // pauses before the 2nd and 3rd attempt

// NEW: our own request limits (independent of Groq's own limits) —
// 15 per minute and 500 per day. The state lives in chrome.storage.local, not
// in the service worker's memory — otherwise it would reset on every worker
// unload (MV3 unloads idle workers very often).
const RPM_LIMIT = 15;
const RPD_LIMIT = 500;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Pulls a human-readable message out of the API error body
// (OpenAI-compatible format: {"error": {"message": "...", ...}}),
// so the popup doesn't show raw JSON.
function extractErrorMessage(status, bodyText) {
    try {
        const parsed = JSON.parse(bodyText);
        if (parsed && parsed.error && parsed.error.message) {
            return parsed.error.message;
        }
    } catch (e) { /* body is not JSON — use it as is */ }
    return bodyText ? bodyText.slice(0, 200) : `HTTP ${status}`;
}

// Checks and immediately spends one request from the RPM/RPD quota.
// Throws an error with err.rateLimited = 'minute' | 'day' when the limit is exhausted.
async function checkAndConsumeRateLimit() {
    const data = await chrome.storage.local.get(['groqRateLimit']);
    const now = Date.now();
    const minuteKey = Math.floor(now / 60000);
    const dayKey = new Date(now).toLocaleDateString('en-CA'); // local date YYYY-MM-DD

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
                response_format: { type: 'json_object' } // Groq returns strict JSON, without ```-wrapping
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

// --- Social links: MusicBrainz ---
// Groq made up URLs (nonexistent sites and profiles), so we take links
// from MusicBrainz — where people add and verify them. If the artist
// isn't in the database (typical for AI performers), there simply will be no links.
const MB_BASE = 'https://musicbrainz.org/ws/2';
const MB_MIN_INTERVAL_MS = 1100; // MusicBrainz rule: no more than 1 request per second
let mbNextSlot = 0;

// Host → platform (by the domain of the link from MusicBrainz).
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
        // 503/429 from MusicBrainz — transient overload/limit, retry once
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

// Find the artist's MBID. First by the "track + artist" pair (this removes
// ambiguity between groups with the same name), then by name alone — but only
// if there is exactly one candidate among the exact matches.
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

// --- Social links: Wikidata (second source) ---
// The artist is identified through MusicBrainz (a Wikidata link in its record
// or a search by MBID, property P434), so there is no confusion with namesakes.
// The Wikidata property IDs below are verified on the fly: on the first run we
// request their labels and URL templates (P1630) and use a property only
// if its English label matches the expected one. A wrong ID is skipped.
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

// Returns { key: { id, formatter } } for verified properties only.
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
    return hits.length === 1 && /^Q\d+$/.test(hits[0].title) ? hits[0].title : null; // ambiguous — don't take it
}

function wdStatementValues(claims, propId) {
    const list = (claims && claims[propId]) || [];
    const usable = list.filter(st =>
        st.rank !== 'deprecated' &&
        st.mainsnak && st.mainsnak.datavalue &&
        !(st.qualifiers && st.qualifiers.P582) // P582 — "end date": the account is no longer current
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
        if (key !== 'website' && platformOfUrl(url) !== key) continue; // the link must point to its "own" platform
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

    // Second source: Wikidata only fills in platforms that MusicBrainz lacks.
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

    // We spend the quota ONCE per logical track check, not on
    // every retry inside it — otherwise a single retry would "eat"
    // several requests from the quota at once.
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
                throw err; // not a transient error, or attempts exhausted
            }
            console.warn(`[YTM Ward] Groq ${err.status} — retry ${attempt}/${MAX_ATTEMPTS - 1}...`);
            await sleep(RETRY_DELAY_MS[attempt - 1]);
        }
    }
    if (lastErr) throw lastErr;

    const rawText = data?.choices?.[0]?.message?.content || '';
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    // Debug: DevTools → chrome://extensions → "service worker" → Console
    console.log('[YTM Ward] Groq raw answer for', artist, '-', title, ':', cleaned);

    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch (e) {
        throw new Error('Groq returned a non-JSON response');
    }

    // true / false / null — null ("not sure") is no longer turned into false.
    const isAI = parsed.isAI === true ? true : (parsed.isAI === false ? false : null);

    return {
        isAI,
        reason: typeof parsed.reason === 'string' ? parsed.reason : ''
    };
}

// --- SoundProof (source: community votes) ---
// Read-only: get_artist_status returns the number of "AI" and "Human" votes
// for an artist and a verified flag. Voting from this extension is not
// performed. The key is SoundProof's public (publishable) client key;
// the data belongs to the SoundProof service.
const SOUNDPROOF_RPC = 'https://solsneywdlhvwbtghopw.supabase.co/rest/v1/rpc/';
const SOUNDPROOF_URL = SOUNDPROOF_RPC + 'get_artist_status';
const SOUNDPROOF_KEY = 'sb_publishable_dlFufI-1QXA4VJdGoMWxMw_ouWHyl3k';
const SOUNDPROOF_PLATFORM = 'music'; // this is what SoundProof calls YouTube Music

async function fetchSoundproofStatus(artist) {
    const response = await fetch(SOUNDPROOF_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SOUNDPROOF_KEY },
        body: JSON.stringify({ target_id: String(artist).toLowerCase().trim(), platform_input: SOUNDPROOF_PLATFORM })
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        console.warn('[YTM Ward] SoundProof HTTP', response.status, body.slice(0, 200));
        throw new Error(`SoundProof HTTP ${response.status}`);
    }
    const data = await response.json();
    const row = Array.isArray(data) ? (data[0] || {}) : (data || {});
    return {
        human: Number(row.out_human) || 0,
        ai: Number(row.out_ai) || 0,
        verified: row.out_verified === true,
        myVote: row.my_current_vote === 'human' || row.my_current_vote === 'ai' ? row.my_current_vote : null
    };
}

// The user's vote. Called only on a click of the Human / AI button in the
// SoundProof card (Info). Parameters are as in the original SoundProof client; who
// is actually voting is decided by the server, we send no credentials.
async function castSoundproofVote(artist, type) {
    if (type !== 'human' && type !== 'ai') throw new Error('Invalid vote type');
    const response = await fetch(SOUNDPROOF_RPC + 'handle_vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SOUNDPROOF_KEY },
        body: JSON.stringify({ artist_id_input: String(artist).trim(), vote_type_input: type, platform_input: SOUNDPROOF_PLATFORM })
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        console.warn('[YTM Ward] SoundProof vote HTTP', response.status, body.slice(0, 200));
        throw new Error(`SoundProof HTTP ${response.status}`);
    }
}

// SoundProof status with cache (the same cache and the same lifetime as on the Info tab,
// so the check at track start and the Info card don't make redundant requests).
const SP_CACHE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 1D

async function getSoundproofCached(artist) {
    const key = String(artist).toLowerCase().trim();
    const stored = await chrome.storage.local.get(['soundproofCache', 'soundproofCacheTtl']);
    const ttl = (typeof stored.soundproofCacheTtl === 'number' && stored.soundproofCacheTtl >= 0)
        ? stored.soundproofCacheTtl : SP_CACHE_DEFAULT_TTL_MS;

    if (ttl > 0) {
        const entry = (stored.soundproofCache || {})[key];
        if (entry && Date.now() - entry.checkedAt < ttl) return entry.data;
    }

    let data = await fetchSoundproofStatus(artist);

    // "A, B" — for SoundProof the key is the first artist
    if (data.human + data.ai === 0 && String(artist).includes(',')) {
        const first = String(artist).split(/\s*,\s*/)[0];
        if (first && first.toLowerCase() !== key) {
            try {
                const d2 = await fetchSoundproofStatus(first);
                if (d2.human + d2.ai > 0) data = d2;
            } catch (e) { /* keep the original answer */ }
        }
    }

    if (ttl > 0) {
        const fresh = await chrome.storage.local.get(['soundproofCache']);
        const cache = fresh.soundproofCache || {};
        cache[key] = { data, checkedAt: Date.now() };
        const keys = Object.keys(cache);
        if (keys.length > 500) {
            keys.sort((x, y) => cache[x].checkedAt - cache[y].checkedAt);
            for (let i = 0; i < keys.length - 500; i++) delete cache[keys[i]];
        }
        await chrome.storage.local.set({ soundproofCache: cache });
    }
    return data;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'FETCH_AI_ARTISTS') {
        fetchArtists()
            .then(data => sendResponse({ ok: true, data }))
            .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
        return true;
    }

    if (message && message.type === 'FETCH_SOUNDPROOF') {
        fetchSoundproofStatus(message.artist)
            .then(data => sendResponse({ ok: true, data }))
            .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
        return true;
    }

    if (message && message.type === 'GET_SOUNDPROOF') {
        getSoundproofCached(message.artist)
            .then(data => sendResponse({ ok: true, data }))
            .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
        return true;
    }

    if (message && message.type === 'SOUNDPROOF_VOTE') {
        castSoundproofVote(message.artist, message.vote)
            .then(() => sendResponse({ ok: true }))
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