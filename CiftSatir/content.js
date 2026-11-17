(() => {
  const SAMPLE_CAPTIONS = {
    en: [
      { start: 0, end: 3, text: 'Hello, how are you?' },
      { start: 3, end: 6, text: "I'm learning English." },
      { start: 6, end: 10, text: 'I want to understand movies.' }
    ],
    tr: [
      { start: 0, end: 3, text: 'Merhaba, nasılsın?' },
      { start: 3, end: 6, text: 'İngilizce öğreniyorum.' },
      { start: 6, end: 10, text: 'Filmleri anlamak istiyorum.' }
    ]
  };

  const state = {
    enabled: true,
    activeVideo: null,
    attachedVideos: new Set(),
    overlayByVideo: new WeakMap(),
    layoutByVideo: new WeakMap(),
    resizeObservers: new Map(),
    observer: null,
    initialized: false
  };

  function isVideoElement(value) {
    return value instanceof HTMLVideoElement && value.isConnected;
  }

  function getCaptionAt(entries, time) {
    if (!Array.isArray(entries) || !entries.length || !Number.isFinite(time)) {
      return null;
    }

    return entries.find((entry) => time >= entry.start && time < entry.end) || null;
  }

  function setTextIfChanged(element, text) {
    if (!element || element.textContent === text) {
      return false;
    }

    element.textContent = text;
    return true;
  }

  function setStyleIfChanged(element, property, value) {
    if (element.style.getPropertyValue(property) !== value) {
      element.style.setProperty(property, value);
    }
  }

  function hideOverlay(overlay) {
    if (!overlay) {
      return;
    }

    if (!overlay.classList.contains('is-hidden')) {
      overlay.classList.add('is-hidden');
    }
    const enLine = overlay.querySelector('.dualsub-line.en');
    const trLine = overlay.querySelector('.dualsub-line.tr');
    setTextIfChanged(enLine, '');
    setTextIfChanged(trLine, '');
  }

  function positionOverlay(overlay, video, forceMeasure) {
    const fullscreenRoot = document.fullscreenElement;
    const target = fullscreenRoot && fullscreenRoot !== video && fullscreenRoot.contains(video)
      ? fullscreenRoot
      : document.documentElement;

    if (overlay.parentElement !== target) {
      target.appendChild(overlay);
    }

    const videoRect = getVisibleVideoRect(video);
    if (!videoRect) {
      return false;
    }

    const fontSize = Math.max(10, Math.min(36, videoRect.width * 0.045, videoRect.height * 0.1));
    const controlSpace = Math.min(72, Math.max(24, videoRect.height * 0.2));
    const layout = {
      target,
      left: videoRect.left + videoRect.width / 2,
      bottom: Math.max(12, window.innerHeight - videoRect.bottom + controlSpace),
      width: Math.min(videoRect.width * 0.9, 720),
      fontSize,
      top: videoRect.top,
      height: videoRect.height,
      viewportHeight: window.innerHeight
    };
    const previousLayout = state.layoutByVideo.get(video);
    const layoutUnchanged = previousLayout &&
      Object.keys(layout).every((key) => layout[key] === previousLayout[key]) &&
      overlay.parentElement === target;

    if (layoutUnchanged && !forceMeasure) {
      return true;
    }

    setStyleIfChanged(overlay, 'left', `${layout.left}px`);
    setStyleIfChanged(overlay, 'bottom', `${layout.bottom}px`);
    setStyleIfChanged(overlay, 'width', `${layout.width}px`);
    setStyleIfChanged(overlay, '--dualsub-font-size', `${fontSize}px`);

    let fittedFontSize = fontSize;
    let overlayRect = overlay.getBoundingClientRect();
    while (
      fittedFontSize > 10 &&
      (overlayRect.top < videoRect.top + 4 ||
        overlayRect.left < videoRect.left + 4 ||
        overlayRect.right > videoRect.right - 4)
    ) {
      fittedFontSize = Math.max(10, fittedFontSize - 1);
      setStyleIfChanged(overlay, '--dualsub-font-size', `${fittedFontSize}px`);
      overlayRect = overlay.getBoundingClientRect();
    }

    if (
      overlayRect.top < videoRect.top + 4 ||
      overlayRect.left < videoRect.left + 4 ||
      overlayRect.right > videoRect.right - 4 ||
      overlayRect.bottom > videoRect.bottom - controlSpace + 1
    ) {
      return false;
    }

    state.layoutByVideo.set(video, layout);
    return true;
  }

  function updateOverlay(overlay, video) {
    if (!overlay || !video) {
      return;
    }

    if (state.activeVideo !== video || !state.enabled) {
      hideOverlay(overlay);
      return;
    }

    if (document.fullscreenElement === video) {
      hideOverlay(overlay);
      return;
    }

    const currentTime = Number(video.currentTime) || 0;
    const englishCaption = getCaptionAt(SAMPLE_CAPTIONS.en, currentTime);
    const turkishCaption = getCaptionAt(SAMPLE_CAPTIONS.tr, currentTime);
    const enLine = overlay.querySelector('.dualsub-line.en');
    const trLine = overlay.querySelector('.dualsub-line.tr');

    if (!enLine || !trLine) {
      return;
    }

    if (!englishCaption && !turkishCaption) {
      hideOverlay(overlay);
      return;
    }

    const englishChanged = setTextIfChanged(enLine, englishCaption ? englishCaption.text : '');
    const turkishChanged = setTextIfChanged(trLine, turkishCaption ? turkishCaption.text : '');
    const textChanged = englishChanged || turkishChanged;
    const wasHidden = overlay.classList.contains('is-hidden');
    overlay.classList.remove('is-hidden');

    if (!positionOverlay(overlay, video, textChanged || wasHidden)) {
      hideOverlay(overlay);
    }
  }

  function createOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'dualsub-layer is-hidden';

    const englishLine = document.createElement('div');
    englishLine.className = 'dualsub-line en';
    englishLine.setAttribute('aria-live', 'polite');

    const turkishLine = document.createElement('div');
    turkishLine.className = 'dualsub-line tr';
    turkishLine.setAttribute('aria-live', 'polite');

    overlay.appendChild(englishLine);
    overlay.appendChild(turkishLine);
    return overlay;
  }

  function cleanupVideo(video) {
    if (!(video instanceof HTMLVideoElement)) {
      return;
    }

    const overlay = state.overlayByVideo.get(video);
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }

    if (video.__dualsubHandlers) {
      for (const [eventName, handler] of Object.entries(video.__dualsubHandlers)) {
        video.removeEventListener(eventName, handler);
      }
      delete video.__dualsubHandlers;
    }

    state.overlayByVideo.delete(video);
    state.layoutByVideo.delete(video);
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

  function bindVideo(video) {
    if (!isVideoElement(video) || state.attachedVideos.has(video)) {
      return;
    }

    const overlay = createOverlay();
    document.documentElement.appendChild(overlay);
    state.overlayByVideo.set(video, overlay);
    state.attachedVideos.add(video);

    const sync = () => updateOverlay(overlay, video);
    const onEnded = () => {
      const currentTime = Number(video.currentTime) || 0;
      if (video.ended || currentTime >= Number(video.duration || 0)) {
        hideOverlay(overlay);
      }
      refreshActiveVideo();
      refreshActiveOverlay();
    };

    const onPlaybackChange = () => {
      refreshActiveVideo();
      refreshActiveOverlay();
    };

    const handlers = {
      timeupdate: sync,
      play: onPlaybackChange,
      pause: onPlaybackChange,
      seeking: sync,
      seeked: sync,
      ended: onEnded,
      loadedmetadata: sync,
      fullscreenchange: sync,
      resize: sync
    };

    Object.entries(handlers).forEach(([eventName, handler]) => {
      video.addEventListener(eventName, handler);
    });

    video.__dualsubHandlers = handlers;
    if (typeof ResizeObserver === 'function') {
      const resizeObserver = new ResizeObserver(() => updateOverlay(overlay, video));
      resizeObserver.observe(video);
      state.resizeObservers.set(video, resizeObserver);
    }
    updateOverlay(overlay, video);
  }

  function isVisibleVideo(video) {
    if (!isVideoElement(video)) {
      return false;
    }

    for (let element = video; element; element = element.parentElement) {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
        style.contentVisibility === 'hidden' || Number(style.opacity) === 0) {
        return false;
      }
    }

    return Boolean(getVisibleVideoRect(video));
  }

  function getVisibleVideoRect(video) {
    const rect = video.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    const width = right - left;
    const height = bottom - top;

    if (width <= 20 || height <= 20) {
      return null;
    }

    return { left, top, right, bottom, width, height };
  }

  function pickBestVideo(videos) {
    const fullscreenElement = document.fullscreenElement;
    const candidates = Array.from(videos).filter((video) => isVideoElement(video) && isVisibleVideo(video));
    if (!candidates.length) {
      return null;
    }

    return candidates
      .map((video) => {
        const rect = getVisibleVideoRect(video);
        return {
          video,
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

  function refreshActiveVideo() {
    const videos = document.querySelectorAll('video');
    const nextVideo = pickBestVideo(videos);

    if (state.activeVideo && state.activeVideo !== nextVideo && state.activeVideo.isConnected) {
      const activeOverlay = state.overlayByVideo.get(state.activeVideo);
      if (activeOverlay) {
        hideOverlay(activeOverlay);
      }
    }

    if (state.activeVideo && state.activeVideo !== nextVideo && !state.activeVideo.isConnected) {
      cleanupVideo(state.activeVideo);
    }

    if (nextVideo && state.activeVideo !== nextVideo) {
      if (state.activeVideo && state.activeVideo !== nextVideo) {
        cleanupVideo(state.activeVideo);
      }
      state.activeVideo = nextVideo;
      bindVideo(nextVideo);
      const overlay = state.overlayByVideo.get(nextVideo);
      updateOverlay(overlay, nextVideo);
      return;
    }

    if (!state.activeVideo && nextVideo) {
      state.activeVideo = nextVideo;
      bindVideo(nextVideo);
      const overlay = state.overlayByVideo.get(nextVideo);
      updateOverlay(overlay, nextVideo);
      return;
    }

    if (!nextVideo && state.activeVideo) {
      cleanupVideo(state.activeVideo);
    }
  }

  function pruneDetachedVideos() {
    Array.from(state.attachedVideos).forEach((video) => {
      if (!video.isConnected) {
        cleanupVideo(video);
      }
    });
  }

  function scanAndConnect() {
    refreshActiveVideo();
    pruneDetachedVideos();
    const allVideos = Array.from(document.querySelectorAll('video'));
    allVideos.forEach((video) => {
      if (!state.attachedVideos.has(video)) {
        bindVideo(video);
      }
      const overlay = state.overlayByVideo.get(video);
      if (overlay) {
        updateOverlay(overlay, video);
      }
    });
  }

  function refreshActiveOverlay() {
    if (!state.activeVideo) {
      return;
    }

    const overlay = state.overlayByVideo.get(state.activeVideo);
    updateOverlay(overlay, state.activeVideo);
  }

  function refreshAfterScroll() {
    refreshActiveVideo();
    refreshActiveOverlay();
  }

  function installObserver() {
    if (state.observer) {
      return;
    }

    state.observer = new MutationObserver((records) => {
      const hasPageMutation = records.some((record) => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        return !target || !target.closest('.dualsub-layer');
      });

      if (hasPageMutation) {
        scanAndConnect();
      }
    });

    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'poster', 'controls', 'style']
    });
  }

  function collectState() {
    const video = pickBestVideo(document.querySelectorAll('video'));
    return {
      enabled: state.enabled,
      hasVideo: Boolean(video),
      videoDetected: Boolean(video),
      englishOn: state.enabled,
      turkishOn: state.enabled,
      message: video ? 'Video detected and ready for ÇiftSatır.' : 'No HTML5 video was detected on this page.'
    };
  }

  function attachRuntimeMessages() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || typeof message !== 'object') {
        return false;
      }

      if (message.type === 'toggle-subtitles') {
        state.enabled = !state.enabled;
        if (state.activeVideo) {
          const overlay = state.overlayByVideo.get(state.activeVideo);
          updateOverlay(overlay, state.activeVideo);
        }
        sendResponse(collectState());
        return true;
      }

      if (message.type === 'get-state') {
        sendResponse(collectState());
        return true;
      }

      return false;
    });
  }

  function initialize() {
    if (state.initialized) {
      return;
    }

    state.initialized = true;
    attachRuntimeMessages();
    scanAndConnect();
    installObserver();

    const boundRefresh = () => {
      scanAndConnect();
    };

    window.addEventListener('load', boundRefresh, { once: true });
    document.addEventListener('fullscreenchange', boundRefresh);
    window.addEventListener('resize', boundRefresh);
    window.addEventListener('scroll', refreshAfterScroll, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
