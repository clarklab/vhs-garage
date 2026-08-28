import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SLIDES, addSlide, addSlideBeforeOutro, removeSlide, reorderSlide, editCaption, canAddSlide, updateSlideFrame,
} from '../../public/scripts/tik/slides.js';
import { isOutroSlide } from '../../public/scripts/tik/project.js';

const s = (id, caption = '') => ({ id, caption });

test('addSlide appends and does not mutate the input array', () => {
  const a = [s('1')];
  const b = addSlide(a, s('2'));
  assert.deepEqual(b.map(x => x.id), ['1', '2']);
  assert.equal(a.length, 1); // original untouched
});

test('addSlide refuses to exceed MAX_SLIDES', () => {
  let arr = [];
  for (let i = 0; i < MAX_SLIDES; i++) arr = addSlide(arr, s(String(i)));
  assert.equal(arr.length, MAX_SLIDES);
  const same = addSlide(arr, s('overflow'));
  assert.equal(same.length, MAX_SLIDES); // unchanged, rejected
});

test('canAddSlide reflects the cap', () => {
  assert.equal(canAddSlide([]), true);
  const full = Array.from({ length: MAX_SLIDES }, (_, i) => s(String(i)));
  assert.equal(canAddSlide(full), false);
});

test('removeSlide drops by id', () => {
  const a = [s('1'), s('2'), s('3')];
  assert.deepEqual(removeSlide(a, '2').map(x => x.id), ['1', '3']);
});

test('reorderSlide moves an item from one index to another', () => {
  const a = [s('1'), s('2'), s('3')];
  assert.deepEqual(reorderSlide(a, 0, 2).map(x => x.id), ['2', '3', '1']);
  assert.deepEqual(reorderSlide(a, 2, 0).map(x => x.id), ['3', '1', '2']);
});

test('editCaption updates only the matching slide, immutably', () => {
  const a = [s('1', 'old'), s('2', 'keep')];
  const b = editCaption(a, '1', 'new');
  assert.equal(b[0].caption, 'new');
  assert.equal(b[1].caption, 'keep');
  assert.equal(a[0].caption, 'old'); // original untouched
});

test('updateSlideFrame replaces bitmap+timecode for the matching slide only, immutably', () => {
  const a = [
    { id: '1', caption: 'c1', bitmap: 'b1', timecode: 1 },
    { id: '2', caption: 'c2', bitmap: 'b2', timecode: 2 },
  ];
  const b = updateSlideFrame(a, '1', 'newbmp', 9);
  assert.equal(b[0].bitmap, 'newbmp');
  assert.equal(b[0].timecode, 9);
  assert.equal(b[0].caption, 'c1');  // caption preserved
  assert.equal(b[1].bitmap, 'b2');   // other slide untouched
  assert.equal(a[0].bitmap, 'b1');   // original untouched
});


// ---- addSlideBeforeOutro: a hand-added slide belongs ahead of the sign-off ----

const outro = (id = 'out') => ({ id, caption: 'Follow VHS Garage for more', kind: 'outro' });

test('addSlideBeforeOutro slips the slide in ahead of a trailing outro', () => {
  const set = [s('1'), s('2'), outro()];
  const next = addSlideBeforeOutro(set, s('new'), isOutroSlide);
  assert.deepEqual(next.map(x => x.id), ['1', '2', 'new', 'out']);
});

test('addSlideBeforeOutro appends when the set has no outro yet', () => {
  const next = addSlideBeforeOutro([s('1'), s('2')], s('new'), isOutroSlide);
  assert.deepEqual(next.map(x => x.id), ['1', '2', 'new']);
});

test('addSlideBeforeOutro appends to an empty set', () => {
  assert.deepEqual(addSlideBeforeOutro([], s('new'), isOutroSlide).map(x => x.id), ['new']);
});

test('addSlideBeforeOutro only looks at the LAST slide', () => {
  // An outro dragged into the middle is the user's arrangement, not a reason to
  // insert in front of it; the new slide still goes at the end.
  const set = [s('1'), outro('moved'), s('2')];
  const next = addSlideBeforeOutro(set, s('new'), isOutroSlide);
  assert.deepEqual(next.map(x => x.id), ['1', 'moved', '2', 'new']);
});

test('addSlideBeforeOutro recognizes an unmarked outro by its follow line', () => {
  // Older projects predate `kind`, so the caption is the only marker.
  const legacy = { id: 'legacy', caption: 'Follow VHS Garage for more bad movies' };
  const next = addSlideBeforeOutro([s('1'), legacy], s('new'), isOutroSlide);
  assert.deepEqual(next.map(x => x.id), ['1', 'new', 'legacy']);
});

test('addSlideBeforeOutro respects the cap and never mutates', () => {
  let arr = [];
  for (let i = 0; i < MAX_SLIDES - 1; i++) arr = addSlide(arr, s(String(i)));
  arr = addSlide(arr, outro());
  const same = addSlideBeforeOutro(arr, s('overflow'), isOutroSlide);
  assert.equal(same.length, MAX_SLIDES);
  assert.equal(same.at(-1).id, 'out'); // rejected outright, outro untouched
  const before = [s('1'), outro()];
  addSlideBeforeOutro(before, s('new'), isOutroSlide);
  assert.deepEqual(before.map(x => x.id), ['1', 'out']);
});

test('addSlideBeforeOutro without a predicate behaves like addSlide', () => {
  const set = [s('1'), outro()];
  assert.deepEqual(addSlideBeforeOutro(set, s('new')).map(x => x.id), ['1', 'out', 'new']);
});


// ---- A replaced frame is a different picture ----

test('updateSlideFrame drops the correction with the old pixels', () => {
  // A brighten set for a night scene, or a zoom framed on one shot's title
  // card, is nonsense on the picture that replaces it — pasting an image into
  // a zoomed slide came back zoomed, which reads as the app acting on its own.
  const set = [{ id: '1', caption: 'a', adjust: { brightness: 1.2, zoom: 1.35 } }];
  const next = updateSlideFrame(set, '1', 'newBitmap', 12.5);
  assert.equal(next[0].adjust, null);
  assert.equal(next[0].bitmap, 'newBitmap');
  assert.equal(next[0].timecode, 12.5);
  assert.equal(next[0].caption, 'a', 'everything else survives');
  assert.deepEqual(set[0].adjust, { brightness: 1.2, zoom: 1.35 }, 'input untouched');
});

test('updateSlideFrame leaves other slides alone', () => {
  const set = [
    { id: '1', adjust: { zoom: 1.2 } },
    { id: '2', adjust: { zoom: 1.35 } },
  ];
  const next = updateSlideFrame(set, '1', 'bmp', 1);
  assert.equal(next[0].adjust, null);
  assert.deepEqual(next[1].adjust, { zoom: 1.35 }, 'the slide that was not re-framed keeps its own');
});
