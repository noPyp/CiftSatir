// The service worker owns every network request and every persistent write.
//
// Two reasons that split is forced rather than stylistic: a content script's
// fetch is bound by the page's own CORS rules, and its IndexedDB belongs to the
// page's origin instead of the extension's. With host_permissions, the service
// worker is the only context that can reach third-party APIs reliably and the
// only one whose storage actually persists.
//
// Note: this file must not be an ES module ("type": "module" in the manifest),
// so that importScripts() can pull in the shared/ files.

// importScripts() resolves relative paths against *this file's* directory (the
// worker entry script), not the extension root - so a bare 'shared/x.js' here
// would look for 'background/shared/x.js' and fail, and the whole worker would
// refuse to load. Absolute URLs built from the extension root remove the
// ambiguity entirely.
const DS_ROOT = chrome.runtime.getURL('');

importScripts(
  DS_ROOT + 'shared/constants.js',
  DS_ROOT + 'shared/stemmer.js',
  DS_ROOT + 'shared/cache.js',
  DS_ROOT + 'shared/library.js',
  DS_ROOT + 'shared/starred.js',
  DS_ROOT + 'shared/providers/util.js',
  DS_ROOT + 'shared/providers/free-dictionary.js',
  DS_ROOT + 'shared/providers/wiktionary.js',
  DS_ROOT + 'shared/providers/mymemory.js',
  DS_ROOT + 'shared/providers/google.js',
  DS_ROOT + 'shared/providers/free-ai.js',
  DS_ROOT + 'shared/providers/tatoeba.js',
  DS_ROOT + 'shared/providers/claude.js',
  DS_ROOT + 'shared/sentences.js',
  DS_ROOT + 'shared/providers/index.js'
);

