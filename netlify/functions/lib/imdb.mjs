// IMDb trivia + title search, straight from the GraphQL endpoint IMDb's own
// web app talks to. This replaces the "Pick IMDb trivia" bookmarklet: the
// bookmarklet existed because plain page fetches are walled off (www.imdb.com
// answers a server-side GET with 202 and an empty body, and api.graphql.imdb.com
// 403s), but caching.graphql.imdb.com answers normally as long as the request
// carries the client-name header the web app sends. That one header is the
// whole handshake — no cookies, no session, no WAF token.
//
// It is also strictly better data than scraping the page ever was: exact vote
// counts instead of the rounded "2.2K" the DOM shows, a spoiler flag per item,
// the film's runtime, and every item in two requests instead of clicking
// "See all" and walking 400 cards.
//
// The pure helpers (score/rank/normalize) are unit-tested; the fetch* helpers
// hit the network.

const ENDPOINT = 'https://caching.graphql.imdb.com/';
// Identifies us as the IMDb web client. Without it every request 403s.
const CLIENT_NAME = 'imdb-web-next-localized';
const PAGE_SIZE = 250;      // IMDb serves this happily; 325 items = 2 round trips
const MAX_PAGES = 12;       // hard stop, so a pathological title can't loop
const REQUEST_TIMEOUT_MS = 10_000;

export const IMDB_ID_RE = /^tt\d{5,10}$/;

const TRIVIA_QUERY = `query TikTrivia($id: ID!, $first: Int!, $after: ID) {
  title(id: $id) {
    id
    titleText { text }
    releaseYear { year }
    runtime { seconds }
    ratingsSummary { aggregateRating voteCount }
    trivia(first: $first, after: $after) {
      total
      pageInfo { hasNextPage endCursor }
      edges { node {
        id
        text { plainText }
        interestScore { usersInterested usersVoted }
        isSpoiler
      } }
    }
  }
}`;

const QUOTES_QUERY = `query TikQuotes($id: ID!, $first: Int!, $after: ID) {
  title(id: $id) {
    id
    titleText { text }
    releaseYear { year }
    runtime { seconds }
    ratingsSummary { aggregateRating voteCount }
    quotes(first: $first, after: $after) {
      total
      pageInfo { hasNextPage endCursor }
      edges { node {
        id
        lines { text characters { character } }
        interestScore { usersInterested usersVoted }
        isSpoiler
      } }
    }
  }
}`;

const SEARCH_QUERY = `query TikSearch($q: String!, $first: Int!) {
  mainSearch(first: $first, options: {
    searchTerm: $q, type: TITLE, titleSearchOptions: { type: [MOVIE] }
  }) {
    edges { node { entity { ... on Title {
      id
      titleText { text }
      releaseYear { year }
      runtime { seconds }
      ratingsSummary { aggregateRating voteCount }
      primaryImage { url }
    } } } }
  }
}`;

// ---- pure helpers ----

// How helpful IMDb's readers found an item, as a single sortable number.
//
// IMDb reports usersInterested (thumbs up) and usersVoted (up + down), so the
// downs are the difference. We rank on up minus down rather than raw ups so a
// contested item (300 up, 250 down) lands below a quieter one everybody agrees
// on (280 up, 5 down) — for a slideshow we want facts that land, not facts
// people are arguing about.
export function triviaScore(node) {
  const up = Math.max(0, Math.round(Number(node?.interestScore?.usersInterested) || 0));
  const total = Math.max(up, Math.round(Number(node?.interestScore?.usersVoted) || 0));
  return up - (total - up);
}

