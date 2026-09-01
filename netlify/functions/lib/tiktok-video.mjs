// Pure builder + validator for the TikTok Content Posting API VIDEO init body.
// Endpoint: POST https://open.tiktokapis.com/v2/post/publish/inbox/video/init/
//
// The inbox endpoint is the video twin of the photo path's content/init with
// post_mode MEDIA_UPLOAD: it drops a draft into the account's inbox for the
// human to finish and publish, which is all an unaudited app may do. Same
// video.upload scope, same PULL_FROM_URL rule that the URL must live under a
// verified URL property (ours is <domain>/tik, which /tik/video/<id> is under).
//
// Note the shape difference from the photo call: the inbox endpoint carries no
// post_info at all — the title and description are typed by the human in the
// TikTok app when they finish the draft. Sending post_info here is rejected.

export const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // TikTok's PULL_FROM_URL ceiling
export const MIN_VIDEO_BYTES = 1024;              // a clip that small is a failed render

export function validateVideoForInit({ videoUrl, bytes = null } = {}) {
  if (typeof videoUrl !== 'string' || !videoUrl.startsWith('https://')) {
    return { ok: false, error: 'The clip URL must be https' };
  }
  if (bytes !== null) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < MIN_VIDEO_BYTES) return { ok: false, error: 'That clip is empty' };
    if (n > MAX_VIDEO_BYTES) return { ok: false, error: 'That clip is too large for TikTok (200MB max)' };
  }
  return { ok: true };
}

export function buildVideoInitPayload({ videoUrl }) {
  return {
    source_info: {
      source: 'PULL_FROM_URL',
      video_url: videoUrl,
    },
  };
}
