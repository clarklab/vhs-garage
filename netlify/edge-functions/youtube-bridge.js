// YouTube upload bridge — lets whitelisted users upload to the VHS Garage
// channel without ever needing the brand to appear in their OAuth chooser.
//
// HOW IT WORKS
//   1. An admin (Clark) signs into /admin/connect-youtube once. That
//      page captures the admin's refresh token (with VHS Garage as the
//      OAuth-selected channel) and POSTs it here under
//      `action: 'admin-store-token'` — we stash it in Netlify Blobs.
//   2. Any whitelisted end-user uploads via `action: 'init-upload'`:
//      - We verify their identity by calling Google's tokeninfo endpoint
//        with the access token they sent (requires `openid email` in the
//        OAuth scopes).
//      - If their email is on YOUTUBE_BRIDGE_ALLOWED_EMAILS, we mint a
//        fresh access token from the stored admin refresh token, init a
//        resumable upload against the VHS Garage channel, and hand the
//        upload URL back to the browser.
//      - The browser PUTs the video bytes directly to that URL — we
//        never proxy the file (no Netlify timeout / bandwidth issue).
//   3. Non-whitelisted users get a 403, and the client falls back to the
//      existing direct OAuth flow (which uploads to their own channel).
//
// REQUIRED ENV VARS (Netlify dashboard → Site settings → Environment)
//   YOUTUBE_OAUTH_CLIENT_ID       — already set, used everywhere else
//   YOUTUBE_OAUTH_CLIENT_SECRET   — already set
//   YOUTUBE_BRIDGE_ADMIN_EMAILS   — comma-separated emails allowed to
//                                   write the bridge token (e.g. just
//                                   "clark@clarklab.net")
//   YOUTUBE_BRIDGE_ALLOWED_EMAILS — comma-separated emails allowed to
//                                   upload via the bridge (the people
//                                   who upload to VHS Garage)
//
// STORAGE
//   Refresh token lives in Netlify Blobs under the "youtube-bridge" store,
//   key "refresh-token-meta". Format:
//     { refreshToken, storedAt, storedBy }

import { getStore } from "@netlify/blobs";

