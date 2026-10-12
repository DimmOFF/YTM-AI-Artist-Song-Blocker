/*
 * YTM Ward — MAIN-world hook для медиа-клавиш.
 *
 * Медиа-клавиши (и кнопки Bluetooth-гарнитуры) не создают keydown-события в
 * странице: Chrome вызывает обработчик, который YouTube Music зарегистрировал
 * через navigator.mediaSession.setActionHandler('previoustrack', ...).
 * Изолированный content.js этот вызов увидеть не может, поэтому этот скрипт
 * запускается в MAIN world на document_start (до того, как YTM зарегистрирует
 * свои обработчики), оборачивает 'previoustrack' и перед вызовом оригинала
 * шлёт событие, которое слушает content.js.
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
