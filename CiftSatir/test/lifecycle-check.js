/* Lifecycle test: the cases the happy-path test cannot see.
 *
 * live-check.js proves the extension works on a simple page. This one proves it
 * keeps working when the page changes underneath it, which is where the real
 * "sometimes the subtitles disappear" reports come from:
 *
 *   - video added after load / video element replaced
 *   - the same element gets a new video (YouTube's SPA navigation)
 *   - the <track> is attached seconds after playback started
 *   - the subtitle layer on a very short video
 *   - scrolling the page while the video is paused
 *   - turning the extension and each language line off and on
 *   - translation failing and then recovering
 *
 * Every case runs in a real Chromium (Edge) with the unpacked extension.
 *
 *   node test/lifecycle-check.js
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { chromium } = require(path.resolve('C:\\Users\\fatih\\ceviri-projesi\\node_modules\\playwright-core'));

const root = path.resolve(__dirname, '..');
const testsDir = path.join(root, 'test');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 5331;
const BASE = 'http://127.0.0.1:' + PORT + '/';

let failures = 0;
let checks = 0;

function check(label, okValue, detail) {
  checks += 1;
  if (!okValue) {
    failures += 1;
    console.log('FAIL  ' + label + (detail !== undefined ? '  (' + detail + ')' : ''));
    return false;
  }
  console.log('ok    ' + label);
  return true;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8'
};

const SHELL = (body, extraCss) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>ÇiftSatır lifecycle</title>
    <style>
      body { margin: 0; background: #1b1b1b; color: #eee; font-family: Arial, sans-serif; }
      video { display: block; width: 640px; height: 360px; background: #000; }
      .spacer { height: 500px; }
      ${extraCss || ''}
    </style>
  </head>
  <body>${body}</body>
</html>`;

const PAGES = {
  'life-baseline.html': SHELL(`
    <video id="v" playsinline preload="auto">
      <track id="t" kind="subtitles" srclang="en" label="English" src="/sample.vtt" default />
    </video>`),
  'life-short.html': SHELL(`
    <div style="height:120px"></div>
    <video id="v" playsinline preload="auto" style="width:360px;height:150px">
      <track id="t" kind="subtitles" srclang="en" label="English" src="/sample.vtt" default />
    </video>`, 'video{width:360px;height:150px;}'),
  'life-scroll.html': SHELL(`
    <div class="spacer" style="height:100px"></div>
    <video id="v" playsinline preload="auto" style="width:640px;height:300px">
      <track id="t" kind="subtitles" srclang="en" label="English" src="/sample.vtt" default />
    </video>
    <div class="spacer"></div>`, 'video{width:640px;height:300px;}'),
  'life-late.html': SHELL(`
    <video id="v" playsinline preload="auto"></video>`),
  'life-swap.html': SHELL(`
    <video id="v" playsinline preload="auto">
      <track id="t" kind="subtitles" srclang="en" label="English" src="/sample.vtt" default />
    </video>`),
  'life-replace.html': SHELL(`
    <video id="old" playsinline preload="auto">
      <track kind="subtitles" srclang="en" label="English" src="/sample.vtt" default />
    </video>`),
  'life-notrack.html': SHELL(`
    <video id="v" playsinline preload="auto"></video>`),
  'life-tronly.html': SHELL(`
    <video id="v" playsinline preload="auto">
      <track id="t" kind="subtitles" srclang="tr" label="Türkçe" src="/sample.tr.vtt" default />
    </video>`),
  'life-trunknown.html': SHELL(`
    <video id="v" playsinline preload="auto">
      <track id="t" kind="subtitles" label="Altyazı" src="/sample.tr.vtt" default />
    </video>`),
  'life-fullscreen.html': SHELL(`
    <div id="player" style="background:#000;width:640px;height:360px">
      <video id="v" playsinline preload="auto" style="width:640px;height:360px">
        <track id="t" kind="subtitles" srclang="en" label="English" src="/sample.vtt" default />
      </video>
    </div>
    <button id="fs" type="button">fullscreen</button>
    <script>
      document.getElementById('fs').addEventListener('click', () => {
        const player = document.getElementById('player');
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else if (player.requestFullscreen) {
          player.requestFullscreen();
        }
      });
    </script>`)
};

function startServer() {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'life-baseline.html';

    if (PAGES[name]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGES[name]);
      return;
    }

    const file = path.join(testsDir, name);
    if (!file.startsWith(testsDir)) {
      res.writeHead(403).end();
      return;
    }

    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });

  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

/* ---------- page helpers ---------- */

