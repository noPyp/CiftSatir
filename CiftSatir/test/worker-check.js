// Exercises the service worker's lookup chain outside the browser.
//
// The browser half of the worker (chrome.* APIs, IndexedDB) is faked, but the
// provider chain, the stem fallback and the cache logic are the real modules
// loaded from disk - so a break in that path shows up here rather than only in
// the extension. Network calls are stubbed so this stays offline and fast.
//
//   node test/worker-check.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
let failures = 0;

function check(label, actual, expected) {
  // Two-argument form asserts truthiness, for cases where the value itself
  // isn't the point.
  if (arguments.length === 2) {
    if (!actual) {
      failures += 1;
      console.log('FAIL  ' + label);
      console.log('      expected: truthy');
      console.log('      actual:   ' + JSON.stringify(actual));
      return;
    }
    console.log('ok    ' + label);
    return;
  }

  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.log('FAIL  ' + label);
    console.log('      expected: ' + JSON.stringify(expected));
    console.log('      actual:   ' + JSON.stringify(actual));
    return;
  }
  console.log('ok    ' + label);
}

// ---- fake fetch: returns a dictionary-shaped payload for known words only ----

const KNOWN = {
  understand: {
    partOfSpeech: 'verb',
    phonetics: [{ text: '/ˌʌndəˈstænd/' }],
    meanings: [{ partOfSpeech: 'verb', definitions: [{ definition: 'to grasp the meaning of' }] }]
  },
  movie: {
    partOfSpeech: 'noun',
    phonetics: [{ text: '/ˈmuːvi/' }],
    meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'a film' }] }]
  },
  run: {
    partOfSpeech: 'verb',
    phonetics: [{ text: '/rʌn/' }],
    meanings: [{ partOfSpeech: 'verb', definitions: [{ definition: 'to move quickly' }] }]
  }
};

const fetchCalls = [];

// api.dictionaryapi.dev deliberately hangs (never settles) to mirror the real
// outage observed on 2026-10-15 - the chain must still produce a result from
// Wiktionary rather than stalling until the panel gives up.
let dictionaryHangs = true;

// Same idea for the free AI endpoint: a public service that can stall for the
// whole 30 s timeout. A stalled attempt used to consume the panel's entire
// budget, so even the sentences Tatoeba had already returned never reached the
// screen.
let aiHangs = false;

const WIKTIONARY = {
  understand: {
    en: [{
      partOfSpeech: 'Verb',
      language: 'English',
      definitions: [{
        definition: 'To <a href="/wiki/know">know</a> the <b>meaning</b> of.'
      }]
    }]
  },
  movie: {
    en: [{
      partOfSpeech: 'Noun',
      language: 'English',
      definitions: [{ definition: 'A recorded sequence of images.' }]
    }]
  },
  run: {
    en: [{
      partOfSpeech: 'Verb',
      language: 'English',
      definitions: [{ definition: 'To move quickly on foot.' }]
    }]
  }
};

function fakeFetch(url, options) {
  fetchCalls.push(url);

  if (url.includes('translate.googleapis.com')) {
    const match = /q=([^&]*)/.exec(url);
    const term = decodeURIComponent(match ? match[1] : '');
    const map = { understand: 'anlamak', movie: 'film', run: 'koşmak', movies: 'filmler' };
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve([[[map[term] || '', term, null]]])
    });
  }

  if (url.includes('text.pollinations.ai')) {
    if (aiHangs) {
      // Never settles: only the sentence builder's own time budget can rescue it.
      return new Promise(() => {});
    }
    const body = JSON.parse((options && options.body) || '{}');
    const prompt = String((body.messages || []).map((m) => m.content).join(' '));
    const wordMatch = /word "([^"]+)"/i.exec(prompt);
    const word = wordMatch ? wordMatch[1] : 'word';
    const sentences = [1, 2, 3, 4, 5].map((n) => ({
      en: 'This is example sentence ' + n + ' with ' + word + ' in it.',
      tr: 'Bu, ' + word + ' kelimesini içeren ' + n + '. örnek cümledir.',
      level: 'A2'
    }));
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: JSON.stringify({ sentences: sentences }) } }]
      })
    });
  }

  if (url.includes('tatoeba.org')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        results: [{
          text: 'I want to understand every word.',
          translations: [[{ lang: 'tur', text: 'Her kelimeyi anlamak istiyorum.' }]]
        }]
      })
    });
  }

  if (url.includes('dictionaryapi.dev')) {
    if (dictionaryHangs) {
      // Never settles: only the provider's own timeout can rescue the chain.
      return new Promise(() => {});
    }
    const word = decodeURIComponent(url.split('/').pop());
    if (KNOWN[word]) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([KNOWN[word]]) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  }

  if (url.includes('wiktionary.org')) {
    const word = decodeURIComponent(url.split('/').pop()).toLowerCase();
    const entry = WIKTIONARY[word];
    if (entry) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(entry) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  }

  if (url.includes('mymemory')) {
    const match = /q=([^&]*)/.exec(url);
    const term = decodeURIComponent(match ? match[1] : '');
    const map = { understand: 'anlamak', movie: 'film', run: 'koşmak', movies: 'filmler' };
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ responseData: { translatedText: map[term] || term } })
    });
  }

  return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
}

