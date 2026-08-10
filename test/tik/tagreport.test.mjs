import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTags, median, tagReport, tagReportHtml, MIN_SAMPLE } from '../../public/scripts/tik/tagreport.js';
import { HOUSE_SETS, buildDescription, buildHashtags } from '../../public/scripts/tik/hashtags.js';

// ---- reading tags back off a shipped post ----

test('parseTags reads the tags out of a description we actually wrote', () => {
  const houseSet = HOUSE_SETS.find((s) => s.key === 'retro');
  const hashtags = buildHashtags({ filmTags: ['thething', 'johncarpenter'], houseSet });
  const desc = buildDescription({ hook: 'A hook.', movie: 'The Thing', hashtags });
  assert.deepEqual(parseTags(desc), hashtags);
});

test('parseTags lowercases, dedupes, and ignores mid-word hashes', () => {
  assert.deepEqual(
    parseTags('#Jaws is great #JAWS #spielberg  no#tag here'),
    ['jaws', 'spielberg'],
  );
});

test('parseTags on empty or non-string input returns an empty array', () => {
  assert.deepEqual(parseTags(''), []);
  assert.deepEqual(parseTags(null), []);
  assert.deepEqual(parseTags(undefined), []);
  assert.deepEqual(parseTags(42), []);
  assert.deepEqual(parseTags('a description with no tags at all'), []);
});

// ---- median ----

test('median averages the middle pair on an even count', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([4, 1, 3, 2]), 2.5); // unsorted input
});

test('median returns the middle on an odd count', () => {
  assert.equal(median([5, 1, 3]), 3);
});

test('median of nothing is null, not zero', () => {
  // Zero would render as a real "0 views" row and read as a finding.
  assert.equal(median([]), null);
  assert.equal(median(null), null);
});

// ---- the report ----

const row = (movie, tags, views, likes = 0, comments = 0, shares = 0) =>
  ({ movie, tags, views, likes, comments, shares });

test('tagReport groups posts by the house set they carried', () => {
  const retro = ['vhs', 'videostore'];
  const cult = ['cultclassic', 'movienight'];
  const rep = tagReport([
    row('A', ['thething', ...retro], 1000),
    row('B', ['jaws', ...retro], 3000),
    row('C', ['alien', ...cult], 500),
  ]);
  const byKey = Object.fromEntries(rep.bySet.map((s) => [s.key, s]));
  assert.equal(byKey.retro.n, 2);
  assert.equal(byKey.retro.medianViews, 2000);
  assert.equal(byKey.cult.n, 1);
  assert.equal(byKey.cult.medianViews, 500);
});

test('tagReport needs BOTH of a set’s tags to credit the set', () => {
  // Half a set is not that set. Crediting on one tag would let a legacy post
  // that happens to carry #movietok get counted as the filmtok experiment.
  const rep = tagReport([row('A', ['movietok', 'moviequotes'], 1000)]);
  const filmtok = rep.bySet.find((s) => s.key === 'filmtok');
  assert.equal(filmtok.n, 0);
  assert.equal(filmtok.medianViews, null);
});

test('tagReport reports every set, including the ones never shipped', () => {
  const rep = tagReport([row('A', ['vhs', 'videostore'], 1000)]);
  assert.equal(rep.bySet.length, HOUSE_SETS.length);
});

test('tagReport computes engagement rate and skips zero-view rows', () => {
  const rep = tagReport([
    row('A', ['vhs', 'videostore'], 1000, 60, 30, 10), // 100/1000 = 0.1
    row('B', ['vhs', 'videostore'], 0, 5, 0, 0),       // no views: no rate
  ]);
  const retro = rep.bySet.find((s) => s.key === 'retro');
  assert.equal(retro.n, 2);
  assert.equal(retro.medianEngagement, 0.1);
});

test('tagReport ranks individual tags by sample size then by median views', () => {
  const rep = tagReport([
    row('A', ['jaws', 'vhs'], 100),
    row('B', ['alien', 'vhs'], 900),
    row('C', ['alien', 'videostore'], 700),
  ]);
  // alien and vhs both have n=2, so the higher median breaks the tie; the
  // n=1 tags sort under both regardless of how well they did.
  assert.deepEqual(rep.byTag.map((t) => t.tag), ['alien', 'vhs', 'videostore', 'jaws']);
  assert.equal(rep.byTag[0].medianViews, 800);
  assert.equal(rep.byTag[1].medianViews, 500);
});

