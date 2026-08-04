import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVisionPrompt, normalizeVerdict, nextAttemptSeconds, MAX_ATTEMPTS, ISSUES,
} from '../../netlify/functions/lib/vision.mjs';

// ---- the prompt ----

test('buildVisionPrompt carries the caption, the shot hint and where we are', () => {
  const p = buildVisionPrompt({
    caption: 'Joe Pesci avoided Macaulay Culkin on set.',
    grab: 'Pesci glaring in the doorway',
    timecode: 1200, durationSeconds: 6180, attempt: 1,
  });
  assert.match(p, /Joe Pesci avoided Macaulay Culkin on set\./);
  assert.match(p, /Pesci glaring in the doorway/);
  assert.match(p, /grabbed at 1200 seconds/);
  assert.match(p, /19% through a 6180-second film/);
  assert.match(p, /attempt 1 of 3/);
});

test('buildVisionPrompt omits the shot block when there is no hint', () => {
  const p = buildVisionPrompt({ caption: 'A fact.', timecode: 10, durationSeconds: 100 });
  assert.ok(!p.includes('<shot_wanted>'));
});

test('buildVisionPrompt asks for a title card in title mode only', () => {
  const title = buildVisionPrompt({ caption: 'Home Alone', timecode: 60, durationSeconds: 6180, kind: 'title' });
  const trivia = buildVisionPrompt({ caption: 'A fact.', timecode: 60, durationSeconds: 6180 });
  assert.match(title, /TITLE CARD/);
  assert.ok(!trivia.includes('TITLE CARD'));
});

test('buildVisionPrompt lists what has already been tried so it stops repeating itself', () => {
  const p = buildVisionPrompt({
    caption: 'A fact.', timecode: 900, durationSeconds: 6180, attempt: 3,
    tried: [{ seconds: 100, reason: 'black frame' }, { seconds: 500, reason: 'end credits' }],
  });
  assert.match(p, /do NOT suggest these again/);
  assert.match(p, /- 100s: black frame/);
  assert.match(p, /- 500s: end credits/);
});

test('buildVisionPrompt tells the model a decent frame beats running out of tries', () => {
  // Without this it rejects three good-enough frames and we ship the worst one.
  const p = buildVisionPrompt({ caption: 'A fact.', timecode: 10, durationSeconds: 100 });
  assert.match(p, /merely-decent frame beats running out of attempts/);
});

test('buildVisionPrompt survives a zero or missing duration', () => {
  const p = buildVisionPrompt({ caption: 'A fact.', timecode: 0, durationSeconds: 0 });
  assert.ok(!p.includes('NaN'));
  assert.ok(!p.includes('Infinity'));
});

// ---- the verdict ----

test('normalizeVerdict passes a clean accept through', () => {
  const v = normalizeVerdict({ ok: true, issue: 'ok', reason: 'Pesci in the doorway.', confidence: 0.9 }, 6180);
  assert.deepEqual(v, { ok: true, issue: 'ok', reason: 'Pesci in the doorway.', suggestSeconds: null, confidence: 0.9 });
});

test('normalizeVerdict keeps a rejection and its suggestion', () => {
  const v = normalizeVerdict({ ok: false, issue: 'credits', reason: 'End credits.', suggestSeconds: 900, confidence: 0.95 }, 6180);
  assert.equal(v.ok, false);
  assert.equal(v.issue, 'credits');
  assert.equal(v.suggestSeconds, 900);
});

test('normalizeVerdict clamps a suggestion into the runtime', () => {
  assert.equal(normalizeVerdict({ ok: false, suggestSeconds: 99999 }, 6180).suggestSeconds, 6180);
  assert.equal(normalizeVerdict({ ok: false, suggestSeconds: -50 }, 6180).suggestSeconds, 0);
  assert.equal(normalizeVerdict({ ok: false, suggestSeconds: 900.6 }, 6180).suggestSeconds, 901);
});

test('normalizeVerdict drops a suggestion on an accepted frame', () => {
  assert.equal(normalizeVerdict({ ok: true, suggestSeconds: 900 }, 6180).suggestSeconds, null);
});

