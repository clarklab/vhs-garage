import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wantsQuoteStamp, wantsLeftAlign, clampStampNudge, stampTravel, canNudgeStamp,
  STAMP_NUDGE_MIN, STAMP_NUDGE_MAX, STAMP_NUDGE_STEP,
} from '../../public/scripts/tik/compose.js';
import { fontScaleForQuote } from '../../public/scripts/tik/caption.js';
import { defaultPostFields } from '../../public/scripts/tik/project.js';
import { buildQuotesPrompt } from '../../netlify/functions/lib/autopilot.mjs';
import { quoteHints } from '../../netlify/functions/lib/srt.mjs';
import { quotePlainText } from '../../netlify/functions/lib/imdb.mjs';

test('wantsQuoteStamp only on quotes title slides', () => {
  assert.equal(wantsQuoteStamp({ format: 'quotes', kind: 'title' }), true);
  assert.equal(wantsQuoteStamp({ format: 'quotes', kind: null }), false);
  assert.equal(wantsQuoteStamp({ format: 'quotes', kind: 'outro' }), false);
  assert.equal(wantsQuoteStamp({ format: 'trivia', kind: 'title' }), false);
  assert.equal(wantsQuoteStamp({}), false);
});

test('quotes title is not a trivia title', () => {
  assert.doesNotMatch(defaultPostFields('quotes', 'Jaws').title, /trivia/i);
});

// ---- the two numbered lists in the prompt have to agree ----

test('matcher hints are numbered the same way the quote pool is', () => {
  // The pool is listed "1. …" and the hints were written "0 -> 12-15", several
  // hundred lines apart in one prompt. Nothing in the text tells the model the
  // two lists are offset, so every quote quietly took the PREVIOUS quote's
  // timecode — the exact failure this feature exists to prevent, and invisible
  // unless you sit and compare frames.
  const cues = [
    { start: 10, end: 14, text: 'They mostly come at night. Mostly.' },
    { start: 40, end: 44, text: 'Get away from her, you bitch!' },
    { start: 80, end: 84, text: 'Game over, man. Game over!' },
  ];
  const quotes = [
    { text: 'Newt: They mostly come at night. Mostly.' },
    { text: 'Ripley: Get away from her, you bitch!' },
    { text: 'Hudson: Game over, man. Game over!' },
  ];
  const p = buildQuotesPrompt({
    title: 'Aliens', year: '1986', durationSeconds: 9000,
    quotes, cues, hints: quoteHints(quotes, cues),
  });

  const pool = Object.fromEntries(
    [...p.matchAll(/^(\d+)\.\s+(.+)$/gm)].map(([, n, text]) => [n, text]),
  );
  const hints = [...p.matchAll(/^(\d+) -> ([\d.]+)-([\d.]+)$/gm)];
  assert.equal(hints.length, 3, 'expected one hint per quote');

  for (const [, n, start] of hints) {
    const line = pool[n];
    assert.ok(line, `hint points at pool item ${n}, which is not listed`);
    // The cue that actually holds this quote, found independently.
    const cue = cues.find((c) => line.toLowerCase().includes(c.text.toLowerCase().slice(0, 12)));
    assert.ok(cue, `could not place pool item ${n}`);
    assert.equal(Number(start), cue.start, `hint ${n} points at the wrong line: "${line}"`);
  }
});

test('the prompt admits when the cue list is only a sample', () => {
  // Told to "match against these" over a 1-in-N sample, the model answers
  // confidently off the nearest visible cue.
  const many = Array.from({ length: 1200 }, (_, i) => ({ start: i * 5, end: i * 5 + 3, text: `line ${i}` }));
  const p = buildQuotesPrompt({ title: 'Aliens', durationSeconds: 9000, quotes: [{ text: 'line 7 here' }], cues: many });
  assert.match(p, /as context only/i);
  assert.match(p, /may not be here/i);
  assert.doesNotMatch(p, /English subtitle cues for matching/);

  // A short file is not a sample and keeps the plain instruction.
  const few = many.slice(0, 20);
  const q = buildQuotesPrompt({ title: 'Aliens', durationSeconds: 9000, quotes: [{ text: 'line 7 here' }], cues: few });
  assert.match(q, /English subtitle cues for matching/);
  assert.doesNotMatch(q, /as context only/i);
});

// ---- an exchange keeps its line breaks, all the way to the frame ----

