// Turning the post history into numbers worth acting on.
//
// Everything here answers one of two questions:
//
//   "what is working"   — which posts, tags, lengths and posting times earn
//                         views, compared against the account's own median
//   "what is alive now" — which posts are still gaining, from the snapshot
//                         history that tik-posts.mjs accumulates
//
// Two rules carried over from tagreport.js, for the same reasons:
//
//   Medians, not means. One breakout post otherwise drags every bucket it
//   touches and invents a winner.
//
//   Every row carries its `n`. At a handful of posts per bucket this is noise,
//   and a report that hides its sample size implies a confidence it has not
//   earned.
//
// A third rule is specific to this module: compare on VIEWS PER DAY, not
// lifetime views. Lifetime totals structurally favour older posts — a mediocre
// post from March will out-total a strong one from last week forever — so any
// ranking built on them is really a ranking of post age. Lifetime views are
// still shown, because that is the number TikTok shows, but the comparisons
// and the lift columns run on the age-adjusted figure.
//
// Pure — no DOM, no network. Unit-tested under node:test.

import { median, MIN_SAMPLE } from './tagreport.js';
import { finite as num } from './fmt.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Buckets chosen around what we actually ship: a trivia slideshow runs 20-35s,
// so the interesting question is whether the short ones or the long ones win.
// Photo posts report no duration at all and get their own row rather than
// being silently lumped in with the shortest videos.
export const DURATION_BUCKETS = [
  { key: 'photo', label: 'Photo / no length', max: null },
  { key: 'u15', label: 'Under 15s', max: 15 },
  { key: 'u25', label: '15–24s', max: 25 },
  { key: 'u35', label: '25–34s', max: 35 },
  { key: 'u60', label: '35–59s', max: 60 },
  { key: 'o60', label: '60s+', max: Infinity },
];

// Three-hour blocks. Twenty-four separate hours would slice a few dozen posts
// into rows of one, which is not a measurement.
export const HOUR_BLOCKS = [
  { key: 'h0', label: '12–3am', from: 0 }, { key: 'h3', label: '3–6am', from: 3 },
  { key: 'h6', label: '6–9am', from: 6 }, { key: 'h9', label: '9am–12pm', from: 9 },
  { key: 'h12', label: '12–3pm', from: 12 }, { key: 'h15', label: '3–6pm', from: 15 },
  { key: 'h18', label: '6–9pm', from: 18 }, { key: 'h21', label: '9pm–12am', from: 21 },
];

