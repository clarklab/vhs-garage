// Batch mode's "what should we make next?" endpoint.
//
// - GET ?job=<id> → poll a background job's result. This is the primary path:
//   picking ten films with a reason for each runs long past Netlify's 10s sync
//   ceiling (the first cut of this was sync-only and 502'd on every call), so
//   tik-queue-background does the work and drops it in Blobs.
// - POST → synchronous fallback, for stale clients and for the case where the
//   background function isn't deployed yet. It fits under the ceiling by using
//   the fast tier and aborting at 8s, so it answers with SOMETHING rather than
//   a 502, at the cost of thinner picks and no IMDb ids.
import { getStore } from '@netlify/blobs';
import { buildQueuePrompt, normalizeQueue, QUEUE_COUNT, QUEUE_JOBS_STORE } from './lib/queue.mjs';
import { callModel, parseModelJson } from './lib/ai-providers.mjs';

const SYNC_MODEL = process.env.TIK_QUEUE_SYNC_MODEL || 'claude-haiku-4-5';
const SYNC_TIMEOUT_MS = 8_000;

export default async (req) => {
  const url = new URL(req.url);

  // ---- Poll a background job result ----
  if (req.method === 'GET') {
    const jobId = url.searchParams.get('job');
    if (!jobId) return json({ error: 'Missing job id' }, 400);
    try {
      const store = getStore(QUEUE_JOBS_STORE);
      // Strong consistency: the job may have finished milliseconds ago.
      const result = await store.get(jobId, { type: 'json', consistency: 'strong' });
      if (!result) return json({ done: false });
      // Start marker only → the worker is alive but still thinking.
      if (result.started && result.ok === undefined) return json({ done: false, started: true });
      return json({ done: true, ...result });
    } catch (e) {
      console.error('[tik-queue] job poll read failed', { jobId, message: e.message });
      return json({ error: 'Job store unavailable' }, 500);
    }
  }

  if (req.method !== 'POST') return json({ error: 'GET ?job=<id> or POST required' }, 405);

  // ---- Synchronous fallback (10s ceiling → fast model, 8s abort) ----
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const history = Array.isArray(body?.history) ? body.history : [];
  const posted = Array.isArray(body?.posted) ? body.posted : [];
  const count = Number(body?.count) || QUEUE_COUNT;
  const prompt = buildQueuePrompt({ history, posted, count, guidance: body?.guidance, format: body?.format });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
    let raw;
    try {
      raw = await callModel(prompt, SYNC_MODEL, controller.signal, 1536);
    } finally {
      clearTimeout(timer);
    }
    const picks = normalizeQueue(parseModelJson(raw), { posted: [...posted, ...history], count });
    if (!picks.length) {
      console.warn('[tik-queue] sync path returned no usable picks');
      return json({ error: 'The model returned no usable picks — try again.' }, 502);
    }
    // No IMDb resolution here: it would eat what's left of the budget, and
    // batch mode looks each film up by name when its turn comes anyway.
    return json({ picks: picks.map((p) => ({ ...p, imdbId: null })) });
  } catch (e) {
    const reason = e.name === 'AbortError' ? 'the model took too long on the fallback path' : e.message;
    console.error('[tik-queue] sync path failed', { name: e.name, message: e.message });
    return json({ error: `Could not pick movies: ${reason}` }, 502);
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
