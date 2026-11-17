(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});

  // Sentence assembly for auto-generated subtitles.
  //
  // YouTube's automatic captions are painted one fragment at a time: the visible
  // line grows word by word ("so", "so today", "so today I...") and only becomes
  // a sentence at the very end. Rendering every fragment put a stuttering,
  // half-finished line on screen, and the Turkish translation was re-requested
  // for each fragment. This module turns those fragments back into sentences:
  // the fragment is appended to the open sentence, and the sentence is handed
  // over only when it is finished.
  //
  // It is deliberately stateless (append / isTerminal / group). The caller keeps
  // the buffer, which keeps the live YouTube watcher and the offline cue list
  // reader on exactly the same rules.

  // A finished sentence ends with terminal punctuation, optionally followed by a
  // closing quote or bracket. Commas are not a sentence end.
  const TERMINAL_RE = /[.!?…。！？](?:["'”’»)\]]+)?$/;

  const DEFAULTS = {
    maxWords: 22,
    minWords: 2,
    // A gap longer than this between two captions means a new sentence started
    // even when the speaker's line had no punctuation.
    joinGap: 1.2
  };

  function words(text) {
    return String(text == null ? '' : text)
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);
  }

  function wordCount(text) {
    return words(text).length;
  }

  // Comparison form of one word: case and punctuation are not part of the
  // identity, because the player repaints "Hello," as "hello" and back.
  function foldWord(value) {
    return String(value == null ? '' : value)
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[^\p{L}\p{N}']/gu, '');
  }

  function foldedWords(text) {
    return words(text).map(foldWord);
  }

  function isTerminal(text) {
    return TERMINAL_RE.test(String(text == null ? '' : text).trim());
  }

  // Appends a freshly painted caption to the sentence being built.
  //
  // The new text is usually the old text plus a few words ("Hello" ->
  // "Hello everyone"), but it can also be a completely new phrase after the
  // player cleared the line. Finding the largest word overlap keeps both cases
  // from duplicating text.
  function append(buffer, next) {
    const base = String(buffer == null ? '' : buffer).replace(/\s+/g, ' ').trim();
    const addition = String(next == null ? '' : next).replace(/\s+/g, ' ').trim();

    if (!addition) {
      return base;
    }
    if (!base) {
      return addition;
    }

    const baseWords = words(base);
    const nextWords = words(addition);
    const max = Math.min(baseWords.length, nextWords.length);
    let overlap = 0;

    for (let size = max; size > 0; size -= 1) {
      let same = true;
      for (let index = 0; index < size; index += 1) {
        const left = foldWord(baseWords[baseWords.length - size + index]);
        const right = foldWord(nextWords[index]);
        if (left !== right) {
          same = false;
          break;
        }
      }
      if (same) {
        overlap = size;
        break;
      }
    }

    if (overlap >= nextWords.length) {
      // The new line adds nothing; keep what is already assembled.
      return base;
    }

    // The new line is the whole sentence plus more ("Hello" -> "Hello,
    // everyone"). Keeping the newer text preserves punctuation the earlier
    // paint did not have yet.
    if (overlap >= baseWords.length) {
      return addition;
    }

    return base + ' ' + nextWords.slice(overlap).join(' ');
  }

  // True when `text` begins with every word of `prefix`.
  function startsWith(text, prefix) {
    const prefixWords = foldedWords(prefix);
    if (!prefixWords.length) {
      return false;
    }

    const textWords = foldedWords(text);
    if (textWords.length < prefixWords.length) {
      return false;
    }

    for (let index = 0; index < prefixWords.length; index += 1) {
      if (textWords[index] !== prefixWords[index]) {
        return false;
      }
    }

    return true;
  }

  // Removes already-published words from the front of a repainted line. The
  // YouTube caption box keeps the previous line on screen for a moment while the
  // next one starts, so the raw text can include the sentence that is already
  // shown.
  function removePrefix(text, prefix) {
    if (!prefix || !startsWith(text, prefix)) {
      return String(text == null ? '' : text);
    }

    const count = wordCount(prefix);
    return words(text).slice(count).join(' ');
  }

  // Rebuilds sentence-level cues from a list of word- or phrase-level cues.
  // Used for YouTube's auto-generated TextTrack and for the timedtext formats
  // (json3 / srv3) where every word is its own entry.
  function group(cues, options) {
    const opts = Object.assign({}, DEFAULTS, options || {});
    const sorted = (Array.isArray(cues) ? cues : [])
      .filter((cue) => cue && String(cue.text || '').trim())
      .slice()
      .sort((left, right) => Number(left.start) - Number(right.start));

    const out = [];
    let current = null;

    const close = () => {
      if (!current) {
        return;
      }
      if (String(current.text || '').trim()) {
        out.push(current);
      }
      current = null;
    };

    for (const cue of sorted) {
      const start = Number(cue.start);
      const end = Number(cue.end);

      if (!current) {
        current = { start: start, end: end, text: String(cue.text).trim() };
      } else {
        const gap = start - Number(current.end);
        const continues = gap <= opts.joinGap &&
          !isTerminal(current.text) &&
          wordCount(current.text) < opts.maxWords;

        if (!continues) {
          close();
          current = { start: start, end: end, text: String(cue.text).trim() };
        } else {
          current.text = append(current.text, cue.text);
          current.end = Math.max(Number(current.end), end);
        }
      }

      if (isTerminal(current.text) || wordCount(current.text) >= opts.maxWords) {
        close();
      }
    }

    close();
    return out;
  }

  DS.sentenceBuilder = {
    append: append,
    isTerminal: isTerminal,
    startsWith: startsWith,
    removePrefix: removePrefix,
    group: group,
    words: words,
    wordCount: wordCount,
    foldWord: foldWord,
    DEFAULTS: DEFAULTS
  };
})(typeof self !== 'undefined' ? self : this);
