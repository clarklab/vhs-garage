// Background worker for batch mode's "pick 10 movies for me".
//
// The first cut of this ran synchronously and timed out: choosing ten films
// with a reason for each takes a good model well past Netlify's 10s ceiling.
// Same shape as tik-autopilot-job-background — the "-background" filename
// suffix is what actually makes it a Background Function (15-min budget) on
// every bundler version, so don't swap it for an in-source config key.
//
// The browser POSTs a job (immediate 202) and polls GET tik-queue?job=<id>.
import { getStore } from '@netlify/blobs';
import { buildQueuePrompt, normalizeQueue, QUEUE_COUNT, QUEUE_JOBS_STORE } from './lib/queue.mjs';
import { resolveTitle } from './lib/imdb.mjs';
import { callModel, parseModelJson } from './lib/ai-providers.mjs';

const JOB_MAX_AGE_MS = 60 * 60 * 1000;
// Under the client's poll cap so every job resolves to a result-or-error blob
// while the browser is still listening.
const AI_TIMEOUT_MS = 3 * 60 * 1000;
const MODEL = process.env.TIK_QUEUE_MODEL || 'claude-sonnet-5';

export default async (req) => {
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  let body;
  try { body = await req.json(); } catch { return new Response(null, { status: 400 }); }

  const { jobId, history = [], posted = [], count = QUEUE_COUNT, guidance = '' } = body;
  if (!jobId || !/^[a-zA-Z0-9-]{8,64}$/.test(jobId)) {
    console.error('[tik-queue-job] missing/invalid jobId');
    return new Response(null, { status: 400 });
  }

  let store;
  try {
    store = getStore(QUEUE_JOBS_STORE);
    await store.setJSON(jobId, { started: true }, { metadata: { createdAt: Date.now() } });
    await sweepOldJobs(store);

    const prompt = buildQueuePrompt({
      history: Array.isArray(history) ? history : [],
      posted: Array.isArray(posted) ? posted : [],
      count, guidance,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    let raw;
    try {
      raw = await callModel(prompt, MODEL, controller.signal, 1536);
    } finally {
      clearTimeout(timer);
    }

    const picks = normalizeQueue(parseModelJson(raw), {
      posted: [...(posted || []), ...(history || [])], count,
    });

    if (!picks.length) {
      console.warn('[tik-queue-job] no usable picks', { jobId, rawPreview: String(raw).slice(0, 300) });
      await store.setJSON(jobId, { ok: false, error: 'The AI returned no usable picks — try again.' },
        { metadata: { createdAt: Date.now() } });
      return new Response(null, { status: 202 });
    }

    // No sync ceiling here, so every pick gets resolved against IMDb properly
    // instead of racing a 1.5s budget. Still best-effort: an unresolved pick
    // keeps its title and batch mode looks it up when that film's turn comes.
    const resolved = await Promise.allSettled(picks.map((p) => resolveTitle(p.title, p.year)));
    const out = picks.map((pick, i) => {
      const hit = resolved[i]?.status === 'fulfilled' ? resolved[i].value : null;
      if (!hit) return { ...pick, imdbId: null };
      return {
        ...pick,
        title: hit.title || pick.title,
        year: hit.year ?? pick.year,
        imdbId: hit.id,
        runtimeSeconds: hit.runtimeSeconds,
        rating: hit.rating,
        poster: hit.poster,
      };
    });

    console.log('[tik-queue-job] picked movies', {
      jobId, count: out.length, resolved: out.filter((p) => p.imdbId).length,
    });
    await store.setJSON(jobId, { ok: true, picks: out }, { metadata: { createdAt: Date.now() } });
  } catch (e) {
    const reason = e.name === 'AbortError'
      ? 'the AI took too long even for a background job — try again'
      : e.message;
    console.error('[tik-queue-job] failed', { jobId, name: e.name, message: e.message });
    if (store) {
      await store.setJSON(jobId, { ok: false, error: `Could not pick movies: ${reason}` },
        { metadata: { createdAt: Date.now() } })
        .catch((we) => console.error('[tik-queue-job] could not write error result', { jobId, message: we.message }));
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
    console.warn('[tik-queue-job] job sweep failed:', e.message);
  }
}
