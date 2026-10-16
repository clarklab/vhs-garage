// Creates a TikTok VIDEO draft from a hosted clip URL — the Quote-a-long video
// format's other half. Body: { refreshToken, videoUrl, bytes? }
//
// Deliberately a separate function from tik-publish.mjs rather than a branch
// inside it. The photo path is the one that posts every day; a video request
// with a typo in it must not be able to reach that code. The token refresh and
// status poll below are copies of the ones there — small, stable, and worth
// duplicating to keep the working path untouched.
// MUST MATCH the same helpers in tik-publish.mjs.
import { buildVideoInitPayload, validateVideoForInit } from './lib/tiktok-video.mjs';

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';
const STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  if (!CLIENT_KEY || !CLIENT_SECRET) return json({ error: 'TikTok OAuth not configured' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { refreshToken, videoUrl, bytes = null } = body;
  if (!refreshToken) return json({ error: 'Not signed in' }, 401);

  const check = validateVideoForInit({ videoUrl, bytes });
  if (!check.ok) return json({ error: check.error }, 400);

  const accessToken = await getAccessToken(refreshToken);
  if (!accessToken) {
    console.error('[tik-publish-video] token refresh failed — refresh token invalid/expired');
    return json({ error: 'Could not get access token — please sign in again' }, 401);
  }

  const initRes = await fetch(INIT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(buildVideoInitPayload({ videoUrl })),
  });
  const initData = await initRes.json().catch(() => ({}));
  const publishId = initData?.data?.publish_id;
  if (!publishId) {
    console.error('[tik-publish-video] inbox/video/init rejected', { status: initRes.status, tiktok: initData?.error });
    const msg = initData?.error?.message || 'TikTok rejected the clip';
    return json({ error: msg, hint: hintForError(initData?.error), tiktok: initData?.error }, 400);
  }

  // A video takes longer to pull and transcode than a handful of JPEGs, so this
  // waits longer than the photo path before handing back "still processing".
  const { status, failReason } = await pollStatus(accessToken, publishId, 12);
  return json({ publishId, status, failReason });
};

function hintForError(err) {
  const code = String(err?.code || '').toLowerCase();
  const msg = String(err?.message || '').toLowerCase();
  const blob = `${code} ${msg}`;
  if (blob.includes('url_ownership') || blob.includes('unverified') || blob.includes('domain')) {
    return 'Add this site’s domain under "URL properties" in the TikTok developer portal — the clip is served under the same /tik prefix as the slide images.';
  }
  if (blob.includes('scope') || blob.includes('permission')) {
    return 'Request the video.upload scope for your app and re-authorize.';
  }
  if (blob.includes('spam') || blob.includes('rate')) {
    return 'TikTok rate-limits drafts — wait a few minutes and try again.';
  }
  if (blob.includes('user') && (blob.includes('target') || blob.includes('tester'))) {
    return 'Add this TikTok account as a target user / tester on your app in the developer portal.';
  }
  return '';
}

async function getAccessToken(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json().catch(() => ({}));
  return data.access_token || null;
}

async function pollStatus(accessToken, publishId, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(STATUS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({ publish_id: publishId }),
    });
    const data = await res.json().catch(() => ({}));
    const status = data?.data?.status;
    const failReason = data?.data?.fail_reason || null;
    if (status && status !== 'PROCESSING_UPLOAD' && status !== 'PROCESSING_DOWNLOAD') {
      if (status === 'FAILED') {
        console.error('[tik-publish-video] post FAILED', { publishId, failReason, tiktok: data?.data });
      }
      return { status, failReason };
    }
    await sleep(1500);
  }
  return { status: 'PROCESSING_DOWNLOAD', failReason: null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