(function () {
  'use strict';

  const DS = self.DualSub;
  const { STORES } = DS.cache;

  const WORDS_LIMIT = 20000;
  const SENTENCES_LIMIT = 5000;

  async function clearStore(storeName) {
    const rows = await DS.cache.all(storeName);
    for (const row of rows) {
      await DS.cache.remove(storeName, row.key);
    }
  }

  async function getSettings() {
    const defaults = {
      enabled: true,
      turkishOn: true,
      englishOn: true,
      hideNativeSubtitles: true,
      fontSize: 100,
      position: 'bottom',
      enColor: '#f8fbff',
      trColor: '#dff7e6',
      hoverColor: '#38bdf8',
      bgOn: true,
      bgOpacity: 58,
      outline: true,
      siteUrl: 'http://127.0.0.1:5173/'
    };

    try {
      const stored = await chrome.storage.local.get(DS.constants.STORAGE_SETTINGS);
      return Object.assign(defaults, stored && stored[DS.constants.STORAGE_SETTINGS] || {});
    } catch (error) {
      return defaults;
    }
  }

  async function saveSettings(patch) {
    const current = await getSettings();
    const next = Object.assign({}, current, patch || {});
    try {
      await chrome.storage.local.set({ [DS.constants.STORAGE_SETTINGS]: next });
    } catch (error) {
      // Settings are conveniences; a write failure isn't worth failing the call.
    }
    return next;
  }

  async function lookupWord(word) {
    const key = DS.cache.normalizeKey(word);
    if (!key) {
      return null;
    }

    const cached = await DS.cache.get(STORES.words, key);
    if (cached) {
      // Even a cached miss is a cache hit: it means we already asked and the
      // providers had nothing, so don't pay for the request again.
      return cached.miss ? null : cached;
    }

    const result = await DS.providerChain.lookup(key);

    if (result) {
      await DS.cache.put(STORES.words, key, result, { updatedAt: Date.now() });
      DS.cache.evictIfNeeded(STORES.words, WORDS_LIMIT).catch(() => {});
    } else {
      // A miss is cached too, so an unknown word isn't re-queried on every
      // click (the providers are rate-limited and one is paid).
      await DS.cache.put(STORES.words, key, { miss: true }, { updatedAt: Date.now() });
    }

    return result;
  }

  // Clicking "movies" or "running" should find the dictionary entry for the
  // base form. The word is tried first, then the stem candidates in order, and
  // the first hit is stored under the requested key so the next click on that
  // exact form is a plain cache hit.
  async function lookupWordWithStems(word) {
    const direct = await lookupWord(word);
    if (direct) {
      return direct;
    }

    const key = DS.cache.normalizeKey(word);
    const candidates = DS.stemmer.stemsFor(key).filter((candidate) => candidate !== key);

    for (const candidate of candidates) {
      const stemmed = await lookupWord(candidate);
      if (stemmed) {
        const merged = Object.assign({}, stemmed, { matchedForm: candidate });
        await DS.cache.put(STORES.words, key, merged, { updatedAt: Date.now() });
        return merged;
      }
    }

    return null;
  }

  async function wordSentences(word, contextSentence) {
    const key = DS.cache.normalizeKey(word);
    if (!key) {
      return { sentences: [], error: '' };
    }

    // Rotation: every request passes the sentences already shown for this word,
    // so reopening a word prioritises new ones. `last` keeps a usable batch for
    // the case where every free source is temporarily down.
    const histKey = 'hist:' + key;
    const hist = await DS.cache.get(STORES.sentences, histKey) || { seen: [], last: [] };
    const avoid = Array.isArray(hist.seen) ? hist.seen.slice(-30) : [];

    const result = await DS.providerChain.sentencesWithStatus(key, contextSentence, avoid);

    if (result.sentences.length) {
      const fresh = result.sentences
        .map((item) => DS.sentences.flatten(item.en))
        .filter(Boolean);

      const seen = Array.from(new Set(avoid.concat(fresh))).slice(-60);
      await DS.cache.put(STORES.sentences, histKey, {
        seen: seen,
        last: result.sentences,
        at: Date.now()
      }, { updatedAt: Date.now() });

      // Kept under the plain key too, so starring a word can attach the
      // examples that were just shown without asking the network again.
      await DS.cache.put(STORES.sentences, key, result.sentences, { updatedAt: Date.now() });
      DS.cache.evictIfNeeded(STORES.sentences, SENTENCES_LIMIT).catch(() => {});

      return {
        sentences: result.sentences,
        partial: Boolean(result.partial),
        warning: result.warning || '',
        sources: result.sources || [],
        error: ''
      };
    }

    // Nothing new came back. Reusing the previous batch is better than an empty
    // panel, but it is labelled as repeated rather than passed off as new.
    if (Array.isArray(hist.last) && hist.last.length) {
      return {
        sentences: hist.last,
        partial: hist.last.length < 5,
        warning: 'Yeni cümle üretilemedi; daha önce gösterilen cümleler tekrar gösteriliyor.',
        repeated: true,
        error: result.error || ''
      };
    }

    return {
      sentences: [],
      partial: true,
      warning: result.warning || '',
      error: result.error || ''
    };
  }

  const handlers = {
    // Lets the content script and popup tell "the worker is not running" apart
    // from "the lookup ran and found nothing".
    ping: async () => ({ ok: true, version: chrome.runtime.getManifest().version }),

    'lookup-word': async (message) => lookupWordWithStems(message.word),

    'refine-word': async (message) => DS.providerChain.refine(message.word, message.context),

    'word-sentences': async (message) => wordSentences(message.word, message.context),

    // Line translation for videos that only ship an English track. Each line is
    // cached by its English text in the sentences store, so replaying the same
    // scene is instant and a re-seek costs nothing.
    'translate-cues': async (message) => {
      const texts = (Array.isArray(message.texts) ? message.texts : [])
        .map((text) => String(text || '').trim())
        .filter(Boolean)
        .slice(0, 6);

      const translations = [];

      for (const text of texts) {
        const cacheKey = 'cue:' + text.toLowerCase();
        let tr = null;

        try {
          const cached = await DS.cache.get(STORES.sentences, cacheKey);
          if (typeof cached === 'string') {
            tr = cached;
          }
        } catch (error) {
          // A cache miss is not an error.
        }

        if (!tr) {
          tr = await DS.providers.util.guarded(
            'google',
            () => DS.providers.google.translate(text, 'en', 'tr')
          );
        }

        if (!tr) {
          tr = await DS.providers.util.guarded(
            'mymemory',
            () => DS.providers.mymemory.translate(text, 'en', 'tr')
          );
        }

        if (tr) {
          try {
            await DS.cache.put(STORES.sentences, cacheKey, tr, { updatedAt: Date.now() });
          } catch (error) {
            // Caching is an optimisation, not a requirement.
          }
        }

        translations.push({ text: text, tr: tr || '' });
      }

      return { translations: translations };
    },

    'library-count': async () => ({ count: await DS.library.count() }),

    'is-starred': async (message) => DS.starred.isStarred(message.word),

    'set-starred': async (message) => {
      if (message.starred) {
        // Reuse the cached lookup so a starred word keeps its meanings without
        // another round of provider calls.
        const info = await lookupWordWithStems(message.word);
        const key = DS.cache.normalizeKey(message.word);
        const examples = await DS.cache.get(STORES.sentences, key);
        await DS.starred.star(
          message.word,
          info,
          message.source,
          Array.isArray(examples) ? examples : []
        );
      } else {
        await DS.starred.unstar(message.word);
      }
      return { starred: Boolean(message.starred) };
    },

    'list-starred': async () => DS.starred.list(),

    'remove-starred': async (message) => {
      await DS.starred.unstar(message.word);
      return { removed: true };
    },

    'get-settings': async () => {
      const settings = await getSettings();
      const providerStatus = await DS.providerChain.status();
      return Object.assign({}, settings, providerStatus);
    },

    'save-settings': async (message) => saveSettings(message.patch),

    'set-api-key': async (message) => {
      const key = String(message.key || '').trim();
      if (key) {
        await chrome.storage.local.set({ [DS.constants.STORAGE_API_KEY]: key });
      } else {
        await chrome.storage.local.remove(DS.constants.STORAGE_API_KEY);
      }

      // Sentence lookups that failed for want of a key (or because the old key
      // was bad) are now stale, so they are dropped. Without this, words the
      // user tried before adding the key would keep reporting the old failure.
      await clearStore(STORES.sentences);
      DS.cache.clearMemory();

      return { hasClaudeKey: Boolean(key) };
    },

    'clear-cache': async () => {
      const words = await DS.cache.count(STORES.words);
      const sentences = await DS.cache.count(STORES.sentences);
      // Starred entries live in their own store and are deliberately left
      // alone: the user asked to keep those.
      await clearStore(STORES.words);
      await clearStore(STORES.sentences);
      DS.cache.clearMemory();
      return { words: words, sentences: sentences };
    }
  };

  // Every handler is async, so the listener always returns true to keep the
  // message channel open for the eventual sendResponse.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      return false;
    }

    const handler = handlers[message.type];
    if (!handler) {
      return false;
    }

    Promise.resolve()
      .then(() => handler(message, sender))
      .then((result) => sendResponse(result === undefined ? null : result))
      .catch((error) => {
        sendResponse({ error: String(error && error.message ? error.message : error) });
      });

    return true;
  });

  // One-time move of pre-library stars into the shared library. Runs at boot as
  // well as on install, because an update can restart the worker without firing
  // onInstalled in the same session.
  DS.starred.migrate().catch(() => {});
  chrome.runtime.onInstalled.addListener(() => {
    DS.starred.migrate().catch(() => {});
  });
})();
