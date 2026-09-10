import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { seekForClip, CLIP_SEEK_TIMEOUT_MS } from '../../public/scripts/tik/clip-seek.js';

class Movie extends EventTarget {
  time = 0;
  readyState = 2;
  seeking = false;
  error = null;
  seeks = [];
  get currentTime() { return this.time; }
  set currentTime(time) { this.time = time; this.seeking = true; this.readyState = 1; this.seeks.push(time); }
  finish({ event = true, time = this.time } = {}) {
    this.time = time;
    this.seeking = false;
    this.readyState = 2;
    if (event) this.dispatchEvent(new Event('seeked'));
  }
}

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  return new Movie();
}

function assertClean(video, signal) {
  for (const event of ['seeked', 'loadeddata', 'canplay', 'error']) assert.equal(getEventListeners(video, event).length, 0);
  if (signal) assert.equal(getEventListeners(signal, 'abort').length, 0);
}

test('a seek taking longer than four seconds finishes without restarting or failing', async (t) => {
  const video = fixture(t);
  let waiting = 0, finished = false;
  const job = seekForClip(video, 1800, { onWaiting: () => waiting++ }).then(() => { finished = true; });
  t.mock.timers.tick(4500);
  await Promise.resolve();
  assert.equal(waiting, 1);
  assert.equal(finished, false);
  video.finish();
  await job;
  assert.deepEqual(video.seeks, [1800]);
  assertClean(video);
  t.mock.timers.tick(CLIP_SEEK_TIMEOUT_MS);
  assert.equal(waiting, 1);
});

test('a completed seek with no seeked event is recognized from the ready frame', async (t) => {
  const video = fixture(t);
  let finished = false;
  const job = seekForClip(video, 600).then(() => { finished = true; });
  t.mock.timers.tick(200);
  await Promise.resolve();
  assert.equal(finished, false, 'currentTime changes before decoding finishes');
  video.finish({ event: false });
  t.mock.timers.tick(100);
  await job;
  assertClean(video);
});

test('an in-flight seek to the same frame is not restarted, and must still decode', async (t) => {
  const video = fixture(t);
  video.currentTime = 600;
  let finished = false;
  const job = seekForClip(video, 600).then(() => { finished = true; });
  assert.deepEqual(video.seeks, [600]);
  video.seeking = false;
  video.dispatchEvent(new Event('seeked'));
  t.mock.timers.tick(100);
  await Promise.resolve();
  assert.equal(finished, false, 'seeked alone is not a decoded frame');
  video.readyState = 2;
  video.dispatchEvent(new Event('loadeddata'));
  await job;
  assertClean(video);
});

test('an already decoded target needs no seek or event', async (t) => {
  const video = fixture(t);
  await seekForClip(video, 0);
  assert.deepEqual(video.seeks, []);
  assertClean(video);
});

test('cancel interrupts a pending seek immediately and removes its listeners', async (t) => {
  const video = fixture(t);
  const controller = new AbortController();
  const job = seekForClip(video, 600, { signal: controller.signal });
  controller.abort();
  await assert.rejects(job, (error) => error.cancelled === true);
  assertClean(video, controller.signal);
  await assert.rejects(seekForClip(video, 900, { signal: controller.signal }), (error) => error.cancelled === true);
  assert.deepEqual(video.seeks, [600], 'an already cancelled request never moves the movie');
});

test('a decode error fails immediately instead of sitting through the seek timeout', async (t) => {
  const video = fixture(t);
  const job = seekForClip(video, 600);
  video.error = { code: 3 };
  video.dispatchEvent(new Event('error'));
  await assert.rejects(job, /decode.*600.00s.*media error 3/);
  assertClean(video);
  await assert.rejects(seekForClip(video, 900), /decode.*900.00s/);
  assert.deepEqual(video.seeks, [600]);
});

test('a truly stuck seek still has a bounded timeout with useful state', async (t) => {
  const video = fixture(t);
  const job = seekForClip(video, 600);
  t.mock.timers.tick(CLIP_SEEK_TIMEOUT_MS);
  await assert.rejects(job, (error) => {
    assert.match(error.message, /600.00s after 30 seconds/);
    assert.doesNotMatch(error.message, /compatible/);
    assert.deepEqual(error.seek, { target: 600, currentTime: 600, seeking: true, readyState: 1 });
    return true;
  });
  assertClean(video);
});

test('a seek event for the wrong position never permits unrelated footage', async (t) => {
  const video = fixture(t);
  const job = seekForClip(video, 600);
  video.finish({ time: 30 });
  t.mock.timers.tick(CLIP_SEEK_TIMEOUT_MS);
  await assert.rejects(job, /did not finish seeking/);
  assertClean(video);
});

test('a setter failure releases pending timers and listeners', async (t) => {
  const video = fixture(t);
  Object.defineProperty(video, 'currentTime', { get: () => 0, set: () => { throw new Error('Movie unavailable'); } });
  await assert.rejects(seekForClip(video, 600), /Movie unavailable/);
  assertClean(video);
});
