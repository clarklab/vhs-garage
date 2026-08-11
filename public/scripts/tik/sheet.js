// Where to grab the frames for one contact sheet.
//
// The frame checker used to see one frame per call: it was told "that's the
// credits", suggested a new timecode sight-unseen, and the client re-grabbed
// blind. Three round trips, three guesses, and often three misses. Seeking a
// loaded <video> is cheap and a model call is not, so we grab a spread of the
// film and let the checker choose between shots it can actually see.
//
// This module owns the sampling because the browser owns the <video>. The
// server keeps matching SHEET_SIZE / MAX_ROUNDS constants for its prompt and
// its request cap; a test asserts the two never drift apart.
//
// Pure — no DOM, no network. Unit-tested under node:test.

export const SHEET_SIZE = 6;      // frames per call
export const MAX_ROUNDS = 2;      // sheets per slide; 12 frames seen, 2 calls made
const MIN_GAP_SECONDS = 4;        // closer than this re-grabs the same shot

// Offsets from the guessed timecode, in seconds, densest first.
//
// Deliberately not an even spread. Autopilot's guess is a real signal, so three
// frames stay within ~40s of it and the rest fan out across roughly eight
// minutes of runtime. An even spread over the same window would put nothing
// near the one place we have any reason to believe in.
export const SHEET_OFFSETS = [0, 40, -40, 110, -110, 240];

// → an ordered list of seconds to grab. Clamped into the film, deduped, and
// never within MIN_GAP_SECONDS of something already shown: re-grabbing a shot
// we already rejected is how the old loop wasted its attempts.
export function sheetSeconds({ center, durationSeconds, tried = [], size = SHEET_SIZE } = {}) {
  const dur = Math.max(1, Math.round(Number(durationSeconds) || 0));
  const mid = Math.min(dur, Math.max(0, Math.round(Number(center) || 0)));
  const want = Math.max(1, Math.round(Number(size) || SHEET_SIZE));
  const seen = (Array.isArray(tried) ? tried : [])
    .map((t) => Math.round(Number(t?.seconds ?? t)))
    .filter((n) => Number.isFinite(n));

  const out = [];
  const isNew = (s) => [...seen, ...out].every((t) => Math.abs(t - s) >= MIN_GAP_SECONDS);
  const push = (s) => {
    const v = Math.min(dur, Math.max(0, Math.round(s)));
    if (isNew(v)) out.push(v);
  };

  for (const off of SHEET_OFFSETS) {
    if (out.length >= want) break;
    push(mid + off);
  }
  // A guess near either end collapses several offsets onto each other. Sweep
  // the whole film rather than handing back a short sheet.
  const stride = Math.max(MIN_GAP_SECONDS, Math.round(dur / (want + 1)));
  for (let step = 1; out.length < want && step <= want * 4; step++) {
    push(mid + step * stride);
    if (out.length < want) push(mid - step * stride);
  }
  return out.slice(0, want);
}
