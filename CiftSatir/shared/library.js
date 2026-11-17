(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});

  // One vocabulary library shared by the extension and the learning site.
  //
  // chrome.storage.local is used instead of the old IndexedDB store because it
  // is reachable from every context that needs the library - service worker,
  // popup and the site bridge - and because `chrome.storage.onChanged` gives the
  // bridge a reliable way to notice changes made while the site is open.
  // IndexedDB keeps doing what it is good at: the word/sentence caches.
  const KEY = 'dualsub:library:v1';
  const TOMBSTONES = 'dualsub:removed:v1';

  function clean(word) {
    return String(word || '').trim();
  }

  function lemmaOf(word) {
    const key = DS.cache.normalizeKey(word);
    if (!key) {
      return '';
    }
    // The stemmer is a candidate generator. The last candidate is the original
    // word, so a word with no recognised suffix maps to itself.
    const candidates = DS.stemmer.stemsFor(key);
    return candidates.length ? candidates[candidates.length - 1] : key;
  }

  function keyOf(word) {
    return DS.cache.normalizeKey(word);
  }

  function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const word = clean(raw.word || raw.display);
    if (!word) {
      return null;
    }

    const meanings = (Array.isArray(raw.meanings) ? raw.meanings : [])
      .map((m) => String(m || '').trim())
      .filter(Boolean);

    const examples = (Array.isArray(raw.examples) ? raw.examples : [])
      .map((item) => ({
        en: String((item && item.en) || '').trim(),
        tr: String((item && item.tr) || '').trim(),
        source: String((item && item.source) || '').trim()
      }))
      .filter((item) => item.en);

    const source = raw.source && typeof raw.source === 'object'
      ? {
          sentence: String(raw.source.sentence || ''),
          trSentence: String(raw.source.trSentence || ''),
          url: String(raw.source.url || ''),
          title: String(raw.source.title || ''),
          timestamp: Number(raw.source.timestamp) || 0
        }
      : null;

    return {
      word: word,
      lemma: raw.lemma || lemmaOf(word),
      display: raw.display || word,
      meanings: meanings,
      partOfSpeech: String(raw.partOfSpeech || raw.pos || ''),
      ipa: String(raw.ipa || ''),
      examples: examples,
      savedAt: Number(raw.savedAt || raw.addedAt) || Date.now(),
      origin: String(raw.origin || 'dualsub'),
      siteId: String(raw.siteId || ''),
      source: source
    };
  }

  async function readAll() {
    try {
      const stored = await chrome.storage.local.get(KEY);
      const list = stored && stored[KEY];
      return Array.isArray(list) ? list : [];
    } catch (error) {
      return [];
    }
  }

  async function readTombstones() {
    try {
      const stored = await chrome.storage.local.get(TOMBSTONES);
      const list = stored && stored[TOMBSTONES];
      return Array.isArray(list) ? list : [];
    } catch (error) {
      return [];
    }
  }

  async function writeAll(list) {
    const cleanList = list
      .map(normalizeEntry)
      .filter(Boolean)
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));

    try {
      await chrome.storage.local.set({ [KEY]: cleanList });
    } catch (error) {
      // Storage failures are surfaced by the caller's own error handling; there
      // is nothing useful to do here except avoid throwing in a UI handler.
    }

    return cleanList;
  }

  async function tombstone(word) {
    const key = keyOf(word);
    if (!key) {
      return;
    }

    const list = await readTombstones();
    const set = new Set(list);
    set.add(key);
    try {
      await chrome.storage.local.set({ [TOMBSTONES]: Array.from(set).slice(-500) });
    } catch (error) {
      // ignore
    }
  }

  async function clearTombstone(word) {
    const key = keyOf(word);
    const list = await readTombstones();
    if (!list.includes(key)) {
      return;
    }
    try {
      await chrome.storage.local.set({
        [TOMBSTONES]: list.filter((item) => item !== key)
      });
    } catch (error) {
      // ignore
    }
  }

  async function all() {
    return readAll();
  }

  async function find(word) {
    const key = keyOf(word);
    const lemma = lemmaOf(word);
    const list = await readAll();
    return list.find((entry) =>
      keyOf(entry.word) === key ||
      (entry.lemma && entry.lemma === lemma)
    ) || null;
  }

  async function isStarred(word) {
    return Boolean(await find(word));
  }

  // Merges an entry. Re-starring the same word updates the stored meanings and
  // examples instead of creating a duplicate.
  async function save(raw) {
    const entry = normalizeEntry(raw);
    if (!entry) {
      return { ok: false, error: 'empty' };
    }

    await clearTombstone(entry.word);

    const list = await readAll();
    const key = keyOf(entry.word);
    const lemma = entry.lemma;
    const index = list.findIndex((item) =>
      keyOf(item.word) === key ||
      (lemma && item.lemma === lemma)
    );

    if (index >= 0) {
      const previous = list[index];
      list[index] = normalizeEntry(Object.assign({}, previous, entry, {
        savedAt: previous.savedAt || entry.savedAt,
        examples: entry.examples.length ? entry.examples : previous.examples,
        meanings: entry.meanings.length ? entry.meanings : previous.meanings,
        source: entry.source || previous.source
      }));
    } else {
      list.unshift(entry);
    }

    const saved = await writeAll(list);
    return { ok: true, entry: saved.find((item) => keyOf(item.word) === key) || entry };
  }

  async function remove(word) {
    const key = keyOf(word);
    if (!key) {
      return false;
    }

    const list = await readAll();
    const next = list.filter((entry) => keyOf(entry.word) !== key && entry.lemma !== key);
    const removed = next.length !== list.length;

    if (removed) {
      await writeAll(next);
    }

    await tombstone(word);
    return removed;
  }

  async function count() {
    return (await readAll()).length;
  }

  // Union merge used by the site bridge. Tombstoned words are skipped so a
  // deletion on either side is not undone by the next sync.
  async function merge(rows) {
    if (!Array.isArray(rows) || !rows.length) {
      return { added: 0, total: (await readAll()).length };
    }

    const tombstones = new Set(await readTombstones());
    const list = await readAll();
    const seen = new Set(list.map((entry) => keyOf(entry.word)));
    let added = 0;

    for (const row of rows) {
      const entry = normalizeEntry(row);
      if (!entry) {
        continue;
      }

      const key = keyOf(entry.word);
      if (!key || seen.has(key) || tombstones.has(key)) {
        continue;
      }

      seen.add(key);
      list.push(entry);
      added += 1;
    }

    if (added) {
      await writeAll(list);
    }

    return { added: added, total: list.length };
  }

  function subscribe(fn) {
    if (!chrome.storage || !chrome.storage.onChanged || typeof fn !== 'function') {
      return () => {};
    }

    const listener = (changes, area) => {
      if (area !== 'local' || !changes[KEY]) {
        return;
      }
      try {
        fn(changes[KEY].newValue || []);
      } catch (error) {
        // A broken listener must not break storage handling.
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  function toSiteEntry(entry) {
    const e = normalizeEntry(entry);
    if (!e) {
      return null;
    }

    const sense = {
      pos: e.partOfSpeech || '',
      kisa: e.meanings[0] || '',
      defTr: e.meanings.join(', '),
      aiExamples: e.examples.map((item) => ({ en: item.en, tr: item.tr }))
    };

    return {
      word: e.word,
      lemma: e.lemma,
      display: e.display,
      lang: 'en',
      ipa: e.ipa,
      pos: e.partOfSpeech,
      gloss: e.meanings[0] || '',
      senses: e.examples.length || e.meanings.length ? [sense] : [],
      context: e.source ? e.source.sentence : '',
      addedAt: e.savedAt,
      origin: e.origin
    };
  }

  DS.library = {
    KEY: KEY,
    TOMBSTONES: TOMBSTONES,
    all: all,
    find: find,
    isStarred: isStarred,
    save: save,
    remove: remove,
    count: count,
    merge: merge,
    subscribe: subscribe,
    normalizeEntry: normalizeEntry,
    toSiteEntry: toSiteEntry,
    lemmaOf: lemmaOf,
    keyOf: keyOf
  };
})(typeof self !== 'undefined' ? self : this);
