import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORMATS, YEAR_LISTS, formatOf, makeProject, defaultPostFields, captionForRole,
  sectionCaption, captionForYearEntry, photoQueryFor, relativeTime, projectDisplayName,
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
  assert.equal(formatOf({ format: 'year' }).label, 'Year Snapshot');
  assert.equal(formatOf({ format: 'mystery' }).label, 'Tape Trivia');
  assert.equal(formatOf(null).label, 'Tape Trivia');
  // Every format needs the bits the editor chrome reads off it.
  for (const f of Object.values(FORMATS)) {
    assert.ok(f.icon && f.chip && f.editorHint && f.label, `${f.key} is missing chrome`);
  }
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

// ---- Year Snapshot ----

test('year post defaults name the year and ask what viewers watched, ≤5 hashtags', () => {
  const d = defaultPostFields('year', '1994');
  assert.match(d.title, /1994/);
  assert.match(d.description, /highest rated and highest grossing movies of 1994/i);
  assert.doesNotMatch(d.description, /rent/i);
  assert.match(d.description, /What were you watching in 1994\?/);
  const tags = d.description.match(/#\w+/g) || [];
  assert.ok(tags.length <= 5, `expected ≤5 hashtags, got ${tags.length}`);
  // No year yet (fresh project) still reads as a sentence.
  const empty = defaultPostFields('year', '');
  assert.doesNotMatch(empty.title, /undefined|null/);
  assert.match(empty.description, /that year/);
});

test('sectionCaption announces each top-eight list by name and year', () => {
  assert.equal(sectionCaption('rated', 1994), 'These are the top eight rated movies of 1994.');
  assert.equal(sectionCaption('boxoffice', 1994), 'These are the top eight box office numbers of 1994.');
  assert.equal(sectionCaption('nope', 1994), '');
  // Rentals were dropped as too obscure; nothing should still announce them.
  assert.equal(sectionCaption('rentals', 1994), '');
  assert.deepEqual(YEAR_LISTS.map((l) => l.key), ['rated', 'boxoffice']);
  // Every list the builder loops over must have a caption to announce it.
  for (const l of YEAR_LISTS) assert.ok(sectionCaption(l.key, 1994), `${l.key} has no section caption`);
});

test('captionForYearEntry stacks rank+title, the number line, then the note', () => {
  assert.equal(
    captionForYearEntry({ rank: 1, title: 'Pulp Fiction', value: '8.9 on IMDb', note: 'Tarantino rewired the decade.' }),
    '#1 Pulp Fiction\n8.9 on IMDb\nTarantino rewired the decade.'
  );
  // Missing pieces collapse instead of leaving blank lines.
  assert.equal(captionForYearEntry({ rank: 3, title: 'Speed', value: '', note: '' }), '#3 Speed');
  assert.equal(captionForYearEntry({ rank: 2, title: 'Speed', note: 'Bus.' }), '#2 Speed\nBus.');
  assert.equal(captionForYearEntry({ title: 'No rank' }), '#1 No rank');
  assert.equal(captionForYearEntry({}), '');
  assert.equal(captionForYearEntry(null), '');
});

test('photoQueryFor gives every year slide a search but the outro', () => {
  const p = { format: 'year', year: 1994 };
  assert.equal(photoQueryFor(p, { kind: 'title' }), '1994 movie posters');
  assert.equal(photoQueryFor(p, { kind: 'section', section: 'rated' }), '1994 best movies');
  assert.equal(photoQueryFor(p, { kind: 'section', section: 'boxoffice' }), '1994 box office hits');
  // An unknown section (e.g. a project saved before rentals were dropped) still
  // gets a usable search rather than a dead button.
  assert.equal(photoQueryFor(p, { kind: 'section', section: 'rentals' }), '1994 movies');
  assert.equal(photoQueryFor(p, { entry: { list: 'rated', title: 'Pulp Fiction' } }), 'Pulp Fiction 1994 movie poster');
  assert.equal(photoQueryFor(p, { kind: 'outro' }), '');
});

test('photoQueryFor keeps the Some Guys behavior and ignores unknown formats', () => {
  const p = { format: 'guys', actor: 'Keith David' };
  assert.equal(photoQueryFor(p, { role: { movie: 'They Live' } }), 'Keith David They Live');
  assert.equal(photoQueryFor(p, { kind: 'title' }), 'Keith David');
  assert.equal(photoQueryFor(p, { kind: 'outro' }), '');
  assert.equal(photoQueryFor({ format: 'trivia' }, { kind: 'title' }), '');
  assert.equal(photoQueryFor(null, null), '');
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
