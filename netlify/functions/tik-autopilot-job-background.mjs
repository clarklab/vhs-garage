// Background AI-job worker — beats Netlify's 10s sync-function ceiling.
// The "-background" filename suffix makes this a Background Function (15-min
// budget) on EVERY bundler version — the in-source `config = { background }`
// key is silently stripped by older zip-it-and-ship-it releases, so don't
// rely on it. The browser POSTs a job (immediate 202), this writes a start
// marker, runs the AI call, and writes the result to Blobs; the browser polls
// GET tik-autopilot?job=<id> for it.
//
// Job kinds (body.kind):
// - 'trivia' (default): movie trivia suggestions → { suggestions }
// - 'roles': an actor's memorable cult roles      → { roles }
// - 'blurbs': slide blurbs for picked roles       → { intro, blurbs }
// - 'year': one year's three top-eight lists      → { intro, rated, boxoffice, rentals }
import { getStore } from '@netlify/blobs';
import { buildAutopilotPrompt, normalizeSuggestions, AUTOPILOT_COUNT, JOBS_STORE, ALLOWED_MODELS } from './lib/autopilot.mjs';
import { buildRolesPrompt, normalizeRoles, buildBlurbsPrompt, normalizeBlurbs, ROLES_COUNT } from './lib/someguys.mjs';
import { buildYearPrompt, normalizeYearSnapshot, normalizeYearInput, hasAnyEntries, LIST_COUNT } from './lib/yearsnapshot.mjs';
import { callModel, parseModelJson } from './lib/ai-providers.mjs';
import { fetchFilmSource, fetchActorSource, fetchYearSource } from './lib/wiki.mjs';

const JOB_MAX_AGE_MS = 60 * 60 * 1000; // sweep results older than 1h
// Keep the AI budget BELOW the client's poll cap (4 min) so every job resolves
// to a result-or-error blob while the browser is still listening.
const AI_TIMEOUT_MS = 3.5 * 60 * 1000;

// With the sync ceiling gone, default to the strongest model for trivia.
const DEFAULT_MODEL = process.env.TIK_AUTOPILOT_MODEL || 'claude-opus-4-8';

// Ground the model in Wikipedia (film production sections, the actor's career
// sections, or the "<year> in film" article). Best-effort: a Wikipedia hiccup
// must never sink the job.
async function fetchSource(kind, { title, year, actor }, jobId) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const source = kind === 'trivia'
      ? await fetchFilmSource(title, year, controller.signal).finally(() => clearTimeout(timer))
      : kind === 'year'
        ? await fetchYearSource(year, controller.signal).finally(() => clearTimeout(timer))
        : await fetchActorSource(actor, controller.signal).finally(() => clearTimeout(timer));
    if (source) console.log('[tik-autopilot-job] grounded in Wikipedia', { jobId, kind, page: source.pageTitle, chars: source.text.length });
    return source;
  } catch (e) {
    console.warn('[tik-autopilot-job] Wikipedia fetch failed; proceeding on recall', { jobId, kind, message: e.message });
    return null;
  }
}

export default async (req) => {
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  let body;
  try { body = await req.json(); } catch { return new Response(null, { status: 400 }); }

  const {
    jobId, kind = 'trivia',
    title, year, durationSeconds, count, exclude, focusTimecode, guidance, includeTitleSlide,
    actor, roles,
    model: requested,
  } = body;
  if (!jobId || !/^[a-zA-Z0-9-]{8,64}$/.test(jobId)) {
    console.error('[tik-autopilot-job] missing/invalid jobId');
    return new Response(null, { status: 400 });
  }

  const model = requested && ALLOWED_MODELS.has(requested) ? requested : DEFAULT_MODEL;

  let store;
  try {
    store = getStore(JOBS_STORE);
    if (kind === 'trivia' && !title) throw new Error('Missing movie title');
    if ((kind === 'roles' || kind === 'blurbs') && !actor) throw new Error('Missing actor name');
    if (kind === 'blurbs' && !(Array.isArray(roles) && roles.length)) throw new Error('No roles picked');
    if (kind === 'year' && normalizeYearInput(year) === null) throw new Error('Enter a four digit year');

    // Start marker: lets the poller distinguish "running" from "never started",
    // so the client can bail early instead of polling a dead job for minutes.
    await store.setJSON(jobId, { started: true }, { metadata: { createdAt: Date.now() } });
    await sweepOldJobs(store);

    // Blurbs run on already-picked roles; no grounding needed there.
    const source = kind === 'blurbs' ? null : await fetchSource(kind, { title, year, actor }, jobId);

    let prompt;
    if (kind === 'roles') {
      prompt = buildRolesPrompt({
        actor, count: Number(count) || ROLES_COUNT, exclude,
        sourceMaterial: source?.text || '', sourceName: source?.pageTitle || '',
      });
    } else if (kind === 'blurbs') {
      prompt = buildBlurbsPrompt({ actor, roles, exclude });
    } else if (kind === 'year') {
      prompt = buildYearPrompt({
        year, count: Number(count) || LIST_COUNT,
        sourceMaterial: source?.text || '', sourceName: source?.pageTitle || '',
      });
    } else {
      prompt = buildAutopilotPrompt({
        title, year, durationSeconds, count, exclude, focusTimecode, guidance, includeTitleSlide,
        sourceMaterial: source?.text || '', sourceName: source?.pageTitle || '',
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    let raw;
    try {
      raw = await callModel(prompt, model, controller.signal);
    } finally {
      clearTimeout(timer);
    }

    let result;
    if (kind === 'roles') {
      const list = normalizeRoles(parseModelJson(raw));
      result = list.length
        ? { ok: true, model, roles: list }
        : { ok: false, model, error: 'The AI returned no usable roles — try again.' };
    } else if (kind === 'blurbs') {
      const { intro, blurbs } = normalizeBlurbs(parseModelJson(raw));
      result = blurbs.length
        ? { ok: true, model, intro, blurbs }
        : { ok: false, model, error: 'The AI returned no usable blurbs — try again.' };
    } else if (kind === 'year') {
      const snapshot = normalizeYearSnapshot(parseModelJson(raw), Number(count) || LIST_COUNT);
      result = hasAnyEntries(snapshot)
        ? { ok: true, model, year: normalizeYearInput(year), ...snapshot }
        : { ok: false, model, error: 'The AI returned no usable lists for that year — try again.' };
    } else {
      const base = Number(count) || AUTOPILOT_COUNT;
      const max = includeTitleSlide ? base + 1 : base;
      const suggestions = normalizeSuggestions(parseModelJson(raw), durationSeconds, max);
      result = suggestions.length
        ? { ok: true, model, suggestions }
        : { ok: false, model, error: 'The AI returned no usable trivia — try again.' };
    }
    if (!result.ok) console.warn('[tik-autopilot-job] no usable result', { jobId, kind, model, rawPreview: String(raw).slice(0, 300) });
    await store.setJSON(jobId, result, { metadata: { createdAt: Date.now() } });
  } catch (e) {
    const reason = e.name === 'AbortError' ? 'the AI took too long even for a background job — try again' : e.message;
    console.error('[tik-autopilot-job] failed', { jobId, kind, model, name: e.name, message: e.message });
    if (store) {
      await store.setJSON(jobId, { ok: false, model, error: `The AI job failed: ${reason}` }, { metadata: { createdAt: Date.now() } })
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
