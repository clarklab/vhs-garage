// The library, as one file you can keep somewhere that is not a browser.
//
// Everything the studio makes lives in IndexedDB on one origin in one browser
// profile: drafts, statuses, captions, timecodes and the grabbed frames. That
// is fast and private — the movie file never leaves the machine — and it is
// also one cleared-site-data away from nothing at all. There was no way to get
// a copy out. This is that way.
//
// FORMAT — one file, no dependencies, no base64:
//
//   VHSLIB1 <manifestByteLength>\n   magic line, ASCII
//   <manifest JSON>                  projects, with blobs replaced by refs
//   <blob bytes>                     every blob, end to end, in manifest order
//
// Base64 would inflate a 60MB library to 80MB and make the browser hold both
// copies in memory at once. Offsets into a flat byte run cost nothing and are
// trivial to slice back out.
//
// The manifest half is pure and unit-tested; only the two functions at the
// bottom touch Blob or IndexedDB.

export const MAGIC = 'VHSLIB1';
export const BACKUP_EXT = 'vhslib';

// Fields that hold a Blob, by where they live. Slides carry their frame and
// their source frames; the project carries its thumbnail.
const SLIDE_BLOB_KEYS = ['frame', 'thumb'];
const SLIDE_BLOB_LISTS = ['pairFrames', 'mosaicPhotos'];

const isBlobLike = (v) => typeof Blob !== 'undefined' && v instanceof Blob;

// Walk a project, pulling every Blob out into `blobs` and leaving a reference
// behind. Returns the project with refs in place of blobs.
export function stripBlobs(project, blobs) {
  const ref = (blob) => {
    const index = blobs.length;
    blobs.push(blob);
    return { __blob: index, type: blob.type || '', size: blob.size };
  };
  const out = { ...project };
  if (isBlobLike(out.thumb)) out.thumb = ref(out.thumb);
  out.slides = (Array.isArray(project.slides) ? project.slides : []).map((slide) => {
    const s = { ...slide };
    for (const key of SLIDE_BLOB_KEYS) if (isBlobLike(s[key])) s[key] = ref(s[key]);
    for (const key of SLIDE_BLOB_LISTS) {
      if (Array.isArray(s[key])) s[key] = s[key].map((b) => (isBlobLike(b) ? ref(b) : null));
    }
    return s;
  });
  return out;
}

// The reverse: swap every reference back for the blob it points at.
export function restoreBlobs(project, blobs) {
  const get = (r) => {
    const i = r?.__blob;
    return Number.isInteger(i) && blobs[i] ? blobs[i] : null;
  };
  const isRef = (v) => !!v && typeof v === 'object' && Number.isInteger(v.__blob);
  const out = { ...project };
  if (isRef(out.thumb)) out.thumb = get(out.thumb);
  out.slides = (Array.isArray(project.slides) ? project.slides : []).map((slide) => {
    const s = { ...slide };
    for (const key of SLIDE_BLOB_KEYS) if (isRef(s[key])) s[key] = get(s[key]);
    for (const key of SLIDE_BLOB_LISTS) {
      if (Array.isArray(s[key])) s[key] = s[key].map((v) => (isRef(v) ? get(v) : null)).filter(Boolean);
    }
    return s;
  });
  return out;
}

// Byte offsets for a run of blobs laid end to end.
export function blobOffsets(sizes) {
  let at = 0;
  return (Array.isArray(sizes) ? sizes : []).map((n) => {
    const start = at;
    at += Math.max(0, Number(n) || 0);
    return { start, end: at };
  });
}

export function buildManifest(projects, blobSizes, { now = Date.now() } = {}) {
  return {
    format: MAGIC,
    createdAt: now,
    projects,
    blobs: blobOffsets(blobSizes).map((o, i) => ({ ...o, type: '' , index: i })),
  };
}

// "VHSLIB1 1234\n" — the only thing a reader must understand before the JSON.
export function headerLine(manifestBytes) {
  return `${MAGIC} ${Math.max(0, Math.round(Number(manifestBytes) || 0))}\n`;
}

export function parseHeader(text) {
  const line = String(text || '').split('\n', 1)[0];
  const m = line.match(/^(\S+)\s+(\d+)$/);
  if (!m || m[1] !== MAGIC) return null;
  return { magic: m[1], manifestBytes: Number(m[2]), headerBytes: line.length + 1 };
}

// A name for the file. Dated, because a backup you cannot order is a worry.
export function backupFileName(now = new Date()) {
  const d = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `vhs-studio-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.${BACKUP_EXT}`;
}

// Which of these projects the library does not already hold, by id.
export function restorable(projects, existingIds = []) {
  const have = new Set((existingIds || []).map(String));
  return (Array.isArray(projects) ? projects : []).filter((p) => p?.id && !have.has(String(p.id)));
}

// ---- The two halves that touch Blobs ----

// projects (with live Blobs) → one Blob to download.
export function packLibrary(projects, { now = Date.now() } = {}) {
  const blobs = [];
  const stripped = (Array.isArray(projects) ? projects : []).map((p) => stripBlobs(p, blobs));
  const manifest = buildManifest(stripped, blobs.map((b) => b.size), { now });
  manifest.blobs = manifest.blobs.map((b, i) => ({ ...b, type: blobs[i]?.type || '' }));
  const json = new Blob([JSON.stringify(manifest)], { type: 'application/json' });
  // The header has to state the manifest's BYTE length, which is not its
  // character length once anything non-ASCII is in a caption.
  return new Blob([headerLine(json.size), json, ...blobs], { type: 'application/octet-stream' });
}

// The file → projects with their Blobs back.
export async function unpackLibrary(file) {
  if (!file || !file.size) throw new Error('That file is empty.');
  const head = await file.slice(0, 64).text();
  const header = parseHeader(head);
  if (!header) throw new Error('That is not a VHS Studio library file.');
  const manifestEnd = header.headerBytes + header.manifestBytes;
  let manifest;
  try {
    manifest = JSON.parse(await file.slice(header.headerBytes, manifestEnd).text());
  } catch (e) {
    console.error('[tik-backup] manifest would not parse:', e);
    throw new Error('That library file is damaged — its index would not read.');
  }
  const blobs = (manifest.blobs || []).map((b) => file.slice(
    manifestEnd + b.start,
    manifestEnd + b.end,
    b.type || 'application/octet-stream',
  ));
  return (manifest.projects || []).map((p) => restoreBlobs(p, blobs));
}

// ---- Keeping the data ----

// Ask the browser not to throw the library away.
//
// Without this the data is "best effort": Chrome evicts it under storage
// pressure and Safari deletes script-writable storage after seven days without
// a visit. Granted means it survives until it is deleted on purpose.
export async function keepStorage() {
  try {
    if (!navigator.storage?.persist) return 'unsupported';
    if (await navigator.storage.persisted()) return 'granted';
    const ok = await navigator.storage.persist();
    if (!ok) console.warn('[tik-store] the browser would not mark this library as persistent; it can be evicted');
    return ok ? 'granted' : 'denied';
  } catch (e) {
    console.error('[tik-store] could not ask for persistent storage:', e);
    return 'error';
  }
}

export async function storageUsed() {
  try {
    const { usage = 0, quota = 0 } = (await navigator.storage?.estimate?.()) || {};
    return { usage, quota };
  } catch (e) {
    console.warn('[tik-store] storage estimate unavailable:', e);
    return { usage: 0, quota: 0 };
  }
}
