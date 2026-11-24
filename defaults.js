// Единственное место с дефолтами. Подключается и в попапе (popup.html),
// и в content script (manifest.json) ДО своих скриптов — иначе попап и
// движок при отсутствии ключа aiActions в хранилище показывают разное.
var DEFAULT_AI_ACTIONS = { label: true, dislike: false, skipAi: true };
