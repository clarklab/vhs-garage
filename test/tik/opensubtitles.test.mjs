import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  numericImdbId, pickBestSubtitle, osCredentials, login, downloadSubtitle, TOKEN_TTL_MS,
} from '../../netlify/functions/lib/opensubtitles.mjs';

test('numericImdbId strips the tt prefix', () => {
  assert.equal(numericImdbId('tt0103064'), '103064');
  assert.equal(numericImdbId('tt0120338'), '120338');
  assert.equal(numericImdbId('0103064'), '103064');
  assert.equal(numericImdbId(''), null);
  assert.equal(numericImdbId('nope'), null);
});

const file = (fileId, name = 'movie.srt') => ({ file_id: fileId, file_name: name });
const hit = (attrs) => ({ attributes: { files: [file(1, 'a.srt')], ...attrs } });

test('pickBestSubtitle prefers English, human, trusted, downloaded, srt', () => {
  const machine = hit({ language: 'en', ai_translated: true, machine_translated: true, from_trusted: false, download_count: 99999, files: [file(9, 'x.srt')] });
  const french = hit({ language: 'fr', ai_translated: false, machine_translated: false, from_trusted: true, download_count: 5000, files: [file(8, 'x.srt')] });
  const zip = hit({ language: 'en', ai_translated: false, machine_translated: false, from_trusted: true, download_count: 4000, files: [file(7, 'x.zip')] });
  const good = hit({ language: 'en', ai_translated: false, machine_translated: false, from_trusted: true, download_count: 1200, files: [file(3, 't2.srt')] });
  const ok = hit({ language: 'en', ai_translated: false, machine_translated: false, from_trusted: false, download_count: 8000, files: [file(4, 't2.srt')] });
  const picked = pickBestSubtitle([machine, french, zip, ok, good]);
  assert.equal(picked.file_id, 3);
});

test('pickBestSubtitle returns null when nothing is usable', () => {
  assert.equal(pickBestSubtitle([]), null);
  assert.equal(pickBestSubtitle(null), null);
});

// ---- anonymous first, login only if refused ----

test('a key alone is enough to TRY a download', () => {
  // A consumer can be configured to allow downloads with no user token, and
  // an "under dev" consumer gets 100 a day that way. Refusing to attempt one
  // without a username and password breaks exactly those installs.
  const key = osCredentials({ OpenSubtitles: 'k' });
  assert.equal(key.canTry, true);
  assert.equal(key.canLogin, false, 'no login is available, but that must not stop the attempt');
  assert.equal(osCredentials({}).canTry, false, 'without a key there is nothing to try');
});

test('canLogin needs all three, since it is the fallback', () => {
  const full = { OpenSubtitles: 'k', OPENSUBTITLES_USERNAME: 'u', OPENSUBTITLES_PASSWORD: 'p' };
  assert.equal(osCredentials(full).canLogin, true);
  for (const missing of ['OpenSubtitles', 'OPENSUBTITLES_USERNAME', 'OPENSUBTITLES_PASSWORD']) {
    const env = { ...full };
    delete env[missing];
    assert.equal(osCredentials(env).canLogin, false, `${missing} was treated as optional`);
  }
});

test('the key is read under either name', () => {
  // The env var was set as "OpenSubtitles"; the conventional spelling should
  // work too rather than silently reading as absent.
  assert.equal(osCredentials({ OpenSubtitles: 'k' }).apiKey, 'k');
  assert.equal(osCredentials({ OPENSUBTITLES_API_KEY: 'k' }).apiKey, 'k');
});

test('downloadSubtitle needs a file and a key, but NOT a token', async () => {
  await assert.rejects(() => downloadSubtitle('', { apiKey: 'k' }), /Missing subtitle file/);
  await assert.rejects(() => downloadSubtitle('123', {}), /key missing/i);
  // No token is a normal anonymous call: it must get as far as the network,
  // not be turned away here.
  await assert.doesNotReject(
    () => downloadSubtitle('123', { apiKey: 'k', signal: AbortSignal.abort() }).catch((e) => {
      assert.doesNotMatch(String(e.message), /token/i, `refused locally instead of trying: ${e.message}`);
    }),
  );
});

test('login says which piece is missing instead of failing at the far end', async () => {
  await assert.rejects(() => login({}), /key missing/i);
  await assert.rejects(
    () => login({ apiKey: 'k' }),
    /OPENSUBTITLES_USERNAME and OPENSUBTITLES_PASSWORD/,
  );
});

test('the token refresh window sits well inside the day the token lasts', () => {
  assert.ok(TOKEN_TTL_MS > 0 && TOKEN_TTL_MS < 24 * 60 * 60 * 1000);
});
