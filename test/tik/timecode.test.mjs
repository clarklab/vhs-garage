import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTimecode, frameStep, clockTimecode } from '../../public/scripts/tik/timecode.js';

test('formatTimecode pads minutes, seconds, milliseconds', () => {
  assert.equal(formatTimecode(0), '00:00.000');
  assert.equal(formatTimecode(5.2), '00:05.200');
  assert.equal(formatTimecode(75.019), '01:15.019');
});

test('formatTimecode clamps negatives to zero', () => {
  assert.equal(formatTimecode(-3), '00:00.000');
});

test('frameStep advances and rewinds by one frame at the given fps', () => {
  // 30fps → one frame = 1/30 s ≈ 0.03333
  assert.ok(Math.abs(frameStep(1.0, 1, 30) - (1.0 + 1 / 30)) < 1e-9);
  assert.ok(Math.abs(frameStep(1.0, -1, 30) - (1.0 - 1 / 30)) < 1e-9);
});

test('frameStep never returns a negative time', () => {
  assert.equal(frameStep(0, -1, 30), 0);
});

test('clockTimecode reads as a place in a film, not a stopwatch', () => {
  assert.equal(clockTimecode(0), '0:00');
  assert.equal(clockTimecode(7), '0:07');
  assert.equal(clockTimecode(247), '4:07');
  assert.equal(clockTimecode(3600), '1:00:00');
  assert.equal(clockTimecode(5025), '1:23:45');
  // Past the hour the minutes restart rather than running to 83.
  assert.doesNotMatch(clockTimecode(5025), /83/);
});

test('clockTimecode floors rather than inventing precision, and survives junk', () => {
  assert.equal(clockTimecode(59.9), '0:59');
  for (const bad of [null, undefined, NaN, -30, 'nope']) assert.equal(clockTimecode(bad), '0:00');
});
