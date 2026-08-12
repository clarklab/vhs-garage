import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSnaps, thinSnaps, metaFromVideo, snapFromVideo, normalizeRecord,
  normalizeStore, mergeSnapshots, capPosts, storeToRows, snapshotDays,
  FRESH_DAYS, MAX_SNAPS, MAX_POSTS,
} from '../../netlify/functions/lib/posts.mjs';

// A TikTok video/list row, as the Display API hands it to us.
const video = (id, over = {}) => ({
  id,
  title: `Post ${id}`,
  video_description: 'Facts about a film. #movietrivia #moviefacts',
  create_time: 1_750_000_000,
  duration: 24,
  share_url: `https://www.tiktok.com/@vhsgaragevideo/video/${id}`,
  view_count: 1000,
  like_count: 100,
  comment_count: 10,
  share_count: 5,
  ...over,
});

// ---- snapshots ----

test('normalizeSnaps drops days it cannot trust and sorts what is left', () => {
  const out = normalizeSnaps([
    { d: '2026-08-03', v: 300 },
    { d: 'not-a-day', v: 999 },
    { d: '2026-08-01', v: 100, l: 9, c: 2, s: 1 },
    { d: '2026-08-02' },              // no view count measures nothing
    { d: '2026-08-04', v: -5 },       // negative is not a count
  ]);
  assert.deepEqual(out.map((s) => s.d), ['2026-08-01', '2026-08-03']);
  assert.deepEqual(out[0], { d: '2026-08-01', v: 100, l: 9, c: 2, s: 1 });
});

