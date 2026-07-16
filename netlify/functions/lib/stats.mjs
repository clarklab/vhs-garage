// Pure helpers for the follower-stats series. TikTok's API only reports the
// CURRENT count (no history endpoint), so we build the history ourselves:
// one snapshot per day, appended whenever the studio is opened. No network/DOM.

export const STATS_STORE = 'tik-stats';
export const SERIES_KEY = 'followers';
export const SERIES_MAX = 1000; // ~3 years of daily points

// Validate a stored series: keep only { d: 'YYYY-MM-DD', c: int >= 0 } entries
// (optional likes/videos ride along), sorted by date ascending, deduped by day.
export function normalizeSeries(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const byDay = new Map();
  for (const item of list) {
    const d = typeof item?.d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.d) ? item.d : null;
    const c = Number(item?.c);
    if (!d || !Number.isFinite(c) || c < 0) continue;
    const entry = { d, c: Math.round(c) };
    if (Number.isFinite(Number(item.likes))) entry.likes = Math.round(Number(item.likes));
    if (Number.isFinite(Number(item.videos))) entry.videos = Math.round(Number(item.videos));
    byDay.set(d, entry); // later entries for the same day win
  }
  return [...byDay.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
}

// Append (or same-day replace) a snapshot; returns a new sorted, capped array.
export function appendSnapshot(series, snap) {
  const next = normalizeSeries([...(Array.isArray(series) ? series : []), snap]);
  return next.length > SERIES_MAX ? next.slice(next.length - SERIES_MAX) : next;
}

// Change over roughly the trailing `days`: baseline is the most recent entry
// at least `days` older than the last one (or the earliest entry when the
// series is younger than the window). Returns null with < 2 points.
export function seriesDelta(series, days = 7) {
  const s = normalizeSeries(series);
  if (s.length < 2) return null;
  const last = s[s.length - 1];
  const lastT = Date.parse(`${last.d}T00:00:00Z`);
  const cutoff = lastT - days * 86_400_000;
  let baseline = s[0];
  for (const entry of s) {
    const t = Date.parse(`${entry.d}T00:00:00Z`);
    if (t <= cutoff) baseline = entry; else break;
  }
  const spanDays = Math.max(1, Math.round((lastT - Date.parse(`${baseline.d}T00:00:00Z`)) / 86_400_000));
  return { delta: last.c - baseline.c, days: spanDays };
}

// Today's date key in UTC (Netlify functions run in UTC).
export function todayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}
