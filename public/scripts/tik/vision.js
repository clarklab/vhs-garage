// The grab → judge → adjust loop, browser side.
//
// Autopilot picks a timecode from the caption alone, never having seen the
// film. This grabs that frame, shows it to Claude, and re-seeks when the answer
// is "that's the credits" or "wrong scene" — up to MAX_ATTEMPTS times, then
// keeps the best frame it saw.
//
// Runs in assisted and batch modes only. Plain autopilot stays fast and free
// because you are already looking at the result and can scrub it yourself.

import { seekAndSettle, grabFrame } from './capture.js';
import { sheetSeconds, MAX_ROUNDS } from './sheet.js';

export const MAX_ATTEMPTS = 3;
// Six frames per call instead of one: smaller each, but the model is choosing
// between shots it can see rather than guessing at one it cannot.
const CHECK_MAX_EDGE = 560;   // plenty for "is this the right scene", cheap to send
const CHECK_QUALITY = 0.8;
const BLANK_NUDGES = 4;         // local hops off a black/flat frame per attempt
const BLANK_NUDGE_SECONDS = 3;  // far enough to clear a cut or a fade

// How salvageable each rejection is, worst last. When every attempt fails we
// keep the least-bad frame: a real shot of the wrong scene still beats a black
// frame, and the user can scrub from something rather than nothing.
const ISSUE_RANK = ['ok', 'unclear', 'no-subject', 'wrong-scene', 'transition', 'credits', 'black'];
const severity = (issue) => {
  const i = ISSUE_RANK.indexOf(issue);
  return i === -1 ? ISSUE_RANK.length : i;
};

// Cheap local read of a frame: mean brightness and contrast, on a tiny
// downscale. Catches the failures that don't need an opinion — a black frame
// between scenes, a fade, a flat wall — before spending a vision call on them.
// Returns { mean, spread, blank } on 0–255.
export function frameStats(bitmap) {
  const w = 32;
  const h = Math.max(1, Math.round((bitmap.height / bitmap.width) * w)) || 18;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  let sum = 0;
  let sumSq = 0;
  const n = w * h;
  for (let i = 0; i < data.length; i += 4) {
    // Rec. 601 luma is plenty for "is anything happening in this frame".
    const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += y;
    sumSq += y * y;
  }
  const mean = sum / n;
  const spread = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  // Thresholds are deliberately timid: a genuinely dark but real shot (night
  // exteriors, a lit face on black) has spread well above 10. Only near-total
  // black or a flat single-colour card trips this.
  const blank = (mean < 10 && spread < 12) || spread < 6;
  return { mean, spread, blank };
}

// Shrink a grabbed frame down to something worth sending over the wire and
// return it as bare base64 (no data: prefix).
export async function frameToBase64(bitmap, maxEdge = CHECK_MAX_EDGE, quality = CHECK_QUALITY) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('Could not encode the frame for checking.');
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function judge(payload) {
  const res = await fetch('/.netlify/functions/tik-vision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    // A hung check must not stall a whole batch run. On timeout this throws,
    // the caller's fail-open catch keeps the grabbed frame, and the run
    // moves on — costing the second opinion, not the slide.
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`Frame check failed (${res.status})`);
  return res.json();
}

// Grab one frame at `at`, nudging off a blank if we land on a cut or a fade.
// Local brightness/contrast catches those without spending a model call.
async function grabAt(video, at, dur, onProgress) {
  let seconds = Math.min(dur, Math.max(0, Math.round(at)));
  await seekAndSettle(video, seconds);
  let bitmap = await grabFrame(video);
  for (let nudge = 0; nudge < BLANK_NUDGES && frameStats(bitmap).blank; nudge++) {
    const bumped = Math.min(dur, seconds + BLANK_NUDGE_SECONDS);
    if (bumped === seconds) break; // already at the end; nothing to nudge into
    onProgress('Skipping a blank frame…');
    bitmap.close?.();
    seconds = bumped;
    await seekAndSettle(video, seconds);
    bitmap = await grabFrame(video);
  }
  return { bitmap, seconds };
}

