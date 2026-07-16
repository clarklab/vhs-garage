import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthorizeUrl } from '../../public/scripts/tik/auth.js';

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

test('buildAuthorizeUrl omits PKCE params (Web flow)', () => {
  const u = new URL(buildAuthorizeUrl({ clientKey: 'ck', redirectUri: 'https://x/tik', state: 's' }));
  assert.equal(u.searchParams.get('code_challenge'), null);
  assert.equal(u.searchParams.get('code_challenge_method'), null);
});
