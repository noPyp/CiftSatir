(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});
  const { EN, TR } = DS.constants;

  // Netflix does not publish its subtitles as TextTracks in most browsers: the
  // player paints the current line into the DOM. There is no complete cue list
  // to read up front, so this adaptor captures the line as it appears and
  // builds cues from wall-clock playback time.
  //
  // Consequences that are deliberately not hidden:
  //   - only lines that have actually played are available; seeking backwards
  //     over a scene you have not watched yet shows nothing
  //   - bitmap subtitles (an <img> instead of text) cannot be read at all
  //   - when the user selected Turkish on Netflix, the captured line is Turkish
  //     and there is no English line to click
  //
  // When the browser *does* expose real tracks, this adaptor steps aside and
  // lets the generic reader handle them.

  const HOSTS = /(^|\.)netflix\.com$/;
  const MIN_CUE_DURATION = 0.4;
  const POLL_MS = 200;
  const LOOK_AHEAD = 2.5;

  function isNetflix() {
    try {
      return HOSTS.test(String(global.location && global.location.hostname || ''));
    } catch (error) {
      return false;
    }
  }

  // Netflix wraps the rendered line (or several lines) in one of these. The
  // class name has changed over the years, so several are tried and the first
  // one with readable text wins. An image-based subtitle yields no text, which
  // is reported as "nothing captured" rather than invented.
  const CONTAINER_SELECTORS = [
    '.player-timedtext',
    '[data-uia="player-subtitle"]',
    '.player-timedtext-text-container'
  ];

  function subtitleText(doc) {
    const documentRef = doc || global.document;
    if (!documentRef || typeof documentRef.querySelector !== 'function') {
      return '';
    }

    for (const selector of CONTAINER_SELECTORS) {
      const element = documentRef.querySelector(selector);
      if (!element) {
        continue;
      }
      const text = String(element.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) {
        return text;
      }
    }

    return '';
  }

  function hasReadableTracks(video) {
    if (!video || !video.textTracks) {
      return false;
    }
    return Array.from(video.textTracks).some((track) =>
      track && (track.kind === 'subtitles' || track.kind === 'captions'));
  }

  // Pure capture state machine, exported for test/adaptor-check.js.
  //
  // options: { now() -> seconds, read() -> string, emit({kind, cues, source}) }
  function createCapture(options) {
    const opts = options || {};
    const now = () => Number(opts.now ? opts.now() : 0) || 0;
    const read = () => String(opts.read ? opts.read() : '').replace(/\s+/g, ' ').trim();
    const emit = typeof opts.emit === 'function' ? opts.emit : function () {};

    const closed = { en: [], tr: [] };
    const state = {
      open: '',
      openStart: 0,
      kind: null,
      lastEmitAt: -Infinity
    };

    function channel(kind) {
      const list = (closed[kind] || []).slice();
      if (state.open && state.kind === kind) {
        list.push({
          start: state.openStart,
          end: now() + LOOK_AHEAD,
          text: state.open
        });
      }
      return list;
    }

    function emitKind(kind) {
      if (!kind) {
        return;
      }
      state.lastEmitAt = now();
      emit({ kind: kind, cues: channel(kind), source: 'netflix-dom' });
    }

    // Foreign lines are dropped rather than filed under English. Each rendered
    // line is classified on its own: mixing it with the previous lines would let
    // an English sentence mask the Spanish one that followed it. A very short
    // line ("Hi!", "No!") has nothing to classify, so it stays in the channel
    // the previous line used.
    function kindFor(text) {
      const verdict = DS.langDetect.classify('', text);
      if (verdict.confidence === 'foreign') {
        return null;
      }

      if (verdict.lang) {
        return verdict.lang === 'tr' ? TR : EN;
      }

      return state.kind || EN;
    }

    function flush(at) {
      if (!state.open || !state.kind) {
        return;
      }

      const list = closed[state.kind];
      list.push({
        start: state.openStart,
        end: Math.max(at, state.openStart + MIN_CUE_DURATION),
        text: state.open
      });

      // A long film can produce thousands of lines; only the recent ones are
      // worth keeping, since seeking back that far is rare.
      if (list.length > 400) {
        list.splice(0, list.length - 400);
      }

      state.open = '';
      state.openStart = 0;
    }

    function tick() {
      const at = now();
      const text = read();

      if (!text) {
        if (state.open && at - state.openStart >= 0.25) {
          const kind = state.kind;
          flush(at);
          emitKind(kind);
        }
        return;
      }

      if (text === state.open) {
        // Keep the open cue's end ahead of the playhead while the line stays on
        // screen; otherwise a long line would vanish after LOOK_AHEAD seconds.
        if (state.open && at - state.lastEmitAt >= 1) {
          emitKind(state.kind);
        }
        return;
      }

      const previousKind = state.kind;
      if (state.open) {
        flush(at);
        emitKind(previousKind);
      }

      const kind = kindFor(text);
      if (!kind) {
        return;
      }

      state.kind = kind;
      state.open = text;
      state.openStart = at;
      emitKind(kind);
    }

    return {
      tick: tick,
      channel: channel,
      state: state
    };
  }

  function matches(video) {
    return isNetflix() && Boolean(video);
  }

  // Netflix keeps painting its own subtitle under ours, so the same sentence
  // appeared twice (most visibly with English selected on Netflix). Once a line
  // has actually been captured, Netflix's layer is made invisible with opacity:
  // the DOM keeps updating, so capture continues. It is never hidden before the
  // first capture, so an unreadable (bitmap) subtitle still shows Netflix's own.
  // Reference-counted for the same reason as on YouTube: two <video> elements
  // can be bound briefly while Netflix switches episodes.
  const NATIVE_HIDE_CLASS = 'dualsub-netflix-dom';
  let nativeHideCount = 0;

  function setNativeHideClass(on) {
    try {
      global.document.documentElement.classList.toggle(NATIVE_HIDE_CLASS, on);
    } catch (error) {
      // Cosmetic only.
    }
  }

  function acquireNativeHide() {
    nativeHideCount += 1;
    setNativeHideClass(true);
  }

  function releaseNativeHide() {
    nativeHideCount = Math.max(0, nativeHideCount - 1);
    if (nativeHideCount === 0) {
      setNativeHideClass(false);
    }
  }

  async function attach(video, ctx) {
    // The generic reader knows how to read real tracks; do not shadow it.
    if (hasReadableTracks(video)) {
      return null;
    }

    let hidden = false;
    const wantsHide = () => !ctx.getSetting || ctx.getSetting('hideNativeSubtitles') !== false;

    const capture = createCapture({
      now: () => Number(video.currentTime) || 0,
      read: () => subtitleText(global.document),
      emit: (payload) => {
        if (payload && payload.cues && payload.cues.length && !hidden && wantsHide()) {
          hidden = true;
          acquireNativeHide();
        }
        ctx.emit('cues', payload);
      }
    });

    const timer = setInterval(() => capture.tick(), POLL_MS);
    capture.tick();

    return {
      live: true,
      en: null,
      tr: null,
      detach: () => {
        clearInterval(timer);
        if (hidden) {
          hidden = false;
          releaseNativeHide();
        }
      }
    };
  }

  DS.adaptorRegistry.register({
    id: 'netflix',
    priority: 70,
    matches: matches,
    attach: attach,
    detach: () => {}
  });

  DS.adaptors = DS.adaptors || {};
  DS.adaptors.netflix = {
    isNetflix: isNetflix,
    subtitleText: subtitleText,
    hasReadableTracks: hasReadableTracks,
    createCapture: createCapture,
    NATIVE_HIDE_CLASS: NATIVE_HIDE_CLASS
  };
})(typeof self !== 'undefined' ? self : this);
