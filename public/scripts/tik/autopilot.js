// Autopilot AI fetch. Primary path: kick off a BACKGROUND job (Netlify gives
// it 15 minutes — no more 10s sync-function timeouts) and poll for the result.
// Falls back to the legacy synchronous endpoint if the job function isn't
// deployed. The seek + frame-grab happens in app.js, so bulk-autopilot,
// "add scene", and the per-slide sparkle all share this one code path.

const POLL_INTERVAL_MS = 2500;
const POLL_MAX_MS = 4 * 60 * 1000; // give even Opus on a bad day plenty of room

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// opts: { title, year, durationSeconds, count?, exclude?, focusTimecode?,
//         guidance?, includeTitleSlide?, model?, onProgress? }
// Returns [{ caption, timecode, grab }]. Throws a clear message on failure.
export async function fetchScenes(opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const params = {
    title: opts.title,
    year: opts.year,
    durationSeconds: opts.durationSeconds || 0,
    count: opts.count,
    exclude: opts.exclude || [],
    focusTimecode: opts.focusTimecode,
    guidance: opts.guidance || '',
    includeTitleSlide: !!opts.includeTitleSlide,
    model: opts.model, // optional override; server allowlist decides
  };

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
    console.warn('[tik] background job unavailable, using sync autopilot', { status: kick?.status });
    return fetchScenesSync(params);
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
        console.warn('[tik] job polling kept failing; falling back to sync autopilot');
        return fetchScenesSync(params);
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
        console.warn('[tik] job never started; falling back to sync autopilot', { jobId });
        return fetchScenesSync(params);
      }
      continue;
    }
    if (!data.ok || !data.suggestions?.length) {
      throw new Error(data.error || 'Autopilot couldn’t generate trivia — try again.');
    }
    return data.suggestions;
  }
  throw new Error('Autopilot is taking unusually long — give it a minute and try again.');
}

// Legacy synchronous path (10s server ceiling).
async function fetchScenesSync(params) {
  const res = await fetch('/.netlify/functions/tik-autopilot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  const suggestions = data.suggestions || [];
  if (!suggestions.length) {
    throw new Error(data.error || 'Autopilot couldn’t generate trivia — try again.');
  }
  return suggestions;
}