async function openCase(context, name) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(BASE + name, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.dualsub-layer', { state: 'attached', timeout: 15000 }).catch(() => {});
  return page;
}

async function seek(page, seconds) {
  await page.evaluate((value) => {
    const video = document.querySelector('video');
    if (!video) {
      return;
    }
    try { video.currentTime = value; } catch (error) { /* no media */ }
    video.dispatchEvent(new Event('timeupdate'));
    video.dispatchEvent(new Event('seeked'));
  }, seconds);
}

async function state(page) {
  return page.evaluate(() => {
    const layer = document.querySelector('.dualsub-layer');
    const en = document.querySelector('.dualsub-layer .dualsub-line.en');
    const tr = document.querySelector('.dualsub-layer .dualsub-line.tr');
    const video = document.querySelector('video');
    const layerRect = layer ? layer.getBoundingClientRect() : null;
    const videoRect = video ? video.getBoundingClientRect() : null;

    const visible = (element) => {
      if (!element) {
        return false;
      }
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    return {
      layers: document.querySelectorAll('.dualsub-layer').length,
      panels: document.querySelectorAll('.dualsub-panel').length,
      videos: document.querySelectorAll('video').length,
      layerVisible: visible(layer),
      enVisible: visible(en),
      trVisible: visible(tr),
      enText: en ? en.textContent.trim() : '',
      trText: tr ? tr.textContent.trim() : '',
      layerTop: layerRect ? Math.round(layerRect.top) : null,
      layerBottom: layerRect ? Math.round(layerRect.bottom) : null,
      videoTop: videoRect ? Math.round(videoRect.top) : null,
      videoBottom: videoRect ? Math.round(videoRect.bottom) : null,
      words: document.querySelectorAll('.dualsub-layer .dualsub-word').length,
      currentTime: video ? video.currentTime : null,
      paused: video ? video.paused : null
    };
  });
}

async function waitForText(page, pattern, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000);
  while (Date.now() < deadline) {
    const info = await state(page);
    if (pattern.test(info.enText + ' ' + info.trText)) {
      return info;
    }
    await page.waitForTimeout(200);
  }
  return state(page);
}

async function sendToPage(worker, page, message) {
  // Several test tabs can share a URL (the same harness page is reopened), so
  // matching on the URL alone can talk to the wrong tab. Bring the page to the
  // front and use the active tab instead.
  await page.bringToFront();
  return worker.evaluate(async (payload) => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || typeof tab.id !== 'number') {
      return null;
    }
    try {
      return await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, payload, (value) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(value);
        });
      });
    } catch (error) {
      return null;
    }
  }, message).catch(() => null);
}

