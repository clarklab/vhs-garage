import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMp4Init, retimeMoof, createRetimer, parseWebmInit } from '../../public/scripts/capture/retime.js';

function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; }
function u64(n) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; }
function cat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function box(type, ...payload) {
  const body = cat(...payload);
  return cat(u32(body.length + 8), new TextEncoder().encode(type), body);
}
const full = (v, flags) => cat(new Uint8Array([v]), u32(flags).subarray(1));

// Minimal Chrome-shaped init: two tracks with v1 tkhd/mdhd, stsd, trex.
function init({ stsdByte = 7, created = 0 } = {}) {
  const trak = (id, timescale) => box('trak',
    box('tkhd', full(1, 3), u64(created), u64(created), u32(id), u32(0), u64(0), new Uint8Array(52)),
    box('mdia',
      box('mdhd', full(1, 0), u64(created), u64(created), u32(timescale), u64(0), u32(0)),
      box('minf', box('stbl', box('stsd', full(0, 0), u32(1), new Uint8Array([stsdByte, id]))))));
  return cat(
    box('ftyp', new TextEncoder().encode('isom'), u32(0)),
    box('moov',
      box('mvhd', full(1, 0), u64(created), u64(created), u32(1000), u64(0), new Uint8Array(80)),
      trak(1, 30000), trak(2, 48000),
      box('mvex', box('trex', full(0, 0), u32(1), u32(1), u32(0), u32(0), u32(0)), box('trex', full(0, 0), u32(2), u32(1), u32(960), u32(0), u32(0)))));
}

// moof with per-sample durations for video (0x100) and trex defaults for audio.
function moof(seq, vt, at) {
  const trafV = box('traf', box('tfhd', full(0, 0x20000), u32(1)), box('tfdt', full(1, 0), u64(vt)),
    box('trun', full(0, 0x301), u32(3), u32(0), u32(1001), u32(10), u32(1001), u32(10), u32(1001), u32(10)));
  const trafA = box('traf', box('tfhd', full(0, 0x20000), u32(2)), box('tfdt', full(1, 0), u64(at)),
    box('trun', full(0, 0x201), u32(2), u32(0), u32(10), u32(10)));
  return box('moof', box('mfhd', full(0, 0), u32(seq)), trafV, trafA);
}
const readTfdt = (m, track) => {
  const dv = new DataView(m.buffer, m.byteOffset);
  for (let i = 0; i < m.length - 16; i++) {
    if (String.fromCharCode(...m.subarray(i + 4, i + 8)) === 'tfhd' && dv.getUint32(i + 12) === track) {
      return Number(dv.getBigUint64(i + dv.getUint32(i) + 12));
    }
  }
};

test('mp4 init: signature ignores timestamps but not codec config', () => {
  const a = parseMp4Init(init({ created: 111 }));
  const b = parseMp4Init(init({ created: 999 }));
  const c = parseMp4Init(init({ stsdByte: 8 }));
  assert.equal(a.signature, b.signature);
  assert.notEqual(a.signature, c.signature);
  assert.deepEqual(a.tracks, { 1: { timescale: 30000, defaultDuration: 0 }, 2: { timescale: 48000, defaultDuration: 960 } });
});

test('mp4 moof: shifts tfdt per track and reports track ends', () => {
  const info = parseMp4Init(init());
  const { bytes, ends } = retimeMoof(moof(1, 0, 0), info, { 1: 300000, 2: 480000 }, 42);
  assert.equal(readTfdt(bytes, 1), 300000);
  assert.equal(readTfdt(bytes, 2), 480000);
  assert.equal(ends[1], 300000 + 3003);
  assert.equal(ends[2], 480000 + 1920); // trex default 960 × 2
  assert.equal(new DataView(bytes.buffer).getUint32(20), 42, 'mfhd sequence rewritten');
});

test('retimer: second recorder continues where the first ended', () => {
  const info = parseMp4Init(init());
  const first = createRetimer('mp4', info, 0, 0);
  first.process({ bytes: moof(1, 0, 0), cut: true });
  first.process({ bytes: moof(2, 3003, 1920), cut: true });
  const end = first.endSec();
  assert.ok(Math.abs(end - 6006 / 30000) < 1e-9, 'end is the later of the two tracks (video here)');

  const second = createRetimer('mp4', info, end, first.sequence());
  const out = second.process({ bytes: moof(1, 0, 0), cut: true }).bytes;
  assert.equal(readTfdt(out, 1), Math.round(end * 30000));
  assert.equal(readTfdt(out, 2), Math.round(end * 48000));
  assert.equal(new DataView(out.buffer).getUint32(20), 3, 'sequence numbers keep climbing');
});

// --- WebM ---

const vsize = (n) => cat(new Uint8Array([0x01]), u64(n).subarray(1));
const el = (id, payload) => cat(new Uint8Array(id), vsize(payload.length), payload);

test('webm init: signature ignores TrackUID width and value', () => {
  const mk = (uid) => cat(
    el([0x1a, 0x45, 0xdf, 0xa3], new Uint8Array([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d])),
    new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    el([0x16, 0x54, 0xae, 0x6b], el([0xae], cat(el([0xd7], new Uint8Array([1])), el([0x73, 0xc5], uid), el([0x86], new TextEncoder().encode('V_VP9'))))),
  );
  assert.equal(parseWebmInit(mk(new Uint8Array([1, 2, 3, 4, 5, 6, 7]))).signature, parseWebmInit(mk(new Uint8Array([9, 9, 9, 9, 9, 9]))).signature);
});

test('webm retimer: offsets cluster timecodes and tracks block ends', () => {
  const tc = (v) => ({ bytes: el([0xe7], new Uint8Array([v >> 8, v & 0xff])), cut: false });
  const block = (track, rel) => ({ bytes: el([0xa3], new Uint8Array([0x80 | track, rel >> 8, rel & 0xff, 0x80, 0])), cut: false });
  const first = createRetimer('webm', {}, 0);
  first.process(tc(0));
  first.process(block(1, 0));
  first.process(block(1, 33));
  first.process(block(2, 20));
  assert.equal(first.endSec(), 0.066, 'last video block + one frame step');

  const second = createRetimer('webm', {}, first.endSec());
  const out = second.process(tc(0)).bytes;
  assert.equal(out[0], 0xe7);
  assert.equal(Number(new DataView(out.buffer).getBigUint64(2)), 66);
});
