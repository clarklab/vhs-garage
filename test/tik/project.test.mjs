import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORMATS, YEAR_LISTS, formatOf, makeProject, defaultPostFields, captionForRole,
  sectionCaption, captionForYearEntry, photoQueryFor, relativeTime, projectDisplayName,
  YEAR_LIST_SIZE, numberWord, renumberYearEntries,
} from '../../public/scripts/tik/project.js';
import { houseSetByKey } from '../../public/scripts/tik/hashtags.js';

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

test('sectionCaption announces each list by name and year', () => {
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

// ---- Year Snapshot: re-ranking after edits ----

const yearDeck = () => [
  { kind: 'title' },
  { kind: 'section', section: 'rated' },
  { entry: { list: 'rated', rank: 1, title: 'A' }, caption: '#1 A\n9.3 on IMDb' },
  { entry: { list: 'rated', rank: 2, title: 'B' }, caption: '#2 B\n8.9 on IMDb' },
  { kind: 'section', section: 'boxoffice' },
  { entry: { list: 'boxoffice', rank: 1, title: 'C' }, caption: '#1 C\n$968M worldwide' },
  { kind: 'outro' },
];

test('renumberYearEntries re-ranks each section independently from position', () => {
  const out = renumberYearEntries(yearDeck());
  assert.deepEqual(out.map((s) => s.entry?.rank ?? null), [null, null, 1, 2, null, 1, null]);
});

test('renumberYearEntries fixes every number below an inserted film', () => {
  const deck = yearDeck();
  // Slip a missed film in between #1 and #2, numbered wrong on purpose.
  deck.splice(3, 0, { entry: { list: 'rated', rank: 99, title: 'New' }, caption: '#99 New\n9.0 on IMDb' });
  const out = renumberYearEntries(deck);
  assert.deepEqual(out.slice(2, 5).map((s) => [s.entry.rank, s.entry.title]), [[1, 'A'], [2, 'New'], [3, 'B']]);
  // The caption's visible number moves with the rank, and the rest is untouched.
  assert.equal(out[3].caption, '#2 New\n9.0 on IMDb');
  assert.equal(out[4].caption, '#3 B\n8.9 on IMDb');
  // The other section is unaffected.
  assert.equal(out[6].entry.rank, 1);
});

test('renumberYearEntries adopts an entry dragged under another section', () => {
  const deck = yearDeck();
  const [moved] = deck.splice(2, 1);          // take rated #1
  deck.splice(4, 0, moved);                   // drop it into the box office run
  const out = renumberYearEntries(deck);
  const inBox = out.filter((s) => s.entry?.list === 'boxoffice');
  assert.deepEqual(inBox.map((s) => [s.entry.rank, s.entry.title]), [[1, 'A'], [2, 'C']]);
  assert.equal(out.filter((s) => s.entry?.list === 'rated').length, 1);
});

test('renumberYearEntries leaves hand-edited captions with no #N prefix alone', () => {
  const deck = [
    { kind: 'section', section: 'rated' },
    { entry: { list: 'rated', rank: 5, title: 'A' }, caption: 'A totally rewritten caption' },
  ];
  const out = renumberYearEntries(deck);
  assert.equal(out[1].entry.rank, 1);
  assert.equal(out[1].caption, 'A totally rewritten caption');
});

test('renumberYearEntries is a no-op on already-correct decks and on other formats', () => {
  const deck = yearDeck();
  const out = renumberYearEntries(deck);
  // Unchanged slides keep their identity, so React-less re-renders stay cheap.
  assert.equal(out[2], deck[2]);
  assert.deepEqual(renumberYearEntries([]), []);
  assert.deepEqual(renumberYearEntries(null), []);
  const trivia = [{ caption: 'a fact' }, { caption: 'another' }];
  assert.deepEqual(renumberYearEntries(trivia), trivia);
});

test('sectionCaption spells the count and tracks YEAR_LIST_SIZE', () => {
  assert.equal(YEAR_LIST_SIZE, 10);
  assert.equal(sectionCaption('rated', 1994), 'These are the top ten rated movies of 1994.');
  assert.equal(sectionCaption('boxoffice', 1994), 'These are the top ten box office numbers of 1994.');
  assert.equal(sectionCaption('rated', 1994, 8), 'These are the top eight rated movies of 1994.');
  assert.equal(numberWord(10), 'ten');
  assert.equal(numberWord(99), '99');
  // The section cards must say the same number as the captions.
  for (const l of YEAR_LISTS) assert.match(l.heading, new RegExp(`\\b${YEAR_LIST_SIZE}\\b`));
});

// ---- Tape Trivia post copy: agent meta, film tags, rotating house pair ----

test('defaultPostFields folds the agent hook and film tags into the post', () => {
  const { title, description, hashtags, hashtagSet } = defaultPostFields(
    'trivia', 'The Thing (1982)',
    {
      projectId: 'p1',
      meta: {
        hook: 'John Carpenter’s 1982 arctic paranoia classic with Kurt Russell.',
        filmTags: ['#The Thing', 'John Carpenter', '80s horror'],
      },
    },
  );
  assert.match(title, /^The Thing \(1982\) — movie trivia/);
  assert.match(description, /^John Carpenter/);
  assert.deepEqual(hashtags.slice(0, 3), ['thething', 'johncarpenter', '80shorror']);
  assert.equal(hashtags.length, 5);
  assert.ok(houseSetByKey(hashtagSet), 'hashtagSet must name a real house set');
  assert.match(description, /#thething/);
});

test('defaultPostFields still writes usable trivia copy with no agent meta', () => {
  const { title, description, hashtags } = defaultPostFields('trivia', 'Jaws');
  assert.match(title, /^Jaws — movie trivia/);
  assert.match(description, /hidden details from Jaws/);
  assert.equal(hashtags.length, 5);
  assert.doesNotMatch(description, /undefined/);
});

test('defaultPostFields keeps a trivia post to five hashtags', () => {
  const { description } = defaultPostFields('trivia', 'Jaws', {
    projectId: 'p2',
    meta: { hook: 'A hook.', filmTags: ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'] },
  });
  assert.equal((description.match(/#/g) || []).length, 5);
});

test('an explicit houseSetKey wins over the id-based rotation', () => {
  const a = defaultPostFields('trivia', 'Jaws', { projectId: 'p1', houseSetKey: 'cult' });
  const b = defaultPostFields('trivia', 'Jaws', { projectId: 'p2', houseSetKey: 'cult' });
  assert.equal(a.hashtagSet, 'cult');
  assert.equal(b.hashtagSet, 'cult');
  // An unknown key falls back to the rotation instead of throwing.
  assert.ok(houseSetByKey(defaultPostFields('trivia', 'Jaws', { houseSetKey: 'bogus' }).hashtagSet));
});

test('the same project always regenerates the same tags', () => {
  // Reopening a draft must not reshuffle copy the user already reviewed.
  const opts = { projectId: 'stable-id', meta: { hook: 'A hook.', filmTags: ['jaws'] } };
  assert.deepEqual(defaultPostFields('trivia', 'Jaws', opts), defaultPostFields('trivia', 'Jaws', opts));
});

test('the other two formats are untouched by the hashtag work', () => {
  const guys = defaultPostFields('guys', 'Dick Miller');
  const year = defaultPostFields('year', '1985');
  assert.match(guys.description, /#rememberingsomeguys/);
  assert.match(year.description, /#boxoffice/);
  assert.equal(guys.hashtagSet, undefined);
  assert.equal(year.hashtagSet, undefined);
});

test('makeProject starts with empty post meta, not undefined', () => {
  const p = makeProject({ id: 'x', format: 'trivia', now: 0 });
  assert.equal(p.postMeta, null);
  assert.equal(p.hashtagSet, null);
});
