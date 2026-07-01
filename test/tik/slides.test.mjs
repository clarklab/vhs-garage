import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SLIDES, addSlide, removeSlide, reorderSlide, editCaption, canAddSlide,
} from '../../public/scripts/tik/slides.js';

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
