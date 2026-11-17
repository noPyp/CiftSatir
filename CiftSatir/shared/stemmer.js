(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});

  // This lives in shared/ rather than content/ because both contexts need it:
  // the content script tags each word span with its stem, and the service
  // worker resolves a stem to a dictionary entry. content/words.js is
  // DOM-bound and cannot be loaded into the service worker, so the pure string
  // logic sits here.

  // Strips anything that isn't part of the word itself: surrounding quotes and
  // punctuation, curly apostrophes normalised to straight ones, lowercased.
  // The word splitter already separates leading/trailing punctuation into
  // plain text nodes, so this is a second line of defence for callers that
  // pass a raw token straight through.
  function normalizeForLookup(word) {
    return String(word || '')
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[«»""„”]/g, '')
      // Internal apostrophes and hyphens survive ("don't", "well-known");
      // anything non-alphanumeric is stripped from both ends.
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  }

  // Kept deliberately conservative: a wrong stem costs the user a worse
  // definition than no stem at all, so only common, low-risk endings appear.
  //
  // `minBase` gates on the length of the *original* word, not the stem - the
  // point of the threshold is to avoid stemming short words like "gas" or
  // "bus", and "running" must still be allowed to reach "run".
  //
  // Order is significant: the first candidate the dictionary recognizes wins,
  // so the more specific suffix comes first (("studies" as -ies -> "study"
  // before -s -> "studie").
  const SUFFIX_RULES = [
    { re: /(ies)$/, to: 'y', minBase: 5 },
    { re: /(es)$/, to: '', minBase: 5 },
    { re: /(s)$/, to: '', minBase: 4 },
    { re: /(ing)$/, to: '', minBase: 6 },
    { re: /(ed)$/, to: '', minBase: 5 },
    { re: /(ly)$/, to: '', minBase: 5 }
  ];

  function uniq(list) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
      if (item && !seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
    return out;
  }

  // Produces the candidate base forms for one suffix rule, most likely first.
  // The dictionary is the real judge of which one is a word, so this offers a
  // few plausible forms rather than committing to one.
  //
  // The two repairs are mutually exclusive, which is what keeps the list short:
  //   "running" -> "runn"  (doubled consonant, strip one)
  //   "making"  -> "mak"   (no doubling; a silent 'e' was dropped)
  function variantsFor(base, rule) {
    const plain = base.replace(rule.re, rule.to);
    const variants = [];

    if (rule.to !== '') {
      // "studies" -> "study": the replacement is already the answer.
      return [plain];
    }

    const doubled = /([bdfglmnprt])\1$/.test(plain);

    if (doubled) {
      // "running" -> "runn" -> "run"
      variants.push(plain.slice(0, -1));
      variants.push(plain);
      return variants;
    }

    // "making" -> "mak" -> "make"; "loved" -> "lov" -> "love". A vowel-final
    // stem ("going" -> "go") takes no 'e'.
    if (!/[aeiou]$/.test(plain)) {
      variants.push(plain + 'e');
    }

    variants.push(plain);
    return variants;
  }

  // Stemming is inherently a guess ("movies" -> "movie" or "move"?), and the
  // dictionary is the real authority. So rather than committing to one answer
  // this returns candidates in preference order; the lookup tries each until
  // one is recognized. The word itself is always the last candidate, so a
  // plural with no singular entry ("news", "series") still resolves.
  function stemsFor(word) {
    const base = normalizeForLookup(word);
    if (!base) {
      return [];
    }

    const candidates = [];

    for (const rule of SUFFIX_RULES) {
      if (base.length < rule.minBase || !rule.re.test(base)) {
        continue;
      }

      for (const candidate of variantsFor(base, rule)) {
        if (candidate.length >= 3) {
          candidates.push(candidate);
        }
      }
    }

    candidates.push(base);
    return uniq(candidates);
  }

  function stem(word) {
    return stemsFor(word)[0] || normalizeForLookup(word);
  }

  DS.stemmer = {
    normalizeForLookup: normalizeForLookup,
    stemsFor: stemsFor,
    stem: stem
  };
})(typeof self !== 'undefined' ? self : this);
