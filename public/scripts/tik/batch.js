// Batch mode (beta) — the whole screen, start to finish.
//
// Deliberately self-contained. It imports the shared pieces it needs and owns
// everything else, so the three shipping formats can keep working untouched
// while this proves itself. app.js knows only how to show the screen.
//
// Two steps:
//   WRITE  queue up movies (agent-picked or by name) → pull every trivia item
//          IMDb has, ranked by helpful votes → throw out the ones you don't
//          want, next-best slides up → the agent rewrites the survivors into
//          captions and timecodes → saved as drafts with placeholder frames.
//   SHOOT  point a draft at that movie's file → every frame gets grabbed at
//          its timecode, with Claude checking each one and re-seeking when it
//          lands on black, the credits, or the wrong scene.
//
// Frames are split out from writing because writing ten movies needs no video
// at all: IMDb gives us the runtime, so timecodes can be chosen before any
// file exists.

import { createTriviaPool, helpfulLabel, DEFAULT_PICK } from './triviapool.js';
import { grabVerifiedFrame } from './vision.js';
import { loadVideoFile } from './capture.js';
import { fsSupported, setMoviesFolder, getMoviesFolder, armHandle, pickMovieFile, resolveMovie } from './filestore.js';
import { fetchScenes } from './autopilot.js';
import { makeProject, defaultPostFields } from './project.js';
import { putProject, getProject, listProjects } from './store.js';
import { makeCardBitmap } from './placeholder.js';
import { getRefreshToken } from './auth.js';

const $ = (id) => document.getElementById(id);
const ACCENT = '#10b981';
const MAX_QUEUE = 25;
const QUEUE_POLL_MS = 2500;
const QUEUE_POLL_MAX_MS = 4 * 60 * 1000; // the worker's own budget is 3 min

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every batch fetch goes through this. A stalled connection used to pin the
// whole screen with the buttons disabled — setBusy(true) with no way back —
// which reads as a freeze. A timeout turns that into an error with a name.
const FETCH_TIMEOUT_MS = 30_000;
async function fetchWithTimeout(url, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error(`The server did not answer within ${Math.round(timeoutMs / 1000)}s — try again.`);
    }
    throw e;
  }
}

let els = null;
let queue = [];          // [{ key, title, year, why, imdbId, runtimeSeconds, pool, state, error, draftId }]
let selectedKey = null;
let searchSeq = 0;
let busy = false;
let exitTo = () => {};
let shootVideo = null;   // { file, duration }

export function initBatch({ onExit = () => {} } = {}) {
  exitTo = onExit;
  els = {
    screen: $('screen-batch'), back: $('batch-back'), status: $('batch-status'),
    tabWrite: $('batch-tab-write'), tabShoot: $('batch-tab-shoot'),
    write: $('batch-write'), shoot: $('batch-shoot'),
    // write
    suggest: $('batch-suggest'), suggestNote: $('batch-suggest-note'),
    search: $('batch-search'), results: $('batch-search-results'),
    queue: $('batch-queue'), queueEmpty: $('batch-queue-empty'), queueCount: $('batch-queue-count'),
    build: $('batch-build'), buildLabel: $('batch-build-label'),
    pickerTitle: $('batch-picker-title'), pickerMeta: $('batch-picker-meta'),
    size: $('batch-size'), spoilers: $('batch-spoilers'),
    replaceAll: $('batch-replace-all'), reset: $('batch-reset'),
    trivia: $('batch-trivia'), triviaEmpty: $('batch-trivia-empty'),
    // shoot
    draft: $('batch-draft'), file: $('batch-file'), run: $('batch-shoot-run'),
    video: $('batch-video'), shots: $('batch-shots'),
    folderRow: $('batch-folder-row'), folderBtn: $('batch-folder-btn'), folderStatus: $('batch-folder-status'),
    unlock: $('batch-unlock'), unlockLabel: $('batch-unlock-label'),
    pickFile: $('batch-pick-file'), fileStatus: $('batch-file-status'), shootAll: $('batch-shoot-all'),
  };

  els.back.addEventListener('click', () => exitTo());
  els.tabWrite.addEventListener('click', () => showTab('write'));
  els.tabShoot.addEventListener('click', () => showTab('shoot'));
  els.suggest.addEventListener('click', suggestMovies);
  els.search.addEventListener('input', onSearchInput);
  els.search.addEventListener('blur', () => setTimeout(hideResults, 150));
  els.build.addEventListener('click', buildAll);
  els.size.addEventListener('change', onSizeChange);
  els.spoilers.addEventListener('change', onSpoilersChange);
  els.replaceAll.addEventListener('click', () => withSelected((it) => { it.pool.replaceAll(); renderPicker(); }));
  els.reset.addEventListener('click', () => withSelected((it) => { it.pool.reset(); renderPicker(); }));
  els.file.addEventListener('change', onShootFile);
  els.run.addEventListener('click', runShoot);
  els.draft.addEventListener('change', () => { clearShots(); refreshRunButton(); tryAutoResolve(); });
  els.folderBtn.addEventListener('click', onSetFolder);
  els.unlock.addEventListener('click', onUnlock);
  els.pickFile.addEventListener('click', onPickFile);
  els.shootAll.addEventListener('click', shootAll);

  // The remembered-files UI only exists where the File System Access API
  // does (Chrome/Edge). Elsewhere the plain input is the whole story, same
  // as before this feature.
  if (fsSupported()) {
    els.folderRow.classList.remove('hidden');
    els.folderRow.classList.add('flex');
    els.file.classList.add('hidden');
    els.pickFile.classList.remove('hidden');
    els.pickFile.classList.add('flex');
    els.shootAll.classList.remove('hidden');
    els.shootAll.classList.add('flex');
  }

  showTab('write');
  render();
}

