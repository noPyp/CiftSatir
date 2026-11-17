(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});

  // Pure helpers for the English-only video path: which lines are worth
  // translating next, and how the collected translations are laid back onto the
  // original timings. Kept out of content.js so they can be tested without a
  // browser (test/cue-translate-check.js).

  const MAX_TEXT_LENGTH = 400;

  function textOf(cue) {
    return String((cue && cue.text) || '').trim();
  }

  function lookup(translated, text) {
    if (!text || !translated) {
      return '';
    }
    if (typeof translated.get === 'function') {
      return String(translated.get(text) || '');
    }
    return String(translated[text] || '');
  }

  // Rebuilds the Turkish channel from whatever translations exist. Timings are
  // copied from the English cue, so the two lines stay in sync even though the
  // translation arrived later.
  function build(englishCues, translated) {
    const out = [];

    for (const cue of englishCues || []) {
      const text = textOf(cue);
      const tr = lookup(translated, text).trim();
      if (!cue || !tr) {
        continue;
      }
      out.push({
        start: Number(cue.start),
        end: Number(cue.end),
        text: tr
      });
    }

    return out;
  }

  // The current line plus a short look-ahead. Lines that already have a
  // translation, empty lines and very long lines (a whole paragraph in one cue)
  // are skipped rather than slowing every other line down.
  function pick(englishCues, time, translated, limit) {
    const now = Number(time) || 0;
    const max = Number(limit) > 0 ? Number(limit) : 3;
    const out = [];

    for (const cue of englishCues || []) {
      if (!cue) {
        continue;
      }

      if (Number(cue.end) <= now) {
        continue;
      }

      if (Number(cue.start) > now + 25) {
        break;
      }

      const text = textOf(cue);
      if (!text || text.length > MAX_TEXT_LENGTH) {
        continue;
      }

      if (lookup(translated, text)) {
        continue;
      }

      out.push(text);
      if (out.length >= max) {
        break;
      }
    }

    return out;
  }

  DS.cueTranslate = {
    build: build,
    pick: pick,
    MAX_TEXT_LENGTH: MAX_TEXT_LENGTH
  };
})(typeof self !== 'undefined' ? self : this);
