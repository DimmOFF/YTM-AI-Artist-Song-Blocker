// The only place with defaults. Included both in the popup (popup.html)
// and in the content script (manifest.json) BEFORE their own scripts — otherwise the popup and
// the engine show different things when the aiActions key is missing from storage.
var DEFAULT_AI_ACTIONS = { label: true, dislike: false, skipAi: true };
