// Verifies that the service worker's importScripts() list actually boots.
//
// Every file in the real list is loaded into one shared context in the real
// order, using the real shared/ modules. Several of them destructure from the
// namespace at load time (starred.js reads DS.cache.STORES, the providers read
// DS.providers.util), so a wrong order throws during evaluation - and a service
// worker that throws on load never answers a message at all. That failure looks
// exactly like "the dictionary has no entry for this word", which is why it is
// worth catching here rather than in the browser.
//
//   node test/load-order-check.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

// The manifest declares this file; the list inside it is the thing under test.
const workerSource = fs.readFileSync(path.join(root, 'background/service-worker.js'), 'utf8');

// Strip comments first: the explanatory comment above the call mentions
// importScripts() by name, and matching that would test the prose instead of
// the code.
const codeOnly = workerSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const callIndex = codeOnly.indexOf('importScripts(');
check('service worker calls importScripts()', callIndex !== -1);

const listMatch = callIndex === -1
  ? null
  : /^importScripts\(([\s\S]*?)\);/m.exec(codeOnly.slice(callIndex));

check('the call has a file list', Boolean(listMatch));

const listed = listMatch
  ? [...listMatch[1].matchAll(/'([^']+\.js)'/g)].map((m) => m[1])
  : [];

check('importScripts() lists files', listed.length > 0, 'found ' + listed.length);
console.log('      ' + listed.length + ' files: ' + listed.join(', '));

// The paths are built with chrome.runtime.getURL(''), so strip that prefix and
// confirm each target really exists on disk. A typo here is another way the
// worker silently fails to start.
for (const rel of listed) {
  const exists = fs.existsSync(path.join(root, rel));
  check('file exists: ' + rel, exists);
}

// ---- boot every listed file in one context, in order ----

const sandbox = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  Date: Date,
  JSON: JSON,
  Math: Math,
  Promise: Promise,
  Object: Object,
  Array: Array,
  String: String,
  Number: Number,
  Boolean: Boolean,
  RegExp: RegExp,
  Set: Set,
  Map: Map,
  WeakMap: WeakMap,
  Error: Error,
  TypeError: TypeError,
  AbortController: AbortController,
  // Left undefined on purpose: nothing may touch IndexedDB at load time.
  fetch: () => Promise.reject(new Error('no network in this test')),
  chrome: {
    runtime: {
      getURL: (p) => 'chrome-extension://test/' + p,
      getManifest: () => ({ version: '1.0.1' }),
      onMessage: { addListener: () => {} }
    },
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve()
      }
    }
  }
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let loadError = null;
for (const rel of listed) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    continue;
  }

  try {
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: rel });
  } catch (error) {
    loadError = rel + ': ' + (error && error.message ? error.message : String(error));
    break;
  }
}

check('every listed file evaluates without throwing', loadError === null, loadError || '');

// ---- the namespace the worker then relies on ----

const DS = sandbox.DualSub || {};

const required = [
  ['DS.constants', DS.constants],
  ['DS.stemmer.stemsFor', DS.stemmer && DS.stemmer.stemsFor],
  ['DS.cache.STORES', DS.cache && DS.cache.STORES],
  ['DS.cache.get', DS.cache && DS.cache.get],
  ['DS.starred.isStarred', DS.starred && DS.starred.isStarred],
  ['DS.providers.util.withTimeout', DS.providers && DS.providers.util && DS.providers.util.withTimeout],
  ['DS.providers.freeDictionary.lookup', DS.providers && DS.providers.freeDictionary && DS.providers.freeDictionary.lookup],
  ['DS.providers.wiktionary.lookup', DS.providers && DS.providers.wiktionary && DS.providers.wiktionary.lookup],
  ['DS.providers.mymemory.lookup', DS.providers && DS.providers.mymemory && DS.providers.mymemory.lookup],
  ['DS.providers.google.translate', DS.providers && DS.providers.google && DS.providers.google.translate],
  ['DS.providers.freeAI.json', DS.providers && DS.providers.freeAI && DS.providers.freeAI.json],
  ['DS.providers.tatoeba.examples', DS.providers && DS.providers.tatoeba && DS.providers.tatoeba.examples],
  ['DS.sentences.build', DS.sentences && DS.sentences.build],
  ['DS.library.save', DS.library && DS.library.save],
  ['DS.providers.claude.lookup', DS.providers && DS.providers.claude && DS.providers.claude.lookup],
  ['DS.providerChain.lookup', DS.providerChain && DS.providerChain.lookup],
  ['DS.providerChain.refine', DS.providerChain && DS.providerChain.refine]
];

for (const [name, value] of required) {
  check('exposes ' + name, typeof value !== 'undefined' && value !== null);
}

// No file may have referenced indexedDB while loading, since the worker's
// storage is opened lazily on first use.
check('load touched no indexedDB', typeof sandbox.indexedDB === 'undefined');

console.log('');
if (failures) {
  console.log(failures + ' check(s) failed.');
  process.exit(1);
}
console.log('Service worker would boot cleanly.');
