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
const WALK_DEPTH = 3;        // movies → genre/collection → per-movie folder → file
const WALK_MAX_FILES = 50_000; // a runaway walk (home dir picked by mistake) stops, loudly

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
// 2049", "2001: A Space Odyssey", "1917". And scene names use hyphens where
// it expects dots ("Title-1080p.GROUP"), which walls off the quality junk it
// would otherwise strip. So every filename is read several ways — as-is, with
// hyphens as separators, and with the first number protected so it stays part
// of the title — and the scorer takes the best reading. For ordinary names
// the extra readings just score lower.
function parseVariants(filename) {
  const variants = [];
  for (const name of new Set([String(filename), String(filename).replace(/-/g, '.')])) {
    variants.push(parseMovieName(name));
    const m = name.match(/\b(19\d{2}|20\d{2})\b/);
    if (m) {
      const shield = `q${m[1]}q`; // survives parsing as an ordinary token
      const marked = name.slice(0, m.index) + shield + name.slice(m.index + m[1].length);
      const p = parseMovieName(marked);
      variants.push({ title: p.title.replace(new RegExp(shield, 'ig'), m[1]), year: p.year });
    }
  }
  return variants;
}

// Tokens that mark a different film in the same franchise. An extra one of
// these in a filename means "this is NOT the movie you asked for", so they
// veto the loose-match bonus below. v and x are ambiguous (V for Vendetta,
// Malcolm X) but only as EXTRA tokens — shared ones never reach the check —
// and vetoing costs a miss, never a wrong match.
const SEQUEL_MARKERS = new Set(['ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'part']);

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
      const setA = new Set(a);
      const setB = new Set(b);
      const inter = a.filter((t) => setB.has(t)).length;
      const fileInDraft = inter === a.length && a.length >= 1;
      // The messy-rip case: every draft-title word is in the filename, plus
      // leftovers ("Names.Like.This-1080p.NiGHT" → extra tokens 1080p, night —
      // quality junk the parser missed and the release group). Those extras
      // are fine UNLESS one is a sequel marker: an extra "2" or "ii" means a
      // different film, and vetoing costs a miss, never a wrong match.
      const draftInFile = b.every((t) => setA.has(t));
      const extras = a.filter((t) => !setB.has(t));
      const extrasSafe = !extras.some((t) => /^\d+$/.test(t) || SEQUEL_MARKERS.has(t));
      if (fileInDraft && numerals(a) === numerals(b)) score = 70;
      else if (draftInFile && extrasSafe) score = 70;
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

// ONE connection, opened once, with a timeout.
//
// The old version opened a fresh connection per read and never closed any, and
// indexedDB.open() can hang forever with no error and no console output when
// it's blocked by another connection or a pending version change. That is a
// silent, unrecoverable freeze — and it is the most likely cause of a Shoot
// step that sat on one line for minutes saying nothing. A timeout turns it
// into an error we can show; onblocked says WHY.
const DB_OPEN_TIMEOUT_MS = 8_000;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => {
      dbPromise = null; // let a later call retry rather than caching the failure
      done(reject, new Error('The file-memory database did not open (another tab may be holding it open — close other VHS Studio tabs and reload).'));
    }, DB_OPEN_TIMEOUT_MS);

    let req;
    try { req = indexedDB.open(DB_NAME, 1); }
    catch (e) { return done(reject, e); }

    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onblocked = () => console.warn('[tik-files] IndexedDB open is blocked by another tab');
    req.onsuccess = () => {
      const db = req.result;
      // A version change from another tab would otherwise wedge this handle.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      done(resolve, db);
    };
    req.onerror = () => { dbPromise = null; done(reject, req.error); };
  });
  return dbPromise;
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
    console.warn(`[tik-files] could not persist "${key}" (session-only): ${e.message}`, e);
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
    console.warn(`[tik-files] could not read "${key}": ${e.message}`, e);
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

// Chrome allows exactly ONE file/directory picker at a time and throws
// "File picker already active" on a second — easy to trigger by double
// clicking, or by clicking Pick while the folder dialog is still open.
// One flag guards both pickers; callers get null, same as a cancel.
let pickerOpen = false;

export async function setMoviesFolder() {
  if (pickerOpen) return null;
  pickerOpen = true;
  try {
    const handle = await window.showDirectoryPicker({ id: 'tik-movies', mode: 'read' });
    invalidateFolderIndex(); // a different (or refreshed) folder — re-list it
    await dbPut(FOLDER_KEY, { handle, name: handle.name, savedAt: Date.now() });
    return { handle, name: handle.name, state: 'granted' };
  } catch (e) {
    if (e?.name === 'AbortError') return null; // user closed the picker
    console.error(`[tik-files] folder pick failed: ${e.message}`, e);
    return null;
  } finally {
    pickerOpen = false;
  }
}

