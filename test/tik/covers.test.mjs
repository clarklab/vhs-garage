import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedCoverUrl, allowedCoverHost, allowedCoverType, COVER_HOSTS, MAX_COVER_BYTES,
} from '../../netlify/functions/lib/covers.mjs';

// The proxy fetches a URL the page hands it, which is an SSRF hole unless the
// allowlist is airtight. These are the cases that would open it.

test('a real TikTok cover URL is allowed', () => {
  for (const u of [
    'https://p16-sign-sg.tiktokcdn.com/obj/tos-alisg-p-0037/abc~tplv-photomode.jpeg',
    'https://p19-sign.tiktokcdn-us.com/obj/tos-useast5-p-0068/def.jpeg',
    'https://p16-pu-sign-no.tiktokcdn-eu.com/obj/x.jpeg',
    'https://v16m.tiktokv.com/cover.jpg',
  ]) {
    assert.equal(allowedCoverUrl(u), true, u);
  }
});

test('a host that merely ENDS with an allowed name is refused', () => {
  // The classic allowlist bug: endsWith('tiktokcdn.com') passes this.
  assert.equal(allowedCoverHost('eviltiktokcdn.com'), false);
  assert.equal(allowedCoverHost('nottiktokv.com'), false);
  assert.equal(allowedCoverUrl('https://eviltiktokcdn.com/x.jpg'), false);
});

test('an allowed name buried in a longer host is refused', () => {
  assert.equal(allowedCoverUrl('https://tiktokcdn.com.attacker.net/x.jpg'), false);
  assert.equal(allowedCoverUrl('https://attacker.net/?x=tiktokcdn.com'), false);
});

test('our own network is not reachable through it', () => {
  for (const u of [
    'http://169.254.169.254/latest/meta-data/',          // cloud metadata
    'https://169.254.169.254/latest/meta-data/',
    'http://localhost:8888/.netlify/functions/tik-publish',
    'https://127.0.0.1/admin',
    'http://[::1]/',
    'https://10.0.0.5/internal',
  ]) {
    assert.equal(allowedCoverUrl(u), false, u);
  }
});

test('only https, and never with credentials in the URL', () => {
  assert.equal(allowedCoverUrl('http://p16-sign-sg.tiktokcdn.com/x.jpg'), false, 'plain http');
  assert.equal(allowedCoverUrl('https://user:pass@p16-sign-sg.tiktokcdn.com/x.jpg'), false);
  assert.equal(allowedCoverUrl('file:///etc/passwd'), false);
  assert.equal(allowedCoverUrl('data:image/png;base64,iVBOR'), false);
  assert.equal(allowedCoverUrl('javascript:alert(1)'), false);
});

test('junk is refused rather than thrown over', () => {
  assert.equal(allowedCoverUrl(''), false);
  assert.equal(allowedCoverUrl(null), false);
  assert.equal(allowedCoverUrl('not a url at all'), false);
  assert.equal(allowedCoverHost(''), false);
  assert.equal(allowedCoverHost(null), false);
});

test('the host list is domains, not patterns', () => {
  // A wildcard or a stray dot here would quietly widen the allowlist.
  for (const d of COVER_HOSTS) {
    assert.match(d, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, `${d} should be a bare domain`);
  }
});

test('only images come back out', () => {
  assert.equal(allowedCoverType('image/jpeg'), true);
  assert.equal(allowedCoverType('image/webp; charset=binary'), true);
  assert.equal(allowedCoverType('text/html'), false);
  assert.equal(allowedCoverType('application/json'), false);
  assert.equal(allowedCoverType('image/svg+xml'), false, 'SVG carries script');
  assert.equal(allowedCoverType(''), false);
});

test('there is a size ceiling', () => {
  assert.ok(MAX_COVER_BYTES > 0 && MAX_COVER_BYTES <= 10 * 1024 * 1024);
});
