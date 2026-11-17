// Checks the pure logic behind translating an English-only video.
//
//   node test/cue-translate-check.js

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

const sandbox = {
  setTimeout,
  clearTimeout
};
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'shared/cue-translate.js'), 'utf8'), sandbox, {
  filename: 'shared/cue-translate.js'
});

const CT = sandbox.DualSub.cueTranslate;

const cues = [
  { start: 0, end: 2, text: 'Hello there.' },
  { start: 2, end: 4, text: 'How are you?' },
  { start: 4, end: 6, text: 'I am fine.' },
  { start: 6, end: 8, text: 'See you soon.' }
];

// ---- pick ----

check('current and next lines are picked',
  CT.pick(cues, 2.2, new Map(), 3),
  ['How are you?', 'I am fine.', 'See you soon.']);

check('the look-ahead window is respected',
  CT.pick(cues, 0, new Map(), 3),
  ['Hello there.', 'How are you?', 'I am fine.']);

check('past lines are not requested',
  CT.pick(cues, 5, new Map(), 3),
  ['I am fine.', 'See you soon.']);

check('lines far in the future are not requested',
  CT.pick([{ start: 100, end: 102, text: 'Much later.' }], 0, new Map(), 3),
  []);

check('already translated lines are skipped',
  CT.pick(cues, 2.2, new Map([['How are you?', 'Nasılsın?']]), 3),
  ['I am fine.', 'See you soon.']);

check('limit is honoured',
  CT.pick(cues, 0, new Map(), 1),
  ['Hello there.']);

check('empty lines are skipped',
  CT.pick([{ start: 0, end: 1, text: '   ' }, { start: 1, end: 2, text: 'Next.' }], 0, new Map(), 3),
  ['Next.']);

check('paragraph-sized lines are skipped',
  CT.pick([{ start: 0, end: 30, text: 'x'.repeat(CT.MAX_TEXT_LENGTH + 1) },
    { start: 1, end: 3, text: 'Short.' }], 0, new Map(), 3),
  ['Short.']);

check('plain-object translations work too',
  CT.pick(cues, 0, { 'Hello there.': 'Merhaba.' }, 3),
  ['How are you?', 'I am fine.', 'See you soon.']);

// ---- build ----

const translated = new Map([
  ['Hello there.', 'Merhaba.'],
  ['I am fine.', 'İyiyim.']
]);

const built = CT.build(cues, translated);
check('only translated lines appear', built.length, 2);
check('timings are copied from the English cue',
  built.map((cue) => [cue.start, cue.end]),
  [[0, 2], [4, 6]]);
check('translated text is used',
  built.map((cue) => cue.text),
  ['Merhaba.', 'İyiyim.']);

check('build trims stray whitespace',
  CT.build([{ start: 0, end: 1, text: 'Hi.' }], new Map([['Hi.', '  Selam.  ']]))[0].text,
  'Selam.');

check('untranslated input yields an empty channel',
  CT.build(cues, new Map()), []);

console.log('');
if (failures) {
  console.log(failures + ' cue-translate check(s) failed.');
  process.exit(1);
}
console.log('All cue-translate checks passed.');
