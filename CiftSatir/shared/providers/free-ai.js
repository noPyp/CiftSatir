(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});
  const { withTimeout } = DS.providers.util;

  // Pollinations' OpenAI-compatible text endpoint. Keyless and free; the same
  // service the learning site already uses as its no-key AI. No API key is
  // requested from the user.
  //
  // It is a shared public endpoint, so it can be slow or rate-limited. Every
  // call therefore has a hard timeout and the caller falls back to dictionary
  // examples + Google Translate when it fails.
  const ENDPOINT = 'https://text.pollinations.ai/openai';
  const MODEL = 'openai';
  const TIMEOUT = 30000;

  async function chat(messages, opts) {
    const options = opts || {};
    const body = {
      model: MODEL,
      messages: (messages || []).map((m) => ({
        role: m.role || 'user',
        content: String(m.content || '')
      })),
      temperature: typeof options.temperature === 'number' ? options.temperature : 0.6
    };

    if (options.json) {
      body.response_format = { type: 'json_object' };
    }

    let response;
    try {
      response = await withTimeout(fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify(body)
      }), options.timeout || TIMEOUT, 'Ücretsiz yapay zekâ');
    } catch (error) {
      throw error;
    }

    if (!response.ok) {
      throw new Error('Ücretsiz yapay zekâ HTTP ' + response.status);
    }

    const data = await response.json();
    const content = data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content;

    const text = String(content || '').trim();
    if (!text) {
      throw new Error('Ücretsiz yapay zekâ boş yanıt verdi.');
    }

    return text;
  }

  // Models sometimes wrap JSON in ```json fences or add a sentence before it.
  // Pulling the outermost object out is more reliable than trusting the whole
  // reply to parse.
  function parseJson(text) {
    const raw = String(text || '').trim();
    if (!raw) {
      return null;
    }

    const withoutFence = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    try {
      return JSON.parse(withoutFence);
    } catch (error) {
      // fall through to brace matching
    }

    const start = withoutFence.indexOf('{');
    const end = withoutFence.lastIndexOf('}');
    if (start < 0 || end <= start) {
      return null;
    }

    try {
      return JSON.parse(withoutFence.slice(start, end + 1));
    } catch (error) {
      return null;
    }
  }

  async function json(messages, opts) {
    const text = await chat(messages, Object.assign({ json: true }, opts || {}));
    return parseJson(text);
  }

  DS.providers.freeAI = {
    id: 'free-ai',
    chat: chat,
    json: json,
    parseJson: parseJson
  };
})(typeof self !== 'undefined' ? self : this);
