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

// The fix-up command lives with its twin (the one for a file that will not
// open at all), so the Shoot page can offer it without dragging a recorder in.
export { ffmpegAacCommand, shellQuote } from './ffmpeg.js';

export const PAD_BEFORE = 1.2;   // seconds of run-up, so a line never starts mid-word
export const PAD_AFTER = 1.6;    // and a beat afterwards, so the delivery can land
export const MIN_SCENE = 2.5;
export const MAX_SCENE = 12;     // a runaway cue span is a bad match, not a long scene
export const GUESS_SCENE = 4.5;  // window for a line with no matched cue
export const STILL_SECONDS = 2.2;
export const TITLE_SCENE_SECONDS = 4;
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

// The title card's four seconds.
//
// It opens the post, and a frozen frame under a wordmark is a poster, not an
// opening — so it plays. Starting EXACTLY at the still means what runs is what
// was picked: the frame they chose, and then the next four seconds of it.
//
// A title slide with no timecode is a picture from somewhere else (a pasted
// image clears the timecode), and there is no footage to roll — that one stays
// a still.
export function titleWindow(slide, { duration = 0, seconds = TITLE_SCENE_SECONDS } = {}) {
  const tc = num(slide?.timecode);
  if (tc === null) return null;
  const want = Math.max(0.5, Number(seconds) || TITLE_SCENE_SECONDS);
  const limit = duration > 0 ? duration : Infinity;
  let start = Math.max(0, tc);
  let end = start + want;
  // Picked near the end of the film: back up so the four seconds still exist,
  // rather than opening the post on a half-second of black.
  if (end > limit) {
    end = limit;
    start = Math.max(0, end - want);
  }
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
    const holdStill = () => parts.push({
      kind: 'still',
      slideId: slide.id,
      seconds: Math.max(0.5, Number(still) || STILL_SECONDS),
    });
    if (isOutro(slide)) {
      // The sign-off is the logo, not a frame of the film: nothing to roll.
      holdStill();
      continue;
    }
    if (isTitle(slide)) {
      // The opening plays from the frame that was picked. Same composition —
      // wordmark where they put it, caption where it was — just moving.
      const opener = titleWindow(slide, { duration });
      if (opener) parts.push({ kind: 'scene', slideId: slide.id, title: true, ...opener });
      else holdStill();
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
    // An analyser on the SOURCE side, so after a render we can say whether the
    // film was making any sound at all. That is the one question worth being
    // able to answer: a silent clip is either a film whose audio this browser
    // cannot decode, or a fault in here, and guessing between the two from a
    // finished file is miserable.
    const meter = ctx.createAnalyser();
    meter.fftSize = 2048;
    src.connect(speaker);
    speaker.connect(ctx.destination);
    src.connect(dest);
    src.connect(meter);
    // Once an element is routed through WebAudio it stays routed, so a
    // suspended context would silence ordinary playback too.
    video.addEventListener('play', () => { ctx.resume().catch(() => {}); });
    graph = { video, ctx, speaker, dest, meter };
    return graph;
  } catch (e) {
    console.error('[tik] could not tap the movie audio; the clip will be silent:', e);
    return null;
  }
}

// Below this, call it silence: dither and encoder noise live down here.
export const SILENCE_PEAK = 0.005;

