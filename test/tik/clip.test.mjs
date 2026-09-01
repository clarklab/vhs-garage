import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sceneWindow, planClip, pickClipMime, extensionForMime, describePlan, silenceReason,
  PAD_BEFORE, PAD_AFTER, MIN_SCENE, MAX_SCENE, GUESS_SCENE, STILL_SECONDS, CLIP_MIME_CANDIDATES,
} from '../../public/scripts/tik/clip.js';

const quote = (id, cue, timecode) => ({ id, kind: null, cue, timecode });
const isTitle = (s) => s.kind === 'title';
const isOutro = (s) => s.kind === 'outro';

test('a matched cue becomes its own span plus padding either side', () => {
  const w = sceneWindow(quote('1', { start: 600, end: 604 }), { duration: 7000 });
  assert.equal(w.start, 600 - PAD_BEFORE);
  assert.equal(w.end, 604 + PAD_AFTER);
});

test('an unmatched line holds a window from the guessed time', () => {
  // There is no end to use, so inventing one is worse than holding a window.
  const w = sceneWindow(quote('1', null, 600), { duration: 7000 });
  assert.equal(w.start, 600 - PAD_BEFORE);
  assert.equal(w.end, 600 + GUESS_SCENE);
});

test('a slide with no time at all is not a scene', () => {
  assert.equal(sceneWindow(quote('1', null, null), { duration: 7000 }), null);
  assert.equal(sceneWindow(null, { duration: 7000 }), null);
  assert.equal(sceneWindow({ id: '1', timecode: 'nonsense' }, { duration: 7000 }), null);
});

test('a one-word cue is stretched to something watchable', () => {
  const w = sceneWindow(quote('1', { start: 100, end: 100.4 }), { duration: 7000 });
  assert.ok(w.end - w.start >= MIN_SCENE, `${w.end - w.start}s is too short to read`);
});

test('a runaway cue span is capped rather than trusted', () => {
  // A 90-second "cue" is a bad match, not a long line.
  const w = sceneWindow(quote('1', { start: 100, end: 190 }), { duration: 7000 });
  assert.equal(w.end - w.start, MAX_SCENE);
});

test('a scene never runs past the end of the film or before its start', () => {
  const last = sceneWindow(quote('1', { start: 6998, end: 6999.5 }), { duration: 7000 });
  assert.ok(last.end <= 7000, `ends at ${last.end}, past the film`);
  assert.ok(last.end - last.start >= MIN_SCENE, 'takes the length off the front instead');
  const first = sceneWindow(quote('1', { start: 0.2, end: 1.1 }), { duration: 7000 });
  assert.ok(first.start >= 0, `starts at ${first.start}`);
});

test('an unknown duration does not clamp anything away', () => {
  const w = sceneWindow(quote('1', { start: 600, end: 604 }), { duration: 0 });
  assert.equal(w.end, 604 + PAD_AFTER);
});

test('the plan is the set: title still, a scene per quote, sign-off still', () => {
  const slides = [
    { id: 't', kind: 'title', timecode: 90 },
    quote('a', { start: 600, end: 603 }),
    quote('b', { start: 1200, end: 1204 }),
    { id: 'o', kind: 'outro' },
  ];
  const plan = planClip(slides, { duration: 7000, isTitle, isOutro });
  assert.deepEqual(plan.parts.map((p) => p.kind), ['still', 'scene', 'scene', 'still']);
  assert.deepEqual(plan.parts.map((p) => p.slideId), ['t', 'a', 'b', 'o']);
  assert.equal(plan.scenes, 2);
  // Two stills plus both padded spans.
  const expected = STILL_SECONDS * 2 + (3 + PAD_BEFORE + PAD_AFTER) + (4 + PAD_BEFORE + PAD_AFTER);
  assert.ok(Math.abs(plan.seconds - expected) < 1e-9, `${plan.seconds} vs ${expected}`);
});

test('the title card is a still even though it has a timecode', () => {
  // It points at the film's title card, but the clip holds the composed slide
  // rather than playing three seconds of main titles.
  const plan = planClip([{ id: 't', kind: 'title', timecode: 90, cue: { start: 90, end: 95 } }],
    { duration: 7000, isTitle, isOutro });
  assert.equal(plan.parts[0].kind, 'still');
  assert.equal(plan.parts[0].seconds, STILL_SECONDS);
});

test('a quote with no timecode is reported, not silently dropped', () => {
  const plan = planClip([quote('a', { start: 600, end: 603 }), quote('b', null, null)],
    { duration: 7000, isTitle, isOutro });
  assert.equal(plan.scenes, 1);
  assert.deepEqual(plan.skipped, [{ slideId: 'b', reason: 'no timecode' }]);
  assert.match(describePlan(plan), /1 skipped/);
});