// One GraphQL trivia edge → the flat shape the rest of the app passes around.
// Returns null for anything without usable text, so callers can filter.
export function normalizeTrivia(node) {
  const text = String(node?.text?.plainText || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const up = Math.max(0, Math.round(Number(node?.interestScore?.usersInterested) || 0));
  const total = Math.max(up, Math.round(Number(node?.interestScore?.usersVoted) || 0));
  return {
    id: String(node?.id || ''),
    text,
    up,
    down: total - up,
    score: up - (total - up),
    spoiler: node?.isSpoiler === true,
  };
}

// Rank a batch most-helpful first, dropping blanks and duplicate ids.
// `id` then `text` break ties so the order is stable across identical scores
// (two items on 0 votes must not shuffle between runs — the pool's refill
// order depends on this being deterministic).
export function rankTrivia(nodes, { includeSpoilers = true } = {}) {
  const seen = new Set();
  const out = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const item = node && typeof node.text === 'string' ? node : normalizeTrivia(node);
    if (!item) continue;
    if (!includeSpoilers && item.spoiler) continue;
    const key = item.id || item.text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  out.sort((a, b) => b.score - a.score || b.up - a.up || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

export function quotePlainText(node) {
  const lines = Array.isArray(node?.lines) ? node.lines : [];
  const parts = [];
  for (const ln of lines) {
    const text = String(typeof ln?.text === 'string' ? ln.text : ln?.text?.plainText || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const who = String(ln?.characters?.[0]?.character || '').trim();
    parts.push(who ? `${who}: ${text}` : text);
  }
  // One line per character, not one run-on line. Two reasons, and they are the
  // same reason: a slide reads better with the exchange broken up the way it
  // was spoken, and the matcher's speaker-label strip is anchored per line, so
  // a glued-together exchange leaves every name after the first sitting in the
  // words we score against the subtitles.
  const fromLines = parts.join('\n').replace(/[ \t]+/g, ' ').trim();
  if (fromLines) return fromLines;
  return String(node?.text?.plainText || '').replace(/\s+/g, ' ').trim();
}

export function normalizeQuote(node) {
  const text = quotePlainText(node);
  if (!text) return null;
  const up = Math.max(0, Math.round(Number(node?.interestScore?.usersInterested) || 0));
  const total = Math.max(up, Math.round(Number(node?.interestScore?.usersVoted) || 0));
  return {
    id: String(node?.id || ''),
    text,
    up,
    down: total - up,
    score: up - (total - up),
    spoiler: node?.isSpoiler === true,
  };
}

export function rankQuotes(nodes, opts) {
  return rankTrivia(nodes, opts);
}

// A mainSearch entity → { id, title, year, runtimeSeconds, rating, votes }.
export function normalizeTitle(entity) {
  const id = String(entity?.id || '');
  const title = String(entity?.titleText?.text || '').trim();
  if (!IMDB_ID_RE.test(id) || !title) return null;
  const year = Number(entity?.releaseYear?.year);
  const runtime = Number(entity?.runtime?.seconds);
  const rating = Number(entity?.ratingsSummary?.aggregateRating);
  const votes = Number(entity?.ratingsSummary?.voteCount);
  return {
    id,
    title,
    year: Number.isFinite(year) ? year : null,
    runtimeSeconds: Number.isFinite(runtime) && runtime > 0 ? Math.round(runtime) : null,
    rating: Number.isFinite(rating) ? rating : null,
    votes: Number.isFinite(votes) ? votes : null,
    poster: typeof entity?.primaryImage?.url === 'string' ? entity.primaryImage.url : null,
  };
}

// ---- network ----

async function imdbGraphQL(query, variables, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/graphql+json, application/json',
        'x-imdb-client-name': CLIENT_NAME,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // 403 here almost always means the header handshake stopped working or
      // this egress IP is blocked — worth shouting about, it breaks every
      // trivia fetch at once.
      console.error('[imdb] graphql http error', { status: res.status, body: body.slice(0, 300) });
      throw new Error(`IMDb responded ${res.status}`);
    }
    const data = await res.json();
    if (data?.errors?.length) {
      console.error('[imdb] graphql errors', { errors: data.errors.slice(0, 3) });
      throw new Error(data.errors[0]?.message || 'IMDb query failed');
    }
    return data?.data || null;
  } finally {
    clearTimeout(timer);
  }
}

// Every trivia item for a title, ranked most-helpful first.
// Returns { movie, trivia, total, truncated } — `truncated` tells the caller we
// hit MAX_PAGES and there is more on IMDb, so "we saw everything" is never
// silently assumed.
export async function fetchTrivia(imdbId, { signal, includeSpoilers = true } = {}) {
  if (!IMDB_ID_RE.test(String(imdbId || ''))) throw new Error('Invalid IMDb id');
  const nodes = [];
  let after = null;
  let pages = 0;
  let movie = null;
  let total = 0;
  let hasNextPage = false;

  do {
    const data = await imdbGraphQL(TRIVIA_QUERY, { id: imdbId, first: PAGE_SIZE, after }, signal);
    const title = data?.title;
    if (!title) throw new Error('IMDb returned no title');
    if (!movie) {
      movie = normalizeTitle(title) || { id: imdbId, title: '', year: null, runtimeSeconds: null, rating: null, votes: null, poster: null };
    }
    const conn = title.trivia || {};
    total = Number(conn.total) || total;
    for (const edge of conn.edges || []) nodes.push(edge?.node);
    after = conn.pageInfo?.endCursor || null;
    hasNextPage = conn.pageInfo?.hasNextPage === true && !!after;
    pages += 1;
  } while (hasNextPage && pages < MAX_PAGES);

  return {
    movie,
    trivia: rankTrivia(nodes.map(normalizeTrivia), { includeSpoilers }),
    total,
    truncated: hasNextPage,
  };
}

export async function fetchQuotes(imdbId, { signal, includeSpoilers = true } = {}) {
  if (!IMDB_ID_RE.test(String(imdbId || ''))) throw new Error('Invalid IMDb id');
  const nodes = [];
  let after = null;
  let pages = 0;
  let movie = null;
  let total = 0;
  let hasNextPage = false;

  do {
    const data = await imdbGraphQL(QUOTES_QUERY, { id: imdbId, first: PAGE_SIZE, after }, signal);
    const title = data?.title;
    if (!title) throw new Error('IMDb returned no title');
    if (!movie) {
      movie = normalizeTitle(title) || { id: imdbId, title: '', year: null, runtimeSeconds: null, rating: null, votes: null, poster: null };
    }
    const conn = title.quotes || {};
    total = Number(conn.total) || total;
    for (const edge of conn.edges || []) nodes.push(edge?.node);
    after = conn.pageInfo?.endCursor || null;
    hasNextPage = conn.pageInfo?.hasNextPage === true && !!after;
    pages += 1;
  } while (hasNextPage && pages < MAX_PAGES);

  return {
    movie,
    quotes: rankQuotes(nodes.map(normalizeQuote), { includeSpoilers }),
    total,
    truncated: hasNextPage,
  };
}

// Title search for the "what movie?" box and for resolving AI-suggested titles.
export async function searchTitles(query, { first = 8, signal } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const data = await imdbGraphQL(SEARCH_QUERY, { q, first: Math.min(20, Math.max(1, first)) }, signal);
  const edges = data?.mainSearch?.edges || [];
  return edges.map((e) => normalizeTitle(e?.node?.entity)).filter(Boolean);
}

// Resolve a free-text "Home Alone (1990)" / "Home Alone" to one title. Prefers
// an exact title match, then a year match, then the top hit — IMDb's own
// relevance order is good, but "Home Alone" must not resolve to "Home Alone 3".
export async function resolveTitle(name, year = null, { signal } = {}) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  // Pull a trailing "(1990)" out of the name if the caller left it in.
  const paren = raw.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  const cleanName = paren ? paren[1].trim() : raw;
  const wantYear = Number(year) || (paren ? Number(paren[2]) : null);

  const hits = await searchTitles(cleanName, { first: 8, signal });
  if (!hits.length) return null;
  const lower = cleanName.toLowerCase();
  const exact = hits.filter((h) => h.title.toLowerCase() === lower);
  const pool = exact.length ? exact : hits;
  if (wantYear) {
    const byYear = pool.find((h) => h.year === wantYear)
      || pool.find((h) => Number.isFinite(h.year) && Math.abs(h.year - wantYear) <= 1);
    if (byYear) return byYear;
  }
  return pool[0];
}
