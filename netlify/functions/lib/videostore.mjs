// Pure helpers for hosting a rendered clip so TikTok's PULL_FROM_URL can fetch
// it. No network, no Blobs API — just the arithmetic and the sniffing.
//
// Why chunks at all: a Netlify function's request body tops out around 6MB, and
// a minute of 1080x1920 is tens of megabytes. The client slices the clip, POSTs
// the pieces one at a time, and the GET streams them back in order as one file.

// MUST MATCH CHUNK_BYTES in public/scripts/tik/publish.js.
export const CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 5 * 1024 * 1024;   // guardrail per request
export const MAX_TOTAL_BYTES = 120 * 1024 * 1024; // guardrail per clip
export const MAX_CHUNKS = Math.ceil(MAX_TOTAL_BYTES / CHUNK_BYTES);

export function chunkCount(bytes, size = CHUNK_BYTES) {
  const n = Math.max(0, Number(bytes) || 0);
  return Math.max(1, Math.ceil(n / size));
}

export function chunkKey(id, index) {
  return `${id}/${index}`;
}

export function manifestKey(id) {
  return `${id}/manifest`;
}

// Upload ids come from the client and become part of a storage key and a public
// URL, so they are whitelisted rather than trusted: a slash or a dot here would
// be a path, not an id.
export function validUploadId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(id);
}

// Container sniffing from the first bytes, because the Content-Type header is
// whatever the caller felt like sending.
//
//   MP4  : 'ftyp' at offset 4, inside the first box.
//   WebM : the EBML magic 1A 45 DF A3 at offset 0.
export function sniffVideoType(head) {
  const b = head instanceof Uint8Array ? head : new Uint8Array(head || []);
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (b.length >= 12) {
    const tag = String.fromCharCode(b[4], b[5], b[6], b[7]);
    if (tag === 'ftyp') return 'video/mp4';
  }
  return null;
}

// "bytes=0-1023" over a known total. Returns null for no/unparseable range
// (serve the whole thing) and 'unsatisfiable' for a range past the end, which
// is a 416 rather than a silent full body.
export function parseRange(header, total) {
  const raw = String(header || '').trim();
  if (!raw) return null;
  const m = raw.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start;
  let end;
  if (a === '') {
    // Suffix range: the LAST n bytes.
    const n = Number(b);
    if (!n) return 'unsatisfiable';
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = Number(a);
    end = b === '' ? total - 1 : Math.min(Number(b), total - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) return 'unsatisfiable';
  return { start, end };
}

// Which stored chunks a byte range touches, and where inside each one.
// Returns [{ index, from, to }] with `to` exclusive, in order.
export function rangeSlices(sizes, start, end) {
  const out = [];
  let offset = 0;
  for (let i = 0; i < sizes.length; i++) {
    const size = Number(sizes[i]) || 0;
    const chunkStart = offset;
    const chunkEnd = offset + size; // exclusive
    offset = chunkEnd;
    if (size === 0) continue;
    if (chunkEnd <= start) continue;      // entirely before the range
    if (chunkStart > end) break;          // past it: nothing further can match
    out.push({
      index: i,
      from: Math.max(0, start - chunkStart),
      to: Math.min(size, end - chunkStart + 1),
    });
  }
  return out;
}

export function totalBytes(sizes) {
  return (Array.isArray(sizes) ? sizes : []).reduce((t, n) => t + (Number(n) || 0), 0);
}

// What a GET/HEAD for a clip should answer: status, headers, and which stored
// chunks to stream. Kept here rather than in the handler so the byte arithmetic
// that a video fetcher depends on can be tested without a Blobs store.
//
// `manifest` is { type, sizes }; a missing one is a 404.
export function clipResponsePlan({ manifest, rangeHeader = null, method = 'GET' } = {}) {
  if (!manifest?.sizes?.length) return { status: 404, headers: {}, slices: [] };
  const total = totalBytes(manifest.sizes);
  const headers = {
    'Content-Type': manifest.type || 'video/mp4',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
  };
  if (method === 'HEAD') {
    return { status: 200, headers: { ...headers, 'Content-Length': String(total) }, slices: [] };
  }
  const range = parseRange(rangeHeader, total);
  if (range === 'unsatisfiable') {
    return { status: 416, headers: { 'Content-Range': `bytes */${total}` }, slices: [] };
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;
  return {
    status: range ? 206 : 200,
    headers: {
      ...headers,
      'Content-Length': String(end - start + 1),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
    },
    slices: rangeSlices(manifest.sizes, start, end),
  };
}
