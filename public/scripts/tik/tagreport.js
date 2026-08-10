// Which hashtags are actually earning their slot.
//
// TikTok exposes no hashtag volume data to us: the Creative Center endpoint
// answers "no permission" without an ads login, and /tag/<name> pages serve a
// shell with no counts in them. So we cannot know how big #movietok is, and any
// number claiming otherwise would be invented.
//
// What we CAN see is our own history. tik-history returns view/like/comment/
// share counts plus the description of every post, and the description still
// contains the tags that shipped. Reading them back off the post itself, rather
// than off our local library, keeps this honest for hand-edited posts and for
// posts made on a device whose library we no longer have.
//
// Medians, not means: one breakout post would otherwise drag a whole row and
// invent a winner. And every row carries its own `n`, because at a handful of
// posts per set this is noise, and a report that hides its sample size implies
// a confidence it has not earned.
//
// Pure — no DOM, no network. Unit-tested under node:test.

import { HOUSE_SETS } from './hashtags.js';

// Below this many posts, a row is shown but marked as not yet meaning anything.
export const MIN_SAMPLE = 4;

const TAG_RE = /(^|[\s\n(])#([a-zA-Z0-9_]+)/g;

// Tags as they shipped, lowercased and deduped. The leading-boundary group
// keeps "no#tag" (a hash mid-word) from reading as a hashtag.
export function parseTags(description) {
  if (typeof description !== 'string' || !description) return [];
  const out = [];
  const seen = new Set();
  for (const m of description.matchAll(TAG_RE)) {
    const tag = m[2].toLowerCase();
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

export function median(list) {
  const nums = (Array.isArray(list) ? list : []).filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// (likes + comments + shares) / views. Null when there are no views to divide
// by — a post with no views has no rate, which is not the same as a rate of 0.
function engagementRate(row) {
  const views = Number(row.views);
  if (!Number.isFinite(views) || views <= 0) return null;
  const eng = ['likes', 'comments', 'shares']
    .reduce((sum, k) => sum + (Number.isFinite(Number(row[k])) ? Number(row[k]) : 0), 0);
  return eng / views;
}

// A row's tags, however the caller has them: an explicit array (what
// summarizeHistory now provides) or still inside the description text.
function tagsOf(row) {
  if (Array.isArray(row?.tags) && row.tags.length) {
    return [...new Set(row.tags.map((t) => String(t ?? '').toLowerCase()).filter(Boolean))];
  }
  return parseTags(row?.description ?? row?.video_description);
}

function summarize(rows, baselineViews) {
  const views = rows.map((r) => Number(r.views)).filter(Number.isFinite);
  const rates = rows.map(engagementRate).filter((r) => r !== null);
  const medianViews = median(views);
  const lift = medianViews !== null && Number.isFinite(baselineViews) && baselineViews > 0
    ? medianViews / baselineViews - 1
    : null;
  return {
    n: rows.length,
    medianViews,
    medianEngagement: median(rates),
    lift,
    enough: rows.length >= MIN_SAMPLE,
  };
}

// rows: [{ movie, views, likes, comments, shares, tags? , description? }]
//
// A post is credited to a house set only when it carried BOTH of that set's
// tags. Half a set is not that set: crediting on one tag would let a legacy
// post that happens to carry #movietok count as the filmtok experiment.
//
// Sets are not a partition — if two sets ever shared a tag a post could count
// toward both — so the per-set `n` may not sum to the baseline `n`.
export function tagReport(rows) {
  const clean = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({ ...r, tags: tagsOf(r) }))
    .filter((r) => r.tags.length);

  const baseline = summarize(clean, null);
  const baseViews = baseline.medianViews;

  const bySet = HOUSE_SETS.map((set) => {
    const hits = clean.filter((r) => set.tags.every((t) => r.tags.includes(t)));
    return { key: set.key, label: set.label, tags: set.tags, ...summarize(hits, baseViews) };
  });

  const byTagMap = new Map();
  for (const r of clean) {
    for (const tag of r.tags) {
      if (!byTagMap.has(tag)) byTagMap.set(tag, []);
      byTagMap.get(tag).push(r);
    }
  }
  const byTag = [...byTagMap.entries()]
    .map(([tag, hits]) => ({ tag, ...summarize(hits, baseViews) }))
    // Sample size first: a tag used once that happened to do well is not a
    // finding, and sorting on median alone would put it at the top.
    .sort((a, b) => (b.n - a.n) || ((b.medianViews ?? -1) - (a.medianViews ?? -1)));

  return { baseline, bySet, byTag };
}

// ---- rendering ----
//
// The report's markup lives here rather than in app.js so it can be unit-tested
// and eyeballed without a signed-in TikTok session: tagReportHtml(report) is a
// pure function of the numbers. app.js only fetches and assigns.

const TOP_TAGS = 8;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function count(n) {
  const v = Math.round(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(v);
}

const pct = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(Math.round(n * 100))}%`;
const rate = (n) => (n === null ? '—' : `${(n * 100).toFixed(1)}%`);

// Grey until the sample could plausibly mean something: coloring an n=1 row
// green dresses up a coin flip as a finding.
function liftCell(row) {
  if (row.lift === null || !row.n) return '<span class="text-neutral-700">—</span>';
  const tone = !row.enough ? 'text-neutral-500'
    : row.lift > 0.05 ? 'text-green-400'
      : row.lift < -0.05 ? 'text-red-400' : 'text-neutral-400';
  return `<span class="${tone}">${pct(row.lift)}</span>`;
}

function rows(list, labelOf) {
  return list.map((r) => `
    <tr class="${r.enough ? '' : 'text-neutral-500'}">
      <td class="py-1 pr-3">${labelOf(r)}</td>
      <td class="py-1 pr-3 text-right tabular-nums">${r.n || '—'}</td>
      <td class="py-1 pr-3 text-right tabular-nums">${r.medianViews === null ? '—' : count(r.medianViews)}</td>
      <td class="py-1 pr-3 text-right tabular-nums">${rate(r.medianEngagement)}</td>
      <td class="py-1 text-right font-semibold tabular-nums">${liftCell(r)}</td>
    </tr>`).join('');
}

const HEAD = `
  <tr class="text-[10px] uppercase tracking-wide text-neutral-600">
    <th class="py-1 pr-3 text-left font-semibold">Tag set</th>
    <th class="py-1 pr-3 text-right font-semibold">Posts</th>
    <th class="py-1 pr-3 text-right font-semibold">Med. views</th>
    <th class="py-1 pr-3 text-right font-semibold">Eng.</th>
    <th class="py-1 text-right font-semibold">vs median</th>
  </tr>`;

// → { note, body }: the header line and the panel's inner HTML.
export function tagReportHtml(report) {
  const { baseline, bySet, byTag } = report;

  // No tagged posts is what a fresh account looks like, not an error. Say so
  // rather than rendering an empty grid that reads like a finding.
  if (!baseline.n) {
    return {
      note: '',
      body: '<p class="text-xs leading-relaxed text-neutral-500">No hashtags found in your posted trivia yet. Once a few posts ship with the new tag sets, this fills in.</p>',
    };
  }

  const shipped = bySet.filter((s) => s.n > 0).length;
  const tags = byTag.slice(0, TOP_TAGS);
  const note = `${baseline.n} tagged post${baseline.n === 1 ? '' : 's'} · median ${count(baseline.medianViews)} views`;

  const body = `
    <div class="overflow-x-auto">
      <table class="w-full min-w-[22rem] text-xs text-neutral-300">
        <thead>${HEAD}</thead>
        <tbody>${rows(bySet, (r) => `
          <span class="font-semibold text-neutral-200">${esc(r.label)}</span>
          <span class="ml-1.5 text-[11px] text-neutral-600">${esc(r.tags.map((t) => `#${t}`).join(' '))}</span>`)}
        </tbody>
      </table>
      ${tags.length ? `
        <p class="mt-4 text-[10px] font-semibold uppercase tracking-wide text-neutral-600">Individual tags</p>
        <table class="mt-1 w-full min-w-[22rem] text-xs text-neutral-300">
          <tbody>${rows(tags, (r) => `<span class="text-neutral-200">#${esc(r.tag)}</span>`)}</tbody>
        </table>` : ''}
    </div>
    <p class="mt-3 text-[11px] leading-relaxed text-neutral-600">
      Rows under ${MIN_SAMPLE} posts are greyed out: too few to mean anything yet, so treat this as a nudge and not a verdict.${
        shipped < 2 ? ' Only one house set has shipped so far, so there is nothing to compare it against.' : ''}
      TikTok publishes no hashtag volume data, so these are your numbers only.
    </p>`;

  return { note, body };
}
