// Standalone check for the SRT/VTT parsers and the word splitter.
//
// The extension runs these in a browser, but both modules are plain
// closure-wrapped scripts with no DOM dependency, so they can be loaded
// straight into Node with a fake global. Run with:
//
//   node test/parser-check.js
//
// Exits non-zero on the first failed expectation.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

// The modules attach themselves to a shared `DualSub` namespace exactly the way
// the content script does, so providing a bare object is enough.
const sandbox = { console: console, self: null };
sandbox.self = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);

for (const file of [
  'shared/constants.js',
  'shared/stemmer.js',
  'shared/sentence-builder.js',
  'shared/parsers.js',
  'shared/cue-model.js'
]) {
  const code = fs.readFileSync(path.join(root, file), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
}

const DS = sandbox.DualSub;
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

// ---- timestamps ----

check('SRT timestamp with comma', DS.parsers.parseTimestamp('00:00:04,200'), 4.2);
check('VTT timestamp with dot', DS.parsers.parseTimestamp('00:00:04.200'), 4.2);
check('short VTT timestamp', DS.parsers.parseTimestamp('01:02.500'), 62.5);
check('hours', DS.parsers.parseTimestamp('01:00:00,000'), 3600);
check('rejects out-of-range minutes', DS.parsers.parseTimestamp('00:99:00,000'), null);
check('rejects garbage', DS.parsers.parseTimestamp('not a time'), null);

// ---- SRT ----

const srt = [
  '﻿1',
  '00:00:00,500 --> 00:00:04,000',
  'Hello, how are you today?',
  '',
  '2',
  '00:00:04,200 --> 00:00:08,500',
  "<i>This line has italic tags</i> that must be stripped.",
  '',
  '3',
  '00:00:08,700 --> 00:00:13,000',
  'Line one of a',
  'multi-line cue.',
  ''
].join('\r\n');

const srtCues = DS.parsers.parseSRT(srt);
check('SRT cue count', srtCues.length, 3);
check('SRT first cue start', srtCues[0].start, 0.5);
check('SRT first cue text', srtCues[0].text, 'Hello, how are you today?');
check('SRT strips tags', srtCues[1].text, 'This line has italic tags that must be stripped.');
check('SRT joins multi-line', srtCues[2].text, 'Line one of a multi-line cue.');

// ---- VTT ----

const vtt = [
  'WEBVTT',
  '',
  'NOTE This note block must be skipped.',
  '',
  'STYLE',
  '::cue { color: white; }',
  '',
  '1',
  '00:00:00.500 --> 00:00:04.000 align:start position:10%',
  'Hello, how are you today?',
  '',
  '2',
  '00:00:04.200 --> 00:00:08.500',
  '<v Speaker>Speaker tags and <00:00:06.000>inline timestamps must go.',
  ''
].join('\n');

const vttCues = DS.parsers.parseVTT(vtt);
check('VTT cue count (NOTE/STYLE skipped)', vttCues.length, 2);
check('VTT ignores cue settings', vttCues[0].end, 4);
check('VTT strips inline timestamps and voice tags', vttCues[1].text,
  'Speaker tags and inline timestamps must go.');

// ---- format detection ----

check('detects VTT by header', DS.parsers.detectFormat(vtt, ''), 'vtt');
check('detects SRT by extension', DS.parsers.detectFormat(srt, 'movie.srt'), 'srt');
check('detects VTT by URL', DS.parsers.detectFormat('1\n00:00:01,000 --> 00:00:02,000\nhi', 'a/b.vtt'), 'vtt');

// ---- cue store ----

const store = new DS.CueStore();
store.set('en', srtCues, { source: 'test' });
check('store has english', store.has('en'), true);
check('store lookup inside cue', store.at('en', 2).text, 'Hello, how are you today?');
check('store lookup in gap returns null', store.at('en', 4.1), null);
check('store lookup past the end', store.at('en', 999), null);

// The binary search must agree with a linear scan at every boundary.
function linearAt(cues, time) {
  return cues.find((cue) => time >= cue.start && time < cue.end) || null;
}

let mismatches = 0;
for (let t = 0; t < 14; t += 0.05) {
  const viaStore = store.at('en', t);
  const viaLinear = linearAt(store.get('en'), t);
  if ((viaStore && viaStore.id) !== (viaLinear && viaLinear.id)) {
    mismatches += 1;
  }
}
check('binary search matches linear scan', mismatches, 0);

// ---- shift ----

store.shift('en', 0.5);
check('shift moves the start', store.get('en')[0].start, 1);
check('shift keeps the text', store.at('en', 2.5).text, 'Hello, how are you today?');

// ---- stemmer ----

check('stems running -> run', DS.stemmer.stem('running'), 'run');
check('stems went unchanged (irregular)', DS.stemmer.stem('went'), 'went');
check('stems studies -> study', DS.stemmer.stem('studies'), 'study');
check('stems making -> make', DS.stemmer.stem('making'), 'make');

// "movies" is the case that made a single-answer stemmer wrong: the repaired
// form is "movy", which isn't a word, so "movie" must be reachable too.
const movieCandidates = DS.stemmer.stemsFor('movies');
check('movies candidates include movie', movieCandidates.includes('movie'), true);
check('movies candidates end with the word itself', movieCandidates[movieCandidates.length - 1], 'movies');

const runCandidates = DS.stemmer.stemsFor('running');
check('running candidates include run', runCandidates.includes('run'), true);

check('normalizes curly apostrophe', DS.stemmer.normalizeForLookup('Don’t'), "don't");
check('strips surrounding punctuation', DS.stemmer.normalizeForLookup('"hello,"'), 'hello');
check('lowercases', DS.stemmer.normalizeForLookup('HELLO'), 'hello');

// A word with no known suffix must come back untouched, not mangled.
check('leaves plain words alone', DS.stemmer.stemsFor('cat'), ['cat']);
check('always ends with the original word', DS.stemmer.stemsFor('quickly').pop(), 'quickly');

// ---- dialogue filter ----
//
// The bug this guards: a player exposed an HLS metadata track as
// kind="metadata", the cue text was a stringified object, and it was painted
// over the film as a subtitle. The exact string from the report is used below.

const renderedJson = '{"metadataType":"discontinuity","tag":"DISCONTINUITY","discontinuitySequence":5,"cueType":"discontinuity","PTS":123456}';
check('rejects the JSON metadata cue from the report', DS.parsers.looksLikeDialogue(renderedJson), false);
check('rejects a JSON array', DS.parsers.looksLikeDialogue('["a","b"]'), false);
check('rejects an HLS tag', DS.parsers.looksLikeDialogue('#EXT-X-DISCONTINUITY'), false);
check('rejects an EMSG payload', DS.parsers.looksLikeDialogue('EMSG id=1 payload=0x1f2e'), false);
check('rejects an ID3 marker', DS.parsers.looksLikeDialogue('ID3 TXXX'), false);
check('rejects a data URL', DS.parsers.looksLikeDialogue('data:text/vtt;base64,AAAA'), false);
check('rejects a key=value dump', DS.parsers.looksLikeDialogue('tag=DISCONTINUITY seq=5 pts=123456 payload=abcdef'), false);
check('rejects an empty string', DS.parsers.looksLikeDialogue(''), false);

check('keeps an ordinary English line', DS.parsers.looksLikeDialogue('Where were you last night?'), true);
check('keeps an ordinary Turkish line', DS.parsers.looksLikeDialogue('Dün gece neredeydin?'), true);
check('keeps a short line', DS.parsers.looksLikeDialogue('Run!'), true);
check('keeps a name-only line', DS.parsers.looksLikeDialogue('John'), true);
check('keeps a line starting with a bracket', DS.parsers.looksLikeDialogue('[sighs] I told you so.'), true);
check('keeps a line with numbers in it', DS.parsers.looksLikeDialogue('I have 3 brothers and 2 sisters.'), true);

const mixedCues = [
  { start: 0, end: 1, text: renderedJson },
  { start: 1, end: 2, text: 'Real dialogue here.' }
];
const filtered = DS.parsers.filterDialogue(mixedCues);
check('filterDialogue drops only the metadata cue', filtered.length, 1);
check('filterDialogue keeps the dialogue text', filtered[0].text, 'Real dialogue here.');
check('filterDialogue tolerates a non-array', DS.parsers.filterDialogue(null), []);

// The parser itself must still accept a normal VTT that happens to contain a
// metadata-looking NOTE block; NOTES are skipped, not emitted as cues.
const vttWithNote = 'WEBVTT\n\nNOTE {"metadataType":"discontinuity"}\n\n00:00:01.000 --> 00:00:02.000\nHello there.\n';
const noteCues = DS.parsers.parseVTT(vttWithNote);
check('NOTE blocks are not cues', noteCues.length, 1);
check('the note block did not hide the real cue', noteCues[0].text, 'Hello there.');

// ---- sentence assembly ----
//
// Auto captions arrive as fragments. These checks are the contract the YouTube
// watcher relies on: fragments grow into one sentence, a sentence ends on
// punctuation, and the previous sentence is never duplicated when the player
// repaints the line.

const builder = DS.sentenceBuilder;

let sentence = builder.append('Hello', 'Hello everyone');
check('a growing caption appends only the new words', sentence, 'Hello everyone');
sentence = builder.append(sentence, 'Hello everyone, welcome to');
check('a longer repaint does not duplicate the start', sentence, 'Hello everyone, welcome to');
check('a comma is not a sentence end', builder.isTerminal(sentence), false);
sentence = builder.append(sentence, 'my channel.');
check('a full stop ends the sentence', builder.isTerminal(sentence), true);
check('the assembled sentence is complete',
  sentence, 'Hello everyone, welcome to my channel.');
check('already-shown words are removable',
  builder.removePrefix('Hello everyone. Welcome back.', 'Hello everyone.'),
  'Welcome back.');
check('removePrefix leaves unrelated text alone',
  builder.removePrefix('Completely different line.', 'Hello everyone.'), 'Completely different line.');

const wordCues = [
  { start: 0, end: 0.3, text: 'Hello' },
  { start: 0.3, end: 0.6, text: 'everyone.' },
  { start: 0.8, end: 1.1, text: 'How' },
  { start: 1.1, end: 1.4, text: 'are' },
  { start: 1.4, end: 1.7, text: 'you?' }
];
const grouped = builder.group(wordCues);
check('word cues are grouped into sentences', grouped.map((cue) => cue.text),
  ['Hello everyone.', 'How are you?']);
check('the grouped cue keeps the sentence start', grouped[1].start, 0.8);
check('the grouped cue keeps the sentence end', grouped[1].end, 1.7);

// ---- YouTube timedtext formats ----

const json3 = JSON.stringify({
  events: [
    { tStartMs: 500, dDurationMs: 300, segs: [{ utf8: 'Where' }] },
    { tStartMs: 800, dDurationMs: 300, segs: [{ utf8: 'were' }] },
    { tStartMs: 1100, dDurationMs: 300, segs: [{ utf8: 'you' }] },
    { tStartMs: 1400, dDurationMs: 600, segs: [{ utf8: 'last' }, { utf8: ' night?' }] }
  ]
});
check('json3 is detected', DS.parsers.detectFormat(json3, ''), 'json3');
const jsonCues = DS.parsers.parse(json3, '');
check('json3 words become one sentence', jsonCues.length, 1);
check('json3 sentence text is joined', jsonCues[0].text, 'Where were you last night?');
check('json3 timing is in seconds', jsonCues[0].start, 0.5);

const srv3 = '<?xml version="1.0" encoding="utf-8" ?><transcript>' +
  '<text start="1.5" dur="2.0">Where were you &amp; last night?</text>' +
  '<text start="4.0" dur="2.0">I was at home.</text>' +
  '</transcript>';
check('srv3 is detected', DS.parsers.detectFormat(srv3, ''), 'srv3');
const xmlCues = DS.parsers.parse(srv3, '');
check('srv3 cues are read', xmlCues.length, 2);
check('srv3 entities are decoded', xmlCues[0].text, 'Where were you & last night?');
check('srv3 start is parsed', xmlCues[0].start, 1.5);

console.log('');
if (failures) {
  console.log(failures + ' check(s) failed.');
  process.exit(1);
}
console.log('All parser checks passed.');