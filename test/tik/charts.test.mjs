import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseImdbList, parseVotes, formatVotes, ratingValue, toRatedEntries, imdbSearchUrl,
  parseGrossList, parseGross, formatGross, toGrossEntries, boxOfficeMojoUrl,
} from '../../public/scripts/tik/charts.js';

// ---- votes ----

test('parseVotes reads suffixed and comma-grouped counts', () => {
  assert.equal(parseVotes('(3.1M)'), 3_100_000);
  assert.equal(parseVotes('3.1M votes'), 3_100_000);
  assert.equal(parseVotes('(852K)'), 852_000);
  assert.equal(parseVotes('1,234,567'), 1_234_567);
  assert.equal(parseVotes('123456'), 123_456);
  assert.equal(parseVotes('no numbers here'), null);
  assert.equal(parseVotes(''), null);
});

test('formatVotes renders a compact, verifiable count', () => {
  assert.equal(formatVotes(3_100_000), '3.1M votes');
  assert.equal(formatVotes(12_000_000), '12M votes');
  assert.equal(formatVotes(2_000_000), '2M votes');
  assert.equal(formatVotes(852_000), '852K votes');
  assert.equal(formatVotes(940), '940 votes');
  assert.equal(formatVotes(0), '');
  assert.equal(formatVotes(NaN), '');
});

test('ratingValue writes the slide number line', () => {
  assert.equal(ratingValue(9.3), '9.3 on IMDb');
  assert.equal(ratingValue(8), '8 on IMDb');
  assert.equal(ratingValue(null), '');
});

// ---- the bookmarklet's own output ----

test('parseImdbList reads the bookmarklet format', () => {
  const out = parseImdbList([
    '1. The Shawshank Redemption (1994) | 9.3 | 3.1M votes',
    '2. Pulp Fiction (1994) | 8.9 | 2.3M votes',
    '3. Forrest Gump (1994) | 8.8 | 2.4M votes',
  ].join('\n'));
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { rank: 1, title: 'The Shawshank Redemption', year: 1994, rating: 9.3, votes: 3_100_000 });
  assert.deepEqual(out[2], { rank: 3, title: 'Forrest Gump', year: 1994, rating: 8.8, votes: 2_400_000 });
});

// ---- a raw copy-paste off the results page ----

test('parseImdbList reads a raw multi-line paste, ignoring runtime and certificate', () => {
  const out = parseImdbList([
    '1. The Shawshank Redemption',
    '1994',
    '2h 22m',
    'R',
    '9.3',
    '(3.1M)',
    '2. Pulp Fiction',
    '1994',
    '2h 34m',
    'R',
    '8.9',
    '(2.3M)',
  ].join('\n'));
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { rank: 1, title: 'The Shawshank Redemption', year: 1994, rating: 9.3, votes: 3_100_000 });
  assert.deepEqual(out[1], { rank: 2, title: 'Pulp Fiction', year: 1994, rating: 8.9, votes: 2_300_000 });
});

test('parseImdbList never mistakes a year, runtime, or vote count for a rating', () => {
  const [a] = parseImdbList('1. Some Film\n1994\n2h 22m\n(3.1M)\n2. Other Film\n1994\n8.1');
  assert.equal(a.rating, null, 'no rating present, so none should be invented');
  assert.equal(a.year, 1994);
  assert.equal(a.votes, 3_100_000);
});

// ---- hand-typed ----

test('parseImdbList takes a hand-typed list with or without ratings', () => {
  const out = parseImdbList('The Shawshank Redemption 9.3\nPulp Fiction 8.9\nEd Wood');
  assert.deepEqual(out.map((e) => [e.rank, e.title, e.rating]), [
    [1, 'The Shawshank Redemption', 9.3],
    [2, 'Pulp Fiction', 8.9],
    [3, 'Ed Wood', null],
  ]);
});

test('parseImdbList keeps a numeric title intact when it is the whole line', () => {
  const out = parseImdbList('Se7en 8.6\n300 7.6');
  assert.deepEqual(out.map((e) => [e.title, e.rating]), [['Se7en', 8.6], ['300', 7.6]]);
});

// ---- ordering, dedupe, junk ----

test('parseImdbList preserves the pasted order, which is the IMDb sort', () => {
  const out = parseImdbList('1. Low One | 7.1\n2. High One | 9.9');
  assert.deepEqual(out.map((e) => e.title), ['Low One', 'High One']);
  assert.deepEqual(out.map((e) => e.rank), [1, 2]);
});

test('parseImdbList dedupes by title, renumbers, and caps', () => {
  const out = parseImdbList('1. Dup | 8.0\n2. dup | 8.0\n3. Other | 7.0');
  assert.deepEqual(out.map((e) => [e.rank, e.title]), [[1, 'Dup'], [2, 'Other']]);
  const many = Array.from({ length: 30 }, (_, i) => `${i + 1}. Film ${i} | 7.${i % 10}`).join('\n');
  assert.equal(parseImdbList(many, 8).length, 8);
});

test('parseImdbList returns [] on empty or letterless input', () => {
  assert.deepEqual(parseImdbList(''), []);
  assert.deepEqual(parseImdbList('   \n  \n'), []);
  assert.deepEqual(parseImdbList('1994\n2h 22m\n9.3'), []);
  assert.deepEqual(parseImdbList(null), []);
});

// ---- handing off to the snapshot ----

