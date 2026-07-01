// Pure builder + validator for the TikTok Content Posting API photo init body.
// Endpoint: POST https://open.tiktokapis.com/v2/post/publish/content/init/
// Docs verified 2026-07-01: media_type PHOTO, post_mode MEDIA_UPLOAD (draft to
// inbox), source PULL_FROM_URL, up to 35 https photo_images, title<=90,
// description<=4000 (UTF-16 runes).

export const MAX_PHOTOS = 35;
const TITLE_MAX = 90;
const DESC_MAX = 4000;

// TikTok counts title/description limits in UTF-16 code units (its "runes").
// Truncate by code units to match, but never split a surrogate pair (which
// would leave a broken emoji), so drop a trailing lone high surrogate.
function truncateUtf16(str, max) {
  const s = String(str ?? '');
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // dangling high surrogate
  return cut;
}

export function validateForInit({ photoUrls, coverIndex }) {
  if (!Array.isArray(photoUrls) || photoUrls.length === 0) {
    return { ok: false, error: 'No photos to post' };
  }
  if (photoUrls.length > MAX_PHOTOS) {
    return { ok: false, error: `Too many photos (max ${MAX_PHOTOS})` };
  }
  if (!photoUrls.every(u => typeof u === 'string' && u.startsWith('https://'))) {
    return { ok: false, error: 'All photo URLs must be https' };
  }
  if (!Number.isInteger(coverIndex) || coverIndex < 0 || coverIndex >= photoUrls.length) {
    return { ok: false, error: 'Cover index out of range' };
  }
  return { ok: true };
}

export function buildInitPayload({ photoUrls, coverIndex = 0, title = '', description = '' }) {
  return {
    media_type: 'PHOTO',
    post_mode: 'MEDIA_UPLOAD',
    post_info: {
      title: truncateUtf16(title, TITLE_MAX),
      description: truncateUtf16(description, DESC_MAX),
    },
    source_info: {
      source: 'PULL_FROM_URL',
      photo_cover_index: coverIndex,
      photo_images: photoUrls,
    },
  };
}
