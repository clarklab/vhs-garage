// Where the follower count is heading, and when it gets there.
//
// Two models, deliberately, because one number would be a fiction dressed as a
// fact:
//
//   ALL-TIME  least-squares fit over every snapshot. Steady, slow to react,
//             and the conservative bound once the account gets going.
//   RECENT    the rate over the trailing window only. Reacts to what is
//             happening now, and on an accelerating account it is the
//             optimistic bound.
//
// Showing both as a range is the honest version of "when do we hit 50k". They
// bracket it; neither is a promise. Anything with fewer than MIN_POINTS
// snapshots gets no projection at all — a straight line through two dots says
// more about the dots than the future.
//
// Compounding is deliberately not offered. It fits a young account nicely and
// then predicts a million followers by Christmas, which is the exact kind of
// number that feels great and is worth nothing.
//
// Pure — no DOM, no network, no clock of its own (callers pass `today` so this
// stays testable). Unit-tested under node:test.

export const MIN_POINTS = 3;        // below this, no projection
export const RECENT_DAYS = 14;      // trailing window for the "recent" model
export const MAX_HORIZON_DAYS = 1095; // 3 years; past this we just say "not soon"

// The round numbers worth caring about. A milestone only shows once it is above
// the current count, so this list stays useful from 400 followers to 400k.
const LADDER = [1e3, 2500, 5e3, 1e4, 25e3, 5e4, 1e5, 25e4, 5e5, 1e6];
export const MILESTONE_COUNT = 4;

const DAY_MS = 86_400_000;
const dayOf = (d) => Date.parse(`${d}T00:00:00Z`) / DAY_MS;

// ISO day string for a day-number, so projected dates round-trip through the
// same 'YYYY-MM-DD' shape the stored series uses.
export function dayToISO(day) {
  return new Date(Math.round(day) * DAY_MS).toISOString().slice(0, 10);
}

