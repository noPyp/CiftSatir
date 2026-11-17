/* Multi-player integration test: the path that matters most for film/series
   sites.

   Each page under test/players/ represents a different real-world player
   architecture:

     native           plain <video> + <track>               (textTracks)
     videojs          Video.js 8                            (textTracks)
     plyr             Plyr 3                                (textTracks)
     dplayer          DPlayer 1.27                          (own <track> / DOM)
     artplayer        ArtPlayer 5                           (own fetch + DOM)
     custom-xhr       JW-Player-like: XHR .srt, no <track>  (network capture)
     custom-embedded  captions painted from memory          (DOM only, expected gap)
     metadata         HLS/ID3 metadata track + XHR subtitle (must not leak JSON)

   The test loads the real unpacked extension into real Edge, serves the pages
   from a local HTTP server, and reports for every player: was the video found,
   which subtitle source produced cues, is the English line rendered, are words
   clickable, and does the player's own caption layer stay out of the way.

     node test/players-check.js
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

function info(label, detail) {
  console.log('info  ' + label + '  ' + detail);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

function startServer() {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const name = decodeURIComponent(url).replace(/^\//, '');

    // A subtitle endpoint with no file extension and a generic Content-Type,
    // exactly as many streaming players serve their .srt.
    if (url === '/edge/sub') {
      fs.readFile(path.join(testsDir, 'sample.en.srt'), (error, data) => {
        if (error) {
          res.writeHead(404).end('not found');
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="sub"'
        });
        res.end(data);
      });
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
      const type = MIME[path.extname(file)] || 'application/octet-stream';

      // Range support is not optional for media: without it Chromium reports
      // `seekable` as empty and every seek is silently ignored, which would make
      // the test blame the extension for a server limitation.
      const range = req.headers.range;
      if (range && /^bytes=(\d*)-(\d*)$/.test(range)) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        let start = match[1] === '' ? data.length - Number(match[2]) : Number(match[1]);
        let end = match[2] === '' || match[1] === '' ? data.length - 1 : Number(match[2]);
        start = Math.max(0, Math.min(start, data.length - 1));
        end = Math.max(start, Math.min(end, data.length - 1));
        res.writeHead(206, {
          'content-type': type,
          'accept-ranges': 'bytes',
          'content-range': 'bytes ' + start + '-' + end + '/' + data.length,
          'content-length': String(end - start + 1)
        });
        res.end(data.subarray(start, end + 1));
        return;
      }

      res.writeHead(200, {
        'content-type': type,
        'accept-ranges': 'bytes',
        'content-length': String(data.length)
      });
      res.end(data);
    });
  });

  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

async function domState(page) {
  return page.evaluate(() => {
    const layer = document.querySelector('.dualsub-layer');
    const en = document.querySelector('.dualsub-layer .dualsub-line.en');
    const tr = document.querySelector('.dualsub-layer .dualsub-line.tr');
    const layerStyle = layer ? getComputedStyle(layer) : null;
    const rect = layer ? layer.getBoundingClientRect() : null;

    // The player's own caption container. A few class names cover the
    // libraries under test; this is test instrumentation, not extension logic.
    const nativeSelectors = [
      '.vjs-text-track-display',
      '.plyr__captions',
      '.dplayer-subtitle',
      '.art-subtitle',
      '.jw-text-track-display',
      '.player-captions'
    ];
    const nativeText = nativeSelectors
      .map((selector) => document.querySelector(selector))
      .filter(Boolean)
      .map((el) => (el.textContent || '').trim())
      .filter(Boolean)
      .join(' | ');

    const nativeShown = nativeSelectors
      .map((selector) => document.querySelector(selector))
      .filter(Boolean)
      .some((el) => {
        if (!(el.textContent || '').trim()) {
          return false;
        }
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' &&
          style.opacity !== '0' && box.height > 0;
      });

    return {
      layers: document.querySelectorAll('.dualsub-layer').length,
      layerVisible: Boolean(layer && layerStyle.display !== 'none' &&
        layerStyle.visibility !== 'hidden' && rect && rect.height > 0),
      enText: en ? en.textContent.trim() : '',
      trText: tr ? tr.textContent.trim() : '',
      words: document.querySelectorAll('.dualsub-layer .dualsub-word').length,
      nativeText: nativeText.slice(0, 160),
      nativeShown: nativeShown,
      videoCount: document.querySelectorAll('video').length,
      readyState: (() => {
        const video = document.querySelector('video');
        return video ? Number(video.readyState) : -1;
      })()
    };
  });
}

async function seekIntoFirstCue(page) {
  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (!video) {
      return;
    }
    // Cues in every fixture start at 0.5 s; 1.2 s is safely inside the first.
    try { video.currentTime = 1.2; } catch (error) { /* not loaded yet */ }
    video.dispatchEvent(new Event('loadedmetadata'));
    video.dispatchEvent(new Event('durationchange'));
    video.dispatchEvent(new Event('timeupdate'));
    video.dispatchEvent(new Event('seeked'));
  });
}

