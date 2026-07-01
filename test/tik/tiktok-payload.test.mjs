import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PHOTOS, validateForInit, buildInitPayload,
} from '../../netlify/functions/lib/tiktok-payload.mjs';

test('validateForInit rejects empty photo list', () => {
  const r = validateForInit({ photoUrls: [], coverIndex: 0 });
  assert.equal(r.ok, false);
});

test('validateForInit rejects more than MAX_PHOTOS', () => {
  const photoUrls = Array.from({ length: MAX_PHOTOS + 1 }, (_, i) => `https://x/${i}.jpg`);
  assert.equal(validateForInit({ photoUrls, coverIndex: 0 }).ok, false);
});

test('validateForInit rejects a cover index out of range', () => {
  assert.equal(validateForInit({ photoUrls: ['https://x/0.jpg'], coverIndex: 5 }).ok, false);
});

test('validateForInit rejects non-https urls', () => {
  assert.equal(validateForInit({ photoUrls: ['http://x/0.jpg'], coverIndex: 0 }).ok, false);
});

test('validateForInit accepts a good set', () => {
  assert.equal(validateForInit({ photoUrls: ['https://x/0.jpg'], coverIndex: 0 }).ok, true);
});

test('buildInitPayload produces the PHOTO / MEDIA_UPLOAD / PULL_FROM_URL body', () => {
  const body = buildInitPayload({
    photoUrls: ['https://x/0.jpg', 'https://x/1.jpg'],
    coverIndex: 1,
    title: 'Jaws (1975)',
    description: '#movietrivia',
  });
  assert.equal(body.media_type, 'PHOTO');
  assert.equal(body.post_mode, 'MEDIA_UPLOAD');
  assert.equal(body.source_info.source, 'PULL_FROM_URL');
  assert.deepEqual(body.source_info.photo_images, ['https://x/0.jpg', 'https://x/1.jpg']);
  assert.equal(body.source_info.photo_cover_index, 1);
  assert.equal(body.post_info.title, 'Jaws (1975)');
  assert.equal(body.post_info.description, '#movietrivia');
});

test('buildInitPayload truncates title to 90 and description to 4000 UTF-16 units', () => {
  const body = buildInitPayload({
    photoUrls: ['https://x/0.jpg'],
    coverIndex: 0,
    title: 'x'.repeat(200),
    description: 'y'.repeat(5000),
  });
  assert.equal(body.post_info.title.length, 90);       // .length == UTF-16 code units
  assert.equal(body.post_info.description.length, 4000);
});

test('buildInitPayload does not split a surrogate pair when truncating', () => {
  // '😀' is 2 UTF-16 units. A title of 46 emoji = 92 units; truncating to 90
  // must drop the last whole emoji, not leave a dangling half-surrogate.
  const body = buildInitPayload({
    photoUrls: ['https://x/0.jpg'], coverIndex: 0, title: '😀'.repeat(46),
  });
  assert.ok(body.post_info.title.length <= 90);
  assert.equal(body.post_info.title, '😀'.repeat(45)); // 90 units, no broken pair
});
