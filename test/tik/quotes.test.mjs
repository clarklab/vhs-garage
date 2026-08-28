import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wantsQuoteStamp, wantsLeftAlign, clampStampNudge, stampCenterY, stampTravel, canNudgeStamp,
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

test('an unnudged badge sits exactly where it always did', () => {
  const base = stampCenterY(0);
  assert.equal(stampCenterY(), base);
  assert.equal(stampCenterY(null), base);
  assert.equal(stampCenterY('junk'), base);
  assert.ok(base > 0.3 && base < 0.45, `default height moved: ${base}`);
});

test('each step moves the badge by one step of the frame height', () => {
  assert.ok(Math.abs(stampCenterY(1) - stampCenterY(0) - STAMP_NUDGE_STEP) < 1e-9);
  assert.ok(Math.abs(stampCenterY(0) - stampCenterY(-1) - STAMP_NUDGE_STEP) < 1e-9);
  assert.ok(stampCenterY(3) > stampCenterY(0), 'positive is DOWN the frame');
  assert.ok(stampCenterY(-3) < stampCenterY(0), 'negative is UP the frame');
});

test('the step range reaches both edges of any frame', () => {
  // The step count must not be what stops the badge — the frame is. Even a
  // badge that takes up nearly half the frame can be driven to either edge.
  const half = 0.24;
  assert.equal(stampCenterY(STAMP_NUDGE_MIN, half), half, 'can reach the top edge');
  assert.equal(stampCenterY(STAMP_NUDGE_MAX, half), 1 - half, 'can reach the bottom edge');
  // And on a frame where the badge is small, the whole frame is reachable.
  assert.ok(stampCenterY(STAMP_NUDGE_MIN, 0.05) <= 0.05 + 1e-9);
  assert.ok(stampCenterY(STAMP_NUDGE_MAX, 0.05) >= 0.95 - 1e-9);
});

test('the arrows die at the frame edge, not at a step count', () => {
  const half = 0.12;              // a badge on a poster
  const down = (n) => canNudgeStamp(n, 1, stampTravel(n, half));
  // Walk down until it stops, the way the button does.
  let n = 0;
  while (down(n) && n < 100) n++;
  assert.ok(n < STAMP_NUDGE_MAX, `stopped at the frame edge (step ${n}), not the range`);
  assert.ok(stampTravel(n, half).atBottom, 'and it stopped because it is against the edge');
  assert.ok(stampTravel(n, half).y > 0.85, 'having travelled to the bottom of the frame');
  // The other arrow is still live all the way down.
  assert.equal(canNudgeStamp(n, -1, stampTravel(n, half)), true);
});

test('a step that still moves the badge keeps its arrow live', () => {
  const half = 0.12;
  assert.equal(canNudgeStamp(0, 1, stampTravel(0, half)), true);
  assert.equal(canNudgeStamp(0, -1, stampTravel(0, half)), true);
});

test('without a placement the arrows stay live', () => {
  // The badge image may not have decoded on the first paint; enabled is the
  // harmless way to be wrong, since the nudge itself is still clamped.
  assert.equal(canNudgeStamp(0, 1), true);
  assert.equal(canNudgeStamp(0, -1, null), true);
  assert.equal(canNudgeStamp(STAMP_NUDGE_MAX, 1), false, 'the step range is still a backstop');
});

test('clampStampNudge holds the ends and takes whole steps only', () => {
  assert.equal(clampStampNudge(STAMP_NUDGE_MAX + 50), STAMP_NUDGE_MAX);
  assert.equal(clampStampNudge(STAMP_NUDGE_MIN - 50), STAMP_NUDGE_MIN);
  assert.equal(clampStampNudge(2.4), 2);
  assert.equal(clampStampNudge(undefined), 0);
  assert.equal(clampStampNudge(NaN), 0);
  assert.equal(clampStampNudge('3'), 3);
});

test('canNudgeStamp goes false only at the end it has reached', () => {
  assert.equal(canNudgeStamp(0, -1), true);
  assert.equal(canNudgeStamp(0, 1), true);
  assert.equal(canNudgeStamp(STAMP_NUDGE_MIN, -1), false);
  assert.equal(canNudgeStamp(STAMP_NUDGE_MIN, 1), true);  // can always come back
  assert.equal(canNudgeStamp(STAMP_NUDGE_MAX, 1), false);
  assert.equal(canNudgeStamp(STAMP_NUDGE_MAX, -1), true);
});

test('the badge stops at the frame edge instead of shrinking', () => {
  // A 16:9 title frame is short and the badge is a big share of it, so the full
  // upward nudge would push it off the top; it parks against the edge instead.
  const half = 0.31; // half the tilted badge, as a fraction of the frame height
  assert.equal(stampCenterY(STAMP_NUDGE_MIN, half), half, 'held off the top edge');
  assert.ok(stampCenterY(STAMP_NUDGE_MAX, half) <= 1 - half, 'never past the bottom edge');
  assert.equal(stampCenterY(STAMP_NUDGE_MAX, 0.4), 0.6);
});

test('an ordinary nudge lands exactly where it was asked to', () => {
  const half = 0.12; // the badge on a 2:3 poster
  for (const n of [-4, -1, 0, 2, 5, 8]) {
    assert.equal(stampCenterY(n, half), stampCenterY(n), `step ${n} is unclamped`);
    assert.equal(stampTravel(n, half).atTop, false);
    assert.equal(stampTravel(n, half).atBottom, false);
  }
});

test('a junk half-height is ignored rather than moving the badge', () => {
  assert.equal(stampCenterY(2, NaN), stampCenterY(2));
  assert.equal(stampCenterY(2, -1), stampCenterY(2));
  assert.equal(stampCenterY(2, 99), 0.5, 'a badge taller than the frame centres');
});
