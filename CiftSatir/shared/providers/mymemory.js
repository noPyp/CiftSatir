(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});
  const { withTimeout, fetchJson } = DS.providers.util;

  // MyMemory: keyless EN<->TR translation with a daily anonymous quota.
  // Used for the word's Turkish meaning(s), not for sentences.
  const ENDPOINT = 'https://api.mymemory.translated.net/get';

  // Returns the translated string, or null when there is no usable
  // translation. A genuine outage rethrows so the caller's circuit breaker can
  // tell it apart from a word MyMemory simply cannot translate.
  async function translate(text, from, to) {
    const source = String(text || '').trim();
    if (!source) {
      return null;
    }

    const url = ENDPOINT + '?q=' + encodeURIComponent(source) +
      '&langpair=' + encodeURIComponent((from || 'en') + '|' + (to || 'tr'));

    const data = await withTimeout(fetchJson(url), 6000, 'MyMemory');
    const translated = data && data.responseData && data.responseData.translatedText;
    if (!translated || typeof translated !== 'string') {
      return null;
    }

    // MyMemory returns the input unchanged when it has no match, and
    // sometimes answers with an all-caps quota warning.
    if (translated.trim().toLowerCase() === source.toLowerCase()) {
      return null;
    }

    if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(translated)) {
      return null;
    }

    return translated.trim();
  }

  // The API returns one translation per string, so synonyms are collected by
  // asking for the word in a couple of disambiguating contexts. Only the plain
  // form is used for the primary meaning to keep the panel honest.
  async function lookup(word) {
    const primary = await translate(word, 'en', 'tr');
    if (!primary) {
      return null;
    }

    return { meanings: [primary] };
  }

  DS.providers.mymemory = {
    id: 'mymemory',
    translate: translate,
    lookup: lookup
  };
})(typeof self !== 'undefined' ? self : this);
