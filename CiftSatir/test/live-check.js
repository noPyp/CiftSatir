/* Loads the real extension into a real Chromium (Edge) and checks that it
   actually runs on a page.

   The other tests exercise pure logic in a VM. They cannot catch the failures
   that make an extension look completely dead: a manifest field the browser
   rejects, a content script that throws before it renders anything, or a
   permission that silently blocks injection. This test loads the unpacked
   extension, opens a page with a real <track>, and looks for the overlay in the
   page DOM.

     node test/live-check.js
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
const PORT = 5321;
const BASE = 'http://127.0.0.1:' + PORT + '/';

let failures = 0;
function check(label, okValue, detail) {
  if (!okValue) {
    failures += 1;
    console.log('FAIL  ' + label + (detail ? '  (' + detail + ')' : ''));
    return;
  }
  console.log('ok    ' + label);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8'
};

function startServer(port, iframeSrc) {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'test-page.html';
    const file = path.join(testsDir, name);
    if (!file.startsWith(testsDir)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        // An id-only subtitle URL, as used by many players: the extension has to
        // trust the Content-Type header instead of the path extension.
        if (name.indexOf('subtitle/') === 0) {
          fs.readFile(path.join(testsDir, 'sample2.vtt'), (subError, subData) => {
            if (subError) {
              res.writeHead(404).end('not found');
              return;
            }
            res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8' });
            res.end(subData);
          });
          return;
        }
        res.writeHead(404).end('not found');
        return;
      }
      const type = MIME[path.extname(file)] || 'application/octet-stream';
      const body = name === 'live-frame.html'
        ? data.toString('utf8').replace('IFRAME_SRC', iframeSrc)
        : data;
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// A video element with no media file: the extension only needs the element and
// its text track, not playback. Keeping the media out makes the test hermetic
// (no remote MP4, no codec support). The page is a real file served by the
// static server above - a 404 document would not exercise injection fairly.

(async () => {
  const server = await startServer(PORT, 'http://127.0.0.1:' + (PORT + 1) + '/live-harness.html');
  const frameServer = await startServer(PORT + 1, '');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dualsub-live-'));
  let context;

  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: EDGE,
      headless: true,
      args: [
        '--disable-extensions-except=' + root,
        '--load-extension=' + root,
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });

    // The service worker proves the manifest was accepted and the background
    // boot (all importScripts) succeeded.
    let workers = context.serviceWorkers();
    if (!workers.length) {
      workers = [await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null)];
    }
    const worker = workers.filter(Boolean)[0];
    check('service worker starts (manifest accepted)', Boolean(worker),
      worker ? worker.url() : 'no worker');

    if (worker) {
      const pong = await worker.evaluate(() => new Promise((resolve) => {
        chrome.runtime.onMessage.hasListeners();
        resolve('alive');
      })).catch((error) => 'error: ' + error.message);
      check('service worker evaluates code', pong === 'alive', String(pong));
    }

    const page = await context.newPage();
    const logs = [];
    page.on('console', (message) => logs.push('console[' + message.type() + '] ' + message.text()));
    page.on('pageerror', (error) => logs.push('pageerror ' + error.message));

    await page.goto(BASE + 'live-harness.html', { waitUntil: 'domcontentloaded' });

    const layer = await page.waitForSelector('.dualsub-layer', { timeout: 12000, state: 'attached' }).catch(() => null);
    check('content script injects the subtitle layer', Boolean(layer));

    // The overlay only renders text once a cue covers the playhead, so the test
    // seeks into the first cue instead of pretending playback happened.
    let text = '';
    if (layer) {
      await page.evaluate(() => {
        const v = document.getElementById('v');
        try { v.currentTime = 1; } catch (e) { /* no media, still fine */ }
        v.dispatchEvent(new Event('timeupdate'));
        v.dispatchEvent(new Event('loadedmetadata'));
      });
      await page.waitForTimeout(2500);
      text = await page.evaluate(() => {
        const el = document.querySelector('.dualsub-layer .dualsub-line');
        return el ? el.textContent.trim() : '';
      });
    }
    check('a real cue is rendered as English text', /Hello, how are you/.test(text), text);

    // Words must be individually clickable spans.
    const words = await page.evaluate(() => document.querySelectorAll('.dualsub-layer .dualsub-word').length);
    check('English line is split into clickable words', words >= 4, String(words));

    // The popup must be able to reach this tab. This is the exact call the
    // popup makes; if it fails, the popup shows "sayfayla bağlantı kurulamadı".
    if (worker) {
      const tabCheck = await worker.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          if (typeof tab.id !== 'number') {
            continue;
          }
          try {
            const response = await chrome.tabs.sendMessage(tab.id, { type: 'get-state' });
            if (response) {
              return { found: true, hasVideo: Boolean(response.hasVideo), keys: Object.keys(response) };
            }
          } catch (error) {
            // Tabs without a content script are expected in this loop.
          }
        }
        return { found: false };
      }).catch((error) => ({ evalError: String(error && error.message || error) }));

      check('popup can read page state over messaging',
        Boolean(tabCheck && tabCheck.found && tabCheck.keys && tabCheck.keys.length),
        JSON.stringify(tabCheck).slice(0, 260));
    }

    /* ---- re-injection safety (the popup's recovery path) ---- */

    // The popup injects the same files into tabs that predate the extension. On
    // a page whose declared script already ran, that must be a no-op: one
    // overlay, one keyboard handler, one message listener. Injecting twice here
    // proves the guard in content.js holds.
    if (worker) {
      const injected = await worker.evaluate(async (url) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((row) => row.url && row.url.indexOf(url) === 0);
        if (!tab) {
          return { ok: false, error: 'tab not found' };
        }

        const entry = chrome.runtime.getManifest().content_scripts[0];
        try {
          await chrome.scripting.insertCSS({ target: { tabId: tab.id, allFrames: true }, files: entry.css });
        } catch (error) {
          // Cosmetic only.
        }

        await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: entry.js });
        await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: entry.js });
        await new Promise((resolve) => setTimeout(resolve, 300));

        const response = await chrome.tabs.sendMessage(tab.id, { type: 'get-state' })
          .catch((error) => ({ error: String(error.message) }));
        return { ok: true, state: response };
      }, BASE).catch((error) => ({ evalError: String(error && error.message || error) }));

      check('injection into an existing tab succeeds', Boolean(injected && injected.ok),
        JSON.stringify(injected).slice(0, 260));
      check('injected page answers get-state', Boolean(injected && injected.state && injected.state.hasVideo !== undefined),
        JSON.stringify(injected && injected.state).slice(0, 200));
    }

    const layerCount = await page.evaluate(() => document.querySelectorAll('.dualsub-layer').length);
    check('re-injection does not duplicate the overlay', layerCount === 1, String(layerCount));

    /* ---- the popup's "open learning site" button ---- */

    // The button used to open a dead tab when the local dev server was not
    // running. It must now fall back to the built HTML file. The server address
    // is pointed at a closed port so the fallback is deterministic.
    if (worker) {
      const extensionId = new URL(worker.url()).host;

      await worker.evaluate(async () => {
        const stored = await chrome.storage.local.get('settings');
        const settings = Object.assign({}, stored.settings || {}, { siteUrl: 'http://127.0.0.1:5999/' });
        await chrome.storage.local.set({ settings });
      }).catch(() => {});

      const popupPage = await context.newPage();
      await popupPage.goto('chrome-extension://' + extensionId + '/ui/popup.html', { waitUntil: 'domcontentloaded' });
      await popupPage.waitForTimeout(1200);

      const openedPromise = context.waitForEvent('page', { timeout: 12000 }).catch(() => null);
      await popupPage.click('#openSite').catch(() => {});
      const opened = await openedPromise;

      if (!opened) {
        check('the site button opens the built file when the server is down', false,
          'no tab was opened');
      } else {
        await opened.waitForURL(/Ceviri-Kitabi\.html/i, { timeout: 10000 }).catch(() => {});
        await opened.waitForLoadState('domcontentloaded').catch(() => {});
        const openedUrl = opened.url();
        check('the site button opens the built file when the server is down',
          /^file:\/\/\/.*Ceviri-Kitabi\.html$/i.test(openedUrl), JSON.stringify(openedUrl));

        const title = await opened.title().catch(() => '');
        check('the opened site is the real application',
          /Çeviri Kitabı|Ceviri Kitabi/.test(title), title);

        await opened.close();
      }

      await popupPage.close().catch(() => {});
    }

    /* ---- a player inside a cross-origin iframe (streaming sites) ---- */

    // On most streaming sites the <video> lives in an iframe from another host.
    // The top frame has no video, so an undelayed top-frame answer used to win
    // the race and the popup reported "no video" on a page that was playing.
    const framePage = await context.newPage();
    await framePage.goto(BASE + 'live-frame.html', { waitUntil: 'domcontentloaded' });
    await framePage.waitForTimeout(2000);

    const frameLayer = await (async () => {
      for (const frame of framePage.frames()) {
        const hit = await frame.evaluate(() => Boolean(document.querySelector('.dualsub-layer')))
          .catch(() => false);
        if (hit) {
          return frame;
        }
      }
      return null;
    })();

    check('overlay is created inside the player frame', Boolean(frameLayer),
      frameLayer ? frameLayer.url() : 'no frame');

    if (worker && frameLayer) {
      const frameState = await worker.evaluate(async (url) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((row) => row.url && row.url.indexOf(url) === 0);
        if (!tab) {
          return { error: 'tab not found' };
        }
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'get-state' })
          .catch((error) => ({ error: String(error.message) }));
        return response;
      }, BASE).catch((error) => ({ evalError: String(error && error.message || error) }));

      check('popup sees the video from the player frame',
        Boolean(frameState && frameState.hasVideo === true),
        JSON.stringify(frameState).slice(0, 200));
    }

    await framePage.close();

    /* ---- subtitles fetched by the player, no <track> in the DOM ---- */

    // This is the path that matters on streaming sites: the player downloads a
    // .vtt by XHR and paints its own captions. The extension can only see the
    // text by wrapping fetch/XHR in the page's world.
    const capturePage = await context.newPage();
    await capturePage.goto(BASE + 'live-capture.html', { waitUntil: 'domcontentloaded' });
    await capturePage.waitForTimeout(1500);

    const fetched = await capturePage.evaluate(() => ({
      done: Boolean(window.__captureDone),
      head: String(window.__captureText || '').slice(0, 12)
    }));
    check('the player really fetched the subtitle file', fetched.done && /WEBVTT/.test(fetched.head),
      JSON.stringify(fetched));

    const captureLayer = await capturePage.waitForSelector('.dualsub-layer', { state: 'attached', timeout: 5000 }).catch(() => null);
    check('network-captured subtitles reach the overlay', Boolean(captureLayer));

    let captureText = '';
    if (captureLayer) {
      await capturePage.evaluate(() => {
        const v = document.getElementById('v');
        try { v.currentTime = 1; } catch (error) { /* no media */ }
        v.dispatchEvent(new Event('timeupdate'));
      });
      await capturePage.waitForTimeout(800);
      captureText = await capturePage.evaluate(() => {
        const el = document.querySelector('.dualsub-layer .dualsub-line');
        return el ? el.textContent.trim() : '';
      });
    }
    check('captured cue is rendered as text', /Hello, how are you/.test(captureText), captureText);

    await capturePage.close();

    /* ---- same, but the subtitle URL has no file extension ---- */

    const mimePage = await context.newPage();
    await mimePage.goto(BASE + 'live-capture-mime.html', { waitUntil: 'domcontentloaded' });
    await mimePage.waitForTimeout(1500);

    const mimeLayer = await mimePage.waitForSelector('.dualsub-layer', { state: 'attached', timeout: 5000 }).catch(() => null);
    check('a subtitle served with text/vtt and no extension is captured', Boolean(mimeLayer));

    let mimeText = '';
    if (mimeLayer) {
      await mimePage.evaluate(() => {
        const v = document.getElementById('v');
        try { v.currentTime = 1; } catch (error) { /* no media */ }
        v.dispatchEvent(new Event('timeupdate'));
      });
      await mimePage.waitForTimeout(800);
      mimeText = await mimePage.evaluate(() => {
        const el = document.querySelector('.dualsub-layer .dualsub-line');
        return el ? el.textContent.trim() : '';
      });
    }
    check('the Content-Type-only cue is rendered', /Content type capture works/.test(mimeText), mimeText);

    await mimePage.close();

    if (failures) {
      console.log('\n--- sayfa günlüğü ---');
      for (const line of logs.slice(-25)) {
        console.log(line);
      }
    }
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    server.close();
    frameServer.close();
  }

  console.log('');
  if (failures) {
    console.log(failures + ' canlı kontrol başarısız.');
    process.exit(1);
  }
  console.log('Tüm canlı kontrol testleri geçti.');
})();
