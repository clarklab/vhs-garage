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
import { CHANNEL_CHANGE_SECONDS, createStaticPainter, playStaticNoise } from './tv-static.js';

export const PAD_BEFORE = 1.2;   // seconds of run-up, so a line never starts mid-word
export const PAD_AFTER = 1.6;    // and a beat afterwards, so the delivery can land
export const MIN_SCENE = 2.5;
export const MAX_SCENE = 12;     // a runaway cue span is a bad match, not a long scene
export const MAX_MATCHED_SCENE = 45; // keep complete, bounded dialogue spans
export const MIN_TRIMMED_SCENE = 0.5;
export const GUESS_SCENE = 4.5;  // window for a line with no matched cue
export const STILL_SECONDS = 2.2;
export const TITLE_SCENE_SECONDS = 4;
export const CLIP_FPS = 30;
export const CLIP_VIDEO_BPS = 6_000_000;
export const CLIP_AUDIO_BPS = 128_000;
export const TRIM_STEP = 1;        // one tap of a nudge button, in seconds
export const TRIM_LIMIT = 30;      // as far as a single scene can be stretched either way
export const LONG_CLIP_SECONDS = 180; // past this, say so — nobody watches three minutes

// Number(null) is 0 and Number('') is 0, and a slide with no timecode taking
// that at face value would cut from the top of the film.
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// A hand trim on one scene: seconds ADDED before its start and after its end.
//
// Stored as deltas rather than absolute times, so a scene keeps the adjustment
// when the line is re-matched to its cue — and so "give me two more seconds at
// the end" survives the quote text changing underneath it.
export function trimOf(slide) {
  const n = (v) => {
    const x = Number(v);
    if (!Number.isFinite(x)) return 0;
    return Math.min(TRIM_LIMIT, Math.max(-TRIM_LIMIT, x));
  };
  return { before: n(slide?.trim?.before), after: n(slide?.trim?.after) };
}

// One tap of a nudge button. `edge` is 'before' or 'after'; `dir` is +1 to give
// the scene more film and -1 to take some back.
export function nudgeTrim(slide, edge, dir, step = TRIM_STEP) {
  const trim = trimOf(slide);
  if (!['before', 'after'].includes(edge) || !Number.isFinite(step) || step <= 0) return trim;
  const key = edge === 'before' ? 'before' : 'after';
  const next = trim[key] + (dir >= 0 ? step : -step);
  return { ...trim, [key]: Math.min(TRIM_LIMIT, Math.max(-TRIM_LIMIT, next)) };
}

export function isTrimmed(slide) {
  const t = trimOf(slide);
  return t.before !== 0 || t.after !== 0;
}

