(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});
  const { EN, TR } = DS.constants;

  // Last-resort adaptor for players that fetch their subtitle by some channel
  // the network layer cannot see (WebSocket, an API that returns JSON, a
  // service worker cache) and then paint the current line into their own DOM.
  // Nothing better exists on such a page: only the line that is on screen right
  // now can be read. That is still enough for dual subtitles and for tapping a
  // word, and it is exactly how the YouTube path already works.
  //
  // It is deliberately the lowest-priority adaptor: real text tracks and
  // network-captured files are complete and correctly timed, so they win. While
  // another source owns the English channel this adaptor stops itself, which
  // keeps a late network capture from being overwritten by a less precise DOM
  // line.
  const SELECTORS = [
    '.jw-text-track-display',
    '.vjs-text-track-display',
    '.plyr__captions',
    '.dplayer-subtitle',
    '.art-subtitle',
    '.shaka-text-container'
  ];

  function findContainer(video) {
    if (!video) {
      return null;
    }

    // Scoped to the video's own player wrapper first, so a page with several
    // players cannot read another player's captions. The ancestors are walked
    // because every library puts the caption box at a different depth.
    let node = video.parentElement;
    for (let depth = 0; node && depth < 6; depth += 1) {
      for (const selector of SELECTORS) {
        const el = node.querySelector(selector);
        if (el) {
          return el;
        }
      }
      node = node.parentElement;
    }

    // A single video on the page has no ambiguity even if the caption box sits
    // outside the wrapper (some players portal it to <body>).
    if (global.document.querySelectorAll('video').length === 1) {
      for (const selector of SELECTORS) {
        const el = global.document.querySelector(selector);
        if (el) {
          return el;
        }
      }
    }

    return null;
  }

  function textOf(container) {
    if (!container) {
      return '';
    }
    // textContent rather than innerText: the caption box is hidden by our own
    // CSS once our lines are visible, and innerText reports nothing for hidden
    // nodes in some builds. The box only ever contains the current line, so
    // there is no stale text to worry about.
    return String(container.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function matches(video) {
    return Boolean(findContainer(video));
  }

  function attach(video, ctx) {
    const container = findContainer(video);
    if (!container) {
      return { en: null, tr: null };
    }

    let timer = 0;
    let lastText = '';
    let lastKind = null;
    let stopped = false;

    const publish = (kind, text) => {
      const now = Number(video.currentTime) || 0;
      ctx.emit('cues', {
        kind: kind,
        cues: [{ start: Math.max(0, now - 0.3), end: now + 3600, text: text }],
        source: 'dom-caption',
        confidence: 'live'
      });
    };

    const clear = (kind) => {
      ctx.emit('cues', { kind: kind, cues: [], source: 'dom-caption' });
    };

    const tick = () => {
      if (stopped) {
        return;
      }

      // A track or a captured file arrived after this adaptor attached. Its
      // data is complete and correctly timed; step aside instead of competing.
      const source = ctx.cueSource ? ctx.cueSource(EN) : '';
      if (source && source !== 'dom-caption') {
        stopped = true;
        global.clearInterval(timer);
        timer = 0;
        return;
      }

      const text = textOf(container);

      if (!text) {
        if (lastText) {
          lastText = '';
          if (lastKind) {
            clear(lastKind);
          }
        }
        return;
      }

      if (text === lastText) {
        return;
      }

      lastText = text;

      const verdict = DS.langDetect.classify('', text);
      const kind = verdict.lang === 'tr' || verdict.confidence === 'foreign' ? TR : EN;

      if (lastKind && lastKind !== kind) {
        clear(lastKind);
      }
      lastKind = kind;

      publish(kind, text);
    };

    timer = global.setInterval(tick, 250);
    // The player may already have a line on screen when the adaptor attaches.
    tick();

    return {
      en: null,
      tr: null,
      live: true,
      detach: () => {
        stopped = true;
        if (timer) {
          global.clearInterval(timer);
          timer = 0;
        }
      }
    };
  }

  DS.adaptorRegistry.register({
    id: 'dom-caption',
    priority: 20,
    matches: matches,
    attach: attach,
    detach: () => {}
  });

  DS.adaptors = DS.adaptors || {};
  DS.adaptors.domCaption = {
    SELECTORS: SELECTORS.slice(),
    findContainer: findContainer,
    textOf: textOf
  };
})(typeof self !== 'undefined' ? self : this);