test('the set order is the clip order, even out of film order', () => {
  // Slides are reorderable; the post's order is the one the user chose.
  const plan = planClip([quote('late', { start: 4000, end: 4003 }), quote('early', { start: 100, end: 103 })],
    { duration: 7000, isTitle, isOutro });
  assert.deepEqual(plan.parts.map((p) => p.slideId), ['late', 'early']);
});

test('two quotes from the same exchange are reported as an overlap', () => {
  const plan = planClip([quote('a', { start: 600, end: 603 }), quote('b', { start: 604, end: 607 })],
    { duration: 7000, isTitle, isOutro });
  assert.equal(plan.overlaps, 1, 'b starts inside a’s padded tail');
  assert.equal(plan.scenes, 2, 'and both are still cut');
});

test('an empty set plans nothing rather than throwing', () => {
  const plan = planClip([], { duration: 7000, isTitle, isOutro });
  assert.deepEqual(plan.parts, []);
  assert.equal(plan.seconds, 0);
  assert.equal(describePlan(plan), '');
  assert.deepEqual(planClip(null, {}).parts, []);
});

test('a long set is flagged', () => {
  const many = Array.from({ length: 40 }, (_, i) => quote(String(i), { start: 100 + i * 20, end: 110 + i * 20 }));
  assert.equal(planClip(many, { duration: 7000, isTitle, isOutro }).long, true);
  assert.equal(planClip(many.slice(0, 3), { duration: 7000, isTitle, isOutro }).long, false);
});

test('describePlan says what the render is about to cost', () => {
  const plan = planClip([quote('a', { start: 600, end: 603 })], { duration: 7000, isTitle, isOutro });
  assert.match(describePlan(plan), /^1 scene · 0:06$/); // 3s of line + 2.8s of padding
});

test('a null timecode is not the top of the film', () => {
  // Number(null) is 0, and taking that at face value cut from 0:00.
  assert.equal(sceneWindow({ id: 'x', cue: null, timecode: null }, { duration: 7000 }), null);
  assert.equal(sceneWindow({ id: 'x', cue: { start: null, end: null }, timecode: null }, { duration: 7000 }), null);
  assert.equal(sceneWindow({ id: 'x', timecode: '' }, { duration: 7000 }), null);
  // But a real zero is a real time.
  assert.deepEqual(sceneWindow({ id: 'x', timecode: 0 }, { duration: 7000 }), { start: 0, end: GUESS_SCENE });
});

// ---- Encoding ----

test('MP4 wins when the browser can record it', () => {
  const mime = pickClipMime((t) => t.includes('mp4'));
  assert.match(mime, /mp4/);
  assert.equal(extensionForMime(mime), 'mp4');
});

test('WebM is a fallback, not a failure', () => {
  const mime = pickClipMime((t) => t.startsWith('video/webm'));
  assert.match(mime, /webm/);
  assert.equal(extensionForMime(mime), 'webm');
});

test('a browser that records nothing says so instead of guessing', () => {
  assert.equal(pickClipMime(() => false), null);
  assert.equal(pickClipMime(null), null);
  assert.equal(pickClipMime(() => { throw new Error('bad type'); }), null);
});

test('every candidate is a type the recorder could be asked for', () => {
  for (const t of CLIP_MIME_CANDIDATES) assert.match(t, /^video\/(mp4|webm)/);
  assert.equal(extensionForMime(undefined), 'webm', 'defaults to the safe container');
});


// ---- Telling a silent clip apart from a silent film ----

test('a clip with sound says nothing', () => {
  assert.equal(silenceReason({ sound: 'recorded', filmDecodedAudio: true }), '');
});

test('a film whose audio the browser cannot decode is named as the cause', () => {
  // The common one by far: rips carry AC-3 or DTS, Chrome decodes neither, and
  // the film plays silently in the editor too.
  const msg = silenceReason({ sound: 'silent', filmDecodedAudio: false });
  assert.match(msg, /AC-3|DTS/);
  assert.match(msg, /AAC/, 'and says what fixes it');
});

test('a decoding film that still records silent is called a bug', () => {
  // The two cases must not wear the same message: this one is ours.
  const msg = silenceReason({ sound: 'silent', filmDecodedAudio: true });
  assert.match(msg, /bug/);
  assert.doesNotMatch(msg, /AC-3/);
});

test('an untapped film is its own answer', () => {
  assert.match(silenceReason({ sound: 'untapped' }), /couldn’t be tapped/);
});

test('an unknown decoder state still says something useful', () => {
  const msg = silenceReason({ sound: 'silent', filmDecodedAudio: null });
  assert.ok(msg.length > 0);
  assert.match(msg, /silent/);
  assert.equal(silenceReason({}), silenceReason({ sound: 'silent', filmDecodedAudio: null }));
  assert.ok(silenceReason().length > 0, 'and never throws on nothing');
});