// Loudest sample the meter has seen since the last look.
function peakNow(meter, scratch) {
  if (!meter) return 0;
  meter.getFloatTimeDomainData(scratch);
  let peak = 0;
  for (let i = 0; i < scratch.length; i++) {
    const a = Math.abs(scratch[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

// Does this browser decode the film's audio at all?
//
// Answered by playing a moment of it MUTED and watching the decoder's byte
// counter. Muted playback needs no user gesture and makes no sound, and the
// counter counts decoding rather than loudness — so a stretch of silence still
// registers, and only an audio track the browser cannot decode reads as zero.
// The playhead is put back where it was.
//
// Returns 'yes' | 'no' | 'unknown' ('unknown' when the browser keeps no such
// counter, which is not the same as "no audio").
export async function probeFilmAudio(video, { ms = 450 } = {}) {
  if (!video || video.readyState < 2) return 'unknown';
  if (typeof video.webkitAudioDecodedByteCount !== 'number') return 'unknown';
  const wasMuted = video.muted;
  const wasTime = video.currentTime;
  const wasPaused = video.paused;
  const before = video.webkitAudioDecodedByteCount;
  try {
    video.muted = true;
    await video.play();
    await new Promise((r) => setTimeout(r, ms));
  } catch (e) {
    console.warn('[tik] could not probe the film for audio:', e);
    return 'unknown';
  } finally {
    if (wasPaused) { try { video.pause(); } catch { /* fine */ } }
    try { video.currentTime = wasTime; } catch { /* fine */ }
    video.muted = wasMuted;
  }
  const decoded = video.webkitAudioDecodedByteCount - before;
  if (decoded > 0) return 'yes';
  console.warn('[tik] this film decoded no audio in this browser; a clip cut from it will be silent', {
    // The usual cause, and the one worth naming in the log for later.
    likely: 'AC-3 / E-AC-3 / DTS audio, which Chrome does not decode',
  });
  return 'no';
}

// The line to show when a film will not give up its audio.
export const NO_FILM_AUDIO_NOTE =
  'Heads up: this browser decodes no audio from this film, so a clip cut from it will be silent — '
  + 'the audio track is almost certainly AC-3, E-AC-3 or DTS, which Chrome can’t play even though the '
  + 'film has perfectly good sound elsewhere. A copy with AAC audio records fine.';

// Can this browser decode the film's audio at all?
//
// Most movie rips carry AC-3, E-AC-3 or DTS, and Chrome decodes none of them:
// the picture plays and the film is simply silent, in the editor and therefore
// in the clip. `webkitAudioDecodedByteCount` is the honest witness — it counts
// bytes the audio decoder actually consumed, and it stays at zero when there is
// nothing it can decode.
export function audioDecoding(video) {
  const n = video?.webkitAudioDecodedByteCount;
  if (typeof n !== 'number') return null; // browser won't say; not the same as "no"
  return n > 0;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function seekTo(video, t) {
  // Already there: setting currentTime to where it already is fires no 'seeked'
  // in some browsers, which would then sit out the whole timeout below.
  if (Math.abs(video.currentTime - t) < 0.05 && !video.seeking) return Promise.resolve();
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
  // What the film was actually making while we recorded it. Stills are silent
  // by design (the film is paused), so only scenes are measured.
  const scratch = audio?.meter ? new Float32Array(audio.meter.fftSize) : null;
  let audioPeak = 0;
  const decodedBefore = video.webkitAudioDecodedByteCount;

  try {
    // Park on the first part's own footage BEFORE the recorder starts. Painting
    // first and seeking afterwards opened the clip on a frame or two of
    // wherever the playhead happened to be sitting — which, now that the title
    // card plays, is the very first thing anyone sees.
    if (plan.parts[0].kind === 'scene') {
      onProgress('Cueing up…');
      await seekTo(video, plan.parts[0].start);
    }
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
        if (scratch) audioPeak = Math.max(audioPeak, peakNow(audio.meter, scratch));
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

  const decoded = typeof video.webkitAudioDecodedByteCount === 'number'
    ? video.webkitAudioDecodedByteCount - decodedBefore
    : null;
  const sound = !audio ? 'untapped' : audioPeak > SILENCE_PEAK ? 'recorded' : 'silent';
  if (sound === 'silent') {
    // Worth a log line: this is the difference between "the film has no audio
    // this browser can decode" and "we broke the tap", and the counter says
    // which. Nothing decoded at all is the film, every time.
    console.warn('[tik] the clip came out silent', { audioPeak, audioBytesDecoded: decoded, mime });
  }
  return {
    blob,
    mimeType: mime,
    extension: extensionForMime(mime),
    sound,                                  // 'recorded' | 'silent' | 'untapped'
    audioPeak,
    filmDecodedAudio: decoded === null ? null : decoded > 0,
  };
}

// What to tell someone whose clip came out silent.
//
// Two very different situations wearing the same face, and the byte counter
// tells them apart: a film whose audio track this browser cannot decode (most
// rips are AC-3, E-AC-3 or DTS, and Chrome decodes none of them — the picture
// plays and the film is simply silent, in the editor too), versus a film that
// IS decoding and still came out silent, which is ours to fix.
export function silenceReason({ sound, filmDecodedAudio } = {}) {
  if (sound === 'recorded') return '';
  if (sound === 'untapped') return 'The film’s audio couldn’t be tapped in this browser, so the clip is silent.';
  if (filmDecodedAudio === false) {
    return 'The clip is silent because this browser decoded no audio from the film — most rips use AC-3 or DTS, which Chrome can’t play. The editor’s own play button will be silent too. A copy with AAC audio fixes it.';
  }
  if (filmDecodedAudio === true) {
    return 'The clip is silent even though the film is decoding audio — check the film isn’t muted or silent over these exact scenes, then say so, because that one is a bug.';
  }
  return 'The clip came out silent — check that the film plays with sound in the editor.';
}
