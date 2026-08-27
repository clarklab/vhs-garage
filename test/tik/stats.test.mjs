import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SERIES_MAX, normalizeSeries, appendSnapshot, seriesDelta, todayKey,
} from '../../netlify/functions/lib/stats.mjs';
import { postMarkers } from '../../public/scripts/tik/stats.js';

test('normalizeSeries keeps valid entries, sorts by date, dedupes same-day (last wins)', () => {
  const out = normalizeSeries([
    { d: '2026-07-15', c: 2000 },
    { d: '2026-07-10', c: 1500, likes: 90 },
    { d: '2026-07-15', c: 2041 },          // same day, later entry wins
    { d: 'nope', c: 100 },                  // bad date → dropped
    { d: '2026-07-11', c: -5 },             // negative → dropped
    { d: '2026-07-12', c: 'many' },         // NaN → dropped
  ]);
  assert.deepEqual(out.map((e) => e.d), ['2026-07-10', '2026-07-15']);
  assert.equal(out[1].c, 2041);
  assert.equal(out[0].likes, 90);
});

test('normalizeSeries survives junk input', () => {
  assert.deepEqual(normalizeSeries(null), []);
  assert.deepEqual(normalizeSeries('x'), []);
  assert.deepEqual(normalizeSeries([{}, 42]), []);
});

test('appendSnapshot adds a new day and replaces the same day', () => {
  const base = [{ d: '2026-07-14', c: 1900 }];
  const added = appendSnapshot(base, { d: '2026-07-15', c: 2000 });
  assert.equal(added.length, 2);
  const replaced = appendSnapshot(added, { d: '2026-07-15', c: 2041 });
  assert.equal(replaced.length, 2);
  assert.equal(replaced[1].c, 2041);
  assert.deepEqual(base, [{ d: '2026-07-14', c: 1900 }]); // input untouched
});

test('appendSnapshot caps the series at SERIES_MAX, dropping the oldest', () => {
  const many = Array.from({ length: SERIES_MAX }, (_, i) => ({
    d: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
    c: i,
  }));
  const out = appendSnapshot(many, { d: '2026-07-15', c: 9999 });
  assert.equal(out.length, SERIES_MAX);
  assert.equal(out[out.length - 1].c, 9999);
  assert.notEqual(out[0].d, many[0].d); // oldest dropped
});

test('seriesDelta measures against the entry at least N days back', () => {
  const s = [
    { d: '2026-07-01', c: 1000 },
    { d: '2026-07-08', c: 1700 },
    { d: '2026-07-12', c: 1900 },
    { d: '2026-07-15', c: 2041 },
  ];
  const d7 = seriesDelta(s, 7);
  assert.deepEqual(d7, { delta: 2041 - 1700, days: 7 }); // baseline = Jul 8 (≥7d back)
  const d30 = seriesDelta(s, 30);
  assert.deepEqual(d30, { delta: 1041, days: 14 });      // series shorter than window → earliest
});

test('seriesDelta needs two points, handles negatives', () => {
  assert.equal(seriesDelta([{ d: '2026-07-15', c: 2041 }]), null);
  assert.equal(seriesDelta([]), null);
  const down = seriesDelta([{ d: '2026-07-08', c: 2100 }, { d: '2026-07-15', c: 2041 }], 7);
  assert.deepEqual(down, { delta: -59, days: 7 });
});

test('todayKey renders a UTC YYYY-MM-DD', () => {
  assert.equal(todayKey(Date.UTC(2026, 6, 15, 23, 59)), '2026-07-15');
  assert.match(todayKey(), /^\d{4}-\d{2}-\d{2}$/);
});

// ---- post dots on the follower line ----

const SERIES = [
  { d: '2026-08-01', c: 100 },
  { d: '2026-08-03', c: 200 },
  { d: '2026-08-05', c: 220 },
];
const at = (iso) => Date.parse(iso);

test('a post sits on the line, at the value for that moment', () => {
  // The dots answer "what was growth doing when I posted", which only reads if
  // the mark is ON the stroke. The chart draws straight segments between daily
  // points, so a post between two days interpolates.
  const [m] = postMarkers(SERIES, [at('2026-08-02T12:00:00Z')]);
  assert.equal(m.d, '2026-08-02');
  assert.equal(m.c, 150, 'not halfway between 100 and 200');
});

test('a day lands exactly on its own point', () => {
  const [m] = postMarkers(SERIES, [at('2026-08-03T09:00:00Z')]);
  assert.equal(m.c, 200);
});

test('several posts in a day are one dot that says how many', () => {
  // Four a day would otherwise stack into a single dot claiming to be one post.
  const marks = postMarkers(SERIES, [
    at('2026-08-01T09:00:00Z'), at('2026-08-01T13:00:00Z'), at('2026-08-01T23:00:00Z'),
  ]);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].count, 3);
});

test('a post outside the charted range is dropped, not clamped onto an end', () => {
  // Clamping would put a dot on a day it did not happen.
  const marks = postMarkers(SERIES, [at('2026-07-01T12:00:00Z'), at('2026-09-01T12:00:00Z')]);
  assert.deepEqual(marks, []);
});

test('markers come back in date order, whatever order the posts arrived in', () => {
  const marks = postMarkers(SERIES, [
    at('2026-08-04T12:00:00Z'), at('2026-08-01T12:00:00Z'), at('2026-08-03T12:00:00Z'),
  ]);
  assert.deepEqual(marks.map((m) => m.d), ['2026-08-01', '2026-08-03', '2026-08-04']);
});

test('ISO strings work as well as timestamps', () => {
  assert.equal(postMarkers(SERIES, ['2026-08-03T00:00:00Z'])[0]?.c, 200);
});

test('no posts, no series, or junk gives no dots rather than throwing', () => {
  assert.deepEqual(postMarkers(SERIES, []), []);
  assert.deepEqual(postMarkers(SERIES, null), []);
  assert.deepEqual(postMarkers(SERIES, [NaN, 'nope', null, undefined]), []);
  assert.deepEqual(postMarkers([], [at('2026-08-01T12:00:00Z')]), []);
  assert.deepEqual(postMarkers(null, null), []);
});

test('a one-day series still places a post on that day', () => {
  const marks = postMarkers([{ d: '2026-08-01', c: 42 }], [at('2026-08-01T18:00:00Z')]);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].c, 42);
});

test('a flat stretch places the dot at the flat value, not at an average', () => {
  const flat = [{ d: '2026-08-01', c: 500 }, { d: '2026-08-10', c: 500 }];
  assert.equal(postMarkers(flat, [at('2026-08-05T12:00:00Z')])[0].c, 500);
});
