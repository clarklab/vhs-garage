import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recentGain, gainSeries, enrichPost, enrichPosts, accountSummary,
  leaderboard, momentum, durationKey, weekdayKey, hourKey,
  byDuration, byWeekday, byHour, bucketReport, tagRows,
  WEEKDAYS, DURATION_BUCKETS,
} from '../../public/scripts/tik/postmetrics.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);
// `created` is unix SECONDS, as TikTok reports it.
const daysAgo = (n) => Math.round((NOW - n * DAY) / 1000);

const post = (over = {}) => ({
  id: '1', title: 'Post', desc: '#movietrivia #moviefacts', movie: 'The Thing',
  tags: ['movietrivia', 'moviefacts'], created: daysAgo(10), duration: 24,
  url: 'https://tiktok/1', views: 1000, likes: 80, comments: 15, shares: 5,
  snaps: [], ...over,
});

const snap = (d, v) => ({ d, v });

// ---- velocity ----

test('recentGain needs two snapshots before it will say anything', () => {
  assert.equal(recentGain([]), null);
  assert.equal(recentGain([snap('2026-08-01', 100)]), null);
  assert.equal(recentGain(undefined), null);
});

test('recentGain divides by the real gap, not an assumed day', () => {
  // Snapshots only happen when the studio is open, so a three-day gap is
  // normal. Treating it as one day would report triple the real velocity.
  const out = recentGain([snap('2026-08-01', 100), snap('2026-08-04', 400)]);
  assert.deepEqual(out, { gain: 300, days: 3, perDay: 100 });
});

test('recentGain discards a count that went backwards', () => {
  // TikTok counts do drift down after spam sweeps. "This post lost 40 views"
  // is noise the report would be worse for repeating.
  assert.equal(recentGain([snap('2026-08-01', 500), snap('2026-08-02', 460)]), null);
});

test('recentGain reads the last two points, not the first two', () => {
  const out = recentGain([snap('2026-08-01', 100), snap('2026-08-02', 200), snap('2026-08-03', 260)]);
  assert.equal(out.gain, 60);
});

test('gainSeries turns running totals into per-day rates', () => {
  const out = gainSeries([snap('2026-08-01', 0), snap('2026-08-02', 100), snap('2026-08-06', 300)]);
  assert.deepEqual(out.map((s) => s.perDay), [100, 50]);
});

test('gainSeries yields one fewer point than it was given', () => {
  assert.equal(gainSeries([snap('2026-08-01', 5)]).length, 0);
  assert.equal(gainSeries([]).length, 0);
});

test('gainSeries floors a backwards step at zero rather than drawing below the axis', () => {
  const out = gainSeries([snap('2026-08-01', 500), snap('2026-08-02', 450)]);
  assert.equal(out[0].perDay, 0);
});

// ---- one post ----

test('enrichPost computes engagement as a share of views', () => {
  const p = enrichPost(post({ views: 1000, likes: 80, comments: 15, shares: 5 }), { now: NOW });
  assert.equal(p.engagement, 0.1);
});

test('enrichPost reports no engagement rate when there are no views to divide by', () => {
  // A post with no views has no rate, which is not the same as a rate of zero.
  assert.equal(enrichPost(post({ views: 0 }), { now: NOW }).engagement, null);
  assert.equal(enrichPost(post({ views: null }), { now: NOW }).engagement, null);
});

test('enrichPost charges a young post a full day so it cannot post a fantasy rate', () => {
  const sixHours = enrichPost(post({ created: Math.round((NOW - DAY / 4) / 1000), views: 500 }), { now: NOW });
  assert.equal(sixHours.viewsPerDay, 500, 'not 2000');
});

test('enrichPost divides lifetime views by real age for an older post', () => {
  const p = enrichPost(post({ created: daysAgo(10), views: 1000 }), { now: NOW });
  assert.ok(Math.abs(p.viewsPerDay - 100) < 0.01);
});