async function waitForEnglish(page, pattern, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 9000);
  let state = await domState(page);
  while (Date.now() < deadline) {
    if (pattern.test(state.enText)) {
      return state;
    }
    await page.waitForTimeout(250);
    state = await domState(page);
  }
  return state;
}

async function diagOf(worker, pageName, attempts) {
  const tries = attempts || 6;
  for (let i = 0; i < tries; i += 1) {
    const report = await worker.evaluate(async (needle) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((row) => row.url && row.url.indexOf(needle) !== -1);
      if (!tab || typeof tab.id !== 'number') {
        return { error: 'tab not found' };
      }
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'diagnose' })
        .catch((error) => ({ error: String(error.message) }));
      return response;
    }, pageName).catch((error) => ({ evalError: String(error && error.message || error) }));

    if (report && !report.error && !report.evalError) {
      return report;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return { error: 'diagnose unavailable' };
}

const SWITCH_NEW_TEXT = /Content type capture works/;

async function switchSeekAndWait(page) {
  await seekIntoFirstCue(page);
  await page.waitForTimeout(1200);
  await seekIntoFirstCue(page);
  return waitForEnglish(page, SWITCH_NEW_TEXT, 9000);
}

async function runSwitchCases(context, worker, checkFn) {
  // The same <video> element receiving the next episode is the normal case on
  // every streaming site. These three players cover the three source models:
  // a <track> element that is pointed elsewhere, a library-owned track list,
  // and a library that rebuilds its whole source object.
  const cases = [
    {
      name: 'native',
      page: 'players/native.html',
      run: async (page) => page.evaluate(() => {
        const track = document.getElementById('t');
        track.src = '/sample2.vtt';
      })
    },
    {
      name: 'videojs',
      page: 'players/videojs.html',
      run: async (page) => page.evaluate(() => {
        window.player.src({ src: '/vendor/flower.webm', type: 'video/webm' });
        window.player.addRemoteTextTrack({
          kind: 'subtitles',
          language: 'en',
          label: 'English',
          src: '/sample2.vtt'
        }, false);
      })
    },
    {
      name: 'plyr',
      page: 'players/plyr.html',
      run: async (page) => page.evaluate(() => {
        window.player.source = {
          type: 'video',
          sources: [{ src: '/vendor/flower.webm', type: 'video/webm' }],
          tracks: [{ kind: 'subtitles', src: '/sample2.vtt', srclang: 'en', label: 'English', default: true }]
        };
      })
    }
  ];

  for (const item of cases) {
    const page = await context.newPage();
    try {
      await page.setViewportSize({ width: 900, height: 700 });
      await page.goto('http://127.0.0.1:' + PORT + '/' + item.page, { waitUntil: 'load' });
      await page.waitForTimeout(1200);
      await page.waitForSelector('.dualsub-layer', { state: 'attached', timeout: 10000 }).catch(() => null);
      const first = await switchSeekAndWait(page);
      checkFn(item.name + ' kaynak değişimi: ilk bölüm geldi',
        /Hello, how are you/.test(first.enText), JSON.stringify(first.enText));

      await item.run(page);
      await page.waitForTimeout(1500);
      const next = await switchSeekAndWait(page);
      checkFn(item.name + ' kaynak değişimi: yeni bölüm altyazısı geldi',
        SWITCH_NEW_TEXT.test(next.enText), JSON.stringify(next.enText));
      checkFn(item.name + ' kaynak değişimi: eski satır kalmadı',
        !/Hello, how are you/.test(next.enText), JSON.stringify(next.enText));
      checkFn(item.name + ' kaynak değişimi: tek katman',
        next.layers === 1, String(next.layers));

      const report = await diagOf(worker, item.page);
      checkFn(item.name + ' kaynak değişimi: teşhis active',
        report.stage === 'active', String(report.stage));
    } catch (error) {
      checkFn(item.name + ' kaynak değişimi: senaryo çalıştı', false,
        String(error && error.message || error).slice(0, 200));
    } finally {
      await page.close().catch(() => {});
    }
  }
}

const CASES = [
  { name: 'native', expect: 'Tam', pattern: /Hello, how are you/ },
  { name: 'videojs', expect: 'Tam', pattern: /Hello, how are you/ },
  { name: 'plyr', expect: 'Tam', pattern: /Hello, how are you/ },
  { name: 'dplayer', expect: 'Kısmi', pattern: /Hello, how are you/ },
  { name: 'artplayer', expect: 'Kısmi', pattern: /Hello, how are you/ },
  { name: 'custom-xhr', expect: 'Tam', pattern: /Hello, how are you/ },
  { name: 'custom-embedded', expect: 'Kismi', pattern: /Hello, how are you/ },
  { name: 'custom-canvas', expect: 'Desteklenmiyor', pattern: /Hello, how are you/ },
  // A metadata track full of HLS/ID3 JSON plus a normal XHR subtitle. The JSON
  // was once painted as a subtitle; it must never reach the layer, and it must
  // not stop the real file from being captured.
  { name: 'metadata', expect: 'Tam', pattern: /Hello, how are you/,
    forbid: /metadataType|DISCONTINUITY|SCTE35|payload=/ }
];