(async () => {
  const server = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dualsub-life-'));
  let context;
  let worker = null;

  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: EDGE,
      headless: true,
      args: [
        '--disable-extensions-except=' + root,
        '--load-extension=' + root,
        '--no-first-run',
        '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio'
      ]
    });

    let workers = context.serviceWorkers();
    if (!workers.length) {
      workers = [await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null)].filter(Boolean);
    }
    worker = workers[0] || null;
    check('service worker is running', Boolean(worker), worker ? 'ok' : 'no worker');

    /* ---------- 1. baseline ---------- */

    let page = await openCase(context, 'life-baseline.html');
    await seek(page, 1);
    let info = await waitForText(page, /Hello, how are you/, 10000);
    check('baseline: a real cue is shown', /Hello, how are you/.test(info.enText), JSON.stringify(info.enText));
    check('baseline: words are clickable', info.words >= 4, String(info.words));
    check('baseline: exactly one overlay', info.layers === 1, String(info.layers));

    const diagState = await sendToPage(worker, page, { type: 'get-state' });
    check('diagnostics: the active stage is reported',
      Boolean(diagState) && diagState.stage === 'active' && diagState.cueCount > 0,
      JSON.stringify(diagState && { stage: diagState.stage, cues: diagState.cueCount }));
    check('diagnostics: platform and source are reported',
      Boolean(diagState) && Boolean(diagState.platform) && diagState.adaptor === 'generic-track',
      JSON.stringify(diagState && { platform: diagState.platform, adaptor: diagState.adaptor }));

    const diagReport = await sendToPage(worker, page, { type: 'diagnose' });
    check('diagnostics: diagnose explains the pipeline stage',
      Boolean(diagReport) && diagReport.stage === 'active' && diagReport.layer === 'görünür',
      JSON.stringify(diagReport && { stage: diagReport.stage, layer: diagReport.layer }));

    /* ---------- 2. short video ---------- */

    // A 150px-tall player is common for embedded players. The overlay used to be
    // hidden outright when the two lines did not fit above the controls.
    const shortPage = await openCase(context, 'life-short.html');
    await seek(shortPage, 1);
    info = await waitForText(shortPage, /Hello, how are you/, 10000);
    check('short video: the cue is still visible', info.layerVisible && /Hello, how are you/.test(info.enText),
      JSON.stringify({ visible: info.layerVisible, text: info.enText }));
    check('short video: layer stays inside the viewport',
      info.layerTop !== null && info.layerTop >= 0 && info.layerBottom <= 600,
      JSON.stringify({ top: info.layerTop, bottom: info.layerBottom }));
    await shortPage.close();

    /* ---------- 3. scrolling while paused ---------- */

    const scrollPage = await openCase(context, 'life-scroll.html');
    await seek(scrollPage, 1);
    await waitForText(scrollPage, /Hello, how are you/, 8000);
    const before = await state(scrollPage);
    await scrollPage.evaluate(() => window.scrollBy(0, 80));
    await scrollPage.waitForTimeout(500);
    const after = await state(scrollPage);

    // Compare the bottom edge, not the top: when the Turkish line arrives
    // between the two measurements the layer gains a line and its top moves up
    // by the extra text height. The bottom edge is the anchored side.
    check('scroll: the layer follows the video',
      before.layerBottom !== null && after.layerBottom !== null &&
      Math.abs((before.layerBottom - after.layerBottom) - 80) <= 6,
      JSON.stringify({
        before: before.layerBottom,
        after: after.layerBottom,
        beforeVideo: before.videoTop,
        afterVideo: after.videoTop,
        scrollY: await scrollPage.evaluate(() => window.scrollY)
      }));
    check('scroll: the layer stays visible while the video is paused',
      after.layerVisible, JSON.stringify({ visible: after.layerVisible, videoTop: after.videoTop }));
    await scrollPage.close();

    /* ---------- 4. a <track> that appears late ---------- */

    // Heavy players attach their subtitle track seconds after playback starts.
    // Retrying only on the first play event missed this and left the page blank.
    const latePage = await openCase(context, 'life-late.html');
    await latePage.evaluate(() => {
      const video = document.querySelector('video');
      const play = video.play();
      if (play && play.catch) {
        play.catch(() => {});
      }
    });
    await latePage.waitForTimeout(3500);
    await latePage.evaluate(() => {
      const video = document.querySelector('video');
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.srclang = 'en';
      track.label = 'English';
      track.src = '/sample.vtt';
      track.default = true;
      video.appendChild(track);
      try { track.track.mode = 'hidden'; } catch (error) { /* lazy track */ }
    });
    await latePage.waitForTimeout(1500);
    await seek(latePage, 1);
    info = await waitForText(latePage, /Hello, how are you/, 10000);
    check('late track: arriving after playback still shows subtitles',
      /Hello, how are you/.test(info.enText), JSON.stringify(info.enText));
    await latePage.close();

    /* ---------- 5. cue list that grows on the same track ---------- */

    // HLS/live players append cues to a track that is already attached. That is
    // the same subtitle, not a new video: the session must not tear itself down
    // and rebuild on every appended cue.
    const growPage = await openCase(context, 'life-baseline.html');
    await seek(growPage, 1);
    await waitForText(growPage, /Hello, how are you/, 8000);

    const growResult = await growPage.evaluate(() => {
      const video = document.querySelector('video');
      const track = video.textTracks[0];
      track.mode = 'hidden';
      const before = track.cues ? track.cues.length : 0;
      try {
        track.addCue(new VTTCue(24.5, 26.5, 'A late cue arrives now.'));
      } catch (error) {
        return { supported: false, error: String(error) };
      }
      return { supported: true, before: before, after: track.cues.length };
    });

    if (growResult.supported) {
      await seek(growPage, 25);
      info = await waitForText(growPage, /A late cue arrives now/, 8000);
      check('growing cue list: the appended cue is shown',
        /A late cue arrives now/.test(info.enText), JSON.stringify(info.enText));
      check('growing cue list: exactly one overlay remains', info.layers === 1, String(info.layers));
    } else {
      check('growing cue list: VTTCue is unavailable in this browser (skipped)', true,
        growResult.error);
    }
    await growPage.close();

    /* ---------- 6. same video element, new subtitle track (SPA navigation) ---------- */

    // YouTube does not create a new <video> when you open the next video. The
    // old cue list stayed in the store, so the overlay kept showing the previous
    // video's line - or nothing at all, because "cues exist" blocked re-attach.
    const swapPage = await openCase(context, 'life-swap.html');
    await seek(swapPage, 1);
    await waitForText(swapPage, /Hello, how are you/, 8000);

    await swapPage.evaluate(() => {
      const video = document.querySelector('video');
      const old = document.getElementById('t');
      if (old) {
        old.remove();
      }
      const track = document.createElement('track');
      track.id = 't2';
      track.kind = 'subtitles';
      track.srclang = 'en';
      track.label = 'English';
      track.src = '/sample2.vtt';
      track.default = true;
      video.appendChild(track);
      try { track.track.mode = 'hidden'; } catch (error) { /* lazy */ }
    });
    await swapPage.waitForTimeout(1200);
    await seek(swapPage, 1);
    info = await waitForText(swapPage, /Content type capture works/, 8000);

    check('swapped track: the new subtitle replaces the old one',
      /Content type capture works/.test(info.enText), JSON.stringify(info.enText));
    check('swapped track: the previous line is not left behind',
      !/Hello, how are you/.test(info.enText), JSON.stringify(info.enText));
    await swapPage.close();

    /* ---------- 6b. Turkish-only source ---------- */

    // A site can offer a Turkish track and no English one. The English line must
    // stay empty instead of keeping whatever sentence was there before (or
    // showing the Turkish text twice).
    const trOnlyPage = await openCase(context, 'life-tronly.html');
    await seek(trOnlyPage, 1);
    info = await waitForText(trOnlyPage, /Merhaba, bugün nasılsın/, 10000);
    check('Turkish-only source: the Turkish line is shown',
      /Merhaba, bugün nasılsın/.test(info.trText), JSON.stringify(info.trText));
    check('Turkish-only source: the English line is empty',
      info.enText === '' && info.trVisible, JSON.stringify({ en: info.enText, tr: info.trText }));
    check('Turkish-only source: exactly one overlay', info.layers === 1, String(info.layers));
    await trOnlyPage.close();

    // The reported bug: the site's only subtitle file is Turkish but carries no
    // srclang. The English channel used to take it and the translator translated
    // Turkish into Turkish, producing a second, machine-mangled line.
    const trUnknownPage = await openCase(context, 'life-trunknown.html');
    await seek(trUnknownPage, 1);
    info = await waitForText(trUnknownPage, /Merhaba, bugün nasılsın/, 10000);
    check('unlabelled Turkish track: the Turkish line is shown once',
      /Merhaba, bugün nasılsın/.test(info.trText), JSON.stringify(info.trText));
    check('unlabelled Turkish track: the English line stays empty',
      info.enText === '', JSON.stringify(info.enText));
    check('unlabelled Turkish track: the two lines are never the same text',
      info.enText !== info.trText, JSON.stringify({ en: info.enText, tr: info.trText }));

    // Give the translator time to run. If the Turkish cues had stayed in the
    // English channel, its auto-translation would have owned the Turkish line
    // by now and this source would read "auto-translate".
    await trUnknownPage.waitForTimeout(2500);
    const trUnknownState = await sendToPage(worker, trUnknownPage, { type: 'get-state' });
    check('unlabelled Turkish track: no Turkish-to-Turkish translation ran',
      Boolean(trUnknownState) && trUnknownState.trSource !== 'auto-translate',
      JSON.stringify({ trSource: trUnknownState && trUnknownState.trSource }));
    info = await state(trUnknownPage);
    check('unlabelled Turkish track: the line is unchanged after the translator tick',
      /Merhaba, bugün nasılsın/.test(info.trText) && info.layers === 1,
      JSON.stringify({ tr: info.trText, layers: info.layers }));
    await trUnknownPage.close();

    /* ---------- 6. new video element replaces the old one ---------- */

    const replacePage = await openCase(context, 'life-replace.html');
    await seek(replacePage, 1);
    await waitForText(replacePage, /Hello, how are you/, 8000);

    await replacePage.evaluate(() => {
      const old = document.getElementById('old');
      old.remove();
      const video = document.createElement('video');
      video.id = 'new';
      video.setAttribute('playsinline', '');
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.srclang = 'en';
      track.label = 'English';
      track.src = '/sample2.vtt';
      track.default = true;
      video.appendChild(track);
      document.body.appendChild(video);
      try { track.track.mode = 'hidden'; } catch (error) { /* lazy */ }
    });
    await replacePage.waitForTimeout(1500);
    await seek(replacePage, 1);
    info = await waitForText(replacePage, /Content type capture works/, 10000);

    check('replaced video: the new video is picked up',
      /Content type capture works/.test(info.enText), JSON.stringify(info.enText));
    check('replaced video: the old overlay is removed', info.layers === 1, String(info.layers));
    await replacePage.close();

    /* ---------- 7. no subtitle track ---------- */

    const noTrackPage = await openCase(context, 'life-notrack.html');
    await seek(noTrackPage, 1);
    await noTrackPage.waitForTimeout(2500);
    info = await state(noTrackPage);
    check('no track: no invented subtitle is shown', info.enText === '' && !info.layerVisible,
      JSON.stringify({ text: info.enText, visible: info.layerVisible }));

    const noTrackState = await sendToPage(worker, noTrackPage, { type: 'get-state' });
    check('no track: the page reports that no cue exists',
      Boolean(noTrackState) && noTrackState.hasEnglishCues === false, JSON.stringify(noTrackState));
    await noTrackPage.close();

    /* ---------- 8. fullscreen enter/leave ---------- */

    // The layer must follow the player into the fullscreen element; only that
    // subtree is painted, so a layer left in <html> would vanish.
    const fsPage = await openCase(context, 'life-fullscreen.html');
    await seek(fsPage, 1);
    await waitForText(fsPage, /Hello, how are you/, 8000);

    await fsPage.click('#fs');
    await fsPage.waitForTimeout(900);
    let fsInfo = await fsPage.evaluate(() => {
      const root = document.fullscreenElement;
      const layer = document.querySelector('.dualsub-layer');
      const en = document.querySelector('.dualsub-layer .dualsub-line.en');
      return {
        fullscreen: Boolean(root),
        inside: Boolean(root && layer && root.contains(layer)),
        layerVisible: Boolean(layer && layer.getBoundingClientRect().height > 0 &&
          getComputedStyle(layer).display !== 'none'),
        text: en ? en.textContent.trim() : ''
      };
    });
    check('fullscreen: the layer moves into the fullscreen player',
      fsInfo.fullscreen && fsInfo.inside && fsInfo.layerVisible,
      JSON.stringify(fsInfo));
    check('fullscreen: the cue is still shown', /Hello, how are you/.test(fsInfo.text),
      JSON.stringify(fsInfo.text));

    // In fullscreen only the player subtree is painted, so the page button is
    // not reachable; exit through the API rather than clicking it.
    await fsPage.evaluate(() => {
      if (document.fullscreenElement) {
        return document.exitFullscreen();
      }
      return null;
    });
    await fsPage.waitForTimeout(900);
    fsInfo = await fsPage.evaluate(() => {
      const layer = document.querySelector('.dualsub-layer');
      const en = document.querySelector('.dualsub-layer .dualsub-line.en');
      return {
        fullscreen: Boolean(document.fullscreenElement),
        attachedToDocument: Boolean(layer && layer.parentElement === document.documentElement),
        layerVisible: Boolean(layer && getComputedStyle(layer).display !== 'none'),
        text: en ? en.textContent.trim() : ''
      };
    });
    check('fullscreen exit: the layer returns to the page',
      !fsInfo.fullscreen && fsInfo.attachedToDocument && fsInfo.layerVisible && /Hello, how are you/.test(fsInfo.text),
      JSON.stringify(fsInfo));
    await fsPage.close();

    /* ---------- 9. playback control and reload ---------- */

    // Pausing, resuming, seeking forward and seeking back must all keep the
    // line in sync. A stale line after a seek is the classic "it works but the
    // wrong subtitle" complaint.
    const playPage = await openCase(context, 'life-baseline.html');
    await seek(playPage, 1);
    await waitForText(playPage, /Hello, how are you/, 8000);

    await playPage.evaluate(() => {
      const video = document.querySelector('video');
      video.pause();
    });
    await playPage.waitForTimeout(300);
    info = await state(playPage);
    check('pause: the line stays on screen while paused',
      info.layerVisible && /Hello, how are you/.test(info.enText),
      JSON.stringify({ visible: info.layerVisible, text: info.enText }));

    await seek(playPage, 10);
    info = await waitForText(playPage, /understand every word/, 6000);
    check('seek forward: the line follows the new position',
      /understand every word/.test(info.enText), JSON.stringify(info.enText));

    await seek(playPage, 1);
    info = await waitForText(playPage, /Hello, how are you/, 6000);
    check('seek back: the earlier line returns and the later one is gone',
      /Hello, how are you/.test(info.enText) && !/understand every word/.test(info.enText),
      JSON.stringify(info.enText));

    // A reload is a fresh document: the content script, adaptor and store all
    // have to come back from scratch.
    await playPage.reload({ waitUntil: 'domcontentloaded' });
    await playPage.waitForSelector('.dualsub-layer', { state: 'attached', timeout: 15000 });
    await playPage.waitForTimeout(800);
    await seek(playPage, 1);
    info = await waitForText(playPage, /Hello, how are you/, 10000);
    check('reload: subtitles return after a full page reload',
      /Hello, how are you/.test(info.enText) && info.layers === 1,
      JSON.stringify({ text: info.enText, layers: info.layers }));
    await playPage.close();

    /* ---------- 10. extension and language toggles ---------- */

    page = await openCase(context, 'life-baseline.html');
    await seek(page, 1);
    await waitForText(page, /Hello, how are you/, 8000);

    await sendToPage(worker, page, { type: 'apply-settings', patch: { enabled: false } });
    await page.waitForTimeout(400);
    info = await state(page);
    check('master off: the layer disappears', !info.layerVisible, JSON.stringify(info.layerVisible));

    await sendToPage(worker, page, { type: 'apply-settings', patch: { enabled: true } });
    await page.waitForTimeout(500);
    info = await state(page);
    check('master on: the layer comes back', info.layerVisible && /Hello/.test(info.enText),
      JSON.stringify({ visible: info.layerVisible, text: info.enText }));

    await sendToPage(worker, page, { type: 'apply-settings', patch: { englishOn: false } });
    await page.waitForTimeout(400);
    info = await state(page);
    check('English line off: the English line is hidden', !info.enVisible,
      JSON.stringify({ enVisible: info.enVisible, trVisible: info.trVisible }));

    await sendToPage(worker, page, { type: 'apply-settings', patch: { englishOn: true, turkishOn: false } });
    await page.waitForTimeout(400);
    info = await state(page);
    check('Turkish line off: the Turkish line is hidden', !info.trVisible,
      JSON.stringify({ enVisible: info.enVisible, trVisible: info.trVisible }));

    await sendToPage(worker, page, { type: 'apply-settings', patch: { turkishOn: true } });
    await page.waitForTimeout(1200);
    info = await state(page);
    check('Turkish line back on: the translated sentence returns',
      info.trVisible && info.trText.length > 3,
      JSON.stringify({ trVisible: info.trVisible, trText: info.trText }));
    check('the layer does not duplicate after repeated toggles', info.layers === 1, String(info.layers));

    // The Turkish line was switched off before it had ever been produced. When it
    // is switched back on, the page is paused and emits no `timeupdate`; the
    // translation must still be requested, otherwise the line stays empty until
    // the page is reloaded - the reported "aç kapa yapınca geri gelmiyor".
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) {
        video.pause();
      }
    });
    await sendToPage(worker, page, { type: 'apply-settings', patch: { turkishOn: false } });
    await page.waitForTimeout(700);
    await sendToPage(worker, page, { type: 'apply-settings', patch: { turkishOn: true } });
    await page.waitForTimeout(2500);
    info = await state(page);
    check('Turkish line back on with no playback: the sentence appears without a reload',
      info.trVisible && info.trText.length > 3,
      JSON.stringify({ trVisible: info.trVisible, trText: info.trText }));
    check('toggling with no playback does not leave a second layer', info.layers === 1, String(info.layers));

    // Playhead moves past the last cue (23.5 s). The layer must disappear; the
    // old code kept the last sentence on screen because an empty cue produced
    // the same render signature as "nothing changed".
    await seek(page, 24);
    await page.waitForTimeout(700);
    info = await state(page);
    check('no cue at this position: the subtitle layer is hidden',
      !info.layerVisible, JSON.stringify({ visible: info.layerVisible, en: info.enText }));
    await seek(page, 1);
    await page.waitForTimeout(700);

    /* ---------- 9. a new video on the same element (source change) ---------- */

    const srcPage = await openCase(context, 'life-baseline.html');
    await seek(srcPage, 1);
    await waitForText(srcPage, /Hello, how are you/, 8000);

    // A new blob URL is exactly what YouTube-style players assign when the next
    // video starts on the same element.
    await srcPage.evaluate(() => {
      const video = document.querySelector('video');
      const blob = new Blob([], { type: 'video/mp4' });
      video.src = URL.createObjectURL(blob);
      video.load();
    });
    await srcPage.waitForTimeout(1800);
    await seek(srcPage, 1);

    // The same track is still attached, so subtitles must return after the
    // source reset instead of staying blank forever.
    info = await waitForText(srcPage, /Hello, how are you/, 10000);
    check('source change: subtitles are rebuilt on the same element',
      /Hello, how are you/.test(info.enText), JSON.stringify(info.enText));
    await srcPage.close();

    /* ---------- 10. translation failure must not break English ---------- */

    const offlinePage = await openCase(context, 'life-baseline.html');
    await seek(offlinePage, 1);
    await waitForText(offlinePage, /Hello, how are you/, 8000);

    // With no network the Turkish line cannot be produced. The English line must
    // keep working, and the system must recover once the network returns.
    await context.setOffline(true);
    await seek(offlinePage, 5);
    await offlinePage.waitForTimeout(2500);

    info = await state(offlinePage);
    check('translation offline: the English line keeps rendering',
      /learning English/.test(info.enText) && info.layerVisible,
      JSON.stringify({ text: info.enText, visible: info.layerVisible }));

    await context.setOffline(false);
    await seek(offlinePage, 9);
    info = await waitForText(offlinePage, /understand every word|anlamak/i, 20000);
    check('translation recovery: the Turkish line returns after the network does',
      info.trText.length > 0, JSON.stringify({ tr: info.trText, en: info.enText }));
    await offlinePage.close();

    /* ---------- 11. disabled state is a full teardown ---------- */

    // Turning the extension off used to leave the element in the page whenever
    // the active video reference was null (a hidden player). The layer must be
    // removed from the DOM, not merely hidden, so nothing can be repainted.
    const teardownPage = await openCase(context, 'life-baseline.html');
    await seek(teardownPage, 1);
    await waitForText(teardownPage, /Hello, how are you/, 8000);

    await teardownPage.evaluate(() => {
      const video = document.querySelector('video');
      video.style.display = 'none';
    });
    await teardownPage.waitForTimeout(900);

    info = await state(teardownPage);
    check('hidden video: the overlay is not left floating on its own',
      !info.layerVisible, JSON.stringify({ visible: info.layerVisible, layers: info.layers }));

    await sendToPage(worker, teardownPage, { type: 'apply-settings', patch: { enabled: false } });
    await teardownPage.waitForTimeout(600);
    info = await state(teardownPage);
    check('master off with no active video: the layer is removed from the DOM',
      info.layers === 0 && info.panels === 0, JSON.stringify({ layers: info.layers, panels: info.panels }));

    await sendToPage(worker, teardownPage, { type: 'apply-settings', patch: { enabled: true } });
    await teardownPage.waitForTimeout(600);
    await sendToPage(worker, teardownPage, { type: 'apply-settings', patch: { enabled: false } });
    await teardownPage.waitForTimeout(600);
    check('repeated off: still no layer after toggling back on and off',
      (await state(teardownPage)).layers === 0, String((await state(teardownPage)).layers));
    await teardownPage.close();

    /* ---------- 12. extension off when the page loads ---------- */

    // The content script used to start with enabled: true before the stored
    // setting arrived, so a disabled extension painted subtitles for a moment
    // (or for the whole session when the settings read failed).
    if (worker) {
      await worker.evaluate(async () => {
        const key = 'settings';
        const stored = await chrome.storage.local.get(key);
        await chrome.storage.local.set({ [key]: Object.assign({}, stored[key] || {}, { enabled: false }) });
      });
      const offPage = await context.newPage();
      await offPage.setViewportSize({ width: 800, height: 600 });
      await offPage.goto(BASE + 'life-baseline.html', { waitUntil: 'domcontentloaded' });
      await offPage.waitForTimeout(1800);
      await seek(offPage, 1);
      await offPage.waitForTimeout(800);
      info = await state(offPage);
      const offState = await sendToPage(worker, offPage, { type: 'get-state' });
      check('startup disabled: no overlay is created at all', info.layers === 0,
        JSON.stringify({ layers: info.layers }));
      check('startup disabled: the page reports the saved preference',
        Boolean(offState) && offState.enabled === false && offState.settingsLoaded === true,
        JSON.stringify(offState && { enabled: offState.enabled, loaded: offState.settingsLoaded }));
      await offPage.close();

      await worker.evaluate(async () => {
        const key = 'settings';
        const stored = await chrome.storage.local.get(key);
        await chrome.storage.local.set({ [key]: Object.assign({}, stored[key] || {}, { enabled: true }) });
      });
    }

    /* ---------- 13. duplicate-listener guard ---------- */

    // Re-injection and repeated scans must not stack overlays. content.js is
    // guarded; this proves it end to end after all the activity above.
    if (worker) {
      const injected = await worker.evaluate(async (url) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((row) => row.url && row.url.indexOf(url) === 0);
        if (!tab) {
          return { ok: false };
        }
        const entry = chrome.runtime.getManifest().content_scripts[0];
        await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: entry.js });
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { ok: true };
      }, BASE + 'life-baseline.html').catch(() => ({ ok: false }));

      if (injected.ok) {
        await page.waitForTimeout(300);
        info = await state(page);
        check('re-injection keeps a single overlay', info.layers === 1, String(info.layers));
      }
    }

    await page.close();
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    server.close();
  }

  console.log('');
  console.log(checks + ' kontrol, ' + failures + ' başarısız.');
  if (failures) {
    console.log(failures + ' yaşam döngüsü kontrolü başarısız.');
    process.exit(1);
  }
  console.log('Tüm yaşam döngüsü kontrolleri geçti.');
})();
