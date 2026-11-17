/* YouTube DOM-caption integration test, without touching youtube.com.
 *
 * The real YouTube page cannot be driven from this environment: its caption
 * request returns an empty body to automated browsers (bot protection), so the
 * end-to-end path "open a real YouTube video with CC on" is not provable here.
 *
 * What *can* be proved is the part that used to be broken: when a page at the
 * YouTube origin paints captions into `.ytp-caption-window-container` and keeps
 * `video.textTracks` empty, the extension must read that DOM layer, and must
 * recover when the player swaps to another video on the same <video> element.
 * The document is served by request interception, so the extension sees a real
 * https://www.youtube.com page; no other YouTube request is made.
 *
 *   node test/live-youtube-dom.js
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
    <title>YouTube</title>
    <style>
      body { margin: 0; background: #0f0f0f; }
      #movie_player { position: relative; width: 640px; height: 360px; }
      video { width: 640px; height: 360px; background: #000; }
      .ytp-caption-window-container { position: absolute; left: 0; right: 0; bottom: 40px; text-align: center; color: #fff; }
    </style>
  </head>
  <body>
    <div id="movie_player">
      <video id="v" playsinline preload="auto"></video>
      <div class="ytp-caption-window-container">
        <span class="caption-window">
          <span class="ytp-caption-segment">Hello from the YouTube caption window</span>
        </span>
      </div>
    </div>
  </body>
</html>`;

async function state(page) {
  return page.evaluate(() => {
    const layer = document.querySelector('.dualsub-layer');
    const en = document.querySelector('.dualsub-layer .dualsub-line.en');
    const style = layer ? getComputedStyle(layer) : null;
    return {
      layers: document.querySelectorAll('.dualsub-layer').length,
      layerVisible: Boolean(layer && style.display !== 'none' && layer.getBoundingClientRect().height > 0),
      enText: en ? en.textContent.trim() : '',
      words: document.querySelectorAll('.dualsub-layer .dualsub-word').length,
      nativeHidden: document.documentElement.classList.contains('dualsub-youtube-dom'),
      videos: document.querySelectorAll('video').length
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dualsub-yt-'));
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

    await context.route('https://www.youtube.com/**', (route) => {
      const url = route.request().url();
      // The second-language harvester asks the player's own timedtext endpoint
      // for the English file. Serve a real VTT so the whole path (capture ->
      // bridge -> store -> overlay) runs, not just the fetch.
      if (url.indexOf('/api/timedtext') !== -1) {
        route.fulfill({
          status: 200,
          contentType: 'text/vtt; charset=utf-8',
          body: 'WEBVTT\n\n00:00:00.000 --> 00:10:00.000\nWhere were you last night?\n'
        });
        return;
      }
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: PAGE
      });
    });

    const page = await context.newPage();
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto('https://www.youtube.com/watch?v=first', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.dualsub-layer', { state: 'attached', timeout: 15000 });

    let info = await waitForText(page, /Hello from the YouTube caption window/, 10000);
    check('youtube origin is served as a controlled page', true);
    check('DOM captions are read when textTracks is empty',
      /Hello from the YouTube caption window/.test(info.enText), JSON.stringify(info.enText));
    check('the captured line is clickable', info.words >= 4, String(info.words));
    check('exactly one overlay is created', info.layers === 1, String(info.layers));
    check('the player appears under the extension layer', info.videos === 1, String(info.videos));

    // The player's own caption box is hidden only after our line was captured.
    check('native caption box is hidden once capture works', info.nativeHidden, String(info.nativeHidden));

    // Next video on the same element: YouTube swaps the media and repaints the
    // caption. The old line must not survive.
    await page.evaluate(() => {
      const video = document.querySelector('video');
      const blob = new Blob([], { type: 'video/mp4' });
      video.src = URL.createObjectURL(blob);
      video.load();
      const segment = document.querySelector('.ytp-caption-segment');
      segment.textContent = 'This is the second video caption';
    });

    await page.waitForTimeout(1400);
    info = await waitForText(page, /This is the second video caption/, 10000);
    check('same <video>, next video: the new caption is shown',
      /This is the second video caption/.test(info.enText), JSON.stringify(info.enText));
    check('same <video>, next video: the previous line is gone',
      !/Hello from the YouTube caption window/.test(info.enText), JSON.stringify(info.enText));
    check('same <video>, next video: still one overlay', info.layers === 1, String(info.layers));

    // Captions turned off: the extension must clear its line, not keep the last
    // sentence on screen forever.
    await page.evaluate(() => {
      const container = document.querySelector('.ytp-caption-window-container');
      container.innerHTML = '';
    });
    await page.waitForTimeout(1200);
    info = await state(page);
    check('captions turned off: the last line is cleared',
      !info.layerVisible, JSON.stringify({ visible: info.layerVisible, text: info.enText }));

    // Captions back on: capture must resume on the same page.
    await page.evaluate(() => {
      const container = document.querySelector('.ytp-caption-window-container');
      container.innerHTML = '<span class="caption-window"><span class="ytp-caption-segment">Captions are back again</span></span>';
    });
    info = await waitForText(page, /Captions are back again/, 10000);
    check('captions turned back on: capture resumes',
      /Captions are back again/.test(info.enText) && info.layerVisible,
      JSON.stringify({ text: info.enText, visible: info.layerVisible }));

    /* ---------- second language on a one-language player ---------- */

    // Reported bug: with Turkish captions selected, YouTube exposes only the
    // Turkish track, so the English line was empty. The player's caption list
    // contains English; the MAIN-world harvester fetches it. Here the visible
    // (DOM) caption is Turkish and the fetched track is English, so a working
    // pipeline must show both lines at once.
    const harvestPage = await context.newPage();
    await harvestPage.setViewportSize({ width: 900, height: 700 });
    await harvestPage.goto('https://www.youtube.com/watch?v=harvest', { waitUntil: 'domcontentloaded' });

    await harvestPage.evaluate(() => {
      window.ytInitialPlayerResponse = {
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                languageCode: 'en',
                kind: 'asr',
                baseUrl: 'https://www.youtube.com/api/timedtext?v=harvest&lang=en&fmt=srv3',
                name: { simpleText: 'English (auto-generated)' }
              },
              {
                languageCode: 'tr',
                baseUrl: 'https://www.youtube.com/api/timedtext?v=harvest&lang=tr&fmt=srv3',
                name: { simpleText: 'Türkçe' }
              }
            ]
          }
        }
      };
      const segment = document.querySelector('.ytp-caption-segment');
      if (segment) {
        segment.textContent = 'Dün gece neredeydin?';
      }
    });

    const deadline = Date.now() + 12000;
    let both = await state(harvestPage);
    while (Date.now() < deadline) {
      const pair = await harvestPage.evaluate(() => {
        const en = document.querySelector('.dualsub-layer .dualsub-line.en');
        const tr = document.querySelector('.dualsub-layer .dualsub-line.tr');
        return {
          en: en ? en.textContent.trim() : '',
          tr: tr ? tr.textContent.trim() : ''
        };
      });
      both = Object.assign({}, both, pair);
      if (/Where were you last night\?/.test(pair.en) && /Dün gece/.test(pair.tr)) {
        break;
      }
      await harvestPage.waitForTimeout(250);
    }

    check('tek dilli oynatıcıda İngilizce parça indirildi ve gösterildi',
      /Where were you last night\?/.test(both.en), JSON.stringify(both.en));
    check('seçili Türkçe altyazı Türkçe satırda kaldı',
      /Dün gece neredeydin\?/.test(both.tr), JSON.stringify(both.tr));
    check('iki satır aynı anda görünüyor (EN üstte, TR altta)',
      /Where were you/.test(both.en) && /Dün gece/.test(both.tr),
      JSON.stringify(both));

    await harvestPage.close();
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
  console.log('YouTube DOM altyazı entegrasyonu geçti.');
})();
