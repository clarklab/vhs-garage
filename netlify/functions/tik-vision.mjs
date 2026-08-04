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
import { buildVisionPrompt, normalizeVerdict, nextAttemptSeconds, MAX_ATTEMPTS } from './lib/vision.mjs';
import { callModelWithImage, parseModelJson } from './lib/ai-providers.mjs';

const DEFAULT_MODEL = process.env.TIK_VISION_MODEL || 'claude-sonnet-5';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Anthropic's per-image ceiling
const ALLOWED_MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp']);

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const base64 = String(body?.imageBase64 || '').replace(/^data:[^,]+,/, '');
  if (!base64) return json({ error: 'Missing frame image' }, 400);
  if (base64.length * 0.75 > MAX_IMAGE_BYTES) {
    return json({ error: 'Frame too large — downscale before sending' }, 413);
  }
  const mediaType = ALLOWED_MEDIA.has(body?.mediaType) ? body.mediaType : 'image/jpeg';
  const caption = String(body?.caption || '').trim();
  if (!caption) return json({ error: 'Missing caption' }, 400);

  const durationSeconds = Math.max(1, Math.round(Number(body?.durationSeconds) || 0));
  const timecode = Math.max(0, Math.round(Number(body?.timecode) || 0));
  const attempt = Math.min(MAX_ATTEMPTS, Math.max(1, Math.round(Number(body?.attempt) || 1)));
  const tried = Array.isArray(body?.tried) ? body.tried.slice(0, MAX_ATTEMPTS) : [];

  const prompt = buildVisionPrompt({
    caption, grab: body?.grab, timecode, durationSeconds,
    kind: body?.kind === 'title' ? 'title' : 'trivia',
    attempt, maxAttempts: MAX_ATTEMPTS, tried,
  });

  try {
    const raw = await callModelWithImage(prompt, { base64, mediaType }, DEFAULT_MODEL);
    const verdict = normalizeVerdict(parseModelJson(raw), durationSeconds);
    const nextSeconds = verdict.ok
      ? null
      : nextAttemptSeconds(verdict, { current: timecode, durationSeconds, tried, attempt });
    return json({ ...verdict, nextSeconds, attempt });
  } catch (e) {
    console.error('[tik-vision] frame check failed', { message: e.message, attempt, timecode });
    // Fail OPEN. A verifier outage must not block the slide — the user still
    // gets the frame autopilot picked, just without the second opinion.
    return json({
      ok: true, issue: 'unclear', reason: `Frame check unavailable: ${e.message}`,
      suggestSeconds: null, nextSeconds: null, confidence: 0, attempt, degraded: true,
    });
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