test('toRatedEntries builds the snapshot shape and renumbers to the cap', () => {
  const parsed = parseImdbList('1. A (1994) | 9.3 | 3.1M votes\n2. B (1994) | 8.9 | 2.3M votes\n3. C (1994) | 8.8');
  const rated = toRatedEntries(parsed, 2);
  assert.equal(rated.length, 2);
  assert.deepEqual(rated[0], { rank: 1, title: 'A', value: '9.3 on IMDb', note: '', votes: 3_100_000 });
  // A film with no rating still earns a slide; it just has no number line.
  const noRating = toRatedEntries(parseImdbList('Ed Wood'), 8);
  assert.equal(noRating[0].value, '');
  assert.equal(noRating[0].votes, null);
});

// ---- the search URL ----

test('imdbSearchUrl builds the rating-sorted, vote-floored advanced search', () => {
  const url = imdbSearchUrl(1994, 100000);
  assert.match(url, /^https:\/\/www\.imdb\.com\/search\/title\/\?/);
  const q = new URL(url).searchParams;
  assert.equal(q.get('title_type'), 'feature');
  assert.equal(q.get('release_date'), '1994-01-01,1994-12-31');
  assert.equal(q.get('num_votes'), '100000,');
  assert.equal(q.get('sort'), 'user_rating,desc');
  assert.equal(q.get('user_rating'), '1,');
  // A junk floor degrades to "no floor" in the URL rather than "NaN,".
  assert.equal(new URL(imdbSearchUrl(1994, 'lots')).searchParams.get('num_votes'), '0,');
});

// ================= Box office =================

test('formatGross quotes figures the way box office numbers are normally written', () => {
  assert.equal(formatGross(1_052_000_000), '$1.05B');
  assert.equal(formatGross(2_800_000_000), '$2.8B');
  assert.equal(formatGross(968_483_777), '$968M');
  assert.equal(formatGross(45_200_000), '$45.2M');
  assert.equal(formatGross(8_000_000), '$8M');
  assert.equal(formatGross(123_456), '$123,456');
  assert.equal(formatGross(0), '');
  assert.equal(formatGross(NaN), '');
});

test('parseGross reads raw and abbreviated amounts', () => {
  assert.equal(parseGross('$968,483,777'), 968_483_777);
  assert.equal(parseGross('$968.5M'), 968_500_000);
  assert.equal(parseGross('$1.05B'), 1_050_000_000);
  assert.equal(parseGross('no money'), null);
});

test('parseGrossList reads the bookmarklet format and keeps its wording', () => {
  const out = parseGrossList([
    '1. The Lion King | $968.5M worldwide',
    '2. Forrest Gump | $678.2M worldwide',
  ].join('\n'));
  assert.deepEqual(out.map((e) => [e.rank, e.title, e.value]), [
    [1, 'The Lion King', '$968.5M worldwide'],
    [2, 'Forrest Gump', '$678.2M worldwide'],
  ]);
});

test('parseGrossList reads a raw Box Office Mojo table row, taking the worldwide column', () => {
  const out = parseGrossList([
    '1\tThe Lion King\t$968,483,777\t$312,855,561\t32.3%\t$655,628,216\t67.7%',
    '2\tForrest Gump\t$678,226,465\t$330,455,270\t48.7%\t$347,771,195\t51.3%',
  ].join('\n'));
  assert.equal(out.length, 2);
  // The first dollar column is worldwide; the domestic split must not win.
  assert.deepEqual(out[0], { rank: 1, title: 'The Lion King', value: '$968M worldwide', gross: 968_483_777 });
  assert.equal(out[1].value, '$678M worldwide');
});

test('parseGrossList handles a space-separated copy and a hand-typed line', () => {
  const spaced = parseGrossList('1   The Lion King   $968,483,777   $312,855,561');
  assert.deepEqual([spaced[0].title, spaced[0].value], ['The Lion King', '$968M worldwide']);
  const typed = parseGrossList('The Lion King $968,483,777\nSpeed $350,448,145');
  assert.deepEqual(typed.map((e) => [e.title, e.value]), [
    ['The Lion King', '$968M worldwide'],
    ['Speed', '$350M worldwide'],
  ]);
});

test('parseGrossList takes a title with no figure, and a custom label', () => {
  const out = parseGrossList('1. Some Film');
  assert.deepEqual([out[0].title, out[0].value, out[0].gross], ['Some Film', '', null]);
  const dom = parseGrossList('1\tSpeed\t$121,248,145', 10, 'domestic');
  assert.equal(dom[0].value, '$121M domestic');
});

test('parseGrossList dedupes, renumbers, caps, and survives junk', () => {
  const dup = parseGrossList('1. Dup | $10M worldwide\n2. dup | $10M worldwide\n3. Other | $9M worldwide');
  assert.deepEqual(dup.map((e) => [e.rank, e.title]), [[1, 'Dup'], [2, 'Other']]);
  const many = Array.from({ length: 30 }, (_, i) => `${i + 1}\tFilm ${i}\t$${i + 1},000,000`).join('\n');
  assert.equal(parseGrossList(many, 10).length, 10);
  assert.deepEqual(parseGrossList(''), []);
  assert.deepEqual(parseGrossList(null), []);
  assert.deepEqual(parseGrossList('1\t\t$5,000,000'), []);
});

test('toGrossEntries builds the snapshot shape', () => {
  const parsed = parseGrossList('1. The Lion King | $968.5M worldwide\n2. Forrest Gump | $678.2M worldwide');
  assert.deepEqual(toGrossEntries(parsed, 1), [
    { rank: 1, title: 'The Lion King', value: '$968.5M worldwide', note: '' },
  ]);
});

test('boxOfficeMojoUrl points at the worldwide yearly chart', () => {
  assert.equal(boxOfficeMojoUrl(1994), 'https://www.boxofficemojo.com/year/world/1994/');
});
