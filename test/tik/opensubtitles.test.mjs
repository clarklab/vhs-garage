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

test('pickBestSubtitle prefers English, human, and the track most people use', () => {
  const machine = hit({ language: 'en', ai_translated: true, machine_translated: true, from_trusted: false, download_count: 99999, files: [file(9, 'x')] });
  const french = hit({ language: 'fr', ai_translated: false, machine_translated: false, from_trusted: true, download_count: 5000, files: [file(8, 'x')] });
  const trusted = hit({ language: 'en', ai_translated: false, machine_translated: false, from_trusted: true, download_count: 1200, files: [file(3, 'a.release.name')] });
  const popular = hit({ language: 'en', ai_translated: false, machine_translated: false, from_trusted: false, download_count: 8000, files: [file(4, 'another.release')] });
  // Downloads outrank the trusted flag on purpose: what we need is the track
  // that matches the cut of the film most people have, and popularity says
  // that better than a badge on the uploader does.
  assert.equal(pickBestSubtitle([machine, french, trusted, popular]).file_id, 4);
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

// ---- picking a subtitle out of a real search response ----
//
// These rows are trimmed from a live search for The Princess Bride
// (imdb_id 93779, 44 English tracks). The shape is the point: `file_name` is
// the RELEASE name and never ends in ".srt".
const REAL_ROWS = [
  { attributes: { language: 'en', ai_translated: false, machine_translated: false, from_trusted: false, download_count: 43,
    files: [{ file_id: 12706227, file_name: 'Princess Bride (1987) Special.Edition.DVD.US.Retail' }] } },
  { attributes: { language: 'en', ai_translated: false, machine_translated: false, from_trusted: false, download_count: 1674, hearing_impaired: true,
    files: [{ file_id: 11743238, file_name: 'The.Princess.Bride.1987.PROPER.2160p.BluRay.REMUX.HEVC.DTS-HD.MA.5.1-FGT.en-HI' }] } },
  { attributes: { language: 'en', ai_translated: false, machine_translated: false, from_trusted: true, download_count: 117565,
    files: [{ file_id: 516808, file_name: 'The.Princess.Bride.1987.1080p.x264-HD1080.ENG' }] } },
  { attributes: { language: 'en', ai_translated: false, machine_translated: false, from_trusted: false, download_count: 720,
    files: [{ file_id: 12432285, file_name: 'The.Princess.Bride.1987.DVDRip' }] } },
];

test('a real search response yields a subtitle, not nothing', () => {
  // The regression this exists for: requiring file_name to end in ".srt" threw
  // away all 44 English tracks for this film and reported "no English subtitle
  // for this title", which is plainly untrue and sent every quote to a guess.
  const pick = pickBestSubtitle(REAL_ROWS);
  assert.ok(pick, 'every English subtitle was filtered out');
  assert.ok(Number.isFinite(pick.file_id));
});

test('no file in a real response ends in .srt — the format comes from download', () => {
  const names = REAL_ROWS.flatMap((r) => r.attributes.files.map((f) => f.file_name));
  assert.equal(names.filter((n) => /\.srt$/i.test(n)).length, 0, 'fixture no longer reflects the API');
});

test('the most-downloaded clean track wins', () => {
  const pick = pickBestSubtitle(REAL_ROWS);
  assert.equal(pick.file_id, 516808, `picked ${pick.file_name}`);
});

test('hearing-impaired is a preference, never an exclusion', () => {
  const onlyHI = REAL_ROWS.filter((r) => r.attributes.hearing_impaired);
  assert.ok(pickBestSubtitle(onlyHI), 'an HI-only film would get no subtitles at all');
});

test('machine translations and other languages are still excluded', () => {
  assert.equal(pickBestSubtitle([
    { attributes: { language: 'fr', download_count: 9e9, files: [{ file_id: 1, file_name: 'x' }] } },
    { attributes: { language: 'en', ai_translated: true, download_count: 9e9, files: [{ file_id: 2, file_name: 'x' }] } },
    { attributes: { language: 'en', machine_translated: true, download_count: 9e9, files: [{ file_id: 3, file_name: 'x' }] } },
  ]), null);
  // en-US and friends are English.
  assert.ok(pickBestSubtitle([{ attributes: { language: 'en-US', download_count: 1, files: [{ file_id: 4, file_name: 'x' }] } }]));
});

test('rows with no usable file are skipped, not crashed on', () => {
  assert.equal(pickBestSubtitle([
    { attributes: { language: 'en', files: [] } },
    { attributes: { language: 'en', files: [{ file_name: 'no id here' }] } },
    { attributes: { language: 'en' } },
  ]), null);
  assert.equal(pickBestSubtitle([]), null);
  assert.equal(pickBestSubtitle(null), null);
});
