// YouTube OAuth helper (Edge Function variant) for /capture sign-in.
// - GET  → returns the public client_id so the browser can build the auth URL.
// - POST action=exchange → swaps an auth code (PKCE) for access + refresh tokens.
// - POST action=revoke   → revokes a refresh token at Google.

export default async (req) => {
  const env = (k) => Netlify.env.get(k);
  const YOUTUBE_CLIENT_ID = env('YOUTUBE_OAUTH_CLIENT_ID');
  const YOUTUBE_CLIENT_SECRET = env('YOUTUBE_OAUTH_CLIENT_SECRET');

  if (req.method === 'GET') {
    if (!YOUTUBE_CLIENT_ID) return json({ error: 'OAuth not configured' }, 500);
    return json({ clientId: YOUTUBE_CLIENT_ID });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET) {
    return json({ error: 'OAuth not configured' }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  if (body.action === 'exchange') {
    const { code, codeVerifier, redirectUri } = body;
    if (!code || !codeVerifier || !redirectUri) {
      return json({ error: 'Missing code, codeVerifier, or redirectUri' }, 400);
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: YOUTUBE_CLIENT_ID,
        client_secret: YOUTUBE_CLIENT_SECRET,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      return json({ error: data.error_description || data.error || 'Token exchange failed' }, 400);
    }

    if (!data.refresh_token) {
      return json({ error: 'Google did not return a refresh token. Revoke access at https://myaccount.google.com/permissions and sign in again.' }, 400);
    }

    return json({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    });
  }

  if (body.action === 'revoke') {
    const { token } = body;
    if (!token) return json({ error: 'Missing token' }, 400);
    await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token), {
      method: 'POST',
    }).catch(() => {});
    return json({ ok: true });
  }

  return json({ error: 'Unknown action. Use "exchange" or "revoke".' }, 400);
};

export const config = { path: '/api/youtube-auth' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
