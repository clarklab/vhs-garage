// Library sync, browser side. Keeps this device's IndexedDB library and the
// cloud copy (netlify/functions/tik-library.mjs) in step, so the phone sees
// everything the desk made and the desk sees what the phone posted.
//
// - Every local save or delete is queued and pushed a moment later.
// - A full sync (pull what's newer there, push what's newer here) runs on load,
//   when the tab comes back, and every few minutes while it's open.
// - Pulled projects arrive with their cover thumb but not their slide frames;
//   those are fetched the first time the project is opened (hydrateRecord),
//   so a phone doesn't download every frame of every post up front.
//
// The device is linked by a key (localStorage), set once from a link the desk
// shows: /tik/?link=<key>.

import { listProjects, getProject, putProject, deleteProject, onLibraryChange } from './store.js';
import { dehydrate, rehydrate, placeholderHashes, planSync, chunk, chunkBySize } from './syncwire.js';

const API = '/.netlify/functions/tik-library';
const LS_KEY = 'tik_sync_key';
const LS_TOMBS = 'tik_sync_tombstones';
const LS_LAST = 'tik_sync_last';
const PUSH_DELAY_MS = 2500;
const RESYNC_MS = 3 * 60 * 1000;
const FRAME_BATCH_BYTES = 3 * 1024 * 1024;   // decoded; base64 adds a third

const ls = {
  get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { console.warn('[tik-sync] could not save', k, e); } },
  del(k) { try { localStorage.removeItem(k); } catch { /* fine */ } },
};

// ---- linking ----

