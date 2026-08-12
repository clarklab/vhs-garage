// Formatting shared by the report panels.
//
// These started as private helpers in tagreport.js. postreport.js needs the
// same ones, and three report tables that round or escape differently would
// read as three different tools.
//
// Pure — no DOM, no network. Unit-tested under node:test.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// The guard every formatter below runs first.
//
// `Number(null)` is 0 and `Number('')` is 0, so the obvious
// `Number.isFinite(Number(v))` reports a MISSING value as a real zero. In a
// report that is the worst possible failure: "we have no view count for this
// post" renders identically to "this post got zero views", and the fake zero
// then drags every median it lands in. Absent must stay absent.
export function finite(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 1200 → "1.2K". Whole numbers below a thousand, one decimal above, and the
// trailing ".0" dropped so it reads as 4K rather than 4.0K.
export function count(n) {
  const raw = finite(n);
  if (raw === null) return '—';
  const v = Math.round(raw);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(v);
}

// A true minus sign, not a hyphen — these sit in tabular-nums columns.
export function pct(n) {
  const v = finite(n);
  if (v === null) return '—';
  return `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100))}%`;
}

export function rate(n) {
  const v = finite(n);
  return v === null ? '—' : `${(v * 100).toFixed(1)}%`;
}

// Seconds → "0:24". Photo posts report no duration at all, which is a real
// answer ("this was a slideshow") rather than a zero-length video.
export function duration(seconds) {
  const s = finite(seconds);
  if (s === null || s <= 0) return '—';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}

// Age in days → "3d", "6w", "1y". Coarse on purpose: the report is comparing
// posts, not timing a stopwatch.
export function age(days) {
  const d = finite(days);
  if (d === null || d < 0) return '—';
  if (d < 1) return 'today';
  if (d < 14) return `${Math.round(d)}d`;
  if (d < 60) return `${Math.round(d / 7)}w`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${(d / 365).toFixed(1).replace(/\.0$/, '')}y`;
}
