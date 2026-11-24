(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});
  const { LAYER_CLASS, LINE_CLASS, PANEL_CLASS, HIDDEN_CLASS, EN, TR } = DS.constants;

  // While our two lines are actually on screen, the player's own caption layer
  // must be hidden or the same sentence appears twice, one over the other. The
  // class is only applied to known player caption containers (see styles.css),
  // and only while a line is visible, so a player whose subtitle capture failed
  // still shows its own captions instead of nothing.
  const NATIVE_CAPTIONS_CLASS = 'dualsub-own-captions';

  function setNativeCaptionsHidden(hidden) {
    try {
      global.document.documentElement.classList.toggle(NATIVE_CAPTIONS_CLASS, Boolean(hidden));
    } catch (error) {
      // Cosmetic only.
    }
  }

  function hideOverlay(overlay) {
    if (!overlay) {
      return;
    }

    if (!overlay.classList.contains(HIDDEN_CLASS)) {
      overlay.classList.add(HIDDEN_CLASS);
    }

    setNativeCaptionsHidden(false);
    overlay.__dualsubSignature = '';
  }

  // Removes the rendered text as well as hiding the layer. Hiding alone left the
  // previous source's sentence in the DOM: when the next subtitle source had no
  // English channel (for example a Turkish-only track), the English line was
  // shown again unchanged because its signature was still the empty string.
  function clearOverlay(overlay) {
    if (!overlay) {
      return;
    }

    if (overlay.__dualsubEnglishLine) {
      overlay.__dualsubEnglishLine.textContent = '';
    }
    if (overlay.__dualsubTurkishLine) {
      overlay.__dualsubTurkishLine.textContent = '';
    }
    overlay.__dualsubSignature = '';
    overlay.__dualsubTurkishText = '';
    overlay.__dualsubWords = [];
    hideOverlay(overlay);
  }

  // Moves the overlay into whichever element is actually rendering in
  // fullscreen. On streaming sites the fullscreen request is made by the
  // player, so `fullscreenElement` is the player wrapper (which contains the
  // video), not the <video> itself. When the <video> really is the fullscreen
  // element, appending into it fails (it is a replaced element), so its parent
  // is used instead.
  function resolveOverlayHost(video) {
    const fullscreenRoot = document.fullscreenElement;

    if (!fullscreenRoot) {
      return document.documentElement;
    }

    if (fullscreenRoot === video) {
      return video.parentElement || document.documentElement;
    }

    if (fullscreenRoot.contains(video)) {
      return fullscreenRoot;
    }

    return document.documentElement;
  }

  function getVisibleVideoRect(video) {
    const rect = video.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(global.innerWidth, rect.right);
    const bottom = Math.min(global.innerHeight, rect.bottom);
    const width = right - left;
    const height = bottom - top;

    if (width <= 20 || height <= 20) {
      return null;
    }

    return { left, top, right, bottom, width, height };
  }

  function positionOverlay(overlay, video, forceMeasure, settings) {
    const target = resolveOverlayHost(video);

    if (overlay.parentElement !== target) {
      target.appendChild(overlay);
      forceMeasure = true;
    }

    const videoRect = getVisibleVideoRect(video);
    if (!videoRect) {
      return false;
    }

    const fontScale = Math.min(1.8, Math.max(0.6, (Number(settings && settings.fontSize) || 100) / 100));
    const baseFontSize = Math.max(10, Math.min(36, videoRect.width * 0.045, videoRect.height * 0.1));
    const fontSize = Math.max(10, Math.min(48, baseFontSize * fontScale));
    const controlSpace = Math.min(72, Math.max(24, videoRect.height * 0.2));

    // Vertical position: the subtitle block normally sits just above the player
    // controls; "middle" and "top" lift it further for videos whose controls
    // cover the bottom of the frame.
    const position = String((settings && settings.position) || 'bottom');
    const lift = position === 'middle'
      ? videoRect.height * 0.28
      : position === 'top' ? videoRect.height * 0.55 : 0;

    const layout = {
      target: target,
      left: videoRect.left + videoRect.width / 2,
      bottom: Math.max(12, global.innerHeight - videoRect.bottom + controlSpace + lift),
      width: Math.min(videoRect.width * 0.9, 720),
      fontSize: fontSize,
      top: videoRect.top,
      height: videoRect.height,
      viewportHeight: global.innerHeight
    };

    const previousLayout = overlay.__dualsubLayout;
    const layoutUnchanged = previousLayout &&
      Object.keys(layout).every((key) => layout[key] === previousLayout[key]) &&
      overlay.parentElement === target;

    if (layoutUnchanged && !forceMeasure) {
      return true;
    }

    overlay.style.setProperty('left', layout.left + 'px');
    overlay.style.setProperty('bottom', layout.bottom + 'px');
    overlay.style.setProperty('width', layout.width + 'px');
    overlay.style.setProperty('--dualsub-font-size', fontSize + 'px');

    const panel = overlay.__dualsubPanel;

    // The panel must follow the layer into the fullscreen element. In
    // fullscreen, only the fullscreen element's own subtree is rendered, so a
    // panel left behind in documentElement would simply disappear.
    if (panel && panel.el.parentElement !== target) {
      target.appendChild(panel.el);
    }

    // Measure only the layer. The panel is position:fixed and unrelated, but
    // hiding it during measurement keeps this loop from churning its layout on
    // every one of the ~26 iterations.
    const panelWasVisible = panel && !panel.el.classList.contains(HIDDEN_CLASS);
    if (panelWasVisible) {
      panel.el.style.visibility = 'hidden';
    }

    let fittedFontSize = fontSize;
    let overlayRect = overlay.getBoundingClientRect();
    let iterations = 0;

    while (
      fittedFontSize > 10 &&
      iterations < 26 &&
      (overlayRect.top < videoRect.top + 4 ||
        overlayRect.left < videoRect.left + 4 ||
        overlayRect.right > videoRect.right - 4)
    ) {
      fittedFontSize = Math.max(10, fittedFontSize - 1);
      overlay.style.setProperty('--dualsub-font-size', fittedFontSize + 'px');
      overlayRect = overlay.getBoundingClientRect();
      iterations += 1;
    }

    // If the block still does not sit where it belongs, move it instead of
    // hiding it. Embedded players are often ~150px tall, and the old code hid
    // the whole layer whenever the two lines did not clear the (guessed)
    // control area. A subtitle that overlaps the controls is readable; a
    // subtitle that disappears looks like a broken extension.
    const viewportHeight = global.innerHeight;
    const upper = viewportHeight - videoRect.top - 4 - overlayRect.height;
    const lowerWithControls = viewportHeight - videoRect.bottom + controlSpace - 1;
    const lowerInside = viewportHeight - videoRect.bottom + 4;
    const lower = lowerWithControls > upper ? lowerInside : lowerWithControls;

    let placedBottom = layout.bottom;
    if (placedBottom < lower) {
      placedBottom = lower;
    }
    if (placedBottom > upper && upper > 0) {
      placedBottom = Math.max(lower, upper);
    }

    if (placedBottom !== layout.bottom) {
      layout.bottom = placedBottom;
      overlay.style.setProperty('bottom', placedBottom + 'px');
      overlayRect = overlay.getBoundingClientRect();
    }

    if (panelWasVisible) {
      panel.el.style.visibility = '';
      panel.position(overlayRect);
    }

    overlay.__dualsubLayout = layout;
    return true;
  }

  // ---- Appearance (user customisation from the popup) ----------------------
  // Colours and the background bar are CSS variables on the layer, so a change
  // costs one style write and never rebuilds the word spans.
  const HEX = /^#[0-9a-f]{6}$/i;

  function hexToRgba(hex, alpha) {
    const value = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((value >> 16) & 255) + ', ' + ((value >> 8) & 255) + ', ' +
      (value & 255) + ', ' + alpha + ')';
  }

  function colorOr(value, fallback) {
    return HEX.test(String(value || '')) ? String(value) : fallback;
  }

  function appearanceVars(settings) {
    const s = settings || {};
    const en = colorOr(s.enColor, '#f8fbff');
    const tr = colorOr(s.trColor, '#dff7e6');
    const hover = colorOr(s.hoverColor, '#38bdf8');
    const bgOn = s.bgOn !== false;
    const opacity = Math.min(100, Math.max(0, Number.isFinite(Number(s.bgOpacity)) ? Number(s.bgOpacity) : 58));
    const outline = s.outline !== false;

    // Without the bar the text sits directly on the picture, so the shadow
    // becomes a full outline to stay readable on bright scenes.
    let shadow = 'none';
    if (outline) {
      shadow = bgOn
        ? '0 2px 4px rgba(0, 0, 0, 0.8)'
        : '0 0 2px #000, 0 0 2px #000, 0 0 3px #000, 1px 1px 2px #000';
    }

    return {
      '--dualsub-en-color': en,
      '--dualsub-tr-color': tr,
      '--dualsub-hover': hexToRgba(hover, 0.38),
      '--dualsub-hover-strong': hexToRgba(hover, 0.62),
      '--dualsub-bg': bgOn ? 'rgba(0, 0, 0, ' + (opacity / 100) + ')' : 'transparent',
      '--dualsub-shadow': shadow
    };
  }

  function applyAppearance(overlay, settings) {
    const vars = appearanceVars(settings);
    const signature = JSON.stringify(vars);
    if (overlay.__dualsubAppearance === signature) {
      return;
    }
    overlay.__dualsubAppearance = signature;
    for (const name of Object.keys(vars)) {
      overlay.style.setProperty(name, vars[name]);
    }
  }

  function renderEnglish(lineEl, cue) {
    const { fragment, words } = DS.words.buildWordSpans(cue.text);
    lineEl.textContent = '';
    lineEl.appendChild(fragment);
    return words;
  }

  function renderTurkish(lineEl, text) {
    lineEl.textContent = text || '';
  }

  function createOverlay() {
    const overlay = document.createElement('div');
    overlay.className = LAYER_CLASS + ' ' + HIDDEN_CLASS;

    const englishLine = document.createElement('div');
    englishLine.className = LINE_CLASS + ' ' + EN;
    englishLine.setAttribute('aria-live', 'polite');

    const turkishLine = document.createElement('div');
    turkishLine.className = LINE_CLASS + ' ' + TR;
    turkishLine.setAttribute('aria-live', 'polite');

    overlay.appendChild(englishLine);
    overlay.appendChild(turkishLine);

    overlay.__dualsubEnglishLine = englishLine;
    overlay.__dualsubTurkishLine = turkishLine;
    overlay.__dualsubSignature = '';
    overlay.__dualsubWords = [];
    overlay.__dualsubOnWordClick = null;

    // One delegated listener per overlay rather than one per word span: the
    // English line is rebuilt whenever the cue changes, and per-span listeners
    // would have to be re-attached on every one of those rebuilds.
    englishLine.addEventListener('click', (event) => {
      const handler = overlay.__dualsubOnWordClick;
      if (!handler) {
        return;
      }

      const span = event.target instanceof Element
        ? event.target.closest('.' + DS.constants.WORD_CLASS)
        : null;
      if (!span || !englishLine.contains(span)) {
        return;
      }

      handler(event, span);
    });

    // Keyboard access for the word spans, which are focusable.
    englishLine.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      const handler = overlay.__dualsubOnWordClick;
      const span = event.target instanceof Element
        ? event.target.closest('.' + DS.constants.WORD_CLASS)
        : null;
      if (!handler || !span) {
        return;
      }

      event.preventDefault();
      handler(event, span);
    });

    return overlay;
  }

  function attachPanelToOverlay(overlay, handlers) {
    const panel = DS.panel.createPanel();
    panel.el.classList.add('is-hidden');
    // The panel is a sibling of the layer and positioned independently, so it
    // never participates in the layer's font-fitting measurement.
    overlay.__dualsubPanel = DS.panel.attachPanel(panel, handlers || {});
    return overlay.__dualsubPanel;
  }

  // Renders one frame. The expensive part (span building) runs only when the
  // cue identity actually changes; timeupdate fires ~4x/sec within a single cue.
  function updateOverlay(overlay, video, store, settings, onWordClick) {
    if (!overlay || !video || !store) {
      return;
    }

    const panel = overlay.__dualsubPanel;
    const enabled = !settings || settings.enabled !== false;

    if (!enabled) {
      hideOverlay(overlay);
      if (panel && panel.isOpen()) {
        panel.hide();
      }
      return;
    }

    const time = Number(video.currentTime) || 0;
    const enCue = store.has(EN) ? store.at(EN, time) : null;
    const trCue = store.has(TR) ? store.at(TR, time) : null;
    const enText = enCue ? enCue.text : '';
    const trText = trCue ? trCue.text : '';

    if (!enText && !trText) {
      hideOverlay(overlay);
      // An empty gap in the subtitles shouldn't close a panel the user is
      // reading, for the same reason a cue change doesn't.
      return;
    }

    const signature = DS.words.cueSignature(enCue);
    const cueChanged = signature !== overlay.__dualsubSignature;
    const wasHidden = overlay.classList.contains(HIDDEN_CLASS);

    overlay.__dualsubOnWordClick = onWordClick || null;
    applyAppearance(overlay, settings);

    if (cueChanged) {
      // Rebuilding the line would destroy the span the panel is anchored to, so
      // an open panel would lose its word. The panel is left open instead: the
      // user is reading a definition or a five-sentence list, and yanking it
      // away two seconds later would make the feature unusable. It closes on
      // Escape, the Kapat button, or a click on a different word.
      if (enCue && enText) {
        overlay.__dualsubWords = renderEnglish(overlay.__dualsubEnglishLine, enCue);
      } else {
        // Turkish-only source or a gap in English. Explicitly clear the old
        // sentence instead of leaving it under the new Turkish line.
        overlay.__dualsubEnglishLine.textContent = '';
        overlay.__dualsubWords = [];
      }
      overlay.__dualsubSignature = signature;
    }

    if (trText !== overlay.__dualsubTurkishText) {
      renderTurkish(overlay.__dualsubTurkishLine, trText);
      overlay.__dualsubTurkishText = trText;
    }

    if (settings && settings.englishOn === false) {
      overlay.__dualsubEnglishLine.classList.add(HIDDEN_CLASS);
    } else {
      overlay.__dualsubEnglishLine.classList.remove(HIDDEN_CLASS);
    }

    if (settings && settings.turkishOn === false) {
      overlay.__dualsubTurkishLine.classList.add(HIDDEN_CLASS);
    } else {
      overlay.__dualsubTurkishLine.classList.remove(HIDDEN_CLASS);
    }

    overlay.classList.remove(HIDDEN_CLASS);

    if (!positionOverlay(overlay, video, cueChanged || wasHidden, settings)) {
      hideOverlay(overlay);
      return;
    }

    setNativeCaptionsHidden(true);
  }

  DS.overlay = {
    createOverlay: createOverlay,
    updateOverlay: updateOverlay,
    hideOverlay: hideOverlay,
    clearOverlay: clearOverlay,
    positionOverlay: positionOverlay,
    resolveOverlayHost: resolveOverlayHost,
    getVisibleVideoRect: getVisibleVideoRect,
    attachPanelToOverlay: attachPanelToOverlay,
    appearanceVars: appearanceVars,
    applyAppearance: applyAppearance
  };
})(typeof self !== 'undefined' ? self : this);
