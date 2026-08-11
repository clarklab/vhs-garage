// The screenshot verifier's prompt and verdict handling.
//
// Autopilot guesses a timecode from the caption alone, which means it is
// guessing where in a two-hour film a moment lives without ever seeing the
// film. Often it lands on black, on the credits, or three scenes early.
//
// Pure — no network, no DOM. The endpoint does the calling; public/scripts/tik/
// sheet.js decides where to grab, because the browser owns the <video>.
// Unit-tested.

import { clampText } from './autopilot.mjs';

const REASON_MAX = 200;

// Why a frame was rejected. A closed set so the UI can show an icon and the
// client can rank rejections without parsing prose.
export const ISSUES = ['ok', 'black', 'credits', 'transition', 'wrong-scene', 'no-subject', 'unclear'];

// ---- contact sheets: show a range, don't guess at one ----
//
// One frame per call meant every rejection was answered with another blind
// guess: the model said "try 400 seconds later" without having seen 400 seconds
// later, so three round trips often produced three misses. Showing a spread of
// the film at once turns guessing into choosing — the model picks the best
// frame it can actually see, and only falls back to suggesting when none of
// them work.
// These two must match public/scripts/tik/sheet.js, which decides WHERE to
// grab (browser side, since it owns the <video>). Asserted equal in tests.
export const SHEET_SIZE = 6;      // frames per call
export const MAX_ROUNDS = 2;      // sheets per slide; 12 frames seen, 2 calls made

export function buildSheetPrompt({
  caption, grab = '', frames = [], durationSeconds, kind = 'trivia',
  round = 1, maxRounds = MAX_ROUNDS, tried = [],
}) {
  const dur = Math.max(1, Math.round(Number(durationSeconds) || 0));
  const list = frames.map((f, i) => {
    const at = Math.max(0, Math.round(Number(f?.seconds ?? f) || 0));
    return `- Frame ${i + 1}: ${at}s (${Math.round((at / dur) * 100)}% in)`;
  }).join('\n');

  const historyBlock = tried.length
    ? `\n\nAlready shown and rejected, do not send us back to these:\n${tried
        .map((t) => `- ${Math.round(t.seconds)}s: ${t.reason || 'rejected'}`).join('\n')}`
    : '';

  const goal = kind === 'title'
    ? `You are looking for the film's TITLE CARD — the main-title logo shot. The winning frame shows the film's title on screen.`
    : `You are looking for the frame that best illustrates a trivia caption on a slideshow. The viewer reads the caption while looking at the image, so it has to support it: a clear, well-lit shot of the moment, scene, person, or prop the caption is about.`;

  return `You are picking the best frame for a slide from several grabbed out of a movie.

${goal}

<caption>${String(caption || '').trim()}</caption>
${grab ? `<shot_wanted>${String(grab).trim()}</shot_wanted>\n` : ''}
The ${frames.length} images above are frames from the same film, in this order:
${list}

This is round ${round} of ${maxRounds}.

Rule out any frame that is essentially black or a flat colour, is opening or closing credits or a studio logo (unless a title card is what was wanted), is caught mid-cut or blurred into mush, shows a different scene than the caption describes, or does not show the person, prop, or detail the caption is about.

From whatever is left, pick the single best one and return its number in "pick". It does NOT have to be the exact instant and the subject does not have to be centred. Prefer a merely-decent frame over rejecting the whole sheet: you only get ${maxRounds} rounds, and a real shot of roughly the right moment beats running out.

Only if EVERY frame is ruled out, set "pick" to null and use "suggestSeconds" to say where to look instead, as a whole number of seconds between 0 and ${dur}. Steer with what you can see: if these all look later in the film than the caption describes, go earlier, and vice versa. Move at least 60 seconds from the nearest frame above.${historyBlock}

Return ONLY valid JSON in this exact shape, nothing else:
{
  "pick": 1,
  "issue": "one of: ${ISSUES.join(', ')}",
  "reason": "one short sentence on what you see in the frame you picked, or why they all failed",
  "suggestSeconds": null,
  "confidence": 0.0
}`;
}

// The model's reply → { pick, ok, issue, reason, suggestSeconds, confidence }.
// `pick` is a 0-based index into the frames that were sent, or null.
//
// Unparseable becomes a low-confidence pick of the FIRST frame rather than a
// rejection: the first frame sits on autopilot's own guess, so a broken
// verifier degrades to the behaviour we would have had without it.
export function normalizeSheetVerdict(raw, frameCount, durationSeconds) {
  const n = Math.max(0, Math.round(Number(frameCount) || 0));
  const dur = Math.max(0, Math.round(Number(durationSeconds) || 0));
  const fallback = {
    pick: n ? 0 : null, ok: n > 0, issue: 'unclear',
    reason: 'Verifier returned nothing usable.', suggestSeconds: null, confidence: 0,
  };
  // An array is not a verdict. Without this it slips past the type check, reads
  // as pick=undefined, and is treated as "every frame rejected" — the one
  // answer a broken verifier must never be able to give.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;

  let pick = Number(raw.pick);
  // The prompt asks for 1-based, which is what a person reading "Frame 3"
  // expects; everything past this line is 0-based.
  pick = Number.isFinite(pick) && pick >= 1 && pick <= n ? Math.round(pick) - 1 : null;

  const ok = pick !== null;
  const issue = ISSUES.includes(raw.issue) ? raw.issue : (ok ? 'ok' : 'unclear');
  const reason = clampText(raw.reason, REASON_MAX);

  let suggest = Number(raw.suggestSeconds);
  if (!Number.isFinite(suggest) || ok) suggest = null;
  else suggest = Math.min(dur, Math.max(0, Math.round(suggest)));

  let confidence = Number(raw.confidence);
  confidence = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5;

  return { pick, ok, issue, reason, suggestSeconds: suggest, confidence };
}

