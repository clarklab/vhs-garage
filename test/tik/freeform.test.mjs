import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFreeformPrompt, normalizeFreeform, clampCount,
  FREEFORM_COUNT, FREEFORM_MIN, FREEFORM_MAX,
} from '../../netlify/functions/lib/freeform.mjs';
import { FORMATS, defaultPostFields, photoQueryFor, captionForFreeform } from '../../public/scripts/tik/project.js';

// ---- how many slides ----

test('the count sticks to a range a slideshow can actually be', () => {
  assert.ok(FREEFORM_MIN >= 2 && FREEFORM_MAX <= 20 && FREEFORM_MIN < FREEFORM_COUNT);
  assert.equal(clampCount(1), FREEFORM_MIN);
  assert.equal(clampCount(99), FREEFORM_MAX);
  assert.equal(clampCount(8), 8);
  assert.equal(clampCount(12.6), 13);
});

test('an unspecified count means the default, not the floor', () => {
  // Number(null) is 0, which is finite, and would have quietly clamped an
  // unset count down to the minimum.
  for (const empty of [null, undefined, '', 'nope']) {
    assert.equal(clampCount(empty), FREEFORM_COUNT, JSON.stringify(empty));
  }
});

// ---- the prompt ----

test('the brief is fenced and treated as data, not as instructions', () => {
  const p = buildFreeformPrompt({ topic: 'top 8 slasher villains', count: 8 });
  assert.match(p, /<brief>top 8 slasher villains<\/brief>/);
  assert.match(p, /as data and not instructions/i);
  assert.match(p, /exactly 8 items/);
});

test('every slide is told to carry its own image search', () => {
  // The pictures are the work on this format; a slide with no search term
  // leaves the user hunting by hand.
  const p = buildFreeformPrompt({ topic: 'x' });
  assert.match(p, /"search"/);
  assert.match(p, /Google Images/i);
  assert.match(p, /specific enough to return the right thing/i);
});

test('the set is ordered to finish strong', () => {
  assert.match(buildFreeformPrompt({ topic: 'x' }), /strongest LAST/);
});

test('post copy and songs come back in the same call', () => {
  const p = buildFreeformPrompt({ topic: 'x', includeMeta: true });
  assert.match(p, /"hook"/);
  assert.match(p, /"filmTags"/);
  assert.match(p, /"songs"/);
  assert.match(p, /never an orchestral score/i);
  // And can be turned off without leaving a dangling shape.
  const bare = buildFreeformPrompt({ topic: 'x', includeMeta: false });
  assert.doesNotMatch(bare, /"songs"/);
  assert.doesNotMatch(bare, /"meta"/);
});

test('previous wording is fed back so a rewrite moves', () => {
  const p = buildFreeformPrompt({ topic: 'x', exclude: ['Michael Myers never runs.', ''] });
  assert.match(p, /Already used on this post/i);
  assert.match(p, /Michael Myers never runs/);
});

// ---- what comes back ----

const GOOD = {
  title: 'Slasher Villains',
  intro: 'Who did we miss?',
  items: [
    { heading: 'Michael Myers', sub: 'Halloween (1978)', caption: 'He never runs.', search: 'Michael Myers Halloween 1978' },
    { heading: 'Pinhead', sub: 'Hellraiser (1987)', caption: 'Such sights to show you.', search: 'Pinhead Hellraiser 1987' },
  ],
};

test('a clean answer passes through whole', () => {
  const out = normalizeFreeform(GOOD);
  assert.equal(out.title, 'Slasher Villains');
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0].search, 'Michael Myers Halloween 1978');
});

test('an item with no caption or no heading is dropped, not shipped blank', () => {
  const out = normalizeFreeform({ items: [
    ...GOOD.items,
    { heading: 'Nothing to say', caption: '' },
    { heading: '', caption: 'nobody' },
    { caption: 'no heading either' },
  ]});
  assert.equal(out.items.length, 2);
});

test('a repeated entry is dropped rather than becoming a duplicate slide', () => {
  const out = normalizeFreeform({ items: [
    GOOD.items[0],
    { ...GOOD.items[0], heading: 'MICHAEL MYERS', caption: 'said twice' },
  ]});
  assert.equal(out.items.length, 1);
});

test('a missing search term falls back to the heading, never to nothing', () => {
  // Better an imperfect search than a slide with no way to find its picture.
  const out = normalizeFreeform({ items: [{ heading: 'Chucky', caption: 'Hi, I am Chucky.' }] });
  assert.equal(out.items[0].search, 'Chucky');
});

