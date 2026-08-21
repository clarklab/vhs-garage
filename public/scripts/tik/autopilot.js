// AI-job client for all agent calls (trivia, actor roles, blurbs). Primary
// path: kick off a BACKGROUND job (Netlify gives it 15 minutes — no more 10s
// sync-function timeouts) and poll for the result. Falls back to the legacy
// synchronous endpoint if the job function isn't deployed. The seek +
// frame-grab happens in app.js, so bulk-autopilot, "add scene", the per-slide
// rewrites, and the Some Guys flow all share this one code path.

const POLL_INTERVAL_MS = 2500;
const POLL_MAX_MS = 4 * 60 * 1000; // give even Opus on a bad day plenty of room

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run one AI job end-to-end and return the full result body. params must
// include `kind`; onProgress(msg) drives the UI while the model thinks.
async function runJob(params, onProgress = () => {}) {
  // Kick off the background job. (randomUUID needs a secure context; fall back
  // to getRandomValues hex for plain-HTTP LAN use — the server regex takes both.)
  const jobId = crypto.randomUUID?.() ??
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  // 20s timeout: a STALLED connection (not an error) used to hang this await
  // forever with the UI's buttons disabled. A timeout rejects, the .catch
  // turns it into null, and the existing sync fallback takes over.
  const kick = await fetch('/.netlify/functions/tik-autopilot-job-background', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, jobId }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);

  if (!kick || !kick.ok) {
    // Job function unavailable (stale deploy?) — legacy sync call still works.
    console.warn('[tik] background job unavailable, using sync endpoint', { status: kick?.status });
    return runJobSync(params);
  }

  // Poll for the result. Background jobs survive as long as they need to; we
  // keep the user informed while it thinks, and bail to the sync path if the
  // poll endpoint keeps erroring or the job never even starts.
  const t0 = Date.now();
  let consecutiveFails = 0;
  let sawStart = false;
  while (Date.now() - t0 < POLL_MAX_MS) {
    await sleep(POLL_INTERVAL_MS);
    const elapsed = Math.round((Date.now() - t0) / 1000);
    onProgress(`AI is thinking… ${elapsed}s`);
    const res = await fetch(`/.netlify/functions/tik-autopilot?job=${encodeURIComponent(jobId)}`,
      { signal: AbortSignal.timeout(15_000) }).catch(() => null); // hung poll → counts as a failed one
    if (!res || !res.ok) {
      if (++consecutiveFails >= 5) {
        console.warn('[tik] job polling kept failing; falling back to sync endpoint');
        return runJobSync(params);
      }
      continue; // transient poll error — keep waiting
    }
    consecutiveFails = 0;
    const data = await res.json().catch(() => ({}));
    if (data.started) sawStart = true;
    if (!data.done) {
      // Healthy polls but no start marker after 30s → the worker likely died
      // before it could begin; don't burn 4 minutes on a ghost job.
      if (!sawStart && Date.now() - t0 > 30_000) {
        console.warn('[tik] job never started; falling back to sync endpoint', { jobId });
        return runJobSync(params);
      }
      continue;
    }
    return data;
  }
  throw new Error('The AI is taking unusually long — give it a minute and try again.');
}

// Legacy synchronous path (10s server ceiling).
async function runJobSync(params) {
  const res = await fetch('/.netlify/functions/tik-autopilot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30_000), // the server's own ceiling is 10s
  });
  return await res.json().catch(() => ({}));
}

// opts: { title, year, durationSeconds, count?, exclude?, focusTimecode?,
//         guidance?, includeTitleSlide?, includeMeta?, model?, onProgress? }
// Returns { suggestions: [{ caption, timecode, grab }], meta }, where meta is
// { hook, filmTags, songs } or null. Throws a clear message on failure.
//
// meta is only requested when includeMeta is set, and a null meta is a normal
// outcome the caller falls back from — never a reason to throw away trivia.
export async function fetchTriviaPost(opts = {}) {
  const data = await runJob({
    kind: 'trivia',
    title: opts.title,
    year: opts.year,
    durationSeconds: opts.durationSeconds || 0,
    count: opts.count,
    exclude: opts.exclude || [],
    focusTimecode: opts.focusTimecode,
    guidance: opts.guidance || '',
    includeTitleSlide: !!opts.includeTitleSlide,
    includeMeta: !!opts.includeMeta,
    model: opts.model, // optional override; server allowlist decides
  }, opts.onProgress);
  if (!data.suggestions?.length) {
    throw new Error(data.error || 'Autopilot couldn’t generate trivia — try again.');
  }
  if (opts.includeMeta && !data.meta) {
    console.warn('[tik] post meta missing from the AI answer; using template copy', { title: opts.title });
  }
  return { suggestions: data.suggestions, meta: data.meta || null };
}

// Trivia only, for the callers that never wanted the post copy (the "write one
// more slide" path). Returns [{ caption, timecode, grab }].
export async function fetchScenes(opts = {}) {
  const { suggestions } = await fetchTriviaPost(opts);
  return suggestions;
}

