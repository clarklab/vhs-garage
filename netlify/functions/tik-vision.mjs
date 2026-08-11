// Screenshot verifier: is this frame the right image for this caption?
//
// POST { imageBase64, mediaType, caption, grab, timecode, durationSeconds,
//        kind, attempt, tried[] }
//   → { ok, issue, reason, suggestSeconds, confidence, nextSeconds }
//
// `nextSeconds` is the answer the client actually acts on — the model's own
// suggestion when it is usable, and a deterministic probe when it is not (see
// nextAttemptSeconds). Null means "stop, there is nowhere new to look".
//
// One frame per call, so the client can show progress between attempts and
// stop early the moment a frame passes.
import { buildSheetPrompt, normalizeSheetVerdict, SHEET_SIZE, MAX_ROUNDS } from './lib/vision.mjs';
import { callModelWithImages, parseModelJson } from './lib/ai-providers.mjs';

const DEFAULT_MODEL = process.env.TIK_VISION_MODEL || 'claude-sonnet-5';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Anthropic's per-image ceiling
const ALLOWED_MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp']);

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  // frames: [{ base64, mediaType, seconds }] — a spread of the film, in order.
  const raw = Array.isArray(body?.frames) ? body.frames.slice(0, SHEET_SIZE) : [];
  const frames = raw
    .map((f) => ({
      base64: String(f?.base64 || '').replace(/^data:[^,]+,/, ''),
      mediaType: ALLOWED_MEDIA.has(f?.mediaType) ? f.mediaType : 'image/jpeg',
      seconds: Math.max(0, Math.round(Number(f?.seconds) || 0)),
    }))
    .filter((f) => f.base64);
  if (!frames.length) return json({ error: 'Missing frame images' }, 400);

  const totalBytes = frames.reduce((n, f) => n + f.base64.length * 0.75, 0);
  if (totalBytes > MAX_IMAGE_BYTES * SHEET_SIZE) {
    return json({ error: 'Frames too large — downscale before sending' }, 413);
  }

  const caption = String(body?.caption || '').trim();
  if (!caption) return json({ error: 'Missing caption' }, 400);

  const durationSeconds = Math.max(1, Math.round(Number(body?.durationSeconds) || 0));
  const round = Math.min(MAX_ROUNDS, Math.max(1, Math.round(Number(body?.round) || 1)));
  const tried = Array.isArray(body?.tried) ? body.tried.slice(0, SHEET_SIZE * MAX_ROUNDS) : [];

  const prompt = buildSheetPrompt({
    caption, grab: body?.grab, frames, durationSeconds,
    kind: body?.kind === 'title' ? 'title' : 'trivia',
    round, maxRounds: MAX_ROUNDS, tried,
  });

  try {
    const answer = await callModelWithImages(
      prompt,
      frames.map((f) => ({ base64: f.base64, mediaType: f.mediaType })),
      DEFAULT_MODEL,
    );
    const verdict = normalizeSheetVerdict(parseModelJson(answer), frames.length, durationSeconds);
    // Hand back the chosen frame's timecode so the client never has to re-derive
    // which image the index referred to.
    const pickedSeconds = verdict.pick === null ? null : frames[verdict.pick].seconds;
    return json({ ...verdict, pickedSeconds, round });
  } catch (e) {
    console.error('[tik-vision] sheet check failed', {
      message: e.message, round, frames: frames.length,
    });
    // Fail OPEN on the first frame, which sits on autopilot's own guess: an
    // outage costs the second opinion, never the slide.
    return json({
      pick: 0, ok: true, issue: 'unclear', reason: `Frame check unavailable: ${e.message}`,
      suggestSeconds: null, pickedSeconds: frames[0].seconds, confidence: 0, round, degraded: true,
    });
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
