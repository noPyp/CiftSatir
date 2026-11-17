(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});
  const { withTimeout, fetchJson } = DS.providers.util;

  // Wiktionary's REST definition endpoint, used as the fallback for English
  // definitions and part of speech when api.dictionaryapi.dev is unavailable.
  // It carries no IPA (the payload has no phonetics field) and no Turkish, so
  // it is a partial substitute only - but it is fast and has no rate limit.
  const ENDPOINT = 'https://en.wiktionary.org/api/rest_v1/page/definition/';

  const POS_MAP = {
    verb: 'fiil',
    noun: 'isim',
    adjective: 'sıfat',
    adverb: 'zarf',
    pronoun: 'zamir',
    preposition: 'edat',
    conjunction: 'bağlaç',
    interjection: 'ünlem',
    determiner: 'belirteç',
    numeral: 'sayı',
    particle: 'ilgeç'
  };

  function translatePos(pos) {
    const key = String(pos || '').trim().toLowerCase();
    return POS_MAP[key] || key;
  }

  // Definitions arrive as HTML fragments full of links and usage-label spans.
  // They are reduced to plain text here rather than at render time, so nothing
  // downstream has to think about markup.
  function stripHtml(html) {
    return String(html || '')
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async function lookup(word) {
    const term = String(word || '').trim().toLowerCase();
    if (!term) {
      return null;
    }

    let data;
    try {
      data = await withTimeout(
        fetchJson(ENDPOINT + encodeURIComponent(term)),
        6000,
        'Wiktionary'
      );
    } catch (error) {
      // 404 is a healthy "no entry"; anything else is a real outage and is
      // rethrown so the caller's circuit breaker sees it.
      if (error && /HTTP 404/.test(error.message || '')) {
        return null;
      }
      throw error;
    }

    // The payload is keyed by language code; only the English section is of
    // interest.
    const entries = data && Array.isArray(data.en) ? data.en : [];
    if (!entries.length) {
      return null;
    }

    const englishDefinitions = [];
    let partOfSpeech = '';

    for (const entry of entries) {
      if (!partOfSpeech && entry.partOfSpeech) {
        partOfSpeech = entry.partOfSpeech;
      }

      for (const definition of entry.definitions || []) {
        const text = stripHtml(definition.definition);
        // Usage labels come through as leading fragments like "(transitive)".
        if (text) {
          englishDefinitions.push(text);
        }
      }
    }

    if (!partOfSpeech && !englishDefinitions.length) {
      return null;
    }

    return {
      partOfSpeech: translatePos(partOfSpeech),
      ipa: '',
      audio: '',
      englishDefinitions: englishDefinitions.slice(0, 4)
    };
  }

  DS.providers.wiktionary = {
    id: 'wiktionary',
    lookup: lookup,
    translatePos: translatePos,
    stripHtml: stripHtml
  };
})(typeof self !== 'undefined' ? self : this);
