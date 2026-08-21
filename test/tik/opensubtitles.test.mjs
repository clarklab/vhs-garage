import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numericImdbId, pickBestSubtitle } from '../../netlify/functions/lib/opensubtitles.mjs';

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
