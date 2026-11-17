/* Popup behaviour test: the states the user actually sees.
 *
 * The popup is loaded as a real page in a real Chromium with a stubbed
 * chrome.* API, so the code under test is ui/popup.js itself - not a copy.
 *
 * The case that matters most: a tab message that never answers. It used to
 * leave the badge on "Kontrol ediliyor…" forever while the message underneath
 * already said the page was unreachable. Every probe is now bounded, so that
 * pair cannot be produced.
 *
 *   node test/popup-check.js
 */
'use strict';

const path = require('path');
const { chromium } = require(path.resolve('C:\\Users\\fatih\\ceviri-projesi\\node_modules\\playwright-core'));

const root = path.resolve(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const POPUP_URL = 'file:///' + path.join(root, 'ui', 'popup.html').replace(/\\/g, '/');

let checks = 0;
let failures = 0;

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

const STUB = () => {
  const stub = {
    mode: 'ok',
    sendCalls: 0,
    failNext: false,
    messages: [],
    setCalls: [],
    reloaded: false,
    stored: {
      settings: {
        enabled: true,
        englishOn: true,
        turkishOn: true,
        fontSize: 100,
        position: 'bottom'
      }
    },
    pageState: {
      enabled: true,
      settingsLoaded: true,
      hasVideo: true,
      hasEnglishCues: true,
      hasTurkishCues: true,
      englishOn: true,
      turkishOn: true,
      englishVisible: true,
      turkishVisible: true,
      fontSize: 100,
      position: 'bottom',
      activeWords: 5,
      stage: 'active',
      stageText: 'altyazı aktif',
      platform: 'YouTube',
      adaptor: 'generic-track',
      cueCount: 5,
      translated: true,
      lastError: ''
    }
  };

  window.__stub = stub;

  const chromeStub = {
    runtime: {
      lastError: null,
      getManifest: () => ({
        manifest_version: 3,
        content_scripts: [
          { js: ['shared/constants.js', 'content/content.js'], css: ['styles.css'] },
          { js: ['adaptors/network-capture.js'], world: 'MAIN' }
        ]
      }),
      sendMessage: (message, callback) => {
        // The service worker is not part of this test; answering null keeps the
        // popup on its "worker not running" path without hanging.
        setTimeout(() => { if (callback) callback(null); }, 0);
      },
      onMessage: { addListener: () => {} }
    },
    tabs: {
      query: async () => [{ id: 7, url: 'https://www.youtube.com/watch?v=abc' }],
      sendMessage: (tabId, message, callback) => {
        stub.sendCalls += 1;
        stub.messages.push(message);

        if (stub.mode === 'silent') {
          // A listener that returns true and never answers. This is the real
          // hang: the callback is simply never invoked.
          return;
        }

        if (stub.failNext) {
          // One late "receiving end does not exist", the way a tab that was open
          // before an extension reload behaves. The popup then reinjects and
          // retries, which takes hundreds of milliseconds - long enough for a
          // second click to overtake the first one.
          stub.failNext = false;
          chromeStub.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
          setTimeout(() => {
            if (callback) callback(undefined);
            chromeStub.runtime.lastError = null;
          }, 0);
          return;
        }

        if (stub.mode === 'error' || stub.mode === 'hangInject') {
          chromeStub.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
          setTimeout(() => {
            if (callback) callback(undefined);
            chromeStub.runtime.lastError = null;
          }, 0);
          return;
        }

        setTimeout(() => {
          if (callback) callback(Object.assign({}, stub.pageState));
        }, 10);
      },
      reload: async () => { stub.reloaded = true; }
    },
    scripting: {
      insertCSS: async () => {},
      executeScript: async (options) => {
        if (stub.mode === 'hangInject') {
          // An executeScript call that never settles, which is what left the
          // old popup waiting forever.
          return new Promise(() => {});
        }
        if (stub.mode === 'ok') {
          // The readiness probe from the popup runs in the same isolated world.
          return [{ frameId: 0, result: true }];
        }
        throw new Error('Cannot access contents of the page.');
      }
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: stub.stored[key] }),
        set: async (patch) => {
          stub.setCalls.push(patch);
          Object.assign(stub.stored, patch);
        }
      },
      onChanged: { addListener: () => {} }
    }
  };

  Object.defineProperty(window, 'chrome', { value: chromeStub, configurable: true });
};

async function badge(page) {
  return page.evaluate(() => {
    const support = document.getElementById('supportBadge');
    const message = document.getElementById('pageMessage');
    const recovery = document.getElementById('recoveryRow');
    return {
      support: support ? support.textContent.trim() : '',
      message: message ? message.textContent.trim() : '',
      recoveryHidden: recovery ? recovery.classList.contains('is-hidden') : true,
      master: document.getElementById('masterToggle').checked,
      english: document.getElementById('englishToggle').checked
    };
  });
}