// Called by app.js every time the screen is shown.
export function refreshBatch() {
  loadDrafts();
}

// ================= chrome =================

function showTab(name) {
  const on = 'bg-emerald-600 text-white';
  const off = 'text-neutral-400 hover:text-neutral-200';
  els.tabWrite.className = `rounded-md px-3 py-1.5 text-xs font-semibold ${name === 'write' ? on : off}`;
  els.tabShoot.className = `rounded-md px-3 py-1.5 text-xs font-semibold ${name === 'shoot' ? on : off}`;
  els.write.classList.toggle('hidden', name !== 'write');
  els.shoot.classList.toggle('hidden', name !== 'shoot');
  if (name === 'shoot') { loadDrafts(); refreshFolderStatus(); }
}

function say(msg, tone = 'idle') {
  els.status.textContent = msg;
  els.status.className = `mt-3 min-h-5 text-xs ${
    tone === 'bad' ? 'text-red-300' : tone === 'good' ? 'text-emerald-300' : 'text-neutral-400'}`;
}

function setBusy(on) {
  busy = on;
  for (const b of [els.suggest, els.build, els.run, els.replaceAll, els.reset,
                   els.shootAll, els.pickFile, els.folderBtn, els.unlock]) b.disabled = on;
  if (!on) { refreshBuildButton(); refreshRunButton(); }
}

// ================= step 1: the queue =================

async function suggestMovies() {
  setBusy(true);
  say('Working out what to cover next…');
  try {
    // Everything already made on this device, so the agent never repeats one.
    const posted = (await listProjects().catch(() => []))
      .filter((p) => p.format === 'trivia' && p.movie?.title)
      .map((p) => ({ movie: p.movie.title }));

    // Real post performance if TikTok has granted video.list, otherwise the
    // library alone. Never fatal: a missing scope just means weaker signal.
    let history = [];
    const token = getRefreshToken();
    if (token) {
      const res = await fetchWithTimeout('/.netlify/functions/tik-history', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      }).catch(() => null);
      const data = res && res.ok ? await res.json().catch(() => ({})) : {};
      history = Array.isArray(data.movies) ? data.movies : [];
      els.suggestNote.textContent = data.scope === 'granted'
        ? `Reading ${history.length} of your posts for what performs.`
        : 'Using this device\'s library. Connect post history for real view counts.';
    }

    const picks = await runQueueJob({ history, posted, count: 10 });

    let added = 0;
    for (const pick of picks) if (addToQueue(pick)) added++;
    say(added
      ? `Queued ${added} movie${added === 1 ? '' : 's'}.`
      : 'Nothing new to add — all of those are already queued.', added ? 'good' : 'idle');
    render();
    prefetchPools(); // fills in the per-movie counts without the user clicking each one
  } catch (e) {
    console.error('[tik-batch] suggest failed', e);
    say(e.message, 'bad');
  } finally {
    setBusy(false);
  }
}

// Kick the background worker and poll for its answer, the same shape autopilot
// uses. The sync endpoint is only a fallback: choosing ten films runs past
// Netlify's 10s ceiling, which is exactly how this 502'd the first time.
async function runQueueJob(params) {
  const jobId = crypto.randomUUID?.() ??
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

  const kick = await fetchWithTimeout('/.netlify/functions/tik-queue-background', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, jobId }),
  }).catch(() => null);

  if (!kick || !kick.ok) {
    console.warn('[tik-batch] background queue unavailable, using sync endpoint', { status: kick?.status });
    return runQueueSync(params);
  }

  const t0 = Date.now();
  let fails = 0;
  let sawStart = false;
  while (Date.now() - t0 < QUEUE_POLL_MAX_MS) {
    await sleep(QUEUE_POLL_MS);
    say(`Picking movies… ${Math.round((Date.now() - t0) / 1000)}s`);
    const res = await fetchWithTimeout(`/.netlify/functions/tik-queue?job=${encodeURIComponent(jobId)}`).catch(() => null);
    if (!res || !res.ok) {
      if (++fails >= 5) {
        console.warn('[tik-batch] queue polling kept failing; falling back to sync');
        return runQueueSync(params);
      }
      continue;
    }
    fails = 0;
    const data = await res.json().catch(() => ({}));
    if (data.started) sawStart = true;
    if (!data.done) {
      // Healthy polls but no start marker → the worker died before it began.
      // Don't burn the full poll window on a job that will never answer.
      if (!sawStart && Date.now() - t0 > 30_000) {
        console.warn('[tik-batch] queue job never started; falling back to sync', { jobId });
        return runQueueSync(params);
      }
      continue;
    }
    if (!data.ok) throw new Error(data.error || 'Could not pick movies.');
    return data.picks || [];
  }
  throw new Error('Picking movies timed out — try again.');
}

