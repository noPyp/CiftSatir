(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});
  const { withTimeout, fetchJson } = DS.providers.util;

  // Google's public "gtx" endpoint: the same one the learning site uses. It is
  // keyless, answers in well under a second and covers EN<->TR far better than
  // MyMemory. It is not a documented API, so it is used as the first link in a
  // chain rather than the only link: MyMemory stays behind it as a fallback.
  const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

  function pickText(data) {
    if (!Array.isArray(data) || !Array.isArray(data[0])) {
      return '';
    }

    // The response is an array of segments: [[translated, original, ...], ...].
    // Joining every segment keeps multi-sentence input intact.
    return data[0]
      .map((segment) => (Array.isArray(segment) ? String(segment[0] || '') : ''))
      .join('')
      .trim();
  }

  async function translate(text, from, to) {
    const source = String(text || '').trim();
    if (!source) {
      return null;
    }

    const url = ENDPOINT +
      '?client=gtx&sl=' + encodeURIComponent(from || 'en') +
      '&tl=' + encodeURIComponent(to || 'tr') +
      '&dt=t&q=' + encodeURIComponent(source);

    const data = await withTimeout(fetchJson(url), 6000, 'Google Çeviri');
    const translated = pickText(data);
    return translated || null;
  }

  DS.providers.google = {
    id: 'google-translate',
    translate: translate
  };
})(typeof self !== 'undefined' ? self : this);
