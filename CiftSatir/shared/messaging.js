(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});

  // Thin promise wrapper over chrome.runtime.sendMessage, shared by the
  // content script and the popup.
  //
  // Resolves to null on failure so callers can degrade gracefully, but records
  // the reason in DS.messaging.lastError. A silently swallowed messaging
  // failure is indistinguishable from "the dictionary has no entry", which
  // makes a broken service worker look like a missing word.
  let lastError = '';

  function send(message, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          lastError = 'Service worker ' + (timeoutMs || 10000) + ' ms içinde yanıt vermedi.';
          resolve(null);
        }
      }, timeoutMs || 10000);

      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);

          if (chrome.runtime.lastError) {
            lastError = chrome.runtime.lastError.message || 'Bilinmeyen mesaj hatası.';
            resolve(null);
            return;
          }

          if (response === undefined) {
            lastError = 'Service worker boş yanıt döndü.';
            resolve(null);
            return;
          }

          // The worker reports a thrown handler as { error }, which must not be
          // mistaken for a successful lookup that found nothing.
          if (response && typeof response === 'object' && response.error) {
            lastError = String(response.error);
            resolve(null);
            return;
          }

          lastError = '';
          resolve(response);
        });
      } catch (error) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          lastError = String(error && error.message ? error.message : error);
          resolve(null);
        }
      }
    });
  }

  DS.messaging = {
    send: send,
    getLastError: () => lastError,
    ping: () => send({ type: 'ping' }, 4000),
    lookup: (word, context) => send({ type: 'lookup-word', word: word, context: context || '' }),
    refine: (word, context) => send({ type: 'refine-word', word: word, context: context || '' }, 30000),
    sentences: (word, context) => send({
      type: 'word-sentences',
      word: word,
      context: context || ''
    }, 60000),
    isStarred: (word) => send({ type: 'is-starred', word: word }),
    setStarred: (word, starred, source, examples) => send({
      type: 'set-starred',
      word: word,
      starred: starred,
      source: source,
      examples: examples
    }),
    listStarred: () => send({ type: 'list-starred' }),
    removeStarred: (word) => send({ type: 'remove-starred', word: word }),
    getSettings: (timeoutMs) => send({ type: 'get-settings' }, timeoutMs || 10000),
    saveSettings: (patch) => send({ type: 'save-settings', patch: patch })
  };
})(typeof self !== 'undefined' ? self : this);
