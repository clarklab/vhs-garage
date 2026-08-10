// The screenshot verifier's prompt and verdict handling.
//
// Autopilot guesses a timecode from the caption alone, which means it is
// guessing where in a two-hour film a moment lives without ever seeing the
// film. Often it lands on black, on the credits, or three scenes early. This
// closes that loop: grab the frame, show it to Claude alongside the caption it
// is supposed to illustrate, and let it say "wrong, try 400 seconds later".
//
// Pure — no network, no DOM. The endpoint does the calling, the client does
// the seeking. Unit-tested.

export const MAX_ATTEMPTS = 3;
const MIN_GAP_SECONDS = 4;   // a suggestion closer than this re-grabs the same shot
import { clampText } from './autopilot.mjs';

const REASON_MAX = 200;

// Why a frame was rejected. Kept as a closed set so the UI can show an icon and
// the fallback probe can reason about direction without parsing prose.
export const ISSUES = ['ok', 'black', 'credits', 'transition', 'wrong-scene', 'no-subject', 'unclear'];

export function buildVisionPrompt({
  caption, grab = '', timecode, durationSeconds, kind = 'trivia',
  attempt = 1, maxAttempts = MAX_ATTEMPTS, tried = [],
}) {
  const dur = Math.max(1, Math.round(Number(durationSeconds) || 0));
  const at = Math.max(0, Math.round(Number(timecode) || 0));
  const pct = Math.round((at / dur) * 100);

  const historyBlock = tried.length
    ? `\n\nAlready tried, do NOT suggest these again:\n${tried
        .map((t) => `- ${Math.round(t.seconds)}s: ${t.reason || 'rejected'}`).join('\n')}`
    : '';

  const goal = kind === 'title'
    ? `This frame is meant to be the film's TITLE CARD — the main-title logo shot. A good frame shows the film's title on screen.`
    : `This frame is meant to illustrate a trivia caption on a slideshow. A good frame is a clear, well-lit shot of the moment, scene, person, or prop the caption is about. The viewer reads the caption while looking at this image, so it has to support it.`;

  return `You are checking whether a frame grabbed from a movie is the right image for a slide.

${goal}

<caption>${String(caption || '').trim()}</caption>
${grab ? `<shot_wanted>${String(grab).trim()}</shot_wanted>\n` : ''}
The frame above was grabbed at ${at} seconds (${pct}% through a ${dur}-second film). This is attempt ${attempt} of ${maxAttempts}.

Reject the frame if ANY of these are true:
- It is essentially black, blank, or a single flat colour.
- It is opening or closing CREDITS, a text card, or a studio logo (unless a title card is what was wanted).
- It is caught mid-cut, mid-fade, or motion-blurred into mush.
- It shows a different scene than the caption describes.
- The person, prop, or detail the caption is about is not visible in it.

Accept the frame if it is a clean, readable shot that a viewer would accept as illustrating the caption. It does NOT have to be the exact instant, and the subject does not have to be centred. Do not reject a perfectly good shot for being imperfect: you get ${maxAttempts} tries and a merely-decent frame beats running out of attempts.

If you reject it, suggest where to look instead as a whole number of seconds between 0 and ${dur}. Use what you can see to steer: if this looks like a later part of the film than the caption describes, go earlier, and vice versa. Move a meaningful distance, at least 30 seconds, since a few seconds away is the same shot.${historyBlock}

Return ONLY valid JSON in this exact shape, nothing else:
{
  "ok": true,
  "issue": "one of: ${ISSUES.join(', ')}",
  "reason": "one short sentence on what you actually see in the frame",
  "suggestSeconds": null,
  "confidence": 0.0
}`;
}

// The model's reply → a verdict we can act on. Anything unparseable becomes a
// low-confidence accept: a broken verifier must not throw away a frame that
// might be fine, and it must never strand the caller with no frame at all.
export function normalizeVerdict(raw, durationSeconds) {
  const dur = Math.max(0, Math.round(Number(durationSeconds) || 0));
  if (!raw || typeof raw !== 'object') {
    return { ok: true, issue: 'unclear', reason: 'Verifier returned nothing usable.', suggestSeconds: null, confidence: 0 };
  }
  const ok = raw.ok === true || raw.ok === 'true';
  const issue = ISSUES.includes(raw.issue) ? raw.issue : (ok ? 'ok' : 'unclear');
  const reason = clampText(raw.reason, REASON_MAX);

  let suggest = Number(raw.suggestSeconds);
  if (!Number.isFinite(suggest) || ok) suggest = null;
  else suggest = Math.min(dur, Math.max(0, Math.round(suggest)));

  let confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence)) confidence = ok ? 0.5 : 0.5;
  confidence = Math.min(1, Math.max(0, confidence));

  return { ok, issue, reason, suggestSeconds: suggest, confidence };
}

// Where to grab next. The model's suggestion wins when it is usable, but it
// gets vetoed when it would land us back on a frame we already rejected —
// without this the loop happily burns all three attempts re-grabbing the same
// shot, which is exactly the failure it exists to prevent.
//
// The fallback walks the film in even strides from the original guess,
// alternating later/earlier, so three attempts actually sample three different
// parts of the runtime. Returns null when there is nowhere new left to look.
export function nextAttemptSeconds(verdict, { current, durationSeconds, tried = [], attempt = 1 }) {
  const dur = Math.max(1, Math.round(Number(durationSeconds) || 0));
  const seen = [...tried.map((t) => Math.round(Number(t.seconds ?? t))), Math.round(Number(current) || 0)]
    .filter((n) => Number.isFinite(n));
  const isNew = (s) => s >= 0 && s <= dur && seen.every((t) => Math.abs(t - s) >= MIN_GAP_SECONDS);

  const suggested = verdict?.suggestSeconds;
  if (Number.isFinite(suggested) && isNew(suggested)) return suggested;

  // Fallback probe: stride out from the first guess, flipping side each time.
  const base = seen[0] ?? Math.round(Number(current) || 0);
  const stride = Math.max(45, Math.round(dur * 0.08));
  for (let step = attempt; step <= attempt + 6; step++) {
    for (const dir of [1, -1]) {
      const candidate = base + dir * stride * step;
      const clamped = Math.min(dur, Math.max(0, candidate));
      if (isNew(clamped)) return clamped;
    }
  }
  return null;
}