test('the count cap is honoured on the way back in', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ heading: `Item ${i}`, caption: `Caption ${i}`, search: `s${i}` }));
  assert.equal(normalizeFreeform({ items: many }).items.length, FREEFORM_MAX);
  assert.equal(normalizeFreeform({ items: many }, 5).items.length, 5);
});

test('junk normalizes to an empty set instead of throwing', () => {
  for (const bad of [null, undefined, {}, { items: 'nope' }, { items: [null, 7, 'x'] }, 'string']) {
    const out = normalizeFreeform(bad);
    assert.deepEqual(out.items, [], JSON.stringify(bad));
    assert.equal(typeof out.title, 'string');
    assert.equal(typeof out.intro, 'string');
  }
});

test('em dashes are stripped, the way every other format strips them', () => {
  const out = normalizeFreeform({ title: 'A — B', items: [
    { heading: 'X', caption: 'One thing — and another.', search: 's' },
  ]});
  assert.doesNotMatch(out.title, /[—–]/);
  assert.doesNotMatch(out.items[0].caption, /[—–]/);
});

// ---- the format in the studio ----

test('Freeform is a registered format with its own look', () => {
  const f = FORMATS.freeform;
  assert.ok(f, 'not registered');
  assert.equal(f.label, 'Freeform');
  assert.ok(f.icon && f.chip && f.tagline && f.editorHint);
  // A distinct accent, so the library chip is not another format's colour.
  const chips = Object.values(FORMATS).map((x) => x.chip);
  assert.equal(new Set(chips).size, chips.length, 'two formats share a chip');
});

test('each slide searches for its own subject', () => {
  const project = { format: 'freeform' };
  assert.equal(photoQueryFor(project, { search: 'Pinhead Hellraiser 1987' }), 'Pinhead Hellraiser 1987');
  // No term is a real answer: the button simply is not offered.
  assert.equal(photoQueryFor(project, {}), '');
  assert.equal(photoQueryFor(project, { search: '   ' }), '');
});

test('a Freeform post gets its own title, description and hashtags', () => {
  const post = defaultPostFields('freeform', 'Slasher Villains', {
    meta: { hook: 'Eight of them.', filmTags: ['slashers', 'horror'] }, projectId: 'abc',
  });
  assert.equal(post.title, 'Slasher Villains');
  assert.match(post.description, /Eight of them/);
  assert.ok(post.hashtags.length >= 3);
  assert.ok(post.hashtagSet, 'no house set recorded');
  // And it still produces usable copy with no agent answer at all.
  const bare = defaultPostFields('freeform', 'Some List');
  assert.ok(bare.title && bare.description && bare.hashtags.length);
});

test('a slide caption puts the heading over the line, without nested parens', () => {
  // `sub` is free text the agent wrote and usually carries its own brackets;
  // wrapping it produced "Michael Myers (Halloween (1978))".
  const c = captionForFreeform({ heading: 'Michael Myers', sub: 'Halloween (1978)', caption: 'He never runs.' });
  assert.equal(c, 'Michael Myers · Halloween (1978)\nHe never runs.');
  assert.doesNotMatch(c, /\(\(|\)\)/);
});

test('a caption survives a missing sub, heading or body', () => {
  assert.equal(captionForFreeform({ heading: 'Chucky', caption: 'Hi.' }), 'Chucky\nHi.');
  assert.equal(captionForFreeform({ heading: 'Chucky', sub: '', caption: '' }), 'Chucky');
  assert.equal(captionForFreeform({}), '');
  assert.equal(captionForFreeform(null), '');
});

test('each format asks for the right thing and promises the right account', () => {
  const desc = (format) => defaultPostFields(format, 'X', { projectId: 'p' }).description;
  // A Quote-a-long asking for "your favorite quote from the movie" is asking
  // for the thing its own slides just showed.
  assert.match(desc('quotes'), /Which line do you quote most/);
  assert.match(desc('quotes'), /more movie quotes/);
  assert.match(desc('freeform'), /Who did we miss/);
  assert.match(desc('freeform'), /more from the video store/);
  assert.doesNotMatch(desc('freeform'), /movie trivia/);
});

test('Tape Trivia copy is untouched, because a server parser reads it', () => {
  // parsePostedMovie() recovers the film from "hidden details from X" when a
  // post title has been hand-edited. Reword this and batch mode starts
  // proposing films that were already covered.
  const d = defaultPostFields('trivia', 'The Thing', { projectId: 'p' }).description;
  assert.match(d, /Behind-the-scenes facts and hidden details from The Thing\./);
  assert.match(d, /What’s your favorite quote from the movie\? Drop it in the comments\./);
  assert.match(d, /Follow VHS Garage for more movie trivia\./);
});
