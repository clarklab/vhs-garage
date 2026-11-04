// The cloud copy of the studio library. See lib/library.mjs for the layout.
//
// GET  ?manifest                       → { manifest }
// POST { op: 'getProjects', ids }      → { projects: { id: record | null } }
// POST { op: 'haveFrames', hashes }    → { missing: [hash] }
// POST { op: 'putFrames', frames }     → { stored }       frames: [{ hash, type, data(base64) }]
// POST { op: 'getFrames', hashes }     → { frames: { hash: { type, data } }, more: [hash] }
// POST { op: 'putProjects', records }  → { accepted: [id], conflicts: { id: remoteUpdatedAt }, missingFrames: { id: [hash] } }
// POST { op: 'deleteProjects', items } → { deleted: [id], conflicts: { id: remoteUpdatedAt } }
//
// Every call carries x-tik-key, checked against TIK_SYNC_KEY. Clark is the only
// user, so one shared key per device is the whole account model.
//
// A project's JSON is stored under its own version, p/<id>/<updatedAt>, and the
// manifest is moved to it with a compare-and-swap. A push that loses a race
// therefore never overwrites newer content: its version is simply never pointed
// at, and is cleaned up.
import { getStore } from '@netlify/blobs';
import {
  LIBRARY_STORE, MANIFEST_KEY, projectKey, frameKey,
  MAX_PROJECT_BYTES, MAX_FRAME_BYTES, MAX_BATCH_BYTES, MAX_RESPONSE_BYTES, MAX_IDS, MAX_HASHES,
  validId, validHash, validType, sha256Hex, keyMatches,
  emptyManifest, readManifest, acceptPush, acceptDelete, blobRefs,
} from './lib/library.mjs';

const versionKey = (id, u) => `${projectKey(id)}/${u}`;

export default async (req) => {
  if (!process.env.TIK_SYNC_KEY) {
    console.error('[tik-library] TIK_SYNC_KEY is not set; sync is off');
    return json({ error: 'Library sync is not set up on the server.' }, 503);
  }
  if (!keyMatches(req.headers.get('x-tik-key'), process.env.TIK_SYNC_KEY)) {
    return json({ error: 'This device is not linked to the library.', relink: true }, 401);
  }
  const store = getStore({ name: LIBRARY_STORE, consistency: 'strong' });
  const url = new URL(req.url);

  try {
    if (req.method === 'GET' && url.searchParams.has('manifest')) {
      const raw = await store.get(MANIFEST_KEY, { type: 'json' });
      return json({ manifest: readManifest(raw) });
    }
    if (req.method !== 'POST') return json({ error: 'GET ?manifest or POST an op' }, 405);

    let body;
    try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    switch (body?.op) {
      case 'getProjects': return json(await getProjects(store, body.ids));
      case 'haveFrames': return json(await haveFrames(store, body.hashes));
      case 'putFrames': return json(await putFrames(store, body.frames));
      case 'getFrames': return json(await getFrames(store, body.hashes));
      case 'putProjects': return json(await putProjects(store, body.records));
      case 'deleteProjects': return json(await deleteProjects(store, body.items));
      default: return json({ error: `Unknown op: ${body?.op}` }, 400);
    }
  } catch (e) {
    if (e.status) return json({ error: e.message }, e.status);
    console.error('[tik-library] failed', { op: url.searchParams.toString() || 'post', message: e.message });
    return json({ error: 'Library storage failed — try again.' }, 500);
  }
};

const bad = (message) => Object.assign(new Error(message), { status: 400 });

async function getProjects(store, ids) {
  if (!Array.isArray(ids) || ids.length > MAX_IDS || !ids.every(validId)) throw bad('ids must be up to 50 project ids');
  const manifest = readManifest(await store.get(MANIFEST_KEY, { type: 'json' }));
  const projects = {};
  await Promise.all(ids.map(async (id) => {
    const entry = manifest.projects[id];
    projects[id] = entry && !entry.d ? await store.get(versionKey(id, entry.u), { type: 'json' }) : null;
  }));
  return { projects };
}

// Every stored frame hash. One listing per call is far cheaper than a metadata
// read per hash, and a library has a few thousand frames at most.
async function storedHashes(store) {
  const have = new Set();
  const { blobs } = await store.list({ prefix: 'f/' });
  for (const b of blobs) have.add(b.key.slice(2));
  return have;
}

async function haveFrames(store, hashes) {
  if (!Array.isArray(hashes) || hashes.length > MAX_HASHES || !hashes.every(validHash)) throw bad('hashes must be up to 2000 sha256 hex strings');
  const have = await storedHashes(store);
  return { missing: hashes.filter((h) => !have.has(h)) };
}

async function putFrames(store, frames) {
  if (!Array.isArray(frames) || !frames.length) throw bad('frames must be a non-empty list');
  let total = 0;
  const decoded = frames.map((f) => {
    if (!validHash(f?.hash) || !validType(f?.type) || typeof f?.data !== 'string') throw bad('each frame needs hash, type and base64 data');
    const bytes = Buffer.from(f.data, 'base64');
    if (bytes.length > MAX_FRAME_BYTES) throw bad(`frame ${f.hash.slice(0, 8)} is too large`);
    // The hash is the frame's name everywhere, so it has to be the truth.
    if (sha256Hex(bytes) !== f.hash) throw bad(`frame ${f.hash.slice(0, 8)} does not match its hash`);
    total += bytes.length;
    return { hash: f.hash, type: f.type, bytes };
  });
  if (total > MAX_BATCH_BYTES) throw bad('too many frame bytes in one call');
  await Promise.all(decoded.map((f) => store.set(frameKey(f.hash), f.bytes, { metadata: { type: f.type }, onlyIfNew: true })));
  return { stored: decoded.length };
}