test('quotePlainText puts each character on their own line', () => {
  const out = quotePlainText({ lines: [
    { text: 'Get away from her, you bitch!', characters: [{ character: 'Ripley' }] },
    { text: 'Mommy!', characters: [{ character: 'Newt' }] },
  ] });
  assert.equal(out, 'Ripley: Get away from her, you bitch!\nNewt: Mommy!');
});

test('a single speaker stays a single line with no name', () => {
  const out = quotePlainText({ lines: [{ text: 'I will be back.', characters: [] }] });
  assert.equal(out, 'I will be back.');
  assert.ok(!out.includes('\n'));
});

test('the prompt tells the model to keep the exchange broken up', () => {
  const p = buildQuotesPrompt({ title: 'Aliens', durationSeconds: 9000, quotes: [{ text: 'A: one\nB: two' }] });
  assert.match(p, /KEEP THE EXCHANGE ON SEPARATE LINES/);
  assert.match(p, /each speaker on their own line as "Name: line"/i);
  assert.match(p, /Never join an exchange onto one line/i);
});

test('a multi-line pool item stays readable in the numbered list', () => {
  const p = buildQuotesPrompt({
    title: 'Aliens', durationSeconds: 9000,
    quotes: [{ text: 'Hudson: Game over, man!\nRipley: Deal with it.' }, { text: 'Second one.' }],
  });
  const pool = p.match(/<imdb_quotes>\n([\s\S]*?)\n<\/imdb_quotes>/)[1].split('\n');
  assert.match(pool[0], /^1\. Hudson: Game over, man!$/);
  assert.match(pool[1], /^\s+Ripley: Deal with it\.$/, 'continuation was not indented under its number');
  assert.match(pool[2], /^2\. Second one\.$/);
});

// ---- and reads as dialogue on the slide ----

test('a multi-line quote is flush left, a single line is centred', () => {
  const two = ['Hudson: Game over, man!', 'Ripley: Deal with it.'];
  assert.equal(wantsLeftAlign({ format: 'quotes', kind: null, lines: two }), true);
  assert.equal(wantsLeftAlign({ format: 'quotes', kind: null, lines: ['I will be back.'] }), false);
});

test('the title slide and the sign-off stay centred like every other format', () => {
  const two = ['Hudson: Game over, man!', 'Ripley: Deal with it.'];
  assert.equal(wantsLeftAlign({ format: 'quotes', kind: 'title', lines: two }), false);
  assert.equal(wantsLeftAlign({ format: 'quotes', kind: 'outro', lines: two }), false);
  // Trivia is never left-aligned, however many lines it runs to.
  assert.equal(wantsLeftAlign({ format: 'trivia', kind: null, lines: two }), false);
});

test('wantsLeftAlign shrugs off junk and blank lines', () => {
  assert.equal(wantsLeftAlign(), false);
  assert.equal(wantsLeftAlign({ format: 'quotes', lines: null }), false);
  // A blank paragraph is spacing, not a second speaker.
  assert.equal(wantsLeftAlign({ format: 'quotes', lines: ['one line', '', '   '] }), false);
});


// ---- Nudging the badge off the poster's own title ----

// A 2:3 poster contained on the 1080x1920 slide, and the badge on it.
const POSTER = { frameY: 150, frameH: 1620, canvasH: 1920, half: 190 };
// A 2.39:1 scope frame: a shallow band with a lot of black above and below.
const SCOPE = { frameY: 734, frameH: 452, canvasH: 1920, half: 158 };

const yAt = (n, geo) => stampTravel(n, geo).y;

test('an unnudged badge sits exactly where it always did', () => {
  const base = yAt(0, POSTER);
  assert.equal(yAt(undefined, POSTER), base);
  assert.equal(yAt(null, POSTER), base);
  assert.equal(yAt('junk', POSTER), base);
  // High on the frame — well above its middle.
  assert.ok(base < POSTER.frameY + POSTER.frameH / 2, `badge should sit high: ${base}`);
});

test('a step is a share of the SLIDE, so it moves the same distance on any frame', () => {
  const step = STAMP_NUDGE_STEP * 1920;
  assert.ok(Math.abs(yAt(1, POSTER) - yAt(0, POSTER) - step) < 1e-9);
  assert.ok(Math.abs(yAt(1, SCOPE) - yAt(0, SCOPE) - step) < 1e-9);
  assert.ok(yAt(3, POSTER) > yAt(0, POSTER), 'positive is DOWN the slide');
  assert.ok(yAt(-3, POSTER) < yAt(0, POSTER), 'negative is UP the slide');
});