export async function getMoviesFolder() {
  const rec = await dbGet(FOLDER_KEY);
  if (!rec?.handle) return null;
  return { handle: rec.handle, name: rec.name || rec.handle.name, state: await permissionOf(rec.handle) };
}

// The folder is walked ONCE per session and the listing cached — a big
// library was being re-scanned on every draft select, which read as a freeze.
// Invalidated when the folder is re-picked or re-armed (contents may differ).
let folderIndex = null; // { dirHandle, files: Map(name → handle), truncated }

export function invalidateFolderIndex() {
  folderIndex = null;
}

// Hand control back to the browser so it can actually paint.
//
// This is THE fix for the "long freeze": `for await (const entry of dir.values())`
// settles in MICROtasks, and microtasks never yield a render opportunity. The
// whole walk ran as one uninterrupted job, so progress text written during it
// was invisible until the walk finished — a frozen tab with a stale screen.
// A real macrotask (setTimeout/scheduler.yield) lets a frame render.
// Yield on a TIME slice, not an entry count.
//
// scheduler.yield() is preferred because setTimeout is clamped to 1000ms in a
// backgrounded tab — a count-based setTimeout yield turned a 4s scan into
// minutes when the tab lost focus, which is measurably worse than the freeze
// it was fixing. Slicing on elapsed time bounds it from both ends: the thread
// is never held for more than SLICE_MS, and a throttled fallback can only cost
// one timeout per slice rather than one per N entries.
const SLICE_MS = 50;
let sliceStart = 0;
const rawYield = () =>
  (globalThis.scheduler?.yield?.() ?? new Promise((r) => setTimeout(r, 0)));

async function maybeYield() {
  const now = performance.now();
  if (now - sliceStart < SLICE_MS) return false;
  sliceStart = now;
  await rawYield();
  return true;
}

// onProgress({ files, videos, dir }) fires often enough to look alive.
// signal aborts a walk in flight (switching drafts, leaving the screen).
async function buildFolderIndex(folderHandle, { onProgress = () => {}, signal } = {}) {
  if (folderIndex && (folderIndex.dirHandle === folderHandle
    || await folderHandle.isSameEntry?.(folderIndex.dirHandle).catch(() => false))) {
    return folderIndex;
  }
  const files = new Map(); // filename → file handle (first wins on duplicates)
  let truncated = false;
  let seen = 0;
  sliceStart = performance.now();

  async function walk(dir, depth) {
    for await (const entry of dir.values()) {
      if (truncated || signal?.aborted) return;
      // Report only when we actually yield: a progress line the browser has no
      // chance to paint is just wasted work.
      if (await maybeYield()) onProgress({ files: seen, videos: files.size, dir: dir.name });
      if (entry.name.startsWith('.')) continue;
      if (entry.kind === 'file') {
        if (++seen > WALK_MAX_FILES) { truncated = true; return; }
        if (isVideoFilename(entry.name) && !files.has(entry.name)) files.set(entry.name, entry);
      } else if (entry.kind === 'directory' && depth < WALK_DEPTH) {
        await walk(entry, depth + 1);
      }
    }
  }

  await walk(folderHandle, 0);
  if (signal?.aborted) throw new DOMException('Folder scan cancelled', 'AbortError');
  if (truncated) console.warn('[tik-files] folder walk stopped at the file cap', { cap: WALK_MAX_FILES });
  onProgress({ files: seen, videos: files.size, dir: folderHandle.name, done: true });
  folderIndex = { dirHandle: folderHandle, files, truncated, scannedFiles: seen, at: Date.now() };
  return folderIndex;
}

// Scan the folder up front (right after it's granted) so the first draft
// lookup is instant instead of paying for the walk mid-flow.
export async function indexFolder(folderHandle, opts) {
  const index = await buildFolderIndex(folderHandle, opts);
  await saveFolderIndex(folderHandle.name, index.files);
  return { videos: index.files.size, scanned: index.scannedFiles ?? index.files.size, truncated: index.truncated };
}

// What the cached index knows, for UI that wants to report it without a walk.
export function folderIndexInfo() {
  return folderIndex ? { videos: folderIndex.files.size, truncated: folderIndex.truncated, at: folderIndex.at } : null;
}

// Every video filename the index holds — lets the preflight explain a miss by
// showing what it DID have to choose from.
export function indexedFilenames() {
  return folderIndex ? [...folderIndex.files.keys()] : [];
}

const INDEX_KEY = 'folder-index';

