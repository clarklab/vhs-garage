import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIST_COUNT, YEAR_LIST_KEYS, DEFAULT_MIN_VOTES, normalizeYearInput, normalizeMinVotes,
  buildYearPrompt, normalizeYearSnapshot, hasAnyEntries,
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

// ---- vote floor ----

test('normalizeMinVotes falls back to the default rather than to no floor', () => {
  assert.equal(normalizeMinVotes(25000), 25000);
  assert.equal(normalizeMinVotes('25000'), 25000);
  assert.equal(normalizeMinVotes(0), 0);
  assert.equal(normalizeMinVotes(undefined), DEFAULT_MIN_VOTES);
  assert.equal(normalizeMinVotes('lots'), DEFAULT_MIN_VOTES);
  assert.equal(normalizeMinVotes(-5), DEFAULT_MIN_VOTES);
  assert.equal(normalizeMinVotes(1e9), 10_000_000);
});

// ---- prompt ----

test('buildYearPrompt asks for two top-eight lists and no longer mentions rentals', () => {
  const p = buildYearPrompt({ year: 1994 });
  assert.match(p, /The year is 1994\./);
  assert.match(p, /Produce TWO ranked lists/);
  assert.match(p, new RegExp(`exactly ${LIST_COUNT} entries in rank order`));
  assert.match(p, /"rated"/);
  assert.match(p, /"boxoffice"/);
  assert.match(p, /highest IMDb-rated/);
  assert.match(p, /WORLDWIDE box office/);
  // The rentals list is gone. ("VHS Garage" and "grew up renting tapes" stay —
  // that's the brand and the audience, not a third list.)
  assert.doesNotMatch(p, /"rentals"/);
  assert.doesNotMatch(p, /rental chart/i);
  assert.doesNotMatch(p, /3\.\s*"/);
  assert.match(p, /ONLY valid JSON/i);
});

test('buildYearPrompt states the vote floor, formatted, in the recall path', () => {
  assert.match(buildYearPrompt({ year: 1994 }), /at least 100,000 votes/);
  assert.match(buildYearPrompt({ year: 1994, minVotes: 25000 }), /at least 25,000 votes/);
  // A junk floor must not reach the model as "at least NaN votes".
  assert.match(buildYearPrompt({ year: 1994, minVotes: 'lots' }), /at least 100,000 votes/);
});

test('buildYearPrompt fixes the rated list when the user pasted IMDb results', () => {
  const p = buildYearPrompt({
    year: 1994,
    ratedGiven: [
      { title: 'The Shawshank Redemption', value: '9.3 on IMDb' },
      { title: 'Pulp Fiction', value: '8.9 on IMDb' },
    ],
  });
  assert.match(p, /"rated": FIXED/);
  assert.match(p, /1\. The Shawshank Redemption \| value: 9\.3 on IMDb/);
  assert.match(p, /2\. Pulp Fiction \| value: 8\.9 on IMDb/);
  assert.match(p, /Do not add titles, drop titles, reorder them, correct them, or adjust a rating/);
  assert.match(p, /only job on this list is writing each "note"/);
  // The recall instructions must be gone, or the model gets two contradictory briefs.
  assert.doesNotMatch(p, /highest IMDb-rated feature films RELEASED/);
});

test('buildYearPrompt drops titleless given entries and caps them at the count', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ title: `Film ${i}`, value: `${i} on IMDb` }));
  const p = buildYearPrompt({ year: 1994, count: 3, ratedGiven: [...many, { value: 'no title' }] });
  assert.match(p, /3\. Film 2/);
  assert.doesNotMatch(p, /4\. Film 3/);
  // An empty given list falls back to recall rather than shipping an empty FIXED block.
  assert.match(buildYearPrompt({ year: 1994, ratedGiven: [] }), /highest IMDb-rated feature films RELEASED/);
});

test('buildYearPrompt would rather have an empty list than an invented one', () => {
  const p = buildYearPrompt({ year: 1994 });
  assert.match(p, /NEVER invent a film, a rating, or a gross/);
  assert.match(p, /return that list as an EMPTY array/);
  assert.match(p, /Do not pad a list with guesses/);
});

test('buildYearPrompt asks for an intro that invites comments and bans hype/dashes', () => {
  const p = buildYearPrompt({ year: 1994 });
  assert.match(p, /"intro"/);
  assert.match(p, /invites viewers to comment on what they were watching/);
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

test('normalizeYearSnapshot always returns every list key, and rentals is gone', () => {
  const out = normalizeYearSnapshot({});
  assert.deepEqual(YEAR_LIST_KEYS, ['rated', 'boxoffice']);
  for (const k of YEAR_LIST_KEYS) assert.deepEqual(out[k], []);
  assert.equal(out.intro, '');
  assert.equal(out.rentals, undefined);
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
    boxoffice: [{ title: 'The Lion King', value: '$968M — worldwide', note: 'Lions — everywhere.' }],
  }, 8);
  assert.equal(out.rated.length, 8);
  assert.doesNotMatch(out.intro, /[—–]/);
  assert.doesNotMatch(out.boxoffice[0].value, /[—–]/);
  assert.doesNotMatch(out.boxoffice[0].note, /[—–]/);
});

test('normalizeYearSnapshot keeps a list empty when the model returns nothing for it', () => {
  const out = normalizeYearSnapshot({ rated: [{ title: 'A', value: '9.0 on IMDb' }], boxoffice: null });
  assert.equal(out.rated.length, 1);
  assert.deepEqual(out.boxoffice, []);
});

// ---- usable-result gate ----

test('hasAnyEntries is true when any single list survived', () => {
  assert.equal(hasAnyEntries(normalizeYearSnapshot({ boxoffice: [{ title: 'A' }] })), true);
  assert.equal(hasAnyEntries(normalizeYearSnapshot({ intro: 'just an intro' })), false);
  assert.equal(hasAnyEntries(null), false);
});
