// Follower stats for the home screen: fetch/snapshot via tik-stats, and a
// dependency-free canvas line chart (single series, hero number lives in HTML).
// TikTok has no history API, so the series grows one point per day of use.
import { getRefreshToken } from './auth.js';
import { models, projectSeries, trendSeries, horizonFor, milestones, MIN_POINTS } from './forecast.js';

const LS_LAST_SNAP = 'tik_stats_last_snap';
const SNAP_INTERVAL_MS = 60 * 60 * 1000; // at most one POST snapshot per hour

// Returns { series, profile? } — POSTs a fresh snapshot when signed in (rate-
// limited), otherwise GETs the stored series. Throws { reauth } on dead tokens.
export async function fetchFollowerStats({ force = false } = {}) {
  const refreshToken = getRefreshToken();
  const lastSnap = Number(localStorage.getItem(LS_LAST_SNAP) || 0);
  if (refreshToken && (force || Date.now() - lastSnap > SNAP_INTERVAL_MS)) {
    const res = await fetch('/.netlify/functions/tik-stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw Object.assign(new Error(data.error || 'Sign in again'), { reauth: true });
    if (!res.ok) throw Object.assign(new Error(data.error || 'Stats unavailable'), { scope: !!data.scope, hint: data.hint || '' });
    localStorage.setItem(LS_LAST_SNAP, String(Date.now()));
    return data;
  }
  const res = await fetch('/.netlify/functions/tik-stats');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Stats unavailable');
  return data;
}

export const fmtCount = (n) => Number(n).toLocaleString('en-US');
const fmtDate = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// Palette. Validated as a categorical set against this card's own dark surface
// (#171717): lightness band, chroma floor, CVD separation, normal-vision floor,
// and 3:1 contrast all pass. The amber is the brand's, kept because it passed;
// the projection hues were re-stepped for the dark band after the first pair I
// reached for (cyan/violet) came back too light to sit on this surface.
//
// The CVD margin lands in the band where secondary encoding is required, which
// is why the projections are also dashed, legended, and end-labelled — identity
// never rests on hue alone here.
const SERIES = {
  history: '#d97706',   // amber — what actually happened
  alltime: '#199e70',   // aqua  — the conservative pace
  recent: '#3987e5',    // blue  — the recent pace
};
const LINE = SERIES.history;
// Post markers are an ANNOTATION on the follower line, not a fourth series, so
// they take an ink tone rather than a fourth hue. Adding one would have had to
// clear the categorical checks against the three already there, and would have
// read as another thing being measured rather than as events on the one line.
const POST_MARK = '#e7e5e4';
const GRID = '#262626';       // neutral-800
const INK_MUTED = '#737373';  // neutral-500
const INK_DIM = '#525252';    // neutral-600
const INK = '#f5f5f4';        // neutral-100
const SURFACE = '#171717';    // neutral-900, the stats card's own background
const PAD = { top: 16, right: 16, bottom: 26, left: 10 };
const FONT = '500 10px Inter, system-ui, sans-serif';
const FONT_BOLD = '700 11px Inter, system-ui, sans-serif';

export const CHART_MODES = ['history', 'forecast'];
export const CHART_STYLES = ['area', 'bars', 'retro'];

// rgba() from a hex, for the gradient fills.
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Legend as real HTML: selectable, screen-readable, and present whenever there
// is more than one series — identity is never carried by colour alone.
// `dot: true` draws the swatch as a marker rather than a line. A key has to
// show the mark it is keying: a line swatch beside "Posts" says the posts are
// another series running across the chart, which is not what is on it.
function renderLegend(el, entries) {
  if (!el) return;
  el.innerHTML = entries.map((e) => {
    const swatch = e.dot
      ? `<span class="inline-block h-2 w-2 rounded-full" style="background:${e.color}"></span>`
      : `<span class="inline-block h-0.5 w-4 rounded-full" style="background:${e.color};${e.dashed ? 'mask-image:repeating-linear-gradient(90deg,#000 0 4px,transparent 4px 7px);-webkit-mask-image:repeating-linear-gradient(90deg,#000 0 4px,transparent 4px 7px)' : ''}"></span>`;
    return `
    <span class="inline-flex items-center gap-1.5 text-[11px] text-neutral-400">
      ${swatch}
      ${e.label}
    </span>`;
  }).join('');
}

// Draw the series onto `canvas` (dpr-aware) and wire a crosshair + tooltip.
//
// `mode` is WHAT is plotted — 'history' (what happened, plus the least-squares
// fit through it) or 'forecast' (both paces extended past a "now" divider).
// `style` is HOW it looks, and all three are shipped so the choice can be made
// against real numbers rather than a mockup:
//
//   area   filled projection cone — the widening wedge IS the uncertainty
//   bars   daily-gain bars under the cumulative line, for day-to-day texture
//   retro  stepped fill with scanlines and mono labels, the house look
//
// Everything right of "now" is dashed and differently coloured in every style.
// Nothing there is a measurement and the chart never lets that blur.
// Where each post sits on the follower line.
//
// Pure, so the placement is testable without a canvas.
//
// A post lands on the line rather than on the axis: the question the dots
// answer is "what was growth doing when I posted", and that reading only works
// if the mark is at the value for that moment. The chart draws straight
// segments between daily points, so interpolating between the two surrounding
// days puts the dot exactly on the stroke rather than near it.
//
// Posts are grouped by day and carry a count, because four a day would
// otherwise stack into one dot that silently claims to be one post.
export function postMarkers(series, posts) {
  const s = (Array.isArray(series) ? series : []).filter((p) => p?.d && Number.isFinite(Number(p.c)));
  if (!s.length) return [];
  const at = (d) => Date.parse(`${d}T00:00:00Z`);
  const first = at(s[0].d);
  const last = at(s[s.length - 1].d);

  const byDay = new Map();
  for (const raw of Array.isArray(posts) ? posts : []) {
    const t = typeof raw === 'number' ? raw : Date.parse(raw);
    if (!Number.isFinite(t)) continue;
    const day = new Date(t).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }

  // The follower count on a given day, read off the line the chart draws.
  const countAt = (t) => {
    if (t <= first) return Number(s[0].c);
    if (t >= last) return Number(s[s.length - 1].c);
    for (let i = 1; i < s.length; i++) {
      const b = at(s[i].d);
      if (b < t) continue;
      const a = at(s[i - 1].d);
      const span = b - a;
      const k = span > 0 ? (t - a) / span : 0;
      return Number(s[i - 1].c) + k * (Number(s[i].c) - Number(s[i - 1].c));
    }
    return Number(s[s.length - 1].c);
  };

  const out = [];
  for (const [d, count] of byDay) {
    const t = at(d);
    // A post from before the chart starts has nowhere honest to sit.
    if (!Number.isFinite(t) || t < first || t > last) continue;
    out.push({ d, count, c: countAt(t) });
  }
  return out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
}

export function renderFollowerChart(canvas, series, tipEl, {
  mode = 'history', style = 'area', legendEl = null, animate = false, posts = [],
} = {}) {
  // A canvas measured while (an ancestor is) hidden reads 0 wide; falling back
  // blind stretches the raster AND breaks hover hit-testing. Prefer the parent.
  const cssW = canvas.clientWidth || canvas.parentElement?.clientWidth || 600;
  const cssH = canvas.clientHeight || 256;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const s = series;
  const plotW = cssW - PAD.left - PAD.right;
  if (!s.length || plotW < 40) return;

  const forecasting = mode === 'forecast' && s.length >= MIN_POINTS;
  const paces = forecasting ? models(s) : [];
  const horizon = forecasting ? horizonFor(s) : 0;
  const projections = paces
    .map((m) => ({ ...m, pts: projectSeries(s, m.perDay, horizon) }))
    .filter((p) => p.pts.length > 1);
  const trend = mode === 'history' ? trendSeries(s) : [];

  // 'bars' gives the lower third to the daily-gain histogram, so the cumulative
  // line gets a shorter band. The other two use the full height.
  const barsOn = style === 'bars';
  const fullH = cssH - PAD.top - PAD.bottom;
  const gainH = barsOn ? Math.round(fullH * 0.34) : 0;
  const plotH = barsOn ? fullH - gainH - 10 : fullH;
  const gainTop = PAD.top + plotH + 10;

  const t0 = Date.parse(`${s[0].d}T00:00:00Z`);
  const lastReal = Date.parse(`${s[s.length - 1].d}T00:00:00Z`);
  const futureEnd = projections.reduce(
    (mx, p) => Math.max(mx, Date.parse(`${p.pts[p.pts.length - 1].d}T00:00:00Z`)), lastReal,
  );
  const span = Math.max(1, Math.max(lastReal, futureEnd) - t0);

  const counts = s.map((p) => p.c);
  const projCounts = projections.flatMap((p) => p.pts.map((q) => q.c));
  const allC = projCounts.length ? [...counts, ...projCounts] : counts;
  // Area and retro fill down to a baseline, so they read as a mass only when
  // that baseline is zero; the line-led style keeps a tight range instead.
  const filled = style !== 'bars';
  let lo = filled && forecasting ? 0 : Math.min(...allC);
  let hi = Math.max(...allC);
  const headroom = Math.max(Math.round((hi - lo) * 0.10), Math.max(2, Math.round(hi * 0.02)));
  if (!(filled && forecasting)) lo = Math.max(0, lo - headroom);
  hi += headroom;

  const bands = forecasting
    ? milestones(s).filter((m) => m.target > lo && m.target <= hi)
    : [];

  const xAt = (d) => PAD.left + ((Date.parse(`${d}T00:00:00Z`) - t0) / span) * plotW;
  const y = (c) => PAD.top + (1 - (c - lo) / (hi - lo)) * plotH;
  const place = (list, isHistory = false) => list.map((p) => ({
    ...p, px: isHistory && s.length === 1 ? PAD.left + plotW / 2 : xAt(p.d), py: y(p.c),
  }));
  const pts = place(s, true);
  // One dot per DAY that had posts, sitting on the line at that day's value.
  const marks = place(postMarkers(s, posts));
  const trendPts = place(trend);
  const projPts = projections.map((p) => ({ ...p, pts: place(p.pts) }));

  renderLegend(legendEl, [
    { label: 'Followers', color: SERIES.history },
    ...(marks.length ? [{ label: 'Posts', color: POST_MARK, dot: true }] : []),
    ...(mode === 'history' && trendPts.length
      ? [{ label: 'All-time trend', color: INK_MUTED, dashed: true }] : []),
    ...projPts.map((p) => ({ label: p.label, color: SERIES[p.key] || INK_MUTED, dashed: true })),
  ]);

  // ---- shared primitives ----
  const trace = (list, stepped) => {
    ctx.beginPath();
    list.forEach((p, i) => {
      if (!i) { ctx.moveTo(p.px, p.py); return; }
      if (stepped) ctx.lineTo(p.px, list[i - 1].py);
      ctx.lineTo(p.px, p.py);
    });
  };
  const stroke = (list, { color, width = 2, dash = null, glow = 0, stepped = false }) => {
    if (list.length < 2) return;
    ctx.save();
    ctx.setLineDash(dash || []);
    ctx.lineJoin = stepped ? 'miter' : 'round';
    ctx.lineCap = stepped ? 'butt' : 'round';
    if (glow) { ctx.shadowColor = rgba(color, 0.55); ctx.shadowBlur = glow; }
    trace(list, stepped);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.restore();
  };
  const fillUnder = (list, color, a1, a2, stepped = false) => {
    if (list.length < 2) return;
    trace(list, stepped);
    ctx.lineTo(list[list.length - 1].px, PAD.top + plotH);
    ctx.lineTo(list[0].px, PAD.top + plotH);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + plotH);
    g.addColorStop(0, rgba(color, a1));
    g.addColorStop(1, rgba(color, a2));
    ctx.fillStyle = g;
    ctx.fill();
  };
  const ringDot = (p, color, r = 4) => {
    ctx.beginPath(); ctx.arc(p.px, p.py, r + 2, 0, Math.PI * 2);
    ctx.fillStyle = SURFACE; ctx.fill();
    ctx.beginPath(); ctx.arc(p.px, p.py, r, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
  };

  const chrome = () => {
    const mono = style === 'retro';
    ctx.font = mono ? '500 10px ui-monospace, SFMono-Regular, Menlo, monospace' : FONT;
    // Milestone rules. In area they are barely-there hairlines; in retro they
    // are the furniture; in bars they sit behind the cumulative line.
    for (const b of bands) {
      const by = y(b.target);
      ctx.save();
      ctx.setLineDash(mono ? [] : [2, 4]);
      ctx.strokeStyle = mono ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.08)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(PAD.left, by); ctx.lineTo(PAD.left + plotW, by); ctx.stroke();
      ctx.restore();
      const label = b.target >= 1e6 ? `${b.target / 1e6}M` : `${b.target / 1e3}K`;
      ctx.font = mono ? '700 10px ui-monospace, SFMono-Regular, Menlo, monospace' : FONT_BOLD;
      const lw = ctx.measureText(label).width;
      if (mono) {
        ctx.fillStyle = SURFACE; ctx.fillRect(PAD.left, by - 7, lw + 8, 14);
        ctx.fillStyle = '#a3a3a3'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(label, PAD.left + 4, by);
      } else {
        ctx.fillStyle = SURFACE; ctx.fillRect(PAD.left + plotW - lw - 4, by - 14, lw + 6, 13);
        ctx.fillStyle = INK_DIM; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(label, PAD.left + plotW - 2, by - 7);
      }
    }
    // "now" divider.
    if (projPts.length) {
      const nx = xAt(s[s.length - 1].d);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = mono ? 'rgba(255,255,255,.25)' : '#3f3f46';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(nx, PAD.top); ctx.lineTo(nx, PAD.top + plotH); ctx.stroke();
      ctx.restore();
      ctx.font = mono ? '700 9px ui-monospace, SFMono-Regular, Menlo, monospace' : FONT;
      ctx.fillStyle = INK_DIM;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(mono ? 'NOW' : 'now', nx, PAD.top - 3);
    }
    // Dates.
    ctx.font = mono ? '500 9px ui-monospace, SFMono-Regular, Menlo, monospace' : FONT;
    ctx.fillStyle = INK_MUTED;
    ctx.textBaseline = 'top';
    const first = mono ? fmtDate(s[0].d).toUpperCase() : fmtDate(s[0].d);
    ctx.textAlign = 'left';
    ctx.fillText(first, PAD.left, cssH - PAD.bottom + 8);
    const lastD = projPts.length ? projPts[0].pts[projPts[0].pts.length - 1].d : s[s.length - 1].d;
    if (s.length > 1 || projPts.length) {
      ctx.textAlign = 'right';
      ctx.fillText(mono ? fmtDate(lastD).toUpperCase() : fmtDate(lastD), PAD.left + plotW, cssH - PAD.bottom + 8);
    }
  };

  const drawArea = (reveal) => {
    // The cone first, back to front, so the amber history reads on top of it.
    for (const p of [...projPts].reverse()) fillUnder(p.pts, SERIES[p.key] || INK_MUTED, 0.28, 0.02);
    fillUnder(pts.slice(0, Math.max(2, Math.ceil(pts.length * reveal))), SERIES.history, 0.55, 0.04);
    stroke(trendPts, { color: INK_MUTED, width: 1.5, dash: [4, 5] });
    for (const p of projPts) stroke(p.pts, { color: SERIES[p.key] || INK_MUTED, width: 2, dash: [7, 5], glow: 8 });
    stroke(pts.slice(0, Math.max(2, Math.ceil(pts.length * reveal))), { color: SERIES.history, width: 3.5, glow: 14 });
  };

  const drawBars = (reveal) => {
    // Daily gains: the texture a cumulative line physically cannot show.
    const gains = s.slice(1).map((p, i) => ({ d: p.d, g: p.c - s[i].c }));
    const gMax = Math.max(1, ...gains.map((g) => g.g));
    const bw = Math.max(2, plotW / Math.max(1, span / 86_400_000) - 1.5);
    const bar = (d, val, color, alpha) => {
      const h = Math.max(1, (val / gMax) * gainH);
      ctx.fillStyle = rgba(color, alpha);
      ctx.beginPath();
      ctx.roundRect(xAt(d) - bw / 2, gainTop + gainH - h, bw, h, 1.5);
      ctx.fill();
    };
    gains.slice(0, Math.ceil(gains.length * reveal)).forEach((g) => bar(g.d, g.g, SERIES.history, 0.6));
    for (const p of projPts) {
      for (const q of p.pts.slice(1)) bar(q.d, p.perDay, SERIES[p.key] || INK_MUTED, 0.14);
    }
    ctx.font = FONT;
    ctx.fillStyle = INK_DIM;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('DAILY GAIN', PAD.left, gainTop + 2);

    stroke(trendPts, { color: INK_MUTED, width: 1.5, dash: [4, 5] });
    for (const p of projPts) stroke(p.pts, { color: SERIES[p.key] || INK_MUTED, width: 2, dash: [7, 5], glow: 6 });
    stroke(pts.slice(0, Math.max(2, Math.ceil(pts.length * reveal))), { color: SERIES.history, width: 3, glow: 10 });
  };

  const drawRetro = (reveal) => {
    const shown = pts.slice(0, Math.max(2, Math.ceil(pts.length * reveal)));
    fillUnder(shown, SERIES.history, 0.5, 0.03, true);
    // Scanlines over the fill only — the house texture, not a grid.
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    for (let ly = PAD.top; ly < PAD.top + plotH; ly += 3) {
      ctx.fillStyle = 'rgba(0,0,0,.30)';
      ctx.fillRect(PAD.left, ly, plotW, 1.2);
    }
    ctx.restore();
    stroke(shown, { color: SERIES.history, width: 2.5, stepped: true });
    stroke(trendPts, { color: INK_MUTED, width: 1.5, dash: [4, 5] });
    // Projections stay smooth: a straight-line forecast drawn as steps implies
    // a volatility that is not in the model.
    for (const p of projPts) stroke(p.pts, { color: SERIES[p.key] || INK_MUTED, width: 2, dash: [8, 6] });
  };

  const DRAW = { area: drawArea, bars: drawBars, retro: drawRetro };

  const draw = (hoverIdx = -1, reveal = 1) => {
    ctx.clearRect(0, 0, cssW, cssH);
    chrome();
    (DRAW[style] || drawArea)(reveal);

    for (const p of projPts) {
      const end = p.pts[p.pts.length - 1];
      if (reveal >= 1) ringDot(end, SERIES[p.key] || INK_MUTED, 3);
    }
    // Drawn over the line so a dot is never half-buried under the stroke, and
    // only once the line has finished drawing itself in.
    if (reveal >= 1) {
      for (const m of marks) ringDot(m, POST_MARK, m.count > 1 ? 5 : 4);
    }

    const head = pts[Math.max(0, Math.ceil(pts.length * reveal) - 1)] || pts[pts.length - 1];
    ringDot(head, SERIES.history, 4);

    if (hoverIdx >= 0 && pts[hoverIdx]) {
      const p = pts[hoverIdx];
      ctx.beginPath(); ctx.moveTo(p.px, PAD.top); ctx.lineTo(p.px, PAD.top + plotH);
      ctx.strokeStyle = '#3f3f46'; ctx.lineWidth = 1; ctx.stroke();
      ringDot(p, SERIES.history, 4.5);
    }
  };

  if (animate && pts.length > 2) {
    const startMs = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - startMs) / 480);
      draw(-1, 1 - (1 - k) ** 3);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  } else {
    draw();
  }

  // Markers go FIRST, and the hit-test keeps the first of equal distances, so a
  // post on a day the studio was opened deterministically beats that day's own
  // point — they sit at the same pixel. That means the marker's tooltip has to
  // carry the follower count too, or hovering a post day would lose the number
  // the chart is actually about.
  const hoverable = [
    ...marks.map((m) => ({ ...m, kind: 'post' })),
    ...pts.map((p, i) => ({ ...p, kind: 'real', idx: i })),
    ...projPts.flatMap((p) => p.pts.slice(1).map((q) => ({ ...q, kind: p.key, label: p.label }))),
  ];
  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best = hoverable[0];
    let bestD = Infinity;
    for (const p of hoverable) {
      const d = (p.px - mx) ** 2 + ((p.py - my) * 0.6) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    draw(best.kind === 'real' ? best.idx : -1);
    if (tipEl) {
      tipEl.innerHTML = best.kind === 'post'
        ? `<span class="text-neutral-500">${fmtDate(best.d)}</span> <span class="font-semibold text-neutral-100">${fmtCount(Math.round(best.c))}</span> <span class="text-neutral-400">· ${best.count} post${best.count === 1 ? '' : 's'}</span>`
        : best.kind === 'real'
          ? `<span class="text-neutral-500">${fmtDate(best.d)}</span> <span class="font-semibold text-neutral-100">${fmtCount(best.c)}</span>`
          : `<span class="text-neutral-500">${fmtDate(best.d)}</span> <span class="font-semibold text-neutral-100">~${fmtCount(best.c)}</span> <span class="text-neutral-500">${best.label}</span>`;
      tipEl.classList.remove('hidden');
      const tw = tipEl.offsetWidth;
      tipEl.style.left = `${Math.min(Math.max(best.px - tw / 2, 0), cssW - tw)}px`;
      tipEl.style.top = `${Math.max(best.py - 36, 0)}px`;
    }
  };
  canvas.onmouseleave = () => {
    draw();
    if (tipEl) tipEl.classList.add('hidden');
  };
}