test('normalizeSnaps lets a later read of the same day win', () => {
  const out = normalizeSnaps([{ d: '2026-08-01', v: 100 }, { d: '2026-08-01', v: 140 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].v, 140);
});

test('normalizeSnaps keeps a genuine zero rather than treating it as missing', () => {
  const out = normalizeSnaps([{ d: '2026-08-01', v: 0, l: 0 }]);
  assert.deepEqual(out, [{ d: '2026-08-01', v: 0, l: 0 }]);
});

// ---- retention ----

const dayAt = (offset, from = Date.UTC(2026, 7, 31)) =>
  new Date(from + offset * 86_400_000).toISOString().slice(0, 10);

test('thinSnaps keeps every day inside the fresh window', () => {
  const snaps = Array.from({ length: 10 }, (_, i) => ({ d: dayAt(-i), v: 1000 - i * 10 }));
  const kept = thinSnaps(snaps, { day: dayAt(0) });
  assert.equal(kept.length, 10);
});

test('thinSnaps drops older days down to roughly one a week', () => {
  // 120 consecutive daily snapshots ending today.
  const snaps = Array.from({ length: 120 }, (_, i) => ({ d: dayAt(i - 119), v: i * 10 }));
  const kept = thinSnaps(snaps, { day: dayAt(0) });

  const fresh = kept.filter((s) => Date.parse(`${s.d}T00:00:00Z`) > Date.UTC(2026, 7, 31) - FRESH_DAYS * 86_400_000);
  assert.equal(fresh.length, FRESH_DAYS, 'the fresh window survives intact');
  assert.ok(kept.length < 50, `expected heavy thinning, kept ${kept.length}`);
  assert.ok(kept.length > FRESH_DAYS, 'older history is thinned, not deleted');
});

test('thinSnaps always keeps the earliest snapshot as the anchor', () => {
  const snaps = Array.from({ length: 200 }, (_, i) => ({ d: dayAt(i - 199), v: i }));
  const kept = thinSnaps(snaps, { day: dayAt(0) });
  assert.equal(kept[0].d, dayAt(-199), 'the first sighting is what velocity is measured against');
});

test('thinSnaps obeys the hard ceiling even for an absurdly long history', () => {
  const snaps = Array.from({ length: 4000 }, (_, i) => ({ d: dayAt(i - 3999), v: i }));
  const kept = thinSnaps(snaps, { day: dayAt(0) });
  assert.ok(kept.length <= MAX_SNAPS, `kept ${kept.length}, ceiling is ${MAX_SNAPS}`);
  assert.equal(kept[0].d, dayAt(-3999), 'the anchor survives the ceiling too');
});

test('thinSnaps leaves a one-point history alone', () => {
  assert.deepEqual(thinSnaps([{ d: '2026-08-01', v: 5 }]), [{ d: '2026-08-01', v: 5 }]);
  assert.deepEqual(thinSnaps([]), []);
});

// ---- reading TikTok rows ----

test('metaFromVideo maps the Display API field names onto ours', () => {
  const meta = metaFromVideo(video('111'));
  assert.deepEqual(meta, {
    id: '111',
    title: 'Post 111',
    desc: 'Facts about a film. #movietrivia #moviefacts',
    created: 1_750_000_000,
    duration: 24,
    url: 'https://www.tiktok.com/@vhsgaragevideo/video/111',
  });
});

test('metaFromVideo refuses a row with no id', () => {
  assert.equal(metaFromVideo({ title: 'orphan' }), null);
  assert.equal(metaFromVideo(null), null);
});

test('metaFromVideo never stores a cover image url', () => {
  // The CDN link expires in six hours; a stored one is a broken image by the
  // next visit, so it must not survive into the record.
  const meta = metaFromVideo(video('111', { cover_image_url: 'https://cdn/expiring.jpg' }));
  assert.ok(!('cover' in meta) && !('cover_image_url' in meta));
  assert.ok(!JSON.stringify(meta).includes('expiring.jpg'));
});

test('snapFromVideo returns null when there is no view count to record', () => {
  assert.equal(snapFromVideo(video('111', { view_count: undefined }), '2026-08-01'), null);
});

test('snapFromVideo will not turn a missing count into a real zero', () => {
  // Number(null) is 0. Coercing straight through would store a fabricated
  // zero-view snapshot and then quietly drag every median that touches it.
  assert.equal(snapFromVideo(video('111', { view_count: null }), '2026-08-01'), null);
  assert.equal(snapFromVideo(video('111', { view_count: '' }), '2026-08-01'), null);
  const partial = snapFromVideo(video('111', { like_count: null }), '2026-08-01');
  assert.ok(!('l' in partial), 'an absent like count is absent, not zero');
});

test('metaFromVideo keeps a null date null rather than turning it into 1970', () => {
  const meta = metaFromVideo(video('111', { create_time: null, duration: null }));
  assert.equal(meta.created, null);
  assert.equal(meta.duration, null);
});

test('snapFromVideo carries the engagement counts alongside views', () => {
  assert.deepEqual(snapFromVideo(video('111'), '2026-08-01'), {
    d: '2026-08-01', v: 1000, l: 100, c: 10, s: 5,
  });
});

// ---- the stored shape survives a round trip ----

test('normalizeRecord reads our own field names, not TikTok’s', () => {
  // Regression: running a stored record back through the live-video mapper
  // looked for create_time/video_description, found nothing, and blanked the
  // date and description on every read.
  const stored = {
    id: '111', title: 'Post 111', desc: 'a description', created: 1_750_000_000,
    duration: 24, url: 'https://tiktok/111', snaps: [{ d: '2026-08-01', v: 10 }],
  };
  assert.deepEqual(normalizeRecord(stored), stored);
});

test('a merged store survives being normalized again unchanged', () => {
  const once = mergeSnapshots({}, [video('111')], { day: '2026-08-01' });
  assert.deepEqual(normalizeStore(once), once);
  assert.equal(once['111'].desc, 'Facts about a film. #movietrivia #moviefacts');
  assert.equal(once['111'].created, 1_750_000_000);
});

// ---- merging ----

test('mergeSnapshots accumulates one point per day per post', () => {
  let store = mergeSnapshots({}, [video('111')], { day: '2026-08-01' });
  store = mergeSnapshots(store, [video('111', { view_count: 1500 })], { day: '2026-08-02' });
  store = mergeSnapshots(store, [video('111', { view_count: 1800 })], { day: '2026-08-03' });
  assert.deepEqual(store['111'].snaps.map((s) => s.v), [1000, 1500, 1800]);
});

test('mergeSnapshots replaces the same day rather than doubling it', () => {
  let store = mergeSnapshots({}, [video('111')], { day: '2026-08-01' });
  store = mergeSnapshots(store, [video('111', { view_count: 1200 })], { day: '2026-08-01' });
  assert.equal(store['111'].snaps.length, 1);
  assert.equal(store['111'].snaps[0].v, 1200);
});

test('mergeSnapshots takes an edited title from the live row', () => {
  let store = mergeSnapshots({}, [video('111')], { day: '2026-08-01' });
  store = mergeSnapshots(store, [video('111', { title: 'Retitled in the app' })], { day: '2026-08-02' });
  assert.equal(store['111'].title, 'Retitled in the app');
});

test('mergeSnapshots will not let a thin live row erase a date we already knew', () => {
  let store = mergeSnapshots({}, [video('111')], { day: '2026-08-01' });
  store = mergeSnapshots(store, [{ id: '111', view_count: 1400 }], { day: '2026-08-02' });
  assert.equal(store['111'].created, 1_750_000_000);
  assert.equal(store['111'].duration, 24);
  assert.equal(store['111'].snaps.length, 2);
});

test('mergeSnapshots keeps a post that has fallen out of the live window', () => {
  // video/list only reaches back so far; an old post must not vanish from the
  // history just because it stopped being returned.
  let store = mergeSnapshots({}, [video('111'), video('222')], { day: '2026-08-01' });
  store = mergeSnapshots(store, [video('222')], { day: '2026-08-02' });
  assert.deepEqual(Object.keys(store).sort(), ['111', '222']);
  assert.equal(store['111'].snaps.length, 1, 'no new point, but the history stays');
});

test('capPosts keeps the newest posts when over the ceiling', () => {
  const store = {};
  for (let i = 0; i < MAX_POSTS + 10; i++) {
    store[String(i)] = { id: String(i), created: 1_700_000_000 + i, snaps: [{ d: '2026-08-01', v: i }] };
  }
  const capped = capPosts(store);
  assert.equal(Object.keys(capped).length, MAX_POSTS);
  assert.ok(capped[String(MAX_POSTS + 9)], 'newest survives');
  assert.ok(!capped['0'], 'oldest is dropped');
});

// ---- reading back out ----

test('storeToRows hoists the latest counts and sorts newest first', () => {
  let store = mergeSnapshots({}, [
    video('111', { create_time: 1_750_000_000 }),
    video('222', { create_time: 1_760_000_000, view_count: 50 }),
  ], { day: '2026-08-01' });
  store = mergeSnapshots(store, [video('111', { view_count: 4321, like_count: 99 })], { day: '2026-08-02' });

  const rows = storeToRows(store);
  assert.deepEqual(rows.map((r) => r.id), ['222', '111']);
  const first = rows.find((r) => r.id === '111');
  assert.equal(first.views, 4321, 'the most recent snapshot is the current total');
  assert.equal(first.likes, 99);
});

test('snapshotDays counts distinct observation days across the whole store', () => {
  let store = mergeSnapshots({}, [video('111'), video('222')], { day: '2026-08-01' });
  assert.equal(snapshotDays(store), 1, 'two posts seen on one day is still one day of history');
  store = mergeSnapshots(store, [video('111')], { day: '2026-08-02' });
  assert.equal(snapshotDays(store), 2);
});

test('an empty or junk store reads as empty rather than throwing', () => {
  assert.deepEqual(storeToRows(null), []);
  assert.deepEqual(storeToRows('nonsense'), []);
  assert.deepEqual(storeToRows([1, 2, 3]), []);
  assert.equal(snapshotDays(undefined), 0);
});
