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
const GRID = '#262626';       // neutral-800
const INK_MUTED = '#737373';  // neutral-500
const INK_DIM = '#525252';    // neutral-600
const INK = '#f5f5f4';        // neutral-100
const SURFACE = '#171717';    // neutral-900, the stats card's own background
const PAD = { top: 16, right: 16, bottom: 26, left: 10 };
const FONT = '500 10px Inter, system-ui, sans-serif';
const FONT_BOLD = '700 11px Inter, system-ui, sans-serif';

export const CHART_MODES = ['history', 'forecast'];

// rgba() from a hex, for the gradient fills.
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Legend as real HTML: selectable, screen-readable, and present whenever there
// is more than one series — identity is never carried by colour alone.
function renderLegend(el, entries) {
  if (!el) return;
  el.innerHTML = entries.map((e) => `
    <span class="inline-flex items-center gap-1.5 text-[11px] text-neutral-400">
      <span class="inline-block h-0.5 w-4 rounded-full" style="background:${e.color};${e.dashed ? 'opacity:.9;mask-image:repeating-linear-gradient(90deg,#000 0 4px,transparent 4px 7px);-webkit-mask-image:repeating-linear-gradient(90deg,#000 0 4px,transparent 4px 7px)' : ''}"></span>
      ${e.label}
    </span>`).join('');
}

