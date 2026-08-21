import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wantsQuoteStamp } from '../../public/scripts/tik/compose.js';
import { fontScaleForQuote } from '../../public/scripts/tik/caption.js';
import { defaultPostFields } from '../../public/scripts/tik/project.js';
import { buildQuotesPrompt } from '../../netlify/functions/lib/autopilot.mjs';
import { quoteHints } from '../../netlify/functions/lib/srt.mjs';

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
