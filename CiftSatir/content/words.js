(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});

  // A "word" is a run of letters/digits that may contain an internal apostrophe
  // or hyphen, so "don't" and "well-known" stay single lookup units.
  // Leading/trailing punctuation is split off and stays outside the clickable
  // span, so the hover box hugs the word itself.
  const TOKEN_RE = /^([^\p{L}\p{N}]*)([\p{L}\p{N}][\p{L}\p{N}'’\-]*)?([^\p{L}\p{N}]*)$/u;

  function tokenize(text) {
    const parts = [];
    const raw = String(text == null ? '' : text);
    const tokens = raw.split(/(\s+)/);

    for (const token of tokens) {
      if (!token) {
        continue;
      }

      if (/^\s+$/.test(token)) {
        parts.push({ text: token, clean: null, isWord: false });
        continue;
      }

      const match = TOKEN_RE.exec(token);
      const leading = match && match[1] ? match[1] : '';
      const core = match && match[2] ? match[2] : '';
      const trailing = match && match[3] ? match[3] : '';

      if (!core) {
        parts.push({ text: token, clean: null, isWord: false });
        continue;
      }

      if (leading) {
        parts.push({ text: leading, clean: null, isWord: false });
      }
      parts.push({ text: core, clean: core, isWord: true });
      if (trailing) {
        parts.push({ text: trailing, clean: null, isWord: false });
      }
    }

    return parts;
  }

  // Builds the English line as individual spans. Non-word parts (spaces and
  // punctuation) go in as plain text nodes so the browser can wrap lines at
  // them normally.
  function buildWordSpans(text) {
    const fragment = document.createDocumentFragment();
    const words = [];

    for (const part of tokenize(text)) {
      if (!part.isWord) {
        fragment.appendChild(document.createTextNode(part.text));
        continue;
      }

      const span = document.createElement('span');
      span.className = DS.constants.WORD_CLASS;
      span.textContent = part.text;
      span.dataset.word = DS.stemmer.normalizeForLookup(part.clean);
      span.dataset.lemma = DS.stemmer.stem(part.clean);
      span.setAttribute('role', 'button');
      span.setAttribute('tabindex', '0');

      fragment.appendChild(span);
      words.push(span);
    }

    return { fragment, words };
  }

  // Key for a cue's rendered form. When this is unchanged the overlay keeps the
  // existing spans instead of rebuilding them, which is what keeps a click from
  // being swallowed mid-hover on a 4x/sec timeupdate.
  function cueSignature(cue) {
    return cue ? cue.id + ':' + cue.text : '';
  }

  DS.words = {
    tokenize: tokenize,
    buildWordSpans: buildWordSpans,
    cueSignature: cueSignature
  };
})(typeof self !== 'undefined' ? self : this);