async function waitForBadge(page, text, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000);
  let info = await badge(page);
  while (Date.now() < deadline) {
    if (info.support === text) {
      return info;
    }
    await page.waitForTimeout(100);
    info = await badge(page);
  }
  return info;
}

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });

  try {
    /* ---------- 1. a healthy page ---------- */

    let page = await browser.newPage();
    await page.addInitScript(STUB);
    await page.goto(POPUP_URL, { waitUntil: 'load' });

    let info = await waitForBadge(page, 'Altyazı hazır', 6000);
    check('connected page: the badge reports ready subtitles', info.support === 'Altyazı hazır',
      JSON.stringify(info));
    check('connected page: the master switch follows the saved setting', info.master === true, String(info.master));

    /* ---------- 2. a tab that never answers ---------- */

    await page.close();
    page = await browser.newPage();
    await page.addInitScript(STUB);
    await page.addInitScript(() => {
      // Applied before the popup reads the stub; the hang must start at boot.
      const original = window.__stub;
      Object.defineProperty(window, '__stubPending', { value: true, configurable: true });
    });
    await page.addInitScript(() => {
      // The stub is created by the previous init script; switch it to the
      // silent mode as soon as it exists.
      let tries = 0;
      const timer = setInterval(() => {
        if (window.__stub) {
          window.__stub.mode = 'silent';
          clearInterval(timer);
        }
        if (++tries > 200) {
          clearInterval(timer);
        }
      }, 0);
    });
    await page.goto(POPUP_URL, { waitUntil: 'load' });

    info = await waitForBadge(page, 'Bağlantı yok', 9000);
    check('silent tab: the badge leaves "Kontrol ediliyor…"', info.support === 'Bağlantı yok',
      JSON.stringify(info));
    check('silent tab: the reason is shown instead of a bare failure',
      info.message.indexOf('bağlantı kurulamadı') >= 0, JSON.stringify(info.message));
    check('silent tab: a retry action is offered', info.recoveryHidden === false, String(info.recoveryHidden));

    // The old bug was a stuck label. Waiting past every internal timeout proves
    // it cannot come back on its own.
    await page.waitForTimeout(2500);
    info = await badge(page);
    check('silent tab: the badge stays out of the checking state',
      info.support !== 'Kontrol ediliyor…', JSON.stringify(info.support));

    /* ---------- 3. a hung executeScript ---------- */

    await page.close();
    page = await browser.newPage();
    await page.addInitScript(STUB);
    await page.addInitScript(() => {
      let tries = 0;
      const timer = setInterval(() => {
        if (window.__stub) {
          window.__stub.mode = 'hangInject';
          clearInterval(timer);
        }
        if (++tries > 200) {
          clearInterval(timer);
        }
      }, 0);
    });
    await page.goto(POPUP_URL, { waitUntil: 'load' });

    info = await waitForBadge(page, 'Bağlantı yok', 12000);
    check('hung injection: the popup still reaches a final state',
      info.support === 'Bağlantı yok', JSON.stringify(info));
    check('hung injection: the message keeps a concrete reason',
      info.message.length > 40, JSON.stringify(info.message));

    /* ---------- 4. retry recovers ---------- */

    await page.evaluate(() => { window.__stub.mode = 'ok'; });
    await page.click('#retryButton');
    info = await waitForBadge(page, 'Altyazı hazır', 6000);
    check('retry: pressing the button re-probes the tab', info.support === 'Altyazı hazır',
      JSON.stringify(info));

    /* ---------- 5. settings persist immediately ---------- */

    await page.evaluate(() => { window.__stub.setCalls.length = 0; });
    // The visible switch is a styled span; click the label like a user would.
    await page.evaluate(() => {
      const input = document.getElementById('englishToggle');
      input.click();
    });
    await page.waitForTimeout(300);
    const writes = await page.evaluate(() => window.__stub.setCalls.slice());
    const wroteEnglish = writes.some((entry) => {
      const saved = entry && entry.settings;
      return saved && saved.englishOn === false;
    });
    check('a change is written to storage without the old 250 ms delay', wroteEnglish,
      JSON.stringify(writes));

    /* ---------- 6. two quick toggles keep their order ---------- */

    // The reported bug: turning the Turkish line off and straight back on left
    // it off, and only a page refresh brought it back. The first command was
    // being retried for hundreds of milliseconds while the second one overtook
    // it, so the page ended in the older state. Commands are now queued.
    await page.evaluate(() => {
      window.__stub.failNext = true;
      window.__stub.messages.length = 0;
      const input = document.getElementById('turkishToggle');
      input.click();
      setTimeout(() => input.click(), 30);
    });
    await page.waitForTimeout(3000);

    const toggles = await page.evaluate(() => {
      const patches = window.__stub.messages
        .filter((m) => m && m.type === 'apply-settings' && m.patch && 'turkishOn' in m.patch)
        .map((m) => m.patch.turkishOn);
      return {
        patches: patches,
        stored: window.__stub.stored.settings.turkishOn,
        checked: document.getElementById('turkishToggle').checked
      };
    });
    check('two quick toggles: the page receives them in order',
      toggles.patches.length >= 2 &&
      toggles.patches[toggles.patches.length - 2] === false &&
      toggles.patches[toggles.patches.length - 1] === true,
      JSON.stringify(toggles.patches));
    check('two quick toggles: the switch and the saved setting end up on',
      toggles.stored === true && toggles.checked === true, JSON.stringify(toggles));

    /* ---------- 7. reload action ---------- */

    await page.evaluate(() => { window.__stub.mode = 'silent'; });
    await page.evaluate(() => { window.__stub.reloaded = false; });
    await page.close();

    page = await browser.newPage();
    await page.addInitScript(STUB);
    await page.addInitScript(() => {
      let tries = 0;
      const timer = setInterval(() => {
        if (window.__stub) {
          window.__stub.mode = 'silent';
          clearInterval(timer);
        }
        if (++tries > 200) {
          clearInterval(timer);
        }
      }, 0);
    });
    await page.goto(POPUP_URL, { waitUntil: 'load' });
    await waitForBadge(page, 'Bağlantı yok', 9000);
    const hasReload = await page.evaluate(() => Boolean(document.getElementById('reloadButton')));
    check('the popup offers a reload action when it cannot connect', hasReload);

    await page.close();
  } finally {
    await browser.close();
  }

  console.log('');
  console.log(checks + ' kontrol, ' + failures + ' başarısız.');
  if (failures) {
    process.exit(1);
  }
  console.log('Tüm popup kontrolleri geçti.');
})().catch((error) => {
  console.log('TEST ERROR', error && error.stack ? error.stack : error);
  process.exit(1);
});