function dayMs(d) {
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

// ---- one post ----

// Views gained between the last two snapshots, and the rate that implies.
//
// The gap is measured from the actual dates, never assumed to be a day: the
// snapshot only happens when the studio is open, so a three-day gap is normal
// and dividing it by one would report triple the real velocity.
//
// A negative gain is discarded rather than shown. TikTok's counts do drift
// downward occasionally (spam sweeps, deleted accounts), and "this post lost
// 40 views" is noise the report would be worse for repeating.
export function recentGain(snaps) {
  const list = Array.isArray(snaps) ? snaps.filter((s) => s && num(s.v) !== null && dayMs(s.d) !== null) : [];
  if (list.length < 2) return null;
  const last = list[list.length - 1];
  const prev = list[list.length - 2];
  const days = Math.max(1, Math.round((dayMs(last.d) - dayMs(prev.d)) / DAY_MS));
  const gain = num(last.v) - num(prev.v);
  if (gain < 0) return null;
  return { gain, days, perDay: gain / days };
}

// Views-per-day between each consecutive pair of snapshots.
//
// A sparkline of the running TOTAL would climb from left to right for every
// post ever made and so distinguish none of them. The gain between snapshots
// is the shape worth drawing: it shows the opening spike, the decay, and the
// occasional second wind when a post gets picked up again.
//
// Rates, not raw gains, because the gaps are uneven — snapshots happen when
// the studio is open. A five-day gap would otherwise draw a spike that is
// really just five days of ordinary drift stacked into one point.
export function gainSeries(snaps) {
  const list = (Array.isArray(snaps) ? snaps : [])
    .filter((s) => s && num(s.v) !== null && dayMs(s.d) !== null);
  const out = [];
  for (let i = 1; i < list.length; i++) {
    const days = Math.max(1, Math.round((dayMs(list[i].d) - dayMs(list[i - 1].d)) / DAY_MS));
    const gain = num(list[i].v) - num(list[i - 1].v);
    out.push({ d: list[i].d, days, perDay: Math.max(0, gain) / days });
  }
  return out;
}

// Age in days, as a real number — a post six hours old is 0.25 days, and
// rounding that to 0 would make its views-per-day infinite.
function ageDaysOf(created, now) {
  const c = num(created);
  if (c === null || c <= 0) return null;
  const age = (now - c * 1000) / DAY_MS;
  return age > 0 ? age : null;
}

export function enrichPost(post, { now = Date.now() } = {}) {
  const views = num(post?.views);
  const likes = num(post?.likes);
  const comments = num(post?.comments);
  const shares = num(post?.shares);
  const ageDays = ageDaysOf(post?.created, now);

  const engagementSum = [likes, comments, shares].reduce((a, b) => a + (b ?? 0), 0);
  const engagement = views !== null && views > 0 ? engagementSum / views : null;

  // The age-adjusted figure. A post younger than a day is charged a full day,
  // so a six-hour-old post cannot post a fantasy rate off a tiny denominator.
  const viewsPerDay = views !== null && ageDays !== null ? views / Math.max(1, ageDays) : null;

  const recent = recentGain(post?.snaps);
  // >1 means it is currently outrunning its own lifetime average — still
  // climbing rather than coasting on an opening burst.
  const momentum = recent && viewsPerDay ? recent.perDay / viewsPerDay : null;

  return {
    ...post,
    views, likes, comments, shares,
    ageDays,
    engagement,
    viewsPerDay,
    recent,
    momentum,
    snapCount: Array.isArray(post?.snaps) ? post.snaps.length : 0,
  };
}

export function enrichPosts(posts, { now = Date.now() } = {}) {
  return (Array.isArray(posts) ? posts : [])
    .filter((p) => p && p.id)
    .map((p) => enrichPost(p, { now }));
}

// ---- the account ----

export function accountSummary(posts, profile = null) {
  const list = Array.isArray(posts) ? posts : [];
  const views = list.map((p) => p.views).filter((v) => Number.isFinite(v));
  const totalViews = views.reduce((a, b) => a + b, 0);
  const withRecent = list.filter((p) => p.recent);

  return {
    posts: list.length,
    // The account totals TikTok gives us directly, when we have them.
    followers: num(profile?.followers),
    following: num(profile?.following),
    likes: num(profile?.likes),
    videos: num(profile?.videos),
    // Derived from the post history.
    totalViews: views.length ? totalViews : null,
    medianViews: median(views),
    medianPerDay: median(list.map((p) => p.viewsPerDay)),
    medianEngagement: median(list.map((p) => p.engagement)),
    // Views the whole account picked up since the previous snapshot — the one
    // number that says whether the catalogue as a whole is still working.
    recentGain: withRecent.length ? withRecent.reduce((a, p) => a + p.recent.gain, 0) : null,
    recentPosts: withRecent.length,
  };
}

// ---- rankings ----

export function leaderboard(posts, { limit = 10, by = 'viewsPerDay' } = {}) {
  return (Array.isArray(posts) ? posts : [])
    .filter((p) => Number.isFinite(p[by]))
    .sort((a, b) => b[by] - a[by])
    .slice(0, limit);
}

// What is still moving. Sorted by raw gain rather than rate: the report is
// asking "where did this week's views actually come from", and a tiny post
// doubling from 8 views to 16 is not the answer.
export function momentum(posts, { limit = 6 } = {}) {
  return (Array.isArray(posts) ? posts : [])
    .filter((p) => p.recent && p.recent.gain > 0)
    .sort((a, b) => b.recent.gain - a.recent.gain)
    .slice(0, limit);
}

// ---- buckets ----

function summarizeGroup(rows, baselinePerDay) {
  const medianPerDay = median(rows.map((r) => r.viewsPerDay));
  return {
    n: rows.length,
    medianViews: median(rows.map((r) => r.views)),
    medianPerDay,
    medianEngagement: median(rows.map((r) => r.engagement)),
    lift: medianPerDay !== null && Number.isFinite(baselinePerDay) && baselinePerDay > 0
      ? medianPerDay / baselinePerDay - 1
      : null,
    enough: rows.length >= MIN_SAMPLE,
  };
}

// Group posts by a key, summarize each group against the overall median, and
// return the buckets in their declared order — including empty ones, so a
// posting slot we have never tried reads as untried rather than absent.
export function bucketReport(posts, { buckets, keyOf, now = Date.now() }) {
  const list = (Array.isArray(posts) ? posts : []).filter((p) => p);
  const baseline = summarizeGroup(list, null);
  const baselinePerDay = baseline.medianPerDay;

  const grouped = new Map();
  for (const post of list) {
    const key = keyOf(post, now);
    if (key === null || key === undefined) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(post);
  }

  return {
    baseline: { ...baseline, lift: null },
    rows: buckets.map((b) => ({
      key: b.key,
      label: b.label,
      ...summarizeGroup(grouped.get(b.key) || [], baselinePerDay),
    })),
  };
}

export function durationKey(post) {
  const d = num(post?.duration);
  if (d === null || d <= 0) return 'photo';
  for (const b of DURATION_BUCKETS) {
    if (b.max !== null && d < b.max) return b.key;
  }
  return 'o60';
}

// Local time, deliberately. The question "when should I post" is asked in the
// timezone the person posting lives in, and a UTC answer would be off by hours
// with no indication that it was.
function localDate(post) {
  const c = num(post?.created);
  return c !== null && c > 0 ? new Date(c * 1000) : null;
}

export function weekdayKey(post) {
  const d = localDate(post);
  return d ? WEEKDAYS[d.getDay()] : null;
}

export function hourKey(post) {
  const d = localDate(post);
  if (!d) return null;
  const block = Math.floor(d.getHours() / 3) * 3;
  return `h${block}`;
}

export function byDuration(posts, opts = {}) {
  return bucketReport(posts, { buckets: DURATION_BUCKETS, keyOf: durationKey, ...opts });
}

export function byWeekday(posts, opts = {}) {
  const buckets = WEEKDAYS.map((label) => ({ key: label, label }));
  return bucketReport(posts, { buckets, keyOf: weekdayKey, ...opts });
}

export function byHour(posts, opts = {}) {
  return bucketReport(posts, { buckets: HOUR_BLOCKS, keyOf: hourKey, ...opts });
}

// ---- feeding the tag report ----

// tagreport.js takes rows keyed by lifetime counts. Handing it the enriched
// posts directly works because the field names already line up; this exists to
// drop posts with no usable numbers, which would otherwise pull every median
// they touch toward nothing.
export function tagRows(posts) {
  return (Array.isArray(posts) ? posts : []).filter((p) => Number.isFinite(p?.views));
}
