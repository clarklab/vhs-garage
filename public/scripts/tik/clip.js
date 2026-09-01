// Quote-a-long as a VIDEO instead of a slideshow.
//
// Same set, same matching: the quotes came from IMDb and the times came from
// the subtitle cues, so we already know where in the film every line is spoken.
// This cuts those spans out of the movie file — with a beat of padding either
// side so a line does not start mid-word — and stitches them into one 1080x1920
// clip with the film's own audio, topped and tailed by the title card and the
// sign-off the slideshow uses.
//
// The planning half is pure and unit-tested. The recording half is browser-only
// and deliberately dumb: there is no transcoding library here. The movie file
// never leaves the machine, so the cut is made by playing the spans into a
// canvas and recording that canvas — MediaRecorder does the encoding.

export const PAD_BEFORE = 1.2;   // seconds of run-up, so a line never starts mid-word
export const PAD_AFTER = 1.6;    // and a beat afterwards, so the delivery can land
export const MIN_SCENE = 2.5;
export const MAX_SCENE = 12;     // a runaway cue span is a bad match, not a long scene
export const GUESS_SCENE = 4.5;  // window for a line with no matched cue
export const STILL_SECONDS = 2.2;
export const CLIP_FPS = 30;
export const CLIP_VIDEO_BPS = 6_000_000;
export const CLIP_AUDIO_BPS = 128_000;
export const LONG_CLIP_SECONDS = 180; // past this, say so — nobody watches three minutes

// Number(null) is 0 and Number('') is 0, and a slide with no timecode taking
// that at face value would cut from the top of the film.
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Where in the film one quote slide's scene starts and ends.
//
// A matched cue gives both ends of the line. A bare timecode is the model's
// guess at where the line lands, so we hold a fixed window from there rather
// than pretending to know where it finishes.
export function sceneWindow(slide, { duration = 0, padBefore = PAD_BEFORE, padAfter = PAD_AFTER } = {}) {
  const cueStart = num(slide?.cue?.start);
  const cueEnd = num(slide?.cue?.end);
  const tc = num(slide?.timecode);
  let start;
  let end;
  if (cueStart !== null && cueEnd !== null && cueEnd > cueStart) {
    start = cueStart - padBefore;
    end = cueEnd + padAfter;
  } else if (tc !== null) {
    start = tc - padBefore;
    end = tc + GUESS_SCENE;
  } else {
    return null; // no time at all: nothing to cut
  }

  const limit = duration > 0 ? duration : Infinity;
  start = Math.max(0, start);
  end = Math.min(Math.max(end, start + MIN_SCENE), limit);
  // Clamped at the end of the film? Take the length out of the front instead.
  if (end - start < MIN_SCENE) start = Math.max(0, end - MIN_SCENE);
  if (end - start > MAX_SCENE) end = start + MAX_SCENE;
  if (!(end > start)) return null;
  return { start, end };
}

// The whole clip, part by part, in the order the set is in.
//
// isTitle/isOutro are passed in so this file needs no idea what a title slide
// looks like; app.js already owns those two questions.
export function planClip(slides, {
  duration = 0,
  isTitle = () => false,
  isOutro = () => false,
  still = STILL_SECONDS,
} = {}) {
  const parts = [];
  const skipped = [];
  const list = Array.isArray(slides) ? slides : [];

  for (const slide of list) {
    if (!slide) continue;
    if (isTitle(slide) || isOutro(slide)) {
      // The card slides have no scene behind them — they are held stills, cut
      // from the same composition the slideshow posts.
      parts.push({ kind: 'still', slideId: slide.id, seconds: Math.max(0.5, Number(still) || STILL_SECONDS) });
      continue;
    }
    const win = sceneWindow(slide, { duration });
    if (!win) {
      skipped.push({ slideId: slide.id, reason: 'no timecode' });
      continue;
    }
    parts.push({ kind: 'scene', slideId: slide.id, ...win });
  }

  const scenes = parts.filter((p) => p.kind === 'scene');
  const seconds = parts.reduce((t, p) => t + (p.kind === 'scene' ? p.end - p.start : p.seconds), 0);
  // Two quotes from the same exchange land on overlapping spans, which plays
  // the same footage twice under different captions. It is a real cut, not a
  // fault, so it is reported rather than silently merged away.
  let overlaps = 0;
  for (let i = 1; i < scenes.length; i++) {
    if (scenes[i].start < scenes[i - 1].end && scenes[i].start >= scenes[i - 1].start) overlaps++;
  }
  return { parts, seconds, scenes: scenes.length, skipped, overlaps, long: seconds > LONG_CLIP_SECONDS };
}

// What MediaRecorder should encode to.
//
// MP4 first: TikTok takes both, but an MP4 is the one a human can also drop
// into anything else. Chrome only grew MP4 recording recently, so WebM is the
// fallback and not an error.
export const CLIP_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickClipMime(isSupported, candidates = CLIP_MIME_CANDIDATES) {
  if (typeof isSupported !== 'function') return null;
  for (const type of candidates) {
    try { if (isSupported(type)) return type; } catch { /* a bad type is a no */ }
  }
  return null;
}

export function extensionForMime(mime) {
  return String(mime || '').includes('mp4') ? 'mp4' : 'webm';
}

