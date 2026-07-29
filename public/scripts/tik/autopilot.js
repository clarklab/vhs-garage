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
  const kick = await fetch('/.netlify/functions/tik-autopilot-job-background', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, jobId }),
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
    const res = await fetch(`/.netlify/functions/tik-autopilot?job=${encodeURIComponent(jobId)}`).catch(() => null);
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
  });
  return await res.json().catch(() => ({}));
}

// opts: { title, year, durationSeconds, count?, exclude?, focusTimecode?,
//         guidance?, includeTitleSlide?, model?, onProgress? }
// Returns [{ caption, timecode, grab }]. Throws a clear message on failure.
export async function fetchScenes(opts = {}) {
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
    model: opts.model, // optional override; server allowlist decides
  }, opts.onProgress);
  if (!data.suggestions?.length) {
    throw new Error(data.error || 'Autopilot couldn’t generate trivia — try again.');
  }
  return data.suggestions;
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
