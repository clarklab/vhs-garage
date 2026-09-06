// The account's own post history, for batch mode's "what have we already
// covered?" question.
//
// POST { refreshToken } → { posts, movies, scope: 'granted'|'missing', error? }
//
// This needs TikTok's video.list scope, which is a separate Display API
// permission from the ones normal sign-in asks for. Until it is approved the
// call 403s, and that is an expected state rather than a bug: we answer 200
// with scope:'missing' so batch mode can fall back to the local library and
// say why, instead of showing the user a broken screen.
import { summarizeHistory, summarizeTagRows, importablePosts } from './lib/queue.mjs';

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const LIST_URL = 'https://open.tiktokapis.com/v2/video/list/';
const FIELDS = 'id,title,video_description,create_time,view_count,like_count,comment_count,share_count';
const PAGE_SIZE = 20;   // TikTok's per-request maximum
const MAX_PAGES = 10;   // 200 posts is far more history than the queue needs

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  if (!CLIENT_KEY || !CLIENT_SECRET) return json({ error: 'TikTok OAuth not configured' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const refreshToken = body?.refreshToken;
  if (!refreshToken) return json({ error: 'Not signed in' }, 401);

  const accessToken = await getAccessToken(refreshToken);
  if (!accessToken) {
    console.error('[tik-history] token refresh failed — refresh token invalid/expired');
    return json({ error: 'Could not get access token — please sign in again', reauth: true }, 401);
  }

  const posts = [];
  let cursor = null;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(`${LIST_URL}?fields=${encodeURIComponent(FIELDS)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cursor ? { max_count: PAGE_SIZE, cursor } : { max_count: PAGE_SIZE }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || data?.error?.code === 'scope_not_authorized' || res.status === 403) {
        const code = String(data?.error?.code || '');
        const scopeIssue = res.status === 403 || /scope|permission|unauthorized/i.test(code);
        if (scopeIssue) {
          // Expected until the portal grants video.list. Not an error state.
          console.warn('[tik-history] video.list not granted', { status: res.status, code });
          return json({
            posts: 0, rows: [], movies: [], quoteMovies: [], tagRows: [], scope: 'missing',
            error: 'This TikTok app has not been granted the video.list scope yet.',
            hint: 'Request the video.list scope in the TikTok developer portal, then use "Connect post history" to re-authorize. Batch mode uses your local library until then.',
          });
        }
        console.error('[tik-history] video list failed', { status: res.status, tiktok: data?.error });
        return json({ error: data?.error?.message || 'TikTok video list unavailable' }, 502);
      }

      const videos = data?.data?.videos || [];
      posts.push(...videos);
      cursor = data?.data?.cursor;
      if (!data?.data?.has_more || !cursor || !videos.length) break;
    }
  } catch (e) {
    console.error('[tik-history] request threw', { message: e.message });
    return json({ error: 'Could not read post history' }, 502);
  }

  // `movies` answers "what have we covered" (film-gated, deduped); `tagRows`
  // answers "which tags work" (every tagged post, however it was retitled).
  return json({
    posts: posts.length,
    // One row per post, so the library can take in what was published before
    // it existed. summarizeHistory below still answers the coverage question.
    rows: importablePosts(posts),
    movies: summarizeHistory(posts),
    quoteMovies: summarizeHistory(posts, { format: 'quotes' }),
    tagRows: summarizeTagRows(posts),
    scope: 'granted',
  });
};

async function getAccessToken(refreshToken) {
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: CLIENT_KEY, client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token', refresh_token: refreshToken,
      }),
    });
    const data = await res.json().catch(() => ({}));
    return data?.access_token || null;
  } catch (e) {
    console.error('[tik-history] token refresh threw', { message: e.message });
    return null;
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
