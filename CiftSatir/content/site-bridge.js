(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});

  // Mirrors the shared vocabulary library into the learning site when the site
  // is open in the same tab.
  //
  // The site cannot read chrome.storage and the extension cannot read the
  // site's localStorage, so the two sides talk over window.postMessage. That
  // needs no extra server, no extra permission, and works for the built HTML
  // file as well as for the local dev server.
  //
  // Nothing is posted on ordinary pages: the bridge waits for the site to speak
  // first (or for its greeting), so opening Netflix does not emit messages.

  if (DS.siteBridgeInstalled || !DS.library) {
    return;
  }
  DS.siteBridgeInstalled = true;

  const SOURCE_SITE = 'ck-site';
  const SOURCE_EXT = 'dualsub-ext';

  let syncTimer = 0;
  let siteSeen = false;

  // file:// pages report the opaque origin "null", which is not a valid
  // targetOrigin. The message never leaves this window, so "*" is safe there.
  function targetOrigin() {
    const origin = global.location.origin;
    return !origin || origin === 'null' ? '*' : origin;
  }

  function post(message) {
    try {
      global.postMessage(Object.assign({ source: SOURCE_EXT }, message), targetOrigin());
    } catch (error) {
      // A failed post must not break the page.
    }
  }

  // The site stores senses; the shared library stores flat meanings plus
  // examples. Converting here keeps shared/library.js's own schema as the one
  // canonical shape.
  function fromSiteEntry(raw) {
    if (!raw || !raw.word) {
      return null;
    }

    const senses = Array.isArray(raw.senses) ? raw.senses : [];
    const meanings = [];
    const examples = [];

    if (raw.gloss) {
      meanings.push(String(raw.gloss));
    }

    for (const sense of senses) {
      if (!sense) {
        continue;
      }
      if (sense.kisa) {
        meanings.push(String(sense.kisa));
      }
      for (const item of sense.aiExamples || []) {
        if (item && item.en) {
          examples.push({ en: String(item.en), tr: String(item.tr || ''), source: 'site' });
        }
      }
    }

    return {
      word: String(raw.word),
      lemma: String(raw.lemma || ''),
      display: String(raw.display || raw.word),
      meanings: Array.from(new Set(meanings.filter(Boolean))),
      partOfSpeech: String(raw.pos || ''),
      ipa: String(raw.ipa || ''),
      examples: examples,
      savedAt: Number(raw.addedAt) || Date.now(),
      origin: 'site',
      siteId: String(raw.id || ''),
      source: raw.context
        ? { sentence: String(raw.context), trSentence: '' }
        : null
    };
  }

  async function snapshot() {
    const list = await DS.library.all();
    return list.map((entry) => DS.library.toSiteEntry(entry)).filter(Boolean);
  }

  async function sendSync() {
    const library = await snapshot();
    post({ type: 'sync', library: library });
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      sendSync().catch(() => {});
    }, 120);
  }

  function isSiteEvent(event) {
    if (event.source !== global) {
      return false;
    }
    const origin = event.origin;
    return origin === global.location.origin || origin === 'null' || origin === '';
  }

  async function handleSiteMessage(data) {
    if (data.type === 'hello') {
      post({ type: 'hello-ack' });
      await sendSync();
      return;
    }

    siteSeen = true;

    if (data.type === 'ready') {
      await sendSync();
      return;
    }

    if (data.type === 'upsert') {
      const rows = (Array.isArray(data.entries) ? data.entries : [])
        .map(fromSiteEntry)
        .filter(Boolean);
      if (rows.length) {
        await DS.library.merge(rows);
      }
      await sendSync();
      return;
    }

    if (data.type === 'unstar') {
      if (data.word) {
        await DS.library.remove(data.word);
      }
      await sendSync();
    }
  }

  global.addEventListener('message', (event) => {
    if (!isSiteEvent(event)) {
      return;
    }

    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== SOURCE_SITE) {
      return;
    }

    handleSiteMessage(data).catch(() => {});
  });

  // Stars added from the video panel must reach an open site tab immediately.
  DS.library.subscribe(() => {
    if (siteSeen) {
      scheduleSync();
    }
  });

  // Wake the site if it loaded before this content script did. The site bridge
  // answers a greeting with its own snapshot.
  post({ type: 'hello' });

  DS.siteBridge = {
    sync: sendSync,
    available: () => siteSeen,
    targetOrigin: targetOrigin
  };
})(typeof self !== 'undefined' ? self : this);
