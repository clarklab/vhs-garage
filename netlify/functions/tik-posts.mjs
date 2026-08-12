// Per-post stats for the Reports screen.
//
// This is tik-history's richer sibling and it supersedes it for reporting.
// tik-history answers batch mode's one question ("which films have we already
// covered?") and stays as it is; this one pulls every field the Display API
// will give us and, crucially, SNAPSHOTS them.
//
// The snapshot is the whole point. TikTok reports only a post's current totals
// — there is no per-post history endpoint — so a lifetime view count can tell
// you a post got 4k views but never whether it is still earning them. Storing
// one point a day turns those totals into velocity. See lib/posts.mjs.
//
// - GET  → the stored history alone (no auth; these are our own public numbers).
//          Lets the report render before, or without, a video.list grant.
// - POST { refreshToken } → refresh, page video/list, merge today's snapshot,
//          return the merged rows.
//
// Like tik-history this needs the video.list scope, which is a separate Display
// API permission. Until it is granted the call answers 200 with scope:'missing'
// and whatever history we already have, rather than showing a broken screen.
import { getStore } from '@netlify/blobs';
import { POSTS_STORE, POSTS_KEY, mergeSnapshots, storeToRows, snapshotDays, todayKey } from './lib/posts.mjs';
import { parsePostedMovie, parseHashtags } from './lib/queue.mjs';

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const LIST_URL = 'https://open.tiktokapis.com/v2/video/list/';
// Everything the Video Object exposes that we can actually reason about.
// height/width are omitted (every post is 1080x1920) and embed_html/embed_link
// have no use here.
const FIELDS = [
  'id', 'title', 'video_description', 'create_time', 'duration',
  'cover_image_url', 'share_url',
  'view_count', 'like_count', 'comment_count', 'share_count',
].join(',');
const PAGE_SIZE = 20;   // TikTok's per-request maximum
const MAX_PAGES = 10;   // 200 posts, which is as far back as video/list reaches

export default async (req) => {
  if (req.method === 'GET') {
    const store = await readStore();
    return json({
      posts: decorate(storeToRows(store)),
      snapshotDays: snapshotDays(store),
      scope: 'stored',
    });
  }
  if (req.method !== 'POST') return json({ error: 'GET or POST required' }, 405);
  if (!CLIENT_KEY || !CLIENT_SECRET) return json({ error: 'TikTok OAuth not configured' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const refreshToken = body?.refreshToken;
  if (!refreshToken) return json({ error: 'Not signed in' }, 401);

  const accessToken = await getAccessToken(refreshToken);
  if (!accessToken) {
    console.error('[tik-posts] token refresh failed — refresh token invalid/expired');
    return json({ error: 'Could not get access token — please sign in again', reauth: true }, 401);
  }

  const stored = await readStore();
  let videos;
  try {
    videos = await listVideos(accessToken);
  } catch (e) {
    if (e.scopeIssue) {
      // Expected until the portal grants video.list AND the user re-authorizes.
      // Serve the stored history anyway — it is still true, just not fresh.
      console.warn('[tik-posts] video.list not granted', { status: e.status, code: e.code });
      return json({
        posts: decorate(storeToRows(stored)),
        snapshotDays: snapshotDays(stored),
        scope: 'missing',
        error: 'This TikTok app has not been granted the video.list scope yet.',
        hint: 'Approve video.list in the TikTok developer portal, then use “Connect post history” to re-authorize.',
      });
    }
    console.error('[tik-posts] video list failed', { status: e.status, message: e.message, tiktok: e.tiktok });
    return json({ error: e.message || 'TikTok video list unavailable' }, 502);
  }

  // Merge first, persist second: a write failure must not cost the user the
  // numbers we just fetched, only the new point in the history.
  const day = todayKey();
  const merged = mergeSnapshots(stored, videos, { day });
  let persisted = true;
  try {
    await getStore(POSTS_STORE).setJSON(POSTS_KEY, merged);
  } catch (e) {
    persisted = false;
    console.error('[tik-posts] snapshot write failed', { message: e.message });
  }

  // Cover images come off the LIVE rows only — the CDN links expire after six
  // hours, so they are never stored (see metaFromVideo).
  const covers = new Map();
  for (const v of videos) {
    if (v?.id && v?.cover_image_url) covers.set(String(v.id), String(v.cover_image_url));
  }
  const posts = decorate(storeToRows(merged)).map((p) => (
    covers.has(p.id) ? { ...p, cover: covers.get(p.id) } : p
  ));

  return json({
    posts,
    fetched: videos.length,
    snapshotDays: snapshotDays(merged),
    persisted,
    scope: 'granted',
  });
};

// Film title and shipped hashtags, read off the post itself rather than our
// local library — the same rule tagreport.js follows, so a post retitled by
// hand in the TikTok app still reports correctly.
function decorate(rows) {
  return rows.map((row) => ({
    ...row,
    movie: parsePostedMovie(row.title, row.desc),
    tags: parseHashtags(row.desc),
  }));
}

async function readStore() {
  try {
    return await getStore(POSTS_STORE).get(POSTS_KEY, { type: 'json' });
  } catch (e) {
    console.error('[tik-posts] store read failed', { message: e.message });
    return {};
  }
}

async function listVideos(accessToken) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(`${LIST_URL}?fields=${encodeURIComponent(FIELDS)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cursor ? { max_count: PAGE_SIZE, cursor } : { max_count: PAGE_SIZE }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const code = String(data?.error?.code || '');
      const err = new Error(data?.error?.message || 'TikTok video list unavailable');
      err.status = res.status;
      err.code = code;
      err.tiktok = data?.error;
      err.scopeIssue = res.status === 403 || /scope|permission|unauthorized/i.test(code);
      throw err;
    }

    const videos = data?.data?.videos || [];
    out.push(...videos);
    cursor = data?.data?.cursor;
    if (!data?.data?.has_more || !cursor || !videos.length) break;
  }
  return out;
}

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
    console.error('[tik-posts] token refresh threw', { message: e.message });
    return null;
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