test('enrichPost leaves velocity null when the post has no date', () => {
  const p = enrichPost(post({ created: null }), { now: NOW });
  assert.equal(p.ageDays, null);
  assert.equal(p.viewsPerDay, null);
});

test('enrichPost flags a post outrunning its own lifetime average', () => {
  const p = enrichPost(post({
    created: daysAgo(10), views: 1000,
    snaps: [snap('2026-08-29', 700), snap('2026-08-30', 1000)],
  }), { now: NOW });
  // Lifetime is 100/day; it just did 300 in a day.
  assert.ok(p.momentum > 2.9 && p.momentum < 3.1, `momentum was ${p.momentum}`);
});

test('enrichPosts skips rows with no id rather than emitting nameless entries', () => {
  const out = enrichPosts([post(), { views: 5 }, null], { now: NOW });
  assert.equal(out.length, 1);
});

// ---- the account ----

test('accountSummary totals views and reports medians over the posts it can read', () => {
  const posts = enrichPosts([
    post({ id: '1', views: 100 }), post({ id: '2', views: 200 }), post({ id: '3', views: 300 }),
  ], { now: NOW });
  const s = accountSummary(posts, { followers: 2000, following: 30, likes: 9000, videos: 40 });
  assert.equal(s.posts, 3);
  assert.equal(s.totalViews, 600);
  assert.equal(s.medianViews, 200);
  assert.equal(s.followers, 2000);
  assert.equal(s.following, 30);
});

test('accountSummary sums the catalogue’s recent gain only over posts that have one', () => {
  const posts = enrichPosts([
    post({ id: '1', snaps: [snap('2026-08-29', 100), snap('2026-08-30', 180)] }),
    post({ id: '2', snaps: [snap('2026-08-30', 50)] }),                            // one point: no gain
    post({ id: '3', snaps: [snap('2026-08-29', 10), snap('2026-08-30', 30)] }),
  ], { now: NOW });
  const s = accountSummary(posts);
  assert.equal(s.recentGain, 100);
  assert.equal(s.recentPosts, 2);
});

test('accountSummary reports no velocity at all before a second snapshot exists', () => {
  const posts = enrichPosts([post({ snaps: [snap('2026-08-30', 50)] })], { now: NOW });
  assert.equal(accountSummary(posts).recentGain, null, 'null, not 0 — 0 would read as "nothing grew"');
});

// ---- rankings ----

test('leaderboard ranks on views per day, not lifetime views', () => {
  const posts = enrichPosts([
    post({ id: 'old', created: daysAgo(100), views: 5000 }),   //  50/day
    post({ id: 'new', created: daysAgo(2), views: 800 }),      // 400/day
  ], { now: NOW });
  assert.deepEqual(leaderboard(posts).map((p) => p.id), ['new', 'old']);
});

test('leaderboard honours its limit and drops rows it cannot rank', () => {
  const posts = enrichPosts([
    post({ id: '1', views: 100 }), post({ id: '2', views: 200 }),
    post({ id: '3', created: null, views: 999 }),   // no age → no rate → unrankable
  ], { now: NOW });
  assert.equal(leaderboard(posts, { limit: 1 }).length, 1);
  assert.equal(leaderboard(posts).length, 2);
});

test('momentum ranks on raw views gained, not on rate of change', () => {
  // A tiny post doubling from 8 to 16 is not where this week's views came from.
  const posts = enrichPosts([
    post({ id: 'tiny', views: 16, snaps: [snap('2026-08-29', 8), snap('2026-08-30', 16)] }),
    post({ id: 'big', views: 9000, snaps: [snap('2026-08-29', 8000), snap('2026-08-30', 9000)] }),
  ], { now: NOW });
  assert.deepEqual(momentum(posts).map((p) => p.id), ['big', 'tiny']);
});

test('momentum excludes posts that did not move', () => {
  const posts = enrichPosts([
    post({ id: 'flat', snaps: [snap('2026-08-29', 100), snap('2026-08-30', 100)] }),
    post({ id: 'cold', snaps: [snap('2026-08-30', 100)] }),
  ], { now: NOW });
  assert.deepEqual(momentum(posts), []);
});

