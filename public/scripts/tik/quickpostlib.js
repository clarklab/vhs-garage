// Quick post (the phone page) — the pure parts. No DOM. Unit-tested.

import { statusOf, isImported, defaultPostFields, projectDisplayName } from './project.js';
import { flaggedCount, wrongCount } from './slides.js';

const YEAR_FRAME_HEIGHT_RATIO = 0.6;   // keep in step with app.js frameHeightRatio()

// The library as the phone wants it: ready sets first (oldest first, the
// queue order), then drafts (newest first), then everything posted.
export function groupForQuickPost(records) {
  const ready = [];
  const drafts = [];
  const posted = [];
  for (const r of records || []) {
    const s = statusOf(r);
    if (s === 'posted') posted.push(r);
    else if (s === 'ready') ready.push(r);
    else if (!isImported(r) && (r.slides || []).length) drafts.push(r);
  }
  ready.sort((a, b) => (a.readyAt || a.updatedAt || 0) - (b.readyAt || b.updatedAt || 0));
  drafts.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  posted.sort((a, b) => (b.postedAt || b.updatedAt || 0) - (a.postedAt || a.updatedAt || 0));
  return { ready, drafts, posted };
}

// Can this set go to TikTok from the phone as it stands?
// → { ok: true } or { ok: false, reason }
export function canPublish(rec) {
  const slides = rec?.slides || [];
  if (!slides.length) return { ok: false, reason: 'This set has no slides.' };
  if (rec.batch?.pendingFrames) return { ok: false, reason: 'Its frames haven’t been shot yet.' };
  if (slides.length > 35) return { ok: false, reason: 'TikTok takes at most 35 slides.' };
  if (rec.format === 'quotes' && rec.output === 'video') return { ok: false, reason: 'Video Quote-a-longs are rendered and posted from the full studio.' };
  return { ok: true };
}

// What the slides are drawn with — the same options the studio uses for the
// photo post, so the phone posts exactly what the desk would have.
export function composeOptionsFor(rec) {
  return {
    titleLine: rec?.format === 'trivia' && rec?.titleOn ? String(rec.titleLine || '').trim() : '',
    maxFrameHeightRatio: rec?.format === 'year' ? YEAR_FRAME_HEIGHT_RATIO : null,
    format: rec?.format,
  };
}

// The post copy that will go out: the set's own, or the generated default.
export function postCopyFor(rec) {
  const fallback = defaultPostFields(rec?.format, projectDisplayName(rec || {}));
  return {
    title: String(rec?.postTitle || '').trim() || fallback.title,
    description: String(rec?.postDesc || '').trim() || fallback.description,
  };
}

export const songsFor = (rec) => (rec?.postMeta?.songs || []).filter((s) => s && s.title);
export const flagsFor = (rec) => flaggedCount(rec?.slides || []);
export const wrongsFor = (rec) => wrongCount(rec?.slides || []);

// A sound pick as one searchable line for the TikTok sound search.
export const songQuery = (s) => [s.title, s.artist].filter(Boolean).join(' ');
