import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  groupForQuickPost, canPublish, composeOptionsFor, postCopyFor, songsFor, songQuery, wrongsFor, flagsFor, shotNotesFor, hms, adjustNotesFor,
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

test('the phone can say how a frame was chosen: the direction, then the pick', () => {
  assert.deepEqual(shotNotesFor({
    grabHint: ' Kano, red eye plate ', timecode: 209,
    frameScan: { source: 'claude', why: 'Picked by Claude from the whole film: Kano face on, eye plate lit' },
  }), [
    { label: 'Direction', text: 'Kano, red eye plate' },
    { label: 'Picked', text: 'Claude: Kano face on, eye plate lit · at 3:29' },
  ]);
  assert.deepEqual(shotNotesFor({ timecode: 3725.5, frameScan: { source: 'scan', score: 62, why: 'two men at a table' } }),
    [{ label: 'Picked', text: 'web shoot, 62% sure: two men at a table · at 1:02:05' }]);
  assert.deepEqual(shotNotesFor({ timecode: 12, frameScan: { source: 'manual', wrong: { note: '' } } }),
    [{ label: 'Picked', text: 'by hand · at 0:12' }]);
  assert.deepEqual(shotNotesFor({ timecode: 12 }), [{ label: 'Picked', text: 'by hand · at 0:12' }], 'a frame grabbed before scans existed');
  assert.deepEqual(shotNotesFor({ frameScan: { source: 'claude', why: 'Picked by Claude from a local look at the whole film' } }),
    [{ label: 'Picked', text: 'Claude: a look at the whole film, no note' }]);
  assert.deepEqual(shotNotesFor({ frameScan: { source: 'failed', why: 'no match' } }), [{ label: 'Picked', text: 'nothing found: no match' }]);
  assert.deepEqual(shotNotesFor({ caption: 'x' }), [], 'nothing to say about a slide with no frame history');
  assert.deepEqual(shotNotesFor(null), []);
  assert.equal(hms(0), '0:00');
  assert.equal(hms(3600), '1:00:00');
});

test('a set counts its batch flags and its wrong-frame marks separately', () => {
  const rec = { slides: [{ frameScan: { review: true } }, { frameScan: { wrong: { note: '' } } }, { frameScan: null }] };
  assert.equal(flagsFor(rec), 1);
  assert.equal(wrongsFor(rec), 1);
  assert.equal(wrongsFor({}), 0);
});

test('the adjust tool says whether this frame has been touched, and how', () => {
  assert.deepEqual(adjustNotesFor({ adjust: { brightness: 1.2, contrast: 1, saturate: 1, zoom: 1.2 } }),
    { label: 'Adjusted', summary: '+20% bright, +20% zoom', touched: true });
  assert.deepEqual(adjustNotesFor({ caption: 'x' }), { label: 'Adjust', summary: 'As grabbed', touched: false });
  assert.deepEqual(adjustNotesFor(null), { label: 'Adjust', summary: 'As grabbed', touched: false });
});

// ---- Text size on the phone: the studio's caption nudge, a click at a time ----
import * as qp from '../../public/scripts/tik/quickpostlib.js';

test('the phone nudges a caption size in the studio steps and stays inside its range', () => {
  assert.equal(typeof qp.nudgedFontScale, 'function');
  assert.equal(qp.nudgedFontScale(1, -1), 0.9);
  assert.equal(qp.nudgedFontScale(0.9, -1), 0.8);
  assert.equal(qp.nudgedFontScale(0.8, +1), 0.9, 'no float drift: 0.8 + 0.1 is 0.9, not 0.9000000001');
  assert.equal(qp.nudgedFontScale(undefined, +1), 1.1, 'a slide with no scale is at 1');
  assert.equal(qp.nudgedFontScale(0.5, -1), 0.5, 'floor');
  assert.equal(qp.nudgedFontScale(1.6, +1), 1.6, 'ceiling');
});

test('the text size tool says where this caption sits', () => {
  assert.equal(typeof qp.textSizeNotesFor, 'function');
  assert.deepEqual(qp.textSizeNotesFor({ caption: 'x' }), { label: 'Text size', summary: '100%', touched: false });
  assert.deepEqual(qp.textSizeNotesFor({ caption: 'x', fontScale: 0.9 }), { label: 'Text 90%', summary: '90%', touched: true });
  assert.deepEqual(qp.textSizeNotesFor({ caption: 'x', fontScale: 1.2 }), { label: 'Text 120%', summary: '120%', touched: true });
});
