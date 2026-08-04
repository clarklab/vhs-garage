// Remembering where the movie files live, so a file picked once stays picked.
//
// Two kinds of memory, both held as File System Access API handles in their
// own IndexedDB database ('tik-files', separate from the projects DB so the
// shipping store is never touched):
//   folder   the user's movies folder, granted once. Every draft — including
//            ones written after the grant — finds its own file inside it by
//            filename matching. This is the one that makes the tool run itself.
//   movie:*  a single file the user picked by hand, keyed by movie title+year.
//            Covers films living outside the folder and wrong/missed matches.
//
// Browser rules to know: handles persist across sessions, but a returning
// session may need one requestPermission() click to re-arm them (Chrome offers
// "allow on every visit", which drops even that). requestPermission must run
// inside a user gesture. Safari/Firefox have no showOpenFilePicker at all, so
// everything here degrades to the plain <input type=file>, exactly as before.
//
// The matching logic is pure and unit-tested. Its prime directive: on any
// uncertainty, MISS. A miss costs one manual pick (which is then remembered);
// a wrong match silently shoots another movie's frames into the draft.

import { parseMovieName } from './filename.js';

const DB_NAME = 'tik-files';
const STORE = 'handles';
const FOLDER_KEY = 'folder';
const MATCH_THRESHOLD = 60;
const VIDEO_EXT = /\.(mp4|m4v|mkv|mov|avi|webm|mpg|mpeg|wmv)$/i;
const WALK_DEPTH = 2; // movies folder → per-movie subfolder → file

// Call-time detection (not import-time) so a missing API is discovered where
// the fallback can be shown.
export function fsSupported() {
  return typeof window !== 'undefined'
    && typeof window.showOpenFilePicker === 'function'
    && typeof window.showDirectoryPicker === 'function';
}

// ---- pure: keys and matching ----

export function movieKeyFor(title, year) {
  const t = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const y = Number(year);
  return Number.isInteger(y) && y > 1800 ? `${t} ${y}` : t;
}

export function isVideoFilename(name) {
  return VIDEO_EXT.test(String(name || ''));
}

const tokensOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
const numerals = (tokens) => tokens.filter((t) => /^\d+$/.test(t)).sort().join(',');

// parseMovieName treats the FIRST year-like number as the release year and
// cuts the title there — which mangles titles that contain one: "Blade Runner
// 2049", "2001: A Space Odyssey", "1917". So every filename is read two ways:
// as-is, and with that first number protected so it stays part of the title
// (any later year then reads as the release year). The scorer takes the
// better reading; for ordinary names the second reading just scores lower.
function parseVariants(filename) {
  const name = String(filename);
  const variants = [parseMovieName(name)];
  const m = name.match(/\b(19\d{2}|20\d{2})\b/);
  if (m) {
    const shield = `q${m[1]}q`; // survives parsing as an ordinary token
    const marked = name.slice(0, m.index) + shield + name.slice(m.index + m[1].length);
    const p = parseMovieName(marked);
    variants.push({ title: p.title.replace(new RegExp(shield, 'ig'), m[1]), year: p.year });
  }
  return variants;
}

// How confidently `filename` is the movie `title` (`year`). 0–105; the
// threshold for acting is MATCH_THRESHOLD.
//
// - Identical parsed titles: 90. parseMovieName already strips scene-release
//   junk ("Home.Alone.1990.1080p.BluRay.x264" → "Home Alone").
// - File title ⊆ draft title: 70, but ONLY when their digit tokens agree —
//   sequel numbers are load-bearing, and this rule is what keeps a bare
//   "Home Alone" rip from matching a Home Alone 2 draft (and vice versa).
// - Otherwise token-overlap F1 × 70, which lands under the threshold for
//   near-misses like sequels (0.8 × 70 = 56).
// - Year: +15 when both known and equal, −40 when both known and different.
//   The −40 is what kills wrong remakes ("The Thing" 1982 vs 2011: 90−40=50).
export function scoreCandidate(filename, title, year) {
  if (!isVideoFilename(filename)) return 0;
  const b = tokensOf(title);
  if (!b.length) return 0;
  let best = 0;
  for (const parsed of parseVariants(filename)) {
    const a = tokensOf(parsed.title);
    if (!a.length) continue;

    let score;
    if (a.join(' ') === b.join(' ')) {
      score = 90;
    } else {
      const setB = new Set(b);
      const inter = a.filter((t) => setB.has(t)).length;
      const subset = inter === a.length && a.length >= 1;
      if (subset && numerals(a) === numerals(b)) score = 70;
      else score = (2 * inter / (a.length + b.length)) * 70;
    }

    const fy = Number(parsed.year);
    const wy = Number(year);
    if (Number.isInteger(fy) && fy > 1800 && Number.isInteger(wy) && wy > 1800) {
      score += fy === wy ? 15 : -40;
    }
    best = Math.max(best, score);
  }
  return best;
}

// The best-matching filename from a listing, or null when nothing clears the
// threshold. Ties break toward the higher score, then the shorter name (a
// plain rip over a directors-cut-extras variant).
export function pickBestFile(names, title, year, threshold = MATCH_THRESHOLD) {
  let best = null;
  let bestScore = threshold;
  for (const name of Array.isArray(names) ? names : []) {
    const s = scoreCandidate(name, title, year);
    if (s > bestScore || (s === bestScore && best && String(name).length < best.length)) {
      bestScore = s;
      best = String(name);
    }
  }
  return best;
}

