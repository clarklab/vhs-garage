import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthorizeUrl, HISTORY_SCOPE } from '../../public/scripts/tik/auth.js';

test('buildAuthorizeUrl builds the TikTok Web login URL', () => {
  const u = new URL(buildAuthorizeUrl({
    clientKey: 'ck123',
    redirectUri: 'https://vhs.example/tik',
    state: 'st',
  }));
  assert.equal(u.origin + u.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
  assert.equal(u.searchParams.get('client_key'), 'ck123');
  assert.equal(u.searchParams.get('response_type'), 'code');
  // user.info.stats powers the follower chart on the studio home screen.
  assert.equal(u.searchParams.get('scope'), 'user.info.basic,user.info.stats,video.upload');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://vhs.example/tik');
  assert.equal(u.searchParams.get('state'), 'st');
});

test('the default sign-in scope never asks for video.list', () => {
  // TikTok rejects the WHOLE authorize request when an app asks for a scope it
  // does not hold, so a video.list that leaked into normal sign-in would take
  // publishing down with it, not just reporting.
  const u = new URL(buildAuthorizeUrl({ clientKey: 'ck', redirectUri: 'https://x/tik', state: 's' }));
  assert.doesNotMatch(u.searchParams.get('scope'), /video\.list/);
});

test('HISTORY_SCOPE adds video.list on top of the default scope, losing none of it', () => {
  const base = new URL(buildAuthorizeUrl({ clientKey: 'ck', redirectUri: 'https://x/tik', state: 's' }))
    .searchParams.get('scope').split(',');
  const history = HISTORY_SCOPE.split(',');
  for (const scope of base) assert.ok(history.includes(scope), `${scope} was dropped`);
  assert.ok(history.includes('video.list'));
});

test('buildAuthorizeUrl carries an explicit scope through to the URL', () => {
  const u = new URL(buildAuthorizeUrl({
    clientKey: 'ck', redirectUri: 'https://x/tik', state: 's', scope: HISTORY_SCOPE,
  }));
  assert.equal(u.searchParams.get('scope'), HISTORY_SCOPE);
});

test('buildAuthorizeUrl omits PKCE params (Web flow)', () => {
  const u = new URL(buildAuthorizeUrl({ clientKey: 'ck', redirectUri: 'https://x/tik', state: 's' }));
  assert.equal(u.searchParams.get('code_challenge'), null);
  assert.equal(u.searchParams.get('code_challenge_method'), null);
});
