// OpenSubtitles REST v1: pick an English human SRT for an IMDb title.
// Zip payloads are treated as a miss — we do not unzip.
//
// Downloads are ANONYMOUS-FIRST. A consumer (the thing an Api-Key belongs to)
// can be configured to allow downloads with no user token at all — there is a
// checkbox for it, and an "under dev" one that lifts the anonymous allowance
// to 100 a day. Plenty of keys are set up that way, so refusing to try without
// a username and password would break a perfectly good install.
//
// The Bearer JWT from /login is therefore a FALLBACK, used only when the API
// actually answers 401. It also raises the ceiling for a consumer that has not
// enabled anonymous downloads. Login is expensive and rate-limited at the far
// end, so the token is cached and only re-fetched when missing or stale.

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

// The credentials, and a single place that decides what we can attempt.
//
// `canTry` is the only gate that matters: with a key we can always attempt an
// anonymous download. `canLogin` says whether the 401 fallback is available.
export function osCredentials(env = process.env) {
  const apiKey = env.OpenSubtitles || env.OPENSUBTITLES_API_KEY || '';
  const username = env.OPENSUBTITLES_USERNAME || '';
  const password = env.OPENSUBTITLES_PASSWORD || '';
  return { apiKey, username, password, canTry: !!apiKey, canLogin: !!(apiKey && username && password) };
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

// Hearing-impaired tracks carry bracketed sound cues on top of the dialogue.
// They match fine, but a clean dialogue track is the better default when both
// exist, so this is a preference and never an exclusion.
function isHearingImpaired(row) {
  return row?.attributes?.hearing_impaired === true;
}

// NOTE: there is deliberately no filter on the file's extension here.
//
// `file_name` on an OpenSubtitles file is the RELEASE name — "The.Princess.
// Bride.1987.DVDRip", "...REMUX...-FGT.en-HI" — and essentially never ends in
// ".srt". Requiring that extension threw away every English subtitle for every
// film and reported "no English subtitle for this title", which for a film like
// The Princess Bride (44 English tracks) was plainly untrue. The format is
// decided at DOWNLOAD time by asking for sub_format: srt, which the API
// converts to; the stored file's name says nothing about what we can get.
export function pickBestSubtitle(rows) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter(isEnglish)
    .filter(isHuman)
    .map((row) => {
      const file = filesOf(row)[0];
      if (!file?.file_id) return null;
      return {
        file_id: file.file_id,
        file_name: file.file_name || '',
        clean: isHearingImpaired(row) ? 0 : 1,
        trusted: row.attributes?.from_trusted === true ? 1 : 0,
        downloads: Number(row.attributes?.download_count) || 0,
      };
    })
    .filter(Boolean);
  // Most-downloaded is the strongest signal that a track matches the common
  // cut of the film, so it outranks the trusted flag.
  list.sort((a, b) => b.clean - a.clean || b.downloads - a.downloads || b.trusted - a.trusted);
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
  // No token is a normal call, not an error: the consumer may allow it.
  const res = await fetchWithTimeout(DOWNLOAD, {
    method: 'POST',
    headers: {
      'Api-Key': apiKey,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'User-Agent': OS_USER_AGENT,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    // Ask for SRT rather than hoping the stored file is one. /infos/formats
    // lists srt as an output format, so this is a conversion the API does.
    body: JSON.stringify({ file_id: fileId, sub_format: 'srt' }),
    signal,
  });
  if (!res.ok) {
    // Carry the status so the caller can tell "log in and try again" apart from
    // "today's allowance is gone", which are the same words to a human and very
    // different instructions. The body often names the real reason; keep it.
    const detail = await res.text().catch(() => '');
    const err = new Error(res.status === 406
      ? 'OpenSubtitles download quota is spent for today'
      : `OpenSubtitles download ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  // The download response is the only place the allowance is visible. Logging
  // it means "quota is spent" arrives as a number you watched fall, not as a
  // surprise in the middle of a batch.
  if (Number.isFinite(Number(body?.remaining))) {
    console.log('[opensubtitles] download ok', { remaining: body.remaining, resetsIn: body.reset_time });
  }
  const link = body?.link;
  if (!link) throw new Error('OpenSubtitles returned no link');
  const file = await fetchWithTimeout(link, { signal, headers: { 'User-Agent': OS_USER_AGENT } });
  if (!file.ok) throw new Error(`Subtitle file ${file.status}`);
  const buf = Buffer.from(await file.arrayBuffer());
  const head = buf.slice(0, 4).toString('utf8');
  if (head.startsWith('PK')) throw new Error('Subtitle was a zip');
  return buf.toString('utf8');
}