// Draw the series onto `canvas` (dpr-aware) and wire a crosshair + tooltip.
//
// mode 'history'  — what happened, plus the least-squares fit through it, so a
//                   good fortnight reads as a good fortnight and not as the new
//                   normal. The gap between the two lines is the whole story.
// mode 'forecast' — the same history, then both paces extended into dated
//                   future past a "now" divider, with the milestones drawn as
//                   labelled bands so you can see the line meet them.
//
// Everything to the right of "now" is dashed, differently coloured, and
// legended. Nothing there is a measurement and the chart never lets that blur.
export function renderFollowerChart(canvas, series, tipEl, { mode = 'history', legendEl = null, animate = false } = {}) {
  // A canvas measured while (an ancestor is) hidden reads 0 wide; falling back
  // blind stretches the raster AND breaks hover hit-testing. Prefer the parent.
  const cssW = canvas.clientWidth || canvas.parentElement?.clientWidth || 600;
  const cssH = canvas.clientHeight || 256;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const plotW = cssW - PAD.left - PAD.right;
  const plotH = cssH - PAD.top - PAD.bottom;
  const s = series;
  if (!s.length || plotW < 40) return;

  const forecasting = mode === 'forecast' && s.length >= MIN_POINTS;
  const paces = forecasting ? models(s) : [];
  const horizon = forecasting ? horizonFor(s) : 0;
  const projections = paces
    .map((m) => ({ ...m, pts: projectSeries(s, m.perDay, horizon) }))
    .filter((p) => p.pts.length > 1);
  const trend = mode === 'history' ? trendSeries(s) : [];

  const t0 = Date.parse(`${s[0].d}T00:00:00Z`);
  const lastReal = Date.parse(`${s[s.length - 1].d}T00:00:00Z`);
  const futureEnd = projections.reduce(
    (mx, p) => Math.max(mx, Date.parse(`${p.pts[p.pts.length - 1].d}T00:00:00Z`)), lastReal,
  );
  const span = Math.max(1, Math.max(lastReal, futureEnd) - t0);

  const counts = s.map((p) => p.c);
  const projCounts = projections.flatMap((p) => p.pts.map((q) => q.c));
  const all = projCounts.length ? [...counts, ...projCounts] : counts;
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const headroom = Math.max(Math.round((hi - lo) * 0.12), Math.max(2, Math.round(hi * 0.02)));
  lo = Math.max(0, lo - headroom);
  hi += headroom;

  // Milestones that actually fall inside the plotted range get a band; one that
  // sits above the top of the chart would just be a label with no line.
  const bands = forecasting
    ? milestones(s).filter((m) => m.target > lo && m.target <= hi)
    : [];

  const xAt = (d) => PAD.left + ((Date.parse(`${d}T00:00:00Z`) - t0) / span) * plotW;
  const y = (c) => PAD.top + (1 - (c - lo) / (hi - lo)) * plotH;
  const place = (list, isHistory = false) => list.map((p) => ({
    ...p, px: isHistory && s.length === 1 ? PAD.left + plotW / 2 : xAt(p.d), py: y(p.c),
  }));
  const pts = place(s, true);
  const trendPts = place(trend);
  const projPts = projections.map((p) => ({ ...p, pts: place(p.pts) }));

  renderLegend(legendEl, [
    { label: 'Followers', color: SERIES.history },
    ...(mode === 'history' && trendPts.length
      ? [{ label: 'All-time trend', color: INK_MUTED, dashed: true }] : []),
    ...projPts.map((p) => ({ label: p.label, color: SERIES[p.key] || INK_MUTED, dashed: true })),
  ]);

  const path = (list, upto = 1) => {
    const n = Math.max(2, Math.ceil(list.length * upto));
    ctx.beginPath();
    list.slice(0, n).forEach((p, i) => (i ? ctx.lineTo(p.px, p.py) : ctx.moveTo(p.px, p.py)));
  };
  const stroke = (list, { color, width = 2, dash = null, glow = 0, upto = 1 }) => {
    if (list.length < 2) return;
    ctx.save();
    ctx.setLineDash(dash || []);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (glow) { ctx.shadowColor = rgba(color, 0.55); ctx.shadowBlur = glow; }
    path(list, upto);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.restore();
  };

  const draw = (hoverIdx = -1, reveal = 1) => {
    ctx.clearRect(0, 0, cssW, cssH);

    // Grid + right-aligned labels, each on a surface backdrop so a line running
    // underneath never eats the number.
    ctx.font = FONT;
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const gy = PAD.top + f * plotH;
      ctx.beginPath();
      ctx.moveTo(PAD.left, gy);
      ctx.lineTo(PAD.left + plotW, gy);
      ctx.stroke();
      if (f === 0 || f === 0.5 || f === 1) {
        const label = fmtCount(Math.round(hi - f * (hi - lo)));
        const lw = ctx.measureText(label).width;
        ctx.fillStyle = SURFACE;
        ctx.fillRect(PAD.left + plotW - lw - 3, gy - 12, lw + 4, 12);
        ctx.fillStyle = INK_MUTED;
        ctx.fillText(label, PAD.left + plotW, gy - 2);
      }
    }

    // Milestone bands: the thing the forecast view exists to show.
    for (const b of bands) {
      const by = y(b.target);
      ctx.save();
      ctx.setLineDash([1, 4]);
      ctx.beginPath();
      ctx.moveTo(PAD.left, by);
      ctx.lineTo(PAD.left + plotW, by);
      ctx.strokeStyle = '#3f3f46';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
      const label = b.target >= 1e6 ? `${b.target / 1e6}M` : `${b.target / 1e3}K`;
      ctx.font = FONT_BOLD;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const lw = ctx.measureText(label).width;
      ctx.fillStyle = SURFACE;
      ctx.fillRect(PAD.left, by - 7, lw + 6, 14);
      ctx.fillStyle = INK_DIM;
      ctx.fillText(label, PAD.left + 3, by);
    }

    // The "now" divider.
    if (projPts.length) {
      const nx = xAt(s[s.length - 1].d);
      ctx.save();
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(nx, PAD.top);
      ctx.lineTo(nx, PAD.top + plotH);
      ctx.strokeStyle = '#3f3f46';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
      ctx.font = FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = INK_DIM;
      ctx.fillText('now', nx, PAD.top - 12);
    }

    // Date labels.
    ctx.font = FONT;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = INK_MUTED;
    ctx.fillText(fmtDate(s[0].d), PAD.left, cssH - PAD.bottom + 8);
    const lastLabel = projPts.length ? projPts[0].pts[projPts[0].pts.length - 1].d : s[s.length - 1].d;
    if (s.length > 1 || projPts.length) {
      ctx.textAlign = 'right';
      ctx.fillText(fmtDate(lastLabel), PAD.left + plotW, cssH - PAD.bottom + 8);
    }

    // History: gradient area, then the line with a soft glow.
    if (pts.length > 1) {
      const n = Math.max(2, Math.ceil(pts.length * reveal));
      const shown = pts.slice(0, n);
      ctx.beginPath();
      shown.forEach((p, i) => (i ? ctx.lineTo(p.px, p.py) : ctx.moveTo(p.px, p.py)));
      const fill = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + plotH);
      fill.addColorStop(0, rgba(SERIES.history, 0.28));
      fill.addColorStop(1, rgba(SERIES.history, 0));
      ctx.lineTo(shown[shown.length - 1].px, PAD.top + plotH);
      ctx.lineTo(shown[0].px, PAD.top + plotH);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }

    stroke(trendPts, { color: INK_MUTED, width: 1.5, dash: [4, 5], upto: reveal });
    stroke(pts, { color: SERIES.history, width: 2.5, glow: 10, upto: reveal });

    // Projections, each dashed in its own validated hue with an end label.
    if (reveal >= 1) {
      for (const p of projPts) {
        const color = SERIES[p.key] || INK_MUTED;
        stroke(p.pts, { color, width: 2, dash: [6, 5], glow: 6 });
        const end = p.pts[p.pts.length - 1];
        ctx.beginPath();
        ctx.arc(end.px, end.py, 4, 0, Math.PI * 2);
        ctx.fillStyle = SURFACE;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(end.px, end.py, 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }

    // Latest real value: a ringed dot so it separates from the line.
    const head = pts[Math.max(0, Math.ceil(pts.length * reveal) - 1)] || pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(head.px, head.py, 6, 0, Math.PI * 2);
    ctx.fillStyle = SURFACE;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(head.px, head.py, 4, 0, Math.PI * 2);
    ctx.fillStyle = SERIES.history;
    ctx.fill();

    if (hoverIdx >= 0 && pts[hoverIdx]) {
      const p = pts[hoverIdx];
      ctx.beginPath();
      ctx.moveTo(p.px, PAD.top);
      ctx.lineTo(p.px, PAD.top + plotH);
      ctx.strokeStyle = '#3f3f46';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.px, p.py, 7, 0, Math.PI * 2);
      ctx.fillStyle = SURFACE;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.px, p.py, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = SERIES.history;
      ctx.fill();
    }
  };

  // A short draw-in on mode changes. Purely decorative, so it is skipped on
  // resize and on hover redraws where it would read as a flicker.
  if (animate && pts.length > 2) {
    const t0ms = performance.now();
    const DURATION = 480;
    const step = (now) => {
      const k = Math.min(1, (now - t0ms) / DURATION);
      draw(-1, 1 - (1 - k) ** 3); // ease-out cubic
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  } else {
    draw();
  }

  // Hover: nearest point in both axes, so two stacked projection lines can be
  // told apart by pointing at one of them.
  const hoverable = [
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
      tipEl.innerHTML = best.kind === 'real'
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
