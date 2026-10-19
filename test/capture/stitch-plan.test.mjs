import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planStitch, frameAt, clipGainAt, staticGainAt, CROSSFADE_SEC, STATIC_SEC } from '../../public/scripts/capture/stitch-plan.js';

const close = (a, b) => Math.abs(a - b) < 1e-9;

test('cut: clips play back to back', () => {
  const p = planStitch([10, 5, 7], 'cut');
  assert.deepEqual(p.clips.map(c => c.start), [0, 10, 15]);
  assert.equal(p.total, 22);
  assert.deepEqual(frameAt(p, 10).layers, [{ index: 1, sourceTime: 0, alpha: 1 }]);
});

test('crossfade: clips overlap, picture and audio blend', () => {
  const p = planStitch([10, 5], 'crossfade');
  assert.ok(close(p.clips[1].start, 10 - CROSSFADE_SEC));
  assert.ok(close(p.total, 15 - CROSSFADE_SEC));
  const mid = p.clips[1].start + CROSSFADE_SEC / 2;
  const f = frameAt(p, mid);
  assert.equal(f.layers.length, 2);
  assert.ok(close(f.layers[1].alpha, 0.5));
  // Equal-power: gains squared sum to 1 through the overlap.
  const g0 = clipGainAt(p, 0, mid), g1 = clipGainAt(p, 1, mid);
  assert.ok(close(g0 * g0 + g1 * g1, 1));
});

test('crossfade never eats more than a third of a short clip', () => {
  const p = planStitch([1.2, 1.5], 'crossfade');
  assert.ok(close(p.fades[0].length, 0.4));
});

test('static: a burst between clips, hiss only inside it', () => {
  const p = planStitch([4, 4], 'static');
  assert.equal(p.clips[1].start, 4 + STATIC_SEC);
  const f = frameAt(p, 4 + STATIC_SEC / 2);
  assert.equal(f.static, true);
  assert.equal(f.layers.length, 0);
  assert.equal(staticGainAt(p, 4 + STATIC_SEC / 2), 1);
  assert.equal(staticGainAt(p, 3), 0);
});

test('hard edges ramp audio instead of clicking', () => {
  const p = planStitch([4, 4], 'cut');
  assert.equal(clipGainAt(p, 0, 0), 0);
  assert.equal(clipGainAt(p, 0, 2), 1);
  assert.ok(clipGainAt(p, 0, 3.999) < 0.2);
  assert.equal(clipGainAt(p, 1, 4), 0);
});
