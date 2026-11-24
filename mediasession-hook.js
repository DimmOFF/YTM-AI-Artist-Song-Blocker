/*
 * YTM Ward — MAIN-world hook for media keys.
 *
 * Media keys (and Bluetooth headset buttons) don't create keydown events in
 * the page: Chrome calls the handler that YouTube Music registered
 * via navigator.mediaSession.setActionHandler('previoustrack', ...).
 * The isolated content.js can't see that call, so this script
 * runs in the MAIN world at document_start (before YTM registers
 * its handlers), wraps 'previoustrack' and, before calling the original,
 * dispatches an event that content.js listens for.
 */
(() => {
    const ms = navigator.mediaSession;
    if (!ms || typeof ms.setActionHandler !== 'function' || ms.__ytmWardHooked) return;
    ms.__ytmWardHooked = true;

    const original = ms.setActionHandler.bind(ms);

    ms.setActionHandler = function (action, handler) {
        if (action === 'previoustrack' && typeof handler === 'function') {
            const wrapped = function (...args) {
                try { document.dispatchEvent(new CustomEvent('ytm-ward:prev-media')); } catch (_) {}
                return handler.apply(this, args);
            };
            return original(action, wrapped);
        }
        return original(action, handler);
    };
})();
