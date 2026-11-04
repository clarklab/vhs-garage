// Library sync — the pure parts (no DOM, no network). Unit-tested.
//
// A project record holds Blobs in a few places (the cover thumb, each slide's
// frame, paired and mosaic photos). On the wire every Blob becomes
// { $blob: <sha256>, type } and the bytes travel separately, once per image.
// A device that pulls a project gets placeholders back and fills them in from
// the images it already has, fetching only what is new to it.

const MAX_DEPTH = 8;

export const isPlaceholder = (v) => !!v && typeof v === 'object' && !isBlobLike(v) && typeof v.$blob === 'string';

export function isBlobLike(v) {
  return typeof Blob !== 'undefined' && v instanceof Blob;
}

// Replace every Blob with a placeholder. `hashOf(blob)` → Promise<hex>.
// → { record, blobs: Map<hash, Blob> }
export async function dehydrate(record, hashOf) {
  const blobs = new Map();
  const walk = async (v, depth) => {
    if (depth > MAX_DEPTH || v === null || typeof v !== 'object') return v;
    if (isBlobLike(v)) {
      const hash = await hashOf(v);
      blobs.set(hash, v);
      return { $blob: hash, type: v.type || 'image/jpeg' };
    }
    if (Array.isArray(v)) return Promise.all(v.map((x) => walk(x, depth + 1)));
    // Live objects that never belong in storage (bitmaps, canvases) are left
    // out rather than serialised as {}.
    if (typeof ImageBitmap !== 'undefined' && v instanceof ImageBitmap) return null;
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = await walk(x, depth + 1);
    return out;
  };
  return { record: await walk(record, 0), blobs };
}

// Every placeholder hash still in a record.
export function placeholderHashes(record) {
  const out = new Set();
  const walk = (v, depth) => {
    if (depth > MAX_DEPTH || v === null || typeof v !== 'object' || isBlobLike(v)) return;
    if (isPlaceholder(v)) { out.add(v.$blob); return; }
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  walk(record, 0);
  return out;
}

// Put Blobs back wherever `blobs` (Map<hash, Blob>) has them. Placeholders
// with no match are kept, to be fetched later.
export function rehydrate(record, blobs) {
  const walk = (v, depth) => {
    if (depth > MAX_DEPTH || v === null || typeof v !== 'object' || isBlobLike(v)) return v;
    if (isPlaceholder(v)) return blobs.get(v.$blob) || v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, depth + 1);
    return out;
  };
  return walk(record, 0);
}

// What to do, given the cloud manifest, this device's projects and the
// deletions it has made but not yet sent.
//   local:      [{ id, updatedAt }]
//   tombstones: { id: deletedAt }
// → { pull: [id], push: [id], deleteLocal: [id], pushDeletes: [{ id, at }] }
export function planSync(manifest, local, tombstones = {}) {
  const remote = manifest?.projects || {};
  const mine = new Map(local.map((p) => [p.id, Number(p.updatedAt) || 0]));
  const plan = { pull: [], push: [], deleteLocal: [], pushDeletes: [] };

  for (const [id, at] of Object.entries(tombstones)) {
    const r = remote[id];
    if (!r || r.d) continue;                 // already gone there too
    if ((Number(r.u) || 0) <= at) plan.pushDeletes.push({ id, at });
    // else: changed elsewhere after this device deleted it; the pull below brings it back
  }
  for (const [id, r] of Object.entries(remote)) {
    const u = Number(r.u) || 0;
    const here = mine.get(id);
    if (r.d) {
      if (here !== undefined && here <= u) plan.deleteLocal.push(id);
      continue;
    }
    if (tombstones[id] !== undefined && tombstones[id] >= u) continue;  // our delete wins
    if (here === undefined || here < u) plan.pull.push(id);
  }
  for (const [id, here] of mine) {
    const r = remote[id];
    if (!r || (!r.d && (Number(r.u) || 0) < here) || (r.d && here > (Number(r.u) || 0))) plan.push.push(id);
  }
  return plan;
}

// Split items into runs whose sizes add up to at most `max` (an item bigger
// than `max` travels alone).
export function chunkBySize(items, sizeOf, max) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const it of items) {
    const s = sizeOf(it);
    if (cur.length && size + s > max) { out.push(cur); cur = []; size = 0; }
    cur.push(it);
    size += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

export const chunk = (items, n) => {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
};
