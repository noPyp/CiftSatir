// Exercises the extension half of the site <-> extension library bridge.
//
// The bridge is the only path by which a word starred in the subtitle panel can
// appear in the learning site (and the reverse). It is pure message plumbing, so
// it can run outside the browser with a fake chrome.storage and a fake window.
//
// What it must get right:
//   - stay silent on ordinary pages until the site speaks
//   - merge site entries without creating duplicates
//   - remove on unstar and keep a tombstone, so a later snapshot cannot
//     resurrect a word the user deleted
//   - push extension-side changes to an open site
//   - ignore messages that do not come from the site bridge
//
//   node test/bridge-check.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
let failures = 0;

function check(label, actual, expected) {
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

function checkTrue(label, value) {
  if (!value) {
    failures += 1;
    console.log('FAIL  ' + label);
    return;
  }
  console.log('ok    ' + label);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeContext(origin) {
  const storage = {};
  const changeListeners = [];
  const windowListeners = [];
  const posted = [];

  const chrome = {
    storage: {
      local: {
        get(key) {
          if (typeof key === 'string') {
            return Promise.resolve(Object.prototype.hasOwnProperty.call(storage, key)
              ? { [key]: storage[key] }
              : {});
          }
          if (Array.isArray(key)) {
            const out = {};
            for (const k of key) {
              if (Object.prototype.hasOwnProperty.call(storage, k)) {
                out[k] = storage[k];
              }
            }
            return Promise.resolve(out);
          }
          return Promise.resolve(Object.assign({}, storage));
        },
        set(values) {
          const changes = {};
          for (const [k, v] of Object.entries(values || {})) {
            changes[k] = { oldValue: storage[k], newValue: v };
            storage[k] = v;
          }
          for (const listener of changeListeners) {
            listener(changes, 'local');
          }
          return Promise.resolve();
        },
        remove(key) {
          delete storage[key];
          return Promise.resolve();
        }
      },
      onChanged: {
        addListener(fn) {
          changeListeners.push(fn);
        },
        removeListener(fn) {
          const i = changeListeners.indexOf(fn);
          if (i >= 0) {
            changeListeners.splice(i, 1);
          }
        }
      }
    }
  };

  const sandbox = {
    chrome,
    console,
    setTimeout,
    clearTimeout,
    location: { origin },
    addEventListener(type, fn) {
      if (type === 'message') {
        windowListeners.push(fn);
      }
    },
    postMessage(message, targetOrigin) {
      posted.push({ message, targetOrigin });
    }
  };

  sandbox.self = sandbox;
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox);
  const innerGlobal = vm.runInContext('globalThis', context);

  for (const file of [
    'shared/constants.js',
    'shared/stemmer.js',
    'shared/cache.js',
    'shared/library.js',
    'content/site-bridge.js'
  ]) {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }

  function emit(data, extra) {
    for (const listener of windowListeners) {
      listener(Object.assign({
        source: innerGlobal,
        origin: origin === 'null' ? 'null' : origin,
        data: data
      }, extra || {}));
    }
  }

  return {
    DS: sandbox.DualSub,
    storage,
    posted,
    emit,
    sandbox,
    lastSync() {
      const syncs = posted.filter((item) => item.message && item.message.type === 'sync');
      return syncs.length ? syncs[syncs.length - 1].message.library : null;
    }
  };
}

(async () => {
  const ctx = makeContext('http://127.0.0.1:5173/');
  const DS = ctx.DS;

  // ---- handshake ----

  checkTrue('bridge exposes its API', Boolean(DS.siteBridge && DS.siteBridge.sync));
  check('a greeting is posted on load',
    ctx.posted.some((item) => item.message && item.message.type === 'hello'), true);
  check('greeting uses the page origin as target', ctx.posted[0].targetOrigin,
    'http://127.0.0.1:5173/');

  ctx.emit({ source: 'ck-site', type: 'ready' });
  await sleep(20);
  check('ready is answered with an empty library', ctx.lastSync(), []);

  // ---- site -> extension ----

  const siteEntry = {
    word: 'movies',
    lemma: 'movie',
    display: 'movies',
    gloss: 'filmler',
    pos: 'isim',
    ipa: '/ˈmuːviz/',
    senses: [{
      pos: 'isim',
      kisa: 'filmler',
      defTr: 'filmler',
      aiExamples: [{ en: 'We watched two movies last night.', tr: 'Dün gece iki film izledik.' }]
    }],
    context: 'We watched two movies last night.',
    addedAt: 1700000000000
  };

  ctx.emit({ source: 'ck-site', type: 'upsert', entries: [siteEntry] });
  await sleep(30);

  const library = ctx.storage['dualsub:library:v1'] || [];
  check('site entry is stored in the shared library', library.length, 1);
  check('meaning survives the trip', library[0].meanings, ['filmler']);
  check('example survives the trip', library[0].examples[0].tr, 'Dün gece iki film izledik.');
  check('site origin is recorded', library[0].origin, 'site');
  check('sync goes back to the site', ctx.lastSync().length, 1);
  check('sync uses the site sense shape', ctx.lastSync()[0].gloss, 'filmler');

  // Re-starring the same word must not create a second record. An existing
  // entry keeps the data it was saved with; the panel's own star path updates
  // in place, while a site snapshot is a union merge that cannot overwrite.
  ctx.emit({
    source: 'ck-site',
    type: 'upsert',
    entries: [Object.assign({}, siteEntry, { gloss: 'film', senses: [] })]
  });
  await sleep(30);
  check('re-starring does not duplicate', (ctx.storage['dualsub:library:v1'] || []).length, 1);
  check('the existing record is left intact',
    (ctx.storage['dualsub:library:v1'] || [])[0].meanings, ['filmler']);

  // ---- unstar and tombstones ----

  ctx.emit({ source: 'ck-site', type: 'unstar', word: 'movies' });
  await sleep(30);
  check('unstar removes the word', (ctx.storage['dualsub:library:v1'] || []).length, 0);
  check('unstar is tombstoned',
    (ctx.storage['dualsub:removed:v1'] || []).includes('movies'), true);

  // A stale full snapshot must not bring the deleted word back.
  ctx.emit({ source: 'ck-site', type: 'upsert', entries: [siteEntry] });
  await sleep(30);
  check('a tombstone blocks resurrection', (ctx.storage['dualsub:library:v1'] || []).length, 0);

  // ---- extension -> site ----

  await DS.library.save({
    word: 'resilient',
    meanings: ['dayanıklı'],
    partOfSpeech: 'sıfat',
    savedAt: Date.now(),
    origin: 'dualsub'
  });

  await sleep(220);
  const pushed = ctx.lastSync() || [];
  check('extension-side star is pushed to the site', pushed.length, 1);
  check('pushed entry carries the word', pushed[0] && pushed[0].word, 'resilient');
  check('pushed entry carries the meaning', pushed[0] && pushed[0].gloss, 'dayanıklı');

  // ---- safety ----

  const before = JSON.stringify(ctx.storage['dualsub:library:v1'] || []);
  ctx.emit({ source: 'not-the-site', type: 'upsert', entries: [siteEntry] });
  ctx.emit({ source: 'ck-site', type: 'upsert', entries: [siteEntry] }, { source: {} });
  await sleep(30);
  check('foreign-source messages are ignored',
    JSON.stringify(ctx.storage['dualsub:library:v1'] || []), before);

  // ---- file:// support ----

  const fileCtx = makeContext('null');
  check('file:// pages use a wildcard target', fileCtx.DS.siteBridge.targetOrigin(), '*');
  fileCtx.emit({ source: 'ck-site', type: 'ready' }, { origin: 'null' });
  await sleep(20);
  check('file:// handshake still syncs', fileCtx.lastSync(), []);

  console.log('');
  if (failures) {
    console.log(failures + ' bridge check(s) failed.');
    process.exit(1);
  }
  console.log('All site-bridge checks passed.');
})();
