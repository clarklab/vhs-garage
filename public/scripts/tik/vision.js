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

export const MAX_ATTEMPTS = 3;
const CHECK_MAX_EDGE = 768;   // plenty for "is this the right scene", cheap to send
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

// Grab the frame for one slide, verifying and re-seeking as needed.
//
// Returns { bitmap, timecode, verified, attempts, reason } — always with a
// bitmap, so a caller can render a slide no matter how the check went. The
// verifier failing open is deliberate: a Claude outage should cost the second
// opinion, not the frame.
export async function grabVerifiedFrame(video, {
  timecode, durationSeconds, caption, grab = '', kind = 'trivia',
  maxAttempts = MAX_ATTEMPTS, onProgress = () => {},
}) {
  const dur = Math.max(1, Math.round(Number(durationSeconds) || video.duration || 0));
  let at = Math.min(dur, Math.max(0, Math.round(Number(timecode) || 0)));
  const tried = [];
  const seen = [];   // { bitmap, seconds, issue, reason }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onProgress(attempt === 1
      ? 'Grabbing the frame…'
      : `Checking a different shot (try ${attempt} of ${maxAttempts})…`);

    await seekAndSettle(video, at);
    let bitmap = await grabFrame(video);

    // Nudge off a blank frame before asking anyone's opinion. Cuts between
    // scenes and fades are common landing spots for a guessed timecode, and
    // they're recognisable locally — so step forward a couple of seconds
    // instead of burning one of three vision calls to be told it's black.
    for (let nudge = 0; nudge < BLANK_NUDGES && frameStats(bitmap).blank; nudge++) {
      const bumped = Math.min(dur, at + BLANK_NUDGE_SECONDS);
      if (bumped === at) break; // already at the end; nothing to nudge into
      onProgress('Skipping a blank frame…');
      bitmap.close?.();
      at = bumped;
      await seekAndSettle(video, at);
      bitmap = await grabFrame(video);
    }

    let verdict;
    try {
      verdict = await judge({
        imageBase64: await frameToBase64(bitmap),
        mediaType: 'image/jpeg',
        caption, grab, timecode: at, durationSeconds: dur, kind, attempt, tried,
      });
    } catch (e) {
      // Fail open: keep the frame we have and stop checking.
      console.warn('[tik] frame check unavailable, keeping the grabbed frame', { message: e.message });
      return { bitmap, timecode: at, verified: false, attempts: attempt, reason: e.message, degraded: true };
    }

    seen.push({ bitmap, seconds: at, issue: verdict.issue, reason: verdict.reason });

    if (verdict.ok) {
      return {
        bitmap, timecode: at, verified: !verdict.degraded, attempts: attempt,
        reason: verdict.reason, degraded: !!verdict.degraded,
      };
    }

    tried.push({ seconds: at, reason: verdict.reason || verdict.issue });
    const next = verdict.nextSeconds;
    if (!Number.isFinite(next) || attempt === maxAttempts) break;
    at = next;
  }

  // Nothing passed. Hand back the least-bad frame we saw and say so.
  const best = seen.slice().sort((a, b) => severity(a.issue) - severity(b.issue))[0];
  return {
    bitmap: best.bitmap,
    timecode: best.seconds,
    verified: false,
    attempts: seen.length,
    reason: best.reason || 'No frame passed the check.',
  };
}
