// Background autopilot worker — beats Netlify's 10s sync-function ceiling.
// The "-background" filename suffix makes this a Background Function (15-min
// budget) on EVERY bundler version — the in-source `config = { background }`
// key is silently stripped by older zip-it-and-ship-it releases, so don't
// rely on it. The browser POSTs a job (immediate 202), this writes a start
// marker, runs the AI call, and writes the result to Blobs; the browser polls
// GET tik-autopilot?job=<id> for it.
import { getStore } from '@netlify/blobs';
import { buildAutopilotPrompt, normalizeSuggestions, AUTOPILOT_COUNT, JOBS_STORE, ALLOWED_MODELS } from './lib/autopilot.mjs';
import { callModel, parseModelJson } from './lib/ai-providers.mjs';

const JOB_MAX_AGE_MS = 60 * 60 * 1000; // sweep results older than 1h
// Keep the AI budget BELOW the client's poll cap (4 min) so every job resolves
// to a result-or-error blob while the browser is still listening.
const AI_TIMEOUT_MS = 3.5 * 60 * 1000;

// With the sync ceiling gone, default to the strongest model for trivia.
const DEFAULT_MODEL = process.env.TIK_AUTOPILOT_MODEL || 'claude-opus-4-8';

export default async (req) => {
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  let body;
  try { body = await req.json(); } catch { return new Response(null, { status: 400 }); }

  const { jobId, title, year, durationSeconds, count, exclude, focusTimecode, guidance, includeTitleSlide, model: requested } = body;
  if (!jobId || !/^[a-zA-Z0-9-]{8,64}$/.test(jobId)) {
    console.error('[tik-autopilot-job] missing/invalid jobId');
    return new Response(null, { status: 400 });
  }

  const model = requested && ALLOWED_MODELS.has(requested) ? requested : DEFAULT_MODEL;

  let store;
  try {
    store = getStore(JOBS_STORE);
    if (!title) throw new Error('Missing movie title');

    // Start marker: lets the poller distinguish "running" from "never started",
    // so the client can bail early instead of polling a dead job for minutes.
    await store.setJSON(jobId, { started: true }, { metadata: { createdAt: Date.now() } });
    await sweepOldJobs(store);

    const prompt = buildAutopilotPrompt({ title, year, durationSeconds, count, exclude, focusTimecode, guidance, includeTitleSlide });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    let raw;
    try {
      raw = await callModel(prompt, model, controller.signal);
    } finally {
      clearTimeout(timer);
    }

    const base = Number(count) || AUTOPILOT_COUNT;
    const max = includeTitleSlide ? base + 1 : base;
    const suggestions = normalizeSuggestions(parseModelJson(raw), durationSeconds, max);
    if (!suggestions.length) {
      console.warn('[tik-autopilot-job] no usable suggestions', { jobId, model, rawPreview: String(raw).slice(0, 300) });
      await store.setJSON(jobId, { ok: false, model, error: 'The AI returned no usable trivia — try again.' }, { metadata: { createdAt: Date.now() } });
    } else {
      await store.setJSON(jobId, { ok: true, model, suggestions }, { metadata: { createdAt: Date.now() } });
    }
  } catch (e) {
    const reason = e.name === 'AbortError' ? 'the AI took too long even for a background job — try again' : e.message;
    console.error('[tik-autopilot-job] failed', { jobId, model, name: e.name, message: e.message });
    if (store) {
      await store.setJSON(jobId, { ok: false, model, error: `Autopilot failed: ${reason}` }, { metadata: { createdAt: Date.now() } })
        .catch((we) => console.error('[tik-autopilot-job] could not write error result', { jobId, message: we.message }));
    }
  }

  return new Response(null, { status: 202 });
};

async function sweepOldJobs(store) {
  try {
    const { blobs } = await store.list();
    const now = Date.now();
    await Promise.all(blobs.map(async (b) => {
      const meta = await store.getMetadata(b.key).catch(() => null);
      if (!meta) return; // unreadable metadata ≠ old — never delete a live job on a read blip
      const createdAt = meta?.metadata?.createdAt ?? 0;
      if (now - createdAt > JOB_MAX_AGE_MS) await store.delete(b.key).catch(() => {});
    }));
  } catch (e) {
    console.warn('[tik-autopilot-job] job sweep failed:', e.message);
  }
}