// ---- storage (IndexedDB + a session cache) ----

// Live handles are also kept in-memory: repeated lookups skip the DB, and a
// handle that can't be structured-cloned (never true for real ones) still
// works for the session.
const cache = new Map();

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(key, value) {
  cache.set(key, value);
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    // Session-only memory still works; say so rather than dying.
    console.warn('[tik-files] could not persist a handle (session-only)', { key, message: e.message });
  }
}

async function dbGet(key) {
  if (cache.has(key)) return cache.get(key);
  try {
    const db = await openDB();
    const value = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (value) cache.set(key, value);
    return value || null;
  } catch (e) {
    console.warn('[tik-files] handle read failed', { key, message: e.message });
    return null;
  }
}

async function permissionOf(handle) {
  try {
    return (await handle.queryPermission?.({ mode: 'read' })) || 'prompt';
  } catch {
    return 'prompt';
  }
}

// Ask the browser to re-arm a stored handle. MUST be called from a user
// gesture (a click) or Chrome rejects it outright.
export async function armHandle(handle) {
  try {
    return (await handle.requestPermission?.({ mode: 'read' })) === 'granted';
  } catch (e) {
    console.warn('[tik-files] permission request failed', { message: e.message });
    return false;
  }
}

// ---- the movies folder ----

export async function setMoviesFolder() {
  try {
    const handle = await window.showDirectoryPicker({ id: 'tik-movies', mode: 'read' });
    await dbPut(FOLDER_KEY, { handle, name: handle.name, savedAt: Date.now() });
    return { handle, name: handle.name, state: 'granted' };
  } catch (e) {
    if (e?.name === 'AbortError') return null; // user closed the picker
    console.error('[tik-files] folder pick failed', { message: e.message });
    return null;
  }
}

export async function getMoviesFolder() {
  const rec = await dbGet(FOLDER_KEY);
  if (!rec?.handle) return null;
  return { handle: rec.handle, name: rec.name || rec.handle.name, state: await permissionOf(rec.handle) };
}

// Walk the folder (bounded depth, dot-entries skipped) and return
// { name, handle } for the file that best matches, or null.
export async function findFileInFolder(folderHandle, title, year) {
  const found = new Map(); // filename → file handle (first wins on duplicates)
  async function walk(dir, depth) {
    for await (const entry of dir.values()) {
      if (entry.name.startsWith('.')) continue;
      if (entry.kind === 'file') {
        if (isVideoFilename(entry.name) && !found.has(entry.name)) found.set(entry.name, entry);
      } else if (entry.kind === 'directory' && depth < WALK_DEPTH) {
        await walk(entry, depth + 1);
      }
    }
  }
  try {
    await walk(folderHandle, 0);
  } catch (e) {
    console.warn('[tik-files] folder walk failed', { message: e.message });
    return null;
  }
  const best = pickBestFile([...found.keys()], title, year);
  return best ? { name: best, handle: found.get(best) } : null;
}

// ---- single-file memory ----

export async function pickMovieFile(title, year) {
  try {
    const [handle] = await window.showOpenFilePicker({
      id: 'tik-movie',
      multiple: false,
      types: [{ description: 'Movie file', accept: { 'video/*': ['.mp4', '.m4v', '.mkv', '.mov', '.avi', '.webm'] } }],
    });
    if (!handle) return null;
    const key = movieKeyFor(title, year);
    if (key) await dbPut(`movie:${key}`, { handle, name: handle.name, savedAt: Date.now() });
    return { handle, file: await handle.getFile() };
  } catch (e) {
    if (e?.name === 'AbortError') return null;
    console.error('[tik-files] file pick failed', { message: e.message });
    return null;
  }
}

// ---- resolution: "where is this movie's file?" ----

// Returns { label, state, armTarget, load() } or null when nothing is
// remembered. state 'granted' means load() will work right now; 'prompt'
// means call armHandle(armTarget) from a click first, then resolve again.
// Granted sources always beat prompt ones, so a granted folder match is
// preferred over a hand-picked handle that needs re-arming.
export async function resolveMovie(title, year) {
  if (!fsSupported() || !String(title || '').trim()) return null;
  const candidates = [];

  const rec = await dbGet(`movie:${movieKeyFor(title, year)}`)
    || (year ? await dbGet(`movie:${movieKeyFor(title, null)}`) : null);
  if (rec?.handle) {
    candidates.push({
      label: rec.name || 'your picked file',
      state: await permissionOf(rec.handle),
      armTarget: rec.handle,
      load: () => rec.handle.getFile(),
    });
  }

  const folder = await getMoviesFolder();
  if (folder) {
    if (folder.state === 'granted') {
      const hit = await findFileInFolder(folder.handle, title, year);
      if (hit) {
        candidates.push({
          label: hit.name,
          state: 'granted',
          armTarget: folder.handle,
          load: () => hit.handle.getFile(),
        });
      }
    } else {
      // Can't search a locked folder — surface it as an armable source.
      candidates.push({
        label: `your movies folder (${folder.name})`,
        state: 'prompt',
        armTarget: folder.handle,
        load: async () => {
          const again = await findFileInFolder(folder.handle, title, year);
          if (!again) throw new Error('No matching file in the movies folder.');
          return again.handle.getFile();
        },
      });
    }
  }

  return candidates.find((c) => c.state === 'granted') || candidates[0] || null;
}
