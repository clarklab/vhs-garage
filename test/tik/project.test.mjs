import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORMATS, formatOf, makeProject, defaultPostFields, captionForRole, relativeTime, projectDisplayName,
} from '../../public/scripts/tik/project.js';

test('makeProject builds a draft with the right shape and format fallback', () => {
  const p = makeProject({ id: 'abc', format: 'guys', now: 1000 });
  assert.equal(p.id, 'abc');
  assert.equal(p.format, 'guys');
  assert.equal(p.status, 'draft');
  assert.equal(p.createdAt, 1000);
  assert.equal(p.updatedAt, 1000);
  assert.equal(p.postedAt, null);
  assert.deepEqual(p.slides, []);
  assert.equal(p.postEdited, false);
  // Unknown format falls back to trivia rather than exploding.
  assert.equal(makeProject({ id: 'x', format: 'nope', now: 1 }).format, 'trivia');
});

test('formatOf falls back to Tape Trivia', () => {
  assert.equal(formatOf({ format: 'guys' }).label, 'Remembering Some Guys');
  assert.equal(formatOf({ format: 'mystery' }).label, 'Tape Trivia');
  assert.equal(formatOf(null).label, 'Tape Trivia');
  assert.ok(FORMATS.trivia.icon && FORMATS.guys.icon);
});

test('trivia post defaults ask for a favorite quote, ≤5 hashtags', () => {
  const d = defaultPostFields('trivia', 'Jaws (1975)');
  assert.match(d.title, /Jaws \(1975\)/);
  assert.match(d.description, /favorite quote from the movie/i);
  assert.match(d.description, /follow VHS Garage/i);
  const tags = d.description.match(/#\w+/g) || [];
  assert.ok(tags.length <= 5, `expected ≤5 hashtags, got ${tags.length}`);
});

test('guys post defaults ask for a favorite role, ≤5 hashtags, name-safe fallback', () => {
  const d = defaultPostFields('guys', 'Keith David');
  assert.match(d.title, /Remembering some guys: Keith David/);
  assert.match(d.description, /Which one is your favorite/);
  const tags = d.description.match(/#\w+/g) || [];
  assert.ok(tags.length <= 5, `expected ≤5 hashtags, got ${tags.length}`);
  const empty = defaultPostFields('guys', '');
  assert.match(empty.title, /Remembering some guys/);
});

test('captionForRole formats "Movie (Year)" + blurb, hook fallback, no year fallback', () => {
  const role = { movie: 'They Live', year: 1988, role: 'Frank', hook: 'The alley fight ran six minutes.' };
  assert.equal(
    captionForRole(role, 'Frank made sunglasses a threat.'),
    'They Live (1988)\nFrank made sunglasses a threat.'
  );
  // No blurb → the picker hook carries the slide.
  assert.equal(captionForRole(role, ''), 'They Live (1988)\nThe alley fight ran six minutes.');
  // No year → no parens.
  assert.equal(captionForRole({ movie: 'Mystery', year: null, role: 'X', hook: 'h' }, 'b'), 'Mystery\nb');
});

test('relativeTime buckets: now/minutes/hours/days/date', () => {
  const now = 10 * 24 * 60 * 60 * 1000; // fixed "now"
  assert.equal(relativeTime(now - 30_000, now), 'just now');
  assert.equal(relativeTime(now - 5 * 60_000, now), '5m ago');
  assert.equal(relativeTime(now - 3 * 3_600_000, now), '3h ago');
  assert.equal(relativeTime(now - 2 * 86_400_000, now), '2d ago');
  // Very old → a real date string (locale-dependent; just require non-"ago").
  const old = relativeTime(now - 40 * 86_400_000, now);
  assert.doesNotMatch(old, /ago$/);
});

test('projectDisplayName falls back to Untitled', () => {
  assert.equal(projectDisplayName({ name: 'Jaws (1975)' }), 'Jaws (1975)');
  assert.equal(projectDisplayName({ name: '   ' }), 'Untitled');
  assert.equal(projectDisplayName(null), 'Untitled');
});
