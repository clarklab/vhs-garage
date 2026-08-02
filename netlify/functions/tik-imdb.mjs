// IMDb lookups for the studio: title search and the full ranked trivia pool.
// This is what replaced the "Pick IMDb trivia" bookmarklet — the browser asks
// us, we ask IMDb, and the ranking happens here so every client sees the same
// order.
//
// - POST { action: 'search', query }        → { titles: [...] }
// - POST { action: 'trivia', imdbId }       → { movie, trivia, total, truncated, cached }
// - POST { action: 'trivia', query, year }  → same, resolving the name first
//
// Trivia is cached in Blobs for a day. A film's trivia list barely moves, the
// vote counts move slowly, and a batch run over ten movies would otherwise
// re-fetch the same few hundred items every time the user reshuffles a pool.
import { getStore } from '@netlify/blobs';
import { fetchTrivia, searchTitles, resolveTitle, IMDB_ID_RE } from './lib/imdb.mjs';

const CACHE_STORE = 'tik-imdb';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const action = String(body?.action || 'trivia');

  try {
    if (action === 'search') {
      const query = String(body?.query || '').trim();
      if (!query) return json({ error: 'Missing search query' }, 400);
      const titles = await searchTitles(query, { first: Number(body?.first) || 8 });
      return json({ titles });
    }

    if (action === 'trivia') {
      const imdbId = String(body?.imdbId || '').trim();
      let target = IMDB_ID_RE.test(imdbId) ? { id: imdbId } : null;

      // No id? Resolve the name the caller gave us ("Home Alone", 1990).
      if (!target) {
        const query = String(body?.query || '').trim();
        if (!query) return json({ error: 'Give an imdbId or a query' }, 400);
        target = await resolveTitle(query, body?.year);
        if (!target) return json({ error: `No movie found for "${query}"` }, 404);
      }

      const includeSpoilers = body?.includeSpoilers !== false;
      const cacheKey = `${target.id}:${includeSpoilers ? 'all' : 'nospoil'}`;
      const cached = await readCache(cacheKey);
      if (cached) return json({ ...cached, cached: true });

      const result = await fetchTrivia(target.id, { includeSpoilers });
      // resolveTitle already knows the year/runtime; keep whichever is richer.
      if (target.title && !result.movie.title) result.movie = { ...result.movie, ...target };
      await writeCache(cacheKey, result);
      return json({ ...result, cached: false });
    }

    return json({ error: `Unknown action "${action}"` }, 400);
  } catch (e) {
    console.error('[tik-imdb] request failed', { action, message: e.message });
    return json({ error: e.message || 'IMDb lookup failed' }, 502);
  }
};

async function readCache(key) {
  try {
    const entry = await getStore(CACHE_STORE).get(key, { type: 'json' });
    if (!entry || !Number.isFinite(entry.at)) return null;
    if (Date.now() - entry.at > CACHE_TTL_MS) return null;
    return entry.value;
  } catch (e) {
    // A cache miss must never be fatal — fall through to a live fetch.
    console.warn('[tik-imdb] cache read failed', { key, message: e.message });
    return null;
  }
}

async function writeCache(key, value) {
  try {
    await getStore(CACHE_STORE).setJSON(key, { at: Date.now(), value });
  } catch (e) {
    console.warn('[tik-imdb] cache write failed', { key, message: e.message });
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