export const syncKey = () => ls.get(LS_KEY, '');
export const isLinked = () => !!syncKey();
export function setSyncKey(key) {
  const k = String(key || '').trim();
  if (k) ls.set(LS_KEY, k); else ls.del(LS_KEY);
}
export function phoneLink() {
  const k = syncKey();
  return k ? `${location.origin}/tik/?link=${encodeURIComponent(k)}` : '';
}
// A link opened on a new device: keep the key, drop it from the address bar.
export function captureLinkFromUrl() {
  const params = new URLSearchParams(location.search);
  const k = params.get('link');
  if (!k) return false;
  setSyncKey(k);
  params.delete('link');
  const qs = params.toString();
  history.replaceState({}, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
  return true;
}

// ---- status ----

let status = { state: 'off', detail: '', at: Number(ls.get(LS_LAST, 0)) || 0 };
const statusListeners = new Set();
export function onSyncStatus(fn) { statusListeners.add(fn); fn(status); return () => statusListeners.delete(fn); }
export const syncStatus = () => status;
function setStatus(state, detail = '') {
  status = { state, detail, at: state === 'idle' ? Date.now() : status.at };
  if (state === 'idle') ls.set(LS_LAST, String(status.at));
  for (const fn of statusListeners) { try { fn(status); } catch (e) { console.error('[tik-sync] status listener failed:', e); } }
}

// ---- wire ----

async function api(body, { method = 'POST', query = '' } = {}) {
  const res = await fetch(`${API}${query}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-tik-key': syncKey() },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    setStatus('unlinked', data.error || 'This device is not linked to the library.');
    throw Object.assign(new Error(data.error || 'Not linked'), { unlinked: true });
  }
  if (!res.ok) throw new Error(data.error || `Library sync failed (${res.status})`);
  return data;
}

export async function hashBlob(blob) {
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

// Fetch frames by hash. → Map<hash, Blob>
async function fetchFrames(hashes) {
  const out = new Map();
  let todo = [...new Set(hashes)];
  while (todo.length) {
    const ask = todo.slice(0, 200);
    const rest = todo.slice(200);
    const { frames = {}, more = [] } = await api({ op: 'getFrames', hashes: ask });
    for (const [h, f] of Object.entries(frames)) out.set(h, base64ToBlob(f.data, f.type));
    // `more` = over this call's size budget, asked again next time. The server
    // always answers at least the first, so this always moves forward. A hash
    // in neither list no longer exists, and stays missing.
    if (more.length >= ask.length) throw new Error('The cloud library would not send a frame.');
    todo = [...more, ...rest];
  }
  return out;
}

// Upload whichever of these blobs the cloud doesn't already have.
async function uploadFrames(blobs) {
  if (!blobs.size) return;
  const { missing } = await api({ op: 'haveFrames', hashes: [...blobs.keys()] });
  const items = (missing || []).map((h) => ({ hash: h, blob: blobs.get(h) })).filter((x) => x.blob);
  for (const run of chunkBySize(items, (x) => x.blob.size, FRAME_BATCH_BYTES)) {
    const frames = await Promise.all(run.map(async (x) => ({ hash: x.hash, type: x.blob.type || 'image/jpeg', data: await blobToBase64(x.blob) })));
    await api({ op: 'putFrames', frames });
  }
}

// ---- push ----

const tombstones = () => { try { return JSON.parse(ls.get(LS_TOMBS, '{}')) || {}; } catch { return {}; } };
const saveTombstones = (t) => ls.set(LS_TOMBS, JSON.stringify(t));

// Push these projects. → ids the cloud refused because it holds something newer.
async function pushIds(ids, onProgress = () => {}) {
  const conflicts = [];
  let done = 0;
  for (const run of chunk(ids, 8)) {
    const records = [];
    const blobs = new Map();
    for (const id of run) {
      const rec = await getProject(id);
      if (!rec) continue;
      const wire = await dehydrate(rec, hashBlob);
      wire.blobs.forEach((b, h) => blobs.set(h, b));
      records.push({ ...wire.record, updatedAt: rec.updatedAt || 0 });
    }
    await uploadFrames(blobs);
    if (records.length) {
      const res = await api({ op: 'putProjects', records });
      conflicts.push(...Object.keys(res.conflicts || {}));
      const holes = Object.keys(res.missingFrames || {});
      // Placeholders this device never filled in (a project it pulled and never
      // opened) still exist in the cloud; anything else missing is a real fault.
      if (holes.length) console.warn('[tik-sync] cloud refused projects with missing frames', res.missingFrames);
    }
    done += run.length;
    onProgress(done, ids.length);
  }
  return conflicts;
}

async function pushDeletes(items) {
  if (!items.length) return;
  for (const run of chunk(items, 50)) await api({ op: 'deleteProjects', items: run });
  const t = tombstones();
  for (const it of items) delete t[it.id];
  saveTombstones(t);
}

// ---- pull ----

// Bring these projects down. Covers are fetched now; slide frames are reused
// from this device's own copy when it has the same image, and otherwise left
// as placeholders until the project is opened.
async function pullIds(ids, onProgress = () => {}) {
  let done = 0;
  for (const run of chunk(ids, 25)) {
    const { projects } = await api({ op: 'getProjects', ids: run });
    const want = [];
    const fresh = [];
    for (const id of run) {
      const rec = projects?.[id];
      if (!rec) continue;
      const old = await getProject(id);
      const mine = old ? (await dehydrate(old, hashBlob)).blobs : new Map();
      const filled = rehydrate(rec, mine);
      if (filled.thumb && filled.thumb.$blob) want.push(filled.thumb.$blob);
      fresh.push(filled);
    }
    const thumbs = await fetchFrames(want);
    for (const rec of fresh) {
      const done1 = rehydrate(rec, thumbs);
      if (done1.thumb && done1.thumb.$blob) done1.thumb = null;   // never leave a placeholder where the grid expects a Blob
      await putProject(done1, { silent: true });
    }
    done += run.length;
    onProgress(done, ids.length);
  }
}

// Fill in a pulled project's remaining placeholders before it is opened or
// published. Writes the result back so it only happens once per device.
export async function hydrateRecord(rec) {
  const missing = [...placeholderHashes(rec)];
  if (!missing.length) return rec;
  if (!isLinked()) throw new Error('This set\'s frames are in the cloud library, and this device is not linked to it.');
  const got = await fetchFrames(missing);
  const filled = rehydrate(rec, got);
  const left = placeholderHashes(filled).size;
  if (left) throw new Error(`${left} frame${left === 1 ? '' : 's'} for this set could not be downloaded — try again.`);
  await putProject(filled, { silent: true });
  return filled;
}

// ---- the loop ----

let running = null;
let onRemote = () => {};

export function fullSync() {
  if (!isLinked()) { setStatus('off'); return Promise.resolve(); }
  if (running) return running;
  running = (async () => {
    try {
      setStatus('syncing', 'Checking the cloud library…');
      const { manifest } = await api(null, { method: 'GET', query: '?manifest' });
      const local = (await listProjects()).map((p) => ({ id: p.id, updatedAt: p.updatedAt || 0 }));
      const plan = planSync(manifest, local, tombstones());
      await pushDeletes(plan.pushDeletes);
      for (const id of plan.deleteLocal) await deleteProject(id, { silent: true });
      if (plan.pull.length) await pullIds(plan.pull, (d, n) => setStatus('syncing', `Downloading ${d} of ${n} sets…`));
      let conflicts = [];
      if (plan.push.length) conflicts = await pushIds(plan.push, (d, n) => setStatus('syncing', `Uploading ${d} of ${n} sets…`));
      if (conflicts.length) await pullIds(conflicts);
      const changed = [...plan.pull, ...plan.deleteLocal, ...conflicts];
      if (changed.length) onRemote(changed);
      setStatus('idle', plan.push.length || changed.length ? `${plan.push.length} up, ${changed.length} down` : '');
    } catch (e) {
      if (!e.unlinked) {
        console.error('[tik-sync] sync failed:', e);
        setStatus('error', e.message);
      }
    } finally {
      running = null;
    }
  })();
  return running;
}

let queued = new Set();
let queueTimer = null;
function queuePush(change) {
  if (!isLinked()) return;
  if (change.type === 'delete') {
    const t = tombstones();
    t[change.id] = change.at;
    saveTombstones(t);
    queued.delete(change.id);
  } else {
    queued.add(change.id);
  }
  clearTimeout(queueTimer);
  queueTimer = setTimeout(flushQueue, PUSH_DELAY_MS);
}

async function flushQueue() {
  if (running) { await running; }
  const ids = [...queued];
  queued = new Set();
  const dels = Object.entries(tombstones()).map(([id, at]) => ({ id, at }));
  if (!ids.length && !dels.length) return;
  try {
    setStatus('syncing', 'Saving to the cloud library…');
    await pushDeletes(dels);
    const conflicts = ids.length ? await pushIds(ids) : [];
    if (conflicts.length) {
      // Something newer was saved on another device: take it.
      await pullIds(conflicts);
      onRemote(conflicts);
    }
    setStatus('idle');
  } catch (e) {
    ids.forEach((id) => queued.add(id));   // try again on the next change or sync
    if (!e.unlinked) {
      console.error('[tik-sync] push failed:', e);
      setStatus('error', e.message);
    }
  }
}

let started = false;
// Start syncing on this page. `onRemoteChange(ids)` runs after projects
// arrive from (or are deleted by) another device, so the page can redraw.
export function initSync({ onRemoteChange = () => {} } = {}) {
  onRemote = onRemoteChange;
  if (started) return fullSync();
  started = true;
  onLibraryChange(queuePush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - status.at > 30_000) fullSync();
  });
  setInterval(() => { if (document.visibilityState === 'visible') fullSync(); }, RESYNC_MS);
  window.addEventListener('pagehide', () => { if (queued.size) flushQueue(); });
  return fullSync();
}
