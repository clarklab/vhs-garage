import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOUSE_SETS, FILLER_TAGS, TAGS_PER_POST, pickHouseSet, houseSetAt, houseSetByKey, sanitizeTags,
  buildHashtags, formatHashtags, buildDescription,
} from '../../public/scripts/tik/hashtags.js';

// ---- sanitizing what the model hands us ----

test('sanitizeTags strips the "#", spaces, punctuation, and casing', () => {
  assert.deepEqual(
    sanitizeTags(['#The Thing', 'John-Carpenter', "Rob Bottin's FX"]),
    ['thething', 'johncarpenter', 'robbottinsfx'],
  );
});

test('sanitizeTags survives the worst thing a model could return', () => {
  // A whole hashtag line, a year in parens, an emoji, a null, a number.
  assert.deepEqual(
    sanitizeTags(['#The Thing (1982)', '🎬', null, 42, '   ', '#']),
    ['thething1982'],
  );
});

test('sanitizeTags drops one-character and over-long tags', () => {
  const long = 'a'.repeat(31);
  assert.deepEqual(sanitizeTags(['a', 'ok', long, 'a'.repeat(30)]), ['ok', 'a'.repeat(30)]);
});

test('sanitizeTags dedupes case-insensitively and after cleaning', () => {
  assert.deepEqual(sanitizeTags(['Jaws', '#jaws', 'JAWS!']), ['jaws']);
});

test('sanitizeTags honors exclude and max', () => {
  assert.deepEqual(
    sanitizeTags(['jaws', 'spielberg', '70shorror', 'sharks'], { exclude: ['spielberg'], max: 2 }),
    ['jaws', '70shorror'],
  );
});

test('sanitizeTags on junk input returns an empty array, never throws', () => {
  assert.deepEqual(sanitizeTags(null), []);
  assert.deepEqual(sanitizeTags('jaws'), []);
  assert.deepEqual(sanitizeTags(undefined), []);
});

// ---- house-set rotation ----

test('pickHouseSet is deterministic for the same project id', () => {
  const a = pickHouseSet('abc-123');
  const b = pickHouseSet('abc-123');
  assert.equal(a.key, b.key);
  assert.deepEqual(a.tags, b.tags);
});

test('pickHouseSet returns a real set for any input, including junk', () => {
  for (const id of ['', null, undefined, 0, 'x', '🎬']) {
    const set = pickHouseSet(id);
    assert.ok(HOUSE_SETS.some((s) => s.key === set.key), `no set for ${String(id)}`);
  }
});

test('pickHouseSet spreads across every set over a run of ids', () => {
  // If the hash collapsed (e.g. only ever picking index 0), rotation would be
  // a lie and the whole experiment would measure one bucket.
  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(pickHouseSet(`project-${i}`).key);
  assert.equal(seen.size, HOUSE_SETS.length);
});

test('every house set is a distinct pair of clean tags', () => {
  const all = HOUSE_SETS.flatMap((s) => s.tags);
  assert.equal(new Set(all).size, all.length, 'a tag appears in two house sets');
  assert.equal(new Set(HOUSE_SETS.map((s) => s.key)).size, HOUSE_SETS.length);
  for (const s of HOUSE_SETS) {
    assert.equal(s.tags.length, 2);
    assert.deepEqual(sanitizeTags(s.tags), s.tags, `${s.key} has an unclean tag`);
  }
});

// ---- assembling the five ----

test('buildHashtags leads with the film tags and closes with the house pair', () => {
  const tags = buildHashtags({
    filmTags: ['#The Thing', 'John Carpenter', '80s horror'],
    houseSet: HOUSE_SETS.find((s) => s.key === 'retro'),
  });
  assert.deepEqual(tags, ['thething', 'johncarpenter', '80shorror', 'vhs', 'videostore']);
});

test('buildHashtags caps film tags at three even when the model sends more', () => {
  const tags = buildHashtags({
    filmTags: ['a1', 'b2', 'c3', 'd4', 'e5'],
    houseSet: HOUSE_SETS[0],
  });
  assert.equal(tags.length, TAGS_PER_POST);
  assert.deepEqual(tags.slice(0, 3), ['a1', 'b2', 'c3']);
});

test('buildHashtags never repeats the house pair as a film tag', () => {
  const houseSet = HOUSE_SETS.find((s) => s.key === 'retro');
  const tags = buildHashtags({ filmTags: ['VHS', 'videostore', 'thething'], houseSet });
  // The two collisions are dropped, not duplicated, and the freed slots are
  // topped up rather than shipping a three-tag post.
  assert.deepEqual(tags.slice(0, 3), ['thething', 'vhs', 'videostore']);
  assert.equal(tags.length, TAGS_PER_POST);
  assert.equal(new Set(tags).size, tags.length);
});

