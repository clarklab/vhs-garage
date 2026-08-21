// Autopilot: given a movie title/year, ask an LLM (via the Netlify AI Gateway)
// for deep-cut trivia + suggested timecodes.
//
// Two roles:
// - GET ?job=<id> → poll for a background job's result (written to Blobs by
//   tik-autopilot-job, which has a 15-minute budget). This is the primary path.
// - POST → legacy SYNCHRONOUS call, kept as a fallback for stale clients; it
//   lives under Netlify's 10s function ceiling so it uses a fast model + 9s abort.
import { getStore } from '@netlify/blobs';
import { buildAutopilotPrompt, buildTitleSlidePrompt, buildQuotesPrompt, normalizeSuggestions, normalizeMeta, AUTOPILOT_COUNT, QUOTES_COUNT, JOBS_STORE, ALLOWED_MODELS } from './lib/autopilot.mjs';
import { buildRolesPrompt, normalizeRoles, buildBlurbsPrompt, normalizeBlurbs, ROLES_COUNT } from './lib/someguys.mjs';
import { buildYearPrompt, normalizeYearSnapshot, normalizeYearInput, hasAnyEntries, yearFailureReason, LIST_COUNT, YEAR_MAX_TOKENS } from './lib/yearsnapshot.mjs';
import { callModel, parseModelJson } from './lib/ai-providers.mjs';

// Sync-path default: must fit the 9s abort, so use the fast tier here. The
// background job (tik-autopilot-job-background) defaults to Opus 4.8 instead.
const DEFAULT_MODEL = process.env.TIK_AUTOPILOT_SYNC_MODEL || 'claude-haiku-4-5';
function pickModel(requested) {
  return requested && ALLOWED_MODELS.has(requested) ? requested : DEFAULT_MODEL;
}

export default async (req) => {
  const url = new URL(req.url);

  // ---- Poll a background job result ----
  if (req.method === 'GET') {
    const jobId = url.searchParams.get('job');
    if (!jobId) return json({ error: 'Missing job id' }, 400);
    try {
      const store = getStore(JOBS_STORE);
      // Strong consistency: the job may have finished milliseconds ago.
      const result = await store.get(jobId, { type: 'json', consistency: 'strong' });
      if (!result) return json({ done: false });
      // Start marker only → the worker is alive but still thinking.
      if (result.started && result.ok === undefined) return json({ done: false, started: true });
      return json({ done: true, ...result });
    } catch (e) {
      // Loud + distinguishable: a Blobs outage must not masquerade as
      // "still thinking" — the client bails to the sync path on repeated 5xx.
      console.error('[tik-autopilot] job poll read failed', { jobId, message: e.message });
      return json({ error: 'Job store unavailable' }, 500);
    }
  }

  if (req.method !== 'POST') return json({ error: 'GET ?job=<id> or POST required' }, 405);

  // ---- Legacy synchronous path (10s ceiling → fast model, 9s abort) ----
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { kind = 'trivia', title, year, durationSeconds, count, exclude, focusTimecode, guidance, includeTitleSlide, includeMeta, titleOnly, actor, roles, minVotes, ratedGiven, boxofficeGiven, quotes, cues, hints, model: requested } = body;
  if ((kind === 'trivia' || kind === 'quotes') && !title) return json({ error: 'Missing movie title' }, 400);
  if ((kind === 'roles' || kind === 'blurbs') && !actor) return json({ error: 'Missing actor name' }, 400);
  if (kind === 'blurbs' && !(Array.isArray(roles) && roles.length)) return json({ error: 'No roles picked' }, 400);
  if (kind === 'year' && normalizeYearInput(year) === null) return json({ error: 'Enter a four digit year' }, 400);
  const model = pickModel(requested);
  const prompt = kind === 'roles'
    ? buildRolesPrompt({ actor, count: Number(count) || ROLES_COUNT, exclude })
    : kind === 'blurbs'
      ? buildBlurbsPrompt({ actor, roles, exclude })
      : kind === 'year'
        ? buildYearPrompt({ year, count: Number(count) || LIST_COUNT, minVotes, ratedGiven, boxofficeGiven })
        : kind === 'quotes'
          ? buildQuotesPrompt({
            title, year, durationSeconds,
            count: Number(count) || QUOTES_COUNT,
            quotes: Array.isArray(quotes) ? quotes : [],
            cues: Array.isArray(cues) ? cues : [],
            hints: Array.isArray(hints) ? hints : [],
            guidance, includeTitleSlide, includeMeta,
          })
          : titleOnly
            ? buildTitleSlidePrompt({ title, year, durationSeconds, exclude })
            : buildAutopilotPrompt({ title, year, durationSeconds, count, exclude, focusTimecode, guidance, includeTitleSlide, includeMeta });

  // Abort before Netlify's 10s function ceiling so we return a graceful
  // fallback instead of a platform 502.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const raw = await callModel(prompt, model, controller.signal, kind === 'year' ? YEAR_MAX_TOKENS : undefined);
    if (kind === 'roles') {
      const list = normalizeRoles(parseModelJson(raw));
      if (!list.length) {
        console.warn('[tik-autopilot] model returned no usable roles', { model, rawPreview: String(raw).slice(0, 300) });
        return json({ roles: [], model, aiFallback: true, error: 'The AI returned no usable roles — try again.' });
      }
      return json({ roles: list, model, aiFallback: false });
    }
    if (kind === 'blurbs') {
      const { intro, blurbs } = normalizeBlurbs(parseModelJson(raw));
      if (!blurbs.length) {
        console.warn('[tik-autopilot] model returned no usable blurbs', { model, rawPreview: String(raw).slice(0, 300) });
        return json({ blurbs: [], model, aiFallback: true, error: 'The AI returned no usable blurbs — try again.' });
      }
      return json({ intro, blurbs, model, aiFallback: false });
    }
    if (kind === 'year') {
      const parsed = parseModelJson(raw);
      const snapshot = normalizeYearSnapshot(parsed, Number(count) || LIST_COUNT);
      if (!hasAnyEntries(snapshot)) {
        console.warn('[tik-autopilot] model returned no usable year lists', { model, rawPreview: String(raw).slice(0, 300) });
        return json({ rated: [], boxoffice: [], model, aiFallback: true, error: yearFailureReason(raw, parsed) });
      }
      return json({ year: normalizeYearInput(year), ...snapshot, model, aiFallback: false });
    }
    const base = titleOnly ? 1 : (Number(count) || (kind === 'quotes' ? QUOTES_COUNT : AUTOPILOT_COUNT));
    const max = (kind === 'quotes' ? includeTitleSlide !== false : includeTitleSlide) ? base + 1 : base;
    const parsed = parseModelJson(raw);
    const suggestions = normalizeSuggestions(parsed, durationSeconds, max);
    const meta = includeMeta ? normalizeMeta(parsed) : null;
    if (!suggestions.length) {
      console.warn('[tik-autopilot] model returned no usable suggestions', { model, rawPreview: String(raw).slice(0, 300) });
      return json({ suggestions: [], model, aiFallback: true, error: kind === 'quotes' ? 'The AI returned no usable quotes — try again.' : 'The AI returned no usable trivia — try again.' });
    }
    return json({ suggestions, meta, model, aiFallback: false });
  } catch (e) {
    console.error('[tik-autopilot] AI call failed', { kind, model, name: e.name, message: e.message });
    const reason = e.name === 'AbortError'
      ? 'the AI took too long to respond — try again'
      : e.message;
    return json({ suggestions: [], model, aiFallback: true, error: `The AI call failed: ${reason}` });
  } finally {
    clearTimeout(timer);
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