async function runQueueSync(params) {
  const res = await fetchWithTimeout('/.netlify/functions/tik-queue', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Queue failed (${res.status})`);
  return data.picks || [];
}

function onSearchInput() {
  const q = els.search.value.trim();
  const seq = ++searchSeq;
  if (q.length < 2) return hideResults();
  clearTimeout(onSearchInput.timer);
  onSearchInput.timer = setTimeout(async () => {
    try {
      const res = await fetchWithTimeout('/.netlify/functions/tik-imdb', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'search', query: q, first: 6 }),
      });
      const data = await res.json().catch(() => ({}));
      if (seq !== searchSeq) return; // a newer keystroke already won
      renderResults(data.titles || []);
    } catch (e) {
      console.warn('[tik-batch] search failed', e);
      hideResults();
    }
  }, 250);
}

function renderResults(titles) {
  els.results.innerHTML = '';
  if (!titles.length) return hideResults();
  for (const t of titles) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-800';
    row.innerHTML = `<span class="font-semibold"></span><span class="text-xs text-neutral-500"></span>`;
    row.children[0].textContent = t.title;
    row.children[1].textContent = [t.year, t.rating ? `${t.rating}` : ''].filter(Boolean).join(' · ');
    row.addEventListener('click', () => {
      if (addToQueue(t)) { render(); prefetchPools(); say(`Added ${t.title}.`, 'good'); }
      else say(`${t.title} is already in the queue.`);
      els.search.value = '';
      hideResults();
    });
    els.results.appendChild(row);
  }
  els.results.classList.remove('hidden');
}

function hideResults() {
  els.results.classList.add('hidden');
  els.results.innerHTML = '';
}

function addToQueue(pick) {
  const title = String(pick?.title || '').trim();
  if (!title || queue.length >= MAX_QUEUE) return false;
  const key = `${title.toLowerCase()}|${pick.year || ''}`;
  if (queue.some((q) => q.key === key)) return false;
  queue.push({
    key, title, year: pick.year ?? null, why: pick.why || '',
    imdbId: pick.imdbId || pick.id || null,
    runtimeSeconds: pick.runtimeSeconds || null,
    pool: null, state: 'idle', error: '', draftId: null,
  });
  if (!selectedKey) selectMovie(key);
  return true;
}

function removeFromQueue(key) {
  queue = queue.filter((q) => q.key !== key);
  if (selectedKey === key) selectedKey = queue[0]?.key || null;
  render();
  if (selectedKey) ensurePool(find(selectedKey));
}

const find = (key) => queue.find((q) => q.key === key) || null;
const withSelected = (fn) => { const it = find(selectedKey); if (it?.pool) fn(it); };

function selectMovie(key) {
  selectedKey = key;
  render();
  const it = find(key);
  if (it) ensurePool(it);
}

// Pull every trivia item IMDb has for this film, once, and hold the ranked
// pool for as long as the movie stays queued.
async function ensurePool(item) {
  if (!item || item.pool || item.state === 'loading') return;
  item.state = 'loading';
  item.error = '';
  renderQueue();
  if (selectedKey === item.key) renderPicker();
  try {
    const res = await fetchWithTimeout('/.netlify/functions/tik-imdb', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'trivia', imdbId: item.imdbId, query: item.title, year: item.year,
        includeSpoilers: els.spoilers.checked,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `IMDb lookup failed (${res.status})`);
    item.imdbId = data.movie?.id || item.imdbId;
    item.year = data.movie?.year ?? item.year;
    item.runtimeSeconds = data.movie?.runtimeSeconds || item.runtimeSeconds;
    item.pool = createTriviaPool(data.trivia || [], sizeValue());
    item.total = data.total || (data.trivia || []).length;
    item.state = 'ready';
  } catch (e) {
    console.error(`[tik-batch] trivia fetch failed: ${item.title} — ${e.message}`, e);
    item.state = 'error';
    item.error = e.message;
  }
  renderQueue();
  if (selectedKey === item.key) renderPicker();
  refreshBuildButton();
}

// Walk the queue loading pools one at a time. Sequential on purpose: ten
// parallel fetches would hit IMDb in a burst for no gain, since the user can
// only read one movie's trivia at a time anyway.
let prefetching = false;
async function prefetchPools() {
  if (prefetching) return;
  prefetching = true;
  try {
    for (const it of queue) {
      if (!it.pool && it.state === 'idle') await ensurePool(it);
    }
  } finally {
    prefetching = false;
  }
}

function sizeValue() {
  const n = Number(els.size.value);
  return Number.isFinite(n) ? Math.min(25, Math.max(1, Math.round(n))) : DEFAULT_PICK;
}

function onSizeChange() {
  const n = sizeValue();
  els.size.value = String(n);
  for (const it of queue) it.pool?.setSize(n);
  renderPicker();
  refreshBuildButton();
}

// Changing the spoiler rule changes what IMDb sends, so every pool is stale.
function onSpoilersChange() {
  for (const it of queue) { it.pool = null; it.state = 'idle'; }
  render();
  const it = find(selectedKey);
  if (it) ensurePool(it);
}

// ================= step 1: rendering =================

function render() {
  renderQueue();
  renderPicker();
  refreshBuildButton();
}

function renderQueue() {
  els.queue.innerHTML = '';
  els.queueEmpty.classList.toggle('hidden', queue.length > 0);
  els.queueCount.textContent = queue.length ? `${queue.length}${queue.length >= MAX_QUEUE ? ' (max)' : ''}` : '';

  for (const it of queue) {
    const li = document.createElement('li');
    const active = it.key === selectedKey;
    li.className = `group flex items-start gap-2 rounded-lg border px-2.5 py-2 text-left ${
      active ? 'border-emerald-400/60 bg-emerald-400/10' : 'border-neutral-800 bg-neutral-950 hover:border-neutral-700'}`;

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'min-w-0 flex-1 text-left';
    const name = document.createElement('p');
    name.className = 'truncate text-sm font-semibold';
    name.textContent = it.year ? `${it.title} (${it.year})` : it.title;
    const sub = document.createElement('p');
    sub.className = 'mt-0.5 truncate text-[11px] text-neutral-500';
    sub.textContent = statusLine(it);
    sub.title = it.error || it.why || '';
    pick.append(name, sub);
    pick.addEventListener('click', () => selectMovie(it.key));

    const del = document.createElement('button');
    del.type = 'button';
    del.title = `Remove ${it.title} from the queue`;
    del.className = 'rounded p-0.5 text-neutral-600 hover:bg-neutral-800 hover:text-red-300';
    del.innerHTML = '<span class="material-symbols-outlined text-[16px] leading-none">close</span>';
    del.addEventListener('click', () => removeFromQueue(it.key));

    li.append(pick, del);
    els.queue.appendChild(li);
  }
}

// How many of IMDb's items the spoiler filter is holding back, so the numbers
// on screen always add up to something the user can check.
function hiddenNote(it) {
  const hidden = (it.total || 0) - it.pool.total();
  return hidden > 0 ? ` · ${hidden} spoilers hidden` : '';
}

function statusLine(it) {
  if (it.state === 'loading') return 'Loading trivia…';
  if (it.state === 'error') return it.error || 'Could not load trivia';
  if (it.state === 'written') return 'Draft written';
  if (it.pool) {
    const n = it.pool.visible().length;
    return `${n} picked of ${it.pool.total()}${it.pool.exhausted() ? ' (all used)' : ''}`;
  }
  return it.why || 'Queued';
}

function renderPicker() {
  const it = find(selectedKey);
  els.trivia.innerHTML = '';

  if (!it) {
    els.pickerTitle.textContent = 'Trivia';
    els.pickerMeta.textContent = '';
    els.triviaEmpty.textContent = 'Pick a movie on the left to see its trivia.';
    els.triviaEmpty.classList.remove('hidden');
    return;
  }
  els.pickerTitle.textContent = it.year ? `${it.title} (${it.year})` : it.title;

  if (it.state === 'loading') {
    els.pickerMeta.textContent = '';
    els.triviaEmpty.textContent = 'Pulling every trivia item IMDb has…';
    els.triviaEmpty.classList.remove('hidden');
    return;
  }
  // Only an error that left us with NO trivia should replace the list. A failed
  // write still has a perfectly good pool behind it, and throwing the user's
  // picks off screen because the model timed out would lose real work — the
  // queue line already reports what went wrong.
  if (it.state === 'error' && !it.pool) {
    els.pickerMeta.textContent = '';
    els.triviaEmpty.textContent = it.error;
    els.triviaEmpty.classList.remove('hidden');
    return;
  }
  if (!it.pool) { els.triviaEmpty.classList.remove('hidden'); return; }

  const visible = it.pool.visible();
  // Count against what the pool actually holds, not IMDb's grand total: with
  // spoilers off those differ, and "10 of 325 · 191 in reserve" reads like
  // broken arithmetic.
  els.pickerMeta.textContent =
    `${visible.length} of ${it.pool.total()} · ${it.pool.benchCount()} in reserve${hiddenNote(it)}`;
  els.triviaEmpty.classList.toggle('hidden', visible.length > 0);
  if (!visible.length) els.triviaEmpty.textContent = 'Every item was thrown out. Hit Reset to bring them back.';

  visible.forEach((item, i) => els.trivia.appendChild(triviaRow(it, item, i)));

  if (it.pool.exhausted() && visible.length) els.trivia.appendChild(exhaustedNote());
}

// A tiny helper so the exhausted-pool warning is impossible to miss but does
// not pretend to be a trivia item.
function exhaustedNote() {
  const li = document.createElement('li');
  li.className = 'rounded-lg border border-dashed border-amber-400/40 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-200/90';
  li.textContent = 'IMDb has nothing left in reserve for this film, so removing another one leaves you short.';
  return li;
}

function triviaRow(movie, item, index) {
  const li = document.createElement('li');
  li.className = 'flex items-start gap-2 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2';

  const rank = document.createElement('span');
  rank.className = 'mt-0.5 w-5 shrink-0 text-xs font-bold tabular-nums text-neutral-600';
  rank.textContent = String(index + 1);

  const body = document.createElement('div');
  body.className = 'min-w-0 flex-1';
  const text = document.createElement('p');
  text.className = 'text-sm leading-snug text-neutral-100';
  text.textContent = item.text;
  const meta = document.createElement('p');
  meta.className = 'mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-neutral-500';
  const votes = document.createElement('span');
  votes.textContent = helpfulLabel(item);
  votes.title = `${item.up} helpful, ${item.down} not helpful`;
  meta.appendChild(votes);
  if (item.spoiler) {
    const sp = document.createElement('span');
    sp.className = 'rounded bg-red-400/15 px-1.5 py-0.5 font-semibold text-red-300';
    sp.textContent = 'spoiler';
    meta.appendChild(sp);
  }
  body.append(text, meta);

  const del = document.createElement('button');
  del.type = 'button';
  del.title = 'Throw this one out — the next best takes its place';
  del.className = 'shrink-0 rounded p-1 text-neutral-600 hover:bg-neutral-800 hover:text-red-300';
  del.innerHTML = '<span class="material-symbols-outlined text-[18px] leading-none">delete</span>';
  del.addEventListener('click', () => {
    movie.pool.remove(item.id);
    renderPicker();
    renderQueue();
    say(movie.pool.exhausted()
      ? 'Thrown out. IMDb has nothing left in reserve for this film.'
      : 'Thrown out, next best moved up.');
  });

  li.append(rank, body, del);
  return li;
}

// Counts everything still to write, not just what happens to be loaded — a
// movie you never clicked on is still one you asked for, and the button must
// not quietly promise fewer drafts than the queue holds.
function pendingMovies() {
  return queue.filter((q) => q.state !== 'written');
}

function refreshBuildButton() {
  const n = pendingMovies().length;
  els.build.disabled = busy || !n;
  els.buildLabel.textContent = n ? `Write ${n} draft${n === 1 ? '' : 's'}` : 'Write every draft';
}

// ================= step 1: writing the drafts =================

async function buildAll() {
  const ready = pendingMovies();
  if (!ready.length) return;
  setBusy(true);

  let made = 0;
  const failed = [];
  for (const [i, it] of ready.entries()) {
    // A movie the user never opened has no pool yet. Load it now rather than
    // skipping it: "write every draft" has to mean every one in the queue.
    if (!it.pool) {
      say(`Loading trivia for ${it.title} (${i + 1} of ${ready.length})…`);
      await ensurePool(it);
    }
    const picked = it.pool?.visible() || [];
    if (!picked.length) {
      console.warn('[tik-batch] no trivia to write', { movie: it.title, error: it.error });
      failed.push(`${it.title} (${it.error || 'no trivia found'})`);
      continue;
    }
    say(`Writing ${it.title} (${i + 1} of ${ready.length}) — ${picked.length} facts…`);
    try {
      // A blank-line separated list is what the server reads as USER-CHOSEN
      // FACTS: it rewrites each one, in order, and adds nothing of its own.
      const suggestions = await fetchScenes({
        title: it.title,
        year: it.year,
        durationSeconds: it.runtimeSeconds || 0,
        count: picked.length,
        // Same opener the hand-driven flow gets: the server prepends a title
        // slide ("Movie (Year)" + a lead-in) pointed at the film's title card,
        // so it arrives as suggestions[0] and the count above stays the number
        // of TRIVIA slides.
        includeTitleSlide: true,
        guidance: picked.map((p) => p.text).join('\n\n'),
        onProgress: (m) => say(`${it.title} (${i + 1} of ${ready.length}) — ${m}`),
      });
      it.draftId = await saveDraft(it, suggestions);
      it.state = 'written';
      made++;
    } catch (e) {
      console.error(`[tik-batch] draft failed: ${it.title} — ${e.message}`, e);
      it.state = 'error';
      it.error = e.message;
      failed.push(it.title);
    }
    renderQueue();
  }

  setBusy(false);
  render();
  loadDrafts();
  // Say what did NOT work as plainly as what did — a silent partial run is
  // how you end up publishing eight drafts and wondering where two went.
  say(
    failed.length
      ? `Wrote ${made} draft${made === 1 ? '' : 's'}. Failed: ${failed.join(', ')}.`
      : `Wrote ${made} draft${made === 1 ? '' : 's'}. Head to Shoot to fill in the frames.`,
    failed.length ? 'bad' : 'good',
  );
}

async function saveDraft(item, suggestions) {
  const now = Date.now();
  const id = crypto.randomUUID?.() ??
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const label = item.year ? `${item.title} (${item.year})` : item.title;

  // Every slide gets the same placeholder card until Shoot replaces it. The
  // editor drops any slide whose frame won't decode, so "no frame yet" has to
  // be a real image rather than null.
  const card = await makeCardBitmap({
    heading: item.title,
    sub: [item.year, 'frame pending'].filter(Boolean).join(' · '),
    hint: 'Batch mode: run Shoot to grab this frame',
    accent: ACCENT,
  });
  const frame = await bitmapToBlob(card);
  const thumb = await bitmapToBlob(card, 240);
  card.close?.();
  const outro = await fetchOutroFrame();

  const project = makeProject({ id, format: 'trivia', now });
  const post = defaultPostFields('trivia', label);
  Object.assign(project, {
    name: label,
    movie: { title: item.title, year: item.year, query: item.title },
    postTitle: post.title,
    postDesc: post.description,
    // Batch's own bookkeeping — ignored by every other screen.
    batch: {
      imdbId: item.imdbId,
      runtimeSeconds: item.runtimeSeconds || null,
      pendingFrames: true,
      sourceCount: suggestions.length,
    },
    slides: [
      // suggestions[0] is the title slide (includeTitleSlide). It still needs
      // a frame grabbed from the film — its timecode points at the title card —
      // so it carries a placeholder like the rest, marked so Shoot can tell the
      // verifier to look for a title card rather than a scene.
      ...suggestions.map((s, i) => ({
        id: String(i + 1),
        caption: s.caption,
        timecode: s.timecode,
        grabHint: s.grab || '',
        fontScale: 1, role: null, kind: null, entry: null, section: null,
        frame,
        batchShot: i === 0 ? 'title' : 'trivia',
      })),
      ...(outro ? [{
        id: String(suggestions.length + 1),
        caption: OUTRO_CAPTION,
        timecode: null,
        grabHint: '',
        fontScale: 1, role: null, kind: 'outro', entry: null, section: null,
        frame: outro,
        batchShot: 'skip', // the logo IS the frame; never grab over it
      }] : []),
    ],
    thumb,
  });
  await putProject(project);
  return id;
}

// The branded sign-off, same logo and wording the hand-driven flow appends.
// Duplicated rather than imported because app.js keeps it private and batch
// mode stays self-contained; if the caption there changes, change it here too.
const OUTRO_LOGO_URL = '/images/vhs-garage-logo-square.png';
const OUTRO_CAPTION = 'Follow VHS Garage for more movie trivia';

// Never fatal: a missing logo costs the outro slide, not the whole draft.
async function fetchOutroFrame() {
  try {
    const res = await fetch(OUTRO_LOGO_URL);
    if (!res.ok) throw new Error(`logo ${res.status}`);
    return await res.blob();
  } catch (e) {
    console.error('[tik-batch] outro logo failed; draft written without it', { message: e.message });
    return null;
  }
}

async function bitmapToBlob(bitmap, maxEdge = 0) {
  const scale = maxEdge ? Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height)) : 1;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bitmap.width * scale));
  c.height = Math.max(1, Math.round(bitmap.height * scale));
  c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
  return await new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Frame encode failed'))), 'image/jpeg', 0.92);
  });
}

// ================= step 2: shooting the frames =================

async function loadDrafts() {
  if (!els) return;
  let drafts = [];
  try {
    drafts = (await listProjects()).filter((p) => p.batch?.pendingFrames && p.format === 'trivia');
  } catch (e) {
    console.error('[tik-batch] could not list drafts', e);
  }
  const keep = els.draft.value;
  els.draft.innerHTML = '';
  if (!drafts.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No batch drafts waiting for frames';
    opt.value = '';
    els.draft.appendChild(opt);
  } else {
    for (const d of drafts) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.name || 'Untitled'} — ${d.slides?.length || 0} slides`;
      els.draft.appendChild(opt);
    }
    if (drafts.some((d) => d.id === keep)) els.draft.value = keep;
    else tryAutoResolve(); // the selection changed under us — resolve the new one
  }
  refreshRunButton();
}

