(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});
  const { withTimeout } = DS.providers.util;

  const ENDPOINT = 'https://api.anthropic.com/v1/messages';
  const API_VERSION = '2023-06-01';
  const MODEL = 'claude-opus-5-5';

  const WORD_SCHEMA = {
    type: 'object',
    properties: {
      word: { type: 'string' },
      meanings: {
        type: 'array',
        items: { type: 'string' },
        description: 'Türkçe karşılıklar, en yaygın olan başta'
      },
      partOfSpeech: { type: 'string', description: 'Türkçe dil bilgisi terimi, örn. "fiil", "isim"' },
      ipa: { type: 'string', description: 'Uluslararası Fonetik Alfabe gösterimi' }
    },
    required: ['word', 'meanings', 'partOfSpeech', 'ipa'],
    additionalProperties: false
  };

  const SENTENCES_SCHEMA = {
    type: 'object',
    properties: {
      sentences: {
        type: 'array',
        minItems: 5,
        maxItems: 5,
        items: {
          type: 'object',
          properties: {
            en: { type: 'string' },
            tr: { type: 'string' },
            level: { type: 'string', description: 'CEFR seviyesi, örn. A2, B1, B2' }
          },
          required: ['en', 'tr', 'level'],
          additionalProperties: false
        }
      }
    },
    required: ['sentences'],
    additionalProperties: false
  };

  // The API key is read from chrome.storage.local and never reaches a content
  // script: all Claude calls originate in the service worker. Note that a key
  // stored in an extension is readable by anyone with access to the browser
  // profile, which is acceptable for personal use but not for distribution.
  async function getApiKey() {
    try {
      const stored = await chrome.storage.local.get(DS.constants.STORAGE_API_KEY);
      const key = stored && stored[DS.constants.STORAGE_API_KEY];
      return typeof key === 'string' ? key.trim() : '';
    } catch (error) {
      return '';
    }
  }

  async function call(key, prompt, schema, maxTokens) {
    const body = {
      model: MODEL,
      max_tokens: maxTokens || 2048,
      // `thinking` is deliberately omitted. On this model thinking is always on:
      // sending {type:"disabled"} or a budget_tokens value returns HTTP 400.
      // Depth is controlled with output_config.effort instead.
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: schema
        }
      },
      system: 'Sen İngilizce öğrenen Türkçe konuşan bir kullanıcıya yardım eden bir sözlük ve dil öğretmenisin. Yanıtların kısa, doğru ve doğrudan olmalı.',
      messages: [{ role: 'user', content: prompt }]
    };

    const response = await withTimeout(
      fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': API_VERSION,
          // Required for calls made from a page/worker rather than a server.
          // The API rejects browser-originated requests without it, so this
          // header is the difference between the feature working and every
          // sentence request failing with a CORS error.
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(body)
      }),
      30000,
      'Claude'
    );

    if (!response.ok) {
      let detail = '';
      try {
        const errorBody = await response.json();
        detail = (errorBody && errorBody.error && errorBody.error.message) || '';
      } catch (error) {
        detail = '';
      }

      // 401 and 403 are the two failures a user can act on, so they get a
      // message that says what to do rather than the raw API text.
      if (response.status === 401) {
        throw new Error('API anahtarı geçersiz. Popup → Kontrol sekmesinden kontrol et.');
      }
      if (response.status === 403) {
        throw new Error('Bu anahtarın bu isteği yapma izni yok.');
      }
      if (response.status === 429) {
        throw new Error('Çok fazla istek gönderildi, biraz bekleyip tekrar dene.');
      }
      if (response.status === 529 || response.status >= 500) {
        throw new Error('Claude servisi şu anda yanıt vermiyor, sonra tekrar dene.');
      }

      throw new Error('Claude API ' + response.status + (detail ? ': ' + detail : ''));
    }

    const data = await response.json();

    if (data.stop_reason === 'refusal') {
      return null;
    }

    // output_config.format guarantees the first text block is valid JSON.
    const textBlock = (data.content || []).find((block) => block && block.type === 'text');
    if (!textBlock || !textBlock.text) {
      return null;
    }

    try {
      return JSON.parse(textBlock.text);
    } catch (error) {
      return null;
    }
  }

  async function hasKey() {
    return Boolean(await getApiKey());
  }

  // The last real failure, kept so the UI can report why sentences did not
  // arrive. Without this a bad key, a rate limit and "no key configured" all
  // look identical to the user, and each needs different action.
  let lastError = '';

  function getLastError() {
    return lastError;
  }

  async function lookup(word) {
    const key = await getApiKey();
    if (!key) {
      lastError = '';
      return null;
    }

    const prompt = 'İngilizce "' + word + '" kelimesi için: en yaygın 1-3 Türkçe karşılığını, ' +
      'kelime türünü Türkçe olarak (fiil, isim, sıfat vb.) ve IPA telaffuzunu ver. ' +
      'Eğer kelime çekimli bir biçimse (örneğin "running", "went"), kök hâlini de ' +
      'karşılıklara ekle.';

    try {
      const result = await call(key, prompt, WORD_SCHEMA, 1024);
      lastError = '';
      if (!result || !Array.isArray(result.meanings) || !result.meanings.length) {
        return null;
      }
      return {
        meanings: result.meanings,
        partOfSpeech: result.partOfSpeech || '',
        ipa: result.ipa || ''
      };
    } catch (error) {
      // Recorded rather than swallowed: the caller reports it instead of
      // pretending the word was simply not found.
      lastError = String(error && error.message ? error.message : error);
      return null;
    }
  }

  // Sentences are graded easy -> hard so the word is met in rising difficulty,
  // which is what makes a five-sentence set useful for learning rather than
  // five interchangeable examples.
  async function sentences(word, contextSentence) {
    const key = await getApiKey();
    if (!key) {
      // Not an error: the feature simply needs a key the user has not added.
      lastError = '';
      return null;
    }

    const context = contextSentence
      ? ' Kelime şu bağlamda geçiyor: "' + contextSentence + '". İlk cümle bu kullanımla uyumlu olsun.'
      : '';

    const prompt = 'İngilizce "' + word + '" kelimesi için tam 5 örnek cümle yaz.' + context +
      ' Cümleler kolaydan zora sıralı olsun: 1. cümle çok basit (A2), 5. cümle ileri seviye (C1). ' +
      'Her cümlenin Türkçe çevirisini de ver. Her cümlede o kelime geçsin. ' +
      'level alanına o cümlenin CEFR seviyesini yaz.';

    try {
      const result = await call(key, prompt, SENTENCES_SCHEMA, 2048);
      lastError = '';
      if (!result || !Array.isArray(result.sentences) || !result.sentences.length) {
        return null;
      }
      return result.sentences;
    } catch (error) {
      lastError = String(error && error.message ? error.message : error);
      return null;
    }
  }

  DS.providers.claude = {
    id: 'claude',
    MODEL: MODEL,
    hasKey: hasKey,
    getApiKey: getApiKey,
    getLastError: getLastError,
    lookup: lookup,
    sentences: sentences,
    WORD_SCHEMA: WORD_SCHEMA,
    SENTENCES_SCHEMA: SENTENCES_SCHEMA
  };
})(typeof self !== 'undefined' ? self : this);