test('the badge may hang over the bottom of the picture', () => {
  // The whole point: a badge is a sticker, and half off the frame is a real
  // placement. Nothing about the frame stops it.
  const frameBottom = POSTER.frameY + POSTER.frameH;
  const low = yAt(STAMP_NUDGE_MAX, POSTER);
  assert.ok(low + POSTER.half > frameBottom, 'badge overlaps the bottom of the frame');
  // And on a scope band it can be taken right off the picture onto the black.
  const scopeBottom = SCOPE.frameY + SCOPE.frameH;
  assert.ok(yAt(STAMP_NUDGE_MAX, SCOPE) - SCOPE.half > scopeBottom, 'clear of the scope frame entirely');
  assert.ok(yAt(STAMP_NUDGE_MIN, SCOPE) + SCOPE.half < SCOPE.frameY, 'and off the top of it');
});

test('the only stop is the edge of the slide', () => {
  for (const geo of [POSTER, SCOPE]) {
    const bottom = stampTravel(STAMP_NUDGE_MAX, geo);
    const top = stampTravel(STAMP_NUDGE_MIN, geo);
    assert.ok(bottom.y + geo.half <= geo.canvasH + 1e-9, 'never past the bottom of the slide');
    assert.ok(top.y - geo.half >= -1e-9, 'never past the top of the slide');
    assert.equal(bottom.atBottom, true);
    assert.equal(top.atTop, true);
  }
});

test('the arrows die at the slide edge, not at a step count', () => {
  const down = (n) => canNudgeStamp(n, 1, stampTravel(n, SCOPE));
  let n = 0;
  while (down(n) && n < 200) n++;
  assert.ok(stampTravel(n, SCOPE).atBottom, 'stopped because it reached the slide edge');
  assert.ok(stampTravel(n, SCOPE).y > SCOPE.frameY + SCOPE.frameH, 'having gone past the picture');
  assert.equal(canNudgeStamp(n, -1, stampTravel(n, SCOPE)), true, 'the other arrow stays live');
});

test('an ordinary nudge is never clamped', () => {
  for (const n of [-6, -2, 0, 3, 7, 10]) {
    const p = stampTravel(n, POSTER);
    assert.equal(p.atTop, false);
    assert.equal(p.atBottom, false);
    assert.equal(p.y, POSTER.frameY + POSTER.frameH * 0.38 + n * STAMP_NUDGE_STEP * 1920);
  }
});

test('clampStampNudge holds the ends and takes whole steps only', () => {
  assert.equal(clampStampNudge(STAMP_NUDGE_MAX + 50), STAMP_NUDGE_MAX);
  assert.equal(clampStampNudge(STAMP_NUDGE_MIN - 50), STAMP_NUDGE_MIN);
  assert.equal(clampStampNudge(2.4), 2);
  assert.equal(clampStampNudge(undefined), 0);
  assert.equal(clampStampNudge(NaN), 0);
  assert.equal(clampStampNudge('3'), 3);
});

test('the step range reaches both edges of the slide from any frame', () => {
  // If the range ran out first, the arrows would die mid-slide again.
  for (const geo of [POSTER, SCOPE]) {
    assert.equal(stampTravel(STAMP_NUDGE_MAX - 1, geo).atBottom, true, 'bottom edge reachable with a step to spare');
    assert.equal(stampTravel(STAMP_NUDGE_MIN + 1, geo).atTop, true, 'top edge reachable with a step to spare');
  }
});

test('without a placement the arrows stay live', () => {
  // The badge image may not have decoded on the first paint; enabled is the
  // harmless way to be wrong, since the nudge itself is still clamped.
  assert.equal(canNudgeStamp(0, 1), true);
  assert.equal(canNudgeStamp(0, -1, null), true);
  assert.equal(canNudgeStamp(STAMP_NUDGE_MAX, 1), false, 'the step range is still a backstop');
});

test('junk geometry places the badge rather than throwing', () => {
  const p = stampTravel(2, {});
  assert.equal(Number.isFinite(p.y), true);
  assert.equal(p.atTop, false);
  assert.equal(p.atBottom, false);
  // A badge taller than the whole slide has nowhere to be clamped to.
  const huge = stampTravel(0, { ...POSTER, half: 5000 });
  assert.equal(Number.isFinite(huge.y), true);
});