async function getFrames(store, hashes) {
  if (!Array.isArray(hashes) || hashes.length > 200 || !hashes.every(validHash)) throw bad('hashes must be up to 200 sha256 hex strings');
  const frames = {};
  const more = [];
  let total = 0;
  let full = false;
  for (const h of hashes) {
    if (full) { more.push(h); continue; }
    const got = await store.getWithMetadata(frameKey(h), { type: 'arrayBuffer' });
    if (!got) continue;   // missing frames are simply absent from the answer
    // A function's response tops out at 6MB and base64 adds a third, so stop
    // short of the budget rather than after crossing it. The first frame always
    // goes, so a caller can't be stuck asking for one big image forever.
    if (total && total + got.data.byteLength > MAX_RESPONSE_BYTES) { full = true; more.push(h); continue; }
    total += got.data.byteLength;
    frames[h] = { type: got.metadata?.type || 'image/jpeg', data: Buffer.from(got.data).toString('base64') };
  }
  return { frames, more };
}

// Move the manifest forward with compare-and-swap, retrying on a lost race.
// `apply(manifest)` returns the next manifest (or the same one to make no change).
async function updateManifest(store, apply) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await store.getWithMetadata(MANIFEST_KEY, { type: 'json' });
    const manifest = cur ? readManifest(cur.data) : emptyManifest();
    const { next, result } = apply(manifest);
    if (next === manifest) return result;
    const write = cur
      ? await store.setJSON(MANIFEST_KEY, next, { onlyIfMatch: cur.etag })
      : await store.setJSON(MANIFEST_KEY, next, { onlyIfNew: true });
    if (write?.modified !== false) return result;
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 120));
  }
  throw Object.assign(new Error('The library is busy — try again.'), { status: 409 });
}

async function putProjects(store, records) {
  if (!Array.isArray(records) || !records.length || records.length > 25) throw bad('records must be 1–25 projects');
  const have = await storedHashes(store);
  const ready = [];
  const missingFrames = {};
  for (const rec of records) {
    if (!validId(rec?.id) || !Number.isFinite(Number(rec?.updatedAt))) throw bad('each record needs an id and updatedAt');
    const text = JSON.stringify(rec);
    if (text.length > MAX_PROJECT_BYTES) throw bad(`project ${rec.id} is too large`);
    // Refuse a project whose images never arrived: accepting it would hand
    // every other device a set with holes in it.
    const missing = [...blobRefs(rec)].filter((h) => !have.has(h));
    if (missing.length) { missingFrames[rec.id] = missing; continue; }
    ready.push(rec);
  }
  // Write each version first; the manifest only ever points at complete ones.
  await Promise.all(ready.map((rec) => store.setJSON(versionKey(rec.id, Number(rec.updatedAt)), rec)));
  const previous = {};
  const outcome = await updateManifest(store, (manifest) => {
    let next = manifest;
    const accepted = [];
    const conflicts = {};
    for (const rec of ready) {
      const r = acceptPush(next, rec.id, rec.updatedAt);
      if (!r.ok) { conflicts[rec.id] = r.remote; continue; }
      const old = next.projects[rec.id];
      if (old && !old.d && Number(old.u) !== Number(rec.updatedAt)) previous[rec.id] = old.u;
      next = r.manifest;
      accepted.push(rec.id);
    }
    return { next: accepted.length ? next : manifest, result: { accepted, conflicts } };
  });
  // Tidy up: versions nobody points at any more, and the ones that lost.
  const stale = [
    ...Object.entries(previous).filter(([id]) => outcome.accepted.includes(id)).map(([id, u]) => versionKey(id, u)),
    ...ready.filter((r) => !outcome.accepted.includes(r.id)).map((r) => versionKey(r.id, Number(r.updatedAt))),
  ];
  await Promise.all(stale.map((k) => store.delete(k).catch(() => {})));
  return { ...outcome, missingFrames };
}

async function deleteProjects(store, items) {
  if (!Array.isArray(items) || !items.length || items.length > MAX_IDS) throw bad('items must be 1–50 deletions');
  for (const it of items) if (!validId(it?.id) || !Number.isFinite(Number(it?.at))) throw bad('each deletion needs an id and at');
  const gone = {};
  const outcome = await updateManifest(store, (manifest) => {
    let next = manifest;
    const deleted = [];
    const conflicts = {};
    for (const it of items) {
      const old = next.projects[it.id];
      const r = acceptDelete(next, it.id, it.at);
      if (!r.ok) { conflicts[it.id] = r.remote; continue; }
      if (old && !old.d) gone[it.id] = old.u;
      next = r.manifest;
      deleted.push(it.id);
    }
    return { next: deleted.length ? next : manifest, result: { deleted, conflicts } };
  });
  await Promise.all(Object.entries(gone).filter(([id]) => outcome.deleted.includes(id))
    .map(([id, u]) => store.delete(versionKey(id, u)).catch(() => {})));
  return outcome;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