export function describeTrim(slide) {
  const t = trimOf(slide);
  if (!t.before && !t.after) return '';
  const bit = (n, word) => (n ? `${n > 0 ? '+' : ''}${n}s ${word}` : '');
  return [bit(t.before, 'in'), bit(t.after, 'out')].filter(Boolean).join(', ');
}

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
  const matched = cueStart !== null && cueEnd !== null && cueStart >= 0 && cueEnd > cueStart;
  if (matched) {
    start = cueStart - padBefore;
    end = cueEnd + padAfter;
    // Use the available gap; automatic padding should not include the next
    // line of dialogue. Hand trims below can deliberately override this.
    const previousEnd = num(slide.cue.previousEnd);
    const nextStart = num(slide.cue.nextStart);
    if (previousEnd !== null) start = Math.max(start, Math.min(cueStart, previousEnd + 0.08));
    if (nextStart !== null) end = Math.min(end, Math.max(cueEnd, nextStart - 0.08));
  } else if (tc !== null) {
    start = tc - padBefore;
    end = tc + GUESS_SCENE;
  } else {
    return null; // no time at all: nothing to cut
  }

  const limit = duration > 0 ? duration : Infinity;
  if (start >= limit || (matched && cueStart >= limit)) return null;
  start = Math.max(0, start);
  // A legitimate exchange can exceed twelve seconds. Only unbounded legacy
  // spans use the old safety cap, which must not chop a matched last line.
  if (!matched || cueEnd - cueStart > MAX_MATCHED_SCENE) end = Math.min(end, start + MAX_SCENE);
  const minimum = matched && (num(slide.cue.previousEnd) !== null || num(slide.cue.nextStart) !== null)
    ? Math.min(MIN_SCENE, end - start) : MIN_SCENE;
  end = Math.min(Math.max(end, start + minimum), limit);
  // Clamped at the end of the film? Take the length out of the front instead.
  if (end - start < minimum) start = Math.max(0, end - minimum);
  // Apply trims to the finished automatic window, so every half-second tap
  // moves the requested edge by half a second, including capped legacy spans.
  const trim = trimOf(slide);
  start = Math.min(Math.max(0, start - trim.before), Math.max(0, end - MIN_TRIMMED_SCENE));
  end = Math.min(limit, Math.max(start + MIN_TRIMMED_SCENE, end + trim.after));
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
  const trim = trimOf(slide);
  const base = Math.max(0.5, Number(seconds) || TITLE_SCENE_SECONDS);
  const limit = duration > 0 ? duration : Infinity;
  if (tc >= limit) return null;
  // Both ends move outward from the picked frame: nudging the start earlier
  // must ADD film, not slide the same four seconds backwards.
  let start = Math.max(0, tc);
  let end = start + base;
  // Picked near the end of the film: back up so the length still exists,
  // rather than opening the post on a half-second of black.
  if (end > limit) {
    end = limit;
    start = Math.max(0, end - base);
  }
  start = Math.min(Math.max(0, start - trim.before), Math.max(0, end - MIN_TRIMMED_SCENE));
  end = Math.min(limit, Math.max(start + MIN_TRIMMED_SCENE, end + trim.after));
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
  // Each cut gets a quarter-second channel change, including the title and
  // sign-off. Insert only after skipped slides are removed: never bookend the
  // video with static or leave two bursts together where a quote was skipped.
  const timeline = parts.flatMap((part, i) => i
    ? [{ kind: 'static', seconds: CHANNEL_CHANGE_SECONDS }, part] : [part]);
  const seconds = timeline.reduce((t, p) => t + (p.kind === 'scene' ? p.end - p.start : p.seconds), 0);
  // Two quotes from the same exchange land on overlapping spans, which plays
  // the same footage twice under different captions. It is a real cut, not a
  // fault, so it is reported rather than silently merged away.
  let overlaps = 0;
  for (let i = 1; i < scenes.length; i++) {
    if (scenes[i].start < scenes[i - 1].end && scenes[i].start >= scenes[i - 1].start) overlaps++;
  }
  return { parts: timeline, seconds, scenes: scenes.length, skipped, overlaps, long: seconds > LONG_CLIP_SECONDS };
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
  'Heads up: this browser decodes no audio from this film, so the movie scenes in a clip will be silent — '
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
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); video.removeEventListener('seeked', done); };
    const done = () => {
      cleanup();
      if (Math.abs(video.currentTime - t) > 0.1) reject(new Error('The film did not seek to the requested scene.'));
      else resolve();
    };
    const timer = setTimeout(() => {
      cleanup(); reject(new Error('The film took too long to seek. Try a browser-compatible copy.'));
    }, 4000);
    video.addEventListener('seeked', done);
    try { video.currentTime = t; } catch (error) { cleanup(); reject(error); }
  });
}