// ---- fake IndexedDB-backed chrome.storage ----

const stored = {};

const sandbox = {
  console: console,
  fetch: fakeFetch,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  Promise: Promise,
  Date: Date,
  JSON: JSON,
  Object: Object,
  Array: Array,
  String: String,
  Number: Number,
  Boolean: Boolean,
  Set: Set,
  Map: Map,
  Error: Error,
  chrome: {
    runtime: {
      getURL: (p) => 'file:///ext/' + p,
      onMessage: { addListener: () => {} }
    },
    storage: {
      local: {
        get: (key) => Promise.resolve({ [key]: stored[key] }),
        set: (obj) => {
          Object.assign(stored, obj);
          return Promise.resolve();
        },
        remove: (key) => {
          delete stored[key];
          return Promise.resolve();
        }
      }
    }
  }
};
sandbox.self = sandbox;
vm.createContext(sandbox);

// A minimal in-memory stand-in for the IndexedDB layer in shared/cache.js.
const rows = new Map();

const cacheStub = `
(function (global) {
  'use strict';
  const DS = (global.DualSub = global.DualSub || {});
  const memory = new Map();
  const rows = global.__rows;
  const key = (w) => String(w || '').trim().toLowerCase();
  DS.cache = {
    STORES: { words: 'words', sentences: 'sentences', starred: 'starred' },
    normalizeKey: key,
    get: (store, word) => {
      const k = store + ':' + key(word);
      if (memory.has(k)) return Promise.resolve(memory.get(k));
      const v = rows.has(k) ? rows.get(k) : null;
      memory.set(k, v);
      return Promise.resolve(v);
    },
    put: (store, word, value) => {
      const k = store + ':' + key(word);
      memory.set(k, value);
      rows.set(k, value);
      return Promise.resolve(true);
    },
    remove: (store, word) => {
      const k = store + ':' + key(word);
      memory.delete(k);
      rows.delete(k);
      return Promise.resolve(true);
    },
    all: (store) => Promise.resolve(
      [...rows.entries()]
        .filter(([k]) => k.startsWith(store + ':'))
        .map(([k, value]) => ({ key: k.split(':')[1], value: value }))
    ),
    count: (store) => Promise.resolve([...rows.keys()].filter((k) => k.startsWith(store + ':')).length),
    evictIfNeeded: () => Promise.resolve(0),
    clearMemory: () => memory.clear(),
    LruCache: class { constructor() {} get() {} set() {} delete() {} clear() {} }
  };
})(typeof self !== 'undefined' ? self : this);
`;

sandbox.__rows = rows;
vm.runInContext(cacheStub, sandbox, { filename: 'cache-stub.js' });

