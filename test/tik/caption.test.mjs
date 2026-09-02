import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wrapLines, fitFontSize, fontScaleForQuote, wordProgress, spokenIndex, cueProgress, wordWeights,
} from '../../public/scripts/tik/caption.js';
import { captionStyleOf, CAPTION_STYLES } from '../../public/scripts/tik/compose.js';

// Fake measurer: every character is 10px wide.
const measure10 = (s) => s.length * 10;

test('wrapLines greedily fills lines up to maxWidth', () => {
  // maxWidth 100 → 10 chars per line
  const lines = wrapLines('hello world foo', 100, measure10);
  assert.deepEqual(lines, ['hello', 'world foo']);
});

test('wrapLines keeps a single over-long word on its own line', () => {
  const lines = wrapLines('supercalifragilistic hi', 100, measure10);
  assert.deepEqual(lines, ['supercalifragilistic', 'hi']);
});

test('wrapLines preserves explicit newlines', () => {
  const lines = wrapLines('a\nb c', 100, measure10);
  assert.deepEqual(lines, ['a', 'b c']);
});

test('wrapLines on empty/whitespace returns a single empty line', () => {
  assert.deepEqual(wrapLines('   ', 100, measure10), ['']);
});

test('fitFontSize shrinks so all lines fit the band height', () => {
  // 4 lines, band 400px, lineHeightFactor 1.25 → 400/(4*1.25)=80, capped at maxFont
  assert.equal(fitFontSize(4, 400, { lineHeightFactor: 1.25, maxFont: 100 }), 80);
  // capped by maxFont when there's plenty of room
  assert.equal(fitFontSize(1, 4000, { lineHeightFactor: 1.25, maxFont: 100 }), 100);
  // never below minFont
  assert.equal(fitFontSize(50, 100, { lineHeightFactor: 1.25, maxFont: 100, minFont: 24 }), 24);
});

test('fontScaleForQuote grows short lines and shrinks long ones', () => {
  assert.equal(fontScaleForQuote("I'll be back."), 1.35);
  assert.equal(fontScaleForQuote('Come with me if you want to live.'), 1.35);
  assert.equal(fontScaleForQuote('x'.repeat(50)), 1.15);
  assert.equal(fontScaleForQuote('x'.repeat(100)), 1.0);
  assert.equal(fontScaleForQuote('x'.repeat(200)), 0.85);
  assert.equal(fontScaleForQuote(''), 1);
  assert.equal(fontScaleForQuote(null), 1);
});


// ---- Karaoke: which word is being said ----

test('words are spread across the line by length, not by count', () => {
  // "Inconceivable" takes longer to say than "a", and a highlight that moves in
  // equal steps reads as obviously mechanical.
  const spans = wordProgress(['a', 'inconceivable']);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].from, 0);
  assert.equal(spans[1].to, 1);
  const short = spans[0].to - spans[0].from;
  const long = spans[1].to - spans[1].from;
  assert.ok(long > short * 2, `the long word should hold the screen longer: ${short} vs ${long}`);
});

test('every word gets some time, however short', () => {
  // Pure character weighting would give "I" almost nothing; the per-word
  // overhead is the gap between words, which costs time regardless.
  const spans = wordProgress(['I', 'am', 'the', 'Dread', 'Pirate', 'Roberts']);
  for (const s of spans) assert.ok(s.to > s.from, `"${s.word}" got no time at all`);
  const weights = wordWeights(['I', 'Roberts']);
  assert.ok(weights[0] > 1, 'a one-letter word still weighs something');
});

test('the spans tile the line with no gaps and no overlaps', () => {
  const spans = wordProgress(['As', 'you', 'wish']);
  assert.equal(spans[0].from, 0);
  for (let i = 1; i < spans.length; i++) {
    assert.equal(spans[i].from, spans[i - 1].to, 'each word starts where the last ended');
  }
  assert.equal(spans.at(-1).to, 1);
});

test('the highlight walks the line in order', () => {
  const spans = wordProgress(['As', 'you', 'wish']);
  const seen = [0, 0.2, 0.5, 0.8, 1].map((p) => spokenIndex(spans, p));
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], 'never goes backwards');
  assert.equal(spokenIndex(spans, 0.001), 0, 'the first word lights as soon as the line starts');
  assert.equal(spokenIndex(spans, 1), spans.length - 1, 'and the last one stays lit at the end');
});

test('before the line starts, nothing is lit', () => {
  const spans = wordProgress(['As', 'you', 'wish']);
  assert.equal(spokenIndex(spans, 0), -1);
  assert.equal(spokenIndex(spans, -1), -1);
  assert.equal(spokenIndex(spans, NaN), -1);
  assert.equal(spokenIndex([], 0.5), -1);
  assert.equal(spokenIndex(null, 0.5), -1);
});

test('junk words do not break the timing', () => {
  assert.deepEqual(wordProgress([]), []);
  assert.deepEqual(wordProgress(null), []);
  const spans = wordProgress(['', '  ']);
  assert.equal(spans.length, 2, 'blank words still occupy their slot');
  assert.equal(spans.at(-1).to, 1);
});

// ---- Where a moment sits inside a cue ----

test('cueProgress maps the playhead onto the line', () => {
  const cue = { start: 600, end: 604 };
  assert.equal(cueProgress(600, cue), 0);
  assert.equal(cueProgress(602, cue), 0.5);
  assert.equal(cueProgress(604, cue), 1);
});

test('cueProgress clamps rather than running past the line', () => {
  // The scene has padding either side; the line does not.
  const cue = { start: 600, end: 604 };
  assert.equal(cueProgress(598.8, cue), 0, 'the run-up before the line');
  assert.equal(cueProgress(605.6, cue), 1, 'and the beat after it');
});

test('an unmatched line has no honest timing', () => {
  // No cue means the timecode was the model's guess; lighting words off a guess
  // would be a synced-looking lie.
  assert.equal(cueProgress(600, null), null);
  assert.equal(cueProgress(600, { start: 600 }), null);
  assert.equal(cueProgress(600, { start: 604, end: 600 }), null, 'a backwards cue is not a cue');
  assert.equal(cueProgress(undefined, { start: 600, end: 604 }), null);
});

// ---- The looks ----

test('the caption styles are the three the UI offers', () => {
  assert.deepEqual(CAPTION_STYLES, ['pills', 'cc', 'karaoke']);
});

test('anything unknown falls back to the house pills', () => {
  // A project saved before this existed has no style at all, and must keep
  // looking exactly like it did.
  assert.equal(captionStyleOf(undefined), 'pills');
  assert.equal(captionStyleOf(null), 'pills');
  assert.equal(captionStyleOf('fancy'), 'pills');
  assert.equal(captionStyleOf('karaoke'), 'karaoke');
  assert.equal(captionStyleOf('cc'), 'cc');
});