async function playForClip(video, signal) {
  let timer, cancel;
  try {
    await Promise.race([
      video.play(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('The film took too long to start playback.')), 5000);
        cancel = () => reject(Object.assign(new Error('Clip cancelled.'), { cancelled: true }));
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (cancel) signal?.removeEventListener('abort', cancel);
  }
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
  const wasRate = video.playbackRate;
  const restore = () => {
    if (audio) audio.speaker.gain.value = 1;
    video.muted = wasMuted;
    video.playbackRate = wasRate;
    try { video.pause(); } catch { /* already stopped */ }
    for (const t of stream.getVideoTracks()) t.stop();
  };
  if (audio) audio.speaker.gain.value = 0; // record it, don't blast it
  video.muted = false;                      // the graph, not the element, is the volume
  video.playbackRate = 1;

  const aborted = () => signal?.aborted;
  let done = 0;
  const total = plan.parts.filter((p) => p.kind !== 'static').length;
  let paintStatic;
  // What the film was actually making while we recorded it. Stills are silent
  // by design (the film is paused), so only scenes are measured.
  const scratch = audio?.meter ? new Float32Array(audio.meter.fftSize) : null;
  let audioPeak = 0;
  const decodedBefore = video.webkitAudioDecodedByteCount;

  try {
    video.pause();
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
      if (part.kind === 'static') {
        video.pause();
        paintStatic ||= createStaticPainter(canvas);
        paintStatic();
        if (rec.state === 'paused') rec.resume();
        const stopNoise = playStaticNoise(audio, part.seconds);
        const until = performance.now() + part.seconds * 1000;
        try {
          while (performance.now() < until && !aborted()) {
            paintStatic();
            await wait(Math.min(1000 / fps, Math.max(0, until - performance.now())));
          }
        } finally {
          stopNoise();
          // Seeking the next scene must not stretch the static burst.
          if (rec.state === 'recording') rec.pause();
        }
        continue;
      }
      done += 1;
      onProgress(`Recording ${done}/${total}…`);
      if (part.kind === 'still') {
        // A still needs no film: pause the film, hold the card, keep painting
        // so the canvas keeps feeding the stream.
        try { video.pause(); } catch { /* fine */ }
        paint(part);
        if (rec.state === 'paused') rec.resume();
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
      paint(part);
      // Do not record startup latency or buffering as extra footage.
      // A refused play must fail rather than producing a frozen scene.
      await playForClip(video, signal);
      if (rec.state === 'paused') rec.resume();
      const onWaiting = () => { if (rec.state === 'recording') rec.pause(); };
      const onPlaying = () => { if (rec.state === 'paused' && !aborted()) rec.resume(); };
      video.addEventListener('waiting', onWaiting);
      video.addEventListener('playing', onPlaying);
      let lastTime = video.currentTime;
      let lastAdvance = Date.now();
      try {
        while (video.currentTime < part.end && !aborted()) {
          if (video.ended) {
            if (part.end - video.currentTime > 0.1) throw new Error('The film ended before this scene finished.');
            break;
          }
          if (video.currentTime > lastTime) { lastTime = video.currentTime; lastAdvance = Date.now(); }
          else if (Date.now() - lastAdvance > 5000) throw new Error('Playback stalled while recording. Try rendering again.');
          paint(part);
          if (scratch) audioPeak = Math.max(audioPeak, peakNow(audio.meter, scratch));
          await wait(1000 / fps);
        }
      } finally {
        video.removeEventListener('waiting', onWaiting);
        video.removeEventListener('playing', onPlaying);
        try { video.pause(); } catch { /* fine */ }
      }
    }
  } finally {
    if (rec.state !== 'inactive') { rec.stop(); await stopped; }
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
    console.warn('[tik] the clip’s movie audio came out silent', { audioPeak, audioBytesDecoded: decoded, mime });
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
    return 'The movie scenes are silent because this browser decoded no audio from the film — most rips use AC-3 or DTS, which Chrome can’t play. The editor’s own play button will be silent too. A copy with AAC audio fixes it.';
  }
  if (filmDecodedAudio === true) {
    return 'The movie scenes are silent even though the film is decoding audio — check the film isn’t muted or silent over these exact scenes, then say so, because that one is a bug.';
  }
  return 'The movie scenes came out silent — check that the film plays with sound in the editor.';
}
