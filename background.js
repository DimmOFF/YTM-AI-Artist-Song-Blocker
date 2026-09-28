const REMOTE_URL = 'https://zoundhub.com/api/artists/all';

async function fetchArtists() {
    const response = await fetch(REMOTE_URL, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'FETCH_AI_ARTISTS') {
        fetchArtists()
            .then(data => sendResponse({ ok: true, data }))
            .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
        return true;
    }
});
