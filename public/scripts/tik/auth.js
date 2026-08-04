// TikTok OAuth (Login Kit for Web) on the client. /tik is server-backed and the
// code exchange happens in tik-auth.mjs with the client secret, so there is no
// PKCE. The refresh token lives in localStorage (client-trusted, no server
// session). buildAuthorizeUrl is pure (unit-tested); the rest is browser-only
// (sessionStorage, localStorage, location) and only inside functions.

const AUTHORIZE_BASE = 'https://www.tiktok.com/v2/auth/authorize/';
// user.info.stats powers the follower chart — it must also be enabled on the
// app in the TikTok developer portal, or the authorize page rejects the scope.
const SCOPE = 'user.info.basic,user.info.stats,video.upload';
// Batch mode reads the account's own post history to work out which films are
// already covered. video.list is a Display API scope that needs its own
// approval in the developer portal, and TikTok rejects the WHOLE authorize
// request when an app asks for a scope it doesn't hold — which would take
// sign-in and publishing down with it. So it is never part of the normal
// sign-in: batch mode asks for it separately, and only if the user opts in.
export const HISTORY_SCOPE = `${SCOPE},video.list`;
const LS_REFRESH = 'tik_refresh_token';
const SS_STATE = 'tik_oauth_state';

export function buildAuthorizeUrl({ clientKey, redirectUri, state, scope = SCOPE }) {
  const p = new URLSearchParams({
    client_key: clientKey,
    scope,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
  });
  return `${AUTHORIZE_BASE}?${p.toString()}`;
}

export function isSignedIn() {
  return !!localStorage.getItem(LS_REFRESH);
}
export function getRefreshToken() {
  return localStorage.getItem(LS_REFRESH);
}
// Drop the stored token WITHOUT revoking — for when TikTok reports it already
// invalid (401) and we just want to force a fresh sign-in.
export function clearLocalToken() {
  localStorage.removeItem(LS_REFRESH);
}

function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Kick off sign-in: fetch client_key, set a CSRF state, redirect to TikTok.
export async function startAuth() {
  const { clientKey } = await fetch('/.netlify/functions/tik-auth').then((r) => r.json());
  if (!clientKey) throw new Error('TikTok OAuth is not configured on the server.');
  const state = randomHex(16);
  sessionStorage.setItem(SS_STATE, state);
  const redirectUri = location.origin + location.pathname;
  location.href = buildAuthorizeUrl({ clientKey, redirectUri, state });
}

// On page load: if we came back with ?code=&state=, exchange it for tokens.
// Returns true if a sign-in was completed on this load.
export async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const state = params.get('state');
  const authError = params.get('error');
  if (authError) {
    // TikTok bounced back with an error (e.g. the user cancelled). Clean the URL
    // and surface it so the caller can show a message instead of failing silently.
    history.replaceState({}, '', location.origin + location.pathname);
    throw new Error(params.get('error_description') || `TikTok sign-in was cancelled (${authError}).`);
  }
  if (!code) return false;
  const expectedState = sessionStorage.getItem(SS_STATE);
  // Clean the URL regardless of outcome.
  history.replaceState({}, '', location.origin + location.pathname);
  if (!expectedState || state !== expectedState) throw new Error('OAuth state mismatch — try again.');

  const redirectUri = location.origin + location.pathname;
  const res = await fetch('/.netlify/functions/tik-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'exchange', code, redirectUri }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  localStorage.setItem(LS_REFRESH, data.refreshToken);
  sessionStorage.removeItem(SS_STATE);
  return true;
}

export async function signOut() {
  const token = getRefreshToken();
  clearLocalToken();
  if (token) {
    await fetch('/.netlify/functions/tik-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'revoke', token }),
    }).catch(() => {});
  }
}