// The intro slide only. Its own call because the intro is a different writing
// job from a trivia fact: rewriting it through fetchScenes produced another
// fact, which is exactly what it must not be.
//
// opts: { title, year, durationSeconds, exclude?, model?, onProgress? }
// Returns one { caption, timecode, grab }.
export async function fetchTitleSlide(opts = {}) {
  const data = await runJob({
    kind: 'trivia',
    titleOnly: true,
    title: opts.title,
    year: opts.year,
    durationSeconds: opts.durationSeconds || 0,
    exclude: opts.exclude || [],
    model: opts.model,
  }, opts.onProgress);
  const [scene] = data.suggestions || [];
  if (!scene?.caption) throw new Error(data.error || 'The AI couldn’t rewrite the intro — try again.');
  return scene;
}

// opts: { actor, count?, exclude?, model?, onProgress? }
// Returns [{ movie, year, role, hook }]. Throws a clear message on failure.
export async function fetchRoles(opts = {}) {
  const data = await runJob({
    kind: 'roles',
    actor: opts.actor,
    count: opts.count,
    exclude: opts.exclude || [],
    model: opts.model,
  }, opts.onProgress);
  if (!data.roles?.length) {
    throw new Error(data.error || 'The AI couldn’t find roles for that name — check the spelling and try again.');
  }
  return data.roles;
}

// opts: { year, count?, minVotes?, ratedGiven?, boxofficeGiven?, model?, onProgress? }
// Returns { intro, rated, boxoffice } — each list [{ rank, title, value, note }],
// either of which may be empty. Pass `ratedGiven` / `boxofficeGiven` (the user's
// own IMDb / Box Office Mojo rows) to fix that list: the agent then only writes
// its notes. Throws only when the year came back with nothing usable at all.
export async function fetchYearSnapshot(opts = {}) {
  const data = await runJob({
    kind: 'year',
    year: opts.year,
    count: opts.count,
    minVotes: opts.minVotes,
    ratedGiven: opts.ratedGiven || [],
    boxofficeGiven: opts.boxofficeGiven || [],
    model: opts.model,
  }, opts.onProgress);
  const rated = data.rated || [];
  const boxoffice = data.boxoffice || [];
  if (!rated.length && !boxoffice.length) {
    throw new Error(data.error || 'The AI couldn’t pull that year — try again.');
  }
  return { intro: data.intro || '', rated, boxoffice };
}

// opts: { actor, roles: [{movie, year, role}], exclude?, model?, onProgress? }
// Returns { intro, blurbs: [{ movie, year, role, blurb }] }. Throws on failure.
export async function fetchBlurbs(opts = {}) {
  const data = await runJob({
    kind: 'blurbs',
    actor: opts.actor,
    roles: opts.roles || [],
    exclude: opts.exclude || [],
    model: opts.model,
  }, opts.onProgress);
  if (!data.blurbs?.length) {
    throw new Error(data.error || 'The AI couldn’t write blurbs — try again.');
  }
  return { intro: data.intro || '', blurbs: data.blurbs };
}

export const QUOTES_COUNT = 8;

export async function fetchImdbQuotes({ imdbId, query, year, includeSpoilers = true } = {}) {
  const res = await fetch('/.netlify/functions/tik-imdb', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'quotes', imdbId, query, year, includeSpoilers }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'IMDb quotes lookup failed');
  return data;
}

// OpenSubtitles misses fail open: HTTP 200 with missing:true is the normal
// "no English file" answer, not an error. !res.ok is treated the same way so
// Autopilot can still boil quotes with guessed times.
export async function fetchSubtitles({ imdbId, query, year } = {}) {
  try {
    const res = await fetch('/.netlify/functions/tik-subtitles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imdbId, query, year }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.missing) {
      return { cues: Array.isArray(data.cues) ? data.cues : [], missing: true, error: data.error || 'Subtitle lookup failed' };
    }
    return { cues: Array.isArray(data.cues) ? data.cues : [], missing: false, error: data.error || null };
  } catch (e) {
    return { cues: [], missing: true, error: e.message || 'Subtitle lookup failed' };
  }
}

export async function fetchQuotesPost(opts = {}) {
  const data = await runJob({
    kind: 'quotes',
    title: opts.title,
    year: opts.year,
    durationSeconds: opts.durationSeconds || 0,
    count: opts.count || QUOTES_COUNT,
    quotes: opts.quotes || [],
    cues: opts.cues || [],
    hints: opts.hints || [],
    exclude: opts.exclude || [],
    guidance: opts.guidance || '',
    includeTitleSlide: opts.includeTitleSlide !== false,
    includeMeta: !!opts.includeMeta,
    model: opts.model,
  }, opts.onProgress);
  if (!data.suggestions?.length) {
    throw new Error(data.error || 'Autopilot couldn’t generate quotes — try again.');
  }
  return { suggestions: data.suggestions, meta: data.meta || null };
}
