(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});

  // Receives subtitle payloads published by the MAIN-world capture script.
  // Chrome extensions cannot inject into the MAIN world's scope, so the only
  // channel is window.postMessage; the origin is checked to make sure the
  // message really came from this window and is one of ours.
  function install(onPayload) {
    global.addEventListener('message', (event) => {
      if (event.source !== global) {
        return;
      }

      const data = event.data;
      if (!data || typeof data !== 'object' || data.source !== 'dualsub-capture') {
        return;
      }

      const url = String(data.url || '');
      const body = String(data.body || '');
      if (!body) {
        return;
      }

      // A blob: URL tells us nothing about the channel; the parse result is
      // offered to whichever channel is still empty.
      const cues = DS.parsers.parse(body, url);
      if (!cues.length) {
        return;
      }

      onPayload({
        url: url,
        media: String(data.media || ''),
        replay: Boolean(data.replay),
        cues: cues
      });
    });

    // The capture script runs at document_start and buffers anything that
    // arrived before this listener existed; asking for a replay now is what
    // makes early fetches usable. Sent after the listener is registered.
    try {
      global.postMessage({ source: 'dualsub-capture-ready' }, '*');
    } catch (error) {
      // Without postMessage there is no capture path anyway.
    }
  }

  // A player that swaps to the next episode can fetch the new subtitle before
  // the content script notices the new source and clears the old store. Asking
  // for the recent payloads again after that reset makes the new file win.
  function replay() {
    try {
      global.postMessage({ source: 'dualsub-capture-replay' }, '*');
    } catch (error) {
      // Nothing to replay without postMessage.
    }
  }

  DS.captureBridge = { install: install, replay: replay };
})(typeof self !== 'undefined' ? self : this);
