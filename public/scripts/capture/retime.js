// Timeline stitching across MediaRecorder instances.
//
// Chrome's MediaRecorder dies (renderer CHECK → "Aw, Snap! Error code: 5")
// once a single recorder has emitted ~4 GB — Matt hit it at exactly 4.00 GB
// even with the output already split into small part files. So the recorder
// hands off to a fresh MediaRecorder on the same stream well before that.
//
// Each new recorder starts its own timeline at 0 and emits its own init
// header. To keep the take ONE continuous file, its header is dropped (if
// the codec setup matches — only timestamps/UIDs differ between instances)
// and every fragment's timestamps are shifted to continue where the previous
// recorder's media ended:
//
//   MP4  — rewrite tfdt (base media decode time) in each traf, per track
//          timescale; renumber mfhd so sequence numbers keep climbing.
//   WebM — rewrite each Cluster's Timecode (block times are cluster-relative).
//
// The retimer also tracks where each track's media ends, which is how the
// next recorder's offset is computed.

// --- MP4 ---

function boxes(bytes, start = 0, end = bytes.length) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o);
    let header = 8;
    if (size === 1) { size = Number(dv.getBigUint64(o + 8)); header = 16; }
    if (size === 0) size = end - o;
    if (size < header || o + size > end) break;
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    out.push({ type, start: o, header, end: o + size });
    o += size;
  }
  return out;
}

const child = (bytes, box, type) => boxes(bytes, box.start + box.header, box.end).find(b => b.type === type);
const children = (bytes, box, type) => boxes(bytes, box.start + box.header, box.end).filter(b => b.type === type);
const hex = (u8) => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');

export function parseMp4Init(init) {
  const dv = new DataView(init.buffer, init.byteOffset, init.byteLength);
  const moov = boxes(init).find(b => b.type === 'moov');
  if (!moov) throw new Error('mp4 init has no moov');
  const tracks = {};
  const sig = [];
  for (const trak of children(init, moov, 'trak')) {
    const tkhd = child(init, trak, 'tkhd');
    const mdia = child(init, trak, 'mdia');
    const mdhd = mdia && child(init, mdia, 'mdhd');
    const stbl = mdia && child(init, child(init, mdia, 'minf') || mdia, 'stbl');
    const stsd = stbl && child(init, stbl, 'stsd');
    if (!tkhd || !mdhd) throw new Error('mp4 init track missing tkhd/mdhd');
    const tv = init[tkhd.start + 8];
    const id = dv.getUint32(tkhd.start + 8 + (tv ? 20 : 12));
    const mv = init[mdhd.start + 8];
    const timescale = dv.getUint32(mdhd.start + 8 + (mv ? 20 : 12));
    tracks[id] = { timescale, defaultDuration: 0 };
    sig.push(`${id}:${timescale}:${stsd ? hex(init.subarray(stsd.start, stsd.end)) : ''}`);
  }
  const mvex = child(init, moov, 'mvex');
  for (const trex of mvex ? children(init, mvex, 'trex') : []) {
    const id = dv.getUint32(trex.start + 12);
    if (tracks[id]) tracks[id].defaultDuration = dv.getUint32(trex.start + 20);
  }
  return { tracks, signature: sig.join('|') };
}

// Rewrites a moof box (returns a new Uint8Array; the input is untouched).
// offsets: { [trackId]: ticks to add to tfdt }. Also reports where each
// track's media ends (in ticks, after the shift).
export function retimeMoof(moof, info, offsets, sequence) {
  const out = moof.slice();
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const root = boxes(out)[0];
  if (!root || root.type !== 'moof') throw new Error('not a moof');
  const mfhd = child(out, root, 'mfhd');
  if (mfhd && sequence != null) dv.setUint32(mfhd.start + 12, sequence);
  const ends = {};
  for (const traf of children(out, root, 'traf')) {
    const tfhd = child(out, traf, 'tfhd');
    const tfdt = child(out, traf, 'tfdt');
    if (!tfhd || !tfdt) throw new Error('traf missing tfhd/tfdt');
    const tfhdFlags = dv.getUint32(tfhd.start + 8) & 0xffffff;
    const id = dv.getUint32(tfhd.start + 12);
    let defDur = info.tracks[id]?.defaultDuration || 0;
    if (tfhdFlags & 0x08) {
      let p = tfhd.start + 16;
      if (tfhdFlags & 0x01) p += 8;
      if (tfhdFlags & 0x02) p += 4;
      defDur = dv.getUint32(p);
    }
    const v1 = out[tfdt.start + 8] === 1;
    let t = v1 ? dv.getBigUint64(tfdt.start + 12) : BigInt(dv.getUint32(tfdt.start + 12));
    t += BigInt(offsets[id] || 0);
    if (v1) dv.setBigUint64(tfdt.start + 12, t);
    else {
      if (t > 0xffffffffn) throw new Error('tfdt v0 overflow');
      dv.setUint32(tfdt.start + 12, Number(t));
    }
    let dur = 0;
    for (const trun of children(out, traf, 'trun')) {
      const flags = dv.getUint32(trun.start + 8) & 0xffffff;
      const count = dv.getUint32(trun.start + 12);
      let p = trun.start + 16;
      if (flags & 0x001) p += 4;
      if (flags & 0x004) p += 4;
      for (let i = 0; i < count; i++) {
        if (flags & 0x100) { dur += dv.getUint32(p); p += 4; } else dur += defDur;
        if (flags & 0x200) p += 4;
        if (flags & 0x400) p += 4;
        if (flags & 0x800) p += 4;
      }
    }
    ends[id] = Number(t) + dur;
  }
  return { bytes: out, ends };
}