// ---- buckets ----

test('durationKey files a photo post separately from the shortest videos', () => {
  assert.equal(durationKey({ duration: 0 }), 'photo');
  assert.equal(durationKey({ duration: null }), 'photo');
  assert.equal(durationKey({}), 'photo');
});

test('durationKey buckets video lengths on their boundaries', () => {
  assert.equal(durationKey({ duration: 14 }), 'u15');
  assert.equal(durationKey({ duration: 15 }), 'u25');
  assert.equal(durationKey({ duration: 24 }), 'u25');
  assert.equal(durationKey({ duration: 25 }), 'u35');
  assert.equal(durationKey({ duration: 59 }), 'u60');
  assert.equal(durationKey({ duration: 60 }), 'o60');
  assert.equal(durationKey({ duration: 600 }), 'o60');
});

test('weekdayKey and hourKey read the posting time in local time', () => {
  // Built from a LOCAL Date so the expectation holds in any timezone — the
  // point of the test is that the module does not silently answer in UTC.
  const local = new Date(2026, 7, 12, 14, 30, 0);
  const p = { created: Math.round(local.getTime() / 1000) };
  assert.equal(weekdayKey(p), WEEKDAYS[local.getDay()]);
  assert.equal(hourKey(p), `h${Math.floor(local.getHours() / 3) * 3}`);
});

test('weekdayKey and hourKey answer null for a post with no date', () => {
  assert.equal(weekdayKey({ created: null }), null);
  assert.equal(hourKey({}), null);
});

test('bucketReport shows buckets that have never been used', () => {
  // "We have never posted on a Tuesday" is a finding; dropping the row hides it.
  const posts = enrichPosts([post({ created: daysAgo(3) })], { now: NOW });
  const report = byWeekday(posts);
  assert.equal(report.rows.length, 7);
  assert.equal(report.rows.filter((r) => r.n === 0).length, 6);
});

test('bucketReport measures lift against the overall per-day median', () => {
  const posts = enrichPosts([
    post({ id: '1', duration: 10, created: daysAgo(10), views: 2000 }),  // 200/day
    post({ id: '2', duration: 30, created: daysAgo(10), views: 1000 }),  // 100/day
    post({ id: '3', duration: 30, created: daysAgo(10), views: 1000 }),  // 100/day
  ], { now: NOW });
  const report = byDuration(posts);
  const short = report.rows.find((r) => r.key === 'u15');
  const mid = report.rows.find((r) => r.key === 'u35');
  assert.equal(short.n, 1);
  assert.equal(mid.n, 2);
  assert.ok(short.lift > 0.9 && short.lift < 1.1, `short lift was ${short.lift}`);
  assert.ok(Math.abs(mid.lift) < 0.01, `mid lift was ${mid.lift}`);
});

test('bucketReport marks a thin bucket as not yet meaningful', () => {
  const posts = enrichPosts([post({ duration: 24 })], { now: NOW });
  const row = byDuration(posts).rows.find((r) => r.key === 'u25');
  assert.equal(row.n, 1);
  assert.equal(row.enough, false);
});

test('byHour returns all eight blocks in clock order', () => {
  const report = byHour(enrichPosts([post()], { now: NOW }));
  assert.deepEqual(report.rows.map((r) => r.key), ['h0', 'h3', 'h6', 'h9', 'h12', 'h15', 'h18', 'h21']);
});

test('bucketReport on nothing reports a zero baseline rather than throwing', () => {
  const report = bucketReport([], { buckets: DURATION_BUCKETS, keyOf: durationKey });
  assert.equal(report.baseline.n, 0);
  assert.equal(report.rows.length, DURATION_BUCKETS.length);
});

// ---- feeding the tag report ----

test('tagRows drops posts with no usable view count', () => {
  const posts = enrichPosts([post({ id: '1' }), post({ id: '2', views: null })], { now: NOW });
  assert.deepEqual(tagRows(posts).map((p) => p.id), ['1']);
});
