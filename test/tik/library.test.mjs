import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptPush, acceptDelete, blobRefs, keyMatches, readManifest, emptyManifest,
  validId, validHash, validType, sha256Hex, projectKey, frameKey,
} from '../../netlify/functions/lib/library.mjs';

const H = 'a'.repeat(64);

test('a push newer than the cloud copy is taken', () => {
  const m = { v: 1, projects: { x: { u: 100 } } };
  const r = acceptPush(m, 'x', 200);
  assert.equal(r.ok, true);
  assert.deepEqual(r.manifest.projects.x, { u: 200 });
  assert.deepEqual(m.projects.x, { u: 100 }, 'the input manifest is not changed in place');
});

test('a push older than the cloud copy is refused, so an offline device cannot roll a change back', () => {
  const r = acceptPush({ v: 1, projects: { x: { u: 300 } } }, 'x', 200);
  assert.deepEqual(r, { ok: false, remote: 300 });
});

test('the same push twice (a retry) is not a conflict with itself', () => {
  assert.equal(acceptPush({ v: 1, projects: { x: { u: 200 } } }, 'x', 200).ok, true);
});

test('a project deleted elsewhere after this edit stays deleted', () => {
  assert.deepEqual(acceptPush({ v: 1, projects: { x: { u: 100, d: 500 } } }, 'x', 400), { ok: false, remote: 500 });
  const back = acceptPush({ v: 1, projects: { x: { u: 100, d: 500 } } }, 'x', 600);
  assert.equal(back.ok, true, 'an edit made after the delete brings it back');
  assert.deepEqual(back.manifest.projects.x, { u: 600 });
});

test('a brand new project is taken', () => {
  assert.deepEqual(acceptPush(emptyManifest(), 'new', 5).manifest.projects, { new: { u: 5 } });
});

test('a delete loses to an edit made after it', () => {
  assert.deepEqual(acceptDelete({ v: 1, projects: { x: { u: 900 } } }, 'x', 800), { ok: false, remote: 900 });
  const r = acceptDelete({ v: 1, projects: { x: { u: 700 } } }, 'x', 800);
  assert.deepEqual(r.manifest.projects.x, { u: 800, d: 800 });
});

test('blob references are found wherever they sit', () => {
  const rec = {
    thumb: { $blob: H, type: 'image/jpeg' },
    slides: [{ frame: { $blob: 'b'.repeat(64) } }, { pairFrames: [{ $blob: 'c'.repeat(64) }, null] }],
    name: 'x',
  };
  assert.deepEqual([...blobRefs(rec)].sort(), [H, 'b'.repeat(64), 'c'.repeat(64)]);
  assert.equal(blobRefs(null).size, 0);
});

test('the sync key check fails closed', () => {
  assert.equal(keyMatches('abc', 'abc'), true);
  assert.equal(keyMatches('abd', 'abc'), false);
  assert.equal(keyMatches('ab', 'abc'), false);
  assert.equal(keyMatches('', ''), false);
  assert.equal(keyMatches('abc', undefined), false, 'an unset server key never matches');
  assert.equal(keyMatches(undefined, 'abc'), false);
});

test('ids, hashes and types are checked before they become storage keys', () => {
  assert.equal(validId('p-123_abc'), true);
  assert.equal(validId('../manifest'), false);
  assert.equal(validId('a/b'), false);
  assert.equal(validId(''), false);
  assert.equal(validHash(H), true);
  assert.equal(validHash('A'.repeat(64)), false);
  assert.equal(validHash('a'.repeat(63)), false);
  assert.equal(validType('image/jpeg'), true);
  assert.equal(validType('text/html'), false);
  assert.equal(projectKey('x'), 'p/x');
  assert.equal(frameKey(H), `f/${H}`);
});

test('a broken manifest reads as empty rather than throwing', () => {
  assert.deepEqual(readManifest(null), emptyManifest());
  assert.deepEqual(readManifest({ projects: 'nope' }), emptyManifest());
  assert.deepEqual(readManifest({ v: 1, projects: { a: { u: 1 } } }).projects, { a: { u: 1 } });
});

test('sha256 is the hex digest the browser computes', () => {
  assert.equal(sha256Hex(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