(async () => {
  const server = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dualsub-players-'));
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

    let workers = context.serviceWorkers();
    if (!workers.length) {
      workers = [await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null)];
    }
    const worker = workers.filter(Boolean)[0];
    check('service worker starts', Boolean(worker));

    for (const item of CASES) {
      const page = await context.newPage();
      await page.setViewportSize({ width: 900, height: 700 });

      const logs = [];
      page.on('console', (message) => logs.push('console[' + message.type() + '] ' + message.text()));
      page.on('pageerror', (error) => logs.push('pageerror ' + error.message));

      const pageName = 'players/' + item.name + '.html';
      await page.goto(BASE + pageName, { waitUntil: 'load' });
      await page.waitForTimeout(1200);

      const layer = await page.waitForSelector('.dualsub-layer', { state: 'attached', timeout: 10000 })
        .catch(() => null);
      check(item.name + ': altyazı katmanı oluşturuldu', Boolean(layer));

      // The player has to be playing for its cue list to be populated; a seek is
      // enough for both text tracks and XHR-driven players.
      await seekIntoFirstCue(page);
      await page.waitForTimeout(1500);
      await seekIntoFirstCue(page);

      let state = await waitForEnglish(page, item.pattern, 9000);
      if (!item.pattern.test(state.enText)) {
        // One more seek: segmented players can attach their cue list late.
        await seekIntoFirstCue(page);
        await page.waitForTimeout(1500);
        state = await waitForEnglish(page, item.pattern, 4000);
      }

      const report = await diagOf(worker, pageName);
      const stage = report.stage || '?';
      const adaptor = report.renderer || '?';
      const cueCount = report.englishCues !== undefined ? report.englishCues : (report.cueCount || 0);
      info(item.name + ' teşhis', 'stage=' + stage + ' adaptör=' + adaptor +
        ' EN cue=' + cueCount + ' TR cue=' + (report.turkishCues || 0) +
        ' yakalanan=' + (report.capturedTracks || 0) +
        (report.lastError ? ' hata=' + report.lastError : ''));

      const supports = item.expect !== 'Desteklenmiyor';
      if (supports) {        check(item.name + ': İngilizce satır gerçek altyazıdan geldi',
          item.pattern.test(state.enText), JSON.stringify(state.enText));
        check(item.name + ': kelimeler tıklanabilir span',
          state.words >= 4, String(state.words));
        check(item.name + ': katman görünür',
          state.layerVisible, JSON.stringify({
            layers: state.layers, visible: state.layerVisible
          }));
        check(item.name + ': video bulundu',
          state.videoCount === 1 && report.videos !== 0,
          'dom=' + state.videoCount + ' diag=' + report.videos);
        check(item.name + ': teşhis aşaması active',
          stage === 'active', stage);
        check(item.name + ': Türkçe kanal dolu (gerçek track veya çeviri)',
          Number(report.turkishCues || 0) > 0, String(report.turkishCues || 0));
      } else {
        // Documented gap: no text track, no network fetch. A DOM caption
        // adaptor is needed; until it exists this must fail loudly instead of
        // silently pretending support.
        info(item.name + ' beklenen boşluk', 'EN="' + state.enText +
          '" stage=' + stage + ' adaptör=' + adaptor);
        check(item.name + ': altyazı verisi erişilemiyor (bilinen boşluk)',
          !item.pattern.test(state.enText), JSON.stringify(state.enText));
      }

      // Timed metadata (HLS/ID3/EMSG) is not dialogue. If any of it reached the
      // overlay the user would see a wall of JSON instead of a sentence.
      if (item.forbid) {
        const painted = state.enText + ' ' + state.trText;
        check(item.name + ': meta veri JSON altyazı olarak gösterilmedi',
          !item.forbid.test(painted), JSON.stringify(painted.slice(0, 120)));
      }

      // The player's own caption layer must not show the same line underneath
      // ours. Reading it here is measurement only.
      if (state.nativeText) {
        info(item.name + ' yerel katman metni', JSON.stringify(state.nativeText));
      }
      if (supports && state.nativeText) {
        check(item.name + ': oynatıcının kendi altyazı katmanı gizlendi',
          !state.nativeShown, JSON.stringify({ shown: state.nativeShown }));
      }
      if (!supports && state.nativeText) {
        // The documented gap must not be made worse: the site keeps working.
        check(item.name + ': oynatıcının kendi katmanı bozulmadı',
          state.nativeShown, JSON.stringify({ shown: state.nativeShown }));
      }

      check(item.name + ': tek katman (çoğaltma yok)', state.layers === 1, String(state.layers));

      if (logs.length && (failures > 0 || process.env.DUALSUS_PLAYERS_VERBOSE)) {
        for (const line of logs.slice(-8)) {
          console.log('      ' + line);
        }
      }

      await page.close();
    }

    await runSwitchCases(context, worker, check);
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    server.close();
  }

  console.log('');
  console.log(checks + ' kontrol, ' + failures + ' başarısız.');
  if (failures) {
    process.exit(1);
  }
  console.log('Tüm oynatıcı testleri geçti.');
})();
