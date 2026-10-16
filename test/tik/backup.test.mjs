import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripBlobs, restoreBlobs, blobOffsets, buildManifest, headerLine, parseHeader,
  backupFileName, restorable, MAGIC, BACKUP_EXT,
} from '../../public/scripts/tik/backup.js';

// A stand-in for the browser's Blob, so the manifest half can be tested in node.
class FakeBlob {
  constructor(bytes, type = '') { this.size = bytes; this.type = type; }
}
globalThis.Blob = globalThis.Blob || FakeBlob;
const blob = (size, type = 'image/jpeg') => new globalThis.Blob([new Uint8Array(size)], { type });

const project = (id = 'p1') => ({
  id,
  name: 'The Thing',
  status: 'ready',
  thumb: blob(100, 'image/jpeg'),
  slides: [
    { id: 's1', caption: 'Inconceivable!', frame: blob(200), pairFrames: [blob(30), blob(40)] },
    { id: 's2', caption: 'As you wish.', frame: blob(300), mosaicPhotos: [blob(50)] },
  ],
});

// ---- Pulling the blobs out, and putting them back ----

test('every blob comes out and leaves a reference behind', () => {
  const blobs = [];
  const out = stripBlobs(project(), blobs);
  assert.equal(blobs.length, 6, 'thumb + 2 frames + 2 pair frames + 1 mosaic photo');
  assert.equal(out.thumb.__blob, 0);
  assert.equal(out.slides[0].frame.__blob, 1);
  assert.deepEqual(out.slides[0].pairFrames.map((r) => r.__blob), [2, 3]);
  assert.equal(out.slides[1].mosaicPhotos[0].__blob, 5);
  assert.equal(out.name, 'The Thing', 'everything else is untouched');
  assert.equal(out.slides[0].caption, 'Inconceivable!');
});

test('a round trip gives back the same blobs in the same places', () => {
  const blobs = [];
  const stripped = stripBlobs(project(), blobs);
  const back = restoreBlobs(JSON.parse(JSON.stringify(stripped)), blobs);
  assert.equal(back.thumb, blobs[0]);
  assert.equal(back.slides[0].frame, blobs[1]);
  assert.deepEqual(back.slides[0].pairFrames, [blobs[2], blobs[3]]);
  assert.equal(back.slides[1].frame, blobs[4]);
  assert.deepEqual(back.slides[1].mosaicPhotos, [blobs[5]]);
});

test('a project with no blobs survives both ways', () => {
  const bare = { id: 'x', name: 'imported post', slides: [], thumb: null };
  const blobs = [];
  const stripped = stripBlobs(bare, blobs);
  assert.equal(blobs.length, 0);
  assert.deepEqual(restoreBlobs(stripped, []).slides, []);
  assert.equal(restoreBlobs(stripped, []).thumb, null);
});

test('a missing blob restores as null rather than throwing', () => {
  // A truncated file is a real possibility; losing one frame beats losing the
  // whole restore.
  const broken = { id: 'x', thumb: { __blob: 9 }, slides: [{ id: 's', frame: { __blob: 9 } }] };
  const back = restoreBlobs(broken, []);
  assert.equal(back.thumb, null);
  assert.equal(back.slides[0].frame, null);
});

// ---- Where each blob sits in the file ----

test('offsets lay the blobs end to end with no gaps', () => {
  assert.deepEqual(blobOffsets([100, 200, 50]), [
    { start: 0, end: 100 },
    { start: 100, end: 300 },
    { start: 300, end: 350 },
  ]);
});

test('offsets survive junk sizes', () => {
  assert.deepEqual(blobOffsets([]), []);
  assert.deepEqual(blobOffsets(null), []);
  assert.deepEqual(blobOffsets([10, null, 5]), [
    { start: 0, end: 10 }, { start: 10, end: 10 }, { start: 10, end: 15 },
  ]);
});

test('every slice in the manifest is exactly its blob', () => {
  // The proof that matters: walk the manifest and check each span is the size
  // the blob claimed, in order.
  const blobs = [];
  const stripped = [project('a'), project('b')].map((p) => stripBlobs(p, blobs));
  const manifest = buildManifest(stripped, blobs.map((b) => b.size));
  assert.equal(manifest.blobs.length, blobs.length);
  manifest.blobs.forEach((row, i) => {
    assert.equal(row.end - row.start, blobs[i].size, `blob ${i} span`);
  });
  assert.equal(manifest.blobs.at(-1).end, blobs.reduce((t, b) => t + b.size, 0));
  assert.equal(manifest.projects.length, 2);
});

// ---- The header ----

test('the header names the format and the manifest length', () => {
  assert.equal(headerLine(1234), `${MAGIC} 1234\n`);
  const h = parseHeader(`${MAGIC} 1234\n{"format":...`);
  assert.equal(h.manifestBytes, 1234);
  assert.equal(h.headerBytes, `${MAGIC} 1234`.length + 1);
});

test('anything that is not one of our files is refused', () => {
  assert.equal(parseHeader('PK\u0003\u0004 some zip'), null);
  assert.equal(parseHeader('{"json":true}'), null);
  assert.equal(parseHeader('VHSLIB9 100\n'), null, 'a format we do not speak');
  assert.equal(parseHeader(''), null);
  assert.equal(parseHeader(null), null);
});

test('the header round-trips through its own parser', () => {
  for (const n of [0, 1, 999, 10_000_000]) {
    assert.equal(parseHeader(headerLine(n)).manifestBytes, n);
  }
});

// ---- The file name ----

test('a backup is dated so a pile of them can be ordered', () => {
  assert.equal(backupFileName(new Date(2026, 9, 5)), `vhs-studio-2026-10-05.${BACKUP_EXT}`);
  assert.match(backupFileName(), /^vhs-studio-\d{4}-\d{2}-\d{2}\./);
  assert.match(backupFileName('not a date'), /^vhs-studio-\d{4}/, 'junk still gets a name');
});

// ---- Restoring ----

test('restoring never overwrites a project already in the library', () => {
  // The copy you have been working on wins over the copy in the file.
  const file = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(restorable(file, ['b']).map((p) => p.id), ['a', 'c']);
  assert.deepEqual(restorable(file, ['a', 'b', 'c']), []);
  assert.deepEqual(restorable(file, []).map((p) => p.id), ['a', 'b', 'c']);
});

test('restorable survives junk', () => {
  assert.deepEqual(restorable(null, null), []);
  assert.deepEqual(restorable([{}, { id: '' }], []), [], 'a project with no id is not restorable');
});