test('buildHashtags still fills five slots when the model returns no film tags', () => {
  const tags = buildHashtags({ filmTags: [], houseSet: HOUSE_SETS[0] });
  assert.equal(tags.length, TAGS_PER_POST);
  assert.equal(new Set(tags).size, TAGS_PER_POST);
});

test('buildHashtags falls back to a real set when handed no house set', () => {
  const tags = buildHashtags({ filmTags: ['jaws'] });
  assert.ok(tags.length >= 3 && tags.length <= TAGS_PER_POST);
  assert.equal(tags[0], 'jaws');
});

test('formatHashtags writes the line that ships', () => {
  assert.equal(formatHashtags(['jaws', 'spielberg']), '#jaws #spielberg');
  assert.equal(formatHashtags([]), '');
});

// ---- the description ----

test('buildDescription puts the hook first and the tags last', () => {
  const desc = buildDescription({
    hook: 'John Carpenter’s 1982 arctic paranoia classic with Kurt Russell.',
    movie: 'The Thing',
    hashtags: ['thething', 'johncarpenter', 'vhs'],
  });
  const lines = desc.split('\n');
  assert.match(lines[0], /^John Carpenter/);
  assert.equal(lines[lines.length - 1], '#thething #johncarpenter #vhs');
  assert.match(desc, /Drop it in the comments/);
  assert.match(desc, /Follow VHS Garage/);
});

test('buildDescription falls back to the movie name when the hook is missing', () => {
  const desc = buildDescription({ hook: '', movie: 'The Thing', hashtags: ['thething'] });
  assert.match(desc, /The Thing/);
  assert.match(desc, /^\S/);
  assert.doesNotMatch(desc, /\n\n/); // no hole where the hook should have been
});

test('buildDescription stays well inside TikTok’s 4000-char ceiling', () => {
  const desc = buildDescription({
    hook: 'x'.repeat(300),
    movie: 'The Thing',
    hashtags: ['a1', 'b2', 'c3', 'd4', 'e5'],
  });
  assert.ok(desc.length < 1000, `description was ${desc.length} chars`);
});

test('buildDescription tolerates being handed nothing at all', () => {
  const desc = buildDescription({});
  assert.ok(desc.length > 0);
  assert.doesNotMatch(desc, /undefined|null/);
});

// ---- balanced rotation for a batch run ----

test('houseSetAt round-robins so a batch of ten covers every set twice', () => {
  const run = Array.from({ length: 10 }, (_, i) => houseSetAt(i).key);
  const counts = {};
  for (const k of run) counts[k] = (counts[k] || 0) + 1;
  assert.equal(Object.keys(counts).length, HOUSE_SETS.length);
  assert.ok(Object.values(counts).every((c) => c === 2), JSON.stringify(counts));
});

test('houseSetAt never returns undefined for a junk index', () => {
  for (const i of [-3, 0, 1.7, NaN, null, undefined, '4']) {
    assert.ok(HOUSE_SETS.includes(houseSetAt(i)), `bad index ${String(i)}`);
  }
});

test('houseSetByKey resolves a stored key and rejects an unknown one', () => {
  assert.equal(houseSetByKey('retro').key, 'retro');
  assert.equal(houseSetByKey('nope'), null);
  assert.equal(houseSetByKey(''), null);
});

test('filler tags never overlap a house set', () => {
  // A filler that reused a house tag would attach it to posts from every lane
  // and corrupt the per-tag numbers the rotation exists to produce.
  const house = new Set(HOUSE_SETS.flatMap((s) => s.tags));
  for (const t of FILLER_TAGS) assert.ok(!house.has(t), `filler "${t}" is a house tag`);
  assert.deepEqual(sanitizeTags(FILLER_TAGS), FILLER_TAGS, 'a filler tag is unclean');
  assert.ok(FILLER_TAGS.length >= TAGS_PER_POST - 2, 'not enough filler to reach five');
});

test('a topped-up post never accidentally credits another house set', () => {
  // Worst case: the agent returned nothing, so three slots come from filler.
  for (const houseSet of HOUSE_SETS) {
    const tags = buildHashtags({ filmTags: [], houseSet });
    for (const other of HOUSE_SETS) {
      if (other.key === houseSet.key) continue;
      assert.ok(
        !other.tags.every((t) => tags.includes(t)),
        `${houseSet.key} post would also count as ${other.key}`,
      );
    }
  }
});

test('filler varies by house set instead of stapling one tag to every post', () => {
  // A filler that was constant across lanes would occupy a measured slot while
  // carrying no information.
  const firstFiller = HOUSE_SETS.map((houseSet) => {
    const tags = buildHashtags({ filmTags: ['onetag'], houseSet });
    return tags.find((t) => FILLER_TAGS.includes(t));
  });
  assert.ok(firstFiller.every(Boolean), 'a short post did not get topped up');
  assert.ok(new Set(firstFiller).size > 1, 'every house set filled with the same tag');
});
