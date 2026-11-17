(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});

  DS.constants = {
    LAYER_CLASS: 'dualsub-layer',
    LINE_CLASS: 'dualsub-line',
    WORD_CLASS: 'dualsub-word',
    PANEL_CLASS: 'dualsub-panel',
    HIDDEN_CLASS: 'is-hidden',

    EN: 'en',
    TR: 'tr',

    // Timing
    MIN_CUE_DURATION: 0.05,

    // Cache
    MEMORY_CACHE_LIMIT: 500,
    INDEXED_DB_NAME: 'dualsub',
    INDEXED_DB_VERSION: 1,

    // Storage keys (chrome.storage.local - small values only)
    STORAGE_API_KEY: 'anthropicApiKey',
    STORAGE_SETTINGS: 'settings',

    // Provider timeouts (ms).
    //
    // Kept short deliberately: a provider that is down should fall through
    // quickly rather than stalling the panel, and Wiktionary answers in under a
    // second when healthy, so 3.5s is generous. api.dictionaryapi.dev has been
    // observed hanging with no response at all, which is exactly the case this
    // budget protects the user from.
    PROVIDER_TIMEOUT: 3500
  };
})(typeof self !== 'undefined' ? self : this);