// Save the crawled listing so a NEW SESSION doesn't pay for the walk again.
// FileSystemFileHandle is structured-cloneable, so the handles survive; only
// the permission needs re-arming, which is one click.
async function saveFolderIndex(folderName, files) {
  try {
    await dbPut(INDEX_KEY, {
      folderName, at: Date.now(),
      entries: [...files.entries()].map(([name, handle]) => ({ name, handle })),
    });
  } catch (e) {
    console.warn(`[tik-files] could not persist the folder index: ${e.message}`, e);
  }
}

// Rehydrate a previously crawled listing. Returns false when there is none.
export async function loadFolderIndex() {
  if (folderIndex) return { videos: folderIndex.files.size, at: folderIndex.at, restored: false };
  const rec = await dbGet(INDEX_KEY);
  if (!rec?.entries?.length) return null;
  const folder = await getMoviesFolder();
  if (!folder) return null;
  const files = new Map(rec.entries.map((e) => [e.name, e.handle]));
  folderIndex = { dirHandle: folder.handle, files, truncated: false, at: rec.at, scannedFiles: files.size };
  return { videos: files.size, at: rec.at, restored: true };
}

// Match a title against the ALREADY-CRAWLED listing. Never crawls: crawling is
// its own explicit, cancelable step with its own progress, because doing it
// implicitly inside a per-draft loop is exactly how the Shoot step ended up
// sitting on "Looking for files… 1 of 4" for minutes with nothing to show.
export function matchInIndex(title, year) {
  if (!folderIndex) return null;
  const best = pickBestFile([...folderIndex.files.keys()], title, year);
  return best ? { name: best, handle: folderIndex.files.get(best) } : null;
}

// { name, handle } for the file that best matches, or null. Crawls if needed —
// used by the explicit crawl step, not by per-draft matching.
export async function findFileInFolder(folderHandle, title, year, opts) {
  let index;
  try {
    index = await buildFolderIndex(folderHandle, opts);
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    console.warn('[tik-files] folder walk failed', { message: e.message });
    invalidateFolderIndex(); // a half-built listing must not be trusted
    return null;
  }
  const best = pickBestFile([...index.files.keys()], title, year);
  return best ? { name: best, handle: index.files.get(best) } : null;
}

// The runners-up for a title, best first — so a miss can show WHY ("closest
// was X, below the bar") instead of a bare "no match".
// The bar is deliberately low (well under MATCH_THRESHOLD): these are shown to
// explain a miss, never acted on. A rejected sequel scoring 20 is exactly what
// the user needs to see — "it found the sequel and refused it" beats a blank
// "no matching file".
const NEAR_MISS_FLOOR = 15;

export function nearMisses(title, year, limit = 3) {
  if (!folderIndex) return [];
  return [...folderIndex.files.keys()]
    .map((name) => ({ name, score: Math.round(scoreCandidate(name, title, year)) }))
    .filter((c) => c.score >= NEAR_MISS_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---- single-file memory ----

export async function pickMovieFile(title, year) {
  if (pickerOpen) return null;
  pickerOpen = true;
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
    console.error(`[tik-files] file pick failed: ${e.message}`, e);
    return null;
  } finally {
    pickerOpen = false;
  }
}

// ---- resolution: "where is this movie's file?" ----

// Returns { label, state, armTarget, load() } or null when nothing is
// remembered. state 'granted' means load() will work right now; 'prompt'
// means call armHandle(armTarget) from a click first, then resolve again.
// Granted sources always beat prompt ones, so a granted folder match is
// preferred over a hand-picked handle that needs re-arming.
export async function resolveMovie(title, year, { onProgress } = {}) {
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
      // Index only — no crawl. If nothing is loaded the caller is told to
      // scan, rather than silently blocking here for minutes.
      const hit = matchInIndex(title, year);
      if (hit) {
        candidates.push({
          label: hit.name,
          state: 'granted',
          armTarget: folder.handle,
          load: () => hit.handle.getFile(),
        });
      } else if (!folderIndex) {
        candidates.push({ label: `your movies folder (${folder.name})`, state: 'unscanned', armTarget: folder.handle });
      }
    } else {
      // Can't search a locked folder — surface it as an armable source.
      candidates.push({
        label: `your movies folder (${folder.name})`,
        state: 'prompt',
        armTarget: folder.handle,
        load: async () => {
          const again = await findFileInFolder(folder.handle, title, year, onProgress);
          if (!again) throw new Error('No matching file in the movies folder.');
          return again.handle.getFile();
        },
      });
    }
  }

  return candidates.find((c) => c.state === 'granted') || candidates[0] || null;
}
