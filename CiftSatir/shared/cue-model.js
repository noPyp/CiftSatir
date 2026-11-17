(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});
  const { MIN_CUE_DURATION } = DS.constants;

  let nextCueId = 1;

  function normalizeCue(raw) {
    const start = Number(raw.start);
    const end = Number(raw.end);
    const text = String(raw.text == null ? '' : raw.text).trim();

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) {
      return null;
    }

    return {
      id: nextCueId++,
      start: start,
      end: Math.max(end, start + MIN_CUE_DURATION),
      text: text,
      words: Array.isArray(raw.words) ? raw.words : null
    };
  }

  function normalizeCues(rawCues) {
    if (!Array.isArray(rawCues)) {
      return [];
    }

    const cues = [];
    for (const raw of rawCues) {
      const cue = normalizeCue(raw);
      if (cue) {
        cues.push(cue);
      }
    }

    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    return cues;
  }

  // Binary search for the cue covering `time`. Called on every timeupdate
  // (~4x/sec) against tracks that can hold >1500 cues, so a linear scan is
  // worth avoiding.
  function findIndexAt(cues, time) {
    let low = 0;
    let high = cues.length - 1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      const cue = cues[mid];

      if (time < cue.start) {
        high = mid - 1;
      } else if (time >= cue.end) {
        low = mid + 1;
      } else {
        return mid;
      }
    }

    return -1;
  }

  // Holds the two subtitle channels for one video and answers "what is showing
  // at time T" for each of them.
  class CueStore {
    constructor() {
      this.channels = { en: [], tr: [] };
      this.meta = { en: null, tr: null };
    }

    set(kind, rawCues, meta) {
      if (kind !== 'en' && kind !== 'tr') {
        return;
      }

      this.channels[kind] = normalizeCues(rawCues);
      this.meta[kind] = meta || null;
    }

    get(kind) {
      return this.channels[kind] || [];
    }

    metaFor(kind) {
      return this.meta[kind] || null;
    }

    has(kind) {
      return this.get(kind).length > 0;
    }

    isEmpty() {
      return !this.has('en') && !this.has('tr');
    }

    at(kind, time) {
      const cues = this.get(kind);
      const index = findIndexAt(cues, time);
      return index === -1 ? null : cues[index];
    }

    // Offset all cues in a channel, used by the [ / ] sync nudge.
    shift(kind, deltaSeconds) {
      const cues = this.get(kind);
      for (const cue of cues) {
        cue.start += deltaSeconds;
        cue.end += deltaSeconds;
      }
    }

    clear() {
      this.channels = { en: [], tr: [] };
      this.meta = { en: null, tr: null };
    }
  }

  DS.CueStore = CueStore;
  DS.cueModel = {
    CueStore: CueStore,
    normalizeCues: normalizeCues,
    findIndexAt: findIndexAt
  };
})(typeof self !== 'undefined' ? self : this);