// --- WebM ---

function readVint(p, o, keepMarker) {
  const first = p[o];
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) { length++; mask >>= 1; }
  if (length > 8 || o + length > p.length) throw new Error('webm: bad vint');
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + p[o + i];
    if (p[o + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function* ebml(p, start, end) {
  let o = start;
  while (o < end) {
    const id = readVint(p, o, true);
    const size = readVint(p, o + id.length, false);
    const dataStart = o + id.length + size.length;
    const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value);
    yield { id: id.value, start: o, dataStart, dataEnd, unknown: size.unknown };
    if (size.unknown) return;
    o = dataEnd;
  }
}

const EBML_MASTERS = new Set([0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0, 0xe1]);
// Random / wall-clock fields that legitimately differ between recorders.
const EBML_VOLATILE = new Set([0x73c5 /* TrackUID */, 0x4461 /* DateUTC */, 0x73a4 /* SegmentUID */]);

export function parseWebmInit(init) {
  const sig = [];
  const walk = (s, e) => {
    for (const el of ebml(init, s, e)) {
      if (EBML_MASTERS.has(el.id)) { sig.push(el.id.toString(16) + '{'); walk(el.dataStart, el.dataEnd); sig.push('}'); }
      else if (!EBML_VOLATILE.has(el.id)) sig.push(`${el.id.toString(16)}=${hex(init.subarray(el.dataStart, el.dataEnd))}`);
    }
  };
  walk(0, init.length);
  return { signature: sig.join(' ') };
}

function encodeTimecodeElement(value) {
  const out = new Uint8Array(10);
  out[0] = 0xe7;
  out[1] = 0x88; // 8-byte size
  new DataView(out.buffer).setBigUint64(2, BigInt(value));
  return out;
}

function readUint(p, s, e) {
  let v = 0;
  for (let i = s; i < e; i++) v = v * 256 + p[i];
  return v;
}

// Block header: track vint, int16 timecode relative to the cluster.
function blockTime(p, dataStart) {
  const track = readVint(p, dataStart, false);
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  return { track: track.value, rel: dv.getInt16(dataStart + track.length) };
}

// --- Retimer: one per MediaRecorder instance ---

export function createRetimer(container, info, offsetSec, sequenceBase = 0) {
  const ends = {}; // track → end time in seconds (output timeline)
  if (container === 'mp4') {
    const offsets = {};
    for (const [id, t] of Object.entries(info.tracks)) offsets[id] = Math.round(offsetSec * t.timescale);
    let seq = sequenceBase;
    return {
      process(unit) {
        const type = unit.bytes.length >= 8 ? String.fromCharCode(...unit.bytes.subarray(4, 8)) : '';
        if (type !== 'moof') return unit;
        seq++;
        const r = retimeMoof(unit.bytes, info, offsets, seq);
        for (const [id, end] of Object.entries(r.ends)) {
          ends[id] = Math.max(ends[id] || 0, end / info.tracks[id].timescale);
        }
        return { ...unit, bytes: r.bytes };
      },
      endSec: () => Math.max(offsetSec, ...Object.values(ends)),
      sequence: () => seq,
    };
  }

  // WebM. Timecodes are in TimecodeScale units — Chrome uses the default 1 ms.
  const offsetMs = Math.round(offsetSec * 1000);
  let clusterTc = 0;
  const last = {}; // track → { t, step }
  const seeBlock = (p, dataStart) => {
    const { track, rel } = blockTime(p, dataStart);
    const t = clusterTc + rel;
    const prev = last[track];
    last[track] = { t, step: prev && t > prev.t ? t - prev.t : prev?.step || 0 };
  };
  return {
    process(unit) {
      const p = unit.bytes;
      const el = ebml(p, 0, p.length).next().value;
      if (!el) return unit;
      if (el.id === 0xe7) {
        clusterTc = readUint(p, el.dataStart, el.dataEnd) + offsetMs;
        return { ...unit, bytes: encodeTimecodeElement(clusterTc) };
      }
      if (el.id === 0xa3) seeBlock(p, el.dataStart);
      if (el.id === 0xa0) {
        const block = [...ebml(p, el.dataStart, el.dataEnd)].find(c => c.id === 0xa1);
        if (block) seeBlock(p, block.dataStart);
      }
      if (el.id === 0x1f43b675 && !el.unknown) {
        // Known-size cluster arrives whole: patch its Timecode in place.
        const tc = [...ebml(p, el.dataStart, el.dataEnd)].find(c => c.id === 0xe7);
        if (!tc) return unit;
        const out = p.slice();
        let v = readUint(p, tc.dataStart, tc.dataEnd) + offsetMs;
        clusterTc = v;
        for (let i = tc.dataEnd - 1; i >= tc.dataStart; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
        if (v > 0) throw new Error('webm cluster timecode overflow');
        for (const c of ebml(out, el.dataStart, el.dataEnd)) {
          if (c.id === 0xa3) seeBlock(out, c.dataStart);
        }
        return { ...unit, bytes: out };
      }
      return unit;
    },
    endSec: () => {
      const trackEnds = Object.values(last).map(({ t, step }) => (t + step) / 1000);
      return Math.max(offsetSec, ...trackEnds);
    },
    sequence: () => 0,
  };
}

export function parseInit(container, initBytes) {
  return container === 'mp4' ? parseMp4Init(initBytes) : parseWebmInit(initBytes);
}
