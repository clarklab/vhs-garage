// The Reports screen's markup.
//
// Every export here is a pure function of numbers to an HTML string, for the
// reason tagreport.js gives: a report you can only look at by signing in to
// TikTok and waiting for a live fetch is a report nobody checks. These render
// from fixtures in the test suite.
//
// reports.js fetches and assigns. Nothing in this file touches the DOM.
//
// Unit-tested under node:test.

import { esc, count, pct, rate, duration, age } from './fmt.js';
import { gainSeries, WEEKDAYS } from './postmetrics.js';
import { MIN_SAMPLE } from './tagreport.js';

// Matches the follower chart's amber (see stats.js SERIES.history) so the two
// surfaces read as one tool.
const LINE = '#d97706';
const DIM = 'text-neutral-600';

// ---- shared bits ----

function empty(message) {
  return `<p class="text-xs leading-relaxed text-neutral-500">${esc(message)}</p>`;
}

// Grey until the sample could plausibly mean something. Same rule as the tag
// report: colouring an n=1 row green dresses up a coin flip as a finding.
function liftCell(row) {
  if (row.lift === null || row.lift === undefined || !row.n) return `<span class="text-neutral-700">—</span>`;
  const tone = !row.enough ? 'text-neutral-500'
    : row.lift > 0.05 ? 'text-green-400'
      : row.lift < -0.05 ? 'text-red-400' : 'text-neutral-400';
  return `<span class="${tone}">${pct(row.lift)}</span>`;
}

