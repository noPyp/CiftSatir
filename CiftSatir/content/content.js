(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});

  // The popup can re-inject these files when a tab was already open before the
  // extension was installed or reloaded (Chrome does not retrofit content
  // scripts into existing tabs). Running the whole chain again must not create a
  // second overlay, a second keyboard handler or duplicate messages, so the
  // entry point is guarded on the shared namespace.
  if (DS.contentInstalled) {
    return;
  }
  DS.contentInstalled = true;

  // Readiness marker for the popup. It is set synchronously, before any await,
  // so the popup can tell "the script never ran" apart from "the script ran but
  // has not answered yet" when a tab was opened before an extension reload.
  global.__dualsubContentReady = true;

  const { EN, TR } = DS.constants;

  const state = {
    enabled: true,
    turkishOn: true,
    englishOn: true,
    hideNativeSubtitles: true,
    fontSize: 100,
    position: 'bottom',
    // Appearance (popup > Görünüm)
    enColor: '#f8fbff',
    trColor: '#dff7e6',
    hoverColor: '#38bdf8',
    bgOn: true,
    bgOpacity: 58,
    outline: true,
    siteUrl: 'http://127.0.0.1:5173/',
    pausedByPanel: false,
    activeVideo: null,
    attachedVideos: new Set(),
    overlayByVideo: new WeakMap(),
    storeByVideo: new WeakMap(),
    detachByVideo: new WeakMap(),
    adaptorIdByVideo: new WeakMap(),
    resizeObservers: new Map(),
    observer: null,
    initialized: false,
    settingsLoaded: false,
    settingsTouchedAt: 0,
    pipelineRunning: false,
    scanTimer: 0,
    dropZone: null,
    lastError: '',
    lastRefused: '',
    capturedCount: 0,
    // A player can fetch its .vtt before this script has found/bound the
    // <video>. The capture layer dedupes by URL and will not send it again, so
    // "no store yet" used to mean those subtitles were lost for the whole
    // session. Payloads are held briefly and replayed once a store exists.
    pendingCaptures: [],
    // Every subtitle URL this store has used. A player that switches episode can
    // finish an in-flight request for the *previous* file after the new one has
    // already arrived; that late response must not put the old lines back.
    captureUrlsByStore: new WeakMap(),
    captureLastUrlByStore: new WeakMap(),
    // Line translation for English-only videos.
    autoTrByStore: new WeakMap(),
    autoTranslations: new Map(),
    // One in-flight line-translation request per store. A global flag used to
    // block the next video's translation until the previous video's request
    // finished (up to 20 s), which looked like "the Turkish line is missing".
    pendingTranslationStores: new WeakSet(),
    translationEpoch: new WeakMap(),
    lastTranslateAt: 0,
    translationError: '',
    // Diagnostics: one small record of "where the pipeline currently is".
    // Deliberately last-write-wins and deduplicated, so it never grows and the
    // console never fills with a repeating line every frame.
    debug: false,
    diag: {
      stage: 'idle',
      platform: '',
      adaptor: '',
      cueCount: 0,
      translated: false,
      error: '',
      errorStage: '',
      at: 0
    }
  };

  const loggedSignatures = new Set();

  function logOnce(signature, message) {
    if (!state.debug || loggedSignatures.has(signature)) {
      return;
    }
    loggedSignatures.add(signature);
    try {
      console.log('[ÇiftSatır] ' + message);
    } catch (error) {
      // Logging must never break the pipeline.
    }
  }

  // Records pipeline progress. `stage` is the machine-readable name used by the
  // popup, `message` the human explanation printed once in the console.
  function setStage(stage, extra) {
    const patch = extra || {};
    const next = {
      stage: stage,
      platform: patch.platform !== undefined ? patch.platform : state.diag.platform,
      adaptor: patch.adaptor !== undefined ? patch.adaptor : state.diag.adaptor,
      cueCount: patch.cueCount !== undefined ? patch.cueCount : state.diag.cueCount,
      translated: patch.translated !== undefined ? patch.translated : state.diag.translated,
      error: patch.error !== undefined ? patch.error : '',
      errorStage: patch.error !== undefined ? stage : '',
      at: Date.now()
    };

    state.diag = next;

    if (patch.error) {
      state.lastError = String(patch.error);
    }

    logOnce(
      'stage:' + stage + ':' + next.adaptor + ':' + (patch.error || ''),
      messageForStage(stage, next)
    );
  }

  const STAGE_TEXT = {
    idle: 'video aranıyor',
    video: 'video bulundu',
    'waiting-subtitle': 'altyazı kaynağı bekleniyor',
    'source-attached': 'altyazı kaynağı bağlandı',
    active: 'altyazı aktif',
    unsupported: 'bu oynatıcı henüz desteklenmiyor',
    disabled: 'eklenti kapalı',
    error: 'hata'
  };

  function messageForStage(stage, diag) {
    const base = STAGE_TEXT[stage] || stage;
    const bits = ['aşama: ' + base];
    if (diag.platform) {
      bits.push('platform: ' + diag.platform);
    }
    if (diag.adaptor) {
      bits.push('kaynak: ' + diag.adaptor);
    }
    if (diag.cueCount) {
      bits.push('cue: ' + diag.cueCount);
    }
    if (stage === 'active') {
      bits.push('çeviri: ' + (diag.translated ? 'var' : 'yok (EN gösteriliyor)'));
    }
    if (diag.error) {
      bits.push('hata: ' + diag.error);
    }
    return bits.join(' | ');
  }

  function isVideoElement(value) {
    return value instanceof HTMLVideoElement && value.isConnected;
  }

  // Human-readable platform label for the popup and the console line. Purely
  // diagnostic: no behaviour is keyed on the hostname here - adaptors decide
  // that themselves, so a site check cannot be mistaken for working support.
  function platformName() {
    const id = state.diag.adaptor || '';
    if (id === 'youtube' || id === 'youtube-dom') {
      return 'YouTube';
    }
    if (id === 'netflix') {
      return 'Netflix';
    }
    if (id === 'generic-track') {
      return 'HTML5 text track';
    }
    if (id === 'network-capture') {
      return 'ağdan yakalanan altyazı';
    }
    if (id === 'manual-file') {
      return 'elle yüklenen altyazı';
    }

    const host = String(location.hostname || '').replace(/^www\./, '');
    if (!host) {
      return location.protocol === 'file:' ? 'yerel dosya' : 'bilinmeyen';
    }
    if (/(^|\.)youtube\.com$/.test(host) || host === 'youtu.be') {
      return 'YouTube';
    }
    if (/(^|\.)netflix\.com$/.test(host)) {
      return 'Netflix';
    }
    return host;
  }

  function isVisibleVideo(video) {
    if (!isVideoElement(video)) {
      return false;
    }

    for (let element = video; element; element = element.parentElement) {
      const style = global.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' ||
        style.visibility === 'collapse' || style.contentVisibility === 'hidden' ||
        Number(style.opacity) === 0) {
        return false;
      }
    }

    return Boolean(DS.overlay.getVisibleVideoRect(video));
  }

  function pickBestVideo(videos) {
    const fullscreenElement = document.fullscreenElement;
    const candidates = Array.from(videos).filter((video) => isVideoElement(video) && isVisibleVideo(video));
    if (!candidates.length) {
      return null;
    }

    return candidates
      .map((video) => {
        const rect = DS.overlay.getVisibleVideoRect(video);
        return {
          video: video,
          isFullscreen: Boolean(fullscreenElement && (fullscreenElement === video || fullscreenElement.contains(video))),
          isPlaying: !video.paused && !video.ended,
          isActive: video === state.activeVideo,
          area: rect.width * rect.height
        };
      })
      .sort((a, b) =>
        Number(b.isFullscreen) - Number(a.isFullscreen) ||
        Number(b.isPlaying) - Number(a.isPlaying) ||
        Number(b.isActive) - Number(a.isActive) ||
        b.area - a.area
      )[0]?.video || null;
  }

  function settings() {
    return {
      enabled: state.enabled,
      englishOn: state.englishOn,
      turkishOn: state.turkishOn,
      hideNativeSubtitles: state.hideNativeSubtitles,
      fontSize: state.fontSize,
      position: state.position,
      enColor: state.enColor,
      trColor: state.trColor,
      hoverColor: state.hoverColor,
      bgOn: state.bgOn,
      bgOpacity: state.bgOpacity,
      outline: state.outline
    };
  }

  const APPEARANCE_COLORS = ['enColor', 'trColor', 'hoverColor'];

  function applySettings(patch) {
    const next = patch || {};
    const wasEnabled = state.enabled;

    if (['enabled', 'englishOn', 'turkishOn', 'hideNativeSubtitles', 'fontSize', 'position',
      'enColor', 'trColor', 'hoverColor', 'bgOn', 'bgOpacity', 'outline']
      .some((key) => Object.prototype.hasOwnProperty.call(next, key))) {
      state.settingsTouchedAt = Date.now();
    }

    if (typeof next.enabled === 'boolean') {
      state.enabled = next.enabled;
    }
    if (typeof next.englishOn === 'boolean') {
      state.englishOn = next.englishOn;
    }
    if (typeof next.turkishOn === 'boolean') {
      state.turkishOn = next.turkishOn;
    }
    if (typeof next.hideNativeSubtitles === 'boolean') {
      state.hideNativeSubtitles = next.hideNativeSubtitles;
    }
    if (Number.isFinite(Number(next.fontSize))) {
      state.fontSize = Math.min(180, Math.max(70, Number(next.fontSize)));
    }
    if (next.position === 'bottom' || next.position === 'middle' || next.position === 'top') {
      state.position = next.position;
    }
    for (const key of APPEARANCE_COLORS) {
      if (typeof next[key] === 'string' && /^#[0-9a-f]{6}$/i.test(next[key])) {
        state[key] = next[key];
      }
    }
    if (typeof next.bgOn === 'boolean') {
      state.bgOn = next.bgOn;
    }
    if (next.bgOpacity !== undefined && Number.isFinite(Number(next.bgOpacity))) {
      state.bgOpacity = Math.min(100, Math.max(0, Number(next.bgOpacity)));
    }
    if (typeof next.outline === 'boolean') {
      state.outline = next.outline;
    }
    if (typeof next.siteUrl === 'string' && next.siteUrl) {
      state.siteUrl = next.siteUrl;
    }
    if (typeof next.debug === 'boolean') {
      state.debug = next.debug;
    }

    // The setting has three consumers - popup toggle, content pipeline and
    // overlay - and they used to diverge because this function only re-rendered
    // whichever video happened to be "active". When the active video reference
    // was null (a player that hid its <video>), turning the extension off did
    // nothing at all and the last subtitle stayed on screen forever. Turning it
    // off is now a real teardown, not a CSS change.
    if (wasEnabled !== state.enabled) {
      if (state.enabled) {
        startPipeline();
      } else {
        stopPipeline();
      }
      return;
    }

    if (state.enabled) {
      renderAllVideos();

      // Turning a line back on has to restore it even when nothing else in the
      // page moves. Rendering only draws what is already in the store; when the
      // line was switched off before its translation was fetched, nothing was
      // ever stored and no `timeupdate` may come (a paused video, a player that
      // does not tick), so the line stayed empty until the page was reloaded.
      // Ask for the missing translation explicitly, right now.
      const video = state.activeVideo;
      const store = video ? state.storeByVideo.get(video) : null;
      if (video && store) {
        maybeTranslateCues(video, store, true);
      }
    }
  }

  // The context object handed to adaptors. Adaptors push cues through emit()
  // rather than returning them, so a player that discovers tracks late (JW
  // Player, HLS) can still feed the store after attach() has returned.
  function createContext(video, store) {
    return {
      video: video,
      getSetting: (key) => settings()[key],
      // Lets a low-priority adaptor see whether a better source already owns a
      // channel and step aside (the DOM-caption adaptor does exactly that).
      cueSource: (kind) => {
        const meta = store.metaFor(kind);
        return meta && meta.source ? String(meta.source) : '';
      },
      emit: (event, payload) => {
        if (event === 'cues' && payload && payload.kind) {
          // Timed text is not always dialogue. Player metadata tracks carry
          // serialized HLS/ID3 tags, and one of them was rendered as a subtitle
          // (a wall of JSON over the film). Drop cues that cannot be a spoken
          // line, and treat a payload that had only such cues as "nothing to
          // say" instead of clearing the channel.
          if (Array.isArray(payload.cues) && payload.cues.length) {
            const dialogue = DS.parsers.filterDialogue(payload.cues);
            if (!dialogue.length) {
              return;
            }
            if (dialogue.length !== payload.cues.length) {
              payload = Object.assign({}, payload, { cues: dialogue });
            }
          }

          // Turkish must never be filed under English. This is the single entry
          // point every adaptor goes through, so the correction is made here
          // rather than in each reader.
          if (payload.kind === EN) {
            const corrected = correctSourceLanguage(store, EN, payload.cues);
            if (!corrected) {
              return;
            }
            if (corrected !== EN) {
              payload = Object.assign({}, payload, { kind: corrected });
            }
          }

          // A single-line DOM capture arrives one line at a time and can race a
          // complete track or a captured file for the same channel. The full
          // source is strictly better: never let a live line overwrite it. The
          // same adaptor refreshing its own line is still allowed.
          const existingMeta = store.metaFor(payload.kind);
          if (payload.confidence === 'live' && existingMeta &&
              existingMeta.source !== payload.source &&
              existingMeta.confidence !== 'live') {
            return;
          }

          // A real Turkish track replaces generated lines and must stop the
          // translator from overwriting it on the next tick.
          if (payload.kind === TR && payload.source !== AUTO_TR_SOURCE) {
            state.autoTrByStore.set(store, false);
          }

          const hadAutoTurkish = payload.kind === EN && isAutoTranslated(store);
          store.set(payload.kind, payload.cues, {
            source: payload.source,
            confidence: payload.confidence || ''
          });

          // A cleared English channel (captions switched off, or a live source
          // that stopped) must take the generated Turkish line with it.
          // Otherwise the Turkish sentence stayed on screen under an empty
          // English line - visible, stale, and impossible to dismiss.
          if (payload.kind === EN && (!payload.cues || !payload.cues.length) && isAutoTranslated(store)) {
            store.set(TR, [], { source: AUTO_TR_SOURCE });
            state.autoTrByStore.delete(store);
          } else if (hadAutoTurkish) {
            // The English source changed (new video, new track, or a live
            // caption line). Drop the old generated Turkish sentences - they
            // belong to the previous English cues and timings - then rebuild
            // whatever is already in the translation cache.
            store.set(TR, [], { source: AUTO_TR_SOURCE });
            state.autoTrByStore.set(store, true);
            applyAutoTranslations(store);
          }

          if (payload.kind === EN) {
            setStage('active', {
              cueCount: payload.cues.length,
              adaptor: payload.source || state.diag.adaptor
            });
            maybeTranslateCues(video, store, true);
          }

          render(video);
        }
      }
    };
  }

  // Receives the click already narrowed to a word span by the overlay's
  // delegated listener.
  function onWordClick(event, span) {
    if (!span) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const video = state.activeVideo;
    if (!video) {
      return;
    }

    const overlay = state.overlayByVideo.get(video);
    const panel = overlay && overlay.__dualsubPanel;
    if (!panel) {
      return;
    }

    // The display form keeps its original casing and apostrophes ("Don't"),
    // while the service worker normalises it for the storage key.
    const word = (span.textContent || span.dataset.word || '').trim();
    const store = state.storeByVideo.get(video);
    const cue = store && store.has(EN) ? store.at(EN, Number(video.currentTime) || 0) : null;
    const trCue = store && store.has(TR) ? store.at(TR, Number(video.currentTime) || 0) : null;

    // Pause first, then open the panel. The user clicked a word to read about
    // it; letting the video keep running would move the subtitle out from under
    // the sentence being studied.
    if (!video.paused && !video.ended) {
      state.pausedByPanel = true;
      video.pause();
    } else {
      state.pausedByPanel = false;
    }

    // The panel's star action needs the sentence the word was found in, so the
    // source context is passed along with the lookup.
    const source = cue
      ? {
          sentence: cue.text,
          trSentence: trCue ? trCue.text : '',
          timestamp: Number(video.currentTime) || 0,
          url: location.href,
          title: document.title
        }
      : null;

    panel.__dualsubSource = source;
    panel.show(word, overlay.getBoundingClientRect(), source);
  }

  function render(video) {
    const overlay = state.overlayByVideo.get(video);
    const store = state.storeByVideo.get(video);
    if (!overlay || !store) {
      return;
    }

    DS.overlay.updateOverlay(overlay, video, store, settings(), onWordClick);
    maybeTranslateCues(video, store);
  }

  /* ---- Turkish line for English-only videos ---- */

  const AUTO_TR_SOURCE = 'auto-translate';
  const LANGUAGE_FIX_SOURCE = 'language-fix';


  function isAutoTranslated(store) {
    return state.autoTrByStore.get(store) === true;
  }

  // A subtitle source can be Turkish even when it filled the English channel:
  // the site ships a single Turkish file, its track carries no language
  // metadata, or the first cues were too short for the file-name detector. The
  // translator then translated Turkish into Turkish and the viewer saw the same
  // sentence twice, the lower one machine-mangled ("...misin?" -> "...mi?").
  //
  // Returns the channel the cues actually belong to, or '' when they must be
  // dropped because a real Turkish track already owns the channel.
  function correctSourceLanguage(store, kind, cues) {
    if (kind !== EN || !cues || !cues.length) {
      return kind;
    }
    if (!DS.langDetect.looksTurkish(cues)) {
      return kind;
    }

    // Whatever reached the English channel before is the same Turkish text.
    // Leaving it there would keep the duplicate line on screen, even when a
    // real Turkish track already owns the other line.
    if (store.has(EN)) {
      store.set(EN, [], { source: LANGUAGE_FIX_SOURCE });
    }
    state.autoTrByStore.delete(store);

    const trMeta = store.metaFor(TR);
    if (trMeta && trMeta.source && trMeta.source !== AUTO_TR_SOURCE) {
      // A real Turkish track is already in place. This source is the same
      // language arriving twice; it is not the English line.
      return '';
    }

    return TR;
  }

  function buildTranslatedCues(store) {
    return DS.cueTranslate.build(store.get(EN), state.autoTranslations);
  }

  // Replaces the Turkish channel with the translations collected so far.
  // Returns true when the channel actually changed, so callers do not render in
  // a loop when nothing new arrived.
  function applyAutoTranslations(store) {
    const translated = buildTranslatedCues(store);
    if (!translated.length) {
      return false;
    }

    const before = store.get(TR).length;
    store.set(TR, translated, { source: AUTO_TR_SOURCE });
    state.autoTrByStore.set(store, true);
    return translated.length !== before;
  }

  // Only the current line and the next couple are requested. Translating a whole
  // film up front would be thousands of requests and would still be ready long
  // after the viewer moved on.
  function translationCandidates(store, time) {
    return DS.cueTranslate.pick(store.get(EN), time, state.autoTranslations, 3);
  }

  // True only while this store is still the one bound to that <video>. A late
  // translation response for a video that was already replaced must never
  // repaint the new video or overwrite its diagnostics.
  function isCurrentStore(video, store) {
    return Boolean(video && store && state.storeByVideo.get(video) === store);
  }

  function maybeTranslateCues(video, store, force) {
    if (!state.enabled || !state.englishOn || !state.turkishOn) {
      return;
    }
    if (!store.has(EN)) {
      return;
    }

    // Never translate Turkish into Turkish. A single-language site can leave
    // Turkish cues in the English channel; translating them produced two
    // nearly identical lines. Move the cues to the Turkish line instead and
    // leave English empty - that is the honest state for such a page.
    const englishCues = store.get(EN);
    if (DS.langDetect.looksTurkish(englishCues)) {
      const corrected = correctSourceLanguage(store, EN, englishCues);
      if (corrected === TR) {
        store.set(TR, englishCues, { source: LANGUAGE_FIX_SOURCE });
        state.autoTrByStore.delete(store);
      }
      // One re-render shows the moved line and clears the English one. The next
      // pass exits at the `!store.has(EN)` check above, so this cannot loop.
      render(video);
      return;
    }

    // A real Turkish track always wins; generated lines are only used while the
    // channel is empty or was filled by this same path.
    if (store.has(TR) && !isAutoTranslated(store)) {
      return;
    }
    if (state.pendingTranslationStores.has(store)) {
      return;
    }

    const now = Date.now();
    if (!force && now - state.lastTranslateAt < 800) {
      return;
    }

    const texts = translationCandidates(store, Number(video.currentTime) || 0);
    if (!texts.length) {
      return;
    }

    state.lastTranslateAt = now;
    state.pendingTranslationStores.add(store);
    const epoch = (state.translationEpoch.get(store) || 0) + 1;
    state.translationEpoch.set(store, epoch);

    DS.messaging.send({ type: 'translate-cues', texts: texts }, 20000)
      .then((result) => {
        state.pendingTranslationStores.delete(store);
        if (!isCurrentStore(video, store) || state.translationEpoch.get(store) !== epoch) {
          return;
        }

        const rows = result && Array.isArray(result.translations) ? result.translations : [];
        let added = 0;

        for (const row of rows) {
          const text = String((row && row.text) || '').trim();
          const tr = String((row && row.tr) || '').trim();
          if (text && tr && !state.autoTranslations.has(text)) {
            // Bounded cache: a long session across many videos must not grow
            // this map without limit. Oldest entries are dropped first, and
            // anything still on screen is re-requested if it comes back.
            if (state.autoTranslations.size >= 4000) {
              const oldest = state.autoTranslations.keys().next();
              if (!oldest.done) {
                state.autoTranslations.delete(oldest.value);
              }
            }
            state.autoTranslations.set(text, tr);
            added += 1;
          }
        }

        if (!added) {
          state.translationError = rows.length
            ? 'Türkçe çeviri alınamadı.'
            : '';
          // A translation failure is reported but never escalated: the English
          // line keeps rendering and the next tick retries.
          setStage(store.has(EN) ? 'active' : 'waiting-subtitle', {
            error: state.translationError,
            translated: false
          });
          return;
        }

        state.translationError = '';
        setStage('active', { translated: true, error: '' });
        if ((!store.has(TR) || isAutoTranslated(store)) && applyAutoTranslations(store)) {
          render(video);
        }
      })
      .catch((error) => {
        state.pendingTranslationStores.delete(store);
        if (!isCurrentStore(video, store)) {
          return;
        }
        state.translationError = String(error && error.message ? error.message : error);
        setStage('active', { error: state.translationError, translated: false });
      });
  }

  function cleanupVideo(video) {
    if (!(video instanceof HTMLVideoElement)) {
      return;
    }

    const overlay = state.overlayByVideo.get(video);
    if (overlay) {
      if (overlay.__dualsubPanel) {
        overlay.__dualsubPanel.hide();
      }
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
      const panelEl = overlay.__dualsubPanel && overlay.__dualsubPanel.el;
      if (panelEl && panelEl.parentNode) {
        panelEl.parentNode.removeChild(panelEl);
      }
    }

    const detach = state.detachByVideo.get(video);
    if (typeof detach === 'function') {
      try {
        detach();
      } catch (error) {
        // Teardown is best-effort.
      }
    }

    if (video.__dualsubHandlers) {
      for (const [eventName, handler] of Object.entries(video.__dualsubHandlers)) {
        video.removeEventListener(eventName, handler);
      }
      delete video.__dualsubHandlers;
    }

    if (typeof video.__dualsubRetryTeardown === 'function') {
      try {
        video.__dualsubRetryTeardown();
      } catch (error) {
        // Teardown is best-effort.
      }
      delete video.__dualsubRetryTeardown;
    }

    state.overlayByVideo.delete(video);
    state.storeByVideo.delete(video);
    state.detachByVideo.delete(video);
    state.adaptorIdByVideo.delete(video);
    state.attachedVideos.delete(video);

    const resizeObserver = state.resizeObservers.get(video);
    if (resizeObserver) {
      resizeObserver.disconnect();
      state.resizeObservers.delete(video);
    }

    if (state.activeVideo === video) {
      state.activeVideo = null;
    }
  }

  // Removes every element this extension owns in the current document.
  // Called at start-up as well: reloading the extension leaves the previous
  // content script's overlay in the page with a dead JS context, so it can never
  // hide itself. That orphaned layer is why subtitles could stay on screen while
  // the extension looked off.
  function removeExtensionUi() {
    const selectors = [
      '.' + DS.constants.LAYER_CLASS,
      '.' + DS.constants.PANEL_CLASS,
      '.dualsub-dropzone'
    ].join(',');

    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(selectors));
    } catch (error) {
      nodes = [];
    }

    for (const node of nodes) {
      if (node && node.parentNode) {
        node.parentNode.removeChild(node);
      }
    }

    // A previous extension instance (reloaded or turned off) can leave the
    // "hide Netflix's own subtitles" class behind; Netflix would then show no
    // subtitles at all.
    try {
      document.documentElement.classList.remove('dualsub-netflix-dom');
    } catch (error) {
      // Cosmetic only.
    }

    if (state.dropZone) {
      if (typeof state.dropZone.destroy === 'function') {
        try {
          state.dropZone.destroy();
        } catch (error) {
          // Best-effort teardown.
        }
      }
      state.dropZone = null;
    }
  }

  // Turning the extension off tears the pipeline down. Keeping the adaptors
  // alive but hidden was the old behaviour; it left stale stores and DOM layers
  // behind, and it broke completely when `activeVideo` was null because nothing
  // re-rendered. Turning it back on rebuilds a fresh session instead of trying
  // to salvage the old one.
  function stopPipeline() {
    if (state.scanTimer) {
      global.clearTimeout(state.scanTimer);
      state.scanTimer = 0;
    }

    for (const video of Array.from(state.attachedVideos)) {
      cleanupVideo(video);
    }

    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }

    removeExtensionUi();
    state.activeVideo = null;
    state.pipelineRunning = false;
    state.lastRefused = '';
    state.capturedCount = 0;
    state.pendingCaptures = [];
    state.captureUrlsByStore = new WeakMap();
    state.translationError = '';
    setStage('disabled', { cueCount: 0, translated: false, adaptor: '', error: '' });
  }

  // Idempotent: opening the popup, changing a language and toggling the master
  // switch in quick succession must not create a second observer, drop zone or
  // adaptor set.
  function startPipeline() {
    if (!state.enabled || state.pipelineRunning) {
      return;
    }

    state.pipelineRunning = true;
    installObserver();
    setStage('idle', { cueCount: 0, translated: false, adaptor: '', error: '' });

    if (!state.dropZone) {
      state.dropZone = DS.adaptors.manualFile.createDropZone(handleFileDrop);
      document.documentElement.appendChild(state.dropZone.el);
    }

    scanAndConnect();
  }

  function renderAllVideos() {
    if (!state.enabled) {
      return;
    }
    for (const video of Array.from(state.attachedVideos)) {
      if (!video.isConnected) {
        cleanupVideo(video);
        continue;
      }
      render(video);
    }
  }

  function bindVideo(video) {
    if (!isVideoElement(video) || state.attachedVideos.has(video)) {
      return;
    }

    const store = new DS.CueStore();
    const overlay = DS.overlay.createOverlay();
    const context = createContext(video, store);

    setStage('video', { platform: platformName(), error: '' });

    const panel = DS.overlay.attachPanelToOverlay(overlay, {
      lookup: (word, context) => DS.messaging.lookup(word, context),
      refine: (word, context) => DS.messaging.send({
        type: 'refine-word',
        word: word,
        context: context || ''
      }, 30000),
      sentences: (word, context) => {
        return DS.messaging.send({
          type: 'word-sentences',
          word: word,
          context: context || ''
        }, 60000);
      },
      isStarred: (word) => DS.messaging.isStarred(word),
      setStarred: (word, starred, source, examples) =>
        DS.messaging.setStarred(word, starred, source, examples),
      onPlay: () => {
        if (video.isConnected) {
          Promise.resolve(video.play()).catch(() => {});
        }
      }
    });
    const panelEl = panel.el;

    // The panel element lives beside the layer so the layer's measurement loop
    // is unaffected by panel size. `documentElement` matches the layer's own
    // fullscreen reparenting target.
    document.documentElement.appendChild(overlay);
    document.documentElement.appendChild(panelEl);

    state.overlayByVideo.set(video, overlay);
    state.storeByVideo.set(video, store);
    state.attachedVideos.add(video);

    const sync = () => render(video);

    const handlers = {
      timeupdate: sync,
      play: sync,
      pause: sync,
      seeking: sync,
      seeked: sync,
      ended: sync,
      loadedmetadata: sync,
      fullscreenchange: sync,
      resize: sync
    };

    Object.entries(handlers).forEach(([eventName, handler]) => {
      video.addEventListener(eventName, handler);
    });
    video.__dualsubHandlers = handlers;

    if (typeof ResizeObserver === 'function') {
      const resizeObserver = new ResizeObserver(() => render(video));
      resizeObserver.observe(video);
      state.resizeObservers.set(video, resizeObserver);
    }

    // ---- subtitle session -------------------------------------------------
    //
    // A "session" is one adaptor set reading one subtitle source. It exists
    // because a <video> element is not one video for its whole life: YouTube
    // reuses the element and swaps its track/source when the user opens the
    // next video, HLS players attach tracks seconds after playback starts, and
    // some players replace the cue list on quality switches. The previous
    // generation of this code treated "the store has cues" as "we are done",
    // so a swapped source kept the old line on screen forever (or, when the
    // old cues were rejected, showed nothing at all).
    //
    // Every attempt therefore compares a source key. When it changes, the old
    // adaptor is detached, both channels are cleared and the session starts
    // over. When it does not change, an attempt is a no-op, so the retries
    // below stay cheap.
    const RETRY_DELAYS = [400, 800, 1500, 2500, 4000, 6000, 8000];

    let retryTimer = 0;
    let retryIndex = 0;
    let attachedKey = null;
    let running = false;
    let again = false;
    let disposed = false;
    const trackList = video.textTracks || null;
    const trackLoadBindings = [];

    // Describes the subtitle source behind this video, split into parts so a
    // lazily growing cue list can be told apart from a genuinely new video.
    // `media` catches a new film in the same element, `structure` catches a
    // new/removed/repointed track, and `first` catches the same track file
    // being reused for different content.
    function sourceInfo() {
      let media = '';
      try {
        media = String(video.currentSrc || video.src || '');
      } catch (error) {
        media = '';
      }

      // SPA players (YouTube especially) can keep the same blob/MSE element and
      // the same <video> for the next title, so the media URL alone is not a
      // reliable "this is a different video" signal. The page URL is: query is
      // kept, the hash is dropped because it often only means "scroll here".
      try {
        media += '::' + location.pathname + location.search;
      } catch (error) {
        // Sandboxed frames can throw; media alone still works.
      }

      const parts = [];
      let count = 0;
      let first = '';
      try {
        for (const track of Array.from(video.textTracks || [])) {
          const cues = track && track.cues ? track.cues : null;
          const trackCount = cues ? cues.length : 0;
          const trackFirst = trackCount ? String(cues[0].text || '').slice(0, 24) : '';
          count += trackCount;
          if (!first && trackFirst) {
            first = trackFirst;
          }
          parts.push([
            track.kind,
            track.language,
            track.label,
            track.src || '',
            trackCount > 0 ? 'c' : 'e'
          ].join('~'));
        }
      } catch (error) {
        // A read-only textTracks implementation still leaves `media` usable.
      }

      const structure = parts.join('|');
      return {
        media: media,
        structure: structure,
        count: count,
        first: first,
        key: media + '#' + structure
      };
    }

    function sameFile(previous, next) {
      if (!previous) {
        return false;
      }
      if (previous.media !== next.media || previous.structure !== next.structure) {
        return false;
      }
      // Same media and same track layout. A cue list that only grew (HLS or a
      // player loading more of the file) is the same subtitle, not a new video;
      // replacing content while keeping the first line is not a new video
      // either. Anything else - fewer cues, different first line - means the
      // file behind the same track URL changed and must be re-read.
      return next.count >= previous.count && next.first === previous.first;
    }

    function cuesReady() {
      return store.has(EN) || store.has(TR);
    }

    // Drops everything belonging to the previous source. Called only when the
    // key really changed, never on a plain re-render.
    function resetSession() {
      const previous = state.detachByVideo.get(video);
      if (typeof previous === 'function') {
        try {
          previous();
        } catch (error) {
          // Replacing a stale adaptor is best-effort.
        }
      }
      state.detachByVideo.delete(video);
      store.clear();
      state.autoTrByStore.delete(store);
      attachedKey = null;
      // Clearing is not the same as hiding: the next source may only have a
      // Turkish track, and leaving the old English sentence in the DOM made it
      // reappear underneath the new Turkish line.
      DS.overlay.clearOverlay(overlay);
      setStage('waiting-subtitle', { cueCount: 0, translated: false, adaptor: '', error: '' });

      // A player that swaps episodes often has the new subtitle file in flight
      // before this reset runs; without a replay those cues were cleared with
      // the old session and never arrived again.
      if (DS.captureBridge && typeof DS.captureBridge.replay === 'function') {
        DS.captureBridge.replay();
      }
    }

    function scheduleNext() {
      if (disposed || retryTimer || retryIndex >= RETRY_DELAYS.length) {
        if (!disposed && retryIndex >= RETRY_DELAYS.length && !cuesReady()) {
          setStage('unsupported');
        }
        return;
      }
      if (!cuesReady()) {
        setStage('waiting-subtitle');
      }
      const delay = RETRY_DELAYS[retryIndex];
      retryIndex += 1;
      retryTimer = global.setTimeout(() => {
        retryTimer = 0;
        attempt();
      }, delay);
    }

    // Runs one attach attempt. Concurrent calls are folded into one follow-up
    // run so a burst of DOM mutations cannot start two adaptors at once (which
    // used to duplicate listeners and cuechange work).
    function attempt() {
      if (disposed || !video.isConnected) {
        return;
      }

      if (running) {
        again = true;
        return;
      }

      const info = sourceInfo();
      if (attachedKey !== null) {
        if (sameFile(attachedKey, info)) {
          // Same subtitle file. A cue list that grew is already handled by the
          // adaptor's own cuechange listener; re-attaching would restart it.
          attachedKey = info;
          if (cuesReady() || state.detachByVideo.has(video)) {
            return;
          }
        } else {
          // Cues and the adaptor belong to a source that is no longer there.
          resetSession();
        }
      }

      running = true;
      DS.adaptorRegistry.attachBest(video, context)
        .then(finish)
        .catch((error) => {
          state.lastError = String(error && error.message ? error.message : error);
          finish(null);
        });

      function finish(attached) {
        running = false;

        if (disposed || !video.isConnected) {
          if (attached) {
            attached.detach();
          }
          return;
        }

        if (attached) {
          const previous = state.detachByVideo.get(video);
          if (typeof previous === 'function' && previous !== attached.detach) {
            try {
              previous();
            } catch (error) {
              // Replacing a stale adaptor is best-effort.
            }
          }

          state.detachByVideo.set(video, attached.detach);
          state.adaptorIdByVideo.set(video, attached.adaptorId || '');
          setStage(cuesReady() ? 'active' : 'source-attached', {
            adaptor: attached.adaptorId || '',
            platform: platformName(),
            error: ''
          });
          attachedKey = sourceInfo();
          render(video);
        }

        if (again) {
          again = false;
          attempt();
          return;
        }

        if (!cuesReady()) {
          // A live adaptor (YouTube/Netflix/DOM capture) is already watching
          // and will emit when a line appears. Scheduling retries for it would
          // re-attach the same observer every few seconds and end up wrongly
          // reporting "unsupported" before the user even turns captions on.
          if (state.detachByVideo.has(video)) {
            setStage('waiting-subtitle');
            return;
          }
          scheduleNext();
        }
      }
    }

    // A new track, a removed track or a track that finished loading means the
    // source may be usable now. The retry budget is reset because this is a
    // genuinely new source, not a periodic poll.
    function onSourceSignal() {
      if (disposed) {
        return;
      }
      if (retryTimer) {
        global.clearTimeout(retryTimer);
        retryTimer = 0;
      }
      retryIndex = 0;
      attempt();
    }

    // Cheap check used by media events: no budget reset, and a no-op when the
    // current source is already settled.
    function requestCheck() {
      if (disposed) {
        return;
      }
      if (retryTimer) {
        global.clearTimeout(retryTimer);
        retryTimer = 0;
      }
      attempt();
    }

    // `addtrack` is the event that makes the late-track case work without
    // polling: the browser tells us the moment the player adds a subtitle
    // track. Track `load` covers cues arriving on an already-existing track.
    function watchTrack(track) {
      if (!track || typeof track.addEventListener !== 'function') {
        return;
      }
      const onLoad = () => onSourceSignal();
      track.addEventListener('load', onLoad);
      trackLoadBindings.push(() => track.removeEventListener('load', onLoad));
    }

    try {
      Array.from(video.textTracks || []).forEach(watchTrack);
      if (trackList && typeof trackList.addEventListener === 'function') {
        trackList.addEventListener('addtrack', onSourceSignal);
        trackList.addEventListener('removetrack', onSourceSignal);
      }
    } catch (error) {
      // A player with a read-only textTracks implementation still gets the
      // bounded retries below.
    }

    const mediaChecks = ['loadedmetadata', 'play', 'seeked'];
    for (const eventName of mediaChecks) {
      video.addEventListener(eventName, requestCheck);
    }

    // Teardown for the retry machinery, so cleanupVideo removes these along
    // with the sync handlers instead of leaving them on a detached element.
    video.__dualsubRetryTeardown = () => {
      disposed = true;
      if (retryTimer) {
        global.clearTimeout(retryTimer);
        retryTimer = 0;
      }
      for (const eventName of mediaChecks) {
        video.removeEventListener(eventName, requestCheck);
      }
      for (const off of trackLoadBindings) {
        try {
          off();
        } catch (error) {
          // Best-effort.
        }
      }
      trackLoadBindings.length = 0;
      try {
        if (trackList && typeof trackList.removeEventListener === 'function') {
          trackList.removeEventListener('addtrack', onSourceSignal);
          trackList.removeEventListener('removetrack', onSourceSignal);
        }
      } catch (error) {
        // Best-effort.
      }
      delete video.__dualsubCheckSource;
    };

    // Used by the page MutationObserver when a <track>/<source> is inserted or
    // its src attribute changes.
    video.__dualsubCheckSource = onSourceSignal;

    attempt();

    render(video);
  }

  function pruneDetachedVideos() {
    Array.from(state.attachedVideos).forEach((video) => {
      if (!video.isConnected) {
        cleanupVideo(video);
      }
    });
  }

  function refreshActiveVideo() {
    const nextVideo = pickBestVideo(document.querySelectorAll('video'));

    if (state.activeVideo && state.activeVideo !== nextVideo) {
      if (!state.activeVideo.isConnected) {
        cleanupVideo(state.activeVideo);
      } else {
        // Hide and close the panel of the video we are leaving. The overlay of a
        // player that became invisible must not keep floating over the page.
        const overlay = state.overlayByVideo.get(state.activeVideo);
        if (overlay) {
          if (overlay.__dualsubPanel && overlay.__dualsubPanel.isOpen()) {
            overlay.__dualsubPanel.hide();
          }
          DS.overlay.hideOverlay(overlay);
        }
      }
    }

    if (nextVideo && state.activeVideo !== nextVideo) {
      state.activeVideo = nextVideo;
      if (!state.attachedVideos.has(nextVideo)) {
        bindVideo(nextVideo);
      }
    } else if (!nextVideo && state.activeVideo) {
      // The old code dropped the reference without hiding the layer, so the
      // last subtitle stayed on screen with no video behind it - and a later
      // "off" command rendered nothing because activeVideo was null.
      const overlay = state.overlayByVideo.get(state.activeVideo);
      if (overlay) {
        if (overlay.__dualsubPanel && overlay.__dualsubPanel.isOpen()) {
          overlay.__dualsubPanel.hide();
        }
        DS.overlay.hideOverlay(overlay);
      }
      state.activeVideo = null;
    }
  }

  function scanAndConnect() {
    if (!state.enabled || !state.pipelineRunning) {
      return;
    }

    refreshActiveVideo();

    for (const video of document.querySelectorAll('video')) {
      if (!state.attachedVideos.has(video)) {
        bindVideo(video);
      }
    }

    if (state.activeVideo) {
      render(state.activeVideo);
    }

    pruneDetachedVideos();
    flushPendingCaptures();
  }

  // A busy page mutates class/style attributes for its own UI constantly. Each
  // of those used to trigger a full video scan and an overlay re-render. One
  // debounced pass keeps the same correctness without the churn.
  function scheduleScan() {
    if (state.scanTimer) {
      return;
    }
    state.scanTimer = global.setTimeout(() => {
      state.scanTimer = 0;
      scanAndConnect();
    }, 150);
  }

  // Translates a page mutation into "this video's subtitle source may have
  // changed". Deliberately narrow: only <track>/<source> insertion-removal and
  // a `src` change matter, so a busy page cannot reset the retry budget on
  // every unrelated DOM write.
  function signalSourceForRecord(record) {
    const check = (video) => {
      if (video && typeof video.__dualsubCheckSource === 'function') {
        video.__dualsubCheckSource();
      }
    };

    if (record.type === 'childList') {
      const isSourceNode = (node) => Boolean(node) && node.nodeType === 1 &&
        (node.tagName === 'TRACK' || node.tagName === 'SOURCE');
      const touched = Array.from(record.addedNodes).some(isSourceNode) ||
        Array.from(record.removedNodes).some(isSourceNode);
      if (!touched) {
        return;
      }

      const target = record.target;
      if (target instanceof HTMLVideoElement) {
        check(target);
      } else if (target instanceof Element && typeof target.closest === 'function') {
        check(target.closest('video'));
      }
      return;
    }

    if (record.type === 'attributes' && record.attributeName === 'src') {
      const target = record.target;
      if (target instanceof HTMLVideoElement) {
        check(target);
      } else if (target instanceof HTMLTrackElement || target instanceof HTMLSourceElement) {
        const parent = target.parentElement;
        if (parent instanceof HTMLVideoElement) {
          check(parent);
        }
      }
    }
  }

  // True when a class/hidden change on an element that is (or contains) the
  // active video could have changed whether it is visible.
  function isVisibilityMutation(records) {
    const video = state.activeVideo;
    if (!video) {
      return false;
    }

    return records.some((record) => {
      if (record.type !== 'attributes') {
        return false;
      }
      if (record.attributeName !== 'class' && record.attributeName !== 'hidden') {
        return false;
      }
      const target = record.target;
      if (target === video) {
        return true;
      }
      return target instanceof Element && typeof target.contains === 'function' && target.contains(video);
    });
  }

  let visibilityTimer = 0;

  function scheduleVisibilityCheck() {
    if (visibilityTimer) {
      return;
    }
    visibilityTimer = global.setTimeout(() => {
      visibilityTimer = 0;
      if (!state.initialized) {
        return;
      }
      refreshActiveVideo();
      if (state.activeVideo) {
        render(state.activeVideo);
      }
    }, 200);
  }

  function installObserver() {
    if (state.observer) {
      return;
    }

    state.observer = new MutationObserver((records) => {
      // A <track>/<source> being inserted, removed or repointed is the moment a
      // player decided which subtitles exist. The global scan below ignores
      // those (the element list did not change), so the owning video is asked
      // directly to re-check its source.
      for (const record of records) {
        signalSourceForRecord(record);
      }

      const hasPageMutation = records.some((record) => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (!target) {
          return true;
        }
        // Ignore our own overlay/panel/drop-zone mutations, or the observer
        // would feed itself in a loop.
        return !target.closest('.' + DS.constants.LAYER_CLASS) &&
          !target.closest('.' + DS.constants.PANEL_CLASS) &&
          !target.closest('.dualsub-dropzone');
      });

      if (hasPageMutation) {
        scheduleScan();
      }

      // A player commonly hides or shows its <video> by toggling a class or the
      // `hidden` attribute on the video or one of its wrappers. Treating that
      // as a normal page mutation would run a full scan on every class write,
      // which is far too often on YouTube; only the active video's visibility
      // is re-checked, debounced to one pass.
      if (isVisibilityMutation(records)) {
        scheduleVisibilityCheck();
      }
    });

    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'poster', 'controls', 'style', 'class', 'hidden']
    });
  }

  function currentStore() {
    const video = state.activeVideo || pickBestVideo(document.querySelectorAll('video'));
    return video ? state.storeByVideo.get(video) || null : null;
  }

  function currentPanel() {
    const video = state.activeVideo;
    if (!video) {
      return null;
    }
    const overlay = state.overlayByVideo.get(video);
    return overlay ? overlay.__dualsubPanel : null;
  }

  // Answers "why does this site not work?" without a debugger.
  //
  // On an unfamiliar player the useful facts are: is there a <video> at all, is
  // the player inside another frame (invisible from here), did a text track
  // exist, and did the network capture see anything. Reported through the popup
  // and printed to the console for the case where the popup itself is not
  // reachable.
  function diagnose() {
    const store = currentStore();
    const videos = Array.from(document.querySelectorAll('video'));
    const trackCount = videos.reduce((total, video) => {
      return total + (video.textTracks ? video.textTracks.length : 0);
    }, 0);

    const report = {
      url: location.href,
      frame: global.top === global.self ? 'top' : 'child',
      videos: videos.length,
      textTracks: trackCount,
      englishCues: store ? store.get(EN).length : 0,
      turkishCues: store ? store.get(TR).length : 0,
      capturedTracks: state.capturedCount || 0,
      refusedTrack: state.lastRefused || '',
      adaptors: DS.adaptorRegistry.list().map((adaptor) => adaptor.id),
      iframes: Array.from(document.querySelectorAll('iframe'))
        .map((frame) => frame.getAttribute('src') || '(no src)')
        .slice(0, 8),
      // Pipeline stage: which step is actually stuck, instead of guessing.
      stage: state.diag.stage,
      stageText: STAGE_TEXT[state.diag.stage] || state.diag.stage,
      platform: platformName(),
      renderer: state.diag.adaptor || '',
      layer: (() => {
        const overlay = state.activeVideo ? state.overlayByVideo.get(state.activeVideo) : null;
        if (!overlay) {
          return 'yok';
        }
        return overlay.classList.contains(DS.constants.HIDDEN_CLASS) ? 'gizli' : 'görünür';
      })(),
      translated: state.diag.translated,
      errorStage: state.diag.errorStage || '',
      lastError: state.diag.error || state.lastError || ''
    };

    return report;
  }

  function collectState() {
    const video = state.activeVideo;
    const store = currentStore();
    const stage = state.diag.stage;
    const statusText = !state.settingsLoaded
      ? 'Ayarlar yükleniyor'
      : !state.enabled
        ? 'Eklenti kapalı'
        : STAGE_TEXT[stage] || 'Durum bilinmiyor';

    const time = video ? Number(video.currentTime) || 0 : 0;
    const enCue = store ? store.at(EN, time) : null;
    const trCue = store ? store.at(TR, time) : null;

    return {
      // User preference. This is the same value the popup switch and the
      // stored setting use.
      enabled: state.enabled,
      hasVideo: Boolean(video),
      videoDetected: Boolean(video),
      // Preferences, not "what is on screen right now".
      englishOn: state.englishOn,
      turkishOn: state.turkishOn,
      // Actual rendering state. A preference can be on while no cue exists for
      // this video; the popup shows those as separate facts.
      englishVisible: Boolean(state.enabled && state.englishOn && enCue),
      turkishVisible: Boolean(state.enabled && state.turkishOn && trCue),
      englishLineOn: Boolean(state.enabled && state.englishOn),
      turkishLineOn: Boolean(state.enabled && state.turkishOn),
      hasEnglishCues: Boolean(store && store.has(EN)),
      hasTurkishCues: Boolean(store && store.has(TR)),
      enSource: store ? String((store.metaFor(EN) || {}).source || '') : '',
      trSource: store ? String((store.metaFor(TR) || {}).source || '') : '',
      fontSize: state.fontSize,
      position: state.position,
      enColor: state.enColor,
      trColor: state.trColor,
      hoverColor: state.hoverColor,
      bgOn: state.bgOn,
      bgOpacity: state.bgOpacity,
      outline: state.outline,
      siteUrl: state.siteUrl,
      isSite: Boolean(DS.siteBridge && DS.siteBridge.available()),
      autoTranslated: Boolean(store && state.autoTrByStore.get(store)),
      translationError: state.translationError,
      activeWords: document.querySelectorAll('.' + DS.constants.WORD_CLASS).length,
      inFrame: global.top !== global.self,
      // Set when a captured track was dropped for being the wrong language, so
      // the popup can explain a page that has subtitles but shows none.
      refusedTrack: state.lastRefused,
      // Diagnostics shown as a small line in the popup.
      settingsLoaded: state.settingsLoaded,
      pipelineRunning: state.pipelineRunning,
      stage: stage,
      stageText: statusText,
      platform: platformName(),
      adaptor: state.diag.adaptor || '',
      cueCount: state.diag.cueCount || 0,
      translated: Boolean(state.diag.translated),
      errorStage: state.diag.errorStage || '',
      lastError: state.diag.error || state.lastError || '',
      message: state.lastError
        ? 'Hata: ' + state.lastError
        : (video ? 'Video bulundu.' : 'Bu sayfada video bulunamadı.')
    };
  }

  function handleFileDrop(files) {
    if (!state.enabled || !state.pipelineRunning) {
      return;
    }

    // A drop can arrive before the video has been picked (or after the active
    // one was cleaned up), so the best candidate is resolved again here rather
    // than trusting state.activeVideo.
    const video = state.activeVideo || pickBestVideo(document.querySelectorAll('video'));
    if (!video) {
      return;
    }

    if (!state.attachedVideos.has(video)) {
      bindVideo(video);
    }

    const store = state.storeByVideo.get(video);
    if (!store) {
      return;
    }

    state.activeVideo = video;

    // loadFiles emits 'cues' through the context, which already triggers a
    // render for this video; no extra render call is needed here.
    DS.adaptors.manualFile.loadFiles(files, store, createContext(video, store)).then((result) => {
      if (result && result.loaded) {
        render(video);
      }
    });
  }

  function installKeyboardShortcuts() {
    document.addEventListener('keydown', (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)) {
        return;
      }

      const store = currentStore();
      if (!store) {
        return;
      }

      // [ / ] nudge the subtitle sync, for files that are offset from the video.
      if (event.key === '[' || event.key === ']') {
        const delta = event.key === '[' ? -0.25 : 0.25;
        store.shift(EN, delta);
        store.shift(TR, delta);
        if (state.activeVideo) {
          render(state.activeVideo);
        }
        event.preventDefault();
        return;
      }

      if (event.key === 'Escape') {
        const panel = currentPanel();
        if (panel && panel.isOpen()) {
          panel.hide();
          event.preventDefault();
        }
      }
    });
  }

  function attachRuntimeMessages() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || typeof message !== 'object') {
        return false;
      }

      if (message.type === 'toggle-subtitles') {
        applySettings({ enabled: !state.enabled });
        sendResponse(collectState());
        return true;
      }

      if (message.type === 'set-enabled') {
        applySettings({ enabled: Boolean(message.value) });
        sendResponse(collectState());
        return true;
      }

      if (message.type === 'apply-settings') {
        applySettings(message.patch || {});
        sendResponse(collectState());
        return true;
      }

      if (message.type === 'set-language') {
        if (message.kind === EN) {
          applySettings({ englishOn: Boolean(message.value) });
        } else if (message.kind === TR) {
          applySettings({ turkishOn: Boolean(message.value) });
        }
        sendResponse(collectState());
        return true;
      }

      if (message.type === 'get-state') {
        // Every frame receives this. Chrome delivers whichever frame answers
        // first, so a top frame with no video would win the race on a site that
        // embeds its player in an iframe (the common case on streaming sites)
        // and the popup would report "no video" for a page that is playing one.
        //
        // Frames that actually have a video answer immediately. A frame with
        // nothing to report stays quiet; the top frame only answers after a
        // short delay so a player frame gets its chance first.
        if (state.activeVideo || global.top === global.self) {
          const delay = state.activeVideo ? 0 : 250;
          setTimeout(() => {
            try {
              sendResponse(collectState());
            } catch (error) {
              // The popup may already have been answered by another frame.
            }
          }, delay);
          return true;
        }
        return false;
      }

      if (message.type === 'diagnose') {
        // Same "which frame has the player" issue as get-state: only a frame
        // that can see a video, or the top frame, is worth reporting.
        if (state.activeVideo || global.top === global.self) {
          setTimeout(() => {
            try {
              sendResponse(diagnose());
            } catch (error) {
              // Already answered elsewhere.
            }
          }, state.activeVideo ? 0 : 250);
          return true;
        }
        return false;
      }

      return false;
    });
  }

  // Routes a captured subtitle payload into a channel.
  //
  // A player like JW Player fetches French, Portuguese and Spanish tracks for
  // the same film, and an earlier version of this function filed every
  // unrecognised track into whichever channel was still empty - so Spanish text
  // landed in the English line and was translated to Turkish underneath. So a
  // track that is confidently some other language is dropped.
  //
  // Anything less clear-cut is used, though. Dialogue frequently lacks the
  // common words the language check looks for, and refusing those left the user
  // with a single line or none at all. The confidence level decides: an
  // unidentified track fills an empty channel provisionally, and a track that is
  // positively identified replaces it.
  function bufferCapture(payload) {
    if (!payload || !payload.cues || !payload.cues.length) {
      return;
    }

    const key = String(payload.url || '') + '|' +
      payload.cues.slice(0, 3).map((cue) => String(cue.text || '')).join('|');
    const duplicate = state.pendingCaptures.some((entry) => entry.key === key);
    if (duplicate) {
      return;
    }

    state.pendingCaptures.push({ key: key, payload: payload, at: Date.now() });
    while (state.pendingCaptures.length > 12) {
      state.pendingCaptures.shift();
    }
  }

  function flushPendingCaptures() {
    if (!state.pendingCaptures.length || !currentStore()) {
      return;
    }

    const pending = state.pendingCaptures;
    state.pendingCaptures = [];
    const now = Date.now();

    for (const entry of pending) {
      // Older than a minute: repainting a completely different scene would be
      // worse than waiting for the player to fetch its next track.
      if (now - entry.at <= 60000) {
        routeCapture(entry.payload);
      }
    }
  }

  function routeCapture(payload) {
    if (!payload || !payload.cues || !payload.cues.length) {
      return;
    }

    const store = currentStore();
    if (!store) {
      bufferCapture(payload);
      return;
    }

    // A replay after an episode change can include the previous episode's
    // subtitle file. The capture script tags every payload with the media URL
    // that was playing when it arrived, so a stale file is dropped instead of
    // landing in the new session.
    const media = String(payload.media || '');
    if (!payload.replay && media && state.activeVideo) {
      // Any video this store is attached to can legitimately fetch a subtitle.
      // Comparing only against the active video dropped real captures when a
      // page had more than one <video> (an ad frame, a preview, a second
      // player), which looked like "the extension stopped working on this
      // site". A source that matches no attached player at all is the stale
      // previous-episode fetch this check exists to reject.
      const sources = new Set();
      state.attachedVideos.forEach((video) => {
        try {
          const source = String(video.currentSrc || video.src || '');
          if (source) {
            sources.add(source);
          }
        } catch (error) {
          // A detached video has no source; ignore it.
        }
      });
      try {
        const activeSource = String(state.activeVideo.currentSrc || state.activeVideo.src || '');
        if (activeSource) {
          sources.add(activeSource);
        }
      } catch (error) {
        // Same.
      }
      if (sources.size && !sources.has(media)) {
        return;
      }
    }

    // Counted before any decision, so the diagnostic can tell "the player never
    // exposed subtitles" apart from "they arrived and were rejected".
    state.capturedCount += 1;

    // A handful of cues is plenty to tell English and Turkish from anything
    // else; the file name is checked first and is the stronger signal.
    const sample = payload.cues
      .slice(0, 6)
      .map((cue) => cue.text || '')
      .join(' ');

    const verdict = DS.langDetect.classify(payload.url, sample);
    const certain = verdict.confidence === 'certain';
    let kind = verdict.lang;

    if (verdict.confidence === 'foreign') {
      // Reported so the popup can explain a page that has subtitles but shows
      // none of them.
      state.lastRefused = payload.url || '(isimsiz)';
      return;
    }

    if (!kind) {
      // Unidentified. Used only to fill a gap, never to displace anything -
      // with one exception: when the player fetched a *different* file from the
      // one currently feeding the English channel, this is the next episode's
      // subtitle, not a language variant. Rejecting it was how a series player
      // kept showing the previous episode's lines after the source changed.
      const enMeta = store.metaFor(EN);
      const replacesCapturedEnglish = Boolean(enMeta) &&
        enMeta.source === 'network-capture' &&
        String(enMeta.url || '') !== String(payload.url || '');
      const provisional = Boolean(enMeta && enMeta.confidence === 'live');

      if (replacesCapturedEnglish || provisional || !store.has(EN)) {
        // A single-line DOM capture is provisional; a complete file is better
        // even when its language had to be guessed.
        kind = EN;
      } else if (!store.has(TR)) {
        kind = TR;
      } else {
        return;
      }
    }

    // An unidentified file was put in the English channel above, which is how a
    // Turkish-only site ended up "translating" Turkish to Turkish. If the cues
    // are Turkish, they belong to the Turkish line (or nowhere).
    const correctedKind = correctSourceLanguage(store, kind, payload.cues);
    if (!correctedKind) {
      state.lastRefused = payload.url || '(isimsiz)';
      return;
    }
    kind = correctedKind;

    // A player that reuses the same <video> for the next episode often fetches
    // a *different* .vtt for the same language. The old code treated any
    // already-filled channel as final, so the previous film's cues stayed and
    // the new file was silently thrown away. A different URL or different first
    // lines means this is a different subtitle file for the same channel and
    // must win; an identical refetch only wins when its confidence is higher.
    const fingerprint = payload.cues
      .slice(0, 3)
      .map((cue) => String(cue.text || '').trim())
      .join('|');
    const existing = store.metaFor(kind);
    const sameFile = Boolean(existing) &&
      existing.source === 'network-capture' &&
      String(existing.url || '') === String(payload.url || '') &&
      (!existing.fingerprint || existing.fingerprint === fingerprint);

    // A late response for a file that was already superseded by a newer one
    // (the player finished loading the previous episode's .vtt after the next
    // episode's) must not restore the old lines. Comparing against the file that
    // last fed the English channel catches it even after a pipeline reset.
    let seenUrls = state.captureUrlsByStore.get(store);
    if (!seenUrls) {
      seenUrls = new Set();
      state.captureUrlsByStore.set(store, seenUrls);
    }
    const payloadUrl = String(payload.url || '');
    const lastUrl = state.captureLastUrlByStore.get(store) || '';
    const staleRefetch = kind === EN && payloadUrl !== lastUrl && seenUrls.has(payloadUrl);

    if (staleRefetch) {
      return;
    }
    seenUrls.add(payloadUrl);
    if (kind === EN) {
      state.captureLastUrlByStore.set(store, payloadUrl);
    }

    if (existing && sameFile && !(certain && existing.confidence !== 'certain')) {
      return;
    }

    const rebuildAutoTurkish = kind === EN && !sameFile && isAutoTranslated(store);
    if (rebuildAutoTurkish) {
      // The generated Turkish lines belong to the old English cue list.
      store.set(TR, [], { source: AUTO_TR_SOURCE });
      state.autoTrByStore.set(store, true);
    }

    store.set(kind, payload.cues, {
      source: 'network-capture',
      url: payload.url,
      confidence: verdict.confidence,
      fingerprint: fingerprint
    });

    if (rebuildAutoTurkish) {
      applyAutoTranslations(store);
    }

    // A captured track is the whole session on pages where the player keeps
    // textTracks empty. Without this the popup kept showing "unsupported" while
    // the subtitle was already rendering on screen.
    if (kind === EN) {
      setStage('active', {
        cueCount: payload.cues.length,
        adaptor: 'network-capture',
        translated: false,
        error: ''
      });
      maybeTranslateCues(state.activeVideo, store, true);
    }

    if (state.activeVideo) {
      render(state.activeVideo);
    }
  }

  // Reads the saved settings with a hard time limit. The callback of
  // chrome.storage.get normally fires in milliseconds, but a reloaded extension
  // can leave the old context with no callback at all; waiting on it used to
  // mean "no subtitles ever" or "subtitles despite the extension being off".
  function loadStoredSettings() {
    return new Promise((resolve) => {
      let settled = false;
      let timer = 0;

      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          global.clearTimeout(timer);
        }
        resolve(value && typeof value === 'object' ? value : null);
      };

      timer = global.setTimeout(() => finish(null), 1500);

      try {
        chrome.storage.local.get(DS.constants.STORAGE_SETTINGS, (stored) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            finish(null);
            return;
          }
          const saved = stored && stored[DS.constants.STORAGE_SETTINGS];
          finish(saved);
        });
      } catch (error) {
        finish(null);
      }
    });
  }

  function installSettingsListener() {
    try {
      if (!chrome.storage.onChanged) {
        return;
      }
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[DS.constants.STORAGE_SETTINGS]) {
          return;
        }
        const next = changes[DS.constants.STORAGE_SETTINGS].newValue;
        if (next && typeof next === 'object') {
          applySettings(next);
        }
      });
    } catch (error) {
      // Without the listener the page still works for this session.
    }
  }

  async function initialize() {
    if (state.initialized) {
      return;
    }

    state.initialized = true;
    state.debug = (() => {
      try {
        return /[?&]dualsub-debug=1/.test(location.search);
      } catch (error) {
        return false;
      }
    })();

    // The message listener is attached before anything else. If the cleanup
    // below ever throws, a content script that is present but deaf is far worse
    // than a leftover overlay: the popup can reopen it, hide it, or turn the
    // extension off, but it can never make a deaf script answer.
    attachRuntimeMessages();
    installKeyboardShortcuts();
    installSettingsListener();

    // Remove an overlay left behind by a previous extension instance *before*
    // doing anything else. Its content script context is dead after a reload and
    // can never hide itself, so it would otherwise sit on top of the video
    // forever even though the extension now reports itself as off.
    try {
      removeExtensionUi();
    } catch (error) {
      state.lastError = String(error && error.message ? error.message : error);
    }

    // Listen for captured subtitle bodies before waiting for settings. A player
    // that fetches its .vtt during page startup would otherwise post before this
    // frame had a listener; the MAIN-world capture dedupes the URL, so it would
    // never be offered again.
    DS.captureBridge.install(routeCapture);

    // Settings are read before the first adaptor is attached. Previously the
    // pipeline started with the default `enabled: true` and was corrected only
    // when the asynchronous read returned; a slow or failed read left subtitles
    // running while the popup showed the saved "off" state.
    const loadStartedAt = Date.now();
    const saved = await loadStoredSettings();
    if (saved && state.settingsTouchedAt < loadStartedAt) {
      applySettings(saved);
    }
    state.settingsLoaded = true;

    if (state.enabled) {
      startPipeline();
    } else {
      stopPipeline();
    }

    const boundRefresh = () => scanAndConnect();
    global.addEventListener('load', boundRefresh, { once: true });
    document.addEventListener('fullscreenchange', boundRefresh);
    global.addEventListener('resize', boundRefresh);

    // The layer is position:fixed, so it does not move when the page scrolls.
    // While a video is playing, `timeupdate` happened to re-render often enough
    // to hide this; on a paused video, or before playback, the subtitles stayed
    // glued to the old screen position while the player scrolled away. Scroll
    // events are coalesced into one layout pass per frame.
    let repositionQueued = false;
    const onViewportScroll = () => {
      if (repositionQueued) {
        return;
      }
      repositionQueued = true;
      const run = () => {
        repositionQueued = false;
        if (state.enabled && state.activeVideo && state.attachedVideos.has(state.activeVideo)) {
          render(state.activeVideo);
        }
      };
      if (typeof global.requestAnimationFrame === 'function') {
        global.requestAnimationFrame(run);
      } else {
        global.setTimeout(run, 16);
      }
    };
    document.addEventListener('scroll', onViewportScroll, { capture: true, passive: true });
    if (global.visualViewport) {
      global.visualViewport.addEventListener('resize', boundRefresh);
    }
  }

  DS.state = state;
  DS.collectState = collectState;

  const boot = () => {
    Promise.resolve()
      .then(initialize)
      .catch((error) => {
        state.lastError = String(error && error.message ? error.message : error);
        try {
          setStage('error', { error: state.lastError });
        } catch (stageError) {
          // The diagnostics record is best-effort.
        }
      });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})(typeof self !== 'undefined' ? self : this);
