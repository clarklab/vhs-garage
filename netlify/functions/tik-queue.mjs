// Batch mode's "what should we make next?" call.
//
// POST { history, posted, count, guidance }
//   → { picks: [{ title, year, why, imdbId, runtimeSeconds, rating, poster }] }
//
// The model picks the films; we then resolve each against IMDb so batch mode
// can go straight to fetching trivia instead of guessing at ids. Resolution is
// best-effort and time-boxed: an unresolved pick still comes back with its
// title, and the client resolves it when that film's turn comes round.
import { buildQueuePrompt, normalizeQueue, QUEUE_COUNT } from './lib/queue.mjs';
import { resolveTitle } from './lib/imdb.mjs';
import { callModel, parseModelJson } from './lib/ai-providers.mjs';

const MODEL = process.env.TIK_QUEUE_MODEL || 'claude-sonnet-5';
const MODEL_TIMEOUT_MS = 8_000;   // Netlify's sync ceiling is 10s
const RESOLVE_BUDGET_MS = 1_500;

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const history = Array.isArray(body?.history) ? body.history : [];
  const posted = Array.isArray(body?.posted) ? body.posted : [];
  const count = Number(body?.count) || QUEUE_COUNT;
  const prompt = buildQueuePrompt({ history, posted, count, guidance: body?.guidance });

  let picks;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
    let raw;
    try {
      raw = await callModel(prompt, MODEL, controller.signal, 1536);
    } finally {
      clearTimeout(timer);
    }
    picks = normalizeQueue(parseModelJson(raw), { posted: [...posted, ...history], count });
  } catch (e) {
    console.error('[tik-queue] model call failed', { message: e.message });
    return json({ error: `Could not pick movies: ${e.message}` }, 502);
  }

  if (!picks.length) {
    console.warn('[tik-queue] model returned no usable picks');
    return json({ error: 'The model returned no usable picks — try again.' }, 502);
  }

  const resolved = await withBudget(
    Promise.allSettled(picks.map((p) => resolveTitle(p.title, p.year))),
    RESOLVE_BUDGET_MS,
  );

  return json({
    picks: picks.map((pick, i) => {
      const hit = resolved?.[i]?.status === 'fulfilled' ? resolved[i].value : null;
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
    }),
  });
};

// Resolve `promise`, or give up and return null once the budget runs out. The
// picks matter; their IMDb ids are a nicety we can look up later.
function withBudget(promise, ms) {
  return Promise.race([
    promise.catch(() => null),
    new Promise((r) => setTimeout(() => r(null), ms)),
  ]);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
