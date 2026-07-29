import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIST_COUNT, YEAR_LIST_KEYS, normalizeYearInput, buildYearPrompt, normalizeYearSnapshot, hasAnyEntries,
} from '../../netlify/functions/lib/yearsnapshot.mjs';

// ---- year input ----

test('normalizeYearInput accepts plausible film years, rejects everything else', () => {
  assert.equal(normalizeYearInput(1994), 1994);
  assert.equal(normalizeYearInput('1994'), 1994);
  assert.equal(normalizeYearInput(1929), null);
  assert.equal(normalizeYearInput(2036), null);
  assert.equal(normalizeYearInput(1994.5), null);
  assert.equal(normalizeYearInput('nineteen ninety four'), null);
  assert.equal(normalizeYearInput(null), null);
  assert.equal(normalizeYearInput(undefined), null);
});

// ---- prompt ----

test('buildYearPrompt asks for three top-eight lists for the year', () => {
  const p = buildYearPrompt({ year: 1994 });
  assert.match(p, /The year is 1994\./);
  assert.match(p, new RegExp(`exactly ${LIST_COUNT} entries in rank order`));
  assert.match(p, /"rated"/);
  assert.match(p, /"boxoffice"/);
  assert.match(p, /"rentals"/);
  assert.match(p, /highest IMDb-rated/);
  assert.match(p, /WORLDWIDE box office/);
  assert.match(p, /home video rental charts/);
  assert.match(p, /ONLY valid JSON/i);
});

test('buildYearPrompt explains that rental charts lag theatrical release by a year', () => {
  const p = buildYearPrompt({ year: 1994 });
  assert.match(p, /1994 rental chart is normally dominated by films that hit theaters in 1993/);
});

test('buildYearPrompt would rather have an empty list than an invented one', () => {
  const p = buildYearPrompt({ year: 1994 });
  assert.match(p, /NEVER invent a film, a rating, a gross, or a rental figure/);
  assert.match(p, /return that list as an EMPTY array/);
  assert.match(p, /Do not pad a list with guesses/);
});

test('buildYearPrompt asks for an intro that invites comments and bans hype/dashes', () => {
  const p = buildYearPrompt({ year: 1994 });
  assert.match(p, /"intro"/);
  assert.match(p, /invites viewers to comment on what they were watching or renting/);
  assert.match(p, /MAY ask a friendly question/);
  assert.match(p, /no em or en dashes/);
});

test('buildYearPrompt embeds source material only when given, and clamps a bad year', () => {
  const p = buildYearPrompt({ year: 1994, sourceMaterial: 'Forrest Gump opened in July.', sourceName: '1994 in film' });
  assert.match(p, /<source_material>Forrest Gump opened in July\.<\/source_material>/);
  assert.match(p, /Wikipedia: "1994 in film"/);
  assert.doesNotMatch(buildYearPrompt({ year: 1994 }), /<source_material>/);
  // A junk year must still produce a coherent prompt rather than "The year is NaN".
  assert.match(buildYearPrompt({ year: 'nope' }), /The year is \d{4}\./);
});

// ---- normalizer ----

test('normalizeYearSnapshot always returns all three list keys', () => {
  const out = normalizeYearSnapshot({});
  for (const k of YEAR_LIST_KEYS) assert.deepEqual(out[k], []);
  assert.equal(out.intro, '');
  const junk = normalizeYearSnapshot(null);
  for (const k of YEAR_LIST_KEYS) assert.deepEqual(junk[k], []);
});

test('normalizeYearSnapshot renumbers ranks by position, ignoring the model’s own', () => {
  const { rated } = normalizeYearSnapshot({ rated: [
    { rank: 7, title: 'The Shawshank Redemption', value: '9.3 on IMDb', note: 'a' },
    { rank: 7, title: 'Pulp Fiction', value: '8.9 on IMDb', note: 'b' },
    { title: 'Léon: The Professional', value: '8.5 on IMDb' },
  ] });
  assert.deepEqual(rated.map((r) => r.rank), [1, 2, 3]);
  assert.equal(rated[2].note, '');
});

test('normalizeYearSnapshot drops titleless entries and dedupes within a list', () => {
  const { boxoffice } = normalizeYearSnapshot({ boxoffice: [
    { title: 'The Lion King', value: '$968M worldwide' },
    { title: 'the lion king', value: '$968M worldwide' },
    { title: '   ', value: '$1B worldwide' },
    { value: 'no title at all' },
    { title: 'Forrest Gump', value: '$678M worldwide' },
  ] });
  assert.deepEqual(boxoffice.map((b) => b.title), ['The Lion King', 'Forrest Gump']);
});

test('normalizeYearSnapshot caps each list and strips dashes from intro/value/note', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ title: `Film ${i}`, value: `$${i}M worldwide` }));
  const out = normalizeYearSnapshot({
    intro: '1994 — what a year',
    rated: many,
    rentals: [{ title: 'Jurassic Park', value: '$45M — US rentals', note: 'Dinosaurs — everywhere.' }],
  }, 8);
  assert.equal(out.rated.length, 8);
  assert.doesNotMatch(out.intro, /[—–]/);
  assert.doesNotMatch(out.rentals[0].value, /[—–]/);
  assert.doesNotMatch(out.rentals[0].note, /[—–]/);
});

test('normalizeYearSnapshot keeps a list empty when the model returns nothing for it', () => {
  const out = normalizeYearSnapshot({ rated: [{ title: 'A', value: '9.0 on IMDb' }], rentals: null });
  assert.equal(out.rated.length, 1);
  assert.deepEqual(out.rentals, []);
  assert.deepEqual(out.boxoffice, []);
});

// ---- usable-result gate ----

test('hasAnyEntries is true when any single list survived', () => {
  assert.equal(hasAnyEntries(normalizeYearSnapshot({ rentals: [{ title: 'A' }] })), true);
  assert.equal(hasAnyEntries(normalizeYearSnapshot({ intro: 'just an intro' })), false);
  assert.equal(hasAnyEntries(null), false);
});
