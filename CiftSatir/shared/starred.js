(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});

  // Stars are stored in the shared library (shared/library.js), which the site
  // bridge mirrors into the learning site's own library. The old IndexedDB
  // `starred` store is only read once, to migrate existing installations.
  const MIGRATION_FLAG = 'dualsub:library:migrated:v1';

  function makeEntry(word, info, source, examples) {
    return {
      word: DS.library.keyOf(word) || String(word || ''),
      display: word,
      meanings: (info && info.meanings) || [],
      partOfSpeech: (info && info.partOfSpeech) || '',
      ipa: (info && info.ipa) || '',
      examples: Array.isArray(examples) ? examples : [],
      savedAt: Date.now(),
      origin: 'dualsub',
      source: source
        ? {
            sentence: source.sentence || '',
            trSentence: source.trSentence || '',
            url: source.url || '',
            title: source.title || '',
            timestamp: Number(source.timestamp) || 0
          }
        : null
    };
  }

  async function isStarred(word) {
    return DS.library.isStarred(word);
  }

  async function star(word, info, source, examples) {
    const result = await DS.library.save(makeEntry(word, info, source, examples));
    return result && result.entry;
  }

  async function unstar(word) {
    return DS.library.remove(word);
  }

  async function setStarred(word, starred, info, source, examples) {
    return starred ? star(word, info, source, examples) : unstar(word);
  }

  async function list() {
    const rows = await DS.library.all();
    return rows.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  }

  // Copies the pre-shared-library entries across once, so users who starred
  // words before this change keep them. Failures leave the flag unset and the
  // migration runs again next time.
  async function migrate() {
    try {
      const stored = await chrome.storage.local.get(MIGRATION_FLAG);
      if (stored && stored[MIGRATION_FLAG]) {
        return { migrated: 0 };
      }

      const rows = await DS.cache.all(DS.cache.STORES.starred);
      let migrated = 0;

      for (const row of rows) {
        const value = row && (row.value || row);
        if (!value || !value.word) {
          continue;
        }
        const result = await DS.library.save({
          word: value.word,
          display: value.display,
          meanings: value.meanings,
          partOfSpeech: value.partOfSpeech,
          ipa: value.ipa,
          savedAt: value.savedAt,
          origin: 'dualsub',
          source: value.source
        });
        if (result && result.ok) {
          migrated += 1;
        }
      }

      await chrome.storage.local.set({ [MIGRATION_FLAG]: true });
      return { migrated: migrated };
    } catch (error) {
      return { migrated: 0, error: String(error && error.message || error) };
    }
  }

  DS.starred = {
    isStarred: isStarred,
    star: star,
    unstar: unstar,
    setStarred: setStarred,
    list: list,
    migrate: migrate,
    makeEntry: makeEntry
  };
})(typeof self !== 'undefined' ? self : this);
