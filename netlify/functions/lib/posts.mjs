// Pure helpers for the per-post stats history.
//
// TikTok's Display API reports only CURRENT totals for a post — there is no
// per-post history endpoint, exactly as there is none for the follower count.
// lib/stats.mjs already solves that shape for the account; this does it for
// individual posts, and for the same reason: a lifetime view count says a post
// got 4k views, while two snapshots a week apart say whether it is still alive.
//
// Everything here is pure. getStore() is called in tik-posts.mjs, never here —
// this module only exports the store's NAME, matching STATS_STORE and
// QUEUE_JOBS_STORE.
//
// Storage is ONE blob holding every post, not one blob per post: the report
// needs all of them at once, so N reads to render one screen would be the
// wrong trade. Retention keeps that blob small (see thinSnaps).
//
// No DOM, no network. Unit-tested under node:test.

import { todayKey } from './stats.mjs';

export const POSTS_STORE = 'tik-posts';
export const POSTS_KEY = 'snapshots';

// A post's first month is where the interesting movement happens, and it is
// also the only window in which a daily point tells you something a weekly one
// would not. Past that, weekly is plenty to answer "is this still earning".
export const FRESH_DAYS = 30;
export const THIN_DAYS = 7;

// Ceilings. 400 posts × 80 snapshots × ~40 bytes is comfortably under a
// megabyte, and video/list only reaches back 200 posts anyway.
export const MAX_POSTS = 400;
export const MAX_SNAPS = 80;

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export { todayKey };

function dayMs(d) {
  return Date.parse(`${d}T00:00:00Z`);
}