// Grab the frame for one slide by showing the checker a spread of the film.
//
// The old loop sent one frame, was told "try 400 seconds later", and re-grabbed
// blind — three round trips, three guesses, and often three misses. This grabs
// SHEET_SIZE frames around the guess (seeking is cheap; the model call is not),
// sends them together, and lets the checker pick the best one it can actually
// see. Only when every frame is ruled out does it fall back to a suggestion,
// and then it sends another sheet centred there.
//
// Returns { bitmap, timecode, verified, attempts, reason } — always with a
// bitmap, so a caller can render a slide no matter how the check went.
export async function grabVerifiedFrame(video, {
  timecode, durationSeconds, caption, grab = '', kind = 'trivia',
  maxRounds = MAX_ROUNDS, onProgress = () => {},
}) {
  const dur = Math.max(1, Math.round(Number(durationSeconds) || video.duration || 0));
  let center = Math.min(dur, Math.max(0, Math.round(Number(timecode) || 0)));
  const tried = [];
  const seen = [];   // { bitmap, seconds, issue, reason } — every frame we grabbed
  let grabbed = 0;

  for (let round = 1; round <= maxRounds; round++) {
    const wanted = sheetSeconds({ center, durationSeconds: dur, tried });
    if (!wanted.length) break;

    const shots = [];
    for (const [i, at] of wanted.entries()) {
      onProgress(round === 1
        ? `Grabbing frame ${i + 1} of ${wanted.length}…`
        : `Looking further out — frame ${i + 1} of ${wanted.length}…`);
      shots.push(await grabAt(video, at, dur, onProgress));
    }
    grabbed += shots.length;

    let verdict;
    try {
      onProgress(`Checking ${shots.length} frames…`);
      verdict = await judge({
        frames: await Promise.all(shots.map(async (s) => ({
          base64: await frameToBase64(s.bitmap),
          mediaType: 'image/jpeg',
          seconds: s.seconds,
        }))),
        caption, grab, durationSeconds: dur, kind, round, tried,
      });
    } catch (e) {
      // Fail open on the frame sitting closest to autopilot's own guess.
      console.warn('[tik] frame check unavailable, keeping the first frame', { message: e.message });
      shots.slice(1).forEach((s) => s.bitmap.close?.());
      return {
        bitmap: shots[0].bitmap, timecode: shots[0].seconds, verified: false,
        attempts: grabbed, reason: e.message, degraded: true,
      };
    }

    const picked = Number.isInteger(verdict.pick) ? shots[verdict.pick] : null;
    if (picked) {
      shots.forEach((s) => { if (s !== picked) s.bitmap.close?.(); });
      return {
        bitmap: picked.bitmap, timecode: picked.seconds, verified: !verdict.degraded,
        attempts: grabbed, reason: verdict.reason, degraded: !!verdict.degraded,
      };
    }

    // Whole sheet rejected: remember it so the next one looks somewhere new.
    shots.forEach((s) => {
      seen.push({ bitmap: s.bitmap, seconds: s.seconds, issue: verdict.issue, reason: verdict.reason });
      tried.push({ seconds: s.seconds, reason: verdict.issue || 'rejected' });
    });
    const next = verdict.suggestSeconds;
    if (!Number.isFinite(next) || round === maxRounds) break;
    center = next;
  }

  // Nothing passed. Hand back the least-bad frame we saw and say so.
  const best = seen.slice().sort((a, b) => severity(a.issue) - severity(b.issue))[0];
  if (!best) throw new Error('Could not grab any frame for this slide.');
  seen.forEach((s) => { if (s !== best) s.bitmap.close?.(); });
  return {
    bitmap: best.bitmap,
    timecode: best.seconds,
    verified: false,
    attempts: grabbed,
    reason: best.reason || 'No frame passed the check.',
  };
}
