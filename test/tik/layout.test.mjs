import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSlideLayout, CANVAS_W, CANVAS_H } from '../../public/scripts/tik/layout.js';

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
