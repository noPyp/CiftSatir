(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});
  const { EN, TR } = DS.constants;

  function tracksOf(video) {
    if (!video || !video.textTracks) {
      return [];
    }

    return Array.from(video.textTracks).filter((track) => track && (track.kind === 'subtitles' || track.kind === 'captions'));
  }

  // Picks the English and Turkish channels out of the <video>'s text tracks.
  //
  // A track's own srclang is authored metadata about that exact track, so it is
  // checked first and taken at its word. That matters because many players ship
  // a French or Spanish track with an empty srclang, and such a track used to be
  // mistaken for English.
  //
  // Returns the channel, or null when the track is confidently another language.
  // A track that merely cannot be identified is returned as a guess by the
  // caller - see attach() - rather than discarded, since refusing unclear
  // tracks left the user with a single subtitle line or none.
  function classify(track) {
    const lang = String(track.language || '').trim().toLowerCase();
    const label = String(track.label || '').trim();

    if (lang) {
      const short = lang.split('-')[0];
      if (['en', 'eng', 'english'].includes(short)) {
        return EN;
      }
      if (['tr', 'tur', 'turkish', 'turkce', 'türkçe'].includes(short) || lang === 'türkçe') {
        return TR;
      }
    }

    // srclang and label are both just names, so the shared classifier can read
    // either as if it were a file name.
    for (const name of [lang, label]) {
      if (!name) {
        continue;
      }
      const verdict = DS.langDetect.classify(name, '');
      if (verdict.confidence === 'certain' && verdict.lang) {
        return verdict.lang === 'en' ? EN : TR;
      }
      if (verdict.confidence === 'foreign') {
        return null;
      }
    }

    // Nothing declared that we can use, so read the words.
    const cues = cuesFromTrack(track);
    const sample = cues.slice(0, 6).map((cue) => cue.text || '').join(' ');
    const verdict = DS.langDetect.classify('', sample);

    if (verdict.confidence === 'foreign') {
      return null;
    }

    return verdict.lang ? (verdict.lang === 'en' ? EN : TR) : null;
  }

  function cuesFromTrack(track) {
    if (!track || !track.cues) {
      return [];
    }

    const cues = [];
    for (let i = 0; i < track.cues.length; i += 1) {
      const cue = track.cues[i];
      if (!cue) {
        continue;
      }
      cues.push({ start: Number(cue.startTime), end: Number(cue.endTime), text: String(cue.text || '') });
    }

    return cues;
  }

  function matches(video) {
    return tracksOf(video).length > 0;
  }

  // Reads the cues once up front. Cue lists on subtitle tracks are complete
  // after metadata loads, so polling `activeCues` per frame is unnecessary;
  // the store answers time queries instead.
  async function attach(video, ctx) {
    const tracks = tracksOf(video);
    const result = { en: null, tr: null };
    const listeners = [];
    // Tracks whose language could not be established. Held back rather than
    // dropped: if nothing identifiable turns up they are used to fill the empty
    // channels, which is far better than showing nothing. A track that is
    // already claimed by an identified language is never displaced by one.
    const unidentified = [];

    for (const track of tracks) {
      let kind = classify(track);

      let cues = cuesFromTrack(track);

      // Some players populate cues lazily; force loading and retry once. This
      // has to happen before an unidentified track can be judged on its words.
      if (!cues.length) {
        try {
          track.mode = 'hidden';
          await new Promise((resolve) => {
            const onLoad = () => {
              track.removeEventListener('load', onLoad);
              resolve();
            };
            track.addEventListener('load', onLoad);
            setTimeout(onLoad, 1500);
          });
          cues = cuesFromTrack(track);
        } catch (error) {
          cues = [];
        }
      }

      if (!cues.length) {
        continue;
      }

      // Cues are available now, so a track that had nothing to go on can be
      // re-judged on its text.
      if (!kind) {
        const verdict = DS.langDetect.classify(
          '',
          cues.slice(0, 6).map((cue) => cue.text || '').join(' ')
        );
        if (verdict.confidence === 'foreign') {
          continue;
        }
        if (verdict.lang) {
          kind = verdict.lang === 'en' ? EN : TR;
        }
      }

      if (!kind) {
        unidentified.push({ track: track, cues: cues });
        continue;
      }

      if (result[kind]) {
        continue;
      }

      result[kind] = {
        language: track.language,
        label: track.label,
        cues: cues
      };

      ctx.emit('cues', { kind: kind, cues: cues, source: 'generic-track' });

      // Hide the site's own rendering so ours isn't doubled up.
      if (ctx.getSetting('hideNativeSubtitles') !== false) {
        try {
          track.mode = 'hidden';
        } catch (error) {
          // Read-only tracks are fine; the site keeps rendering its own.
        }
      }

      const onChange = () => {
        const refreshed = cuesFromTrack(track);
        if (refreshed.length && refreshed.length !== cues.length) {
          cues = refreshed;
          ctx.emit('cues', { kind: kind, cues: refreshed, source: 'generic-track' });
        }
      };

      track.addEventListener('cuechange', onChange);
      listeners.push(() => track.removeEventListener('cuechange', onChange));

      // `cuechange` only fires when the *active* cue set changes, so a player
      // that appends cues ahead of playback (HLS, live streams, segmented SRT)
      // can leave the store with an incomplete list until playback reaches the
      // new lines. A length check on timeupdate is O(1) and catches that.
      let lastLength = cues.length;
      const onTime = () => {
        const length = track.cues ? track.cues.length : 0;
        if (length === lastLength) {
          return;
        }
        lastLength = length;
        onChange();
      };
      ctx.video.addEventListener('timeupdate', onTime);
      listeners.push(() => ctx.video.removeEventListener('timeupdate', onTime));
    }

    // Fill any channel still empty with an unidentified track. Order matters: a
    // site normally lists its default track first, and the Turkish track is
    // usually the one marked default on these sites, so an unidentified track
    // goes to whichever channel is actually missing rather than to a fixed one.
    for (const candidate of unidentified) {
      let kind = null;
      if (!result[EN]) {
        kind = EN;
      } else if (!result[TR]) {
        kind = TR;
      } else {
        break;
      }

      result[kind] = {
        language: candidate.track.language,
        label: candidate.track.label,
        cues: candidate.cues
      };

      ctx.emit('cues', { kind: kind, cues: candidate.cues, source: 'generic-track-unidentified' });
    }

    return {
      en: result[EN],
      tr: result[TR],
      detach: () => listeners.forEach((off) => off())
    };
  }

  DS.adaptorRegistry.register({
    id: 'generic-track',
    priority: 40,
    matches: matches,
    attach: attach,
    detach: () => {}
  });

  DS.adaptors = DS.adaptors || {};
  DS.adaptors.genericTrack = {
    classify: classify,
    tracksOf: tracksOf,
    cuesFromTrack: cuesFromTrack
  };
})(typeof self !== 'undefined' ? self : this);
