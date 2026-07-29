import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSlideLayout, containFrame, CANVAS_W, CANVAS_H } from '../../public/scripts/tik/layout.js';

test('canvas constants are TikTok portrait', () => {
  assert.equal(CANVAS_W, 1080);
  assert.equal(CANVAS_H, 1920);
});

test('16:9 frame fills width, letterboxed at top, band fills the rest', () => {
  const L = computeSlideLayout(1920, 1080); // 16:9 source
  assert.equal(L.frame.w, 1080);
  assert.equal(L.frame.h, Math.round(1080 * 1080 / 1920)); // 608
  assert.equal(L.frame.x, 0);
  assert.equal(L.frame.y, 0);
  assert.equal(L.band.x, 0);
  assert.equal(L.band.y, L.frame.h);
  assert.equal(L.band.w, 1080);
  assert.equal(L.band.h, CANVAS_H - L.frame.h);
});

test('very tall source is capped so the band survives, frame centered horizontally', () => {
  const L = computeSlideLayout(1080, 1920); // portrait source, ar 0.5625
  const maxH = Math.round(CANVAS_H * 0.6); // 1152 cap
  assert.equal(L.frame.h, maxH);
  assert.ok(L.frame.w < CANVAS_W);          // narrower than canvas
  assert.equal(L.frame.x, Math.round((CANVAS_W - L.frame.w) / 2)); // centered
  assert.equal(L.band.y, maxH);
  assert.equal(L.band.h, CANVAS_H - maxH);
});

// ---- containFrame: bring-your-own-image formats ----
// The whole image must be visible, so this is a "contain" fit: never cropped,
// never stretched. Callers bound it by HEIGHT and leave the width free, so a
// square or widescreen image runs full width while a tall one is held back
// from pushing the caption down the slide.

const CAP_H = Math.round(CANVAS_H * 0.6); // the Year Snapshot bound: 1152

test('containFrame lets square and widescreen images run the full width', () => {
  assert.deepEqual(containFrame(1080, 1080, CANVAS_W, CAP_H), { w: 1080, h: 1080 });
  assert.deepEqual(containFrame(1920, 1080, CANVAS_W, CAP_H), { w: 1080, h: 608 });
  assert.deepEqual(containFrame(2400, 900, CANVAS_W, CAP_H), { w: 1080, h: 405 });
});

test('containFrame holds tall images to the height bound', () => {
  // 2:3 poster and a 9:16 composed image both stop at the cap, not the width.
  const poster = containFrame(1000, 1500, CANVAS_W, CAP_H);
  assert.equal(poster.h, CAP_H);
  assert.equal(poster.w, 768);
  const tall = containFrame(1080, 1920, CANVAS_W, CAP_H);
  assert.equal(tall.h, CAP_H);
  assert.equal(tall.w, 648);
  // Both are narrower than the canvas, which is the point of bounding height.
  assert.ok(poster.w < CANVAS_W && tall.w < CANVAS_W);
});

test('containFrame preserves the source aspect ratio in every direction', () => {
  for (const [w, h] of [[1000, 1500], [1080, 1920], [1080, 1080], [1920, 1080], [2400, 900], [500, 2000]]) {
    const box = containFrame(w, h, CANVAS_W, CAP_H);
    assert.ok(Math.abs(box.h / box.w - h / w) < 0.01, `aspect drifted for ${w}x${h}`);
    assert.ok(box.w <= CANVAS_W && box.h <= CAP_H, `${w}x${h} overflowed its box`);
  }
});

test('containFrame shrinks further when the caller offers less room', () => {
  // A long caption leaves less than the height cap; the image gives way to it.
  const squeezed = containFrame(1000, 1500, CANVAS_W, 850);
  assert.equal(squeezed.h, 850);
  assert.ok(squeezed.w < 768);
});

test('containFrame survives junk dimensions instead of returning NaN', () => {
  for (const box of [containFrame(0, 0, CANVAS_W, CAP_H), containFrame(NaN, undefined, CANVAS_W, CAP_H)]) {
    assert.ok(Number.isFinite(box.w) && Number.isFinite(box.h));
    assert.ok(box.w > 0 && box.h > 0);
  }
});
