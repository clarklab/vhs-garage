import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapLines, fitFontSize, fontScaleForQuote } from '../../public/scripts/tik/caption.js';

// Fake measurer: every character is 10px wide.
const measure10 = (s) => s.length * 10;

test('wrapLines greedily fills lines up to maxWidth', () => {
  // maxWidth 100 → 10 chars per line
  const lines = wrapLines('hello world foo', 100, measure10);
  assert.deepEqual(lines, ['hello', 'world foo']);
});

test('wrapLines keeps a single over-long word on its own line', () => {
  const lines = wrapLines('supercalifragilistic hi', 100, measure10);
  assert.deepEqual(lines, ['supercalifragilistic', 'hi']);
});

test('wrapLines preserves explicit newlines', () => {
  const lines = wrapLines('a\nb c', 100, measure10);
  assert.deepEqual(lines, ['a', 'b c']);
});

test('wrapLines on empty/whitespace returns a single empty line', () => {
  assert.deepEqual(wrapLines('   ', 100, measure10), ['']);
});

test('fitFontSize shrinks so all lines fit the band height', () => {
  // 4 lines, band 400px, lineHeightFactor 1.25 → 400/(4*1.25)=80, capped at maxFont
  assert.equal(fitFontSize(4, 400, { lineHeightFactor: 1.25, maxFont: 100 }), 80);
  // capped by maxFont when there's plenty of room
  assert.equal(fitFontSize(1, 4000, { lineHeightFactor: 1.25, maxFont: 100 }), 100);
  // never below minFont
  assert.equal(fitFontSize(50, 100, { lineHeightFactor: 1.25, maxFont: 100, minFont: 24 }), 24);
});

test('fontScaleForQuote grows short lines and shrinks long ones', () => {
  assert.equal(fontScaleForQuote("I'll be back."), 1.35);
  assert.equal(fontScaleForQuote('Come with me if you want to live.'), 1.35);
  assert.equal(fontScaleForQuote('x'.repeat(50)), 1.15);
  assert.equal(fontScaleForQuote('x'.repeat(100)), 1.0);
  assert.equal(fontScaleForQuote('x'.repeat(200)), 0.85);
  assert.equal(fontScaleForQuote(''), 1);
  assert.equal(fontScaleForQuote(null), 1);
});
