// OpenSubtitles REST v1: pick an English human SRT for an IMDb title.
// Zip payloads are treated as a miss — we do not unzip.
//
// Two credentials, not one. SEARCH is happy with the Api-Key alone, but
// DOWNLOAD also wants an Authorization: Bearer JWT that you get by POSTing a
// username and password to /login. Sending only the key meant every search
// succeeded, every download failed, and every quote came back with a guessed
// timecode — a silent, total failure that looked like a matching problem.
//
// Login is expensive and rate-limited at the far end, so the token is cached
// and only re-fetched when it is missing or stale.

export const OS_USER_AGENT = 'vhs-garage v1.0';
const SEARCH = 'https://api.opensubtitles.com/api/v1/subtitles';
const DOWNLOAD = 'https://api.opensubtitles.com/api/v1/download';
const LOGIN = 'https://api.opensubtitles.com/api/v1/login';
// Per hop, not per call. A lookup is THREE round trips (search, download
// ticket, then the file itself) and the endpoint that runs them is a plain
// Netlify function on a 10-second ceiling, so a 10s-per-hop budget could spend
// 30 and come back as a platform 502 instead of a graceful miss.
const REQUEST_TIMEOUT_MS = 4_000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const relay = () => controller.abort();
  // One caller signal covers all three hops, so the listener has to come back
  // off again — otherwise each hop leaves another one attached to it.
  if (options.signal) options.signal.addEventListener('abort', relay, { once: true });
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', relay);
  }
}

// Tokens are good for about a day at the far end; refresh well inside that.
export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

// The credentials, and a single place that decides whether we have them.
// Returns null rather than throwing so the caller can say something useful.
export function osCredentials(env = process.env) {
  const apiKey = env.OpenSubtitles || env.OPENSUBTITLES_API_KEY || '';
  const username = env.OPENSUBTITLES_USERNAME || '';
  const password = env.OPENSUBTITLES_PASSWORD || '';
  return { apiKey, username, password, canDownload: !!(apiKey && username && password) };
}

export async function login({ apiKey, username, password, signal } = {}) {
  if (!apiKey) throw new Error('OpenSubtitles key missing');
  if (!username || !password) {
    throw new Error('OpenSubtitles needs a login: set OPENSUBTITLES_USERNAME and OPENSUBTITLES_PASSWORD');
  }
  const res = await fetchWithTimeout(LOGIN, {
    method: 'POST',
    headers: {
      'Api-Key': apiKey,
      'User-Agent': OS_USER_AGENT,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, password }),
    signal,
  });
  if (!res.ok) {
    // 401 here means the username or password is wrong, not that we asked
    // wrongly. Retrying with the same credentials is what gets an app blocked.
    throw new Error(res.status === 401
      ? 'OpenSubtitles rejected the username or password'
      : `OpenSubtitles login ${res.status}`);
  }
  const body = await res.json();
  if (!body?.token) throw new Error('OpenSubtitles login returned no token');
  return body.token;
}

export function numericImdbId(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^tt(\d{5,10})$/i) || s.match(/^(\d{5,10})$/);
  return m ? String(Number(m[1])) : null;
}

function filesOf(row) {
  return Array.isArray(row?.attributes?.files) ? row.attributes.files : [];
}

function isEnglish(row) {
  const lang = String(row?.attributes?.language || '').toLowerCase();
  return lang === 'en' || lang.startsWith('en-');
}

function isHuman(row) {
  const a = row?.attributes || {};
  return a.ai_translated !== true && a.machine_translated !== true && a.auto_translated !== true;
}

function srtFile(file) {
  return /\.srt$/i.test(String(file?.file_name || '')) || !file?.file_name;
}

export function pickBestSubtitle(rows) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter(isEnglish)
    .filter(isHuman)
    .map((row) => {
      const file = filesOf(row).find(srtFile) || filesOf(row)[0];
      if (!file?.file_id) return null;
      if (file.file_name && !srtFile(file)) return null;
      return {
        file_id: file.file_id,
        file_name: file.file_name || '',
        trusted: row.attributes?.from_trusted === true ? 1 : 0,
        downloads: Number(row.attributes?.download_count) || 0,
      };
    })
    .filter(Boolean);
  list.sort((a, b) => b.trusted - a.trusted || b.downloads - a.downloads);
  return list[0] || null;
}

export async function searchSubtitles(imdbId, { apiKey, signal } = {}) {
  const numeric = numericImdbId(imdbId);
  if (!numeric) throw new Error('Invalid IMDb id');
  if (!apiKey) throw new Error('OpenSubtitles key missing');
  const url = new URL(SEARCH);
  url.searchParams.set('imdb_id', numeric);
  url.searchParams.set('languages', 'en');
  const res = await fetchWithTimeout(url, {
    headers: { 'Api-Key': apiKey, 'User-Agent': OS_USER_AGENT, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`OpenSubtitles search ${res.status}`);
  const body = await res.json();
  return pickBestSubtitle(body?.data || []);
}

export async function downloadSubtitle(fileId, { apiKey, token, signal } = {}) {
  if (!fileId) throw new Error('Missing subtitle file');
  if (!apiKey) throw new Error('OpenSubtitles key missing');
  if (!token) throw new Error('OpenSubtitles download needs a login token');
  const res = await fetchWithTimeout(DOWNLOAD, {
    method: 'POST',
    headers: {
      'Api-Key': apiKey,
      Authorization: `Bearer ${token}`,
      'User-Agent': OS_USER_AGENT,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file_id: fileId }),
    signal,
  });
  if (!res.ok) {
    // These two are the ones worth naming: a stale token and a spent daily
    // allowance look identical from the outside otherwise.
    if (res.status === 401) throw new Error('OpenSubtitles login token was rejected');
    if (res.status === 406) throw new Error('OpenSubtitles download quota is spent for today');
    throw new Error(`OpenSubtitles download ${res.status}`);
  }
  const body = await res.json();
  const link = body?.link;
  if (!link) throw new Error('OpenSubtitles returned no link');
  const file = await fetchWithTimeout(link, { signal, headers: { 'User-Agent': OS_USER_AGENT } });
  if (!file.ok) throw new Error(`Subtitle file ${file.status}`);
  const buf = Buffer.from(await file.arrayBuffer());
  const head = buf.slice(0, 4).toString('utf8');
  if (head.startsWith('PK')) throw new Error('Subtitle was a zip');
  return buf.toString('utf8');
}
