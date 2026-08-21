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

// ---- two credentials, not one ----

test('canDownload needs the key AND a login', () => {
  // Search is happy with the key alone; download is not. Sending only the key
  // meant every search succeeded, every download 401'd, and every quote came
  // back with a guessed timecode — a total failure that read as a bad matcher.
  const full = { OpenSubtitles: 'k', OPENSUBTITLES_USERNAME: 'u', OPENSUBTITLES_PASSWORD: 'p' };
  assert.equal(osCredentials(full).canDownload, true);
  for (const missing of ['OpenSubtitles', 'OPENSUBTITLES_USERNAME', 'OPENSUBTITLES_PASSWORD']) {
    const env = { ...full };
    delete env[missing];
    assert.equal(osCredentials(env).canDownload, false, `${missing} was treated as optional`);
  }
  assert.equal(osCredentials({}).canDownload, false);
});

test('the key is read under either name', () => {
  // The env var was set as "OpenSubtitles"; the conventional spelling should
  // work too rather than silently reading as absent.
  assert.equal(osCredentials({ OpenSubtitles: 'k' }).apiKey, 'k');
  assert.equal(osCredentials({ OPENSUBTITLES_API_KEY: 'k' }).apiKey, 'k');
});

test('login says which piece is missing instead of failing at the far end', async () => {
  await assert.rejects(() => login({}), /key missing/i);
  await assert.rejects(
    () => login({ apiKey: 'k' }),
    /OPENSUBTITLES_USERNAME and OPENSUBTITLES_PASSWORD/,
  );
});

test('downloadSubtitle refuses to try without a token', async () => {
  // Better a named error than a bare 401 that reads as "no subtitles exist".
  await assert.rejects(() => downloadSubtitle('123', { apiKey: 'k' }), /login token/i);
  await assert.rejects(() => downloadSubtitle('', { apiKey: 'k', token: 't' }), /Missing subtitle file/);
});

test('the token refresh window sits well inside the day the token lasts', () => {
  assert.ok(TOKEN_TTL_MS > 0 && TOKEN_TTL_MS < 24 * 60 * 60 * 1000);
});
