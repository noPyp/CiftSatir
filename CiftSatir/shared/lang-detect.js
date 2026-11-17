(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});

  // Decides which subtitle track is English and which is Turkish.
  //
  // The rule this follows is: accept when there is a reason to, refuse only when
  // there is a reason to. An earlier version of this file required several
  // matching words and refused whenever it was unsure, which rejected ordinary
  // dialogue ("I'm learning English by watching movies" matches no common
  // function word) and left the user with one line or none. Subtitles that do
  // not appear are a worse failure than subtitles in a slightly wrong language,
  // so the checks here are deliberately generous.
  //
  // What it must still prevent: a player serving French, Portuguese and Spanish
  // tracks for the same film, where an unexamined track used to land in the
  // English channel and be translated to Turkish underneath.

  // Letters that exist in neither English nor Turkish. Seeing one is solid proof
  // the track is some other language, and it is the one signal that needs no
  // sample length to trust.
  //
  // Only letters English genuinely never uses. Common accented vowels (é, á, ü,
  // ç) are left out on purpose: English subtitles contain the occasional name or
  // loanword ("José", "café"), and rejecting a whole English track over one of
  // those would be worse than the bug being fixed.
  const FOREIGN_PROOF = /[¿¡ñÑãõÃÕœŒß]/;

  // Letters English never uses but Turkish does. Their presence means Turkish.
  const TURKISH_PROOF = /[ğışĞŞİ]/;

  // Language markers in a subtitle file name.
  //
  // This is the strongest evidence available: a site that ships a Turkish track
  // labels it "-tur-" or "Turkish", and the name is not a guess about the words.
  const ACCEPTED = {
    en: ['en', 'eng', 'english'],
    tr: ['tr', 'tur', 'turkish', 'turkce']
  };

  // Track names that are confidently some other language. Recognising these lets
  // a foreign track be skipped without inspecting its text at all.
  //
  // Two-letter codes are included, but only ever consulted after the words and
  // after an English/Turkish name have had their say (see classify). That order
  // is what makes them safe: a file called "the-movie-is-good.en.vtt" contains
  // the token "is" (Icelandic) yet is correctly read as English, because the
  // English marker and the cues both get their turn first.
  const FOREIGN_NAMES = [
    'spa', 'spanish', 'esp', 'espanol', 'lat',
    'por', 'portuguese', 'portugues', 'pob',
    'fre', 'fra', 'french', 'francais',
    'ger', 'deu', 'german', 'deutsch',
    'ita', 'italian', 'italiano',
    'rus', 'russian', 'ara', 'arabic', 'pol', 'polish',
    'dut', 'nld', 'dutch', 'gre', 'ell', 'greek',
    'heb', 'hebrew', 'jpn', 'japanese', 'kor', 'korean',
    'chi', 'zho', 'chinese', 'hin', 'hindi', 'swe', 'swedish',
    'dan', 'danish', 'fin', 'finnish', 'nor', 'norwegian',
    'cze', 'ces', 'czech', 'hun', 'hungarian', 'rum', 'ron', 'romanian',
    'bul', 'bulgarian', 'srp', 'serbian', 'hrv', 'croatian', 'ukr', 'ukrainian',
    'per', 'fas', 'persian', 'tha', 'thai', 'vie', 'vietnamese',
    'ind', 'indonesian', 'may', 'msa', 'malay', 'slo', 'slk', 'slovak',
    'slv', 'slovenian', 'lit', 'lithuanian', 'lav', 'latvian', 'est', 'estonian',
    // Two-letter forms.
    'es', 'pt', 'fr', 'de', 'it', 'ru', 'ar', 'pl', 'nl', 'el', 'he', 'ja',
    'ko', 'zh', 'hi', 'sv', 'cs', 'hu', 'ro', 'bg', 'sr', 'hr', 'uk', 'fa',
    'th', 'vi', 'id', 'ms', 'da', 'fi', 'no', 'sk', 'sl', 'lt', 'lv', 'et'
  ];

  // Some releases concatenate both languages into one token; such a file carries
  // both, so it is usable as either channel.
  const BILINGUAL = ['engtr', 'tren'];

  // Words that appear constantly in one of the two languages. Used only as a
  // hint when the file name says nothing, and only to break a tie - never to
  // reject a track on its own.
  const STOPWORDS = {
    en: ['the', 'and', 'you', 'that', 'was', 'for', 'are', 'with', 'his', 'her',
      'they', 'this', 'have', 'from', 'not', 'but', 'what', 'all', 'were', 'when',
      'there', 'can', 'your', 'will', 'would', 'about', 'know', 'just', 'like',
      'him', 'get', 'out', 'one', 'now', 'hey', 'well', 'here', 'because',
      'going', 'think', 'want', 'tell', 'got', 'did', 'she', 'how', 'why', 'who',
      'something', 'nothing', 'never', 'always', 'come', 'take', 'look', 'make',
      'thank', 'thanks', 'please', 'sorry', 'yeah', 'okay', 'right', 'good',
      'back', 'down', 'over', 'been', 'than', 'then', 'them', 'these', 'very',
      'much', 'many', 'some', 'any', 'only', 'other', 'into', 'more', 'most',
      'dont', "don't", 'im', "i'm", 'its', "it's", 'youre', "you're", 'thats',
      "that's", 'cant', "can't", 'wont', "won't", 'lets', "let's", 'isnt',
      "isn't", 'didnt', "didn't", 'whats', "what's", 'theres', "there's"],
    tr: ['bir', 'bu', 've', 'ben', 'sen', 'ne', 'için', 'ile', 'çok', 'daha',
      'ama', 'ancak', 'gibi', 'kadar', 'sonra', 'önce', 'şey', 'yok', 'var',
      'beni', 'seni', 'onu', 'bana', 'sana', 'ona', 'değil', 'evet', 'hayır',
      'tamam', 'peki', 'nasıl', 'neden', 'nerede', 'kim', 'biz', 'siz', 'onlar',
      'her', 'hiç', 'şimdi', 'burada', 'orada', 'mi', 'mı', 'mu', 'mü',
      'olur', 'olacak', 'geldi', 'gitti', 'yapmak', 'istemek', 'bilmiyorum',
      'teşekkür', 'lütfen', 'üzgünüm', 'işte', 'belki', 'nasılsın', 'güzel',
      'iyi', 'kötü', 'büyük', 'küçük', 'yeni', 'eski', 'çocuk', 'adam', 'kadın',
      'biliyorum', 'istiyorum', 'gidiyor', 'geliyor', 'yapıyor', 'değilim',
      'merhaba', 'günaydın', 'iyi', 'peki', 'hadi', 'tabii', 'elbette']
  };

  // Function words from the languages most often shipped alongside English on
  // streaming sites. They are only used to recognise a clearly foreign track:
  // at least three hits, and more than English or Turkish scored. A false
  // positive here would throw away a usable English track, so the bar is high.
  const FOREIGN_STOPWORDS = {
    es: ['que', 'de', 'no', 'el', 'la', 'los', 'las', 'un', 'una', 'y', 'en',
      'por', 'para', 'con', 'quiero', 'entiendo', 'entiendo', 'cada', 'palabra',
      'dicen', 'estás', 'estas', 'haciendo', 'aquí', 'aqui', 'tengo', 'decirte',
      'algo', 'pero', 'como', 'más', 'mas', 'muy', 'esto', 'esta', 'esto',
      'tú', 'tu', 'yo', 'es', 'son', 'está', 'esta', 'hay'],
    pt: ['que', 'de', 'não', 'nao', 'o', 'a', 'os', 'as', 'um', 'uma', 'e',
      'em', 'por', 'para', 'com', 'quero', 'entender', 'cada', 'palavra',
      'dizem', 'você', 'voce', 'está', 'esta', 'fazendo', 'aqui', 'tenho',
      'dizer', 'algo', 'mas', 'como', 'mais', 'muito', 'isso', 'eu', 'é', 'são'],
    fr: ['que', 'de', 'ne', 'pas', 'le', 'la', 'les', 'un', 'une', 'et', 'en',
      'pour', 'avec', 'je', 'veux', 'comprendre', 'chaque', 'mot', 'ils',
      'disent', 'quest', "qu'est", 'tu', 'fais', 'ici', 'dois', 'te', 'dire',
      'quelque', 'chose', 'mais', 'comme', 'plus', 'très', 'tres', 'est', 'sont'],
    de: ['ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'das', 'der', 'die',
      'und', 'oder', 'aber', 'nicht', 'ein', 'eine', 'einen', 'mit', 'für',
      'fur', 'auf', 'will', 'jedes', 'wort', 'verstehen', 'sagen', 'machst',
      'hier', 'muss', 'dir', 'etwas', 'was', 'wie', 'sehr', 'noch', 'schon',
      'bin', 'bist', 'ist', 'sind', 'habe', 'hast', 'hat']
  };

  // Folds away the diacritics that separate a token from its plain form
  // ("şey" -> "sey", "için" -> "icin", "türkçe" -> "turkce"), so both sides of
  // every comparison look the same.
  //
  // NFD decomposes ş/ç/ğ/ö/ü on its own. The dotless ı and dotted İ have no
  // decomposition and are mapped explicitly, since "İ".toLowerCase() would
  // otherwise yield "i" plus a combining dot and split the token in two.
  function fold(text) {
    return String(text || '')
      .replace(/[ıİ]/g, 'i')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
  }

  function words(text) {
    return fold(text)
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .split(/[^\p{L}']+/u)
      .filter((word) => word.length > 0);
  }

  // Pre-folded once at load, so a lookup compares like with like.
  const FOLDED = (() => {
    const out = {};
    for (const [lang, list] of Object.entries(STOPWORDS)) {
      out[lang] = new Set(list.map((word) => fold(word).toLowerCase()));
    }
    return out;
  })();

  const FOLDED_FOREIGN = (() => {
    const out = {};
    for (const [lang, list] of Object.entries(FOREIGN_STOPWORDS)) {
      out[lang] = new Set(list.map((word) => fold(word).toLowerCase()));
    }
    return out;
  })();

  // Returns { lang, score } for the strongest foreign language, or null.
  // Requires at least three hits so one borrowed word ("was" in German, "que"
  // in Spanish) cannot reject a track on its own.
  function detectForeign(tokens, englishScore, turkishScore) {
    let best = null;

    for (const [lang, set] of Object.entries(FOLDED_FOREIGN)) {
      let score = 0;
      for (const token of tokens) {
        if (set.has(token.toLowerCase())) {
          score += 1;
        }
      }

      if (score < 3) {
        continue;
      }

      if (score <= englishScore || score <= turkishScore) {
        continue;
      }

      if (!best || score > best.score) {
        best = { lang: lang, score: score };
      }
    }

    return best;
  }

  // Which language these words look like, or null when they look like neither.
  //
  // Counts rather than ratios: a short cue has few words to work with, and a
  // ratio would demand a larger share than such a cue can provide.
  function scoresFor(tokens) {
    let en = 0;
    let tr = 0;
    for (const token of tokens) {
      const lower = token.toLowerCase();
      if (FOLDED.en.has(lower)) {
        en += 1;
      }
      if (FOLDED.tr.has(lower)) {
        tr += 1;
      }
    }
    return { en: en, tr: tr };
  }

  function detectFromText(text) {
    const sample = String(text || '');
    if (!sample.trim()) {
      return null;
    }

    // A letter English never uses settles it.
    if (FOREIGN_PROOF.test(sample)) {
      return null;
    }

    // A letter only Turkish uses settles it the other way.
    if (TURKISH_PROOF.test(sample)) {
      return 'tr';
    }

    const tokens = words(sample);
    if (!tokens.length) {
      return null;
    }

    const { en, tr } = scoresFor(tokens);

    // Only a clear winner counts. A tie, or nothing at all, means the sample
    // does not say - and "does not say" must not become a rejection here, since
    // the caller may still have the file name to go on.
    if (en === 0 && tr === 0) {
      return null;
    }
    if (en > 0 && tr > 0 && en === tr) {
      return null;
    }

    return en > tr ? 'en' : 'tr';
  }

  // Decides whether a whole channel is Turkish rather than English.
  //
  // This exists because of a specific, visible bug: a site that ships one
  // Turkish subtitle file (or a track with no language metadata) had those cues
  // land in the English channel, and the translator then translated Turkish
  // into Turkish. The result was two nearly identical lines, the lower one
  // machine-mangled ("...misin?" became "...mi?").
  //
  // The question is asked of the whole channel, not one cue, and the thresholds
  // are deliberately one-sided: it must look Turkish, not merely "not clearly
  // English". A stray Turkish word inside English dialogue therefore cannot
  // move the channel.
  function looksTurkish(texts) {
    const list = Array.isArray(texts) ? texts : [texts];
    let trLines = 0;
    let enLines = 0;
    let trHits = 0;
    let enHits = 0;
    let proof = 0;

    for (const item of list) {
      const sample = String(
        typeof item === 'string' ? item : (item && item.text) || ''
      ).replace(/\s+/g, ' ').trim();
      if (sample.length < 2) {
        continue;
      }

      if (TURKISH_PROOF.test(sample)) {
        trLines += 1;
        proof += 1;
        continue;
      }
      // Neither English nor Turkish (a French or Spanish line) says nothing
      // about this channel; ignore it rather than counting it as English.
      if (FOREIGN_PROOF.test(sample)) {
        continue;
      }

      const scores = scoresFor(words(sample));
      trHits += scores.tr;
      enHits += scores.en;
      if (scores.tr > scores.en) {
        trLines += 1;
      } else if (scores.en > scores.tr) {
        enLines += 1;
      }
    }

    // Letters only Turkish uses are decisive; a majority is enough because a
    // bilingual file can mix.
    if (proof > 0) {
      return trLines >= enLines;
    }

    // Without such a letter, Turkish must win on the words themselves: at least
    // two Turkish function words ("evet", "tamam", "bir", "için"...) and no more
    // English ones. That catches short lines the spelling cannot prove while
    // leaving "Okay, sure." and "I know, right?" alone.
    if (trHits < 2 || enHits > trHits) {
      return false;
    }
    return trLines >= enLines;
  }

  // Language markers found in a file name, as a set of codes. Read from the file
  // name only: a "no" or "id" path segment is not a language, and the query
  // string often carries ids that look like codes.
  function markersInUrl(url) {
    const raw = String(url || '');
    if (!raw) {
      return [];
    }

    const name = raw.split(/[?#]/)[0].split('/').pop();
    return fold(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
  }

  // Classifies a track, reporting how sure the answer is.
  //
  // Returns { lang, confidence } where confidence is:
  //   'certain'  a language marker in the file name, or letter-proof from the
  //              cues - the site labelled the track, or the spelling is
  //              unmistakable
  //   'likely'   the words read as English or Turkish
  //   'foreign'  confidently not either of ours; must not be shown
  //   'unknown'  nothing to go on
  //
  // 'unknown' is reported rather than refused. Dialogue often lacks the common
  // function words the word lists look for, and rejecting those left the user
  // with a single line or none at all. The caller fills an empty channel with
  // them and lets anything identified replace them afterwards.
  //
  // Order of evidence - and the order is load-bearing:
  //   1. a letter English never uses, which no amount of URL noise can excuse
  //   2. an English or Turkish marker in the file name
  //   3. Turkish-only letters in the cues
  //   4. what the words read as
  //   5. a foreign marker in the file name
  //
  // Rule 5 comes last on purpose. Two-letter language codes are ordinary English
  // words ("is" Icelandic, "no" Norwegian, "id" Indonesian, "it" Italian), so a
  // file called "the-movie-is-good.en.vtt" would be thrown away if the foreign
  // check ran first. Only when nothing else has claimed the track does a foreign
  // marker get to reject it.
  function classify(url, sampleText) {
    const sample = String(sampleText || '');
    const markers = markersInUrl(url);

    // 1. Spelling English never uses. Definite, and outranks any file name.
    if (FOREIGN_PROOF.test(sample)) {
      return { lang: null, confidence: 'foreign' };
    }

    // 2. The site labelled its own track, which is the best evidence there is.
    // A bilingual release carries both languages; it is filed under English so
    // that the Turkish line can still come from the translator.
    if (markers.some((marker) => BILINGUAL.includes(marker))) {
      return { lang: 'en', confidence: 'certain' };
    }

    for (const marker of markers) {
      if (ACCEPTED.en.includes(marker)) {
        return { lang: 'en', confidence: 'certain' };
      }
      if (ACCEPTED.tr.includes(marker)) {
        return { lang: 'tr', confidence: 'certain' };
      }
    }

    const tokens = words(sample);

    // 3. Turkish-only letters. On a short cue they are conclusive; on a long
    // sample they are still strong evidence, but the answer is reported as
    // "likely" because the words themselves are the better witness.
    if (TURKISH_PROOF.test(sample)) {
      if (tokens.length <= 5) {
        return { lang: 'tr', confidence: 'certain' };
      }
      return { lang: 'tr', confidence: 'likely' };
    }

    // 4. A clearly foreign track. Checked before the English/Turkish word
    // counts so German ("will", "was") is not mistaken for English just because
    // two of its words happen to be English too.
    const scores = scoresFor(tokens);
    const foreign = detectForeign(tokens, scores.en, scores.tr);
    if (foreign) {
      return { lang: null, confidence: 'foreign' };
    }

    // 5. What the words read as.
    const fromText = detectFromText(sample);
    if (fromText) {
      return { lang: fromText, confidence: 'likely' };
    }

    // 6. A foreign marker, now that nothing else has claimed the track.
    for (const marker of markers) {
      if (FOREIGN_NAMES.includes(marker)) {
        return { lang: null, confidence: 'foreign' };
      }
    }

    return { lang: null, confidence: 'unknown' };
  }

  DS.langDetect = {
    classify: classify,
    detectFromText: detectFromText,
    looksTurkish: looksTurkish,
    markersInUrl: markersInUrl,
    hasForeignProof: (text) => FOREIGN_PROOF.test(String(text || '')),
    hasTurkishProof: (text) => TURKISH_PROOF.test(String(text || '')),
    fold: fold,
    words: words
  };
})(typeof self !== 'undefined' ? self : this);
