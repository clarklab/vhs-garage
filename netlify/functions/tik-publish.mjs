// Creates a TikTok photo-slideshow draft from hosted image URLs.
// Body: { refreshToken, photoUrls:[https...], coverIndex, title?, description? }
import { buildInitPayload, validateForInit } from './lib/tiktok-payload.mjs';

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/content/init/';
const STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  if (!CLIENT_KEY || !CLIENT_SECRET) return json({ error: 'TikTok OAuth not configured' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { refreshToken, photoUrls, coverIndex = 0, title = '', description = '' } = body;
  if (!refreshToken) return json({ error: 'Not signed in' }, 401);

  const check = validateForInit({ photoUrls, coverIndex });
  if (!check.ok) return json({ error: check.error }, 400);

  const accessToken = await getAccessToken(refreshToken);
  if (!accessToken) {
    console.error('[tik-publish] token refresh failed — refresh token invalid/expired');
    return json({ error: 'Could not get access token — please sign in again' }, 401);
  }

  // Initialize the draft.
  const initRes = await fetch(INIT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(buildInitPayload({ photoUrls, coverIndex, title, description })),
  });
  const initData = await initRes.json().catch(() => ({}));
  const publishId = initData?.data?.publish_id;
  if (!publishId) {
    console.error('[tik-publish] content/init rejected', { status: initRes.status, tiktok: initData?.error });
    const msg = initData?.error?.message || 'TikTok rejected the post';
    return json({ error: msg, hint: hintForError(initData?.error), tiktok: initData?.error }, 400);
  }

  // Poll status a bounded number of times.
  const status = await pollStatus(accessToken, publishId);
  return json({ publishId, status });
};

// Map known TikTok init errors to a one-line developer-portal hint, so the UI
// can show the verbatim TikTok message PLUS actionable guidance.
function hintForError(err) {
  const code = String(err?.code || '').toLowerCase();
  const msg = String(err?.message || '').toLowerCase();
  const blob = code + ' ' + msg;
  if (blob.includes('url_ownership') || blob.includes('unverified') || blob.includes('domain')) {
    return 'Add this site’s domain (and the /.netlify/functions/tik-media URL prefix) under "URL properties" in the TikTok developer portal.';
  }
  if (blob.includes('unaudited') || blob.includes('private')) {
    return 'Unaudited apps can only post private drafts — this is expected for the draft-to-inbox MVP.';
  }
  if (blob.includes('scope') || blob.includes('permission')) {
    return 'Request the video.upload scope for your app and re-authorize.';
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

// TikTok status enum (get-status reference): PROCESSING_DOWNLOAD / PROCESSING_UPLOAD
// are non-terminal; SEND_TO_USER_INBOX is the terminal SUCCESS for a MEDIA_UPLOAD
// (draft-to-inbox) post; PUBLISH_COMPLETE for direct posts; FAILED on error.
// For PULL_FROM_URL photos the in-flight state is PROCESSING_DOWNLOAD.
async function pollStatus(accessToken, publishId, tries = 8) {
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
    if (status && status !== 'PROCESSING_UPLOAD' && status !== 'PROCESSING_DOWNLOAD') {
      return status; // terminal: SEND_TO_USER_INBOX | PUBLISH_COMPLETE | FAILED
    }
    await sleep(1500);
  }
  return 'PROCESSING_DOWNLOAD'; // timed out still downloading; the draft may still land shortly.
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