async function onShootFile() {
  const file = els.file.files?.[0];
  if (!file) { shootVideo = null; return refreshRunButton(); }
  try {
    await loadShootFile(file);
    say(`Loaded ${file.name} — ${Math.round(shootVideo.duration)}s.`);
  } catch (e) {
    console.error('[tik-batch] video load failed', e);
    shootVideo = null;
    say(e.message, 'bad');
  }
  refreshRunButton();
}

async function loadShootFile(file) {
  const meta = await loadVideoFile(file, els.video);
  shootVideo = { file, duration: meta.duration };
  els.video.classList.remove('hidden');
  refreshRunButton();
  return meta;
}

function refreshRunButton() {
  if (!els) return;
  els.run.disabled = busy || !shootVideo || !els.draft.value;
}

// ---- remembered files (Chrome/Edge; see filestore.js) ----

async function refreshFolderStatus() {
  if (!fsSupported()) return;
  const folder = await getMoviesFolder();
  if (!folder) {
    els.folderStatus.textContent = 'Grant it once and every draft finds its own file.';
    return;
  }
  els.folderStatus.textContent = folder.state === 'granted'
    ? `Watching “${folder.name}”.`
    : `“${folder.name}” remembered — unlock to use it this session.`;
  showUnlock(folder.state !== 'granted', `Unlock “${folder.name}”`, folder.handle);
}

