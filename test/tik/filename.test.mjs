import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMovieName } from '../../public/scripts/tik/filename.js';

test('parses a scene-release filename to title + year', () => {
  const r = parseMovieName('Jaws.1975.1080p.BluRay.x264-YIFY.mkv');
  assert.equal(r.title, 'Jaws');
  assert.equal(r.year, '1975');
  assert.equal(r.query, 'Jaws (1975)');
});

test('strips tags after the year and normalizes separators', () => {
  assert.deepEqual(
    { ...parseMovieName('The.Thing.1982.REMASTERED.720p.mp4') },
    { title: 'The Thing', year: '1982', query: 'The Thing (1982)' }
  );
});

test('handles underscores', () => {
  const r = parseMovieName('Blade_Runner_1982.avi');
  assert.equal(r.title, 'Blade Runner');
  assert.equal(r.year, '1982');
});

test('no year → null year and query is just the title', () => {
  const r = parseMovieName('Alien.mkv');
  assert.equal(r.title, 'Alien');
  assert.equal(r.year, null);
  assert.equal(r.query, 'Alien');
});

test('handles parens/brackets around year and quality', () => {
  const r = parseMovieName('Back to the Future (1985) [1080p].mp4');
  assert.equal(r.title, 'Back to the Future');
  assert.equal(r.year, '1985');
});