function clean(series) {
  return (Array.isArray(series) ? series : [])
    .filter((p) => p && typeof p.d === 'string' && Number.isFinite(Number(p.c)))
    .map((p) => ({ d: p.d, c: Number(p.c), t: dayOf(p.d) }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
}

// Least squares over (day, count). Returns followers/day plus r², which is how
// the UI knows whether to present the fit as a trend or as a shrug.
export function linearFit(series) {
  const s = clean(series);
  if (s.length < 2) return null;
  const t0 = s[0].t;
  const xs = s.map((p) => p.t - t0);
  const ys = s.map((p) => p.c);
  const n = s.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  // Every snapshot on one day: no slope is derivable, and pretending otherwise
  // would divide by zero.
  if (den === 0) return null;
  const perDay = num / den;
  const intercept = my - perDay * mx;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (ys[i] - (intercept + perDay * xs[i])) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);
  return { perDay, intercept, r2, n, t0 };
}

// Followers/day across the trailing `days`, measured end to end rather than
// fitted: with two weeks of points, the endpoints ARE the trend.
export function recentRate(series, days = RECENT_DAYS) {
  const s = clean(series);
  if (s.length < 2) return null;
  const last = s[s.length - 1];
  const cutoff = last.t - Math.max(1, days);
  const window = s.filter((p) => p.t >= cutoff);
  const first = window.length >= 2 ? window[0] : s[s.length - 2];
  const span = last.t - first.t;
  if (span <= 0) return null;
  return { perDay: (last.c - first.c) / span, days: span, from: first.d, n: window.length };
}

// The two models a chart can draw, newest count first.
export function models(series) {
  const s = clean(series);
  if (s.length < MIN_POINTS) return [];
  const last = s[s.length - 1];
  const fit = linearFit(s);
  const recent = recentRate(s);
  const out = [];
  if (fit) {
    out.push({ key: 'alltime', label: 'All-time pace', perDay: fit.perDay, r2: fit.r2, from: s[0].d });
  }
  if (recent && Number.isFinite(recent.perDay)) {
    out.push({ key: 'recent', label: `Last ${Math.round(recent.days)}d pace`, perDay: recent.perDay, from: recent.from });
  }
  return out.map((m) => ({ ...m, at: last.c, on: last.d }));
}

// When does `perDay` growth from (count, day) reach `target`?
// Null when it never does at this rate, or not inside MAX_HORIZON_DAYS.
export function etaDays(current, target, perDay) {
  const need = Number(target) - Number(current);
  if (!Number.isFinite(need)) return null;
  if (need <= 0) return 0;
  if (!Number.isFinite(perDay) || perDay <= 0) return null;
  const days = need / perDay;
  return days > MAX_HORIZON_DAYS ? null : days;
}

// The next few round numbers above the current count, with an ETA per model.
// `eta` is null wherever that model never gets there inside the horizon, which
// the UI renders as a dash rather than inventing a date.
export function milestones(series, count = MILESTONE_COUNT) {
  const s = clean(series);
  if (!s.length) return [];
  const last = s[s.length - 1];
  const ms = models(s);
  return LADDER
    .filter((target) => target > last.c)
    .slice(0, Math.max(1, count))
    .map((target) => ({
      target,
      etas: ms.map((m) => {
        const days = etaDays(last.c, target, m.perDay);
        return {
          key: m.key,
          label: m.label,
          days,
          date: days === null ? null : dayToISO(last.t + days),
        };
      }),
    }));
}

// Future points for plotting: `horizonDays` of straight-line growth from the
// last real snapshot. Starts AT that snapshot so the projection joins the
// history line instead of floating away from it.
export function projectSeries(series, perDay, horizonDays) {
  const s = clean(series);
  if (!s.length || !Number.isFinite(perDay)) return [];
  const last = s[s.length - 1];
  const days = Math.max(1, Math.round(horizonDays));
  const out = [];
  for (let i = 0; i <= days; i++) {
    out.push({ d: dayToISO(last.t + i), c: Math.max(0, Math.round(last.c + perDay * i)), projected: i > 0 });
  }
  return out;
}

// The straight line the all-time fit describes, sampled across the history's
// own span — the "here is the trend through what actually happened" overlay.
export function trendSeries(series) {
  const s = clean(series);
  const fit = linearFit(s);
  if (!fit || s.length < 2) return [];
  return s.map((p) => ({
    d: p.d,
    c: Math.max(0, Math.round(fit.intercept + fit.perDay * (p.t - fit.t0))),
  }));
}

// How far out to plot.
//
// Aimed at the SECOND milestone, not the first: when the next one is ten days
// out, a chart that stops just past it shows a stub and answers nothing about
// where this is going. Reaching one rung further puts a milestone comfortably
// mid-chart with runway behind it, which is the view worth looking at.
//
// Floored at MIN_HORIZON_DAYS so a near milestone still gets a real runway, and
// capped because a 90-a-day account should not render three years wide to fit
// 1M on screen.
const MIN_HORIZON_DAYS = 75;
export function horizonFor(series, { maxDays = 400 } = {}) {
  const ladder = milestones(series, 2);
  if (!ladder.length) return MIN_HORIZON_DAYS;
  const aim = ladder[1] || ladder[0];
  const reachable = aim.etas.map((e) => e.days).filter((d) => Number.isFinite(d));
  if (!reachable.length) return MIN_HORIZON_DAYS;
  // The fastest model gets there first; pad so its arrival is not jammed
  // against the right edge.
  return Math.min(maxDays, Math.max(MIN_HORIZON_DAYS, Math.round(Math.min(...reachable) * 1.15)));
}

// ---- rendering the milestone table ----
//
// Markup lives here, next to the math it describes, so it can be unit-tested
// and eyeballed without a signed-in TikTok session. app.js only assigns it.

const fmt = (n) => Number(n).toLocaleString('en-US');
const short = (n) => (n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${n / 1e3}K` : String(n));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// "in 3 weeks" reads better than a bare date for anything close, and a date
// reads better than "in 41 weeks" for anything far. Give both.
function whenText(eta) {
  if (!eta || eta.days === null) return '<span class="text-neutral-700">—</span>';
  const d = Math.round(eta.days);
  const near = d <= 90
    ? (d <= 1 ? 'tomorrow' : d < 14 ? `in ${d} days` : `in ${Math.round(d / 7)} weeks`)
    : `in ${Math.round(d / 30.4)} months`;
  const date = new Date(`${eta.date}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  return `<span class="text-neutral-200">${esc(date)}</span> <span class="text-neutral-600">${esc(near)}</span>`;
}

// → HTML for the forecast panel, or a plain sentence when there is not enough
// history to say anything. Never renders a date it did not compute.
export function forecastHtml(series) {
  const ms = models(series);
  if (!ms.length) {
    const have = (Array.isArray(series) ? series : []).length;
    return `<p class="text-xs leading-relaxed text-neutral-500">Not enough history to project yet — ${have} snapshot${have === 1 ? '' : 's'} so far, and it takes ${MIN_POINTS}. Open the studio on a few different days and this fills in.</p>`;
  }
  const rows = milestones(series);
  const byKey = Object.fromEntries(ms.map((m) => [m.key, m]));
  const paceLine = ms
    .map((m) => `<span class="text-neutral-400">${esc(m.label)}</span> <span class="tabular-nums text-neutral-200">${m.perDay >= 0 ? '+' : '−'}${fmt(Math.abs(Math.round(m.perDay)))}/day</span>`)
    .join('<span class="px-1.5 text-neutral-700">·</span>');

  const body = rows.length ? `
    <div class="overflow-x-auto">
      <table class="w-full min-w-[20rem] text-xs">
        <thead>
          <tr class="text-[10px] uppercase tracking-wide text-neutral-600">
            <th class="py-1 pr-3 text-left font-semibold">Milestone</th>
            ${ms.map((m) => `<th class="py-1 pr-3 text-left font-semibold">${esc(m.label)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td class="py-1 pr-3 font-bold tabular-nums text-neutral-100">${short(r.target)}</td>
              ${ms.map((m) => `<td class="py-1 pr-3">${whenText(r.etas.find((e) => e.key === m.key))}</td>`).join('')}
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '<p class="text-xs text-neutral-500">Past every milestone on the ladder. Time for bigger numbers.</p>';

  // The caveat is not boilerplate: two straight lines through a month of data
  // are a bracket, not a plan, and the panel should say which one it is.
  const r2 = byKey.alltime?.r2;
  const fitNote = Number.isFinite(r2)
    ? ` The all-time line explains ${Math.round(r2 * 100)}% of the variation so far.`
    : '';
  return `
    <p class="mb-2 text-[11px]">${paceLine}</p>
    ${body}
    <p class="mt-3 text-[11px] leading-relaxed text-neutral-600">
      Two straight lines through ${ms[0] ? fmt((Array.isArray(series) ? series : []).length) : '0'} snapshots, not a plan.
      Real growth is lumpy, one video can move a month of this, and neither line knows that.${esc(fitNote)}
    </p>`;
}