for (const file of [
  'shared/constants.js',
  'shared/stemmer.js',
  'shared/starred.js',
  'shared/providers/util.js',
  'shared/providers/free-dictionary.js',
  'shared/providers/wiktionary.js',
  'shared/providers/mymemory.js',
  'shared/providers/google.js',
  'shared/providers/free-ai.js',
  'shared/providers/tatoeba.js',
  'shared/providers/claude.js',
  'shared/sentences.js',
  'shared/providers/index.js'
]) {
  const code = fs.readFileSync(path.join(root, file), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
}

const DS = sandbox.DualSub;

(async () => {
  // ---- the real-world case: dictionary API hanging, Wiktionary carrying it ----

  const started = Date.now();
  const duringOutage = await DS.providerChain.lookup('understand');
  const elapsed = Date.now() - started;

  check('resolves while the dictionary API hangs', duringOutage !== null);
  check('still returns the Turkish meaning', duringOutage && duringOutage.meanings, ['anlamak']);
  check('Wiktionary supplies the part of speech', duringOutage && duringOutage.partOfSpeech, 'fiil');
  check('IPA is empty when only Wiktionary answered', duringOutage && duringOutage.ipa, '');
  check('does not stall on the hanging provider', elapsed < 4000, true);
  console.log('      took ' + elapsed + ' ms with the dictionary API hung');

  // ---- provider chain ----

  const direct = await DS.providerChain.lookup('understand');
  check('chain returns Turkish meaning', direct && direct.meanings, ['anlamak']);
  check('chain returns part of speech in Turkish', direct && direct.partOfSpeech, 'fiil');

  // ---- IPA path: this is what the dictionary API is actually for ----

  dictionaryHangs = false;
  DS.cache.clearMemory();

  const withIpa = await DS.providerChain.lookup('movie');
  check('IPA comes back once the dictionary API responds', withIpa && withIpa.ipa, '/ˈmuːvi/');
  check('dictionary wins the part of speech when it answers', withIpa && withIpa.partOfSpeech, 'isim');

  // ---- Wiktionary strips the HTML its definitions arrive wrapped in ----

  const stripped = DS.providers.wiktionary.stripHtml(
    'To <a href="/wiki/know">know</a> the <b>meaning</b> of &amp; more.'
  );
  check('Wiktionary HTML is stripped', stripped, 'To know the meaning of & more.');

  // ---- stem fallback: the exact path a click on "movies" takes ----

  DS.cache.clearMemory();
  const movies = await DS.providers.freeDictionary.lookup('movies');
  check('dictionary has no entry for the plural', movies, null);

  const stems = DS.stemmer.stemsFor('movies');
  check('"movie" is among the candidates', stems.includes('movie'), true);

  let resolved = null;
  for (const candidate of stems) {
    const hit = await DS.providers.freeDictionary.lookup(candidate);
    if (hit) {
      resolved = { candidate: candidate, hit: hit };
      break;
    }
  }
  check('stem fallback resolves to the right word', resolved && resolved.candidate, 'movie');

  const running = await (async () => {
    for (const candidate of DS.stemmer.stemsFor('running')) {
      const hit = await DS.providers.freeDictionary.lookup(candidate);
      if (hit) {
        return { candidate: candidate, hit: hit };
      }
    }
    return null;
  })();
  check('stem fallback resolves "running" -> run', running && running.candidate, 'run');

  // ---- unknown word degrades instead of throwing ----

  const unknown = await DS.providerChain.lookup('zzzqqqnotaword');
  check('unknown word resolves to null, not a throw', unknown, null);

  // ---- sentences without an API key: five free, translated examples ----

  const free = await DS.providerChain.sentences('understand');
  check('five free sentences without a Claude key', free.length, 5);
  check('every free sentence has a Turkish line',
    free.every((item) => item.en && item.tr), true);
  check('sentences are not repeated', new Set(free.map((item) => item.en)).size, 5);

  const status = await DS.providerChain.status();
  check('status reports no Claude key', status.hasClaudeKey, false);
  check('status reports the free AI path', status.freeAI, true);

  // ---- a stalled AI must not eat the whole request budget ----
  //
  // The panel waits 60 s for word-sentences. Two 30 s attempts never came back in
  // time, so the user saw "örnek cümleler alınamadı" even though Tatoeba had
  // already delivered a real translated sentence. The builder now honours a
  // budget and returns what it has, marked partial.
  aiHangs = true;
  DS.cache.clearMemory();
  const budgetStarted = Date.now();
  const bounded = await DS.providerChain.sentencesWithStatus('understand', '', [], {
    aiTimeoutMs: 150,
    budgetMs: 600
  });
  const budgetElapsed = Date.now() - budgetStarted;
  aiHangs = false;

  check('a stalled AI still returns the sentences that were available',
    bounded.sentences.length >= 1);
  check('the shortfall is reported instead of padded',
    bounded.partial === true && bounded.warning.length > 0);
  check('the answer arrives well inside the panel timeout', budgetElapsed < 3000);
  console.log('      ' + budgetElapsed + ' ms with the AI stalled, ' +
    bounded.sentences.length + ' sentence(s)');

  // ---- circuit breaker ----

  // Three consecutive outages must open the breaker, after which the hanging
  // provider is skipped entirely instead of costing a timeout per word.
  DS.providers.util.resetBreakers();
  dictionaryHangs = true;
  DS.cache.clearMemory();

  for (let i = 0; i < 3; i += 1) {
    await DS.providerChain.lookup('understand');
  }

  check('breaker opens after repeated outages',
    DS.providers.util.isOpen('free-dictionary'), true);

  DS.cache.clearMemory();
  const afterOpenStarted = Date.now();
  const afterOpen = await DS.providerChain.lookup('understand');
  const afterOpenElapsed = Date.now() - afterOpenStarted;

  check('still resolves with the breaker open', afterOpen !== null);
  check('skips the dead provider entirely', afterOpenElapsed < 200, true);
  console.log('      ' + afterOpenElapsed + ' ms with the breaker open (was ~2500 ms)');

  // A working provider must never be tripped by words it has no entry for.
  DS.providers.util.resetBreakers();
  dictionaryHangs = false;
  for (const rare of ['zzzqqqnotaword', 'wwwnotarealword', 'qqxzznotaword']) {
    await DS.providerChain.lookup(rare);
  }
  check('missing entries do not trip the breaker',
    DS.providers.util.isOpen('free-dictionary'), false);

  console.log('');
  console.log('fetch calls made: ' + fetchCalls.length);
  if (failures) {
    console.log(failures + ' check(s) failed.');
    process.exit(1);
  }
  console.log('All worker-chain checks passed.');
})().catch((error) => {
  console.log('THREW: ' + (error && error.stack ? error.stack : error));
  process.exit(1);
});
