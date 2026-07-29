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
// The whole image must be visible, so this is a "contain" fit: it never crops
// and never stretches. The caller decides how much room to offer.

test('containFrame fills the width when the image is wide enough to allow it', () => {
  // 16:9 into a full-canvas budget.
  assert.deepEqual(containFrame(1920, 1080, 1080, 1920), { w: 1080, h: 608 });
  // Square.
  assert.deepEqual(containFrame(1000, 1000, 1080, 1920), { w: 1080, h: 1080 });
});

test('containFrame shows a whole poster far larger than the 60% cap did', () => {
  // A 2:3 poster with the full canvas to work with.
  const full = containFrame(1000, 1500, 1080, 1920);
  assert.deepEqual(full, { w: 1080, h: 1620 });
  // What the old fixed cap produced, for contrast: 768x1152.
  const capped = computeSlideLayout(1000, 1500).frame;
  assert.ok(full.w > capped.w && full.h > capped.h, 'contain must beat the fixed cap');
  // Aspect ratio is preserved either way — the image is scaled, never cropped.
  assert.ok(Math.abs(full.h / full.w - 1500 / 1000) < 0.01);
});

test('containFrame takes a pre-composed 9:16 image edge to edge', () => {
  assert.deepEqual(containFrame(1080, 1920, 1080, 1920), { w: 1080, h: 1920 });
  // Same image with room reserved for a caption: still whole, just smaller.
  const withCaption = containFrame(1080, 1920, 1080, 1500);
  assert.equal(withCaption.h, 1500);
  assert.ok(withCaption.w < 1080);
  assert.ok(Math.abs(withCaption.h / withCaption.w - 1920 / 1080) < 0.01);
});

test('containFrame is height-bound for tall images and width-bound for wide ones', () => {
  const tall = containFrame(500, 2000, 1080, 1920);   // ar 4.0
  assert.equal(tall.h, 1920);
  assert.equal(tall.w, 480);
  const wide = containFrame(4000, 500, 1080, 1920);   // ar 0.125
  assert.equal(wide.w, 1080);
  assert.equal(wide.h, 135);
});

test('containFrame survives junk dimensions instead of returning NaN', () => {
  for (const box of [containFrame(0, 0, 1080, 1920), containFrame(NaN, undefined, 1080, 1920)]) {
    assert.ok(Number.isFinite(box.w) && Number.isFinite(box.h));
    assert.ok(box.w > 0 && box.h > 0);
  }
});
