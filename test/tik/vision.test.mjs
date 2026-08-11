import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSheetPrompt, normalizeSheetVerdict, ISSUES, SHEET_SIZE, MAX_ROUNDS,
} from '../../netlify/functions/lib/vision.mjs';
import {
  sheetSeconds, SHEET_OFFSETS,
  SHEET_SIZE as CLIENT_SHEET_SIZE, MAX_ROUNDS as CLIENT_MAX_ROUNDS,
} from '../../public/scripts/tik/sheet.js';

const frames = (secs) => secs.map((seconds) => ({ seconds }));

// ---- the two halves must agree ----

test('the client and server agree on sheet size and round count', () => {
  // The browser decides where to grab; the server caps the request and writes
  // the prompt. A mismatch means frames get silently dropped on arrival.
  assert.equal(CLIENT_SHEET_SIZE, SHEET_SIZE);
  assert.equal(CLIENT_MAX_ROUNDS, MAX_ROUNDS);
});

test('a sheet is worth more than the old one-frame loop', () => {
  // The whole point: more frames seen, fewer round trips.
  assert.ok(SHEET_SIZE >= 4, `only ${SHEET_SIZE} frames per call`);
  assert.ok(SHEET_SIZE * MAX_ROUNDS >= 10, 'fewer frames seen than the old 3-attempt loop');
  assert.ok(MAX_ROUNDS <= 3, 'too many round trips');
});

// ---- where to sample ----

test('sheetSeconds keeps several frames near the guess and fans the rest out', () => {
  const out = sheetSeconds({ center: 3000, durationSeconds: 7200 });
  assert.equal(out.length, SHEET_SIZE);
  assert.equal(out[0], 3000, 'the guess itself must be sampled first');
  const near = out.filter((s) => Math.abs(s - 3000) <= 45);
  assert.ok(near.length >= 3, `only ${near.length} frames near the guess`);
  const span = Math.max(...out) - Math.min(...out);
  assert.ok(span >= 240, `sheet only spans ${span}s — that is not a range`);
});

test('sheetSeconds never samples the same shot twice', () => {
  const out = sheetSeconds({ center: 3000, durationSeconds: 7200 });
  for (const a of out) {
    assert.equal(out.filter((b) => Math.abs(a - b) < 4).length, 1, `duplicate near ${a}`);
  }
});

test('sheetSeconds stays inside the film at either end', () => {
  for (const center of [0, 5, 7195, 7200]) {
    const out = sheetSeconds({ center, durationSeconds: 7200 });
    assert.equal(out.length, SHEET_SIZE, `short sheet at ${center}`);
    assert.ok(out.every((s) => s >= 0 && s <= 7200), `out of range at ${center}`);
    assert.equal(new Set(out).size, out.length, `duplicates at ${center}`);
  }
});

test('sheetSeconds avoids everything already rejected', () => {
  const first = sheetSeconds({ center: 3000, durationSeconds: 7200 });
  const second = sheetSeconds({
    center: 5000, durationSeconds: 7200,
    tried: first.map((seconds) => ({ seconds })),
  });
  assert.equal(second.length, SHEET_SIZE);
  for (const s of second) {
    assert.ok(first.every((t) => Math.abs(t - s) >= 4), `${s} was already shown`);
  }
});

test('sheetSeconds fills a sheet even in a very short film', () => {
  const out = sheetSeconds({ center: 30, durationSeconds: 60 });
  assert.ok(out.length >= 1 && out.length <= SHEET_SIZE);
  assert.ok(out.every((s) => s >= 0 && s <= 60));
  assert.equal(new Set(out).size, out.length);
});

test('sheetSeconds survives junk', () => {
  assert.deepEqual(sheetSeconds({ center: NaN, durationSeconds: 0 }), [0]);
  assert.ok(Array.isArray(sheetSeconds()));
  assert.ok(sheetSeconds({ center: -50, durationSeconds: 100 }).every((s) => s >= 0));
});

test('the offsets lead with the guess and cover both directions', () => {
  assert.equal(SHEET_OFFSETS[0], 0);
  assert.ok(SHEET_OFFSETS.some((o) => o > 0) && SHEET_OFFSETS.some((o) => o < 0));
});

// ---- the prompt ----

test('buildSheetPrompt numbers every frame with its timecode', () => {
  const p = buildSheetPrompt({
    caption: 'The shark was named Bruce.', grab: 'the shark surfacing',
    frames: frames([1200, 1240, 1160]), durationSeconds: 7440,
  });
  assert.match(p, /Frame 1: 1200s/);
  assert.match(p, /Frame 2: 1240s/);
  assert.match(p, /Frame 3: 1160s/);
  assert.match(p, /The shark was named Bruce\./);
  assert.match(p, /<shot_wanted>the shark surfacing<\/shot_wanted>/);
});

