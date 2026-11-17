// Static checks for the popup and the manifest.
//
// The popup is mostly wiring: every control must reach a real message that the
// service worker answers. A renamed id or a button that was never wired looks
// fine in a screenshot and does nothing in use, so both are checked here.
//
//   node test/ui-check.js

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let failures = 0;

function check(label, ok, detail) {
  if (!ok) {
    failures += 1;
    console.log('FAIL  ' + label);
    if (detail) {
      console.log('      ' + detail);
    }
    return;
  }
  console.log('ok    ' + label);
}

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

const html = read('ui/popup.html');
const js = read('ui/popup.js');
const css = read('ui/popup.css');
const worker = read('background/service-worker.js');
const manifest = JSON.parse(read('manifest.json'));

// ---- ids ----

const htmlIds = Array.from(html.matchAll(/\bid="([^"]+)"/g)).map((m) => m[1]);
const uniqueIds = new Set(htmlIds);
check('popup ids are unique', uniqueIds.size === htmlIds.length,
  htmlIds.length + ' ids, ' + uniqueIds.size + ' unique');

const lookedUp = Array.from(js.matchAll(/\$\('([^']+)'\)/g)).map((m) => m[1]);
const missing = lookedUp.filter((id) => !uniqueIds.has(id));
check('every id read by popup.js exists in the html', missing.length === 0,
  missing.join(', '));

const buttonIds = Array.from(html.matchAll(/<button[^>]*\bid="([^"]+)"/g)).map((m) => m[1]);
const unwired = buttonIds.filter((id) => !lookedUp.includes(id));
check('every id-based button is wired in popup.js', unwired.length === 0,
  unwired.join(', '));

check('position buttons declare their values',
  (html.match(/data-position="(bottom|middle|top)"/g) || []).length === 3);

check('popup has no dead href="#" links', !/href="#"/.test(html));

// ---- message types ----

const tabMessages = ['get-state', 'set-enabled', 'apply-settings', 'diagnose'];
for (const type of tabMessages) {
  check('popup and content script both know "' + type + '"',
    js.includes("'" + type + "'") && read('content/content.js').includes("'" + type + "'"));
}

const workerMessages = [
  { type: 'library-count' },
  { type: 'set-api-key' },
  { type: 'clear-cache' },
  { type: 'get-settings', via: 'getSettings' },
  { type: 'save-settings', via: 'saveSettings' }
];
for (const item of workerMessages) {
  const clientKnows = js.includes("'" + item.type + "'") ||
    Boolean(item.via && js.includes('.' + item.via + '('));
  check('popup and worker both know "' + item.type + '"',
    clientKnows && worker.includes("'" + item.type + "'"));
}

check('popup never posts a placeholder URL', !/example\.com|localhost:3000|your-domain/i.test(js + html));
check('popup default site address matches the dev server',
  js.includes('http://127.0.0.1:5173/'));
check('popup has a file fallback for the learning site',
  js.includes('siteFileUrl') && js.includes('Ceviri-Kitabi.html'));
check('popup probes the server before opening the site',
  js.includes('probeServer') && js.includes('resolveSiteBase'));
check('popup can inject the content script into an existing tab',
  js.includes('chrome.scripting.executeScript') && js.includes('injectContentScript'));
check('popup injects every manifest content script entry, including the MAIN world one',
  js.includes('manifest.content_scripts') && js.includes("entry.world === 'MAIN'"));
check('popup cannot hang on a tab message',
  js.includes('TAB_TIMEOUT') && js.includes('withTimeout'));
check('popup has a retry button for a failed connection',
  html.includes('id="retryButton"') && js.includes("$('retryButton')"));
check('popup persists settings directly instead of through a delayed timer',
  js.includes('persistNow') && js.includes('chrome.storage.local.set') &&
  !js.includes('persistTimer'));
check('popup verifies the page after a change instead of assuming it worked',
  js.includes('scheduleVerify') && js.includes('refreshPage'));
// `shared/constants.js` publishes window.DualSub, not a global DS. The popup
// once used the bare name, which threw on the first read and left the badge on
// "Kontrol ediliyor…" forever with every switch dead.
check('popup aliases the shared namespace instead of relying on a global DS',
  js.includes('globalThis.DualSub'));
check('the site file field is editable', html.includes('id="siteFileInput"') && html.includes('id="saveSiteFile"'));

// ---- scripts ----

const constantsAt = html.indexOf('../shared/constants.js');
const messagingAt = html.indexOf('../shared/messaging.js');
const popupAt = html.indexOf('popup.js');
check('popup loads constants before messaging', constantsAt >= 0 && constantsAt < messagingAt);
check('popup loads messaging before its own script', messagingAt >= 0 && messagingAt < popupAt);

// ---- markup balance (the tags that nest deepest) ----

for (const tag of ['div', 'section', 'details', 'label']) {
  const open = (html.match(new RegExp('<' + tag + '(\\s|>)', 'g')) || []).length;
  const close = (html.match(new RegExp('</' + tag + '>', 'g')) || []).length;
  check('<' + tag + '> tags are balanced', open === close, open + ' open / ' + close + ' close');
}

// ---- css hooks ----

for (const cls of ['badge', 'card', 'switch', 'segmented', 'toast', 'is-hidden']) {
  check('css defines .' + cls, css.includes('.' + cls));
}

// ---- manifest ----

check('manifest uses Manifest V3', manifest.manifest_version === 3);

check('permissions are minimal',
  JSON.stringify(manifest.permissions.slice().sort()) === JSON.stringify(['activeTab', 'scripting', 'storage']),
  JSON.stringify(manifest.permissions));

const broadHost = (manifest.host_permissions || []).filter((pattern) =>
  pattern === '<all_urls>' || pattern === 'http://*/*' || pattern === 'https://*/*' || pattern === '*://*/*');
check('host permissions are narrowed to the APIs actually called',
  broadHost.length === 0, broadHost.join(', '));

const hosts = (manifest.host_permissions || []).join(' ');
for (const host of [
  'translate.googleapis.com',
  'api.mymemory.translated.net',
  'text.pollinations.ai',
  'tatoeba.org',
  'api.dictionaryapi.dev',
  'wiktionary.org',
  'api.anthropic.com'
]) {
  check('host permission covers ' + host, hosts.includes(host));
}

check('no "tabs" permission is requested', !manifest.permissions.includes('tabs'));

const contentJs = manifest.content_scripts[0].js;
for (const file of contentJs) {
  check('content script exists: ' + file, fs.existsSync(path.join(root, file)));
}
check('content scripts load the shared library',
  contentJs.indexOf('shared/library.js') >= 0 &&
  contentJs.indexOf('shared/library.js') < contentJs.indexOf('content/site-bridge.js'));
check('content scripts load the site bridge', contentJs.includes('content/site-bridge.js'));
check('content scripts load messaging before content.js',
  contentJs.indexOf('shared/messaging.js') < contentJs.indexOf('content/content.js'));
check('content scripts run in every frame', manifest.content_scripts[0].all_frames === true);
check('content scripts run in about:blank frames too',
  manifest.content_scripts[0].match_about_blank === true);
check('the MAIN-world capture script runs at document_start',
  manifest.content_scripts[1] && manifest.content_scripts[1].run_at === 'document_start' &&
  manifest.content_scripts[1].world === 'MAIN');

check('popup entry point exists', fs.existsSync(path.join(root, manifest.action.default_popup)));
check('service worker exists', fs.existsSync(path.join(root, manifest.background.service_worker)));

// ---- runtime files referenced by the worker boot list ----

const importBlock = worker.slice(worker.indexOf('importScripts('), worker.indexOf('});', worker.indexOf('importScripts(')));
const imported = Array.from(importBlock.matchAll(/DS_ROOT \+ '([^']+)'/g)).map((m) => m[1]);
check('worker imports at least ten shared modules', imported.length >= 10, String(imported.length));
for (const file of imported) {
  check('worker import exists: ' + file, fs.existsSync(path.join(root, file)));
}
check('worker imports the shared library',
  imported.indexOf('shared/library.js') >= 0 &&
  imported.indexOf('shared/library.js') < imported.indexOf('shared/starred.js'));

console.log('');
if (failures) {
  console.log(failures + ' UI check(s) failed.');
  process.exit(1);
}
console.log('All popup and manifest checks passed.');
