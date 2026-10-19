// Stitch library clips into one video, in order, with an optional
// transition between them (cut / crossfade / static — see stitch-plan.js).
//
// Unlike Trim, which re-records by playing the clip in real time, this
// decodes and re-encodes with WebCodecs through Mediabunny (vendored under
// /vendor/mediabunny, MPL-2.0), so it runs as fast as the hardware encoder
// allows. Every clip is decoded, drawn onto one canvas at the first clip's
// size (others letterboxed to fit), and encoded once — which is what lets
// clips from different sources and sizes, and the transitions, mix freely.
//
// Audio is resampled to 48 kHz stereo and mixed per clip with the plan's
// gain curves; gaps inside a source are filled with silence so picture and
// sound stay locked.

import {
  Input, BlobSource, ALL_FORMATS, CanvasSink, AudioBufferSink,
  Output, Mp4OutputFormat, StreamTarget, CanvasSource, AudioBufferSource,
  getFirstEncodableAudioCodec, getFirstEncodableVideoCodec,
} from '/vendor/mediabunny/mediabunny.min.mjs';
import { planStitch, frameAt, clipGainAt, staticGainAt } from './stitch-plan.js';

const RATE = 48000;
const WINDOW_SEC = 0.5;
const GAIN_BLOCK = 32;

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function toStereo48k(buffer) {
  const l = buffer.getChannelData(0);
  const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l;
  if (buffer.sampleRate === RATE) return [l, r];
  const ratio = buffer.sampleRate / RATE;
  const n = Math.floor(l.length / ratio);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio, i0 = Math.floor(x), f = x - i0;
    const i1 = Math.min(i0 + 1, l.length - 1);
    L[i] = l[i0] + (l[i1] - l[i0]) * f;
    R[i] = r[i0] + (r[i1] - r[i0]) * f;
  }
  return [L, R];
}

// Sequential PCM from one clip's audio track, aligned to its timestamps:
// sample N of the reader is clip time N / 48000.
class PcmReader {
  constructor(track) {
    this.iter = track ? new AudioBufferSink(track).buffers()[Symbol.asyncIterator]() : null;
    this.done = !track;
    this.queue = [];
    this.queued = 0;
    this.writePos = 0;
  }

  push(L, R) {
    this.queue.push({ L, R });
    this.queued += L.length;
    this.writePos += L.length;
  }

  async fill(n) {
    while (this.queued < n && !this.done) {
      const r = await this.iter.next();
      if (r.done) { this.done = true; break; }
      let [L, R] = toStereo48k(r.value.buffer);
      const at = Math.round(r.value.timestamp * RATE);
      if (at > this.writePos) {
        const gap = Math.min(at - this.writePos, RATE * 2);
        this.push(new Float32Array(gap), new Float32Array(gap));
      } else if (at < this.writePos) {
        const drop = this.writePos - at;
        if (drop >= L.length) continue;
        L = L.subarray(drop);
        R = R.subarray(drop);
      }
      this.push(L, R);
    }
  }

  async read(n) {
    await this.fill(n);
    const L = new Float32Array(n), R = new Float32Array(n);
    let o = 0;
    while (o < n && this.queue.length) {
      const head = this.queue[0];
      const take = Math.min(n - o, head.L.length);
      L.set(head.L.subarray(0, take), o);
      R.set(head.R.subarray(0, take), o);
      if (take === head.L.length) this.queue.shift();
      else { head.L = head.L.subarray(take); head.R = head.R.subarray(take); }
      o += take;
      this.queued -= take;
    }
    return [L, R];
  }

  close() {
    this.iter?.return?.();
    this.done = true;
  }
}

