(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});

  const adaptors = [];

  // An adaptor:
  //   { id, priority,
  //     matches(video, ctx) -> boolean,
  //     attach(video, ctx) -> { en: CueTrack|null, tr: CueTrack|null },
  //     detach() }
  function register(adaptor) {
    if (!adaptor || !adaptor.id || typeof adaptor.matches !== 'function') {
      return;
    }

    if (adaptors.some((existing) => existing.id === adaptor.id)) {
      return;
    }

    adaptors.push(adaptor);
    adaptors.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  function candidates(video, ctx) {
    return adaptors.filter((adaptor) => {
      try {
        return adaptor.matches(video, ctx);
      } catch (error) {
        return false;
      }
    });
  }

  // An adaptor's attach() resolves to { en, tr } where each side is either null
  // or a track object carrying its cues.
  function trackHasCues(track) {
    return Boolean(track && Array.isArray(track.cues) && track.cues.length);
  }

  // Tries every matching adaptor in priority order, stopping at the first one
  // that returns any cues at all. A site-specific adaptor and the generic
  // <track> reader can both match; whichever yields subtitles wins.
  async function attachBest(video, ctx) {
    const ordered = candidates(video, ctx);

    for (const adaptor of ordered) {
      try {
        const result = await adaptor.attach(video, ctx);
        // `live` adaptors (Netflix renders its subtitles to the DOM instead of
        // exposing tracks) cannot produce cues at attach time; they keep
        // observing and emit later. Every other adaptor must show something now
        // or it is skipped in favour of the next one.
        const accepted = (result && result.live === true) ||
          trackHasCues(result && result.en) ||
          trackHasCues(result && result.tr);

        if (accepted) {
          return {
            adaptorId: adaptor.id,
            detach: () => {
              try {
                adaptor.detach();
              } catch (error) {
                // A failing teardown must not block switching adaptors.
              }
              if (result && typeof result.detach === 'function') {
                try {
                  result.detach();
                } catch (error) {
                  // Best-effort.
                }
              }
            }
          };
        }

        if (result && typeof result.detach === 'function') {
          result.detach();
        }
      } catch (error) {
        // Adaptors are best-effort; a broken one falls through to the next.
      }
    }

    return null;
  }

  function list() {
    return adaptors.slice();
  }

  DS.adaptorRegistry = {
    register: register,
    attachBest: attachBest,
    candidates: candidates,
    trackHasCues: trackHasCues,
    list: list
  };
})(typeof self !== 'undefined' ? self : this);