test('tagReport reports lift against the account median, not against zero', () => {
  const rep = tagReport([
    row('A', ['vhs', 'videostore'], 2000),
    row('B', ['vhs', 'videostore'], 2000),
    row('C', ['cultclassic', 'movienight'], 1000),
    row('D', ['cultclassic', 'movienight'], 1000),
  ]);
  assert.equal(rep.baseline.medianViews, 1500);
  const retro = rep.bySet.find((s) => s.key === 'retro');
  const cult = rep.bySet.find((s) => s.key === 'cult');
  assert.ok(Math.abs(retro.lift - (2000 / 1500 - 1)) < 1e-9);
  assert.ok(Math.abs(cult.lift - (1000 / 1500 - 1)) < 1e-9);
});

test('tagReport flags rows whose sample is too small to mean anything', () => {
  const rep = tagReport([row('A', ['vhs', 'videostore'], 1000)]);
  const retro = rep.bySet.find((s) => s.key === 'retro');
  assert.equal(retro.n, 1);
  assert.equal(retro.enough, false);
  assert.ok(MIN_SAMPLE > 1);
});

test('tagReport on no history returns empty rather than dividing by zero', () => {
  const rep = tagReport([]);
  assert.equal(rep.baseline.n, 0);
  assert.equal(rep.baseline.medianViews, null);
  assert.deepEqual(rep.byTag, []);
  assert.ok(rep.bySet.every((s) => s.n === 0 && s.lift === null));
});

test('tagReport ignores rows with no tags and rows that are junk', () => {
  const rep = tagReport([
    row('A', ['vhs', 'videostore'], 1000),
    row('B', [], 5000),
    null,
    { movie: 'C' },
  ]);
  assert.equal(rep.baseline.n, 1);
  assert.equal(rep.baseline.medianViews, 1000);
});

test('tagReport parses tags from a description when a row has none attached', () => {
  // History rows come back from TikTok with the description, not a tag array.
  const rep = tagReport([
    { movie: 'A', description: 'Great film #vhs #videostore', views: 1000 },
  ]);
  const retro = rep.bySet.find((s) => s.key === 'retro');
  assert.equal(retro.n, 1);
});

// ---- rendering ----

test('tagReportHtml says so plainly when there is nothing to report', () => {
  const { note, body } = tagReportHtml(tagReport([]));
  assert.equal(note, '');
  assert.match(body, /No hashtags found/);
  assert.doesNotMatch(body, /<table/);
});

test('tagReportHtml renders a row per house set with its sample size', () => {
  const { note, body } = tagReportHtml(tagReport([
    row('A', ['vhs', 'videostore'], 2000),
    row('B', ['vhs', 'videostore'], 2000),
  ]));
  assert.match(note, /2 tagged posts/);
  assert.match(body, /Retro \/ VHS/);
  assert.match(body, /#vhs #videostore/);
  for (const set of HOUSE_SETS) assert.match(body, new RegExp(set.label.replace(/[/]/g, '\\/')));
});

test('tagReportHtml greys out an under-sampled row and never colors it green', () => {
  const { body } = tagReportHtml(tagReport([row('A', ['vhs', 'videostore'], 9999)]));
  assert.match(body, /text-neutral-500/);
  assert.doesNotMatch(body, /text-green-400/);
  assert.match(body, new RegExp(`under ${MIN_SAMPLE} posts`));
});

test('tagReportHtml keeps its caveats about what this data is not', () => {
  const { body } = tagReportHtml(tagReport([row('A', ['vhs', 'videostore'], 100)]));
  assert.match(body, /no hashtag volume data/i);
  assert.match(body, /nudge and not a verdict/);
});

test('tagReportHtml escapes tag text rather than injecting it', () => {
  const { body } = tagReportHtml(tagReport([
    { movie: 'X', tags: ['<img src=x onerror=alert(1)>'], views: 10 },
  ]));
  assert.doesNotMatch(body, /<img/);
  assert.match(body, /&lt;img/);
});

test('tagReportHtml produces balanced table markup', () => {
  const { body } = tagReportHtml(tagReport([
    row('A', ['vhs', 'videostore'], 2000),
    row('B', ['jaws', 'cultclassic', 'movienight'], 1000),
  ]));
  for (const tag of ['table', 'tr', 'td', 'tbody']) {
    const open = (body.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length;
    const close = (body.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    assert.equal(open, close, `unbalanced <${tag}>`);
  }
});
