// TikTok OAuth helper for the /tik page. Mirrors youtube-auth.mjs.
// - GET  → returns the public client_key so the browser can build the auth URL.
// - POST action=exchange → swaps a PKCE auth code for access + refresh tokens.
// - POST action=refresh  → swaps a refresh token for a fresh access token.
// - POST action=revoke   → revokes a token at TikTok.

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const REVOKE_URL = 'https://open.tiktokapis.com/v2/oauth/revoke/';

export default async (req) => {
  if (req.method === 'GET') {
    if (!CLIENT_KEY) return json({ error: 'TikTok OAuth not configured' }, 500);
    return json({ clientKey: CLIENT_KEY });
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!CLIENT_KEY || !CLIENT_SECRET) return json({ error: 'TikTok OAuth not configured' }, 500);

  const body = await req.json().catch(() => ({}));

  if (body.action === 'exchange') {
    const { code, redirectUri } = body;
    if (!code || !redirectUri) {
      return json({ error: 'Missing code or redirectUri' }, 400);
    }
    const data = await postForm({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    if (data.error && data.error !== 'ok') {
      return json({ error: data.error_description || data.error }, 400);
    }
    if (!data.refresh_token) {
      return json({ error: 'TikTok did not return a refresh token — try signing in again.' }, 400);
    }
    return json({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      openId: data.open_id,
    });
  }

  if (body.action === 'refresh') {
    const { refreshToken } = body;
    if (!refreshToken) return json({ error: 'Missing refreshToken' }, 400);
    const data = await postForm({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    if (!data.access_token) {
      return json({ error: data.error_description || 'Could not refresh token' }, 401);
    }
    return json({
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresIn: data.expires_in,
    });
  }

  if (body.action === 'revoke') {
    const { token } = body;
    if (!token) return json({ error: 'Missing token' }, 400);
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_key: CLIENT_KEY, client_secret: CLIENT_SECRET, token }),
    }).catch(() => {});
    return json({ ok: true });
  }

  return json({ error: 'Unknown action. Use exchange, refresh, or revoke.' }, 400);
};

async function postForm(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return res.json().catch(() => ({}));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
