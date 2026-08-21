import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSrt, srtTimeToSeconds, normalizeQuoteText, matchQuoteToCues, quoteHints, seekTime, applyCueTimes,
} from '../../netlify/functions/lib/srt.mjs';

const SAMPLE = `1
00:01:12,000 --> 00:01:16,000
I'll be back.

2
00:01:16,500 --> 00:01:19,000
Come with me if you want to live.

3
00:02:00,000 --> 00:02:02,000
Sarah Connor?

4
00:02:02,200 --> 00:02:05,000
No, it's just me.
`;

test('srtTimeToSeconds parses the SRT clock', () => {
  assert.equal(srtTimeToSeconds('00:01:12,000'), 72);
  assert.equal(srtTimeToSeconds('01:00:00,500'), 3600.5);
  assert.equal(srtTimeToSeconds('nope'), null);
});

test('parseSrt returns cues in seconds', () => {
  const cues = parseSrt(SAMPLE);
  assert.equal(cues.length, 4);
  assert.equal(cues[0].start, 72);
  assert.equal(cues[0].end, 76);
  assert.equal(cues[0].text, "I'll be back.");
});

test('parseSrt returns [] for empty or junk', () => {
  assert.deepEqual(parseSrt(''), []);
  assert.deepEqual(parseSrt(null), []);
  assert.deepEqual(parseSrt('not an srt'), []);
});

test('normalizeQuoteText strips speakers, quotes, and punctuation', () => {
  assert.equal(normalizeQuoteText(`[Terminator]: I'll be back.`), 'ill be back');
  assert.equal(normalizeQuoteText(`The Terminator: "I'll be back."`), 'ill be back');
  assert.equal(normalizeQuoteText("I'll be back."), 'ill be back');
  assert.equal(normalizeQuoteText('  '), '');
});

test('matchQuoteToCues finds a line ignoring IMDb formatting', () => {
  const cues = parseSrt(SAMPLE);
  const hit = matchQuoteToCues("The Terminator: I'll be back.", cues);
  assert.ok(hit);
  assert.equal(hit.start, 72);
  assert.equal(hit.end, 76);
  assert.equal(seekTime(hit.start, hit.end), 73);
});

test('matchQuoteToCues spans two adjacent cues when the quote covers both', () => {
  const cues = parseSrt(SAMPLE);
  const hit = matchQuoteToCues('Sarah Connor? No, it\'s just me.', cues);
  assert.ok(hit);
  assert.equal(hit.start, 120);
  assert.equal(hit.end, 125);
});

test('matchQuoteToCues returns null when nothing is close', () => {
  const cues = parseSrt(SAMPLE);
  assert.equal(matchQuoteToCues('Get to the chopper', cues), null);
});

test('quoteHints maps matched quotes to cue spans', () => {
  const cues = parseSrt(SAMPLE);
  const out = quoteHints([{ text: "The Terminator: I'll be back." }], cues);
  assert.deepEqual(out, [{ quoteIndex: 0, start: 72, end: 76 }]);
});

// ---- where inside a cue span the frame is grabbed ----

test('seekTime is the first quarter of the cue span', () => {
  assert.equal(seekTime(12, 16), 13);
  assert.equal(seekTime(10, 10), 10);
  assert.equal(seekTime(0, 4), 1);
  assert.ok(Math.abs(seekTime(1.2, 5.2) - 2.2) < 1e-9);
});

test('seekTime spans several cues via first start and last end', () => {
  assert.equal(seekTime(8, 20), 11);
});

test('seekTime survives junk', () => {
  assert.equal(seekTime(null, 10), 0);
  assert.equal(seekTime(5, 'nope'), 5);
  assert.equal(seekTime(-2, 2), 0);
});

// ---- the arithmetic is the authority, not the model ----

const SPANS = [
  { start: 10, end: 14, text: 'They mostly come at night. Mostly.' },
  { start: 40, end: 44, text: 'Get away from her, you bitch!' },
  { start: 80, end: 84, text: 'Game over, man. Game over!' },
];

test('applyCueTimes overrides whatever the model said about a span', () => {
  // The model is handed a SAMPLE of a long cue list, so a confident answer off
  // the nearest visible line is its normal failure. The full file decides.
  const out = applyCueTimes([
    { caption: 'Game over, man. Game over!', timecode: 999, start: 900, end: 904 },
  ], SPANS);
  assert.equal(out[0].start, 80);
  assert.equal(out[0].end, 84);
  assert.equal(out[0].timecode, 81);   // first quarter of 80–84
  assert.equal(out[0].matched, true);
});

test('applyCueTimes matches a caption boiled down from the full quote', () => {
  // What lands on a slide is a trimmed version of the IMDb block, which is a
  // SUBSET of the words that were matched in the first place.
  const out = applyCueTimes([{ caption: 'Get away from her, you bitch!', timecode: 0 }], SPANS);
  assert.equal(out[0].timecode, 41);
});

test('applyCueTimes leaves the title slide on its title card', () => {
  // Slide 0 points at the main-title logo shot, which is not a spoken line.
  const rows = [
    { caption: 'Aliens (1986)', timecode: 120 },
    { caption: 'Game over, man. Game over!', timecode: 5 },
  ];
  const out = applyCueTimes(rows, SPANS, { skipFirst: true });
  assert.equal(out[0].timecode, 120, 'the title slide was dragged to a quote');
  assert.equal(out[1].timecode, 81);
});

test('applyCueTimes keeps the model guess when nothing matches', () => {
  const out = applyCueTimes([{ caption: 'A line that is not in this film at all', timecode: 640 }], SPANS);
  assert.equal(out[0].timecode, 640);
  assert.equal(out[0].matched, undefined);
  assert.equal(out[0].start, undefined);
});

test('applyCueTimes is a no-op with no subtitle file', () => {
  // Every film without an English SRT takes this path; it must not blank the
  // timecodes the model guessed.
  const rows = [{ caption: 'Game over, man.', timecode: 77 }];
  assert.deepEqual(applyCueTimes(rows, []), rows);
  assert.deepEqual(applyCueTimes(rows, null), rows);
  assert.deepEqual(applyCueTimes([], SPANS), []);
});

test('applyCueTimes clamps a match to the runtime it was given', () => {
  const out = applyCueTimes([{ caption: 'Game over, man. Game over!', timecode: 0 }], SPANS, { durationSeconds: 50 });
  assert.ok(out[0].timecode <= 50, `ran past the end of the film: ${out[0].timecode}`);
});
