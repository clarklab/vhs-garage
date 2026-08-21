// English SRT lookup for Quote-a-long. OpenSubtitles misses fail open:
// HTTP 200 with empty cues so Autopilot can still boil quotes without captions.
import { getStore } from '@netlify/blobs';
import { IMDB_ID_RE, resolveTitle } from './lib/imdb.mjs';
import { parseSrt } from './lib/srt.mjs';
import { downloadSubtitle, searchSubtitles, login, osCredentials, TOKEN_TTL_MS } from './lib/opensubtitles.mjs';

const CACHE_STORE = 'tik-subtitles';
// Reserved key in the same store. IMDb ids all start with "tt", so it can
// never collide with a cached film.
const TOKEN_KEY = 'auth-token';
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
  const { apiKey, username, password, canTry, canLogin } = osCredentials();
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), BUDGET_MS);
  try {
    if (!canTry) throw new Error('OpenSubtitles API key missing: set OpenSubtitles');
    const picked = await searchSubtitles(id, { apiKey, signal: budget.signal });
    if (!picked) throw new Error('No English subtitle for this title');
    const srt = await fetchSrt(picked.file_id, { apiKey, username, password, canLogin, signal: budget.signal });
    const cues = parseSrt(srt);
    if (!cues.length) throw new Error('Empty subtitle parse');
    const value = { cues, missing: false, error: null };
    await writeCache(id, value);
    return json({ ...value, cached: false });
  } catch (e) {
    // An abort is our own budget firing, not OpenSubtitles saying no. Naming it
    // matters: "took too long" and "refused us" lead to completely different
    // next steps, and both used to read as "this film has no subtitles".
    const aborted = e?.name === 'AbortError' || e?.name === 'TimeoutError';
    const message = aborted
      ? `OpenSubtitles did not answer within ${Math.round(BUDGET_MS / 100) / 10}s, so the lookup was cut short to stay inside the function limit`
      : (e.message || 'OpenSubtitles lookup failed');
    console.warn('[tik-subtitles] miss', { id, aborted, message });
    const value = { cues: [], missing: true, error: message };
    return json({ ...value, cached: false });
  } finally {
    clearTimeout(timer);
  }
};

// Anonymous first, log in only if the API says we must.
//
// A consumer can be set up to allow downloads with no user token — there is a
// checkbox for it, and an "under dev" one that lifts that allowance to 100 a
// day. Demanding a username and password up front would break exactly those
// installs, so the token is a fallback for a real 401 and nothing more.
async function fetchSrt(fileId, { apiKey, username, password, canLogin, signal }) {
  try {
    return await downloadSubtitle(fileId, { apiKey, signal });
  } catch (e) {
    if (e.status !== 401) throw e;
    if (!canLogin) {
      throw new Error('OpenSubtitles wants a login for downloads. Either tick anonymous downloads on this API key\u2019s consumer, or set OPENSUBTITLES_USERNAME and OPENSUBTITLES_PASSWORD.');
    }
    console.warn('[tik-subtitles] anonymous download refused, logging in');
    const token = await authToken({ apiKey, username, password, signal });
    return await downloadSubtitle(fileId, { apiKey, token, signal });
  }
}

// One login per half-day, shared by every invocation through the blob store.
// Logging in per request is what gets an app rate-limited at the far end.
async function authToken({ apiKey, username, password, signal }) {
  const store = getStore(CACHE_STORE);
  try {
    const entry = await store.get(TOKEN_KEY, { type: 'json' });
    if (entry?.token && Number.isFinite(entry.at) && Date.now() - entry.at < TOKEN_TTL_MS) return entry.token;
  } catch (e) {
    console.warn('[tik-subtitles] token cache read failed', { message: e.message });
  }
  const token = await login({ apiKey, username, password, signal });
  try {
    await store.setJSON(TOKEN_KEY, { at: Date.now(), token });
  } catch (e) {
    console.warn('[tik-subtitles] token cache write failed', { message: e.message });
  }
  return token;
}

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