let unlockTarget = null;
function showUnlock(on, label, handle) {
  els.unlock.classList.toggle('hidden', !on);
  els.unlock.classList.toggle('flex', on);
  if (on) {
    els.unlockLabel.textContent = label;
    unlockTarget = handle;
  }
}

async function onSetFolder() {
  const folder = await setMoviesFolder();
  if (!folder) return; // user closed the picker
  say(`Movies folder set to “${folder.name}”.`, 'good');
  await refreshFolderStatus();
  tryAutoResolve();
}

// The one click a returning session needs: re-arm the stored handle, then
// resolve the selected draft again.
async function onUnlock() {
  if (!unlockTarget) return;
  const ok = await armHandle(unlockTarget);
  if (!ok) { say('The browser declined access — pick the file by hand instead.', 'bad'); return; }
  showUnlock(false);
  await refreshFolderStatus();
  tryAutoResolve();
}

async function onPickFile() {
  const id = els.draft.value;
  const p = id ? await getProject(id) : null;
  const picked = await pickMovieFile(p?.movie?.title, p?.movie?.year);
  if (!picked) return; // cancelled
  try {
    await loadShootFile(picked.file);
    els.fileStatus.textContent = p?.movie?.title
      ? `Picked ${picked.file.name} — remembered for ${p.movie.title}.`
      : `Picked ${picked.file.name}.`;
  } catch (e) {
    console.error('[tik-batch] picked file failed to load', e);
    say(e.message, 'bad');
  }
}