// Number(null) is 0, and Number('') is 0. Coercing straight through would let
// a missing view_count store as a real zero-view snapshot, which is a fabricated
// data point rather than an absent one.
function intOrNull(v) {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  if (typeof v === 'string' && !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function str(v, max = 300) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// ---- snapshots ----

// One day's counts for one post. Short keys because this is the part that
// repeats hundreds of times: d(ay), v(iews), l(ikes), c(omments), s(hares).
export function normalizeSnaps(raw) {
  const byDay = new Map();
  for (const item of Array.isArray(raw) ? raw : []) {
    const d = typeof item?.d === 'string' && DAY_RE.test(item.d) ? item.d : null;
    const v = intOrNull(item?.v);
    if (!d || v === null) continue; // a snapshot with no view count measures nothing
    const snap = { d, v };
    for (const k of ['l', 'c', 's']) {
      const n = intOrNull(item?.[k]);
      if (n !== null) snap[k] = n;
    }
    byDay.set(d, snap); // later entries for the same day win
  }
  return [...byDay.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
}

// Retention. Every snapshot inside the fresh window survives; older ones are
// kept at most one per `everyDays`. The earliest snapshot is always kept — it
// is the anchor for "how many views did this have when we first saw it", and
// dropping it would silently shorten every post's measured history.
export function thinSnaps(raw, { day = null, freshDays = FRESH_DAYS, everyDays = THIN_DAYS } = {}) {
  const list = normalizeSnaps(raw);
  if (list.length < 2) return list;

  const newest = dayMs(day && DAY_RE.test(day) ? day : list[list.length - 1].d);
  const cutoff = newest - freshDays * DAY_MS;
  const kept = [];
  let lastOld = null;
  for (const snap of list) {
    const t = dayMs(snap.d);
    if (t > cutoff) { kept.push(snap); continue; }
    if (lastOld === null || t - lastOld >= everyDays * DAY_MS) {
      kept.push(snap);
      lastOld = t;
    }
  }

  // Hard ceiling, for the pathological case of a very old post seen every day
  // for years. Keep the anchor and the most recent run.
  if (kept.length > MAX_SNAPS) return [kept[0], ...kept.slice(kept.length - (MAX_SNAPS - 1))];
  return kept;
}

// ---- records ----

// The durable half of a post. cover_image_url is deliberately NOT stored: its
// CDN link expires after six hours, so a stored one is a broken image by the
// next visit. tik-posts.mjs passes the fresh one through on live fetches.
export function metaFromVideo(video) {
  const id = String(video?.id ?? '').trim();
  if (!id) return null;
  return {
    id,
    title: str(video?.title, 200),
    desc: str(video?.video_description ?? video?.description, 400),
    created: intOrNull(video?.create_time),
    duration: intOrNull(video?.duration),
    url: str(video?.share_url, 300),
  };
}

export function snapFromVideo(video, day) {
  const v = intOrNull(video?.view_count);
  if (v === null) return null; // no views field → nothing worth storing
  const snap = { d: DAY_RE.test(String(day)) ? day : todayKey(), v };
  const l = intOrNull(video?.like_count);
  const c = intOrNull(video?.comment_count);
  const s = intOrNull(video?.share_count);
  if (l !== null) snap.l = l;
  if (c !== null) snap.c = c;
  if (s !== null) snap.s = s;
  return snap;
}

// Stored records use our own field names, NOT TikTok's — reading them back
// through metaFromVideo() would look for create_time/video_description, find
// nothing, and quietly blank the date and description on every round trip.
export function normalizeRecord(rec, fallbackId = '') {
  const id = String(rec?.id ?? fallbackId ?? '').trim();
  if (!id) return null;
  return {
    id,
    title: str(rec?.title, 200),
    desc: str(rec?.desc, 400),
    created: intOrNull(rec?.created),
    duration: intOrNull(rec?.duration),
    url: str(rec?.url, 300),
    snaps: normalizeSnaps(rec?.snaps),
  };
}

export function normalizeStore(raw) {
  const out = {};
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  for (const [key, rec] of Object.entries(src)) {
    const record = normalizeRecord(rec, key);
    if (record) out[record.id] = record;
  }
  return out;
}

// Fold a freshly fetched page of videos into the stored history.
//
// Metadata is overwritten from the live row rather than merged: a title edited
// in the TikTok app should show as edited. Snapshots accumulate.
export function mergeSnapshots(stored, videos, { day = todayKey() } = {}) {
  const store = normalizeStore(stored);
  for (const video of Array.isArray(videos) ? videos : []) {
    const meta = metaFromVideo(video);
    if (!meta) continue;
    const prev = store[meta.id];
    const snap = snapFromVideo(video, day);
    const snaps = snap ? [...(prev?.snaps || []), snap] : (prev?.snaps || []);
    // `created` can be absent from a live row if the field was not requested;
    // never let that erase a date we already knew.
    store[meta.id] = {
      ...meta,
      created: meta.created ?? prev?.created ?? null,
      duration: meta.duration ?? prev?.duration ?? null,
      snaps: thinSnaps(snaps, { day }),
    };
  }
  return capPosts(store);
}

// Newest posts win when we are over the ceiling. A post with no create_time
// sorts last rather than throwing off the comparison.
export function capPosts(store, max = MAX_POSTS) {
  const entries = Object.entries(normalizeStore(store));
  if (entries.length <= max) return Object.fromEntries(entries);
  entries.sort((a, b) => (b[1].created ?? -1) - (a[1].created ?? -1));
  return Object.fromEntries(entries.slice(0, max));
}

// The store as the client wants it: an array, newest first, with the latest
// counts hoisted out of the snapshot tail so callers do not each re-derive it.
export function storeToRows(store) {
  return Object.values(normalizeStore(store))
    .map((rec) => {
      const last = rec.snaps[rec.snaps.length - 1] || null;
      return {
        ...rec,
        views: last ? last.v : null,
        likes: last && 'l' in last ? last.l : null,
        comments: last && 'c' in last ? last.c : null,
        shares: last && 's' in last ? last.s : null,
      };
    })
    .sort((a, b) => (b.created ?? -1) - (a.created ?? -1));
}

// How many distinct days the store has ever observed. The report uses this to
// decide whether it can talk about velocity yet, or must say "come back
// tomorrow" — one snapshot is a total, not a trend.
export function snapshotDays(store) {
  const days = new Set();
  for (const rec of Object.values(normalizeStore(store))) {
    for (const snap of rec.snaps) days.add(snap.d);
  }
  return days.size;
}
