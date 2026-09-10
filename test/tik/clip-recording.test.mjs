import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordClip } from '../../public/scripts/tik/clip.js';

function fixture(t, { refuse = false, brokenSeek = false, pendingPlay = false, onStatic = () => {} } = {}) {
  const previousWindow = globalThis.window;
  const previousRecorder = globalThis.MediaRecorder;
  const recorders = [];
  class Recorder {
    state = 'inactive';
    constructor() { recorders.push(this); }
    start() { this.state = 'recording'; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable({ data: new Blob(['test video']) });
      queueMicrotask(() => this.onstop());
    }
  }
  class Video extends EventTarget {
    muted = true;
    playbackRate = 1.5;
    time = 0;
    timer = null;
    get currentTime() { return this.time; }
    set currentTime(t) {
      if (brokenSeek) throw new Error('Cannot seek');
      this.time = t;
      queueMicrotask(() => this.dispatchEvent(new Event('seeked')));
    }
    async play() {
      if (refuse) throw new Error('Playback refused');
      if (pendingPlay) return new Promise(() => {});
      this.timer = setInterval(() => { this.time += 0.02; }, 5);
    }
    pause() { clearInterval(this.timer); this.timer = null; }
  }
  const video = new Video();
  let trackStopped = false;
  const canvas = {
    width: 1080, height: 1920,
    ownerDocument: { createElement: () => ({ getContext: () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {},
    }) }) },
    getContext: () => ({ save() {}, restore() {}, setTransform() {}, fillRect() {}, drawImage: onStatic }),
    captureStream: () => ({ getVideoTracks: () => [{ stop: () => { trackStopped = true; } }] }),
  };
  globalThis.window = { MediaRecorder: Recorder };
  globalThis.MediaRecorder = Recorder;
  t.after(() => {
    video.pause();
    globalThis.window = previousWindow;
    globalThis.MediaRecorder = previousRecorder;
  });
  return { video, canvas, recorders, trackStopped: () => trackStopped };
}

const plan = { parts: [{ kind: 'scene', start: 0, end: 0.06 }] };

test('a refused playback fails promptly and restores the editor', async (t) => {
  const f = fixture(t, { refuse: true });
  await assert.rejects(recordClip({ ...f, plan, mimeType: 'video/webm', paint() {} }), /Playback refused/);
  assert.equal(f.video.muted, true);
  assert.equal(f.video.playbackRate, 1.5);
  assert.equal(f.video.timer, null);
  assert.equal(f.recorders[0].state, 'inactive');
  assert.equal(f.trackStopped(), true);
});

test('failure before the recorder starts cleans up without waiting for an impossible stop', async (t) => {
  const f = fixture(t, { brokenSeek: true });
  await assert.rejects(recordClip({ ...f, plan: { parts: [{ kind: 'scene', start: 10, end: 11 }] }, mimeType: 'video/webm', paint() {} }), /Cannot seek/);
  assert.equal(f.recorders[0].state, 'inactive');
  assert.equal(f.trackStopped(), true);
});

test('recording uses normal playback speed then restores the editor speed', async (t) => {
  const f = fixture(t);
  const speeds = [];
  const out = await recordClip({ ...f, plan, fps: 100, mimeType: 'video/webm', paint() { speeds.push(f.video.playbackRate); } });
  assert.ok(out.blob.size > 0);
  assert.ok(speeds.every((speed) => speed === 1));
  assert.equal(f.video.playbackRate, 1.5);
  assert.equal(f.trackStopped(), true);
});

test('cancel also interrupts a play request that never settles', async (t) => {
  const f = fixture(t, { pendingPlay: true });
  const controller = new AbortController();
  const job = recordClip({ ...f, plan, signal: controller.signal, mimeType: 'video/webm', paint() {} });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(job, (error) => error.cancelled === true);
  assert.equal(f.recorders[0].state, 'inactive');
  assert.equal(f.trackStopped(), true);
});

test('static records between scenes and before the outro without playing or extending the film', async (t) => {
  const frames = [];
  const f = fixture(t, { onStatic() {
    assert.equal(f.video.timer, null, 'movie is paused during static');
    frames.push(f.video.currentTime);
  } });
  const parts = [
    { kind: 'scene', start: 0, end: 0.06 },
    { kind: 'static', seconds: 0.25 },
    { kind: 'scene', start: 10, end: 10.06 },
    { kind: 'static', seconds: 0.25 },
    { kind: 'still', seconds: 0.03 },
  ];
  const painted = new Set();
  const progress = [];
  await recordClip({ ...f, plan: { parts }, fps: 100, mimeType: 'video/webm',
    onProgress: (message) => progress.push(message),
    paint(part) {
      assert.notEqual(part.kind, 'static', 'static does not use slide captions or composition');
      painted.add(part);
      if (part.kind === 'still' && painted.has('outro-started')) {
        assert.equal(f.recorders[0].state, 'recording', 'the still resumes after the transition');
      }
      if (part.kind === 'still') painted.add('outro-started');
    },
  });
  assert.ok(frames.length >= 4);
  assert.equal(new Set(frames).size, 2, 'each burst holds its own movie playhead');
  assert.ok(painted.has(parts[0]) && painted.has(parts[2]) && painted.has(parts[4]));
  assert.ok(progress.includes('Recording 3/3…'), 'effect parts do not inflate the scene progress');
  assert.equal(f.trackStopped(), true);
});

test('cancel during static stops recording and never starts the next scene', async (t) => {
  const controller = new AbortController();
  let frames = 0;
  const f = fixture(t, { onStatic() { if (++frames === 3) controller.abort(); } });
  const parts = [plan.parts[0], { kind: 'static', seconds: 0.25 }, { kind: 'scene', start: 10, end: 11 }];
  await assert.rejects(recordClip({ ...f, plan: { parts }, signal: controller.signal,
    mimeType: 'video/webm', paint(part) { assert.notEqual(part, parts[2]); },
  }), (error) => error.cancelled === true);
  assert.equal(f.recorders[0].state, 'inactive');
  assert.equal(f.video.timer, null);
  assert.equal(f.trackStopped(), true);
});