// An inline SVG sparkline of views-per-day between snapshots. No library, no
// canvas — it sits inside a table cell and must survive innerHTML.
//
// Fewer than two intervals is not a shape. Rather than draw a misleading
// straight line we say nothing, and the caller's copy explains why.
export function sparkline(snaps, { width = 64, height = 18 } = {}) {
  const series = gainSeries(snaps);
  if (series.length < 2) return `<span class="${DIM}">—</span>`;

  const vals = series.map((s) => s.perDay);
  const hi = Math.max(...vals);
  const lo = Math.min(...vals);
  const span = hi - lo || 1;
  const stepX = width / (series.length - 1);
  // 1px inset top and bottom so a flat line at either extreme is not clipped
  // to invisibility against the cell edge.
  const points = series.map((s, i) => {
    const x = i * stepX;
    const y = height - 1 - ((s.perDay - lo) / span) * (height - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="inline-block align-middle" aria-hidden="true" preserveAspectRatio="none"><polyline points="${points}" fill="none" stroke="${LINE}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// ---- the account ----

function tile(label, value, sub = '') {
  return `
    <div class="rounded-xl border border-neutral-800 bg-neutral-950/40 px-3 py-2.5">
      <p class="text-[10px] uppercase tracking-[0.15em] text-neutral-600">${esc(label)}</p>
      <p class="mt-0.5 text-lg font-extrabold tabular-nums text-neutral-100">${value}</p>
      ${sub ? `<p class="text-[11px] ${DIM}">${esc(sub)}</p>` : ''}
    </div>`;
}

export function accountHtml(summary, { snapshotDays = 0 } = {}) {
  const s = summary || {};
  const tiles = [
    tile('Followers', count(s.followers)),
    tile('Following', count(s.following)),
    tile('Total likes', count(s.likes)),
    tile('Posts seen', count(s.posts), s.videos ? `${count(s.videos)} on the account` : ''),
    tile('Total views', count(s.totalViews), 'across posts we can read'),
    tile('Median views', count(s.medianViews), 'per post, lifetime'),
    tile('Median / day', count(s.medianPerDay), 'age-adjusted'),
    tile('Engagement', rate(s.medianEngagement), 'median, likes+comments+shares'),
  ].join('');

  // The one number that says whether the catalogue as a whole is still
  // working. Absent until there are two snapshots to subtract.
  const gain = Number.isFinite(s.recentGain)
    ? `<p class="mt-3 text-xs text-neutral-400">Since the last snapshot the catalogue picked up
         <span class="font-semibold tabular-nums text-green-400">${count(s.recentGain)}</span> views
         across ${count(s.recentPosts)} post${s.recentPosts === 1 ? '' : 's'}.</p>`
    : `<p class="mt-3 text-xs ${DIM}">Velocity needs a second snapshot — open this screen again tomorrow and it fills in.</p>`;

  return `
    <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">${tiles}</div>
    ${gain}
    <p class="mt-1 text-[11px] ${DIM}">${snapshotDays} day${snapshotDays === 1 ? '' : 's'} of snapshot history stored.</p>`;
}

// ---- the leaderboard ----

const LEADER_HEAD = `
  <tr class="text-[10px] uppercase tracking-wide text-neutral-600">
    <th class="py-1 pr-3 text-left font-semibold">Post</th>
    <th class="py-1 pr-3 text-right font-semibold">Age</th>
    <th class="py-1 pr-3 text-right font-semibold">Len</th>
    <th class="py-1 pr-3 text-right font-semibold">Views</th>
    <th class="py-1 pr-3 text-right font-semibold">Per day</th>
    <th class="py-1 pr-3 text-right font-semibold">Eng.</th>
    <th class="py-1 text-right font-semibold">Trend</th>
  </tr>`;

// The post's own name for itself: the parsed film title when we can read one,
// otherwise the raw title, otherwise the id. Never blank — a nameless row in a
// leaderboard is unusable.
function postLabel(p) {
  const name = p.movie || p.title || `Post ${p.id}`;
  const label = `<span class="font-semibold text-neutral-200">${esc(name)}</span>`;
  // rel=noopener because these open tiktok.com in a new tab.
  return p.url
    ? `<a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" class="hover:underline">${label}</a>`
    : label;
}

function leaderRow(p) {
  return `
    <tr class="border-t border-neutral-900">
      <td class="max-w-[16rem] truncate py-1.5 pr-3">${postLabel(p)}</td>
      <td class="py-1.5 pr-3 text-right tabular-nums ${DIM}">${esc(age(p.ageDays))}</td>
      <td class="py-1.5 pr-3 text-right tabular-nums ${DIM}">${esc(duration(p.duration))}</td>
      <td class="py-1.5 pr-3 text-right tabular-nums text-neutral-200">${count(p.views)}</td>
      <td class="py-1.5 pr-3 text-right font-semibold tabular-nums text-neutral-100">${count(p.viewsPerDay)}</td>
      <td class="py-1.5 pr-3 text-right tabular-nums ${DIM}">${rate(p.engagement)}</td>
      <td class="py-1.5 text-right">${sparkline(p.snaps)}</td>
    </tr>`;
}

export function leaderboardHtml(posts) {
  const list = Array.isArray(posts) ? posts : [];
  if (!list.length) {
    return { note: '', body: empty('No posts to rank yet. Connect post history and this fills in.') };
  }
  return {
    note: 'ranked by views per day',
    body: `
      <div class="overflow-x-auto">
        <table class="w-full min-w-[34rem] text-xs text-neutral-300">
          <thead>${LEADER_HEAD}</thead>
          <tbody>${list.map(leaderRow).join('')}</tbody>
        </table>
      </div>
      <p class="mt-3 text-[11px] leading-relaxed ${DIM}">
        Ranked on views per day since posting, not lifetime views — otherwise this is partly a list of
        your oldest posts. Trend is views per day between snapshots: falling is normal, flat-then-rising
        means a post got picked up again.
      </p>`,
  };
}

// ---- momentum ----

export function momentumHtml(posts, { snapshotDays = 0 } = {}) {
  const list = Array.isArray(posts) ? posts : [];
  if (!list.length) {
    return {
      note: '',
      body: empty(snapshotDays < 2
        ? 'Nothing to compare yet. This panel needs two snapshots on different days — open the studio tomorrow and it starts working.'
        : 'No post gained views since the last snapshot.'),
    };
  }

  const rows = list.map((p) => `
    <tr class="border-t border-neutral-900">
      <td class="max-w-[18rem] truncate py-1.5 pr-3">${postLabel(p)}</td>
      <td class="py-1.5 pr-3 text-right tabular-nums ${DIM}">${esc(age(p.ageDays))}</td>
      <td class="py-1.5 pr-3 text-right font-semibold tabular-nums text-green-400">+${count(p.recent.gain)}</td>
      <td class="py-1.5 pr-3 text-right tabular-nums ${DIM}">over ${p.recent.days}d</td>
      <td class="py-1.5 text-right tabular-nums ${
        Number.isFinite(p.momentum) && p.momentum > 1.2 ? 'text-green-400' : DIM
      }">${Number.isFinite(p.momentum) ? `${p.momentum.toFixed(1)}×` : '—'}</td>
    </tr>`).join('');

  return {
    note: 'views gained since the last snapshot',
    body: `
      <div class="overflow-x-auto">
        <table class="w-full min-w-[30rem] text-xs text-neutral-300">
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="mt-3 text-[11px] leading-relaxed ${DIM}">
        The last column compares a post's current rate against its own lifetime average. Above 1× means it is
        outrunning its own history — that is the signal worth chasing with a follow-up post on the same film.
      </p>`,
  };
}

// ---- generic bucket tables (length, weekday, time of day) ----

function bucketRow(r) {
  return `
    <tr class="${r.enough ? '' : 'text-neutral-500'}">
      <td class="py-1 pr-3">${esc(r.label)}</td>
      <td class="py-1 pr-3 text-right tabular-nums">${r.n || '—'}</td>
      <td class="py-1 pr-3 text-right tabular-nums">${count(r.medianViews)}</td>
      <td class="py-1 pr-3 text-right tabular-nums">${count(r.medianPerDay)}</td>
      <td class="py-1 text-right font-semibold tabular-nums">${liftCell(r)}</td>
    </tr>`;
}

const BUCKET_HEAD = (first) => `
  <tr class="text-[10px] uppercase tracking-wide text-neutral-600">
    <th class="py-1 pr-3 text-left font-semibold">${esc(first)}</th>
    <th class="py-1 pr-3 text-right font-semibold">Posts</th>
    <th class="py-1 pr-3 text-right font-semibold">Med. views</th>
    <th class="py-1 pr-3 text-right font-semibold">Per day</th>
    <th class="py-1 text-right font-semibold">vs median</th>
  </tr>`;

export function bucketHtml(report, { first = 'Bucket', caveat = '' } = {}) {
  const rows = report?.rows || [];
  const baseline = report?.baseline || { n: 0 };
  if (!baseline.n) {
    return { note: '', body: empty('Not enough posts yet to break this down.') };
  }

  // Rows that have never happened are shown, not hidden: "we have never posted
  // on a Tuesday" is a finding, and dropping the row hides it.
  const tried = rows.filter((r) => r.n > 0).length;

  return {
    note: `${baseline.n} post${baseline.n === 1 ? '' : 's'}`,
    body: `
      <div class="overflow-x-auto">
        <table class="w-full min-w-[26rem] text-xs text-neutral-300">
          <thead>${BUCKET_HEAD(first)}</thead>
          <tbody>${rows.map(bucketRow).join('')}</tbody>
        </table>
      </div>
      <p class="mt-3 text-[11px] leading-relaxed ${DIM}">
        Compared on views per day against your overall median. Rows under ${MIN_SAMPLE} posts are greyed out.${
          tried < 2 ? ' Only one bucket has anything in it, so there is nothing to compare against yet.' : ''}
        ${esc(caveat)}
      </p>`,
  };
}

export function durationHtml(report) {
  return bucketHtml(report, {
    first: 'Length',
    caveat: 'Length is a lever you control directly — if a bucket is consistently ahead, cut to it.',
  });
}

export function weekdayHtml(report) {
  return bucketHtml(report, {
    first: 'Day posted',
    caveat: 'Day and time are in your local timezone.',
  });
}

export function hourHtml(report) {
  return bucketHtml(report, {
    first: 'Time posted',
    caveat: 'Three-hour blocks, local time. TikTok keeps serving a post for weeks, so this moves slowly — treat a lead under a dozen posts per block as a hint.',
  });
}

export { WEEKDAYS };
