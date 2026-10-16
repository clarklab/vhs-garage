// Container-aware splitter for MediaRecorder output.
//
// Why this exists: a single FileSystemWritableFileStream only lands on disk
// when close() runs — until then Chrome writes into a hidden .crswap file and
// throws it away if the tab dies. A 2-hour capture that crashed at 1:45 lost
// everything. Instead the recorder writes a series of part files, closing
// (= committing) each one every few minutes, and joins them on stop.
//
// To make that gapless, we never restart the MediaRecorder. We cut its one
// continuous byte stream at container boundaries instead:
//
//   MP4  (Chrome emits fragmented MP4: ftyp, moov, then moof+mdat pairs with
//         64-bit absolute tfdt timestamps) → cut before any `moof`.
//   WebM (EBML header, unknown-size Segment, Info, Tracks, then unknown-size
//         Clusters with absolute timecodes) → cut before any Cluster.
//
// Every part starts with the init bytes (ftyp+moov / EBML+Segment+Info+Tracks)
// so each part is a playable file on its own, and joining is plain byte
// concatenation: part 1 + (each later part minus its init) is byte-identical
// to what one long writable would have produced.
//
// push() returns units: { bytes, init, cut }. `init` units belong to the
// header every part repeats; `cut` units are safe places to start a new part.
// If the stream ever stops parsing (unexpected structure, absurd sizes), the
// splitter flips to passthrough — bytes keep flowing as non-cut units, the
// recording just stops rotating. Never worse than the old single-file path.

const MAX_UNIT_BYTES = 512 * 1024 * 1024;

function concat(a, b) {
  if (!a || a.length === 0) return b;
  if (!b || b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

class BaseSplitter {
  constructor() {
    this.pending = new Uint8Array(0);
    this.failed = false;
    this.failReason = null;
    this.sawMedia = false;
  }

  push(chunk) {
    if (this.failed) return chunk.length ? [{ bytes: chunk, init: false, cut: false }] : [];
    this.pending = concat(this.pending, chunk);
    const units = [];
    try {
      this.parse(units);
    } catch (err) {
      this.fail(err.message, units);
    }
    return units;
  }

  // Remaining unparsed bytes at end of stream (normally empty).
  flush() {
    const rest = this.pending;
    this.pending = new Uint8Array(0);
    return rest.length ? [{ bytes: rest, init: false, cut: false }] : [];
  }

  fail(reason, units) {
    this.failed = true;
    this.failReason = reason;
    if (this.pending.length) units.push({ bytes: this.pending, init: false, cut: false });
    this.pending = new Uint8Array(0);
  }

  take(n) {
    const bytes = this.pending.subarray(0, n);
    this.pending = this.pending.subarray(n);
    return bytes;
  }
}

class Mp4Splitter extends BaseSplitter {
  parse(units) {
    const INIT_TYPES = new Set(['ftyp', 'moov']);
    while (this.pending.length >= 8) {
      const p = this.pending;
      const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
      let size = dv.getUint32(0);
      const type = String.fromCharCode(p[4], p[5], p[6], p[7]);
      let header = 8;
      if (size === 1) {
        if (p.length < 16) return;
        size = Number(dv.getBigUint64(8));
        header = 16;
      }
      if (size === 0) throw new Error(`mp4 box "${type}" has open-ended size`);
      if (size < header || size > MAX_UNIT_BYTES) throw new Error(`mp4 box "${type}" has bad size ${size}`);
      if (p.length < size) return;
      const init = !this.sawMedia && INIT_TYPES.has(type);
      if (!init) this.sawMedia = true;
      units.push({ bytes: this.take(size), init, cut: type === 'moof' });
    }
  }
}

// EBML IDs we care about.
const EBML_HEADER = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const CLUSTER = 0x1f43b675;
const CLUSTER_CHILDREN = new Set([
  0xe7, // Timecode
  0xa7, // Position
  0xab, // PrevSize
  0xa3, // SimpleBlock
  0xa0, // BlockGroup
  0xaf, // EncryptedBlock
  0xec, // Void
  0xbf, // CRC-32
]);

// Returns { value, length, unknown } or null when more bytes are needed.
function readVint(p, o, keepMarker) {
  if (o >= p.length) return null;
  const first = p[o];
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) { length++; mask >>= 1; }
  if (length > 8) throw new Error('webm: invalid vint');
  if (o + length > p.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + p[o + i];
    if (p[o + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

class WebmSplitter extends BaseSplitter {
  constructor() {
    super();
    this.inSegment = false;
    this.inCluster = false;
  }

  parse(units) {
    while (this.pending.length) {
      const p = this.pending;
      const id = readVint(p, 0, true);
      if (!id) return;
      if (id.length > 4) throw new Error('webm: element id too long');
      const size = readVint(p, id.length, false);
      if (!size) return;
      const header = id.length + size.length;

      if (!this.inSegment) {
        if (id.value === SEGMENT) {
          // Emit only the Segment header; its children stream after it.
          this.inSegment = true;
          units.push({ bytes: this.take(header), init: true, cut: false });
          continue;
        }
        if (id.value !== EBML_HEADER) throw new Error(`webm: unexpected top-level id ${id.value.toString(16)}`);
      }

      if (this.inCluster && !CLUSTER_CHILDREN.has(id.value)) this.inCluster = false;

      if (id.value === CLUSTER) {
        this.sawMedia = true;
        if (size.unknown) {
          this.inCluster = true;
          units.push({ bytes: this.take(header), init: false, cut: true });
          continue;
        }
        // Known-size cluster: hold the whole thing as one unit.
        const total = header + size.value;
        if (total > MAX_UNIT_BYTES) throw new Error(`webm: cluster too large (${total})`);
        if (p.length < total) return;
        units.push({ bytes: this.take(total), init: false, cut: true });
        continue;
      }

      if (size.unknown) throw new Error(`webm: unknown-size element ${id.value.toString(16)}`);
      const total = header + size.value;
      if (total > MAX_UNIT_BYTES) throw new Error(`webm: element too large (${total})`);
      if (p.length < total) return;
      units.push({ bytes: this.take(total), init: !this.sawMedia, cut: false });
    }
  }
}

export function createSplitter(container) {
  return container === 'mp4' ? new Mp4Splitter() : new WebmSplitter();
}
