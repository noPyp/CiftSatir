(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});
  const { withTimeout, fetchJson } = DS.providers.util;

  // Free Dictionary API: English->English definitions, part of speech, IPA and
  // an audio URL. No key, no meaningful rate limit. It cannot supply Turkish,
  // so its output is merged with a translation provider's.
  const ENDPOINT = 'https://api.dictionaryapi.dev/api/v2/entries/en/';

  const POS_MAP = {
    noun: 'isim',
    verb: 'fiil',
    adjective: 'sıfat',
    adverb: 'zarf',
    pronoun: 'zamir',
    preposition: 'edat',
    conjunction: 'bağlaç',
    interjection: 'ünlem',
    determiner: 'belirteç',
    numeral: 'sayı'
  };

  function translatePos(pos) {
    const key = String(pos || '').trim().toLowerCase();
    return POS_MAP[key] || key;
  }

  // Returns { partOfSpeech, ipa, audio, englishDefinitions }, or null when the
  // word simply has no entry.
  //
  // The distinction matters to the caller's circuit breaker: a missing entry is
  // a perfectly healthy response and must not count against the provider, while
  // a timeout or a 5xx is a real failure and is rethrown as one. This endpoint
  // is the only source of IPA in the chain, so it is worth asking - but it has
  // been observed accepting a connection and then never responding, so its
  // budget is tighter than the others'.
  const TIMEOUT = 2500;

  async function lookup(word) {
    const term = String(word || '').trim().toLowerCase();
    if (!term) {
      return null;
    }

    let data;
    try {
      data = await withTimeout(
        fetchJson(ENDPOINT + encodeURIComponent(term)),
        TIMEOUT,
        'Sözlük'
      );
    } catch (error) {
      // A 404 means "no such entry" - a healthy answer, not an outage.
      if (error && /HTTP 404/.test(error.message || '')) {
        return null;
      }
      throw error;
    }

    if (!Array.isArray(data) || !data.length) {
      return null;
    }

    const englishDefinitions = [];
    let ipa = '';
    let audio = '';
    let partOfSpeech = '';

    for (const entry of data) {
      if (!ipa) {
        const phonetic = (entry.phonetics || []).find((item) => item && item.text);
        if (phonetic) {
          ipa = phonetic.text;
        }
        if (!ipa && entry.phonetic) {
          ipa = entry.phonetic;
        }
      }

      for (const phonetic of entry.phonetics || []) {
        if (phonetic && phonetic.audio && !audio) {
          audio = phonetic.audio;
        }
      }

      for (const meaning of entry.meanings || []) {
        if (!partOfSpeech && meaning.partOfSpeech) {
          partOfSpeech = meaning.partOfSpeech;
        }
        for (const def of meaning.definitions || []) {
          if (def && def.definition) {
            englishDefinitions.push(def.definition);
          }
        }
      }
    }

    return {
      partOfSpeech: translatePos(partOfSpeech),
      ipa: ipa,
      audio: audio,
      englishDefinitions: englishDefinitions.slice(0, 4)
    };
  }

  DS.providers.freeDictionary = {
    id: 'free-dictionary',
    lookup: lookup,
    translatePos: translatePos
  };
})(typeof self !== 'undefined' ? self : this);
