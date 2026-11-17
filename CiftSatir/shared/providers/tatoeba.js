(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});
  const { withTimeout, fetchJson } = DS.providers.util;

  // Tatoeba: a community sentence bank with human Turkish translations. Keyless
  // and CORS-open. Coverage for an arbitrary word is uneven, so this is the
  // second link after free AI, not the only one - but what it returns is real,
  // human-written text with a real translation, which is worth more than a
  // generated line when it exists.
  const ENDPOINT = 'https://tatoeba.org/en/api_v0/search';

  function wordMatcher(word) {
    const escaped = String(word || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^\\p{L}])' + escaped + '([^\\p{L}]|$)', 'iu');
  }

  function turkishTranslation(candidate) {
    for (const group of candidate.translations || []) {
      if (!Array.isArray(group)) {
        continue;
      }
      for (const translation of group) {
        if (translation && translation.lang === 'tur' && translation.text) {
          return String(translation.text).trim();
        }
      }
    }
    return '';
  }

  async function examples(word, limit) {
    const term = String(word || '').trim();
    if (!term) {
      return [];
    }

    const url = ENDPOINT +
      '?from=eng&to=tur&query=' + encodeURIComponent(term) +
      '&orphans=no&unapproved=no&sort=relevance';

    const data = await withTimeout(fetchJson(url), 7000, 'Tatoeba');
    const matcher = wordMatcher(term);
    const out = [];
    const seen = new Set();

    for (const candidate of (data && data.results) || []) {
      const en = String((candidate && candidate.text) || '').trim();
      if (!en || !matcher.test(en)) {
        continue;
      }

      const key = en.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      const tr = turkishTranslation(candidate);
      if (!tr) {
        continue;
      }

      seen.add(key);
      out.push({ en: en, tr: tr, source: 'Tatoeba' });
      if (limit && out.length >= limit) {
        break;
      }
    }

    return out;
  }

  DS.providers.tatoeba = {
    id: 'tatoeba',
    examples: examples
  };
})(typeof self !== 'undefined' ? self : this);
