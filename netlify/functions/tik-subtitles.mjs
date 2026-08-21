// English SRT lookup for Quote-a-long. OpenSubtitles misses fail open:
// HTTP 200 with empty cues so Autopilot can still boil quotes without captions.
import { getStore } from '@netlify/blobs';
import { IMDB_ID_RE, resolveTitle } from './lib/imdb.mjs';
import { parseSrt } from './lib/srt.mjs';
import { downloadSubtitle, searchSubtitles } from './lib/opensubtitles.mjs';

const CACHE_STORE = 'tik-subtitles';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Under Netlify's 10s ceiling for a non-background function, the same way
// tik-autopilot's sync path aborts at 9s. Blowing the ceiling returns a
// platform 502, which the client cannot fail open from; aborting ourselves
// lands in the catch below and comes back as a normal "no subtitles" miss.
const BUDGET_MS = 8_500;

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const imdbId = String(body?.imdbId || '').trim();
  let id = IMDB_ID_RE.test(imdbId) ? imdbId : '';
  if (!id) {
    const query = String(body?.query || '').trim();
    if (!query) return json({ error: 'Give an imdbId or a query' }, 400);
    const title = await resolveTitle(query, body?.year);
    if (!title) return json({ error: `No movie found for "${query}"` }, 404);
    id = title.id;
  }
  const cached = await readCache(id);
  if (cached) return json({ ...cached, cached: true });
  const apiKey = process.env.OpenSubtitles || '';
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), BUDGET_MS);
  try {
    const picked = await searchSubtitles(id, { apiKey, signal: budget.signal });
    if (!picked) throw new Error('No English subtitle');
    const srt = await downloadSubtitle(picked.file_id, { apiKey, signal: budget.signal });
    const cues = parseSrt(srt);
    if (!cues.length) throw new Error('Empty subtitle parse');
    const value = { cues, missing: false, error: null };
    await writeCache(id, value);
    return json({ ...value, cached: false });
  } catch (e) {
    console.warn('[tik-subtitles] miss', { id, message: e.message });
    const value = { cues: [], missing: true, error: e.message || 'OpenSubtitles lookup failed' };
    return json({ ...value, cached: false });
  } finally {
    clearTimeout(timer);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

async function readCache(key) {
  try {
    const entry = await getStore(CACHE_STORE).get(key, { type: 'json' });
    if (!entry || !Number.isFinite(entry.at)) return null;
    if (Date.now() - entry.at > CACHE_TTL_MS) return null;
    return entry.value;
  } catch (e) {
    console.warn('[tik-subtitles] cache read failed', { key, message: e.message });
    return null;
  }
}

async function writeCache(key, value) {
  try {
    await getStore(CACHE_STORE).setJSON(key, { at: Date.now(), value });
  } catch (e) {
    console.warn('[tik-subtitles] cache write failed', { key, message: e.message });
  }
}
