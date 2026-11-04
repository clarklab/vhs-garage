// The cloud copy of the studio library — the pure parts.
//
// The library used to live only in one browser's IndexedDB, which is why the
// phone saw none of it and why it was lost once. Now every device keeps its
// own IndexedDB copy and they meet here:
//
//   manifest        { v: 1, projects: { <id>: { u: updatedAt, d?: deletedAt } } }
//   p/<id>          one project as JSON, every Blob replaced by { $blob: <sha256>, type }
//   f/<sha256>      the image bytes, stored once however many projects use them
//
// Newest updatedAt wins, per project. A push older than what the manifest
// already holds is refused, so a device that was offline can't quietly roll
// back a change made on another one; it pulls instead.
//
// No I/O here. Unit-tested.

import { createHash, timingSafeEqual } from 'node:crypto';

export const LIBRARY_STORE = 'tik-library';
export const MANIFEST_KEY = 'manifest';
export const projectKey = (id) => `p/${id}`;
export const frameKey = (hash) => `f/${hash}`;

export const MAX_PROJECT_BYTES = 2 * 1024 * 1024;   // a project's JSON, blobs already stripped
// A function's request and response each top out around 6MB, and the bytes
// travel as base64 (a third bigger), so every limit here stays under 4.5MB.
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;     // one image (a 1080p JPEG is well under 1MB)
export const MAX_BATCH_BYTES = 4 * 1024 * 1024;     // decoded bytes per putFrames call
export const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;  // decoded bytes per getFrames answer
export const MAX_IDS = 50;
export const MAX_HASHES = 2000;

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const HASH = /^[a-f0-9]{64}$/;
const TYPE = /^image\/(jpeg|png|webp|gif)$/;

export const validId = (id) => typeof id === 'string' && ID.test(id);
export const validHash = (h) => typeof h === 'string' && HASH.test(h);
export const validType = (t) => typeof t === 'string' && TYPE.test(t);

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Constant-time key check. An unset server key never matches anything.
export function keyMatches(given, expected) {
  if (!expected || typeof given !== 'string' || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function emptyManifest() {
  return { v: 1, projects: {} };
}

export function readManifest(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.projects !== 'object' || !raw.projects) return emptyManifest();
  return { v: 1, projects: { ...raw.projects } };
}

// Apply one project push to the manifest.
//   → { ok: true, manifest } or { ok: false, remote } when the cloud is newer.
// Equal timestamps are accepted: the same device re-pushing what it already
// pushed (a retry) must not report a conflict with itself.
export function acceptPush(manifest, id, updatedAt) {
  const cur = manifest.projects[id];
  const at = Number(updatedAt) || 0;
  if (cur) {
    const remote = Math.max(Number(cur.u) || 0, Number(cur.d) || 0);
    if (remote > at) return { ok: false, remote };
  }
  return { ok: true, manifest: { ...manifest, projects: { ...manifest.projects, [id]: { u: at } } } };
}

// Apply one delete. A delete older than the last edit loses: the project was
// changed somewhere after this device deleted it, and the change survives.
export function acceptDelete(manifest, id, deletedAt) {
  const cur = manifest.projects[id];
  const at = Number(deletedAt) || 0;
  if (cur && (Number(cur.u) || 0) > at) return { ok: false, remote: Number(cur.u) };
  return { ok: true, manifest: { ...manifest, projects: { ...manifest.projects, [id]: { u: at, d: at } } } };
}

// Every { $blob } reference inside a stored project, so the server can check
// the images a project points at actually arrived before accepting it.
export function blobRefs(value, out = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return out;
  if (Array.isArray(value)) { for (const v of value) blobRefs(v, out, depth + 1); return out; }
  if (typeof value.$blob === 'string') { out.add(value.$blob); return out; }
  for (const v of Object.values(value)) blobRefs(v, out, depth + 1);
  return out;
}