test('buildSheetPrompt asks for a pick, not a yes or no', () => {
  const p = buildSheetPrompt({ caption: 'A fact.', frames: frames([10, 20]), durationSeconds: 100 });
  assert.match(p, /"pick"/);
  assert.match(p, /pick the single best one/i);
  // Rejecting the whole sheet is the exception, not the default.
  assert.match(p, /Only if EVERY frame is ruled out/);
  assert.match(p, /Prefer a merely-decent frame over rejecting the whole sheet/i);
});

test('buildSheetPrompt omits the shot block when there is no hint', () => {
  const p = buildSheetPrompt({ caption: 'A fact.', frames: frames([10]), durationSeconds: 100 });
  assert.doesNotMatch(p, /<shot_wanted>/);
});

test('buildSheetPrompt asks for a title card in title mode only', () => {
  const t = buildSheetPrompt({ caption: 'Jaws', frames: frames([60]), durationSeconds: 7440, kind: 'title' });
  const v = buildSheetPrompt({ caption: 'A fact.', frames: frames([60]), durationSeconds: 7440 });
  assert.match(t, /TITLE CARD/);
  assert.doesNotMatch(v, /TITLE CARD/);
});

test('buildSheetPrompt lists rejected timecodes so round two looks elsewhere', () => {
  const p = buildSheetPrompt({
    caption: 'A fact.', frames: frames([3000]), durationSeconds: 7200, round: 2,
    tried: [{ seconds: 1200, reason: 'credits' }, { seconds: 1240, reason: 'black' }],
  });
  assert.match(p, /do not send us back to these/i);
  assert.match(p, /1200s: credits/);
  assert.match(p, /1240s: black/);
  assert.match(p, /round 2 of/);
});

// ---- reading the answer ----

test('normalizeSheetVerdict turns a 1-based pick into an index', () => {
  const v = normalizeSheetVerdict({ pick: 3, issue: 'ok', reason: 'Shark surfacing.', confidence: 0.9 }, 6, 7200);
  assert.equal(v.pick, 2);
  assert.equal(v.ok, true);
  assert.equal(v.suggestSeconds, null);
});

test('normalizeSheetVerdict accepts the first and last frame', () => {
  assert.equal(normalizeSheetVerdict({ pick: 1 }, 6, 100).pick, 0);
  assert.equal(normalizeSheetVerdict({ pick: 6 }, 6, 100).pick, 5);
});

test('normalizeSheetVerdict rejects an out-of-range pick rather than trusting it', () => {
  // Picking frame 7 of 6 would index past the end and crash the client.
  for (const pick of [0, 7, -1, 99, 'three', null]) {
    const v = normalizeSheetVerdict({ pick }, 6, 100);
    assert.equal(v.pick, null, `accepted pick=${pick}`);
    assert.equal(v.ok, false);
  }
});

test('a whole-sheet rejection carries a clamped suggestion', () => {
  const v = normalizeSheetVerdict({ pick: null, issue: 'wrong-scene', suggestSeconds: 99999 }, 6, 7200);
  assert.equal(v.pick, null);
  assert.equal(v.suggestSeconds, 7200);
  assert.equal(v.issue, 'wrong-scene');
});

test('a suggestion alongside a pick is ignored', () => {
  const v = normalizeSheetVerdict({ pick: 2, suggestSeconds: 500 }, 6, 7200);
  assert.equal(v.pick, 1);
  assert.equal(v.suggestSeconds, null);
});

test('an unknown issue falls back inside the closed set', () => {
  const v = normalizeSheetVerdict({ pick: null, issue: 'vibes' }, 6, 100);
  assert.ok(ISSUES.includes(v.issue));
});

test('junk degrades to the first frame, never to a rejection', () => {
  // Frame 1 sits on autopilot's own guess, so a broken verifier leaves us
  // exactly where we would have been without one.
  for (const raw of [null, undefined, 'nope', 42, []]) {
    const v = normalizeSheetVerdict(raw, 6, 100);
    assert.equal(v.pick, 0, `raw=${JSON.stringify(raw)}`);
    assert.equal(v.ok, true);
    assert.equal(v.confidence, 0);
  }
});

test('junk with no frames at all picks nothing instead of index 0', () => {
  const v = normalizeSheetVerdict(null, 0, 100);
  assert.equal(v.pick, null);
  assert.equal(v.ok, false);
});

test('confidence is clamped to 0..1', () => {
  assert.equal(normalizeSheetVerdict({ pick: 1, confidence: 9 }, 6, 100).confidence, 1);
  assert.equal(normalizeSheetVerdict({ pick: 1, confidence: -3 }, 6, 100).confidence, 0);
  assert.equal(normalizeSheetVerdict({ pick: 1 }, 6, 100).confidence, 0.5);
});