// When the selected draft's file is already remembered and unlocked, load it
// without being asked. When it is remembered but locked, offer the unlock
// button instead — requestPermission needs a real click.
let resolveSeq = 0;
async function tryAutoResolve() {
  if (!fsSupported() || !els) return;
  const seq = ++resolveSeq;
  els.fileStatus.textContent = '';
  const id = els.draft.value;
  if (!id) return;
  const p = await getProject(id);
  const title = p?.movie?.title;
  if (!title || seq !== resolveSeq) return;

  const res = await resolveMovie(title, p.movie?.year, {
    // The first search of a big library takes a while (it's indexed once per
    // session after that) — say so, or it reads as a freeze.
    onProgress: (n) => { if (seq === resolveSeq) els.fileStatus.textContent = `Indexing your movies folder… ${n.toLocaleString()} files`; },
  });
  if (seq !== resolveSeq) return;
  if (!res) {
    els.fileStatus.textContent = 'No remembered file for this movie — pick it once and it sticks.';
    return;
  }
  if (res.state !== 'granted') {
    els.fileStatus.textContent = `Remembered: ${res.label} — unlock to load it.`;
    showUnlock(true, `Unlock ${res.label}`, res.armTarget);
    return;
  }
  try {
    const file = await res.load();
    if (seq !== resolveSeq) return;
    await loadShootFile(file);
    els.fileStatus.textContent = `Remembered: ${file.name} — loaded.`;
  } catch (e) {
    console.warn('[tik-batch] remembered file failed to load', { title, message: e.message });
    els.fileStatus.textContent = `Remembered ${res.label}, but it would not load — pick it by hand.`;
  }
}

