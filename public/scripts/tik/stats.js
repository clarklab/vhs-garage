// Follower stats for the home screen: fetch/snapshot via tik-stats, and a
// dependency-free canvas line chart (single series, hero number lives in HTML).
// TikTok has no history API, so the series grows one point per day of use.
import { getRefreshToken } from './auth.js';

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
const PAD = { top: 10, right: 12, bottom: 22, left: 8 };
const FONT = '500 10px Inter, system-ui, sans-serif';

// Draw the series onto `canvas` (dpr-aware) and wire a crosshair + tooltip.
// `tipEl` is an absolutely-positioned div inside the canvas's relative parent.
export function renderFollowerChart(canvas, series, tipEl) {
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

  // Scales: x by real time (gaps between visits stay proportional), y padded
  // to a small nice range so a flat week doesn't render as a wild swing.
  const t0 = Date.parse(`${s[0].d}T00:00:00Z`);
  const t1 = Date.parse(`${s[s.length - 1].d}T00:00:00Z`);
  const span = Math.max(1, t1 - t0);
  const counts = s.map((p) => p.c);
  let lo = Math.min(...counts);
  let hi = Math.max(...counts);
  const headroom = Math.max(Math.round((hi - lo) * 0.15), Math.max(2, Math.round(hi * 0.02)));
  lo = Math.max(0, lo - headroom);
  hi = hi + headroom;
  const x = (p) => PAD.left + ((Date.parse(`${p.d}T00:00:00Z`) - t0) / span) * plotW;
  const y = (c) => PAD.top + (1 - (c - lo) / (hi - lo)) * plotH;
  const pts = s.map((p) => ({ px: s.length === 1 ? PAD.left + plotW / 2 : x(p), py: y(p.c), ...p }));

  const draw = (hoverIdx = -1) => {
    ctx.clearRect(0, 0, cssW, cssH);

    // Recessive grid: three horizontal lines with muted right-aligned labels.
    ctx.font = FONT;
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.fillStyle = INK_MUTED;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    for (const f of [0, 0.5, 1]) {
      const gy = PAD.top + f * plotH;
      ctx.beginPath();
      ctx.moveTo(PAD.left, gy);
      ctx.lineTo(PAD.left + plotW, gy);
      ctx.stroke();
      ctx.fillText(fmtCount(Math.round(hi - f * (hi - lo))), PAD.left + plotW, gy - 2);
    }
    // X labels: first and last date (plus nothing else — recessive).
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(fmtDate(s[0].d), PAD.left, cssH - PAD.bottom + 6);
    if (s.length > 1) {
      ctx.textAlign = 'right';
      ctx.fillText(fmtDate(s[s.length - 1].d), PAD.left + plotW, cssH - PAD.bottom + 6);
    }

    // Area fill under the line (subtle), then the 2px line itself.
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

      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.px, p.py) : ctx.moveTo(p.px, p.py)));
      ctx.strokeStyle = LINE;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
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

  // Hover: nearest point by x; tooltip text stays in ink tokens.
  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].px - mx) < Math.abs(pts[best].px - mx)) best = i;
    draw(best);
    if (tipEl) {
      const p = pts[best];
      tipEl.textContent = `${fmtDate(p.d)} · ${fmtCount(p.c)} followers`;
      tipEl.classList.remove('hidden');
      const tw = tipEl.offsetWidth;
      tipEl.style.left = `${Math.min(Math.max(p.px - tw / 2, 0), cssW - tw)}px`;
      tipEl.style.top = `${Math.max(p.py - 34, 0)}px`;
    }
  };
  canvas.onmouseleave = () => {
    draw();
    if (tipEl) tipEl.classList.add('hidden');
  };
}
