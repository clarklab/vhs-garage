import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  groupForQuickPost, canPublish, composeOptionsFor, postCopyFor, songsFor, songQuery,
} from '../../public/scripts/tik/quickpostlib.js';

const slide = (extra = {}) => ({ caption: 'x', frame: null, ...extra });

test('ready sets come first in queue order, then drafts newest first, then posts', () => {
  const recs = [
    { id: 'd-old', status: 'draft', updatedAt: 1, slides: [slide()] },
    { id: 'r-2', status: 'ready', updatedAt: 20, slides: [slide()] },
    { id: 'p-1', status: 'posted', postedAt: 5, updatedAt: 5, slides: [slide()] },
    { id: 'd-new', status: 'draft', updatedAt: 9, slides: [slide()] },
    { id: 'r-1', status: 'ready', updatedAt: 10, slides: [slide()] },
    { id: 'empty', status: 'draft', updatedAt: 50, slides: [] },
    { id: 'imp', status: 'posted', updatedAt: 99, imported: { id: '1', link: 'https://x' }, slides: [] },
  ];
  const g = groupForQuickPost(recs);
  assert.deepEqual(g.ready.map((r) => r.id), ['r-1', 'r-2']);
  assert.deepEqual(g.drafts.map((r) => r.id), ['d-new', 'd-old'], 'an empty draft is not worth showing on a phone');
  assert.deepEqual(g.posted.map((r) => r.id), ['imp', 'p-1'], 'imported posts are history too');
});

test('a set that is not finished cannot be posted from the phone', () => {
  assert.equal(canPublish({ slides: [] }).ok, false);
  assert.equal(canPublish({ slides: [slide()], batch: { pendingFrames: true } }).ok, false);
  assert.equal(canPublish({ slides: Array.from({ length: 36 }, () => slide()) }).ok, false);
  assert.equal(canPublish({ format: 'quotes', output: 'video', slides: [slide()] }).ok, false);
  assert.deepEqual(canPublish({ format: 'trivia', slides: [slide()] }), { ok: true });
});

test('the phone draws the slides with the studio’s options', () => {
  assert.deepEqual(composeOptionsFor({ format: 'trivia', titleOn: true, titleLine: ' Aliens (1986) ' }),
    { titleLine: 'Aliens (1986)', maxFrameHeightRatio: null, format: 'trivia' });
  assert.equal(composeOptionsFor({ format: 'trivia', titleOn: false, titleLine: 'Aliens' }).titleLine, '');
  assert.equal(composeOptionsFor({ format: 'someguys', titleOn: true, titleLine: 'X' }).titleLine, '', 'only trivia uses the title prefix');
  assert.equal(composeOptionsFor({ format: 'year' }).maxFrameHeightRatio, 0.6);
});

test('the post copy is the set’s own, or the default', () => {
  assert.deepEqual(postCopyFor({ format: 'trivia', postTitle: ' T ', postDesc: 'D' }), { title: 'T', description: 'D' });
  const fallback = postCopyFor({ format: 'trivia', name: 'Aliens (1986)' });
  assert.ok(fallback.title.length > 0);
  assert.ok(fallback.description.length > 0);
});

test('sound picks become one search line', () => {
  const rec = { postMeta: { songs: [{ title: 'Holding Out for a Hero', artist: 'Bonnie Tyler' }, { title: '' }, null] } };
  assert.equal(songsFor(rec).length, 1);
  assert.equal(songQuery(songsFor(rec)[0]), 'Holding Out for a Hero Bonnie Tyler');
  assert.deepEqual(songsFor({}), []);
});

test('every element the quick-post page script looks up exists in its page', () => {
  const html = readFileSync(new URL('../../src/pages/tik/post.astro', import.meta.url), 'utf8');
  const src = readFileSync(new URL('../../public/scripts/tik/quickpost.js', import.meta.url), 'utf8');
  const wanted = [...new Set([...src.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
  assert.ok(wanted.length > 20, `expected id lookups, found ${wanted.length}`);
  const missing = wanted.filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});
