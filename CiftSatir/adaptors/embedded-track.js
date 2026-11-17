(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});
  const { EN, TR } = DS.constants;

  // Some players do not expose subtitles as `subtitles`/`captions` tracks.
  // DPlayer and ArtPlayer inject their subtitle <track> as `kind="metadata"`,
  // let the browser parse it into a TextTrack, and paint their own caption layer
  // from that cue list. The text is real and complete; only the `kind` is
  // unusual. Reading it is the difference between "this player is unsupported"
  // and working subtitles on a large family of sites.
  //
  // This adaptor deliberately stays below generic-track in priority and only
  // matches when no normal subtitle track exists, so genuine metadata tracks on
  // a page that also has real subtitles are never mistaken for dialogue.

  function subtitleTracks(video) {
    if (!video || !video.textTracks) {
      return [];
    }
    return Array.from(video.textTracks).filter((track) =>
      track && (track.kind === 'subtitles' || track.kind === 'captions'));
  }

  function metaTracks(video) {
    if (!video || !video.textTracks) {
      return [];
    }
    return Array.from(video.textTracks).filter((track) => track && track.kind === 'metadata');
  }

  function cuesOf(track) {
    const cues = [];
    if (!track || !track.cues) {
      return cues;
    }
    for (let i = 0; i < track.cues.length; i += 1) {
      const cue = track.cues[i];
      if (!cue) {
        continue;
      }
      const text = String(cue.text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!text) {
        continue;
      }
      cues.push({ start: Number(cue.startTime), end: Number(cue.endTime), text: text });
    }
    return cues;
  }

  function classify(cues, track) {
    const sample = cues.slice(0, 6).map((cue) => cue.text).join(' ');
    const verdict = DS.langDetect.classify('', sample);
    if (verdict.confidence === 'foreign') {
      return null;
    }
    if (verdict.lang === 'tr') {
      return TR;
    }
    // A metadata track carrying dialogue is far more likely to be the player's
    // only subtitle track than an unrelated timed-metadata feed; put it in the
    // English channel when the words alone cannot decide.
    return EN;
  }

  function matches(video) {
    return metaTracks(video).length > 0 && subtitleTracks(video).length === 0;
  }

  async function attach(video, ctx) {
    const tracks = metaTracks(video);
    const listeners = [];
    const result = { en: null, tr: null };

    function read(track) {
      // A metadata track is not necessarily subtitles: players also put HLS
      // tags, ID3/EMSG payloads and chapter markers there. Those cues can be a
      // serialized object, which used to be painted as a subtitle line over the
      // film. Only keep text that can be spoken dialogue.
      const cues = DS.parsers.filterDialogue(cuesOf(track));
      if (!cues.length) {
        return false;
      }
      const kind = classify(cues, track);
      if (!kind) {
        return false;
      }

      const previous = result[kind];
      if (previous && previous.cues.length === cues.length) {
        return false;
      }

      result[kind] = {
        language: track.language,
        label: track.label,
        cues: cues
      };
      ctx.emit('cues', { kind: kind, cues: cues, source: 'embedded-track' });
      return true;
    }

    let emitted = false;

    for (const track of tracks) {
      // Metadata tracks are not rendered by the browser, but a player may have
      // left the mode on `showing`; hidden keeps every browser quiet.
      try {
        track.mode = 'hidden';
      } catch (error) {
        // Read-only tracks still expose their cues.
      }

      emitted = read(track) || emitted;

      if (!DS.parsers.filterDialogue(cuesOf(track)).length) {
        // The cue list is filled asynchronously right after the track is added.
        await new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) {
              return;
            }
            done = true;
            track.removeEventListener('load', finish);
            resolve();
          };
          track.addEventListener('load', finish);
          setTimeout(finish, 1500);
        });
        emitted = read(track) || emitted;
      }

      const onChange = () => {
        emitted = read(track) || emitted;
      };
      track.addEventListener('cuechange', onChange);
      listeners.push(() => track.removeEventListener('cuechange', onChange));

      let lastLength = track.cues ? track.cues.length : 0;
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

    return {
      en: result[EN] || null,
      tr: result[TR] || null,
      // If the metadata tracks held no dialogue at all, this adaptor must step
      // aside instead of holding the video: a `live` result would stop the
      // registry from trying the DOM/network readers on players whose captions
      // live elsewhere. A newly added metadata track that is still empty does
      // keep it live, so a genuinely late dialogue track is not missed.
      live: !emitted && tracks.some((track) => !cuesOf(track).length),
      detach: () => listeners.forEach((off) => off())
    };
  }

  DS.adaptorRegistry.register({
    id: 'embedded-track',
    priority: 30,
    matches: matches,
    attach: attach,
    detach: () => {}
  });

  DS.adaptors = DS.adaptors || {};
  DS.adaptors.embeddedTrack = {
    metaTracks: metaTracks,
    subtitleTracks: subtitleTracks,
    cuesOf: cuesOf
  };
})(typeof self !== 'undefined' ? self : this);
