// Language classification for captured subtitle tracks.
//
// Two failure modes are being guarded against at once, and they pull in
// opposite directions:
//
//   1. A player offers English, Turkish, French, Portuguese and Spanish
//      subtitles for one film. Filing Spanish under English put the wrong
//      language on screen with a Turkish translation under it.
//   2. Requiring firm evidence before accepting a track made ordinary dialogue
//      ("I'm learning English by watching movies" matches no common function
//      word) get rejected, leaving one subtitle line or none.
//
// So the classifier reports how sure it is rather than a yes/no, and only
// "foreign" is a hard refusal.
//
//   node test/lang-check.js

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

// Shorthand: the (lang, confidence) pair is what every case is really about.
function verdict(url, text) {
  const r = sandbox.DualSub.langDetect.classify(url, text);
  return r.lang + '/' + r.confidence;
}

const sandbox = { console: console };
sandbox.self = sandbox;
vm.createContext(sandbox);

for (const file of ['shared/constants.js', 'shared/lang-detect.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}

const L = sandbox.DualSub.langDetect;
void L;

// ---- real file names from hdfilmcehennemi's JW Player track list ----

const REAL = [
  ['.../MoDEXaHfsVY-en-os12656569-abc.vtt', 'en/certain'],
  ['.../MoDEXaHfsVY-tur-abc-subtitles02.tur.vtt', 'tr/certain'],
  ['.../9kNlmdscOnV-tr-6440274-...-kyogo-engtr.vtt', 'en/certain'],
  ['https://hdfilmcehennemi.mobi/vtt/2026/08/x-tur-subtitles01.tur.vtt?token=1', 'tr/certain']
];

for (const [url, expected] of REAL) {
  check('names ' + expected + ': ' + url.split('/').pop().slice(0, 30), verdict(url, ''), expected);
}

// The other languages the same film ships: refused outright, whatever the cues.
const FOREIGN = [
  '.../MoDEXaHfsVY-fr-os12676164-abc.vtt',
  '.../MoDEXaHfsVY-pt-os12676717-abc.vtt',
  '.../MoDEXaHfsVY-es-os12675899-abc.vtt',
  '.../film-spanish.vtt',
  '.../film-french.vtt',
  '.../film-german.vtt'
];

for (const url of FOREIGN) {
  check('refuses foreign name: ' + url.split('/').pop().slice(0, 30),
    verdict(url, ''), 'null/foreign');
}

// ---- the original bug: Spanish cues with no language in the URL ----

const ES = 'Quiero entender cada palabra que dicen. ¿Qué estás haciendo aquí? Tengo que decirte algo.';
const PT = 'Quero entender cada palavra que dizem. Você está fazendo aqui? Tenho que te dizer algo.';
const FR = "Je veux comprendre chaque mot qu'ils disent. Qu'est-ce que tu fais ici ? Je dois te dire quelque chose.";
const DE = 'Ich will jedes Wort verstehen, das sie sagen. Was machst du hier? Ich muss dir etwas sagen.';

check('Spanish cues, no URL hint -> foreign', verdict('', ES), 'null/foreign');
check('Portuguese cues, no URL hint -> foreign', verdict('', PT), 'null/foreign');
check('French cues, no URL hint -> foreign', verdict('', FR), 'null/foreign');
check('German cues, no URL hint -> foreign', verdict('', DE), 'null/foreign');
check('foreign letters alone are proof', verdict('', '¿Qué?'), 'null/foreign');

// ---- the regression that broke everything: ordinary dialogue must be usable ----
//
// These are the shapes that a stricter version of this file rejected, leaving
// the user with one line or none. None of them contains a word from the common
// function-word lists, so all three come back "unknown" - which the caller
// accepts rather than refuses, because no subtitles is the worse outcome.

const ORDINARY = [
  ['', 'I want to understand movies.'],
  ['', 'Hello, how are you?'],
  ['', 'Thank you.'],
  ['', 'Learning English.']
];

for (const [url, text] of ORDINARY) {
  const v = verdict(url, text);
  check('ordinary dialogue is not refused: ' + JSON.stringify(text),
    v.endsWith('/foreign'), false);
}

// ---- identified by the words when the URL says nothing ----

const EN = 'I want to understand every word they say. What are you doing here? I have to tell you something.';
const TR = 'Söyledikleri her kelimeyi anlamak istiyorum. Burada ne yapıyorsun? Sana bir şey söylemem lazım.';

check('English cues, no URL hint -> en', verdict('', EN), 'en/likely');
check('Turkish cues, no URL hint -> tr', verdict('', TR), 'tr/likely');
check('English name + English cues -> en', verdict('.../film-en-1.vtt', EN), 'en/certain');
check('Turkish name + Turkish cues -> tr', verdict('.../film-tur-2.vtt', TR), 'tr/certain');

// ---- Turkish orthography ----
// "İ".toLowerCase() in a non-Turkish locale yields "i" + combining dot above,
// which would split the token and defeat the word matching.

check('Turkish İ does not break tokenisation',
  L.words('İyi akşamlar, nasılsın?').includes('iyi'), true);
check('short Turkish cue with distinct letters -> tr',
  verdict('', 'İyi geceler.'), 'tr/certain');
check('Turkish ç/ş/ğ are conclusive',
  verdict('', 'Güle güle, görüşürüz.'), 'tr/certain');

// ---- false-positive guard ----
//
// Short codes ("no", "id", "br", "da") appear constantly in ordinary URL text.
// A false positive throws away a good English track, so only the file name is
// read, never a path segment.

check('a language-looking directory is not read as a language',
  verdict('https://x.com/tr/movies/film.vtt', ''), 'null/unknown');
check('a "-no-" directory does not block a real English track',
  verdict('https://x.com/no/movies/film-en.vtt', ''), 'en/certain');

// ---- channel-level Turkish detection ----
//
// The visible bug this guards against: a site ships one Turkish file (or a
// track with no language metadata), the cues landed in the English channel and
// the translator translated Turkish into Turkish. Two near-identical lines
// appeared, the lower one machine-mangled. The decision is made for the whole
// channel, and it must be one-sided: "looks Turkish" is not "not clearly
// English".

check('a Turkish channel is recognised', L.looksTurkish([TR]), true);
check('a short Turkish line is recognised',
  L.looksTurkish(['Evet, tamam.']), true);
check('a Turkish line with Turkish-only letters is recognised',
  L.looksTurkish(['Merhaba, bugün nasılsın?']), true);
check('an English channel is not Turkish',
  L.looksTurkish([EN]), false);
check('ordinary English dialogue is not Turkish',
  L.looksTurkish(['Hello, how are you today?', 'Where were you last night?']), false);
check('short English replies are not Turkish',
  L.looksTurkish(['Okay, sure.', 'I know, right?']), false);
check('one English line inside a Turkish file does not flip the channel',
  L.looksTurkish(['Evet, tamam.', 'Bir şey yok.', 'Okay, sure.']), true);
check('a mixed channel with Turkish majority still wins',
  L.looksTurkish(['Dün gece neredeydin?', 'Sana bir şey söylemem lazım.', 'Okay.']), true);
check('a foreign (Spanish) channel is not claimed as Turkish',
  L.looksTurkish([ES]), false);
check('a single stray Turkish word cannot claim an English channel',
  L.looksTurkish(['I bought a simit in Istanbul yesterday.', 'Where were you last night?']), false);

// ---- empty input ----

check('empty sample and empty url -> unknown', verdict('', ''), 'null/unknown');
check('a blob url with no cues -> unknown', verdict('blob:https://x/abc-123', ''), 'null/unknown');

console.log('');
if (failures) {
  console.log(failures + ' check(s) failed.');
  process.exit(1);
}
console.log('All language-detection checks passed.');
