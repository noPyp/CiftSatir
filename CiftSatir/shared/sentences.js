(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});

  // Builds the five example sentences for a word.
  //
  // Order of sources:
  //   1. free AI (Pollinations, no key) - the only source that can reliably
  //      produce five graded sentences *and* their Turkish translations
  //   2. Tatoeba - real human sentences with human Turkish translations
  //   3. a second AI attempt at a different temperature
  //
  // Nothing is invented locally. When fewer than five verified sentences can be
  // collected the result says so (`partial` + `warning`) instead of padding the
  // list with made-up lines.

  const MIN_EN_WORDS = 3;
  const MAX_EN_LENGTH = 240;

  // The panel gives a word-sentences request 60 s before it reports the
  // background service as unreachable. Two 30 s AI attempts in a row could eat
  // that whole budget and the user saw "örnek cümleler alınamadı" even though
  // real sentences (or a partial list) had been produced. The first attempt now
  // gets a shorter timeout and the retry only runs while enough of the budget is
  // left, so an answer always comes back before the caller gives up.
  const AI_TIMEOUT = 22000;
  const RETRY_MIN_MS = 8000;
  const BUDGET_MS = 45000;

  function flatten(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/\s+/g, ' ')
      .replace(/[^\p{L}\p{N}' ]/gu, '')
      .trim();
  }

  function wordForms(word) {
    const base = DS.stemmer.normalizeForLookup(word);
    if (!base) {
      return [];
    }
    const forms = DS.stemmer.stemsFor(base);
    return forms.length ? forms : [base];
  }

  function containsWord(sentence, forms) {
    const text = ' ' + flatten(sentence) + ' ';
    return forms.some((form) => text.indexOf(' ' + flatten(form)) >= 0 ||
      text.indexOf(' ' + flatten(form) + "'") >= 0);
  }

  function validSentence(item, forms, avoid) {
    if (!item || typeof item.en !== 'string' || typeof item.tr !== 'string') {
      return false;
    }

    const en = item.en.trim();
    const tr = item.tr.trim();
    if (!en || !tr) {
      return false;
    }

    if (en.length > MAX_EN_LENGTH) {
      return false;
    }

    if (en.split(/\s+/).length < MIN_EN_WORDS) {
      return false;
    }

    // The word (or one of its inflected forms) must actually occur. An AI reply
    // that drifts onto a synonym is not an example of this word.
    if (!containsWord(en, forms)) {
      return false;
    }

    const key = flatten(en);
    if (!key || (avoid && avoid.has(key))) {
      return false;
    }

    return true;
  }

  function dedupe(list) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const key = flatten(item.en);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  function cleanLevel(value) {
    const level = String(value || '').trim().toUpperCase();
    return /^(A1|A2|B1|B2|C1|C2)$/.test(level) ? level : '';
  }

  function fromAIPayload(payload, forms, avoid) {
    const rows = (payload && (payload.sentences || payload.cumleler || payload.examples)) || [];
    if (!Array.isArray(rows)) {
      return [];
    }

    const out = [];
    for (const row of rows) {
      const item = {
        en: String((row && (row.en || row.english || row.ingilizce)) || '').trim(),
        tr: String((row && (row.tr || row.turkish || row.turkce)) || '').trim(),
        level: cleanLevel(row && row.level),
        source: 'AI (ücretsiz)'
      };
      if (validSentence(item, forms, avoid)) {
        out.push(item);
      }
    }
    return dedupe(out);
  }

  function aiPrompt(word, context, avoid, attempt) {
    const lines = [
      'You are an English-Turkish learning assistant.',
      'Write exactly 5 different English example sentences for the word "' + word + '".',
      'Rules:',
      '- Use the word exactly as given (an inflected form is allowed when natural).',
      '- Everyday, natural, grammatically correct sentences, 6-16 words each.',
      '- Use the sense in which the word appears in the context below, if a context is given.',
      '- Each sentence must have its own natural Turkish translation.',
      '- Do not repeat a sentence or reuse its structure.',
      'Return ONLY JSON in this shape:',
      '{"sentences":[{"en":"...","tr":"...","level":"A2"}]}'
    ];

    if (context) {
      lines.push('Context sentence from the video: "' + String(context).slice(0, 220) + '"');
    }

    if (avoid && avoid.size) {
      lines.push('Never use these previously shown sentences:');
      for (const text of Array.from(avoid).slice(0, 12)) {
        lines.push('- ' + text);
      }
    }

    if (attempt > 1) {
      lines.push('This is a retry: choose completely different topics and sentence openings.');
    }

    return lines.join('\n');
  }

  async function fromAI(word, context, forms, avoid, attempt, timeout) {
    const payload = await DS.providers.freeAI.json([
      {
        role: 'system',
        content: 'You reply with valid JSON only. No markdown, no commentary.'
      },
      { role: 'user', content: aiPrompt(word, context, avoid, attempt) }
    ], { temperature: attempt > 1 ? 1 : 0.7, timeout: timeout || AI_TIMEOUT });

    return fromAIPayload(payload, forms, avoid);
  }

  // Fills the gap with real Tatoeba sentences. They already carry a human
  // Turkish translation; when one is missing, Google Translate supplies it so
  // the line is still usable.
  async function fromTatoeba(word, forms, avoid, limit) {
    let rows = [];
    try {
      rows = await DS.providers.tatoeba.examples(word, limit + 4);
    } catch (error) {
      return [];
    }

    const out = [];
    for (const row of rows) {
      const item = { en: row.en, tr: row.tr, source: 'Tatoeba' };
      if (validSentence(item, forms, avoid)) {
        out.push(item);
      }
    }
    return dedupe(out);
  }

  function mergeUnique(target, extra, limit) {
    const seen = new Set(target.map((item) => flatten(item.en)));
    for (const item of extra) {
      const key = flatten(item.en);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      target.push(item);
      if (limit && target.length >= limit) {
        break;
      }
    }
    return target;
  }

  async function build(word, opts) {
    const options = opts || {};
    const forms = wordForms(word);
    const avoid = new Set((options.avoid || []).map(flatten).filter(Boolean));
    const startedAt = Date.now();
    const budget = Number(options.budgetMs) > 0 ? Number(options.budgetMs) : BUDGET_MS;
    const aiTimeout = Number(options.aiTimeoutMs) > 0 ? Number(options.aiTimeoutMs) : AI_TIMEOUT;

    // Tatoeba runs in parallel with the AI call: both are network-bound, and a
    // slow AI should not also pay for the sentence bank afterwards.
    const [aiResult, tatoebaResult] = await Promise.allSettled([
      fromAI(word, options.context || '', forms, avoid, 1, aiTimeout),
      fromTatoeba(word, forms, avoid, 6)
    ]);

    const sentences = [];
    let aiError = '';

    if (aiResult.status === 'fulfilled') {
      mergeUnique(sentences, aiResult.value, 5);
    } else {
      aiError = String(aiResult.reason && aiResult.reason.message || aiResult.reason || '');
    }

    if (tatoebaResult.status === 'fulfilled') {
      mergeUnique(sentences, tatoebaResult.value, 5);
    }

    // A second AI attempt is only worth the wait when the first one produced
    // nothing usable at all; when it produced 3-4 good lines, Tatoeba or the
    // honest partial result is better than another 30 seconds of silence. It also
    // only runs while the time budget still leaves room for an answer.
    if (!sentences.length) {
      const remaining = budget - (Date.now() - startedAt);
      if (remaining >= RETRY_MIN_MS) {
        try {
          const retry = await fromAI(
            word,
            options.context || '',
            forms,
            avoid,
            2,
            Math.min(aiTimeout, remaining - 2000)
          );
          mergeUnique(sentences, retry, 5);
        } catch (error) {
          aiError = aiError || String(error && error.message || error);
        }
      }
    }

    const finalList = sentences.slice(0, 5);
    const sources = Array.from(new Set(finalList.map((item) => item.source)));

    return {
      sentences: finalList,
      partial: finalList.length < 5,
      sources: sources,
      warning: finalList.length < 5
        ? ('Yalnızca ' + finalList.length + ' doğrulanmış cümle bulunabildi. ' +
          'Ücretsiz kaynaklar şu an yanıt vermiyor olabilir; tekrar dene.')
        : '',
      error: aiError
    };
  }

  DS.sentences = {
    build: build,
    flatten: flatten,
    containsWord: containsWord,
    fromAIPayload: fromAIPayload,
    validSentence: validSentence
  };
})(typeof self !== 'undefined' ? self : this);
