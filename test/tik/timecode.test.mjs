import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTimecode, frameStep } from '../../public/scripts/tik/timecode.js';

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
