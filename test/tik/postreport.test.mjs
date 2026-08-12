import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sparkline, accountHtml, leaderboardHtml, momentumHtml,
  durationHtml, weekdayHtml, hourHtml,
} from '../../public/scripts/tik/postreport.js';
import { enrichPosts, accountSummary, leaderboard, momentum, byDuration, byWeekday } from '../../public/scripts/tik/postmetrics.js';
import { esc, count, pct, rate, duration, age } from '../../public/scripts/tik/fmt.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);
const daysAgo = (n) => Math.round((NOW - n * DAY) / 1000);
const snap = (d, v) => ({ d, v });

const post = (over = {}) => ({
  id: '1', title: 'The Thing (1982)', movie: 'The Thing', desc: '#movietrivia',
  tags: ['movietrivia'], created: daysAgo(10), duration: 24,
  url: 'https://tiktok/1', views: 1000, likes: 80, comments: 15, shares: 5,
  snaps: [snap('2026-08-27', 700), snap('2026-08-29', 900), snap('2026-08-30', 1000)],
  ...over,
});

// Every panel renders into innerHTML, so tags must balance or the panel below
// it ends up nested inside this one.
function balanced(html) {
  const open = (html.match(/<(?!\/)(?!br|img|input|hr|meta)[a-z][^>]*?(?<!\/)>/g) || []).length;
  const close = (html.match(/<\/[a-z]+>/g) || []).length;
  return open === close;
}

// ---- formatters ----

test('count abbreviates at thousands and millions and drops a trailing .0', () => {
  assert.equal(count(999), '999');
  assert.equal(count(1000), '1K');
  assert.equal(count(1234), '1.2K');
  assert.equal(count(4_000_000), '4M');
});

test('count says nothing rather than zero when there is no number', () => {
  assert.equal(count(null), '—');
  assert.equal(count(undefined), '—');
  assert.equal(count(NaN), '—');
});

test('pct and rate render a missing value as a dash', () => {
  assert.equal(pct(null), '—');
  assert.equal(rate(null), '—');
  assert.equal(pct(0.5), '+50%');
  assert.equal(pct(-0.5), '−50%');
  assert.equal(rate(0.1), '10.0%');
});

test('duration reports a photo post as having no length, not zero length', () => {
  assert.equal(duration(0), '—');
  assert.equal(duration(null), '—');
  assert.equal(duration(24), '0:24');
  assert.equal(duration(95), '1:35');
});

test('age coarsens as posts get older', () => {
  assert.equal(age(0.2), 'today');
  assert.equal(age(3), '3d');
  assert.equal(age(21), '3w');
  assert.equal(age(90), '3mo');
  assert.equal(age(400), '1.1y');
  assert.equal(age(null), '—');
});

test('esc neutralizes markup', () => {
  assert.equal(esc('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
  assert.equal(esc(null), '');
});

// ---- sparkline ----

test('sparkline refuses to draw a shape from a single interval', () => {
  // Two snapshots give one gain figure. A line through one point is a
  // straight line that says nothing, so say nothing instead.
  assert.match(sparkline([snap('2026-08-01', 10), snap('2026-08-02', 20)]), /—/);
  assert.match(sparkline([]), /—/);
  assert.match(sparkline(undefined), /—/);
});

test('sparkline draws one point per interval once there are enough', () => {
  const svg = sparkline([snap('2026-08-01', 0), snap('2026-08-02', 100), snap('2026-08-03', 150)]);
  assert.match(svg, /<svg/);
  const points = svg.match(/points="([^"]+)"/)[1].trim().split(/\s+/);
  assert.equal(points.length, 2, 'three snapshots is two intervals');
});

test('sparkline stays inside its own viewBox', () => {
  const svg = sparkline([
    snap('2026-08-01', 0), snap('2026-08-02', 5000), snap('2026-08-03', 5001), snap('2026-08-04', 9000),
  ], { width: 64, height: 18 });
  for (const pair of svg.match(/points="([^"]+)"/)[1].trim().split(/\s+/)) {
    const [x, y] = pair.split(',').map(Number);
    assert.ok(x >= 0 && x <= 64, `x ${x} out of range`);
    assert.ok(y >= 0 && y <= 18, `y ${y} out of range`);
  }
});

test('sparkline survives a completely flat history without dividing by zero', () => {
  const svg = sparkline([snap('2026-08-01', 100), snap('2026-08-02', 100), snap('2026-08-03', 100)]);
  assert.doesNotMatch(svg, /NaN|Infinity/);
});

// ---- account panel ----

test('accountHtml says velocity is not ready yet rather than showing a zero', () => {
  const posts = enrichPosts([post({ snaps: [snap('2026-08-30', 100)] })], { now: NOW });
  const html = accountHtml(accountSummary(posts, null), { snapshotDays: 1 });
  assert.match(html, /needs a second snapshot/i);
  assert.doesNotMatch(html, /picked up/);
  assert.ok(balanced(html));
});

test('accountHtml reports the catalogue gain once there are two snapshots', () => {
  const posts = enrichPosts([post()], { now: NOW });
  const html = accountHtml(accountSummary(posts, { followers: 2000 }), { snapshotDays: 3 });
  assert.match(html, /picked up/);
  assert.match(html, /3 days of snapshot history/);
  assert.ok(balanced(html));
});