// Chunky analog-looking snow: a few pre-rendered half-res noise frames,
// scaled up without smoothing, with rolling bright bands.
function makeStatic(W, H) {
  const w = Math.max(2, W >> 1), h = Math.max(2, H >> 1);
  const frames = [];
  for (let i = 0; i < 6; i++) {
    const c = new OffscreenCanvas(w, h);
    const cx = c.getContext('2d');
    const img = cx.createImageData(w, h);
    const d = img.data;
    for (let p = 0; p < d.length; p += 4) {
      const v = Math.random() * 255;
      d[p] = d[p + 1] = d[p + 2] = v;
      d[p + 3] = 255;
    }
    cx.putImageData(img, 0, 0);
    frames.push(c);
  }
  return (ctx, k) => {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(frames[k % frames.length], 0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    const band = (k * 37) % H;
    ctx.fillRect(0, band, W, Math.max(4, H / 12));
  };
}

async function frameRateOf(track) {
  try {
    const stats = await track.computePacketStats(120);
    const r = stats.averagePacketRate;
    if (Number.isFinite(r) && r >= 10 && r <= 61) return Math.abs(r - 29.97) < 0.2 ? 30000 / 1001 : Math.round(r);
  } catch (e) {
    console.warn('[stitch] could not measure frame rate, using 30:', e);
  }
  return 30;
}

// files: File[] in order. writable: a FileSystemWritableFileStream for the
// output (closed by the muxer on success). Returns { duration, width,
// height, fps }.
export async function stitchClips({ files, transition = 'cut', writable, bitrate = 5_000_000, onProgress, signal }) {
  const inputs = files.map(f => new Input({ source: new BlobSource(f), formats: ALL_FORMATS }));
  const readers = [];
  const iters = [];
  let output = null;
  try {
    const meta = [];
    for (let i = 0; i < inputs.length; i++) {
      const v = await inputs[i].getPrimaryVideoTrack();
      if (!v) throw new Error(`"${files[i].name}" has no video track.`);
      if (!(await v.canDecode())) throw new Error(`This browser can't decode "${files[i].name}".`);
      let a = await inputs[i].getPrimaryAudioTrack();
      if (a && !(await a.canDecode())) {
        console.warn('[stitch] cannot decode audio, using silence for', files[i].name);
        a = null;
      }
      const duration = await inputs[i].computeDuration();
      if (!(duration > 0)) throw new Error(`"${files[i].name}" has no playable length.`);
      meta.push({ v, a, duration });
    }

    const W = even(await meta[0].v.getDisplayWidth());
    const H = even(await meta[0].v.getDisplayHeight());
    const fps = await frameRateOf(meta[0].v);
    const plan = planStitch(meta.map(m => m.duration), transition);
    const totalFrames = Math.ceil(plan.total * fps);

    // Which source time each clip must deliver, frame by frame — fed to the
    // sinks up front so each decodes its clip exactly once, in order.
    const times = meta.map(() => []);
    for (let k = 0; k < totalFrames; k++) {
      for (const layer of frameAt(plan, k / fps).layers) {
        times[layer.index].push(Math.min(layer.sourceTime, meta[layer.index].duration - 1e-3));
      }
    }
    const sinks = meta.map(m => new CanvasSink(m.v, { width: W, height: H, fit: 'contain', poolSize: 2 }));
    const iterFor = (i) => {
      if (!iters[i]) iters[i] = sinks[i].canvasesAtTimestamps(times[i])[Symbol.asyncIterator]();
      return iters[i];
    };

    const videoCodec = await getFirstEncodableVideoCodec(['avc', 'vp9'], { width: W, height: H });
    if (!videoCodec) throw new Error('This browser has no usable video encoder.');
    const audioCodec = await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: RATE });
    if (!audioCodec) throw new Error('This browser has no usable audio encoder.');

    output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(writable, { chunked: true }),
    });
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { alpha: false });
    const videoSource = new CanvasSource(canvas, { codec: videoCodec, bitrate, keyFrameInterval: 2 });
    output.addVideoTrack(videoSource, { frameRate: fps });
    const audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: 192_000 });
    output.addAudioTrack(audioSource);
    await output.start();

    const drawStatic = makeStatic(W, H);
    const clipSamples = plan.clips.map(c => ({
      start: Math.round(c.start * RATE),
      end: Math.round(c.start * RATE) + Math.round(c.duration * RATE),
    }));
    const lastFrameOf = meta.map(() => -1);
    for (let k = 0; k < totalFrames; k++) {
      for (const l of frameAt(plan, k / fps).layers) lastFrameOf[l.index] = k;
    }

    let k = 0;
    for (let a = 0; a < plan.total; a += WINDOW_SEC) {
      if (signal?.aborted) throw new DOMException('Stitch cancelled', 'AbortError');
      const b = Math.min(plan.total, a + WINDOW_SEC);

      // Video frames in [a, b).
      for (; k < totalFrames && k / fps < b; k++) {
        const t = k / fps;
        const f = frameAt(plan, t);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        for (const layer of f.layers) {
          const wc = (await iterFor(layer.index).next()).value;
          if (wc) {
            ctx.globalAlpha = layer.alpha;
            ctx.drawImage(wc.canvas, 0, 0, W, H);
          }
          if (k === lastFrameOf[layer.index]) {
            iters[layer.index].return?.();
          }
        }
        ctx.globalAlpha = 1;
        if (f.static) drawStatic(ctx, k);
        await videoSource.add(t, 1 / fps);
      }

      // Audio samples in [a, b).
      const A = Math.round(a * RATE), B = Math.round(b * RATE), n = B - A;
      if (n > 0) {
        const L = new Float32Array(n), R = new Float32Array(n);
        for (let i = 0; i < meta.length; i++) {
          const lo = Math.max(A, clipSamples[i].start), hi = Math.min(B, clipSamples[i].end);
          if (hi <= lo) continue;
          if (!readers[i]) readers[i] = new PcmReader(meta[i].a);
          const [cl, cr] = await readers[i].read(hi - lo);
          for (let s = 0; s < hi - lo; s += GAIN_BLOCK) {
            const g = clipGainAt(plan, i, (lo + s) / RATE);
            const end = Math.min(hi - lo, s + GAIN_BLOCK);
            for (let x = s; x < end; x++) {
              L[lo - A + x] += cl[x] * g;
              R[lo - A + x] += cr[x] * g;
            }
          }
          if (hi === clipSamples[i].end) readers[i].close();
        }
        for (let s = 0; s < n; s += GAIN_BLOCK) {
          const g = staticGainAt(plan, (A + s) / RATE) * 0.12;
          if (!g) continue;
          const end = Math.min(n, s + GAIN_BLOCK);
          for (let x = s; x < end; x++) {
            const hiss = (Math.random() * 2 - 1) * g;
            L[x] += hiss;
            R[x] += hiss;
          }
        }
        for (let x = 0; x < n; x++) {
          L[x] = Math.max(-1, Math.min(1, L[x]));
          R[x] = Math.max(-1, Math.min(1, R[x]));
        }
        const buf = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: RATE });
        buf.copyToChannel(L, 0);
        buf.copyToChannel(R, 1);
        await audioSource.add(buf);
      }
      onProgress?.(b / plan.total);
    }

    await output.finalize();
    return { duration: plan.total, width: W, height: H, fps };
  } catch (err) {
    if (output) await output.cancel().catch(() => {});
    throw err;
  } finally {
    readers.forEach(r => r?.close());
    iters.forEach(it => it?.return?.());
    inputs.forEach(i => { try { i.dispose(); } catch {} });
  }
}
