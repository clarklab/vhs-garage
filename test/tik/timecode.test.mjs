import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTimecode, frameStep, seekTime } from '../../public/scripts/tik/timecode.js';

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

test('seekTime is the first quarter of the cue span', () => {
  assert.equal(seekTime(12, 16), 13);
  assert.equal(seekTime(10, 10), 10);
  assert.equal(seekTime(0, 4), 1);
  assert.ok(Math.abs(seekTime(1.2, 5.2) - 2.2) < 1e-9);
});

test('seekTime spans several cues via first start and last end', () => {
  assert.equal(seekTime(8, 20), 11);
});

test('seekTime survives junk', () => {
  assert.equal(seekTime(null, 10), 0);
  assert.equal(seekTime(5, 'nope'), 5);
  assert.equal(seekTime(-2, 2), 0);
});