export default async (req) => {
  const env = (k) => Netlify.env.get(k);
  const YOUTUBE_CLIENT_ID = env('YOUTUBE_OAUTH_CLIENT_ID');
  const YOUTUBE_CLIENT_SECRET = env('YOUTUBE_OAUTH_CLIENT_SECRET');
  const ADMIN_EMAILS = parseEmails(env('YOUTUBE_BRIDGE_ADMIN_EMAILS') || '');
  const ALLOWED_EMAILS = parseEmails(env('YOUTUBE_BRIDGE_ALLOWED_EMAILS') || '');

  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET) {
    return json({ error: 'YouTube OAuth not configured' }, 500);
  }

  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { action, accessToken } = body;
  if (!action) return json({ error: 'Missing action' }, 400);
  if (!accessToken) return json({ error: 'Missing accessToken' }, 401);

  // Verify the caller's identity via Google's tokeninfo endpoint. Works
  // when the OAuth flow requested `openid email` scopes (we now do).
  const user = await verifyAccessToken(accessToken);
  if (!user || !user.email) {
    return json({ error: 'Could not verify user identity' }, 401);
  }
  const userEmail = user.email.toLowerCase();

  // ------------ ADMIN: read-only status ------------
  if (action === 'admin-status') {
    if (!ADMIN_EMAILS.includes(userEmail)) {
      return json({ error: 'Not an admin', email: userEmail }, 403);
    }
    const store = getStore('youtube-bridge');
    const stored = await store.get('refresh-token-meta', { type: 'json' }).catch(() => null);
    const stats = await store.get('bridge-stats', { type: 'json' }).catch(() => null);
    return json({
      hasToken: !!stored?.refreshToken,
      storedAt: stored?.storedAt || null,
      storedBy: stored?.storedBy || null,
      adminEmail: userEmail,
      allowedEmails: ALLOWED_EMAILS,
      stats: stats || { uploads: 0, totalSeconds: 0, totalBytes: 0, byUploader: {}, lastUploadAt: null },
    });
  }

  // ------------ ADMIN: write the bridge refresh token ------------
  if (action === 'admin-store-token') {
    if (!ADMIN_EMAILS.includes(userEmail)) {
      return json({ error: 'Not an admin', email: userEmail }, 403);
    }
    const { refreshToken } = body;
    if (!refreshToken) return json({ error: 'Missing refreshToken' }, 400);
    const store = getStore('youtube-bridge');
    const storedAt = new Date().toISOString();
    await store.set('refresh-token-meta', JSON.stringify({
      refreshToken,
      storedAt,
      storedBy: userEmail,
    }));
    return json({ ok: true, storedAt, storedBy: userEmail });
  }

  // ------------ ADMIN: clear the bridge token ------------
  if (action === 'admin-clear-token') {
    if (!ADMIN_EMAILS.includes(userEmail)) {
      return json({ error: 'Not an admin', email: userEmail }, 403);
    }
    const store = getStore('youtube-bridge');
    await store.delete('refresh-token-meta');
    return json({ ok: true });
  }

  // ------------ USER: init resumable video upload via bridge ------------
  if (action === 'init-upload') {
    if (!ALLOWED_EMAILS.includes(userEmail)) {
      return json({ error: 'Not authorized to upload via bridge', email: userEmail }, 403);
    }
    const { contentType, fileSize, snippet, status: videoStatus } = body;
    if (!contentType || !fileSize || !snippet) {
      return json({ error: 'Missing upload metadata' }, 400);
    }

    const bridgeAccessToken = await getBridgeAccessToken({
      clientId: YOUTUBE_CLIENT_ID,
      clientSecret: YOUTUBE_CLIENT_SECRET,
    });
    if (!bridgeAccessToken) {
      return json({
        error: 'Bridge token missing or expired. Admin must re-connect at /admin/connect-youtube.',
      }, 503);
    }

    // CRITICAL: pass through the user's Origin header so YouTube issues
    // proper CORS headers on the resumable upload URL it returns. Without
    // this, the browser PUT to the upload URL gets blocked by CORS
    // because the response has no Access-Control-Allow-Origin header.
    // Localhost origins (netlify dev) work the same way.
    const userOrigin = req.headers.get('origin') || 'https://vhsgarage.com';

    const initRes = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${bridgeAccessToken}`,
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': contentType,
          'X-Upload-Content-Length': String(fileSize),
          'Origin': userOrigin,
        },
        body: JSON.stringify({ snippet, status: videoStatus || { privacyStatus: 'private' } }),
      }
    );

    if (!initRes.ok) {
      const detail = await initRes.text();
      return json({
        error: 'YouTube init failed',
        detail,
        ytStatus: initRes.status,
      }, initRes.status);
    }

    const uploadUrl = initRes.headers.get('location');
    return json({ uploadUrl, channel: 'VHS Garage' });
  }

  // ------------ USER: upload thumbnail via bridge ------------
  if (action === 'upload-thumbnail') {
    if (!ALLOWED_EMAILS.includes(userEmail)) {
      return json({ error: 'Not authorized to use bridge', email: userEmail }, 403);
    }
    const { videoId, dataUrl } = body;
    if (!videoId || !dataUrl) return json({ error: 'Missing videoId or dataUrl' }, 400);

    const bridgeAccessToken = await getBridgeAccessToken({
      clientId: YOUTUBE_CLIENT_ID,
      clientSecret: YOUTUBE_CLIENT_SECRET,
    });
    if (!bridgeAccessToken) {
      return json({ error: 'Bridge token missing or expired' }, 503);
    }

    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx < 0) return json({ error: 'Invalid dataUrl' }, 400);
    const meta = dataUrl.slice(0, commaIdx);
    const b64 = dataUrl.slice(commaIdx + 1);
    const mimeType = (meta.match(/data:([^;]+)/) || [, 'image/jpeg'])[1];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const res = await fetch(
      `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${bridgeAccessToken}`,
          'Content-Type': mimeType,
        },
        body: bytes,
      }
    );

    if (!res.ok) {
      const detail = await res.text();
      return json({ error: 'Thumbnail upload failed', detail, ytStatus: res.status }, res.status);
    }
    return json({ ok: true });
  }

  // ------------ USER: record a successful bridge upload (stats only) ------------
  // Called by the client after a video PUT succeeds. We don't trust the
  // numbers blindly — both fields are clamped to sane ranges — but the
  // user has to be allow-listed first to call this at all.
  if (action === 'record-upload') {
    if (!ALLOWED_EMAILS.includes(userEmail)) {
      return json({ error: 'Not authorized to record stats', email: userEmail }, 403);
    }
    const { durationSeconds, byteSize, videoId } = body;
    const dur = Math.max(0, Math.min(Number(durationSeconds) || 0, 60 * 60 * 12)); // cap 12h
    const bytes = Math.max(0, Math.min(Number(byteSize) || 0, 50 * 1024 * 1024 * 1024)); // cap 50GB
    const store = getStore('youtube-bridge');
    const current = await store.get('bridge-stats', { type: 'json' }).catch(() => null) || {
      uploads: 0, totalSeconds: 0, totalBytes: 0, byUploader: {}, lastUploadAt: null,
    };
    current.uploads += 1;
    current.totalSeconds += dur;
    current.totalBytes += bytes;
    current.lastUploadAt = new Date().toISOString();
    current.byUploader[userEmail] = (current.byUploader[userEmail] || 0) + 1;
    if (videoId) current.lastVideoId = videoId;
    await store.set('bridge-stats', JSON.stringify(current));
    return json({ ok: true });
  }

  return json({ error: 'Unknown action: ' + action }, 400);
};

// Verify a Google access token via the public tokeninfo endpoint. Returns
// the parsed payload (which includes `email` when the openid+email scopes
// were granted) or null if the token is invalid/expired.
async function verifyAccessToken(token) {
  try {
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Read the stored bridge refresh token from Netlify Blobs and exchange it
// for a fresh access token. Returns null if no token is stored or the
// exchange fails (refresh token revoked / expired / etc.).
async function getBridgeAccessToken({ clientId, clientSecret }) {
  const store = getStore('youtube-bridge');
  const stored = await store.get('refresh-token-meta', { type: 'json' }).catch(() => null);
  if (!stored?.refreshToken) return null;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: stored.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.access_token || null;
}

function parseEmails(s) {
  return String(s || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const config = { path: '/api/youtube-bridge' };
