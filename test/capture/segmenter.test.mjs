import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSplitter } from '../../public/scripts/capture/segmenter.js';

function box(type, payloadLen, fill = 0) {
  const b = new Uint8Array(8 + payloadLen).fill(fill);
  new DataView(b.buffer).setUint32(0, b.length);
  b.set([...type].map(c => c.charCodeAt(0)), 4);
  return b;
}

function cat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Feed `stream` in random-sized chunks, rotate to a new part at every cut
// after the first, and return the parts plus the init length.
function splitIntoParts(container, stream, seed = 1) {
  const splitter = createSplitter(container);
  let rnd = seed;
  const next = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648);
  const init = [];
  const parts = [[]];
  let sawCut = false;
  const handle = (unit) => {
    if (unit.init) init.push(unit.bytes);
    if (unit.cut) {
      if (sawCut) parts.push([...init]);
      sawCut = true;
    }
    parts[parts.length - 1].push(unit.bytes);
  };
  for (let o = 0; o < stream.length;) {
    const n = 1 + (next() % 5000);
    for (const u of splitter.push(stream.slice(o, o + n))) handle(u);
    o += n;
  }
  for (const u of splitter.flush()) handle(u);
  return { parts: parts.map(p => cat(...p)), initLen: cat(...init).length, splitter };
}

function join(parts, initLen) {
  return cat(parts[0], ...parts.slice(1).map(p => p.subarray(initLen)));
}

test('mp4: cuts before each moof and rejoins byte-identically', () => {
  const init = cat(box('ftyp', 28, 1), box('moov', 1173, 2));
  const frags = [];
  for (let i = 0; i < 6; i++) frags.push(box('moof', 540, 10 + i), box('mdat', 20000 + i * 977, 20 + i));
  const stream = cat(init, ...frags);

  for (const seed of [1, 7, 42]) {
    const { parts, initLen, splitter } = splitIntoParts('mp4', stream, seed);
    assert.equal(splitter.failed, false);
    assert.equal(initLen, init.length);
    assert.equal(parts.length, 6);
    for (const p of parts) assert.deepEqual(p.subarray(0, initLen), init, 'every part starts with the init header');
    assert.deepEqual(join(parts, initLen), stream);
  }
});

test('mp4: handles 64-bit largesize boxes', () => {
  const big = new Uint8Array(16 + 100).fill(5);
  const dv = new DataView(big.buffer);
  dv.setUint32(0, 1);
  big.set([...'mdat'].map(c => c.charCodeAt(0)), 4);
  dv.setBigUint64(8, BigInt(big.length));
  const stream = cat(box('ftyp', 8), box('moov', 40), box('moof', 20), big);
  const { parts, initLen } = splitIntoParts('mp4', stream);
  assert.deepEqual(join(parts, initLen), stream);
});

test('mp4: garbage flips to passthrough without losing bytes', () => {
  const stream = cat(box('ftyp', 8), box('moov', 40), new Uint8Array([0, 0, 0, 3, 1, 2, 3, 4, 9, 9, 9]));
  const { parts, splitter } = splitIntoParts('mp4', stream);
  assert.equal(splitter.failed, true);
  assert.deepEqual(cat(...parts), stream);
});

// --- WebM ---

function vintSize(n) {
  // 8-byte size vint so tests don't need size-class logic.
  const b = new Uint8Array(8);
  b[0] = 0x01;
  for (let i = 7, v = n; i >= 1; i--, v = Math.floor(v / 256)) b[i] = v & 0xff;
  return b;
}
const UNKNOWN = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
function el(idBytes, payload) { return cat(new Uint8Array(idBytes), vintSize(payload.length), payload); }

test('webm: cuts before each unknown-size cluster and rejoins byte-identically', () => {
  const ebml = el([0x1a, 0x45, 0xdf, 0xa3], new Uint8Array(23).fill(1));
  const segHead = cat(new Uint8Array([0x18, 0x53, 0x80, 0x67]), UNKNOWN);
  const info = el([0x15, 0x49, 0xa9, 0x66], new Uint8Array(17).fill(2));
  const tracks = el([0x16, 0x54, 0xae, 0x6b], new Uint8Array(97).fill(3));
  const init = cat(ebml, segHead, info, tracks);
  const clusters = [];
  for (let i = 0; i < 5; i++) {
    clusters.push(
      cat(new Uint8Array([0x1f, 0x43, 0xb6, 0x75]), UNKNOWN),
      el([0xe7], new Uint8Array([i])),
      el([0xa3], new Uint8Array(900 + i).fill(4)),
      el([0xa0], new Uint8Array(3000 + i * 13).fill(5)),
    );
  }
  const stream = cat(init, ...clusters);

  for (const seed of [3, 11]) {
    const { parts, initLen, splitter } = splitIntoParts('webm', stream, seed);
    assert.equal(splitter.failed, false, splitter.failReason);
    assert.equal(initLen, init.length);
    assert.equal(parts.length, 5);
    for (const p of parts) assert.deepEqual(p.subarray(0, initLen), init);
    assert.deepEqual(join(parts, initLen), stream);
  }
});

test('webm: segment-level element after a cluster closes the cluster', () => {
  const init = cat(el([0x1a, 0x45, 0xdf, 0xa3], new Uint8Array(4)), new Uint8Array([0x18, 0x53, 0x80, 0x67]), UNKNOWN, el([0x16, 0x54, 0xae, 0x6b], new Uint8Array(10)));
  const stream = cat(
    init,
    new Uint8Array([0x1f, 0x43, 0xb6, 0x75]), UNKNOWN, el([0xa3], new Uint8Array(50)),
    el([0x1c, 0x53, 0xbb, 0x6b], new Uint8Array(30)), // Cues
    new Uint8Array([0x1f, 0x43, 0xb6, 0x75]), UNKNOWN, el([0xa3], new Uint8Array(50)),
  );
  const { parts, initLen, splitter } = splitIntoParts('webm', stream);
  assert.equal(splitter.failed, false, splitter.failReason);
  assert.equal(parts.length, 2);
  assert.deepEqual(join(parts, initLen), stream);
});
