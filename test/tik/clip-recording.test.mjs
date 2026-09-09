import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordClip } from '../../public/scripts/tik/clip.js';

function fixture(t, { refuse = false, brokenSeek = false, pendingPlay = false } = {}) {
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
  const canvas = { captureStream: () => ({ getVideoTracks: () => [{ stop: () => { trackStopped = true; } }] }) };
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
