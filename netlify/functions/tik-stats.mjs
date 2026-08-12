// Follower stats for the studio home screen. TikTok's Display API only
// reports the CURRENT counts (there is no history endpoint), so this function
// snapshots them into Blobs and serves the accumulated series:
// - POST { refreshToken } → refresh token, fetch user info (needs the
//   user.info.stats scope), append today's snapshot, return series + profile.
// - GET → the stored series only (no auth; follower counts are public data).
import { getStore } from '@netlify/blobs';
import { STATS_STORE, SERIES_KEY, normalizeSeries, appendSnapshot, seriesDelta, todayKey } from './lib/stats.mjs';

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
// following_count costs nothing extra: it is the same user.info.stats scope we
// already hold for follower_count. The profile-scope fields (username,
// is_verified, bio_description) are deliberately NOT requested — that is a
// scope this app does not hold, and TikTok rejects the entire authorize
// request when an app asks for one it lacks.
const USER_INFO_URL = 'https://open.tiktokapis.com/v2/user/info/?fields=display_name,avatar_url,follower_count,following_count,likes_count,video_count';

export default async (req) => {
  if (req.method === 'GET') {
    try {
      const store = getStore(STATS_STORE);
      const series = normalizeSeries(await store.get(SERIES_KEY, { type: 'json' }));
      return json({ series, delta: seriesDelta(series) });
    } catch (e) {
      console.error('[tik-stats] series read failed', { message: e.message });
      return json({ error: 'Stats store unavailable' }, 500);
    }
  }
  if (req.method !== 'POST') return json({ error: 'GET or POST required' }, 405);
  if (!CLIENT_KEY || !CLIENT_SECRET) return json({ error: 'TikTok OAuth not configured' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { refreshToken } = body;
  if (!refreshToken) return json({ error: 'Not signed in' }, 401);

  const accessToken = await getAccessToken(refreshToken);
  if (!accessToken) {
    console.error('[tik-stats] token refresh failed — refresh token invalid/expired');
    return json({ error: 'Could not get access token — please sign in again', reauth: true }, 401);
  }

  const res = await fetch(USER_INFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json().catch(() => ({}));
  const user = data?.data?.user;
  const errCode = String(data?.error?.code || '');
  if (!user || !Number.isFinite(Number(user.follower_count))) {
    // The usual cause: the session predates the user.info.stats scope.
    console.error('[tik-stats] user info fetch failed', { status: res.status, tiktok: data?.error });
    const scopeIssue = errCode.includes('scope') || res.status === 403;
    return json({
      error: scopeIssue
        ? 'TikTok hasn’t granted follower stats to this session.'
        : (data?.error?.message || 'TikTok user info unavailable'),
      scope: scopeIssue,
      hint: scopeIssue
        ? 'Enable the user.info.stats scope for the app in the TikTok developer portal, then sign out and back in on this page.'
        : '',
    }, scopeIssue ? 403 : 502);
  }

  // `null` for anything TikTok did not send, never 0 — an absent count and a
  // count of zero mean different things to every report that reads this.
  const int = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
  const profile = {
    displayName: user.display_name || '',
    avatar: typeof user.avatar_url === 'string' ? user.avatar_url : '',
    followers: Math.round(Number(user.follower_count)),
    following: int(user.following_count),
    likes: int(user.likes_count),
    videos: int(user.video_count),
  };

  // Append today's snapshot. Failures to persist must not hide the live count.
  let series = [];
  try {
    const store = getStore(STATS_STORE);
    const stored = normalizeSeries(await store.get(SERIES_KEY, { type: 'json' }));
    const snap = { d: todayKey(), c: profile.followers };
    if (profile.likes !== null) snap.likes = profile.likes;
    if (profile.videos !== null) snap.videos = profile.videos;
    series = appendSnapshot(stored, snap);
    await store.setJSON(SERIES_KEY, series);
  } catch (e) {
    console.error('[tik-stats] snapshot write failed', { message: e.message });
    series = [{ d: todayKey(), c: profile.followers }];
  }

  return json({ series, delta: seriesDelta(series), profile });
};

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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