// ---- shooting ----

async function runShoot() {
  const id = els.draft.value;
  if (!id || !shootVideo) return;
  setBusy(true);
  clearShots();

  try {
    const project = await getProject(id);
    if (!project) throw new Error('That draft is gone.');
    const duration = shootVideo.duration || project.batch?.runtimeSeconds || 0;
    const r = await shootProject(project, duration);
    say(
      `Done — ${r.verified} of ${r.shot} frames verified, ${r.moved} re-seeked` +
      `${r.skipped ? `, outro left alone` : ''}. Open it from your library to review and post.`,
      'good',
    );
    loadDrafts();
  } catch (e) {
    console.error('[tik-batch] shoot failed', e);
    say(e.message, 'bad');
  } finally {
    setBusy(false);
  }
}

// Grab (and verify) every shootable slide of one draft against the video
// currently loaded in els.video, then persist. Shared by the single-draft
// run and Shoot All.
async function shootProject(project, duration) {
  const slides = project.slides || [];
  // The outro is the VHS Garage logo, not a frame from the film — grabbing
  // over it would replace the sign-off with a random shot.
  const shootable = slides.filter((s) => s.batchShot !== 'skip' && s.kind !== 'outro');

  let verified = 0;
  let moved = 0;
  for (const [i, slide] of shootable.entries()) {
    say(`${project.name || 'Draft'} — frame ${i + 1} of ${shootable.length}…`);
    const row = shotRow(i + 1, slide.caption);
    els.shots.appendChild(row.li);
    try {
      const out = await grabVerifiedFrame(els.video, {
        timecode: slide.timecode,
        durationSeconds: duration,
        caption: slide.caption,
        grab: slide.grabHint,
        // Slide one is the opener: the verifier should be hunting for the
        // film's title card, not a scene that matches the caption.
        kind: slide.batchShot === 'title' ? 'title' : 'trivia',
        onProgress: (m) => { row.note.textContent = m; },
      });
      slide.frame = await bitmapToBlob(out.bitmap);
      if (out.timecode !== slide.timecode) moved++;
      slide.timecode = out.timecode;
      out.bitmap.close?.();
      if (out.verified) verified++;
      row.done(out, slide.frame);
    } catch (e) {
      console.error(`[tik-batch] frame grab failed on slide ${i + 1}: ${e.message}`, e);
      row.fail(e.message);
    }
  }

  project.slides = slides;
  project.thumb = slides[0]?.frame || project.thumb;
  project.batch = { ...project.batch, pendingFrames: false };
  project.updatedAt = Date.now();
  await putProject(project);
  return { shot: shootable.length, verified, moved, skipped: slides.length - shootable.length };
}

