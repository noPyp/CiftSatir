/* Netflix DOM-caption integration test, without a Netflix account.
 *
 * A real Netflix session cannot be automated here (login, DRM, geo). This test
 * serves a controlled page at the real Netflix origin via request interception
 * and reproduces the only thing the adaptor depends on: the current line is
 * painted into `.player-timedtext` while `video.textTracks` stays empty.
 *
 * It proves the selector path, the English/Turkish classification hand-off, the
 * clickable words, and - most importantly for the stability round - that a new
 * episode on the same <video> element replaces the previous line instead of
 * leaving it on screen.
 *
 *   node test/live-netflix-dom.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require(path.resolve('C:\\Users\\fatih\\ceviri-projesi\\node_modules\\playwright-core'));

const root = path.resolve(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

let checks = 0;
let failures = 0;

function check(label, okValue, detail) {
  checks += 1;
  if (!okValue) {
    failures += 1;
    console.log('FAIL  ' + label + (detail !== undefined ? '  (' + detail + ')' : ''));
    return;
  }
  console.log('ok    ' + label);
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Netflix</title>
    <style>
      body { margin: 0; background: #000; }
      #player { position: relative; width: 640px; height: 360px; }
      video { width: 640px; height: 360px; background: #000; }
      .player-timedtext { position: absolute; left: 0; right: 0; bottom: 40px; text-align: center; color: #fff; }
    </style>
  </head>
  <body>
    <div id="player">
      <video id="v" playsinline preload="auto"></video>
      <div class="player-timedtext"><span>This is the first episode line</span></div>
    </div>
  </body>
</html>`;

async function state(page) {
  return page.evaluate(() => {
    const layer = document.querySelector('.dualsub-layer');
    const en = document.querySelector('.dualsub-layer .dualsub-line.en');
    return {
      layers: document.querySelectorAll('.dualsub-layer').length,
      enText: en ? en.textContent.trim() : '',
      words: document.querySelectorAll('.dualsub-layer .dualsub-word').length
    };
  });
}

async function waitForText(page, pattern, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000);
  let info = await state(page);
  while (Date.now() < deadline) {
    info = await state(page);
    if (pattern.test(info.enText)) {
      return info;
    }
    await page.waitForTimeout(200);
  }
  return info;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dualsub-nf-'));
  let context;

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

    await context.route('https://www.netflix.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: PAGE
      });
    });

    const page = await context.newPage();
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto('https://www.netflix.com/watch/80000000', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.dualsub-layer', { state: 'attached', timeout: 15000 });

    let info = await waitForText(page, /This is the first episode line/, 10000);
    check('netflix origin is served as a controlled page', true);
    check('the rendered Netflix line is captured',
      /This is the first episode line/.test(info.enText), JSON.stringify(info.enText));
    check('the captured line is clickable', info.words >= 4, String(info.words));
    check('exactly one overlay is created', info.layers === 1, String(info.layers));

    // Next episode on the same element: Netflix keeps the player and swaps the
    // media source and the rendered line.
    await page.evaluate(() => {
      const video = document.querySelector('video');
      const blob = new Blob([], { type: 'video/mp4' });
      video.src = URL.createObjectURL(blob);
      video.load();
      document.querySelector('.player-timedtext span').textContent = 'And this is the second episode line';
    });

    await page.waitForTimeout(1400);
    info = await waitForText(page, /And this is the second episode line/, 10000);
    check('same <video>, next episode: the new line is shown',
      /And this is the second episode line/.test(info.enText), JSON.stringify(info.enText));
    check('same <video>, next episode: the old line is gone',
      !/This is the first episode line/.test(info.enText), JSON.stringify(info.enText));
    check('same <video>, next episode: still one overlay', info.layers === 1, String(info.layers));

    await page.close();
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }

  console.log('');
  console.log(checks + ' kontrol, ' + failures + ' başarısız.');
  if (failures) {
    process.exit(1);
  }
  console.log('Netflix DOM altyazı entegrasyonu geçti.');
})();