test('normalizeVerdict rejects an issue outside the known set', () => {
  assert.equal(normalizeVerdict({ ok: false, issue: 'vibes' }, 100).issue, 'unclear');
  assert.equal(normalizeVerdict({ ok: true, issue: 'vibes' }, 100).issue, 'ok');
  ISSUES.forEach((i) => assert.equal(normalizeVerdict({ ok: false, issue: i }, 100).issue, i));
});

test('normalizeVerdict treats unparseable output as a low-confidence accept', () => {
  // A broken verifier must not throw away a frame that was probably fine.
  for (const junk of [null, undefined, 'nope', 42]) {
    const v = normalizeVerdict(junk, 6180);
    assert.equal(v.ok, true);
    assert.equal(v.confidence, 0);
    assert.equal(v.suggestSeconds, null);
  }
});

test('normalizeVerdict clamps confidence and survives junk', () => {
  assert.equal(normalizeVerdict({ ok: true, confidence: 5 }, 100).confidence, 1);
  assert.equal(normalizeVerdict({ ok: true, confidence: -2 }, 100).confidence, 0);
  assert.equal(normalizeVerdict({ ok: true, confidence: 'high' }, 100).confidence, 0.5);
});

test('normalizeVerdict accepts a stringified boolean', () => {
  assert.equal(normalizeVerdict({ ok: 'true' }, 100).ok, true);
});

// ---- picking the next frame ----

const V = (suggest) => ({ ok: false, suggestSeconds: suggest });

test('nextAttemptSeconds takes a usable suggestion', () => {
  assert.equal(nextAttemptSeconds(V(2400), { current: 1200, durationSeconds: 6180, tried: [] }), 2400);
});

test('nextAttemptSeconds refuses a suggestion that re-grabs the same shot', () => {
  // The loop exists to stop wasting attempts on one frame; a 2-second nudge is
  // the same frame.
  const out = nextAttemptSeconds(V(1202), { current: 1200, durationSeconds: 6180, tried: [] });
  assert.notEqual(out, 1202);
  assert.ok(Math.abs(out - 1200) >= 4);
});

test('nextAttemptSeconds refuses a suggestion we already rejected', () => {
  const tried = [{ seconds: 300 }, { seconds: 900 }];
  const out = nextAttemptSeconds(V(900), { current: 1200, durationSeconds: 6180, tried });
  assert.ok(![300, 900, 1200].includes(out));
});

test('nextAttemptSeconds probes elsewhere when the model suggests nothing', () => {
  const out = nextAttemptSeconds({ ok: false, suggestSeconds: null }, { current: 1200, durationSeconds: 6180, tried: [], attempt: 1 });
  assert.ok(Number.isFinite(out));
  assert.ok(Math.abs(out - 1200) >= 45, 'moved a meaningful distance');
  assert.ok(out >= 0 && out <= 6180);
});

test('three attempts sample three different parts of the runtime', () => {
  const dur = 6180;
  const tried = [];
  let current = 1200;
  const picks = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const next = nextAttemptSeconds({ ok: false, suggestSeconds: null }, { current, durationSeconds: dur, tried, attempt });
    assert.ok(Number.isFinite(next), 'always finds somewhere new to look');
    picks.push(next);
    tried.push({ seconds: current });
    current = next;
  }
  assert.equal(new Set(picks).size, picks.length, 'no repeats');
  picks.forEach((p) => assert.ok(p >= 0 && p <= dur));
});

test('nextAttemptSeconds stays inside a very short film', () => {
  const out = nextAttemptSeconds(V(500), { current: 5, durationSeconds: 20, tried: [] });
  assert.ok(out === null || (out >= 0 && out <= 20));
});

test('nextAttemptSeconds gives up rather than looping when there is nowhere new', () => {
  // A 6-second film with the start already tried: every candidate collides.
  const out = nextAttemptSeconds(V(3), { current: 0, durationSeconds: 6, tried: [{ seconds: 6 }] });
  assert.equal(out, null);
});