test('accountHtml renders dashes rather than zeros for stats we were never given', () => {
  // Follower/like counts come from the profile; with no profile they are
  // unknown, and an unknown follower count must not render as zero followers.
  const html = accountHtml(accountSummary([], null), { snapshotDays: 0 });
  const tile = (label) => html.match(new RegExp(`${label}</p>\\s*<p[^>]*>([^<]*)</p>`))?.[1]?.trim();
  assert.equal(tile('Followers'), '—');
  assert.equal(tile('Total likes'), '—');
  assert.equal(tile('Median views'), '—');
  // "0 posts seen" is genuinely known, so it is a zero and not a dash.
  assert.equal(tile('Posts seen'), '0');
  assert.match(html, /0 days of snapshot history/);
  assert.ok(balanced(html));
});

// ---- leaderboard ----

test('leaderboardHtml escapes a hostile film title', () => {
  const posts = enrichPosts([post({ movie: '<img src=x onerror=alert(1)>', title: '' })], { now: NOW });
  const { body } = leaderboardHtml(leaderboard(posts));
  assert.match(body, /&lt;img/);
  assert.doesNotMatch(body, /<img src=x/);
});

test('leaderboardHtml escapes a hostile share url', () => {
  const posts = enrichPosts([post({ url: 'https://x/"><script>alert(1)</script>' })], { now: NOW });
  const { body } = leaderboardHtml(leaderboard(posts));
  assert.doesNotMatch(body, /<script>/);
});

test('leaderboardHtml opens post links safely in a new tab', () => {
  const { body } = leaderboardHtml(leaderboard(enrichPosts([post()], { now: NOW })));
  assert.match(body, /rel="noopener noreferrer"/);
  assert.match(body, /target="_blank"/);
});

test('leaderboardHtml still names a post that has no title at all', () => {
  const posts = enrichPosts([post({ movie: null, title: '', id: '999' })], { now: NOW });
  const { body } = leaderboardHtml(leaderboard(posts));
  assert.match(body, /Post 999/, 'a nameless row in a leaderboard is unusable');
});

test('leaderboardHtml says so plainly when there is nothing to rank', () => {
  const { body, note } = leaderboardHtml([]);
  assert.equal(note, '');
  assert.match(body, /No posts to rank yet/);
  assert.doesNotMatch(body, /<table/);
});

test('leaderboardHtml explains why it does not rank on lifetime views', () => {
  const { body } = leaderboardHtml(leaderboard(enrichPosts([post()], { now: NOW })));
  assert.match(body, /not lifetime views/);
  assert.ok(balanced(body));
});

// ---- momentum ----

test('momentumHtml distinguishes "no history yet" from "nothing grew"', () => {
  assert.match(momentumHtml([], { snapshotDays: 1 }).body, /needs two snapshots/i);
  assert.match(momentumHtml([], { snapshotDays: 5 }).body, /No post gained views/i);
});

test('momentumHtml shows the gain and the window it covers', () => {
  const posts = enrichPosts([post()], { now: NOW });
  const { body } = momentumHtml(momentum(posts), { snapshotDays: 4 });
  assert.match(body, /\+100/);
  assert.match(body, /over 1d/);
  assert.ok(balanced(body));
});

test('momentumHtml escapes post names', () => {
  const posts = enrichPosts([post({ movie: '<b>bold</b>' })], { now: NOW });
  const { body } = momentumHtml(momentum(posts), { snapshotDays: 4 });
  assert.match(body, /&lt;b&gt;/);
});

// ---- bucket tables ----

test('durationHtml files a photo post under its own row rather than as a short video', () => {
  const posts = enrichPosts([post({ duration: null })], { now: NOW });
  const { body } = durationHtml(byDuration(posts));
  assert.match(body, /Photo \/ no length/);
});

test('bucket tables never colour an under-sampled row green', () => {
  const posts = enrichPosts([
    post({ id: '1', duration: 10, created: daysAgo(10), views: 9000 }),
    post({ id: '2', duration: 30, created: daysAgo(10), views: 100 }),
  ], { now: NOW });
  const { body } = durationHtml(byDuration(posts));
  assert.doesNotMatch(body, /text-green-400/, 'n=1 is a coin flip, not a finding');
});

test('bucket tables say when there is only one bucket to compare', () => {
  const posts = enrichPosts([post({ duration: 24 }), post({ id: '2', duration: 22 })], { now: NOW });
  const { body } = durationHtml(byDuration(posts));
  assert.match(body, /nothing to compare against yet/);
});

test('weekdayHtml keeps days we have never posted on visible', () => {
  const posts = enrichPosts([post({ created: daysAgo(3) })], { now: NOW });
  const { body } = weekdayHtml(byWeekday(posts));
  for (const day of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
    assert.match(body, new RegExp(day), `${day} row is missing`);
  }
});

test('weekdayHtml and hourHtml disclose that the clock is local', () => {
  const posts = enrichPosts([post()], { now: NOW });
  assert.match(weekdayHtml(byWeekday(posts)).body, /local timezone/);
  assert.match(hourHtml({ baseline: { n: 1 }, rows: [] }).body, /local time/);
});

test('bucket tables report an empty account without throwing', () => {
  const { body, note } = durationHtml(byDuration([]));
  assert.equal(note, '');
  assert.match(body, /Not enough posts yet/);
  assert.doesNotMatch(body, /<table/);
});

test('every populated panel produces balanced markup', () => {
  const posts = enrichPosts([
    post({ id: '1' }), post({ id: '2', duration: 45, created: daysAgo(30), views: 4000 }),
  ], { now: NOW });
  const panels = [
    leaderboardHtml(leaderboard(posts)).body,
    momentumHtml(momentum(posts), { snapshotDays: 4 }).body,
    durationHtml(byDuration(posts)).body,
    weekdayHtml(byWeekday(posts)).body,
  ];
  for (const html of panels) assert.ok(balanced(html), `unbalanced: ${html.slice(0, 120)}`);
});
