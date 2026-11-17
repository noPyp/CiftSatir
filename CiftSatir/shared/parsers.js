(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});

  // "HH:MM:SS,mmm" (SRT) or "HH:MM:SS.mmm" / "MM:SS.mmm" (VTT).
  // SRT uses a comma for the decimal separator; VTT uses a dot. One pattern
  // accepts both so neither parser needs its own timing code.
  const TIMESTAMP_RE = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/;
  const INLINE_TIMESTAMP_RE = /<\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}>/g;
  const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;
  const ASS_OVERRIDE_RE = /\{\\[^}]*\}/g;

  const VTT_BLOCK_PREFIXES = ['WEBVTT', 'NOTE', 'STYLE', 'REGION'];

  function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  function normalizeNewlines(text) {
    return String(text).replace(/\r\n?/g, '\n');
  }

  function parseTimestamp(value) {
    if (typeof value !== 'string') {
      return null;
    }

    const match = TIMESTAMP_RE.exec(value.trim());
    if (!match) {
      return null;
    }

    const hours = match[1] ? Number(match[1]) : 0;
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const fraction = match[4] ? Number(match[4].padEnd(3, '0')) : 0;

    if (minutes > 59 || seconds > 59) {
      return null;
    }

    return hours * 3600 + minutes * 60 + seconds + fraction / 1000;
  }

  // Strips VTT inline timestamps, HTML-ish styling tags, ASS override blocks and
  // resolves the few entities that show up in subtitle files.
  function cleanCueText(raw) {
    return String(raw)
      .replace(INLINE_TIMESTAMP_RE, '')
      .replace(ASS_OVERRIDE_RE, '')
      .replace(HTML_TAG_RE, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&quot;/gi, '"')
      .replace(/&#0*39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Not every timed text is a subtitle. Players expose internal bookkeeping as
  // `kind="metadata"` TextTracks (HLS discontinuity tags, ID3/EMSG payloads,
  // "chapter" markers) and some of them stringify an object into cue text. Such
  // a cue was read as dialogue and painted on screen - the visible symptom was
  // a giant JSON blob instead of a sentence:
  //   {"metadataType":"discontinuity","tag":"DISCONTINUITY",...}
  // The check is deliberately conservative: it only rejects text that cannot be
  // spoken dialogue, so ordinary lines (including ones made mostly of numbers,
  // names or punctuation) still pass.
  const NON_DIALOGUE_KEYS = /"(?:metadataType|discontinuitySequence|cueType|PTS|tag|payload|segment)"\s*:/i;
  const LETTER_RE = /[A-Za-zÀ-ÖØ-öø-ÿĀ-žĞÜŞİÖÇğüşıöç]/g;

  function looksLikeDialogue(value) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (text.length < 2) {
      return false;
    }

    // A JSON object/array printed as a subtitle line. A bracketed sound
    // description ("[sighs] ...") is legitimate dialogue, so the bracket form is
    // only rejected when the text actually parses as JSON.
    if (/^[[{]/.test(text)) {
      try {
        JSON.parse(text);
        return false;
      } catch (error) {
        // Not JSON; keep checking as ordinary text.
      }
    }
    if (NON_DIALOGUE_KEYS.test(text) && /[{}"]/.test(text)) {
      return false;
    }
    // HLS playlist tags and player telemetry.
    if (/^#EXT/.test(text) || /^\[?(?:ADS?|AD-|SCTE|EMSG|ID3)\b/i.test(text)) {
      return false;
    }
    if (/^(?:data|blob):/.test(text)) {
      return false;
    }
    // A "key=value key=value" dump (player telemetry), not speech.
    const assignments = (text.match(/(?:^|\s)[A-Za-z][\w.-]*=/g) || []).length;
    if (assignments >= 2) {
      return false;
    }

    const letters = (text.match(LETTER_RE) || []).length;
    if (letters < 2) {
      return false;
    }
    // A real sentence is mostly letters, spaces and punctuation. A serialized
    // object or a key=value dump is mostly structural characters.
    return letters / text.length >= 0.35;
  }

  function filterDialogue(cues) {
    if (!Array.isArray(cues)) {
      return [];
    }
    return cues.filter((cue) => cue && looksLikeDialogue(cue.text));
  }

  function parseBlocks(text, skipPrefixes) {
    const cues = [];
    const blocks = normalizeNewlines(stripBom(String(text))).split(/\n{2,}/);

    for (const block of blocks) {
      const lines = block
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      if (!lines.length) {
        continue;
      }

      const first = lines[0].toUpperCase();
      if (skipPrefixes.some((prefix) => first.startsWith(prefix))) {
        continue;
      }

      const timingIndex = lines.findIndex((line) => line.includes('-->'));
      if (timingIndex === -1) {
        continue;
      }

      const [rawStart, rawEnd] = lines[timingIndex].split('-->');
      const start = parseTimestamp(rawStart || '');
      // The end side may carry VTT cue settings ("align:start position:10%").
      const end = parseTimestamp(((rawEnd || '').trim().split(/\s+/)[0]) || '');

      if (start === null || end === null || end <= start) {
        continue;
      }

      const cueText = cleanCueText(lines.slice(timingIndex + 1).join(' '));
      if (!cueText) {
        continue;
      }

      cues.push({ start, end, text: cueText });
    }

    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    return cues;
  }

  function parseSRT(text) {
    return parseBlocks(text, []);
  }

  function parseVTT(text) {
    return parseBlocks(text, VTT_BLOCK_PREFIXES);
  }

  // YouTube's timedtext endpoint answers in formats the VTT/SRT parsers do not
  // read. The player itself uses `json3` (one event per word for auto captions)
  // and `srv3` (an XML transcript). A harvested second-language track may come
  // back in either, and the player's own caption fetch is sniffed too, so both
  // are parsed here.
  //
  // json3 events are word-sized. Grouping them into sentences keeps the
  // overlay from stuttering one word at a time; the shared sentence builder is
  // used when it is loaded (it always is in the content script).
  function groupSentences(cues) {
    if (DS.sentenceBuilder) {
      return DS.sentenceBuilder.group(cues, { maxWords: 20 });
    }
    return cues;
  }

  function parseJSON3(text) {
    let data = null;
    try {
      data = JSON.parse(stripBom(String(text)));
    } catch (error) {
      return [];
    }

    const events = data && Array.isArray(data.events) ? data.events : [];
    const cues = [];

    for (const event of events) {
      if (!event || !Array.isArray(event.segs)) {
        continue;
      }

      const raw = event.segs
        .map((seg) => String((seg && seg.utf8) == null ? '' : seg.utf8))
        .join('')
        .replace(/\n+/g, ' ');
      const cueText = cleanCueText(raw);
      if (!cueText) {
        continue;
      }

      const start = Number(event.tStartMs) / 1000;
      const duration = Number(event.dDurationMs) / 1000;
      if (!Number.isFinite(start) || start < 0) {
        continue;
      }

      cues.push({
        start: start,
        end: start + (Number.isFinite(duration) && duration > 0 ? duration : 0.001),
        text: cueText
      });
    }

    cues.sort((left, right) => left.start - right.start);
    return groupSentences(cues);
  }

  function parseSRV3(text) {
    const source = normalizeNewlines(stripBom(String(text)));
    const cues = [];
    const pattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let match = pattern.exec(source);

    while (match) {
      const attrs = match[1] || '';
      const startMatch = /\bstart\s*=\s*"([^"]+)"/i.exec(attrs);
      const durMatch = /\bdur\s*=\s*"([^"]+)"/i.exec(attrs);
      const start = startMatch ? Number(startMatch[1]) : NaN;
      const duration = durMatch ? Number(durMatch[1]) : 0;
      const cueText = cleanCueText(match[2]);

      if (Number.isFinite(start) && start >= 0 && cueText) {
        cues.push({
          start: start,
          end: start + (Number.isFinite(duration) && duration > 0 ? duration : 0.001),
          text: cueText
        });
      }

      match = pattern.exec(source);
    }

    cues.sort((left, right) => left.start - right.start);
    return groupSentences(cues);
  }

  function detectFormat(text, url) {
    const source = normalizeNewlines(stripBom(String(text)));
    const head = source.slice(0, 400);

    if (/^\s*\{/.test(head) && /"?events"?\s*:/i.test(head) &&
      /"(?:tStartMs|dDurationMs|segs)"\s*:/.test(head)) {
      return 'json3';
    }

    if (/<transcript[\s>]/i.test(head)) {
      return 'srv3';
    }

    if (head.slice(0, 200).toUpperCase().includes('WEBVTT')) {
      return 'vtt';
    }

    if (/\.VTT(?:[?#]|$)/.test(String(url || '').toUpperCase())) {
      return 'vtt';
    }

    return 'srt';
  }

  function parse(text, url) {
    const format = detectFormat(text, url);
    if (format === 'json3') {
      return parseJSON3(text);
    }
    if (format === 'srv3') {
      return parseSRV3(text);
    }
    return format === 'vtt' ? parseVTT(text) : parseSRT(text);
  }

  DS.parsers = {
    parse: parse,
    parseSRT: parseSRT,
    parseVTT: parseVTT,
    parseJSON3: parseJSON3,
    parseSRV3: parseSRV3,
    detectFormat: detectFormat,
    parseTimestamp: parseTimestamp,
    cleanCueText: cleanCueText,
    looksLikeDialogue: looksLikeDialogue,
    filterDialogue: filterDialogue
  };
})(typeof self !== 'undefined' ? self : this);
