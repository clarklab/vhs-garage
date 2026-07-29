import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIST_COUNT, YEAR_LIST_KEYS, DEFAULT_MIN_VOTES, YEAR_MAX_TOKENS,
  normalizeYearInput, normalizeMinVotes,
  buildYearPrompt, normalizeYearSnapshot, hasAnyEntries, yearFailureReason,
} from '../../netlify/functions/lib/yearsnapshot.mjs';
import { DEFAULT_MAX_TOKENS } from '../../netlify/functions/lib/ai-providers.mjs';

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

test('the year format asks for more output room than the shared default', () => {
  // 16 rows with notes overrun the 6-row trivia budget, and a cut-off reply is
  // unparseable JSON rather than a short list.
  assert.ok(YEAR_MAX_TOKENS > DEFAULT_MAX_TOKENS, 'year needs more than the default cap');
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
  assert.match(p, /Do not add titles, drop titles, reorder them, correct them, or adjust a figure/);
  assert.match(p, /only job on this list is writing each "note"/);
  // The recall instructions must be gone, or the model gets two contradictory briefs.
  assert.doesNotMatch(p, /highest IMDb-rated feature films RELEASED/);
  // Pinning one list must leave the other on recall.
  assert.match(p, /"boxoffice": the \d+ highest-grossing films/);
});

test('buildYearPrompt fixes the box office list independently of the rated one', () => {
  const p = buildYearPrompt({ year: 1994, boxofficeGiven: [{ title: 'The Lion King', value: '$968M worldwide' }] });
  assert.match(p, /"boxoffice": FIXED/);
  assert.match(p, /Box Office Mojo/);
  assert.match(p, /1\. The Lion King \| value: \$968M worldwide/);
  assert.doesNotMatch(p, /highest-grossing films of 1994 by WORLDWIDE/);
  // The rated list stays on recall.
  assert.match(p, /highest IMDb-rated feature films RELEASED/);
  assert.doesNotMatch(p, /"rated": FIXED/);
});

test('buildYearPrompt can fix both lists at once', () => {
  const p = buildYearPrompt({
    year: 1994,
    ratedGiven: [{ title: 'A', value: '9.3 on IMDb' }],
    boxofficeGiven: [{ title: 'B', value: '$1B worldwide' }],
  });
  assert.match(p, /"rated": FIXED/);
  assert.match(p, /"boxoffice": FIXED/);
  assert.doesNotMatch(p, /highest IMDb-rated feature films RELEASED/);
  assert.doesNotMatch(p, /highest-grossing films of 1994 by WORLDWIDE/);
});

test('buildYearPrompt drops titleless given entries and caps them at the count', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ title: `Film ${i}`, value: `${i} on IMDb` }));
  const p = buildYearPrompt({ year: 1994, count: 3, ratedGiven: [...many, { value: 'no title' }] });
  assert.match(p, /3\. Film 2/);
  assert.doesNotMatch(p, /4\. Film 3/);
  // An empty given list falls back to recall rather than shipping an empty FIXED block.
  assert.match(buildYearPrompt({ year: 1994, ratedGiven: [] }), /highest IMDb-rated feature films RELEASED/);
});

test('buildYearPrompt forbids inventing a FILM without making empty lists the safe answer', () => {
  const p = buildYearPrompt({ year: 1994 });
  assert.match(p, /Never invent a FILM/);
  assert.match(p, /Get the ORDER right/);
  // The escape hatch is scoped to not knowing the films, not to number precision
  // — the earlier wording let a careful model return two empty arrays instead.
  assert.match(p, /Leave a list empty ONLY if you genuinely do not know the films/);
  assert.match(p, /Uncertainty about an exact number is not a reason/);
  assert.match(p, /do NOT leave a list empty, because you cannot pin a number to the decimal/);
  assert.match(p, /both lists are normally answerable\. Fill them\./);
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

// ---- naming the failure ----

test('yearFailureReason separates the three ways a year job comes back empty', () => {
  // Nothing at all.
  assert.match(yearFailureReason('', null), /empty response/i);
  assert.match(yearFailureReason('   ', null), /empty response/i);
  // Text that isn't JSON — overwhelmingly a reply cut off mid-array.
  assert.match(yearFailureReason('{"intro":"1994 was', null), /wasn’t valid JSON/);
  assert.match(yearFailureReason('I cannot help with that.', null), /wasn’t valid JSON/);
  // Parsed, but no list keys at all.
  assert.match(yearFailureReason('{"films":[]}', { films: [] }), /wrong shape/);
  // Parsed with real list keys, just empty — the model declined to fill them.
  const empty = yearFailureReason('{"rated":[],"boxoffice":[]}', { rated: [], boxoffice: [] });
  assert.match(empty, /empty lists/);
  assert.match(empty, /paste an IMDb list/);
});

test('yearFailureReason treats a half-present shape as empty lists, not wrong shape', () => {
  assert.match(yearFailureReason('{"rated":[]}', { rated: [] }), /empty lists/);
});
