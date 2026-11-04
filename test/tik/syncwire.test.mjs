import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  dehydrate, rehydrate, placeholderHashes, planSync, chunkBySize, chunk, isPlaceholder,
} from '../../public/scripts/tik/syncwire.js';

const hashOf = async (blob) => createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
const jpeg = (s) => new Blob([s], { type: 'image/jpeg' });

test('every Blob becomes a placeholder and travels once', async () => {
  const shared = jpeg('frame-1');
  const rec = {
    id: 'p1', name: 'Aliens', thumb: shared,
    slides: [{ caption: 'a', frame: shared }, { caption: 'b', frame: jpeg('frame-2') }],
  };
  const { record, blobs } = await dehydrate(rec, hashOf);
  assert.equal(blobs.size, 2, 'the thumb and the first frame are the same image');
  assert.ok(isPlaceholder(record.thumb));
  assert.equal(record.thumb.type, 'image/jpeg');
  assert.equal(record.slides[0].frame.$blob, record.thumb.$blob);
  assert.equal(record.slides[1].caption, 'b');
  assert.equal(JSON.parse(JSON.stringify(record)).slides[1].frame.$blob, record.slides[1].frame.$blob, 'it survives JSON');
  assert.ok(rec.thumb instanceof Blob, 'the original record is left alone');
});

test('rehydrate fills what it has and keeps the rest for later', async () => {
  const a = jpeg('a');
  const b = jpeg('b');
  const { record, blobs } = await dehydrate({ thumb: a, slides: [{ frame: a }, { frame: b }] }, hashOf);
  const [ha, hb] = [await hashOf(a), await hashOf(b)];
  assert.deepEqual([...placeholderHashes(record)].sort(), [ha, hb].sort());
  const partial = rehydrate(record, new Map([[ha, blobs.get(ha)]]));
  assert.ok(partial.thumb instanceof Blob);
  assert.ok(partial.slides[0].frame instanceof Blob);
  assert.ok(isPlaceholder(partial.slides[1].frame));
  assert.deepEqual([...placeholderHashes(partial)], [hb]);
});

test('a project only this device has is pushed; one only the cloud has is pulled', () => {
  const plan = planSync({ projects: { cloud: { u: 5 } } }, [{ id: 'local', updatedAt: 3 }]);
  assert.deepEqual(plan, { pull: ['cloud'], push: ['local'], deleteLocal: [], pushDeletes: [] });
});

test('newest edit wins either way', () => {
  const plan = planSync(
    { projects: { a: { u: 10 }, b: { u: 30 }, same: { u: 7 } } },
    [{ id: 'a', updatedAt: 20 }, { id: 'b', updatedAt: 25 }, { id: 'same', updatedAt: 7 }],
  );
  assert.deepEqual(plan.push, ['a']);
  assert.deepEqual(plan.pull, ['b']);
});

test('a delete made elsewhere removes the local copy, unless it was edited here since', () => {
  const plan = planSync(
    { projects: { gone: { u: 50, d: 50 }, edited: { u: 50, d: 50 } } },
    [{ id: 'gone', updatedAt: 40 }, { id: 'edited', updatedAt: 60 }],
  );
  assert.deepEqual(plan.deleteLocal, ['gone']);
  assert.deepEqual(plan.push, ['edited']);
});

test('a delete made here is sent, and not undone by pulling the old copy back', () => {
  const plan = planSync({ projects: { x: { u: 10 } } }, [], { x: 20 });
  assert.deepEqual(plan.pushDeletes, [{ id: 'x', at: 20 }]);
  assert.deepEqual(plan.pull, []);
});

test('a project edited elsewhere after this device deleted it comes back', () => {
  const plan = planSync({ projects: { x: { u: 30 } } }, [], { x: 20 });
  assert.deepEqual(plan.pushDeletes, []);
  assert.deepEqual(plan.pull, ['x']);
});

test('chunking keeps runs under the size cap, and an oversized item travels alone', () => {
  const runs = chunkBySize([3, 3, 3, 9, 1], (n) => n, 6);
  assert.deepEqual(runs, [[3, 3], [3], [9], [1]]);
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunkBySize([], (n) => n, 6), []);
});