// Shoot All: every pending draft, each resolving its own file from memory.
// One click arms the folder (a gesture is live right then); drafts whose file
// can't be found are skipped BY NAME — a silent partial run is how you end up
// reviewing eight drafts and wondering where two went.
async function shootAll() {
  if (!fsSupported()) return;
  setBusy(true);
  clearShots();
  try {
    let drafts = [];
    try {
      drafts = (await listProjects()).filter((p) => p.batch?.pendingFrames && p.format === 'trivia');
    } catch (e) {
      console.error('[tik-batch] could not list drafts', e);
    }
    if (!drafts.length) { say('No drafts are waiting for frames.'); return; }

    // Use the click we have to arm the folder; per-file handles armed here too
    // would each need their own gesture, so locked ones just fall to the folder.
    const folder = await getMoviesFolder();
    if (folder && folder.state !== 'granted') {
      if (await armHandle(folder.handle)) await refreshFolderStatus();
      else say(`Folder access declined — matching only against hand-picked files.`, 'bad');
    }

    let done = 0;
    let verifiedTotal = 0;
    const skipped = [];
    for (const p of drafts) {
      const res = await resolveMovie(p.movie?.title, p.movie?.year, {
        onProgress: (n) => say(`Indexing your movies folder… ${n.toLocaleString()} files`),
      });
      if (!res || res.state !== 'granted') {
        skipped.push(p.name || p.movie?.title || 'Untitled');
        addShotDivider(p.name, 'no file found — select this draft and pick it once');
        continue;
      }
      let file;
      try {
        file = await res.load();
        addShotDivider(p.name, file.name);
        await loadShootFile(file);
      } catch (e) {
        console.error(`[tik-batch] shoot-all file load failed: ${p.movie?.title} — ${e.message}`, e);
        skipped.push(p.name || 'Untitled');
        addShotDivider(p.name, `file would not load: ${e.message}`);
        continue;
      }
      const r = await shootProject(p, shootVideo.duration);
      verifiedTotal += r.verified;
      done++;
    }

    say(
      `Shot ${done} of ${drafts.length} draft${drafts.length === 1 ? '' : 's'} (${verifiedTotal} frames verified)` +
      `${skipped.length ? ` — no file for: ${skipped.join(', ')}` : ''}.`,
      skipped.length ? 'bad' : 'good',
    );
    loadDrafts();
  } catch (e) {
    console.error('[tik-batch] shoot-all failed', e);
    say(e.message, 'bad');
  } finally {
    setBusy(false);
  }
}

function addShotDivider(name, detail) {
  const li = document.createElement('li');
  li.className = 'mt-2 flex items-baseline gap-2 border-b border-neutral-800 pb-1';
  const h = document.createElement('span');
  h.className = 'text-sm font-bold tracking-tight';
  h.textContent = name || 'Untitled';
  const d = document.createElement('span');
  d.className = 'text-[11px] text-neutral-500';
  d.textContent = detail || '';
  li.append(h, d);
  els.shots.appendChild(li);
}

// Object URLs for the preview thumbnails have to be revoked by hand, or a few
// batch runs leave a hundred decoded frames pinned in memory.
function clearShots() {
  for (const img of els.shots.querySelectorAll('img[data-url]')) URL.revokeObjectURL(img.dataset.url);
  els.shots.innerHTML = '';
}

function shotRow(n, caption) {
  const li = document.createElement('li');
  li.className = 'flex items-start gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2';
  const idx = document.createElement('span');
  idx.className = 'mt-0.5 w-5 shrink-0 text-xs font-bold tabular-nums text-neutral-600';
  idx.textContent = String(n);
  const body = document.createElement('div');
  body.className = 'min-w-0 flex-1';
  const cap = document.createElement('p');
  cap.className = 'truncate text-sm text-neutral-200';
  cap.textContent = caption;
  const note = document.createElement('p');
  note.className = 'mt-0.5 text-[11px] text-neutral-500';
  note.textContent = 'Waiting…';
  body.append(cap, note);
  const shot = document.createElement('img');
  shot.className = 'hidden h-12 w-20 shrink-0 rounded object-cover';
  li.append(idx, body, shot);

  return {
    li, note,
    done(out, blob) {
      note.textContent = `${out.verified ? 'Verified' : 'Unverified'} at ${Math.round(out.timecode)}s` +
        `${out.attempts > 1 ? `, ${out.attempts} tries` : ''}${out.reason ? ` — ${out.reason}` : ''}`;
      note.className = `mt-0.5 text-[11px] ${out.verified ? 'text-emerald-300/80' : 'text-amber-300/80'}`;
      if (!blob) return;
      // Seeing the frame is the point of following along. Track the object URL
      // on the node so clearing the list can revoke it (see clearShots).
      const url = URL.createObjectURL(blob);
      shot.src = url;
      shot.dataset.url = url;
      shot.classList.remove('hidden');
    },
    fail(msg) {
      note.textContent = msg;
      note.className = 'mt-0.5 text-[11px] text-red-300';
    },
  };
}
