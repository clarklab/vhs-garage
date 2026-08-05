// Poller for the trivia curation job (see tik-curate-background).
//
// - GET ?job=<id> → the ranking, once the worker has written it.
// - POST → synchronous fallback on the fast tier for stale clients and
//   undeployed-worker cases. A thinner ranking beats a 502.
import { getStore } from '@netlify/blobs';
import { buildCuratePrompt, normalizeCuration, CURATE_JOBS_STORE } from './lib/curate.mjs';
import { callModel, parseModelJson } from './lib/ai-providers.mjs';

const SYNC_MODEL = process.env.TIK_CURATE_SYNC_MODEL || 'claude-haiku-4-5';
const SYNC_TIMEOUT_MS = 8_000;

export default async (req) => {
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const jobId = url.searchParams.get('job');
    if (!jobId) return json({ error: 'Missing job id' }, 400);
    try {
      const store = getStore(CURATE_JOBS_STORE);
      const result = await store.get(jobId, { type: 'json', consistency: 'strong' });
      if (!result) return json({ done: false });
      if (result.started && result.ok === undefined) return json({ done: false, started: true });
      return json({ done: true, ...result });
    } catch (e) {
      console.error('[tik-curate] job poll read failed', { jobId, message: e.message });
      return json({ error: 'Job store unavailable' }, 500);
    }
  }

  if (req.method !== 'POST') return json({ error: 'GET ?job=<id> or POST required' }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { title, year, candidates = [], count = 10 } = body;
  if (!title || !Array.isArray(candidates) || !candidates.length) {
    return json({ error: 'Need a title and candidates' }, 400);
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
    let raw;
    try {
      raw = await callModel(buildCuratePrompt({ title, year, candidates, count }), SYNC_MODEL, controller.signal, 1024);
    } finally {
      clearTimeout(timer);
    }
    return json({ ok: true, ...normalizeCuration(parseModelJson(raw), candidates, count) });
  } catch (e) {
    const reason = e.name === 'AbortError' ? 'the model took too long on the fallback path' : e.message;
    console.error('[tik-curate] sync path failed', { name: e.name, message: e.message });
    return json({ error: `Could not rank the trivia: ${reason}` }, 502);
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
