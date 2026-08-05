// Background worker for "which of these 25 facts make the best 10 slides".
//
// Background, not synchronous, for the same reason tik-queue is: ranking 25
// items with a reason for each runs past Netlify's 10s sync ceiling often
// enough to matter, and a 502 mid-batch is worse than a two-second wait.
// The "-background" filename suffix is what makes it a Background Function.
import { getStore } from '@netlify/blobs';
import { buildCuratePrompt, normalizeCuration, CURATE_JOBS_STORE } from './lib/curate.mjs';
import { callModel, parseModelJson } from './lib/ai-providers.mjs';

const JOB_MAX_AGE_MS = 60 * 60 * 1000;
const AI_TIMEOUT_MS = 2 * 60 * 1000;
const MODEL = process.env.TIK_CURATE_MODEL || 'claude-sonnet-5';

export default async (req) => {
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  let body;
  try { body = await req.json(); } catch { return new Response(null, { status: 400 }); }

  const { jobId, title, year, candidates = [], count = 10 } = body;
  if (!jobId || !/^[a-zA-Z0-9-]{8,64}$/.test(jobId)) {
    console.error('[tik-curate-job] missing/invalid jobId');
    return new Response(null, { status: 400 });
  }

  let store;
  try {
    store = getStore(CURATE_JOBS_STORE);
    await store.setJSON(jobId, { started: true }, { metadata: { createdAt: Date.now() } });
    await sweepOldJobs(store);

    if (!title) throw new Error('Missing movie title');
    if (!Array.isArray(candidates) || !candidates.length) throw new Error('No candidates to rank');

    const prompt = buildCuratePrompt({ title, year, candidates, count });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    let raw;
    try {
      raw = await callModel(prompt, MODEL, controller.signal, 1024);
    } finally {
      clearTimeout(timer);
    }

    const result = normalizeCuration(parseModelJson(raw), candidates, count);
    if (!result.curated) {
      console.warn('[tik-curate-job] model picked nothing usable', { jobId, title, rawPreview: String(raw).slice(0, 300) });
    }
    console.log('[tik-curate-job] ranked', { jobId, title, curated: result.curated, of: candidates.length });
    await store.setJSON(jobId, { ok: true, ...result }, { metadata: { createdAt: Date.now() } });
  } catch (e) {
    const reason = e.name === 'AbortError' ? 'the model took too long' : e.message;
    console.error(`[tik-curate-job] failed: ${reason}`, e);
    if (store) {
      await store.setJSON(jobId, { ok: false, error: `Could not rank the trivia: ${reason}` },
        { metadata: { createdAt: Date.now() } })
        .catch((we) => console.error('[tik-curate-job] could not write error result', { jobId, message: we.message }));
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
      if (!meta) return; // unreadable metadata ≠ old
      if (now - (meta?.metadata?.createdAt ?? 0) > JOB_MAX_AGE_MS) await store.delete(b.key).catch(() => {});
    }));
  } catch (e) {
    console.warn('[tik-curate-job] job sweep failed:', e.message);
  }
}
