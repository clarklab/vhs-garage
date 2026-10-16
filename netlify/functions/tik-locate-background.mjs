// Whole-film frame search, server side. A BACKGROUND function: a call with
// six grids and ten facts can outrun the ten-second ceiling on a sync one.
//
// POST { jobId, mode: 'scan'|'pinpoint', grids: [{ label, base64, times }],
//        facts: [{ caption, grab, kind }], durationSeconds }
// → writes { ok, matches } (scan) or { ok, pick } (pinpoint) to the job store,
//   where GET /.netlify/functions/tik-autopilot?job=<id> already knows how to
//   read it back. One poller for every background job.
//
// Haiku by default: picking a numbered cell out of a grid is selection, not
// judgement, and Haiku reads images at a fraction of the price.
import { getStore } from '@netlify/blobs';
import { callModelWithLabeledImages, parseModelJson } from './lib/ai-providers.mjs';
import { JOBS_STORE } from './lib/autopilot.mjs';
import {
  buildScanPrompt, buildPinpointPrompt, normalizeScan, normalizePinpoint, MAX_FACTS,
} from './lib/locate.mjs';

const MODEL = process.env.TIK_LOCATE_MODEL || 'claude-haiku-4-5';
const MAX_GRIDS = 8;                         // per call; the client sends six
const MAX_GRID_BYTES = 1.5 * 1024 * 1024;    // a 1536×648 JPEG is ~150KB
const JOB_ID = /^[a-zA-Z0-9-]{8,64}$/;

// The whole job, minus the job store: validate what came in, ask the model,
// check what came back. Separate from the handler so a test can drive it with
// a stand-in for the model and see exactly what the function would do.
export async function runLocate(body, { call = callModelWithLabeledImages, model = MODEL } = {}) {
  const mode = body?.mode === 'pinpoint' ? 'pinpoint' : 'scan';
  const grids = (Array.isArray(body?.grids) ? body.grids : [])
    .slice(0, mode === 'pinpoint' ? 1 : MAX_GRIDS)
    .map((g) => ({
      label: String(g?.label || '').toUpperCase().slice(0, 4),
      base64: String(g?.base64 || '').replace(/^data:[^,]+,/, ''),
      times: (Array.isArray(g?.times) ? g.times : []).map(Number).filter(Number.isFinite),
    }))
    .filter((g) => g.base64 && g.times.length);
  if (!grids.length) throw new Error('No grids to look at');
  for (const g of grids) {
    if (g.base64.length * 0.75 > MAX_GRID_BYTES) throw new Error(`Grid ${g.label} is too large`);
  }

  const facts = (Array.isArray(body?.facts) ? body.facts : []).slice(0, MAX_FACTS)
    .map((f) => ({ caption: String(f?.caption || ''), grab: String(f?.grab || ''), kind: f?.kind === 'title' ? 'title' : 'trivia' }));
  if (!facts.length) throw new Error('No facts to find');
  const durationSeconds = Math.max(0, Number(body?.durationSeconds) || 0);

  if (mode === 'scan') {
    const prompt = buildScanPrompt({ facts, grids, durationSeconds });
    const answer = await call(
      prompt,
      grids.map((g) => ({ label: `Grid ${g.label}`, base64: g.base64, mediaType: 'image/jpeg' })),
      model, AbortSignal.timeout(120_000), 2048,
    );
    return { ok: true, mode, matches: normalizeScan(parseModelJson(answer), { factCount: facts.length, grids }), model };
  }

  const [g] = grids;
  const step = g.times.length > 1 ? Math.round(((g.times.at(-1) - g.times[0]) / (g.times.length - 1)) * 10) / 10 : 0;
  const prompt = buildPinpointPrompt({ fact: facts[0], cellCount: g.times.length, firstSeconds: g.times[0], stepSeconds: step });
  const answer = await call(prompt, [{ label: '', base64: g.base64, mediaType: 'image/jpeg' }], model, AbortSignal.timeout(60_000), 1024);
  return { ok: true, mode, pick: normalizePinpoint(parseModelJson(answer), g.times.length), model };
}

export default async (req) => {
  let body;
  try { body = await req.json(); } catch { return; }
  const jobId = String(body?.jobId || '');
  if (!JOB_ID.test(jobId)) {
    console.error('[tik-locate] refused a job with a bad id');
    return;
  }

  const store = getStore(JOBS_STORE);
  const finish = (result) => store.setJSON(jobId, result, { metadata: { createdAt: Date.now() } })
    .catch((e) => console.error('[tik-locate] could not write the result', { jobId, message: e.message }));

  try {
    await store.setJSON(jobId, { started: true }, { metadata: { createdAt: Date.now() } });
    await finish(await runLocate(body));
  } catch (e) {
    console.error('[tik-locate] job failed', { jobId, message: e.message });
    await finish({ ok: false, error: e.message });
  }
};
