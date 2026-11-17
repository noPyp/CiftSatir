// Runs in the page's MAIN world at document_start, so it sees the page's real
// `fetch` and `XMLHttpRequest`. Many players (JW Player among them) fetch
// subtitle files by XHR and paint their own caption layer, leaving
// `video.textTracks` empty and no <track> element in the DOM - so the network
// layer is the only place the cue text can be observed.
//
// The MAIN world has no access to chrome.* APIs, so captured payloads are
// handed to the ISOLATED-world bridge over window.postMessage.
(function () {
  'use strict';

  if (window.__dualsubCapture) {
    return;
  }
  window.__dualsubCapture = true;

  const CHANNEL = 'dualsub-capture';
  const SUBTITLE_EXT = /\.(vtt|srt|ttml|dfxp|ass|ssa)(?:[?#]|$)/i;
  const SUBTITLE_MIME = /(text\/vtt|application\/ttml|application\/x-subrip|text\/srt)/i;
  const MAX_BODY = 4 * 1024 * 1024;
  const seen = new Set();
  const recent = [];

  function looksLikeUrl(url) {
    return typeof url === 'string' && SUBTITLE_EXT.test(url);
  }

  function looksLikeSubtitleBody(text) {
    if (typeof text !== 'string' || text.length > MAX_BODY) {
      return false;
    }
    // Cheap sniff; the parsers do the real validation once it reaches the
    // content script.
    //
    // Besides WebVTT/SRT, YouTube's player fetches `json3` and `srv3` timed text
    // with no file extension. Those bodies must be recognised here or the
    // player's own caption request - the most reliable English source on a
    // YouTube page - would never reach the parsers.
    const head = text.slice(0, 400);
    const timedTextJson = /^\s*\{/.test(head) &&
      /"?events"?\s*:/i.test(head) &&
      /"(?:tStartMs|dDurationMs|segs)"\s*:/.test(head);
    return /^﻿?WEBVTT/.test(head) || /-->/.test(head) ||
      timedTextJson || /<transcript[\s>]/i.test(head);
  }

  // Streaming players often serve subtitles from an id-only URL with a generic
  // type (`application/octet-stream`, `text/plain`, or none at all). Trusting
  // only the file extension or the subtitle MIME misses exactly those tracks, so
  // any text-like response is worth sniffing. Media and image bodies are never
  // read: cloning a 200 MB video would cost far more than a missed subtitle.
  function worthSniffing(contentType) {
    const type = String(contentType || '').toLowerCase();
    if (!type) {
      return true;
    }
    if (/^(video|audio|image)\//.test(type)) {
      return false;
    }
    return /^(text\/|application\/(octet-stream|x-subrip|ttml\+xml|xml|json))/i.test(type) ||
      type.indexOf('vtt') !== -1;
  }

  function currentMedia() {
    try {
      const video = document.querySelector('video');
      return video ? String(video.currentSrc || video.src || '') : '';
    } catch (error) {
      return '';
    }
  }

  function publish(url, body) {
    if (!body || body.length > MAX_BODY) {
      return;
    }

    // Players re-fetch the same track on seek/quality change; dedupe by URL and
    // a cheap content hash. Length alone was not enough: a next episode can
    // serve a different .vtt with exactly the same byte length, which silently
    // dropped the new subtitles.
    let hash = 0;
    const sample = body.length > 20000 ? body.slice(0, 20000) : body;
    for (let index = 0; index < sample.length; index += 1) {
      hash = ((hash << 5) - hash + sample.charCodeAt(index)) | 0;
    }
    const key = url + ':' + body.length + ':' + hash;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    if (seen.size > 200) {
      seen.clear();
    }

    // Kept because this script runs at document_start while the content script
    // that listens for it runs at document_idle. Players that fetch their
    // subtitle during page parse (DPlayer, ArtPlayer, JW Player) finish long
    // before that listener exists; without the replay the capture is silently
    // lost. The bridge announces itself when it is ready.
    recent.push({ url: String(url || ''), body: body, media: currentMedia() });
    if (recent.length > 20) {
      recent.shift();
    }

    post(url, body, currentMedia());
  }

  function post(url, body, media, replay) {
    window.postMessage(
      {
        source: CHANNEL,
        url: String(url || ''),
        body: body,
        media: String(media || ''),
        replay: Boolean(replay),
        contentType: ''
      },
      '*'
    );
  }

  window.addEventListener('message', (event) => {
    const data = event && event.data;
    if (!data || typeof data !== 'object') {
      return;
    }
    if (data.source === 'dualsub-capture-ready' || data.source === 'dualsub-capture-replay') {
      recent.forEach((item) => post(item.url, item.body, item.media, true));
    }
  });

  function urlOf(input) {
    if (typeof input === 'string') {
      return input;
    }
    if (input && typeof input.url === 'string') {
      return input.url;
    }
    return '';
  }

  // ---- fetch ----
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      const url = urlOf(input);
      const promise = originalFetch.apply(this, arguments);

      return promise.then((response) => {
        try {
          const contentType = response.headers.get('content-type') || '';
          const size = Number(response.headers.get('content-length') || 0);
          // Streaming players often hide the format behind an id-only URL
          // (`/subtitle/12345?lang=en`), so the body is sniffed as well as the
          // declared type. Clearly non-text bodies are skipped unread.
          if (!SUBTITLE_MIME.test(contentType) && !looksLikeUrl(url) && !worthSniffing(contentType)) {
            return response;
          }
          if (size > MAX_BODY) {
            return response;
          }

          const cloned = response.clone();
          cloned.text().then((text) => {
            if (SUBTITLE_MIME.test(contentType) || looksLikeSubtitleBody(text)) {
              publish(url, text);
            }
          }).catch(() => {});
        } catch (error) {
          // A locked or already-consumed body just means no capture here.
        }
        return response;
      });
    };
  }

  // ---- XMLHttpRequest ----
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      this.__dualsubUrl = url;
      return originalOpen.apply(this, arguments);
    };

    XHR.prototype.send = function () {
      const url = this.__dualsubUrl;
      this.addEventListener('load', () => {
        try {
          const contentType = this.getResponseHeader('content-type') || '';
          const text = this.responseType === '' || this.responseType === 'text'
            ? this.responseText
            : '';

          if (!text) {
            return;
          }

          if (SUBTITLE_MIME.test(contentType) || looksLikeUrl(url) ||
            (worthSniffing(contentType) && looksLikeSubtitleBody(text))) {
            publish(url, text);
          }
        } catch (error) {
          // Cross-origin without CORS makes responseText throw; nothing to do.
        }
      });
      return originalSend.apply(this, arguments);
    };
  }

  // ---- createObjectURL ----
  // Some players download the .vtt, wrap it in a Blob and hand the blob: URL to
  // their caption renderer, which hides the real subtitle URL from the network
  // layer. Reading the blob at creation time recovers the text.
  const originalCreateObjectURL = URL.createObjectURL;
  if (typeof originalCreateObjectURL === 'function') {
    URL.createObjectURL = function (blob) {
      const objectUrl = originalCreateObjectURL.apply(this, arguments);
      try {
        if (blob && typeof blob.text === 'function') {
          blob.text().then((text) => {
            if (looksLikeSubtitleBody(text)) {
              publish(objectUrl, text);
            }
          }).catch(() => {});
        }
      } catch (error) {
        // Not a readable blob.
      }
      return objectUrl;
    };
  }
  // ---- YouTube: the English track the player did not load ----
  //
  // YouTube exposes only the caption language the viewer selected. When someone
  // watches with Turkish captions on, `video.textTracks` contains a Turkish
  // track and nothing else, so the English line stayed empty - the reported
  // "only Turkish shows on YouTube". The player's own caption track list (which
  // includes English) is available in this world, so the missing file can be
  // fetched directly and handed to the normal capture pipeline.
  const YT_HOSTS = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/;
  const ytRequested = new Set();

  function isYouTube() {
    try {
      return YT_HOSTS.test(String(window.location.hostname || ''));
    } catch (error) {
      return false;
    }
  }

  function youtubeTrackList() {
    const pick = (value) => {
      if (!value || !Array.isArray(value)) {
        return null;
      }
      return value;
    };

    try {
      const response = window.ytInitialPlayerResponse;
      const list = pick(response && response.captions &&
        response.captions.playerCaptionsTracklistRenderer &&
        response.captions.playerCaptionsTracklistRenderer.captionTracks);
      if (list && list.length) {
        return list;
      }
    } catch (error) {
      // The page object is not always reachable; fall through to the player API.
    }

    // Newer YouTube builds expose the live player response directly. On SPA
    // navigation `ytInitialPlayerResponse` can still describe the previous
    // video, while the player always knows the current one.
    try {
      const player = document.getElementById('movie_player');
      const response = player && typeof player.getPlayerResponse === 'function'
        ? player.getPlayerResponse()
        : null;
      const list = pick(response && response.captions &&
        response.captions.playerCaptionsTracklistRenderer &&
        response.captions.playerCaptionsTracklistRenderer.captionTracks);
      if (list && list.length) {
        return list;
      }
    } catch (error) {
      // Not every build exposes it.
    }

    try {
      const player = document.getElementById('movie_player');
      const list = player && typeof player.getOption === 'function'
        ? pick(player.getOption('captions', 'tracklist'))
        : null;
      if (list && list.length) {
        return list;
      }
    } catch (error) {
      // Same.
    }

    return [];
  }

  function timedTextUrl(base, fmt) {
    try {
      const parsed = new URL(base, window.location.href);
      parsed.searchParams.set('fmt', fmt);
      return parsed.toString();
    } catch (error) {
      return base + (base.indexOf('?') === -1 ? '?' : '&') + 'fmt=' + fmt;
    }
  }

  function fetchTimedText(url) {
    return originalFetch.call(window, url, { credentials: 'include' })
      .then((response) => (response && response.ok ? response.text() : ''))
      .catch(() => '');
  }

  function isEnglishCode(code) {
    const value = String(code || '').toLowerCase();
    return value === 'en' || value.indexOf('en-') === 0 || value === 'en-us' || value === 'en-gb';
  }

  // The video currently open, as an id rather than a URL. YouTube is a single
  // page app: the same document is reused for the next video, so "already
  // fetched this file" state must be reset when the id changes or returning to
  // a previously watched video would keep the previous video's English line.
  function currentYouTubeVideoKey() {
    try {
      const url = new URL(window.location.href);
      const fromQuery = url.searchParams.get('v');
      if (fromQuery) {
        return fromQuery;
      }
      const match = /\/(?:shorts|embed|live)\/([\w-]{6,})/.exec(url.pathname);
      if (match) {
        return match[1];
      }
      if (/(^|\.)youtu\.be$/.test(url.hostname)) {
        return url.pathname.replace(/^\//, '');
      }
      return '';
    } catch (error) {
      return '';
    }
  }

  let ytVideoKey = '';

  function harvestYouTube() {
    if (!isYouTube()) {
      return;
    }

    // Only worth asking while a player is actually on the page. YouTube's home
    // and search pages have no video and no caption list, so this keeps the
    // interval idle there.
    if (document.hidden || !document.querySelector('video')) {
      return;
    }

    const videoKey = currentYouTubeVideoKey();
    if (videoKey && videoKey !== ytVideoKey) {
      ytVideoKey = videoKey;
      ytRequested.clear();
      // The previous video's English file was already published once; the new
      // video needs its own, and the global content dedupe must not eat it.
      seen.clear();
    }

    for (const track of youtubeTrackList()) {
      if (!track || !isEnglishCode(track.languageCode || track.language)) {
        continue;
      }

      const base = String(track.baseUrl || track.url || '');
      if (!base || ytRequested.has(base)) {
        continue;
      }
      ytRequested.add(base);
      if (ytRequested.size > 50) {
        ytRequested.clear();
      }

      // WebVTT is the simplest format to read. YouTube's track URL already
      // carries a `fmt` parameter (usually `srv3`), so the existing value is
      // replaced instead of relying on duplicate-parameter precedence.
      //
      // Auto-generated tracks are the exception: for `kind=asr` the VTT body can
      // come back empty (the player uses `json3` for those). Falling back to
      // json3 is what makes the English line appear on videos that only ship an
      // automatic English track - the "YouTube shows only Turkish" case.
      const vttUrl = timedTextUrl(base, 'vtt');

      fetchTimedText(vttUrl)
        .then((text) => {
          if (text && /-->/.test(text) && looksLikeSubtitleBody(text)) {
            publish(vttUrl, text);
            return null;
          }

          const jsonUrl = timedTextUrl(base, 'json3');
          return fetchTimedText(jsonUrl).then((json) => {
            if (json && looksLikeSubtitleBody(json)) {
              publish(jsonUrl, json);
              return null;
            }

            const srvUrl = timedTextUrl(base, 'srv3');
            return fetchTimedText(srvUrl).then((xml) => {
              if (xml && looksLikeSubtitleBody(xml)) {
                publish(srvUrl, xml);
                return null;
              }
              // A restricted or expired URL is not fatal: the selected track
              // still renders, only the second line is missing. Retry later.
              ytRequested.delete(base);
              return null;
            });
          });
        })
        .catch(() => {
          ytRequested.delete(base);
        });
    }
  }

  if (isYouTube()) {
    // The caption list appears after the player boots, and SPA navigation
    // replaces it without a page load. The tick is cheap (an empty early return
    // when there is no video) and every track URL is fetched at most once.
    setInterval(harvestYouTube, 4000);
  }
})();
