// Follower stats for the home screen: fetch/snapshot via tik-stats, and a
// dependency-free canvas line chart (single series, hero number lives in HTML).
// TikTok has no history API, so the series grows one point per day of use.
import { getRefreshToken } from './auth.js';
import { models, projectSeries, trendSeries, horizonFor, MIN_POINTS } from './forecast.js';

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

// Colors: line hue validated against the dark surface (dataviz six checks);
// text/grid stay in ink tokens, never the series color.
const LINE = '#d97706';       // amber-600
const GRID = '#262626';       // neutral-800
const INK_MUTED = '#737373';  // neutral-500
const INK = '#f5f5f4';        // neutral-100
const SURFACE = '#171717';    // neutral-900, the stats card's own background
const PAD = { top: 10, right: 12, bottom: 22, left: 8 };
const FONT = '500 10px Inter, system-ui, sans-serif';

// Projection hues. Both sit clearly apart from the amber history line so a
// dashed future is never mistaken for something that happened: the recent pace
// leads (it is the one that reacts), the all-time fit trails as the sober one.
const PROJ = {
  recent: '#22d3ee',   // cyan-400
  alltime: '#a78bfa',  // violet-400
};
export const CHART_MODES = ['history', 'forecast'];

// Draw the series onto `canvas` (dpr-aware) and wire a crosshair + tooltip.
// `tipEl` is an absolutely-positioned div inside the canvas's relative parent.
//
// mode 'history'  — what actually happened, plus the straight line fitted
//                   through it so a good week reads as a good week rather than
//                   as the new normal.
// mode 'forecast' — the same history, then both paces extended into dated
//                   future. Projections are dashed and differently coloured
//                   throughout: nothing to the right of today is a measurement,
//                   and the chart should never let that blur.
export function renderFollowerChart(canvas, series, tipEl, { mode = 'history' } = {}) {
  // A canvas measured while (an ancestor is) hidden reads 0 wide; falling back
  // blind stretches the raster AND breaks hover hit-testing. Prefer the parent.
  const cssW = canvas.clientWidth || canvas.parentElement?.clientWidth || 600;
  const cssH = canvas.clientHeight || 144;
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
  const projections = paces.map((m) => ({
    ...m, pts: projectSeries(s, m.perDay, horizon),
  })).filter((p) => p.pts.length > 1);
  const trend = mode === 'history' ? trendSeries(s) : [];

  // Scales: x by real time (gaps between visits stay proportional), y padded
  // to a small nice range so a flat week doesn't render as a wild swing. In
  // forecast mode both axes stretch to hold the projected future.
  const t0 = Date.parse(`${s[0].d}T00:00:00Z`);
  const lastReal = Date.parse(`${s[s.length - 1].d}T00:00:00Z`);
  const futureEnd = projections.reduce(
    (mx, p) => Math.max(mx, Date.parse(`${p.pts[p.pts.length - 1].d}T00:00:00Z`)), lastReal,
  );
  const t1 = Math.max(lastReal, futureEnd);
  const span = Math.max(1, t1 - t0);

  const counts = s.map((p) => p.c);
  const projCounts = projections.flatMap((p) => p.pts.map((q) => q.c));
  let lo = Math.min(...counts, ...(projCounts.length ? projCounts : counts));
  let hi = Math.max(...counts, ...(projCounts.length ? projCounts : counts));
  const headroom = Math.max(Math.round((hi - lo) * 0.15), Math.max(2, Math.round(hi * 0.02)));
  lo = Math.max(0, lo - headroom);
  hi = hi + headroom;

  const xAt = (d) => PAD.left + ((Date.parse(`${d}T00:00:00Z`) - t0) / span) * plotW;
  const y = (c) => PAD.top + (1 - (c - lo) / (hi - lo)) * plotH;
  const place = (list) => list.map((p) => ({
    ...p, px: s.length === 1 && list === s ? PAD.left + plotW / 2 : xAt(p.d), py: y(p.c),
  }));
  const pts = place(s);
  const trendPts = place(trend);
  const projPts = projections.map((p) => ({ ...p, pts: place(p.pts) }));

  const strokePath = (list, { color, width = 2, dash = null }) => {
    if (list.length < 2) return;
    ctx.save();
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    list.forEach((p, i) => (i ? ctx.lineTo(p.px, p.py) : ctx.moveTo(p.px, p.py)));
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  };

  const draw = (hoverIdx = -1) => {
    ctx.clearRect(0, 0, cssW, cssH);

    // Recessive grid: three horizontal lines with muted right-aligned labels.
    ctx.font = FONT;
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.fillStyle = INK_MUTED;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    // Labels ride the right edge, which in forecast mode is where the
    // projection lines end — so each one gets a backdrop in the card's own
    // surface colour rather than being drawn straight over a dashed line.
    for (const f of [0, 0.5, 1]) {
      const gy = PAD.top + f * plotH;
      ctx.beginPath();
      ctx.moveTo(PAD.left, gy);
      ctx.lineTo(PAD.left + plotW, gy);
      ctx.stroke();
      const label = fmtCount(Math.round(hi - f * (hi - lo)));
      const lw = ctx.measureText(label).width;
      ctx.fillStyle = SURFACE;
      ctx.fillRect(PAD.left + plotW - lw - 3, gy - 12, lw + 4, 12);
      ctx.fillStyle = INK_MUTED;
      ctx.fillText(label, PAD.left + plotW, gy - 2);
    }

    // The "today" divider: everything right of it is arithmetic, not history.
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
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = INK_MUTED;
      ctx.fillText('now', nx + 3, PAD.top);
    }

    // X labels: first and last date on screen.
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = INK_MUTED;
    ctx.fillText(fmtDate(s[0].d), PAD.left, cssH - PAD.bottom + 6);
    const lastLabel = projPts.length
      ? projPts[0].pts[projPts[0].pts.length - 1].d
      : s[s.length - 1].d;
    if (s.length > 1 || projPts.length) {
      ctx.textAlign = 'right';
      ctx.fillText(fmtDate(lastLabel), PAD.left + plotW, cssH - PAD.bottom + 6);
    }

    // Area fill under the history line (subtle), then the 2px line itself.
    if (pts.length > 1) {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.px, p.py) : ctx.moveTo(p.px, p.py)));
      const fill = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + plotH);
      fill.addColorStop(0, 'rgba(217, 119, 6, 0.18)');
      fill.addColorStop(1, 'rgba(217, 119, 6, 0)');
      ctx.lineTo(pts[pts.length - 1].px, PAD.top + plotH);
      ctx.lineTo(pts[0].px, PAD.top + plotH);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }

    // Fitted trend under the history: dashed and muted, so it reads as a
    // reference rather than as a second measurement.
    strokePath(trendPts, { color: INK_MUTED, width: 1.5, dash: [4, 4] });
    strokePath(pts, { color: LINE, width: 2 });

    // Projections last so they sit on top, each dashed in its own hue.
    for (const p of projPts) {
      strokePath(p.pts, { color: PROJ[p.key] || INK_MUTED, width: 2, dash: [5, 4] });
      const end = p.pts[p.pts.length - 1];
      ctx.beginPath();
      ctx.arc(end.px, end.py, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = PROJ[p.key] || INK_MUTED;
      ctx.fill();
    }

    // End-point marker (always), hover marker with a surface ring.
    const dot = (p, r) => {
      ctx.beginPath();
      ctx.arc(p.px, p.py, r, 0, Math.PI * 2);
      ctx.fillStyle = LINE;
      ctx.fill();
    };
    dot(pts[pts.length - 1], 3);
    if (hoverIdx >= 0) {
      const p = pts[hoverIdx];
      ctx.beginPath();
      ctx.moveTo(p.px, PAD.top);
      ctx.lineTo(p.px, PAD.top + plotH);
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.px, p.py, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#171717'; // surface ring so the marker separates from the line
      ctx.fill();
      dot(p, 4);
    }
  };
  draw();

  // Hover: nearest point by x. In forecast mode the projected lines are
  // hoverable too, and their tooltip says "projected" in as many words.
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
      // Distance in both axes, so two lines stacked at the same x can be told
      // apart by pointing at one of them.
      const d = (p.px - mx) ** 2 + ((p.py - my) * 0.6) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    draw(best.kind === 'real' ? best.idx : -1);
    if (tipEl) {
      tipEl.textContent = best.kind === 'real'
        ? `${fmtDate(best.d)} · ${fmtCount(best.c)} followers`
        : `${fmtDate(best.d)} · ~${fmtCount(best.c)} projected (${best.label})`;
      tipEl.classList.remove('hidden');
      const tw = tipEl.offsetWidth;
      tipEl.style.left = `${Math.min(Math.max(best.px - tw / 2, 0), cssW - tw)}px`;
      tipEl.style.top = `${Math.max(best.py - 34, 0)}px`;
    }
  };
  canvas.onmouseleave = () => {
    draw();
    if (tipEl) tipEl.classList.add('hidden');
  };
}
