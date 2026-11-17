/* YouTube second-language harvester test.

   Real bug: YouTube exposes only the caption language the viewer selected as
   `video.textTracks`. With Turkish captions on, the English line had no source
   at all ("YouTube'da sadece Türkçe görünüyor"). The MAIN-world capture script
   now reads the player's own caption list and fetches the English file as VTT.

   This test loads the real `adaptors/network-capture.js` into a page served as
   youtube.com, with a fake caption list and a fake fetch, and checks what it
   actually requests and publishes. It does NOT prove that a real YouTube
   session still serves `fmt=vtt` (tokens/consent can change that); it proves the
   harvester's own logic.

     node test/youtube-harvest-check.js
*/
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require(path.resolve('C:\\Users\\fatih\\ceviri-projesi\\node_modules\\playwright-core'));

const root = path.resolve(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SCRIPT = fs.readFileSync(path.join(root, 'adaptors', 'network-capture.js'), 'utf8');

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

const VTT = 'WEBVTT\n\n00:00:00.500 --> 00:00:03.000\nWhere were you last night?\n';

const PAGE_HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
  '<video id="v" playsinline muted></video>' +
  '<div id="movie_player"></div>' +
  '</body></html>';

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });

  try {
    const page = await browser.newPage();

    await page.route('https://www.youtube.com/**', (route) => {
      route.fulfill({ status: 200, contentType: 'text/html', body: PAGE_HTML });
    });

    await page.goto('https://www.youtube.com/watch?v=TESTVIDEO123', { waitUntil: 'load' });

    // The fake player state and fetch must exist before the capture script runs,
    // exactly like the real page: the script reads ytInitialPlayerResponse and
    // wraps window.fetch at document_start.
    await page.evaluate((vtt) => {
      const enUrl = 'https://www.youtube.com/api/timedtext?v=TESTVIDEO123&lang=en&fmt=srv3';
      const trUrl = 'https://www.youtube.com/api/timedtext?v=TESTVIDEO123&lang=tr&fmt=srv3';

      window.__fetched = [];
      window.__published = [];

      window.ytInitialPlayerResponse = {
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              { languageCode: 'tr', baseUrl: trUrl, name: { simpleText: 'Türkçe' } },
              { languageCode: 'en', baseUrl: enUrl, kind: 'asr', name: { simpleText: 'English (auto)' } }
            ]
          }
        }
      };

      window.fetch = (input) => {
        const url = String(input && input.url ? input.url : input);
        window.__fetched.push(url);
        return Promise.resolve({
          ok: true,
          headers: { get: () => 'text/vtt' },
          text: () => Promise.resolve(vtt),
          clone: function () { return this; }
        });
      };

      window.addEventListener('message', (event) => {
        const data = event.data;
        if (data && data.source === 'dualsub-capture') {
          window.__published.push({ url: data.url, body: data.body });
        }
      });
    }, VTT);

    await page.addScriptTag({ content: SCRIPT });

    // The first tick is immediate; the second happens after 4 s. Waiting past
    // it proves the same track is not fetched twice.
    await page.waitForTimeout(4600);

    const result = await page.evaluate(() => ({
      fetched: window.__fetched.slice(),
      published: window.__published.slice()
    }));

    const english = result.fetched.filter((url) => /[?&]lang=en(?:&|$)/.test(url));
    const turkish = result.fetched.filter((url) => /[?&]lang=tr(?:&|$)/.test(url));

    check('İngilizce parça istendi', english.length >= 1, JSON.stringify(result.fetched));
    check('Türkçe parça istenmedi (seçili kanal zaten okunuyor)', turkish.length === 0,
      JSON.stringify(turkish));
    check('aynı İngilizce parça iki kez istenmedi', english.length === 1,
      String(english.length));

    const enUrl = english[0] || '';
    check('fmt parametresi vtt ile değiştirildi', /[?&]fmt=vtt(?:&|$)/.test(enUrl), enUrl);
    check('fmt parametresi iki kez eklenmedi', (enUrl.match(/[?&]fmt=/g) || []).length === 1, enUrl);

    const publishedEn = result.published.filter((item) =>
      /[?&]lang=en(?:&|$)/.test(String(item.url || '')));
    check('İngilizce VTT yakalama kanalına verildi', publishedEn.length >= 1,
      JSON.stringify(result.published.map((item) => item.url)));
    check('verilen gövde gerçek altyazı metnini taşıyor',
      publishedEn.length > 0 && /Where were you last night\?/.test(String(publishedEn[0].body)),
      publishedEn.length ? JSON.stringify(String(publishedEn[0].body).slice(0, 80)) : 'yok');
    check('verilen gövde JSON/meta veri değil',
      publishedEn.length > 0 && !/metadataType|DISCONTINUITY/.test(String(publishedEn[0].body)));

    /* ---- auto-generated track: VTT empty, json3 fallback ---- */

    // Real bug behind "YouTube'da sadece Türkçe görünüyor": for `kind=asr`
    // tracks the timedtext endpoint can answer the VTT request with an empty
    // body. Only the json3 fallback makes the English line appear there.
    const JSON3 = JSON.stringify({
      events: [
        { tStartMs: 500, dDurationMs: 400, segs: [{ utf8: 'Where' }] },
        { tStartMs: 900, dDurationMs: 400, segs: [{ utf8: 'were' }] },
        { tStartMs: 1300, dDurationMs: 400, segs: [{ utf8: 'you' }] },
        { tStartMs: 1700, dDurationMs: 800, segs: [{ utf8: 'last' }, { utf8: ' night?' }] }
      ]
    });

    const page2 = await browser.newPage();
    await page2.route('https://www.youtube.com/**', (route) => {
      route.fulfill({ status: 200, contentType: 'text/html', body: PAGE_HTML });
    });
    await page2.goto('https://www.youtube.com/watch?v=ASRVIDEO456', { waitUntil: 'load' });

    await page2.evaluate((json) => {
      const enUrl = 'https://www.youtube.com/api/timedtext?v=ASRVIDEO456&lang=en&kind=asr&fmt=srv3';
      // The harvester skips background tabs. A second page in a headless
      // browser can still report `hidden`, which would make this test vacuous.
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      window.__fetched = [];
      window.__published = [];

      window.ytInitialPlayerResponse = {
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              { languageCode: 'en', kind: 'asr', baseUrl: enUrl, name: { simpleText: 'English (auto)' } }
            ]
          }
        }
      };

      window.fetch = (input) => {
        const url = String(input && input.url ? input.url : input);
        window.__fetched.push(url);
        const body = /[?&]fmt=json3(?:&|$)/.test(url) ? json : '';
        return Promise.resolve({
          ok: true,
          headers: { get: () => (body ? 'application/json' : 'text/vtt') },
          text: () => Promise.resolve(body),
          clone: function () { return this; }
        });
      };

      window.addEventListener('message', (event) => {
        const data = event.data;
        if (data && data.source === 'dualsub-capture') {
          window.__published.push({ url: data.url, body: data.body });
        }
      });
    }, JSON3);

    await page2.addScriptTag({ content: SCRIPT });
    await page2.bringToFront();
    await page2.waitForTimeout(4600);

    const asrResult = await page2.evaluate(() => ({
      fetched: window.__fetched.slice(),
      published: window.__published.slice()
    }));

    check('boş VTT yanıtında json3 yedeği istendi',
      asrResult.fetched.some((url) => /[?&]fmt=json3(?:&|$)/.test(url)),
      JSON.stringify(asrResult.fetched));
    const publishedJson = asrResult.published.find((item) =>
      /[?&]fmt=json3(?:&|$)/.test(String(item.url || '')));
    check('json3 gövdesi yakalama kanalına verildi', Boolean(publishedJson),
      JSON.stringify(asrResult.published.map((item) => item.url)));
    check('json3 gövdesi gerçek zamanlı kelime verisi taşıyor',
      Boolean(publishedJson) && /"tStartMs"/.test(String(publishedJson.body)) &&
        /Where/.test(String(publishedJson.body)));

    await page2.close();
    await page.close();
  } finally {
    await browser.close();
  }

  console.log('');
  console.log(checks + ' kontrol, ' + failures + ' başarısız.');
  if (failures) {
    process.exit(1);
  }
  console.log('YouTube toplayıcı kontrolleri geçti.');
})().catch((error) => {
  console.log('TEST ERROR', error && error.stack ? error.stack : error);
  process.exit(1);
});
