(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});

  // Provider chain.
  //
  // Free sources come first and are all keyless:
  //   English side : dictionaryapi.dev (IPA) + Wiktionary (definitions/POS)
  //   Turkish side : Google gtx -> MyMemory -> free AI (Pollinations)
  //   Sentences    : free AI -> Tatoeba -> free AI retry
  //
  // Claude is kept only as an optional last resort when the user has configured
  // a key; nothing in the normal path needs one. Every provider is best-effort:
  // a failure falls through rather than breaking the panel.

  function hasMeanings(result) {
    return Boolean(result && Array.isArray(result.meanings) && result.meanings.length);
  }

  function splitMeanings(text) {
    return String(text || '')
      .split(/[;,/]/)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  // English side: the dictionary API carries IPA (which Wiktionary lacks), so
  // both are asked in parallel and merged.
  async function englishSide(word) {
    const [dictionary, wiktionary] = await Promise.all([
      DS.providers.util.guarded('free-dictionary', () => DS.providers.freeDictionary.lookup(word)),
      DS.providers.util.guarded('wiktionary', () => DS.providers.wiktionary.lookup(word))
    ]);

    if (!dictionary && !wiktionary) {
      return null;
    }

    return {
      partOfSpeech: (dictionary && dictionary.partOfSpeech) || (wiktionary && wiktionary.partOfSpeech) || '',
      ipa: (dictionary && dictionary.ipa) || '',
      audio: (dictionary && dictionary.audio) || '',
      englishDefinitions: (
        (dictionary && dictionary.englishDefinitions) ||
        (wiktionary && wiktionary.englishDefinitions) ||
        []
      )
    };
  }

  // Turkish meanings, cheapest working source first. Google is both the fastest
  // and the most accurate for single words, MyMemory covers the case where gtx
  // is blocked, and the free AI is the last resort (and the only one that can
  // read the surrounding sentence).
  async function turkishSide(word) {
    const [google, mymemory] = await Promise.allSettled([
      DS.providers.util.guarded('google', () => DS.providers.google.translate(word, 'en', 'tr')),
      DS.providers.util.guarded('mymemory', () => DS.providers.mymemory.lookup(word))
    ]);

    const meanings = [];

    if (google.status === 'fulfilled' && google.value) {
      for (const part of splitMeanings(google.value)) {
        if (!meanings.includes(part)) {
          meanings.push(part);
        }
      }
    }

    if (mymemory.status === 'fulfilled' && mymemory.value) {
      for (const part of (mymemory.value.meanings || [])) {
        if (!meanings.includes(part)) {
          meanings.push(part);
        }
      }
    }

    return meanings;
  }

  const AI_MEANING_PROMPT = [
    'You are an English-Turkish dictionary.',
    'Give the Turkish meaning(s) of the English word below, as used in the context if one is given.',
    'Return ONLY JSON: {"meanings":["..."],"partOfSpeech":"isim|fiil|sıfat|zarf|..."}',
    'At most 3 short meanings, most common first.'
  ].join(' ');

  async function aiMeanings(word, context) {
    const user = ['Word: ' + word,
      context ? 'Context: "' + String(context).slice(0, 220) + '"' : ''
    ].filter(Boolean).join('\n');

    const payload = await DS.providers.freeAI.json([
      { role: 'system', content: AI_MEANING_PROMPT },
      { role: 'user', content: user }
    ], { temperature: 0.2, timeout: 22000 });

    const rows = (payload && (payload.meanings || payload.anlamlar)) || [];
    const meanings = (Array.isArray(rows) ? rows : [rows])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 3);

    if (!meanings.length) {
      throw new Error('Ücretsiz yapay zekâ anlam döndürmedi.');
    }

    return {
      meanings: meanings,
      partOfSpeech: String((payload && (payload.partOfSpeech || payload.tur)) || '').trim()
    };
  }

  // The panel calls this after the fast lookup is already painted, so a slow AI
  // never delays the first meaningful result.
  async function refine(word, context) {
    if (!context) {
      return null;
    }

    return DS.providers.util.guarded('free-ai', () => aiMeanings(word, context));
  }

  async function lookup(word) {
    const [english, meanings] = await Promise.all([
      englishSide(word),
      turkishSide(word)
    ]);

    const merged = {
      meanings: meanings,
      partOfSpeech: (english && english.partOfSpeech) || '',
      ipa: (english && english.ipa) || '',
      audio: (english && english.audio) || '',
      englishDefinitions: (english && english.englishDefinitions) || []
    };

    // Free sources already answered: Claude is not worth a round trip.
    if (hasMeanings(merged) && (merged.partOfSpeech || merged.ipa)) {
      return merged;
    }

    // Free Turkish sources came up empty: try the free AI before giving up.
    if (!hasMeanings(merged)) {
      try {
        const ai = await DS.providers.util.guarded('free-ai', () => aiMeanings(word, ''));
        if (ai) {
          merged.meanings = ai.meanings;
          merged.partOfSpeech = merged.partOfSpeech || ai.partOfSpeech;
        }
      } catch (error) {
        // Fall through to the optional paid provider / null result.
      }
    }

    if (hasMeanings(merged) && merged.partOfSpeech) {
      return merged;
    }

    const upgraded = await DS.providers.claude.lookup(word);
    if (upgraded) {
      return {
        meanings: upgraded.meanings.length ? upgraded.meanings : merged.meanings,
        partOfSpeech: upgraded.partOfSpeech || merged.partOfSpeech,
        ipa: upgraded.ipa || merged.ipa,
        audio: merged.audio,
        englishDefinitions: merged.englishDefinitions
      };
    }

    return hasMeanings(merged) || merged.englishDefinitions.length ? merged : null;
  }

  // Returns { sentences, partial, warning, sources, error } so the panel can
  // distinguish "five verified sentences" from "the free sources are down".
  async function sentencesWithStatus(word, contextSentence, avoid, opts) {
    const options = opts || {};
    const result = await DS.sentences.build(word, {
      context: contextSentence,
      avoid: avoid || [],
      aiTimeoutMs: options.aiTimeoutMs,
      budgetMs: options.budgetMs
    });

    if (result.sentences.length >= 5) {
      return {
        sentences: result.sentences,
        partial: false,
        warning: '',
        sources: result.sources,
        error: ''
      };
    }

    // Optional paid fallback, only when the user configured a key earlier.
    try {
      const upgraded = await DS.providers.claude.sentences(word, contextSentence);
      if (Array.isArray(upgraded) && upgraded.length) {
        const merged = result.sentences.slice();
        const seen = new Set(merged.map((s) => DS.sentences.flatten(s.en)));
        for (const item of upgraded) {
          const key = DS.sentences.flatten(item.en);
          if (!seen.has(key) && item.en && item.tr) {
            seen.add(key);
            merged.push({ en: item.en, tr: item.tr, source: 'Claude' });
          }
          if (merged.length >= 5) {
            break;
          }
        }
        if (merged.length > result.sentences.length) {
          return {
            sentences: merged.slice(0, 5),
            partial: merged.length < 5,
            warning: merged.length < 5
              ? ('Yalnızca ' + merged.length + ' doğrulanmış cümle bulunabildi.')
              : '',
            sources: Array.from(new Set(merged.map((s) => s.source).filter(Boolean))),
            error: ''
          };
        }
      }
    } catch (error) {
      // The free result is already the answer; a missing key is not an error.
    }

    return {
      sentences: result.sentences,
      partial: result.partial,
      warning: result.warning,
      sources: result.sources,
      error: result.error || ''
    };
  }

  async function sentences(word, contextSentence, avoid) {
    const result = await sentencesWithStatus(word, contextSentence, avoid);
    return result.sentences;
  }

  async function status() {
    return {
      hasClaudeKey: await DS.providers.claude.hasKey(),
      freeAI: true,
      freeTranslation: true
    };
  }

  DS.providerChain = {
    lookup: lookup,
    refine: refine,
    aiMeanings: aiMeanings,
    sentences: sentences,
    sentencesWithStatus: sentencesWithStatus,
    status: status
  };
})(typeof self !== 'undefined' ? self : this);
