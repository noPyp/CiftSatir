document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);

  // `shared/constants.js` publishes `window.DualSub`; it does not create a
  // global `DS` (the content scripts each alias it themselves). The popup used
  // the bare name, so the first `DS.constants` read threw a ReferenceError
  // inside the boot promise. Nothing after it ran: settings were never read,
  // the page was never probed, and every switch handler died on the same line,
  // which is why the badge sat on "Kontrol ediliyor…" and no toggle did
  // anything. The alias (and the explicit guard) fix that class of failure.
  const DS = globalThis.DualSub;

  if (!DS || !DS.constants || !DS.messaging) {
    const message = $('pageMessage');
    if (message) {
      message.textContent = 'Eklenti betikleri yüklenemedi. Eklentiyi opera://extensions sayfasından yenileyin.';
      message.classList.add('is-error');
    }
    return;
  }

  const masterToggle = $('masterToggle');
  const stateBadge = $('stateBadge');
  const supportBadge = $('supportBadge');
  const pageMessage = $('pageMessage');
  const retryButton = $('retryButton');
  const reloadButton = $('reloadButton');
  const recoveryRow = $('recoveryRow');
  const diagLine = $('diagLine');
  const subtitleCard = $('subtitleCard');
  const englishToggle = $('englishToggle');
  const turkishToggle = $('turkishToggle');
  const sizeRange = $('sizeRange');
  const sizeValue = $('sizeValue');
  const positionGroup = $('positionGroup');
  const subtitleHint = $('subtitleHint');
  const styleCard = $('styleCard');
  const stylePreview = $('stylePreview');
  const styleReset = $('styleReset');
  const presetGroup = $('presetGroup');
  const enColorInput = $('enColor');
  const trColorInput = $('trColor');
  const hoverColorInput = $('hoverColor');
  const bgToggle = $('bgToggle');
  const bgOpacityRow = $('bgOpacityRow');
  const bgOpacityRange = $('bgOpacity');
  const bgOpacityValue = $('bgOpacityValue');
  const outlineToggle = $('outlineToggle');
  const libCount = $('libCount');
  const libraryHint = $('libraryHint');
  const openSiteButton = $('openSite');
  const openLibraryButton = $('openLibrary');
  const helpToggle = $('helpToggle');
  const helpBody = $('helpBody');
  const diagnoseButton = $('diagnoseButton');
  const diagnoseOut = $('diagnoseOut');
  const siteUrlInput = $('siteUrlInput');
  const saveSiteUrlButton = $('saveSiteUrl');
  const siteFileInput = $('siteFileInput');
  const saveSiteFileButton = $('saveSiteFile');
  const apiKeyInput = $('apiKeyInput');
  const saveKeyButton = $('saveKeyButton');
  const clearKeyButton = $('clearKeyButton');
  const keyStatus = $('keyStatus');
  const clearCacheButton = $('clearCache');
  const swStatus = $('swStatus');
  const toastEl = $('toast');

  const DEFAULTS = {
    enabled: true,
    englishOn: true,
    turkishOn: true,
    fontSize: 100,
    position: 'bottom',
    enColor: '#f8fbff',
    trColor: '#dff7e6',
    hoverColor: '#38bdf8',
    bgOn: true,
    bgOpacity: 58,
    outline: true,
    siteUrl: 'http://127.0.0.1:5173/',
    // Used when the local server is not running. The site is a single built HTML
    // file, so it opens without any server at all.
    siteFileUrl: 'file:///C:/Users/fatih/ceviri-projesi/Ceviri-Kitabi.html'
  };

  // Appearance keys and the one-click themes in the "Görünüm" card.
  const APPEARANCE_KEYS = ['enColor', 'trColor', 'hoverColor', 'bgOn', 'bgOpacity', 'outline'];
  const HEX_COLOR = /^#[0-9a-f]{6}$/i;
  const PRESETS = {
    classic: { enColor: '#f8fbff', trColor: '#dff7e6', hoverColor: '#38bdf8', bgOn: true, bgOpacity: 58, outline: true },
    cinema: { enColor: '#ffffff', trColor: '#ffe28a', hoverColor: '#38bdf8', bgOn: false, bgOpacity: 58, outline: true },
    yellow: { enColor: '#ffd84d', trColor: '#ffffff', hoverColor: '#f97316', bgOn: true, bgOpacity: 45, outline: true },
    contrast: { enColor: '#ffffff', trColor: '#7dffb0', hoverColor: '#facc15', bgOn: true, bgOpacity: 90, outline: false }
  };

  const state = {
    settings: Object.assign({}, DEFAULTS),
    tabId: null,
    tabUrl: '',
    page: null,
    supported: false,
    blocked: false,
    siteMode: '',
    // Connection is a separate fact from "the extension is off". The popup used
    // to represent both with `page === null`, which left the badge stuck on
    // "Kontrol ediliyor…" forever after a failed connection.
    checking: true,
    connected: false,
    connectionError: '',
    // True once a probe has produced a final answer for this popup session.
    // Until then "Kontrol ediliyor…" is honest; afterwards it never comes back
    // except on an explicit retry, so a stalled probe cannot freeze the badge.
    probed: false,
    refreshPromise: null,
    refreshQueued: false
  };

  const TAB_TIMEOUT = 1600;

  let toastTimer = 0;
  let liveTimer = 0;
  let verifyTimer = 0;

  // Commands to the page are sent one at a time, in the order the user made
  // them. Two quick toggles used to race: the "off" command (delayed by a
  // missing-script retry) could land after the "on" command, leaving the page
  // off while the popup showed on, and only a page refresh put it back.
  let actionChain = Promise.resolve();

  function enqueue(action) {
    actionChain = actionChain.then(action).catch(() => {});
    return actionChain;
  }

  /* ---------- small helpers ---------- */

  function toast(text, isError) {
    clearTimeout(toastTimer);
    toastEl.textContent = text;
    toastEl.classList.toggle('is-error', Boolean(isError));
    toastEl.hidden = false;
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 2600);
  }

  function errorText(error) {
    return String(error && error.message ? error.message : error || '');
  }

  // A chrome.tabs.sendMessage callback is not guaranteed to arrive: a frame can
  // be torn down, a listener can return true and never answer, or the extension
  // context can be invalidated. Without a limit the popup stayed on
  // "Kontrol ediliyor…" indefinitely, which is exactly what the user saw.
  function withTimeout(promise, ms, fallback) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(typeof fallback === 'function' ? fallback() : fallback);
        }
      }, ms);

      Promise.resolve(promise).then((value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }).catch((error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(typeof fallback === 'function' ? fallback(error) : fallback);
      });
    });
  }

  // Same idea, but keeps "did it answer, and why not" separate from the value.
  // chrome.scripting calls are the ones that could stay pending forever on a
  // page that is navigating or restricted, and an unbounded await there is what
  // left the badge on "Kontrol ediliyor…" with no way out.
  function settle(promise, ms) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          resolve({ ok: false, timeout: true, error: ms + ' ms içinde yanıt yok.' });
        }
      }, ms);

      Promise.resolve(promise).then((value) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        resolve({ ok: true, value: value });
      }).catch((error) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, error: errorText(error) });
      });
    });
  }

  function platformName(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') {
        return 'YouTube';
      }
      if (host === 'netflix.com' || host.endsWith('.netflix.com')) {
        return 'Netflix';
      }
    } catch (error) {
      // A missing or unparsable URL is not an error here.
    }
    return '';
  }

  function isBlockedPage(url) {
    return /^(chrome|opera|edge|about|devtools|chrome-extension|moz-extension|view-source|chrome-untrusted):/i.test(url || '');
  }

  function normalizedSiteUrl(value) {
    let raw = String(value || '').trim();
    if (!raw) {
      return DEFAULTS.siteUrl;
    }
    if (!/^(https?|file):\/\//i.test(raw)) {
      raw = 'http://' + raw;
    }
    try {
      return new URL(raw).href;
    } catch (error) {
      return '';
    }
  }

  function siteUrlWithHash(base, hash) {
    try {
      const url = new URL(base || DEFAULTS.siteUrl);
      url.hash = hash || '';
      return url.href;
    } catch (error) {
      return '';
    }
  }

  function sendToTabOnce(message) {
    return new Promise((resolve) => {
      if (state.tabId === null) {
        resolve({ ok: false, error: 'Etkin sekme bulunamadı.' });
        return;
      }

      let settled = false;
      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({ ok: false, error: 'İçerik betiği ' + TAB_TIMEOUT + ' ms içinde yanıt vermedi.', timeout: true });
      }, TAB_TIMEOUT);

      try {
        chrome.tabs.sendMessage(state.tabId, message, (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            finish({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          if (!response) {
            finish({ ok: false, error: 'İçerik betiği yanıt vermedi.' });
            return;
          }
          finish({ ok: true, response: response });
        });
      } catch (error) {
        clearTimeout(timer);
        finish({ ok: false, error: errorText(error) });
      }
    });
  }

  // Tabs that were already open when the extension was installed or reloaded
  // have no content script: Chrome only injects into pages loaded afterwards.
  // Without this, the popup reported "sayfayla bağlantı kurulamadı" on exactly
  // the tab the user cared about, and the only cure was a manual refresh.
  //
  // The file list is read from the manifest, so there is no second copy to keep
  // in sync. content.js refuses to initialise twice, so a page that already has
  // the script cannot end up with a duplicate overlay.
  async function injectContentScript() {
    const manifest = chrome.runtime.getManifest();
    const entries = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
    if (!entries.length || state.tabId === null) {
      return { ok: false, error: 'Enjekte edilecek betik bulunamadı.' };
    }

    let injectedAny = false;
    let lastError = '';
    let partial = false;

    // Every entry is injected, including the MAIN-world capture script. Only
    // injecting the isolated-world entry meant a tab opened before an extension
    // reload could never capture .vtt files fetched by its player.
    for (const entry of entries) {
      if (!entry || !Array.isArray(entry.js) || !entry.js.length) {
        continue;
      }

      const target = { tabId: state.tabId, allFrames: true };
      const world = entry.world === 'MAIN' ? 'MAIN' : 'ISOLATED';

      if (Array.isArray(entry.css) && entry.css.length && world !== 'MAIN') {
        // The stylesheet is cosmetic; a slow one must not hold up the script.
        await settle(chrome.scripting.insertCSS({ target: target, files: entry.css }), 1200);
      }

      const allFrames = await settle(
        chrome.scripting.executeScript({ target: target, files: entry.js, world: world }),
        2000
      );

      if (allFrames.ok) {
        injectedAny = true;
        continue;
      }

      if (allFrames.timeout) {
        // A timed-out call may still have injected into some frames; retrying on
        // the top frame keeps the popup responsive without guessing.
        lastError = allFrames.error;
        partial = true;
        continue;
      }

      // A single restricted frame (about:blank, a sandboxed ad, a PDF viewer)
      // fails the whole call. Retrying on the top frame still makes the page
      // work, and the video frame usually rejects only because it is closed.
      const topFrame = await settle(
        chrome.scripting.executeScript({
          target: { tabId: state.tabId },
          files: entry.js,
          world: world
        }),
        2000
      );

      if (topFrame.ok) {
        injectedAny = true;
        partial = true;
      } else {
        lastError = topFrame.error || allFrames.error;
      }
    }

    if (!injectedAny) {
      return { ok: false, error: lastError || 'İçerik betiği enjekte edilemedi.' };
    }

    return { ok: true, partial: partial };
  }

  function looksLikeMissingScript(error) {
    return /receiving end does not exist|could not establish connection|message port closed|yanıt vermedi/i
      .test(String(error || ''));
  }

  async function sendToTab(message) {
    const first = await sendToTabOnce(message);

    if (first.ok || state.tabId === null || state.blocked || !looksLikeMissingScript(first.error)) {
      return first;
    }

    const injected = await injectContentScript();
    if (!injected.ok) {
      return { ok: false, error: first.error, injectError: injected.error };
    }

    // The injected script registers its message listener synchronously, but the
    // page may still be settling. Two short tries, bounded, so the popup cannot
    // sit on a pending promise while nothing answers.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 180));
      const retry = await sendToTabOnce(message);
      if (retry.ok) {
        return retry;
      }
    }

    return {
      ok: false,
      error: 'İçerik betiği sayfaya yüklendi ama yanıt vermedi.',
      injectError: ''
    };
  }

  // Answers the one question the popup cannot answer from messages: did the
  // content script actually load in this tab? A tab that existed before an
  // extension reload has no script at all until it is injected; a script that
  // loaded but never answers is a different bug with a different cure.
  async function contentScriptState() {
    if (state.tabId === null || state.blocked || !chrome.scripting) {
      return 'unknown';
    }

    const probe = await settle(chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      func: () => Boolean(globalThis.__dualsubContentReady)
    }), 1200);

    if (!probe.ok) {
      return 'unknown';
    }

    const rows = Array.isArray(probe.value) ? probe.value : [];
    return rows.some((row) => row && row.result) ? 'ready' : 'missing';
  }

  async function readActiveTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      state.tabId = tab && typeof tab.id === 'number' ? tab.id : null;
      state.tabUrl = (tab && tab.url) || '';
    } catch (error) {
      state.tabId = null;
      state.tabUrl = '';
    }
  }

  /* ---------- rendering ---------- */

  function colorSetting(key) {
    const value = String(state.settings[key] || '');
    return HEX_COLOR.test(value) ? value.toLowerCase() : DEFAULTS[key];
  }

  function opacitySetting() {
    const value = Number(state.settings.bgOpacity);
    return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : DEFAULTS.bgOpacity;
  }

  function settingsPayload() {
    return {
      enabled: Boolean(state.settings.enabled),
      englishOn: Boolean(state.settings.englishOn),
      turkishOn: Boolean(state.settings.turkishOn),
      fontSize: Number(state.settings.fontSize) || 100,
      position: state.settings.position || 'bottom',
      enColor: colorSetting('enColor'),
      trColor: colorSetting('trColor'),
      hoverColor: colorSetting('hoverColor'),
      bgOn: state.settings.bgOn !== false,
      bgOpacity: opacitySetting(),
      outline: state.settings.outline !== false,
      siteUrl: normalizedSiteUrl(state.settings.siteUrl) || DEFAULTS.siteUrl,
      siteFileUrl: normalizedSiteUrl(state.settings.siteFileUrl) || DEFAULTS.siteFileUrl
    };
  }

  // Writes through chrome.storage.local directly, and immediately. The old code
  // waited 250 ms and then asked the service worker; closing the popup within
  // that window lost the change, so the page kept subtitles running while the
  // switch showed "off". Storage is also the one channel every frame sees via
  // storage.onChanged, even when a direct tab message fails.
  async function persistNow() {
    const payload = settingsPayload();
    const key = DS.constants.STORAGE_SETTINGS;

    try {
      const stored = await withTimeout(chrome.storage.local.get(key), 1200, null);
      const current = (stored && stored[key]) || {};
      await chrome.storage.local.set({ [key]: Object.assign({}, current, payload) });
      return true;
    } catch (error) {
      // Older/restricted contexts may not expose storage; the worker path is
      // still there as a fallback.
      const saved = await withTimeout(DS.messaging.saveSettings(payload), 3000, null);
      return Boolean(saved);
    }
  }

  async function loadStoredSettings() {
    const key = DS.constants.STORAGE_SETTINGS;

    try {
      const stored = await withTimeout(chrome.storage.local.get(key), 1200, null);
      const saved = stored && stored[key];
      if (saved && typeof saved === 'object') {
        return saved;
      }
    } catch (error) {
      // Fall through to the worker.
    }

    const fromWorker = await withTimeout(DS.messaging.getSettings(1600), 1800, null);
    return fromWorker && typeof fromWorker === 'object' ? fromWorker : null;
  }

  function applyLoadedSettings(loaded) {
    if (!loaded) {
      return;
    }

    for (const key of ['enabled', 'englishOn', 'turkishOn', 'fontSize', 'position'].concat(APPEARANCE_KEYS)) {
      if (loaded[key] !== undefined) {
        state.settings[key] = loaded[key];
      }
    }
    if (loaded.siteUrl !== undefined) {
      state.settings.siteUrl = normalizedSiteUrl(loaded.siteUrl) || DEFAULTS.siteUrl;
    }
    if (loaded.siteFileUrl !== undefined) {
      state.settings.siteFileUrl = normalizedSiteUrl(loaded.siteFileUrl) || DEFAULTS.siteFileUrl;
    }
  }

  // After a change the popup verifies the page instead of assuming the command
  // took effect. A stale overlay or a failed message becomes visible as a real
  // status instead of a switch that lies.
  function scheduleVerify() {
    clearTimeout(verifyTimer);
    verifyTimer = setTimeout(() => {
      refreshPage().catch(() => {});
    }, 350);
  }

  function renderMaster() {
    const enabled = Boolean(state.settings.enabled);
    masterToggle.checked = enabled;
    stateBadge.textContent = enabled ? 'Açık' : 'Kapalı';
    stateBadge.classList.toggle('is-on', enabled);
    stateBadge.classList.toggle('is-off', !enabled);
  }

  function renderSupport() {
    supportBadge.className = 'badge';

    if (state.blocked) {
      supportBadge.textContent = 'Desteklenmiyor';
      supportBadge.classList.add('is-bad');
      return;
    }

    // "Still checking" is a real, short-lived state. A failed connection gets
    // its own label; it must never masquerade as an unfinished check.
    if (state.checking) {
      supportBadge.textContent = 'Kontrol ediliyor…';
      supportBadge.classList.add('is-muted');
      return;
    }

    if (!state.connected || !state.page) {
      supportBadge.textContent = 'Bağlantı yok';
      supportBadge.classList.add('is-bad');
      return;
    }

    const page = state.page;

    if (!page.enabled) {
      supportBadge.textContent = 'Eklenti kapalı';
      supportBadge.classList.add('is-off');
      return;
    }

    if (page.hasEnglishCues || page.hasTurkishCues) {
      supportBadge.textContent = 'Altyazı hazır';
      supportBadge.classList.add('is-on');
      return;
    }

    if (page.stage === 'error' || page.lastError) {
      supportBadge.textContent = 'Hata';
      supportBadge.classList.add('is-bad');
      return;
    }

    if (page.hasVideo) {
      supportBadge.textContent = 'Video hazır';
      supportBadge.classList.add('is-warn');
      return;
    }

    supportBadge.textContent = 'Video bekleniyor';
    supportBadge.classList.add('is-warn');
  }

  function renderMessage() {
    let text = 'Bu sekme kontrol ediliyor…';
    let isError = false;
    let showRetry = false;

    if (state.blocked) {
      text = 'Eklenti; opera://, chrome:// ve eklenti mağazası sayfalarında çalışamaz. Bir video sekmesinde deneyin.';
      isError = true;
    } else if (state.checking) {
      text = 'Sayfa durumu okunuyor…';
    } else if (!state.connected || !state.page) {
      // The reason is shown, not just "connection failed": "the script is not
      // there" and "the script is there but deaf" need different actions.
      const detail = state.connectionError || '';
      text = 'Sayfayla bağlantı kurulamadı. Sekmeyi bir kez yenilemek genelde çözer.' +
        (detail ? ' (' + detail + ')' : '');
      isError = true;
      showRetry = true;
    } else {
      const page = state.page;

      if (!page.enabled) {
        text = 'Altyazı kapalı. Açmak için yukarıdaki ana anahtarı kullanın.';
      } else if (page.hasVideo) {
        const bits = [];
        if (page.hasEnglishCues) {
          bits.push('İngilizce altyazı hazır');
        }
        if (page.hasTurkishCues) {
          bits.push(page.autoTranslated ? 'Türkçe çeviri hazır' : 'Türkçe altyazı hazır');
        }

        if (bits.length) {
          bits.push(page.activeWords + ' tıklanabilir kelime');
          text = bits.join(' · ');
        } else if (page.refusedTrack) {
          text = 'Sayfadaki altyazı İngilizce veya Türkçe değil, bu yüzden gösterilmiyor. Kendi .srt/.vtt dosyanı videonun üzerine sürükleyebilirsin.';
        } else {
          text = 'Video bulundu, altyazı bekleniyor. Altyazıyı oynatıcıdan aç ya da .srt/.vtt dosyanı videonun üzerine sürükle.';
        }
      } else if (page.inFrame) {
        text = 'Bu çerçevede video yok. Altyazı, oynatıcının bulunduğu çerçevede gösterilir.';
      } else {
        const platform = platformName(state.tabUrl);
        text = platform
          ? platform + ' sayfasında video bekleniyor. Bir video açınca altyazı otomatik gelir.'
          : 'Bu sayfada henüz video görünmüyor. Videoyu başlat; oynatıcı altyazıyı veriyorsa satırlar kendiliğinden gelir. Altyazı yoksa .srt/.vtt dosyanı videonun üzerine sürükle.';
      }
    }

    pageMessage.textContent = text;
    pageMessage.classList.toggle('is-error', isError);

    if (recoveryRow) {
      recoveryRow.classList.toggle('is-hidden', !showRetry);
    }
  }

  // Compact "where is the pipeline" line. This is what answers "why does it
  // show nothing?" without opening devtools: platform, stage, which adaptor is
  // reading the subtitles, how many cues arrived, whether translation worked.
  function renderDiagnostics() {
    if (!diagLine) {
      return;
    }

    const page = state.page;
    if (state.blocked || !page) {
      diagLine.textContent = '';
      diagLine.classList.add('is-hidden');
      return;
    }

    const stage = String(page.stageText || '');
    const bits = [];
    if (page.platform) {
      bits.push(page.platform);
    }
    if (stage) {
      bits.push(stage);
    }
    if (page.adaptor) {
      bits.push('kaynak: ' + page.adaptor);
    }
    if (page.cueCount) {
      bits.push(page.cueCount + ' cue');
    }
    if (page.cueCount || page.adaptor) {
      bits.push(page.translated ? 'TR hazır' : 'TR bekleniyor');
    }

    const text = bits.join(' · ');
    diagLine.textContent = text;
    diagLine.classList.toggle('is-hidden', !text);
    diagLine.classList.toggle('is-error', page.stage === 'error' || Boolean(page.lastError));

    if (page.lastError) {
      diagLine.textContent = text + ' · hata: ' + page.lastError +
        (page.errorStage ? ' (' + page.errorStage + ')' : '');
    }
  }

  // Mirrors the overlay's own rules (content/overlay.js appearanceVars) so the
  // preview shows exactly what the video will show.
  function previewVars() {
    const bgOn = state.settings.bgOn !== false;
    const outline = state.settings.outline !== false;
    const hover = colorSetting('hoverColor');
    const value = parseInt(hover.slice(1), 16);
    const rgb = ((value >> 16) & 255) + ', ' + ((value >> 8) & 255) + ', ' + (value & 255);
    let shadow = 'none';
    if (outline) {
      shadow = bgOn
        ? '0 2px 4px rgba(0, 0, 0, 0.8)'
        : '0 0 2px #000, 0 0 2px #000, 0 0 3px #000, 1px 1px 2px #000';
    }
    return {
      '--p-en': colorSetting('enColor'),
      '--p-tr': colorSetting('trColor'),
      '--p-hover': 'rgba(' + rgb + ', 0.38)',
      '--p-bg': bgOn ? 'rgba(0, 0, 0, ' + opacitySetting() / 100 + ')' : 'transparent',
      '--p-shadow': shadow
    };
  }

  function activePreset() {
    const current = {
      enColor: colorSetting('enColor'),
      trColor: colorSetting('trColor'),
      hoverColor: colorSetting('hoverColor'),
      bgOn: state.settings.bgOn !== false,
      bgOpacity: opacitySetting(),
      outline: state.settings.outline !== false
    };
    for (const name of Object.keys(PRESETS)) {
      const preset = PRESETS[name];
      // Opacity does not matter while the bar is off.
      const same = APPEARANCE_KEYS.every((key) =>
        (key === 'bgOpacity' && !preset.bgOn) || preset[key] === current[key]);
      if (same) {
        return name;
      }
    }
    return '';
  }

  function renderAppearance(disabled, blocked, enabled) {
    const vars = previewVars();
    for (const name of Object.keys(vars)) {
      stylePreview.style.setProperty(name, vars[name]);
    }

    // Do not overwrite a colour picker the user is dragging in right now.
    if (document.activeElement !== enColorInput) {
      enColorInput.value = colorSetting('enColor');
    }
    if (document.activeElement !== trColorInput) {
      trColorInput.value = colorSetting('trColor');
    }
    if (document.activeElement !== hoverColorInput) {
      hoverColorInput.value = colorSetting('hoverColor');
    }

    const bgOn = state.settings.bgOn !== false;
    bgToggle.checked = bgOn;
    outlineToggle.checked = state.settings.outline !== false;
    bgOpacityRange.value = String(opacitySetting());
    bgOpacityValue.textContent = opacitySetting() + '%';
    bgOpacityRow.classList.toggle('is-off', !bgOn);

    const preset = activePreset();
    for (const button of presetGroup.querySelectorAll('[data-preset]')) {
      button.setAttribute('aria-pressed', String(button.dataset.preset === preset));
      button.disabled = disabled;
    }

    for (const input of [enColorInput, trColorInput, hoverColorInput, bgToggle, outlineToggle]) {
      input.disabled = disabled;
    }
    bgOpacityRange.disabled = disabled || !bgOn;
    styleReset.disabled = disabled;

    styleCard.classList.toggle('is-dim', !enabled);
    styleCard.classList.toggle('is-hidden', blocked);
  }

  function renderSettings() {
    const enabled = Boolean(state.settings.enabled);
    const blocked = Boolean(state.blocked);

    // The switches show what is actually in effect. With the master switch off
    // they are off too, even though the saved per-language preference (which is
    // restored when the master comes back on) is still true. The old popup
    // showed EN/TR as "on" while the extension was closed, which is the exact
    // contradiction reported.
    englishToggle.checked = enabled && state.settings.englishOn !== false;
    turkishToggle.checked = enabled && state.settings.turkishOn !== false;

    const size = Math.min(180, Math.max(70, Number(state.settings.fontSize) || 100));
    sizeRange.value = String(size);
    sizeValue.textContent = size + '%';

    for (const button of positionGroup.querySelectorAll('[data-position]')) {
      const active = button.dataset.position === (state.settings.position || 'bottom');
      button.setAttribute('aria-pressed', String(active));
    }

    // Preferences are global and persist even when this page has no video or is
    // not reachable, so they are only disabled when the master switch is off or
    // the page is a browser-internal page.
    const disabled = blocked || !enabled;
    englishToggle.disabled = disabled;
    turkishToggle.disabled = disabled;
    sizeRange.disabled = disabled;
    for (const button of positionGroup.querySelectorAll('[data-position]')) {
      button.disabled = disabled;
    }

    renderAppearance(disabled, blocked, enabled);

    subtitleCard.classList.toggle('is-dim', !enabled);
    subtitleCard.classList.toggle('is-hidden', blocked);

    if (blocked) {
      subtitleHint.classList.add('is-hidden');
    } else if (!enabled) {
      subtitleHint.textContent = 'Altyazı kapalı. Açmak için yukarıdaki ana anahtarı kullanın.';
      subtitleHint.classList.remove('is-hidden');
    } else if (!state.connected) {
      subtitleHint.textContent = 'Bu sekmeye bağlanılamadı. Ayarlar yine de kaydedilir; sayfayı yenileyip “Yeniden dene”ye basın.';
      subtitleHint.classList.remove('is-hidden');
    } else {
      const page = state.page || {};
      const hints = [];

      if (!page.hasVideo) {
        hints.push('Bu sayfada henüz video yok.');
      } else {
        if (state.settings.englishOn !== false && !page.hasEnglishCues && !page.hasTurkishCues) {
          hints.push('Bu videoda İngilizce altyazı kaynağı bulunamadı.');
        }
        if (state.settings.turkishOn !== false && page.hasEnglishCues && !page.hasTurkishCues) {
          hints.push('Türkçe altyazı yok; satır çevirisi henüz hazır değil.');
        }
        if (state.settings.englishOn === false && !page.hasTurkishCues) {
          hints.push('İngilizce satır kapalı ve Türkçe kaynak yok; gösterilecek satır kalmadı.');
        }
      }

      if (hints.length) {
        subtitleHint.textContent = hints.join(' ');
        subtitleHint.classList.remove('is-hidden');
      } else {
        subtitleHint.classList.add('is-hidden');
      }
    }

    siteUrlInput.value = normalizedSiteUrl(state.settings.siteUrl) || DEFAULTS.siteUrl;
    if (siteFileInput) {
      siteFileInput.value = normalizedSiteUrl(state.settings.siteFileUrl) || DEFAULTS.siteFileUrl;
    }
  }

  function renderKey(hasKey) {
    keyStatus.textContent = hasKey ? 'kayıtlı' : 'yok';
    keyStatus.classList.toggle('is-set', Boolean(hasKey));
    clearKeyButton.disabled = !hasKey;
  }

  function renderAll() {
    renderMaster();
    renderSupport();
    renderMessage();
    renderDiagnostics();
    renderSettings();
  }

  /* ---------- page state ---------- */

  // One probe at a time. The popup used to start a new probe from several
  // places (boot, every setting change, the verify timer); an older probe that
  // never got an answer kept `checking` true forever, so the badge stayed on
  // "Kontrol ediliyor…" while the message underneath already said the page was
  // unreachable. That contradictory pair is exactly what the user saw.
  async function refreshPage(options) {
    const opts = options || {};

    if (state.refreshPromise) {
      state.refreshQueued = true;
      return state.refreshPromise;
    }

    // "Checking" is only shown when there is no answer yet, or when the user
    // pressed a button and expects feedback. Background verifies update quietly.
    if (!state.probed || opts.userInitiated) {
      state.checking = true;
    }

    state.injectError = '';
    if (opts.userInitiated) {
      state.connectionError = '';
    }
    renderAll();

    state.refreshPromise = (async () => {
      try {
        await probePage();
      } catch (error) {
        // Every failure path ends here, so the popup always leaves "checking".
        state.connected = false;
        state.page = null;
        state.supported = false;
        state.connectionError = errorText(error) || 'Sayfa durumu okunamadı.';
      } finally {
        state.probed = true;
        state.checking = false;
        state.refreshPromise = null;
        renderAll();

        if (state.refreshQueued) {
          state.refreshQueued = false;
          setTimeout(() => {
            refreshPage().catch(() => {});
          }, 0);
        }
      }
    })();

    return state.refreshPromise;
  }

  async function probePage() {
    await readActiveTab();
    state.blocked = isBlockedPage(state.tabUrl);

    if (state.tabId === null) {
      state.connected = false;
      state.connectionError = 'Etkin sekme bulunamadı.';
      state.page = null;
      state.supported = false;
      return;
    }

    if (state.blocked) {
      state.connected = false;
      state.connectionError = '';
      state.page = null;
      state.supported = false;
      return;
    }

    // A message, an injection and two retries all have their own small limits;
    // this is the ceiling for all of them together. Nothing here may exceed it,
    // so the popup always reaches a final state.
    const attempt = await settle(sendToTab({ type: 'get-state' }), 7000);
    const result = attempt.ok
      ? attempt.value
      : { ok: false, error: attempt.error, timeout: true };

    if (!result || !result.ok) {
      // sendToTab already tried to inject the content script into a tab that
      // predates the extension install. If it still fails, that reason is the
      // only thing that helps the user, so it is kept for the message.
      state.injectError = (result && (result.injectError || result.error)) || '';
      state.connected = false;
      state.page = null;
      state.supported = false;

      const scriptState = await contentScriptState();
      if (scriptState === 'missing') {
        state.connectionError = 'İçerik betiği bu sayfaya yüklenemedi. "Sekmeyi yenile" düğmesini kullanın.';
      } else if (scriptState === 'ready') {
        state.connectionError = 'İçerik betiği yüklü ama yanıt vermiyor. "Sekmeyi yenile" düğmesini kullanın.';
      } else {
        state.connectionError = state.injectError || 'İçerik betiği yanıt vermedi.';
      }

      state.blocked = state.blocked || /cannot access|not allowed/i.test((result && result.error) || '');
      return;
    }

    state.page = result.response;
    state.connected = true;
    state.connectionError = '';

    const platform = platformName(state.tabUrl);
    state.supported = Boolean(
      state.page.hasVideo ||
      state.page.hasEnglishCues ||
      state.page.hasTurkishCues ||
      state.page.activeWords ||
      platform
    );

    // The live page is the source of truth for font size and position, because
    // those have an immediate visual effect on the overlay. It is NOT the source
    // of truth for englishOn/turkishOn: those are saved preferences, and the
    // old code overwrote them with "is a cue visible right now", so a track
    // that had not loaded yet silently turned the switch off.
    if (Number.isFinite(Number(state.page.fontSize))) {
      state.settings.fontSize = Number(state.page.fontSize);
    }
    if (state.page.position) {
      state.settings.position = state.page.position;
    }
    if (typeof state.page.enabled === 'boolean' && state.page.settingsLoaded) {
      state.settings.enabled = state.page.enabled;
    }
  }

  function applyPatch(patch, opts) {
    // The switch and the target state must react immediately; only talking to
    // the page and saving are queued, so a fast second click cannot overtake
    // the first one.
    Object.assign(state.settings, patch);
    renderAll();

    const options = opts || {};
    return enqueue(async () => {
      if (state.supported && !state.blocked && state.tabId !== null) {
        const result = await sendToTab({ type: 'apply-settings', patch: patch });
        if (result.ok && result.response) {
          state.page = result.response;
          renderSupport();
          renderMessage();
        }
      }

      if (options.save !== false) {
        await persistNow();
        scheduleVerify();
      }
    });
  }

  /* ---------- library ---------- */

  async function refreshLibrary() {
    const result = await DS.messaging.send({ type: 'library-count' }, 8000);
    const count = result && Number.isFinite(Number(result.count)) ? Number(result.count) : null;

    if (count === null) {
      libCount.textContent = '—';
      libCount.classList.add('is-empty');
      libraryHint.textContent = 'Kelime sayısı alınamadı: arka plan servisi yanıt vermedi. Eklentiyi opera://extensions sayfasından yenileyin.';
      libraryHint.classList.remove('is-hidden');
      return;
    }

    libCount.textContent = count + ' kelime';
    libCount.classList.toggle('is-empty', count === 0);
    // The default hint already explains the empty state; keep it only when the
    // library really is empty.
    if (count === 0) {
      libraryHint.textContent = 'Kütüphanen henüz boş. Altyazıda bir kelimeye tıkla, paneldeki ☆ ile kaydet; kelimeler burada birikir.';
      libraryHint.classList.remove('is-hidden');
    } else {
      libraryHint.classList.add('is-hidden');
    }
  }

  function noLibraryHint() {
    libCount.textContent = '—';
    libCount.classList.add('is-empty');
    libraryHint.textContent = 'Kelime sayısı alınamadı: arka plan servisi yanıt vermedi.';
    libraryHint.classList.remove('is-hidden');
  }

  /* ---------- open the learning site ---------- */

  // The site is a single built HTML file that also runs from disk. Requiring a
  // local server meant that pressing the button with no server started opened a
  // dead tab, which read as "the button does not work". So the server is probed
  // briefly and the file is used when it is not there.
  function probeServer(url) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(ok);
      };

      let controller = null;
      try {
        controller = new AbortController();
      } catch (error) {
        // Without AbortController the fetch still settles on its own.
      }

      const timer = setTimeout(() => {
        if (controller) {
          try { controller.abort(); } catch (error) { /* ignore */ }
        }
        done(false);
      }, 1200);

      fetch(url, { method: 'GET', cache: 'no-store', signal: controller ? controller.signal : undefined })
        .then((response) => {
          clearTimeout(timer);
          done(Boolean(response && response.ok));
        })
        .catch(() => {
          clearTimeout(timer);
          done(false);
        });
    });
  }

  async function resolveSiteBase() {
    const server = normalizedSiteUrl(state.settings.siteUrl) || DEFAULTS.siteUrl;
    const file = normalizedSiteUrl(state.settings.siteFileUrl) || DEFAULTS.siteFileUrl;

    if (/^https?:/i.test(server) && await probeServer(server)) {
      state.siteMode = 'server';
      return server;
    }

    if (file) {
      state.siteMode = 'file';
      return file;
    }

    state.siteMode = 'server';
    return server;
  }

  async function openLearningSite(hash) {
    const base = await resolveSiteBase();
    const url = siteUrlWithHash(base, hash);

    if (!url) {
      toast('Öğrenme sitesi adresi geçersiz. Gelişmiş ayarlardan düzeltin.', true);
      return;
    }

    try {
      if (state.page && state.page.isSite && state.tabId !== null) {
        await chrome.tabs.update(state.tabId, { url: url, active: true });
      } else {
        await chrome.tabs.create({ url: url });
      }

      if (state.siteMode === 'file') {
        // The file always opens, but the word library only syncs with the
        // extension when Opera is allowed to run extensions on file URLs.
        toast('Site dosyadan açıldı. Kütüphane eşitlemesi için sunucu (npm start) veya dosya erişimi gerekir.');
      }

      window.close();
    } catch (error) {
      toast('Site açılamadı: ' + errorText(error), true);
    }
  }

  /* ---------- diagnostics ---------- */

  async function runDiagnose() {
    diagnoseOut.classList.remove('is-hidden');
    diagnoseOut.textContent = 'İnceleniyor…';

    const result = await sendToTab({ type: 'diagnose' });
    if (!result.ok) {
      diagnoseOut.textContent = 'Bu sekmede içerik betiği yok: ' + (result.error || 'bilinmeyen hata');
      return;
    }

    const report = result.response;
    const lines = [
      'sayfa: ' + report.url,
      'çerçeve: ' + report.frame + (report.frame === 'child' ? '  (oynatıcı başka çerçevede olabilir)' : ''),
      'video sayısı: ' + report.videos,
      'text track sayısı: ' + report.textTracks,
      'yakalanan altyazı dosyası: ' + report.capturedTracks,
      'İngilizce cue: ' + report.englishCues,
      'Türkçe cue: ' + report.turkishCues,
      'reddedilen dosya: ' + (report.refusedTrack || 'yok'),
      'adaptörler: ' + (report.adaptors || []).join(', ')
    ];

    if (report.iframes && report.iframes.length) {
      lines.push('iframe adresleri:');
      for (const src of report.iframes) {
        lines.push('  ' + src);
      }
    }

    lines.push('');
    if (!report.videos) {
      lines.push('SONUÇ: Bu çerçevede video yok. Oynatıcı yukarıdaki iframe');
      lines.push('adreslerinden birinde olabilir; oynatıcıyı başlatıp tekrar incele.');
      lines.push('Ya da altyazı dosyasını videonun üzerine elle sürükle.');
    } else if (report.englishCues || report.turkishCues) {
      lines.push('SONUÇ: Altyazı bulundu, çalışıyor olmalı.');
    } else if (report.capturedTracks) {
      lines.push('SONUÇ: ' + report.capturedTracks + ' altyazı dosyası yakalandı ama hiçbiri');
      lines.push('İngilizce veya Türkçe değil. Kendi .srt dosyanı sürükleyebilirsin.');
    } else {
      lines.push('SONUÇ: Altyazı hiç yakalanmadı. Oynatıcı altyazıyı videoya gömüyor');
      lines.push('olabilir; .srt dosyasını videonun üzerine sürükleyerek kullanabilirsin.');
    }

    diagnoseOut.textContent = lines.join('\n');
  }

  /* ---------- service worker ---------- */

  async function checkServiceWorker() {
    const pong = await DS.messaging.ping();

    if (pong && pong.ok) {
      swStatus.textContent = 'Arka plan servisi çalışıyor (v' + pong.version + ')';
      swStatus.classList.add('is-ok');
      swStatus.classList.remove('is-bad');
      return;
    }

    const detail = DS.messaging.getLastError();
    swStatus.textContent = 'Arka plan servisi yanıt vermiyor' +
      (detail ? ': ' + detail : '.') +
      ' opera://extensions sayfasından eklentiyi yenileyin.';
    swStatus.classList.add('is-bad');
    swStatus.classList.remove('is-ok');
  }

  /* ---------- events ---------- */

  masterToggle.addEventListener('change', () => {
    const value = masterToggle.checked;
    state.settings.enabled = value;
    renderAll();

    enqueue(async () => {
      if (state.supported && !state.blocked && state.tabId !== null) {
        const result = await sendToTab({ type: 'set-enabled', value: value });
        if (result.ok && result.response) {
          state.page = result.response;
          renderSupport();
          renderMessage();
        }
      }

      await persistNow();
      scheduleVerify();
    });
  });

  englishToggle.addEventListener('change', () => {
    applyPatch({ englishOn: englishToggle.checked });
  });

  turkishToggle.addEventListener('change', () => {
    applyPatch({ turkishOn: turkishToggle.checked });
  });

  sizeRange.addEventListener('input', () => {
    const size = Math.min(180, Math.max(70, Number(sizeRange.value) || 100));
    state.settings.fontSize = size;
    sizeValue.textContent = size + '%';
    if (englishToggle.disabled) {
      return;
    }
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      if (state.supported && !state.blocked && state.tabId !== null) {
        sendToTab({ type: 'apply-settings', patch: { fontSize: size } });
      }
    }, 70);
  });

  sizeRange.addEventListener('change', async () => {
    await persistNow();
    scheduleVerify();
  });

  positionGroup.addEventListener('click', (event) => {
    const button = event.target.closest('[data-position]');
    if (!button || button.disabled) {
      return;
    }
    applyPatch({ position: button.dataset.position });
  });

  /* ---------- appearance ---------- */

  // Colour pickers and the opacity slider fire many `input` events while
  // dragging: the preview updates on each one, the page is told at most every
  // 70 ms, and storage is written once on `change` (as for the size slider).
  let styleTimer = 0;

  function liveAppearance(patch) {
    Object.assign(state.settings, patch);
    renderSettings();
    clearTimeout(styleTimer);
    styleTimer = setTimeout(() => {
      if (state.supported && !state.blocked && state.tabId !== null) {
        sendToTab({ type: 'apply-settings', patch: patch });
      }
    }, 70);
  }

  async function commitAppearance() {
    await persistNow();
    scheduleVerify();
  }

  for (const [input, key] of [[enColorInput, 'enColor'], [trColorInput, 'trColor'], [hoverColorInput, 'hoverColor']]) {
    input.addEventListener('input', () => {
      if (HEX_COLOR.test(input.value)) {
        liveAppearance({ [key]: input.value.toLowerCase() });
      }
    });
    input.addEventListener('change', commitAppearance);
  }

  bgOpacityRange.addEventListener('input', () => {
    const value = Math.min(100, Math.max(0, Number(bgOpacityRange.value) || 0));
    liveAppearance({ bgOpacity: value });
  });
  bgOpacityRange.addEventListener('change', commitAppearance);

  bgToggle.addEventListener('change', () => {
    applyPatch({ bgOn: bgToggle.checked });
  });

  outlineToggle.addEventListener('change', () => {
    applyPatch({ outline: outlineToggle.checked });
  });

  presetGroup.addEventListener('click', (event) => {
    const button = event.target.closest('[data-preset]');
    if (!button || button.disabled || !PRESETS[button.dataset.preset]) {
      return;
    }
    applyPatch(Object.assign({}, PRESETS[button.dataset.preset]));
  });

  styleReset.addEventListener('click', () => {
    if (styleReset.disabled) {
      return;
    }
    applyPatch(Object.assign({}, PRESETS.classic));
    toast('Görünüm varsayılana döndü.');
  });

  openSiteButton.addEventListener('click', () => openLearningSite(''));
  openLibraryButton.addEventListener('click', () => openLearningSite('library'));

  helpToggle.addEventListener('click', () => {
    const open = helpToggle.getAttribute('aria-expanded') === 'true';
    helpToggle.setAttribute('aria-expanded', String(!open));
    helpBody.classList.toggle('is-hidden', open);
  });

  diagnoseButton.addEventListener('click', runDiagnose);

  if (retryButton) {
    retryButton.addEventListener('click', () => {
      refreshPage({ userInitiated: true }).catch(() => {});
    });
  }

  if (reloadButton) {
    reloadButton.addEventListener('click', async () => {
      if (state.tabId === null) {
        return;
      }
      try {
        // Reloading does not need the "tabs" permission, and it is the one
        // action that always gives the page a fresh content script.
        await chrome.tabs.reload(state.tabId);
        window.close();
      } catch (error) {
        toast('Sekme yenilenemedi: ' + errorText(error), true);
      }
    });
  }

  saveSiteUrlButton.addEventListener('click', async () => {
    const url = normalizedSiteUrl(siteUrlInput.value);
    if (!url) {
      toast('Geçerli bir adres girin (örn. http://127.0.0.1:5173/).', true);
      return;
    }
    state.settings.siteUrl = url;
    siteUrlInput.value = url;
    await persistNow();
    toast('Site adresi kaydedildi.');
  });

  if (saveSiteFileButton) {
    saveSiteFileButton.addEventListener('click', async () => {
      const url = normalizedSiteUrl(siteFileInput.value);
      if (!url) {
        toast('Geçerli bir dosya adresi girin (file:///…/Ceviri-Kitabi.html).', true);
        return;
      }
      state.settings.siteFileUrl = url;
      siteFileInput.value = url;
      await persistNow();
      toast('Yedek dosya adresi kaydedildi.');
    });
  }

  saveKeyButton.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      toast('Anahtar boş. Silmek için "Anahtarı sil" bağlantısını kullanın.', true);
      return;
    }

    saveKeyButton.disabled = true;
    const result = await DS.messaging.send({ type: 'set-api-key', key: key }, 15000);
    saveKeyButton.disabled = false;

    if (!result) {
      toast('Anahtar kaydedilemedi: ' + (DS.messaging.getLastError() || 'arka plan servisi yanıt vermedi'), true);
      return;
    }

    renderKey(Boolean(result.hasClaudeKey));
    apiKeyInput.value = '';
    toast('Anahtar kaydedildi. Ücretsiz kaynaklar yine öncelikli.');
  });

  clearKeyButton.addEventListener('click', async () => {
    const result = await DS.messaging.send({ type: 'set-api-key', key: '' }, 10000);
    if (!result) {
      toast('Anahtar silinemedi: ' + (DS.messaging.getLastError() || 'yanıt yok'), true);
      return;
    }
    renderKey(false);
    toast('Anahtar silindi.');
  });

  clearCacheButton.addEventListener('click', async () => {
    clearCacheButton.disabled = true;
    const result = await DS.messaging.send({ type: 'clear-cache' }, 15000);
    clearCacheButton.disabled = false;

    if (!result) {
      toast('Önbellek temizlenemedi: ' + (DS.messaging.getLastError() || 'yanıt yok'), true);
      return;
    }

    toast('Önbellek temizlendi: ' + (result.words || 0) + ' kelime, ' + (result.sentences || 0) + ' cümle. Kayıtlı kelimeler korundu.');
  });

  // Settings changed in another tab (or by the site bridge) should be visible
  // here without reopening the popup.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') {
        return;
      }
      const settingKey = DS.constants && DS.constants.STORAGE_SETTINGS;
      const change = settingKey && changes[settingKey];
      if (!change || !change.newValue) {
        return;
      }

      const next = change.newValue;
      for (const key of ['enabled', 'englishOn', 'turkishOn', 'fontSize', 'position'].concat(APPEARANCE_KEYS)) {
        if (Object.prototype.hasOwnProperty.call(next, key)) {
          state.settings[key] = next[key];
        }
      }
      if (next.siteUrl && document.activeElement !== siteUrlInput) {
        state.settings.siteUrl = next.siteUrl;
      }
      if (next.siteFileUrl && (!siteFileInput || document.activeElement !== siteFileInput)) {
        state.settings.siteFileUrl = next.siteFileUrl;
      }
      renderAll();
    });
  } catch (error) {
    // Without the listener the popup still works for this session.
  }

  /* ---------- boot ---------- */

  (async () => {
    await readActiveTab();
    state.blocked = isBlockedPage(state.tabUrl);

    const loaded = await loadStoredSettings();
    if (loaded) {
      applyLoadedSettings(loaded);
      renderKey(Boolean(loaded.hasClaudeKey));
    } else {
      noLibraryHint();
      renderKey(false);
    }

    renderAll();
    await refreshPage();
    await refreshLibrary();
    await checkServiceWorker();
  })();
});