// A human summary of the plan, for the button that is about to spend a minute
// of wall clock.
export function describePlan(plan) {
  if (!plan || !plan.parts.length) return '';
  const mmss = (s) => {
    const t = Math.round(s);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };
  const bits = [`${plan.scenes} scene${plan.scenes === 1 ? '' : 's'}`, mmss(plan.seconds)];
  if (plan.skipped.length) bits.push(`${plan.skipped.length} skipped (no timecode)`);
  return bits.join(' · ');
}

// ---- Recording (browser only) ----

// One audio graph per <video>, for the life of the page.
//
// The recorder needs the film's audio as a MediaStream, and it must be able to
// take it WITHOUT the whole movie blaring out of the speakers for the length of
// the render. Routing the element through WebAudio gives us both: the recorder
// taps `dest`, and `speaker` is what the user hears, turned down while
// recording and back up afterwards so the editor's own play button still works.
let graph = null;
export function movieAudio(video) {
  if (!video) return null;
  if (graph?.video === video) return graph;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) { console.warn('[tik] no WebAudio; the clip will be silent'); return null; }
  try {
    const ctx = new Ctx();
    const src = ctx.createMediaElementSource(video);
    const speaker = ctx.createGain();
    const dest = ctx.createMediaStreamDestination();
    src.connect(speaker);
    speaker.connect(ctx.destination);
    src.connect(dest);
    // Once an element is routed through WebAudio it stays routed, so a
    // suspended context would silence ordinary playback too.
    video.addEventListener('play', () => { ctx.resume().catch(() => {}); });
    graph = { video, ctx, speaker, dest };
    return graph;
  } catch (e) {
    console.error('[tik] could not tap the movie audio; the clip will be silent:', e);
    return null;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function seekTo(video, t) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (settled) return; settled = true; video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    try { video.currentTime = t; } catch { done(); }
    setTimeout(done, 4000); // a seek that never reports is not a reason to hang
  });
}

// Render the plan into one clip.
//
// paint(part) draws the current state onto `canvas` — the live video for a
// scene, the slide's own frame for a still. Keeping that out here means the
// clip looks exactly like the slideshow, because it IS the slideshow's compose
// code doing the drawing.
export async function recordClip({
  video, plan, canvas, paint,
  mimeType = null, fps = CLIP_FPS, onProgress = () => {}, signal = null,
} = {}) {
  if (!video || !plan?.parts?.length) throw new Error('Nothing to record.');
  const mime = mimeType || pickClipMime((t) => window.MediaRecorder?.isTypeSupported?.(t));
  if (!mime) throw new Error('This browser can’t record video.');

  const audio = movieAudio(video);
  await audio?.ctx.resume().catch(() => {});
  const stream = canvas.captureStream(fps);
  if (audio) for (const track of audio.dest.stream.getAudioTracks()) stream.addTrack(track);

  const rec = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: CLIP_VIDEO_BPS,
    audioBitsPerSecond: CLIP_AUDIO_BPS,
  });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { rec.onstop = resolve; });
  rec.onerror = (e) => console.error('[tik] recorder error:', e.error || e);

  const wasMuted = video.muted;
  const restore = () => {
    if (audio) audio.speaker.gain.value = 1;
    video.muted = wasMuted;
    try { video.pause(); } catch { /* already stopped */ }
    for (const t of stream.getVideoTracks()) t.stop();
  };
  if (audio) audio.speaker.gain.value = 0; // record it, don't blast it
  video.muted = false;                      // the graph, not the element, is the volume

  const aborted = () => signal?.aborted;
  let done = 0;
  const total = plan.parts.length;

  try {
    paint(plan.parts[0]);
    rec.start(1000);
    for (const part of plan.parts) {
      if (aborted()) break;
      done += 1;
      onProgress(`Recording ${done}/${total}…`);
      if (part.kind === 'still') {
        // A still needs no film: pause the film, hold the card, keep painting
        // so the canvas keeps feeding the stream.
        try { video.pause(); } catch { /* fine */ }
        const until = Date.now() + part.seconds * 1000;
        while (Date.now() < until && !aborted()) {
          paint(part);
          await wait(1000 / fps);
        }
        continue;
      }
      // A cut, not a dissolve: the recorder is paused across the seek so the
      // frozen frame and the silence never reach the file.
      if (rec.state === 'recording') rec.pause();
      await seekTo(video, part.start);
      if (aborted()) break;
      if (rec.state === 'paused') rec.resume();
      paint(part);
      await video.play().catch((e) => console.warn('[tik] play refused:', e));
      const hardStop = Date.now() + (part.end - part.start + 5) * 1000 * 2;
      while (video.currentTime < part.end && Date.now() < hardStop && !aborted()) {
        paint(part);
        await wait(1000 / fps);
      }
      try { video.pause(); } catch { /* fine */ }
    }
  } finally {
    if (rec.state !== 'inactive') rec.stop();
    await stopped;
    restore();
  }

  if (aborted()) throw Object.assign(new Error('Clip cancelled.'), { cancelled: true });
  const blob = new Blob(chunks, { type: mime });
  if (!blob.size) throw new Error('The recorder produced nothing — try again.');
  return { blob, mimeType: mime, extension: extensionForMime(mime) };
}
