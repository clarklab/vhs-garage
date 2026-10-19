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
// Step 2 lives in its own module: it owns the folder scan, the per-draft list
// and the run, and nothing here reaches into it beyond showing and refreshing.
import { initShoot, refreshShoot, isShooting } from './shoot.js';
import { fetchTriviaPost, fetchQuotesPost, fetchSubtitles } from './autopilot.js';
import { fontScaleForQuote } from './caption.js';
import { makeProject, defaultPostFields, pickOutro } from './project.js';
import { parseTitleList, pickBestMatch, queueAdmission } from './movielist.js';
import { houseSetAt } from './hashtags.js';
import { putProject, listProjects } from './store.js';
import { makeCardBitmap } from './placeholder.js';
import { getRefreshToken } from './auth.js';
import { writeSteps, runFraction, clockLabel, runSummary } from './writerun.js';

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
let batchFormat = 'trivia';
// Bumped whenever queued pools are thrown out (format toggle, spoilers, …)
// so an IMDb fetch that started before the bump cannot write a stale pool.
let poolGeneration = 0;
// The row a render should scroll to and flash, and when it arrived.
//
// A window rather than a one-shot flag: adding a film kicks off its IMDb pool
// fetch, which re-renders the queue a beat later and throws away the very DOM
// node that was just highlighted. Keyed on time, every render inside the window
// re-applies the highlight to whichever node currently represents that row.
let justAdded = { key: null, at: 0 };
const FLASH_MS = 1200;

export function initBatch({ onExit = () => {} } = {}) {
  exitTo = onExit;
  els = {
    screen: $('screen-batch'), back: $('batch-back'), status: $('batch-status'),
    format: $('batch-format'),
    tabWrite: $('batch-tab-write'), tabShoot: $('batch-tab-shoot'),
    write: $('batch-write'), shoot: $('batch-shoot'),
    // write
    suggest: $('batch-suggest'), suggestNote: $('batch-suggest-note'), steer: $('batch-steer'),
    search: $('batch-search'), results: $('batch-search-results'),
    pasteBox: $('batch-paste-box'), paste: $('batch-paste'),
    pasteMatch: $('batch-paste-match'), pasteNote: $('batch-paste-note'),
    pasteReport: $('batch-paste-report'),
    queue: $('batch-queue'), queueEmpty: $('batch-queue-empty'), queueCount: $('batch-queue-count'),
    build: $('batch-build'), buildLabel: $('batch-build-label'), load: $('batch-load'),
    pickerTitle: $('batch-picker-title'), pickerMeta: $('batch-picker-meta'),
    size: $('batch-size'), spoilers: $('batch-spoilers'), curate: $('batch-curate'),
    curateWrap: $('batch-curate-wrap'),
    curateNote: $('batch-curate-note'),
    replaceAll: $('batch-replace-all'), reset: $('batch-reset'),
    trivia: $('batch-trivia'), triviaEmpty: $('batch-trivia-empty'),
    writingNow: $('batch-writing-now'),
    run: $('batch-write-run'), runIcon: $('bw-icon'), runTitle: $('bw-title'), runCount: $('bw-count'),
    runClock: $('bw-clock'), runStop: $('bw-stop'), runNext: $('bw-next'), runClose: $('bw-close'),
    runBar: $('bw-bar'), runFilms: $('bw-films'), runCurrent: $('bw-current'), runFilm: $('bw-film'),
    runSteps: $('bw-steps'), runDetail: $('bw-detail'),
  };
  els.runStop.addEventListener('click', () => {
    if (!run || run.done) return;
    run.stopRequested = true;
    renderRun();
  });
  els.runNext.addEventListener('click', () => {
    showTab('shoot', { animate: true });
    refreshShoot();
  });
  els.runClose.addEventListener('click', () => { run = null; renderRun(); });

  els.back.addEventListener('click', () => exitTo());
  els.tabWrite.addEventListener('click', () => showTab('write'));
  els.tabShoot.addEventListener('click', () => showTab('shoot'));
  els.suggest.addEventListener('click', suggestMovies);
  els.search.addEventListener('input', onSearchInput);
  els.pasteMatch.addEventListener('click', matchPastedList);
  els.paste.addEventListener('input', updatePasteNote);
  // Closing the dropdown must never race the click that is closing it.
  //
  // This used to be blur + setTimeout(hideResults, 150), and hideResults wipes
  // innerHTML. Pressing the mouse on a result blurs the input, so a click held
  // longer than 150ms had its row deleted out of the tree between mousedown and
  // mouseup — and a click only fires when both land on the same, still-attached
  // element. The film was silently not added, with no error to show for it,
  // and whether it happened came down to how fast you let go of the button.
  //
  // focusout with relatedTarget replaces the timer outright: focus moving INTO
  // the list is not focus leaving the widget, so there is nothing to time.
  // Listened for on BOTH halves of the widget. focusout fires on whatever is
  // losing focus, so a handler on the input alone never hears you tab from a
  // RESULT to somewhere else, and the list would hang open for good.
  const leftTheSearch = (e) => {
    const to = e.relatedTarget;
    if (to && (to === els.search || els.results.contains(to))) return;
    hideResults();
  };
  els.search.addEventListener('focusout', leftTheSearch);
  els.results.addEventListener('focusout', leftTheSearch);
  // And a pointer anywhere outside closes it too. focusout covers the keyboard,
  // but a dropdown that will not go away is its own bug, and this path does not
  // depend on focus behaving. pointerdown fires before mousedown, so a press on
  // a result is recognised as inside and left alone.
  document.addEventListener('pointerdown', (e) => {
    if (els.results.classList.contains('hidden')) return;
    if (e.target === els.search || els.results.contains(e.target)) return;
    hideResults();
  });
  els.build.addEventListener('click', buildAll);
  els.load.addEventListener('click', loadHeld);
  els.size.addEventListener('change', onSizeChange);
  els.spoilers.addEventListener('change', onSpoilersChange);
  els.curate.addEventListener('change', onCurateToggle);
  els.format.addEventListener('click', onFormatClick);
  els.replaceAll.addEventListener('click', () => withSelected((it) => { it.pool.replaceAll(); renderPicker(); }));
  els.reset.addEventListener('click', () => withSelected((it) => { it.pool.reset(); renderPicker(); }));
  initShoot();

  showTab('write');
  syncFormatChrome();
  render();
}

// Called by app.js every time the screen is shown.
export function refreshBatch() {
  refreshShoot();
}

// ================= chrome =================

function showTab(name, { animate = false } = {}) {
  const on = 'bg-emerald-600 text-white';
  const off = 'text-neutral-400 hover:text-neutral-200';
  els.tabWrite.className = `rounded-md px-3 py-1.5 text-xs font-semibold ${name === 'write' ? on : off}`;
  els.tabShoot.className = `rounded-md px-3 py-1.5 text-xs font-semibold ${name === 'shoot' ? on : off}`;
  els.write.classList.toggle('hidden', name !== 'write');
  els.shoot.classList.toggle('hidden', name !== 'shoot');
  els.shoot.classList.toggle('flex', name === 'shoot');
  if (name === 'shoot') refreshShoot();

  // Hand-off from Write to Shoot: slide the panel in and ping the tab, so the
  // screen changing under you reads as a step forward rather than a glitch.
  if (animate) {
    const panel = name === 'shoot' ? els.shoot : els.write;
    const tab = name === 'shoot' ? els.tabShoot : els.tabWrite;
    for (const [el, cls] of [[panel, 'step-in'], [tab, 'tab-ping']]) {
      el.classList.remove(cls);
      void el.offsetWidth; // restart the animation even if the class was there
      el.classList.add(cls);
      el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
    }
    els.screen.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function say(msg, tone = 'idle') {
  els.status.textContent = msg;
  els.status.className = `mt-3 min-h-5 text-xs ${
    tone === 'bad' ? 'text-red-300' : tone === 'good' ? 'text-emerald-300' : 'text-neutral-400'}`;
}

function setBusy(on) {
  busy = on;
  for (const b of [els.suggest, els.build, els.replaceAll, els.reset]) b.disabled = on;
  if (els.format) {
    for (const btn of els.format.querySelectorAll('[data-batch-format]')) btn.disabled = on;
  }
  refreshBuildButton();
}

function onFormatClick(e) {
  const btn = e.target.closest('[data-batch-format]');
  if (!btn || busy) return;
  const next = btn.dataset.batchFormat;
  if (next !== 'trivia' && next !== 'quotes') return;
  if (next === batchFormat) return;
  batchFormat = next;
  poolGeneration += 1;
  for (const it of queue) {
    it.pool = null;
    it.state = 'idle';
    it.curated = 0;
    it.curateError = '';
  }
  syncFormatChrome();
  render();
  const it = find(selectedKey);
  if (it) ensurePool(it);
}

function syncFormatChrome() {
  const on = 'rounded-md px-3 py-1.5 text-xs font-semibold bg-neutral-800 text-white';
  const off = 'rounded-md px-3 py-1.5 text-xs font-semibold text-neutral-400 hover:text-neutral-200';
  if (els.format) {
    for (const btn of els.format.querySelectorAll('[data-batch-format]')) {
      btn.className = btn.dataset.batchFormat === batchFormat ? on : off;
    }
  }
  const quotes = batchFormat === 'quotes';
  els.curateWrap?.classList.toggle('hidden', quotes);
  if (quotes) {
    els.curateNote.classList.add('hidden');
    els.curateNote.textContent = '';
  }
}

// ================= step 1: the queue =================

async function suggestMovies() {
  setBusy(true);
  say('Working out what to cover next…');
  try {
    // Everything already made on this device, so the agent never repeats one.
    // A post imported from TikTok before its caption could be read has no
    // movie; its caption goes instead and the server names the film from it.
    const posted = (await listProjects().catch(() => []))
      .filter((p) => p.format === batchFormat)
      .map((p) => (p.movie?.title ? { movie: p.movie.title }
        : p.imported?.title ? { caption: p.imported.title.slice(0, 300) } : null))
      .filter(Boolean);

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
      const movies = batchFormat === 'quotes' ? data.quoteMovies : data.movies;
      history = Array.isArray(movies) ? movies : [];
      els.suggestNote.textContent = data.scope === 'granted'
        ? `Reading ${history.length} of your posts for what performs.`
        : 'Using this device\'s library. Connect post history for real view counts.';
    }

    // Whatever the user typed above the button: an actor, a director, a theme,
    // a decade. The picker already knew how to take steering; nothing had ever
    // handed it any.
    const guidance = els.steer?.value.trim() || '';
    const picks = await runQueueJob({ history, posted, count: 10, format: batchFormat, guidance });

    // Held: titles only until the list is approved. Ten IMDb pulls and ten AI
    // rankings for a list that still has three films you'd never post is
    // waste, and reading trivia before choosing the films is the wrong order.
    let added = 0;
    for (const pick of picks) if (addToQueue(pick, { held: true }) === 'added') added++;
    const steered = guidance ? ` for “${guidance}”` : '';
    say(added
      ? `Queued ${added} movie${added === 1 ? '' : 's'}${steered}. Remove any you don't want, then load their trivia.`
      : `Nothing new to add${steered} — all of those are already queued.`, added ? 'good' : 'idle');
    render();
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
    // Belt to the focusout braces: swallowing mousedown keeps focus in the
    // input, so picking a result never blurs it in the first place.
    row.addEventListener('mousedown', (e) => e.preventDefault());
    row.addEventListener('click', () => {
      const verdict = addToQueue(t);
      if (verdict === 'added') { render(); prefetchPools(); say(`Added ${t.title}.`, 'good'); }
      else if (verdict === 'full') say(`Queue is full (${MAX_QUEUE}) — remove one first.`, 'bad');
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

// ---- paste a whole list ----
//
// Adding twenty films through a search box is twenty searches, twenty reads of
// a dropdown, and twenty clicks. This takes the list as text, resolves each row
// against IMDb, and reports what it did — including the rows it was unsure
// about, which is the part that makes the result trustworthy enough to use.

function updatePasteNote() {
  const rows = parseTitleList(els.paste.value);
  const room = MAX_QUEUE - queue.length;
  els.pasteMatch.disabled = rows.length === 0 || room <= 0;
  if (!rows.length) { els.pasteNote.textContent = ''; return; }
  const willAdd = Math.min(rows.length, room);
  els.pasteNote.textContent = room <= 0
    ? `Queue is full (${MAX_QUEUE}).`
    : `${rows.length} title${rows.length === 1 ? '' : 's'}${willAdd < rows.length ? `, room for ${willAdd}` : ''}.`;
}

// One search per title. Kept to a small concurrency: IMDb's endpoint is not
// ours, and twenty parallel requests is how you get rate limited mid-list.
const PASTE_CONCURRENCY = 3;

async function resolveTitle(row) {
  try {
    const res = await fetchWithTimeout('/.netlify/functions/tik-imdb', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'search', query: row.title, first: 8 }),
    });
    const data = await res.json().catch(() => ({}));
    return { row, ...pickBestMatch(row, data.titles || []) };
  } catch (e) {
    console.warn('[tik-batch] paste lookup failed', { title: row.title, message: e.message });
    return { row, pick: null, confidence: 'error', error: e.message };
  }
}

async function matchPastedList() {
  const rows = parseTitleList(els.paste.value).slice(0, Math.max(0, MAX_QUEUE - queue.length));
  if (!rows.length) return;

  setBusy(true);
  els.pasteReport.innerHTML = '';
  const results = new Array(rows.length);
  let done = 0;
  say(`Looking up ${rows.length} title${rows.length === 1 ? '' : 's'}…`);

  // A fixed pool of workers pulling from one cursor: bounded concurrency
  // without batching, so one slow lookup never stalls the rest of the list.
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(PASTE_CONCURRENCY, rows.length) }, async () => {
    while (cursor < rows.length) {
      const i = cursor++;
      results[i] = await resolveTitle(rows[i]);
      say(`Looked up ${++done} of ${rows.length}…`);
    }
  }));

  let added = 0;
  const missed = [];
  for (const r of results) {
    const verdict = r.pick ? addToQueue({ ...r.pick, why: r.row.raw }) : 'nomatch';
    const ok = verdict === 'added';
    if (ok) added++;
    else if (r.pick) missed.push({ ...r, confidence: verdict });
    else missed.push(r);
    renderPasteRow(r, ok);
  }

  setBusy(false);
  render();
  prefetchPools();
  updatePasteNote();
  // Say what did not land as plainly as what did — a silent partial match is
  // how three films quietly go missing from a batch of twenty.
  say(
    missed.length
      ? `Added ${added} of ${results.length}. Check the ${missed.length} flagged below.`
      : `Added ${added} movie${added === 1 ? '' : 's'}.`,
    missed.length ? 'bad' : 'good',
  );
  if (added) els.paste.value = '';
}

const PASTE_TONE = {
  exact: 'text-neutral-500',
  title: 'text-neutral-500',
  weak: 'text-amber-300',
  dupe: 'text-neutral-600',
  full: 'text-amber-300',
  none: 'text-red-300',
  error: 'text-red-300',
};

function renderPasteRow(r, added) {
  const li = document.createElement('li');
  li.className = `text-[11px] leading-snug ${PASTE_TONE[r.confidence] || 'text-neutral-500'}`;
  const asked = r.row.year ? `${r.row.title} (${r.row.year})` : r.row.title;
  if (!r.pick) {
    li.textContent = r.confidence === 'error' ? `${asked} — lookup failed` : `${asked} — no match`;
  } else if (!added) {
    li.textContent = r.confidence === 'full'
      ? `${asked} — queue is full (${MAX_QUEUE})`
      : `${asked} — already queued`;
  } else if (r.confidence === 'weak') {
    li.textContent = `${asked} → ${r.pick.title}${r.pick.year ? ` (${r.pick.year})` : ''} — check this one`;
  } else {
    li.textContent = `${r.pick.title}${r.pick.year ? ` (${r.pick.year})` : ''}`;
  }
  els.pasteReport.appendChild(li);
}

// Returns a reason, not a boolean: "already queued" and "queue is full" are
// different things to be told, and callers used to conflate them.
function addToQueue(pick, { held = false } = {}) {
  const verdict = queueAdmission(pick, queue, MAX_QUEUE);
  if (!verdict.ok) return verdict.reason;
  queue.push({
    held,
    key: verdict.key, title: String(pick.title).trim(), year: pick.year ?? null, why: pick.why || '',
    imdbId: pick.imdbId || pick.id || null,
    runtimeSeconds: pick.runtimeSeconds || null,
    pool: null, state: 'idle', error: '', draftId: null,
  });
  // The list grows downward, so with a few films queued a new row lands well
  // below the search box that was just clicked. renderQueue scrolls to this.
  justAdded = { key: verdict.key, at: Date.now() };
  if (!selectedKey && !held) selectMovie(verdict.key);
  return 'added';
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
  const it = find(key);
  if (it) it.held = false; // opening a film is approving it
  render();
  if (!it) return;
  // A pool the background walk already loaded still needs its ranking.
  if (it.pool) curateItem(it);
  else ensurePool(it);
}

// "Load trivia": the queue is approved as it stands.
function loadHeld() {
  for (const it of queue) it.held = false;
  render();
  prefetchPools();
}

// Pull every trivia item IMDb has for this film, once, and hold the ranked
// pool for as long as the movie stays queued.
async function ensurePool(item) {
  if (!item || item.pool || item.state === 'loading') return;
  const generation = poolGeneration;
  const format = batchFormat;
  item.state = 'loading';
  item.error = '';
  renderQueue();
  if (selectedKey === item.key) renderPicker();
  try {
    const res = await fetchWithTimeout('/.netlify/functions/tik-imdb', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: format === 'quotes' ? 'quotes' : 'trivia', imdbId: item.imdbId, query: item.title, year: item.year,
        includeSpoilers: els.spoilers.checked,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (generation !== poolGeneration) return;
    if (!res.ok) throw new Error(data.error || `IMDb lookup failed (${res.status})`);
    item.imdbId = data.movie?.id || item.imdbId;
    item.year = data.movie?.year ?? item.year;
    item.runtimeSeconds = data.movie?.runtimeSeconds || item.runtimeSeconds;
    const rows = format === 'quotes' ? (data.quotes || []) : (data.trivia || []);
    item.pool = createTriviaPool(rows, sizeValue());
    item.total = data.total || rows.length;
    item.state = 'ready';
  } catch (e) {
    if (generation !== poolGeneration) return;
    console.error(`[tik-batch] ${format} fetch failed: ${item.title} — ${e.message}`, e);
    item.state = 'error';
    item.error = e.message;
  }
  if (generation !== poolGeneration) return;
  renderQueue();
  if (selectedKey === item.key) renderPicker();
  refreshBuildButton();

  // Rank every film as its pool lands, not only the one on screen. Ranking
  // only the selected film left the rest in vote order until Write, which then
  // swapped in the agent's choices — so what got written was not what had been
  // reviewed. Films only load once the list is approved, so this is ten calls
  // that Write was going to make anyway, just made in time to be checked.
  if (item.state === 'ready' && format !== 'quotes') curateItem(item);
}

// Walk the queue loading pools one at a time. Sequential on purpose: ten
// parallel fetches would hit IMDb in a burst for no gain, since the user can
// only read one movie's trivia at a time anyway.
let prefetching = false;
async function prefetchPools() {
  if (prefetching) return;
  prefetching = true;
  try {
    // A format/spoilers bump mid-walk invalidates this pass. Restart so the
    // remaining idle rows load the new format instead of stopping halfway.
    while (true) {
      const generation = poolGeneration;
      for (const it of queue) {
        if (generation !== poolGeneration) break;
        if (!it.pool && it.state === 'idle' && !it.held) await ensurePool(it);
      }
      if (generation === poolGeneration) break;
    }
  } finally {
    prefetching = false;
  }
}

// ---- AI curation: which of the top 25 make the best 10 slides ----
//
// IMDb's helpful votes answer "was this worth reading", not "will this stop a
// thumb". So the vote-ranked top 25 goes to an agent, which re-ranks for
// surprise, visual support, brevity and variety. The result reorders the pool,
// and each pick carries the agent's reason — the human review stays the last
// word, it just starts from a better ten.
const CANDIDATES = 25;

async function curatePool(item, { announce = () => {} } = {}) {
  if (batchFormat === 'quotes' || !els.curate.checked || !item?.pool || item.curated) return false;
  const pool = item.pool;
  const size = pool.size();
  const all = pool.top(CANDIDATES);
  if (all.length <= size) return false; // nothing to choose between

  announce('Agent is picking the best of the top 25…');
  try {
    const params = {
      title: item.title,
      year: item.year,
      count: size,
      candidates: all.map((c) => ({ id: c.id, text: c.text })),
    };
    let res;
    try {
      res = await runCurateJob(params);
    } catch (first) {
      // One more go before settling for vote order: a fresh call usually lands
      // on a different function instance, and a bad instance is the common way
      // this fails ("Anthropic not configured" on one, fine on the next).
      console.warn(`[tik-batch] curation failed for ${item.title}, retrying once: ${first.message}`);
      announce('Agent ranking hiccuped — trying once more…');
      await sleep(3000);
      if (item.pool !== pool) return false;
      res = await runCurateJob(params);
    }
    if (!res?.order?.length) return false;
    // A spoiler or format toggle swapped the pool while the agent was busy;
    // this ranking was for the old one, and the new pool ranks itself.
    if (item.pool !== pool) return false;
    item.pool.applyOrder(res.order, res.why || {});
    item.curated = res.curated || 0;
    return true;
  } catch (e) {
    // Never fatal: a failed ranking just leaves the vote order in place.
    console.warn(`[tik-batch] curation failed for ${item.title}: ${e.message}`, e);
    item.curateError = e.message;
    return false;
  }
}

async function runCurateJob(params) {
  const jobId = crypto.randomUUID?.() ??
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const kick = await fetchWithTimeout('/.netlify/functions/tik-curate-background', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, jobId }),
  }).catch(() => null);

  if (!kick || !kick.ok) {
    console.warn('[tik-batch] background curate unavailable, using sync endpoint', { status: kick?.status });
    return runCurateSync(params);
  }

  const t0 = Date.now();
  let fails = 0;
  let sawStart = false;
  while (Date.now() - t0 < QUEUE_POLL_MAX_MS) {
    await sleep(QUEUE_POLL_MS);
    const res = await fetchWithTimeout(`/.netlify/functions/tik-curate?job=${encodeURIComponent(jobId)}`).catch(() => null);
    if (!res || !res.ok) {
      if (++fails >= 5) return runCurateSync(params);
      continue;
    }
    fails = 0;
    const data = await res.json().catch(() => ({}));
    if (data.started) sawStart = true;
    if (!data.done) {
      if (!sawStart && Date.now() - t0 > 30_000) return runCurateSync(params);
      continue;
    }
    if (!data.ok) throw new Error(data.error || 'Could not rank the trivia.');
    return data;
  }
  throw new Error('Ranking the trivia timed out.');
}

async function runCurateSync(params) {
  const res = await fetchWithTimeout('/.netlify/functions/tik-curate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ranking failed (${res.status})`);
  return data;
}

// Turning it on re-ranks what's loaded; turning it off restores vote order by
// reloading the pools (the original order is the server's, not ours to undo).
function onCurateToggle() {
  if (batchFormat === 'quotes') return;
  if (!els.curate.checked) {
    poolGeneration += 1;
    for (const it of queue) { it.pool = null; it.state = 'idle'; it.curated = 0; it.curateError = ''; }
    render();
    const it = find(selectedKey);
    if (it) ensurePool(it);
    return;
  }
  for (const it of queue) if (it.pool) curateItem(it);
}

// One ranking per pool, however many things ask for it: the load, a click on
// the film, and Write all share the same in-flight call.
function curateItem(item) {
  if (batchFormat === 'quotes' || !item?.pool) return Promise.resolve(false);
  const pool = item.pool;
  if (item.curating && item.curatingPool === pool) return item.curating;
  const announce = (m) => {
    if (find(selectedKey) !== item) return;
    els.curateNote.textContent = m;
    els.curateNote.classList.remove('hidden');
  };
  const run = curatePool(item, { announce }).finally(() => {
    if (item.curating === run) { item.curating = null; item.curatingPool = null; }
    if (find(selectedKey) === item) renderPicker();
    renderQueue();
  });
  item.curating = run;
  item.curatingPool = pool;
  renderQueue();
  return run;
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

// Changing the spoiler rule changes what IMDb sends, so every pool is stale —
// and so is its curation. Leaving `curated` set made curatePool() skip the new
// pool, and every "AI pick" label vanished the moment Spoilers was ticked.
function onSpoilersChange() {
  poolGeneration += 1;
  for (const it of queue) { it.pool = null; it.state = 'idle'; it.curated = 0; it.curateError = ''; }
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
  let fresh = null;
  els.queueEmpty.classList.toggle('hidden', queue.length > 0);
  els.queueCount.textContent = queue.length ? `${queue.length}${queue.length >= MAX_QUEUE ? ' (max)' : ''}` : '';

  for (const it of queue) {
    const li = document.createElement('li');
    const active = it.key === selectedKey;
    const writing = run && !run.done && run.films[run.index]?.key === it.key;
    li.className = `group flex items-start gap-2 rounded-lg border px-2.5 py-2 text-left ${
      writing ? 'border-emerald-400 bg-emerald-400/15 ring-2 ring-emerald-400/30'
        : active ? 'border-emerald-400/60 bg-emerald-400/10' : 'border-neutral-800 bg-neutral-950 hover:border-neutral-700'}`;

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'min-w-0 flex-1 text-left';
    const name = document.createElement('p');
    name.className = 'truncate text-sm font-semibold';
    name.textContent = it.year ? `${it.title} (${it.year})` : it.title;
    const sub = document.createElement('p');
    const runLine = runLineFor(it);
    sub.className = `mt-0.5 truncate text-[11px] ${writing ? 'text-emerald-200' : 'text-neutral-500'}`;
    sub.textContent = runLine ?? statusLine(it);
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
    if (it.key === justAdded.key && Date.now() - justAdded.at < FLASH_MS) fresh = li;
  }

  // Show the row that just arrived.
  //
  // The queue grows downward and a new film is appended at the bottom, so with
  // a handful already queued it lands hundreds of pixels below the search box
  // that was just clicked — off-screen on a laptop. Everything worked; you
  // simply could not see it happen, which is indistinguishable from a click
  // that did nothing.
  if (fresh) {
    fresh.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    // And a beat of colour, for when it was already on screen and scrolling
    // into view moves nothing at all.
    fresh.classList.add('ring-2', 'ring-emerald-400');
    setTimeout(() => fresh.classList.remove('ring-2', 'ring-emerald-400'), FLASH_MS);
  }
}

// How many of IMDb's items the spoiler filter is holding back, so the numbers
// on screen always add up to something the user can check.
function hiddenNote(it) {
  const hidden = (it.total || 0) - it.pool.total();
  return hidden > 0 ? ` · ${hidden} spoilers hidden` : '';
}

function statusLine(it) {
  const noun = batchFormat === 'quotes' ? 'quotes' : 'trivia';
  if (it.state === 'loading') return `Loading ${noun}…`;
  if (it.state === 'error') return it.error || `Could not load ${noun}`;
  if (it.state === 'written') return 'Draft written';
  if (it.pool) {
    const n = it.pool.visible().length;
    const ai = batchFormat === 'quotes' || !els.curate.checked ? ''
      : it.curating ? ' · AI ranking…'
        : it.curated ? ' · AI picks'
          : it.curateError ? ' · AI ranking failed, vote order' : '';
    return `${n} picked of ${it.pool.total()}${it.pool.exhausted() ? ' (all used)' : ''}${ai}`;
  }
  return it.why || 'Queued';
}

function renderPicker() {
  const it = find(selectedKey);
  els.trivia.innerHTML = '';
  const writingThis = !!(it && run && !run.done && run.films[run.index]?.key === it.key);
  els.writingNow.classList.toggle('hidden', !writingThis);
  els.writingNow.classList.toggle('flex', writingThis);
  if (writingThis) {
    els.writingNow.lastElementChild.textContent = batchFormat === 'quotes'
      ? 'Writing this one now — these are the quotes going in.'
      : 'Writing this one now — these are the facts going in.';
  }

  if (!it) {
    els.pickerTitle.textContent = batchFormat === 'quotes' ? 'Quotes' : 'Trivia';
    els.pickerMeta.textContent = '';
    els.triviaEmpty.textContent = batchFormat === 'quotes'
      ? 'Pick a movie on the left to see its quotes.'
      : 'Pick a movie on the left to see its trivia.';
    els.triviaEmpty.classList.remove('hidden');
    return;
  }
  els.pickerTitle.textContent = it.year ? `${it.title} (${it.year})` : it.title;

  if (it.state === 'loading') {
    els.pickerMeta.textContent = '';
    els.triviaEmpty.textContent = batchFormat === 'quotes'
      ? 'Pulling every quote IMDb has…'
      : 'Pulling every trivia item IMDb has…';
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
  const curated = it.pool.isCurated();
  if (batchFormat === 'quotes') {
    els.curateNote.textContent = '';
    els.curateNote.className = 'mt-1 hidden text-[11px] leading-snug text-emerald-300/80';
  } else {
    els.curateNote.textContent = it.curateError
      ? `Agent ranking unavailable (${it.curateError}) — showing IMDb vote order.`
      : curated
        ? `Agent chose these ${it.curated} from the top ${Math.min(25, it.pool.total())} by votes.`
        : '';
    // Visibility and colour in ONE assignment: setting .className separately
    // wipes whatever classList.toggle('hidden') just did, leaving an empty
    // element holding layout space.
    els.curateNote.className = `mt-1 text-[11px] leading-snug ${
      els.curateNote.textContent ? '' : 'hidden '}${
      it.curateError ? 'text-amber-300/80' : 'text-emerald-300/80'}`;
  }
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
  if (item.curated) {
    // Why the agent chose it — this is what makes the human review a check on
    // its judgement rather than a rubber stamp.
    const pick = document.createElement('span');
    pick.className = 'text-emerald-300/80';
    pick.textContent = item.why ? `AI pick: ${item.why}` : 'AI pick';
    pick.title = item.why || 'Chosen by the agent from the top 25';
    meta.appendChild(pick);
  }
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
  const held = busy ? 0 : queue.filter((it) => it.held).length;
  els.load.classList.toggle('hidden', !held);
  els.load.classList.toggle('flex', !!held);
  els.load.disabled = busy;
  els.load.textContent = held ? `Load ${batchFormat === 'quotes' ? 'quotes' : 'trivia'} for ${held} movie${held === 1 ? '' : 's'}` : '';
  const n = pendingMovies().length;
  els.build.disabled = busy || !n;
  els.buildLabel.textContent = n ? `Write ${n} draft${n === 1 ? '' : 's'}` : 'Write every draft';
}

// ================= step 1: writing the drafts =================

// ---- the "Write every draft" run, on screen ----
//
// One run at a time. `films` mirrors the queue rows being written, each with
// its own state; `step` is where the current one has got to. The panel, the
// queue rows and the trivia column all read from here, so the whole screen
// says the same thing about what is happening.
let run = null;

function runStart(items) {
  clearInterval(run?.timer);
  run = {
    films: items.map((it) => ({ key: it.key, title: it.title, state: 'waiting', reason: '' })),
    steps: writeSteps(batchFormat),
    index: -1, stepIndex: 0, detail: '',
    started: Date.now(), ended: 0,
    stopRequested: false, done: false, made: 0, failed: [], stopped: 0,
  };
  run.timer = setInterval(() => { els.runClock.textContent = clockLabel(Date.now() - run.started); }, 1000);
  renderRun();
}

function runFilm(i) {
  run.index = i;
  run.films[i].state = 'active';
  run.stepIndex = 0;
  run.detail = '';
  // The trivia column follows the film being written, so the screen shows the
  // facts going in rather than whatever was last clicked.
  selectedKey = run.films[i].key;
  render();
  renderRun();
}

function runStep(key, detail = '') {
  const idx = run.steps.findIndex((s) => s.key === key);
  if (idx >= 0) run.stepIndex = idx;
  run.detail = detail;
  renderRun();
  renderQueue();
}

function runDetail(detail) {
  if (!run) return;
  run.detail = detail;
  els.runDetail.textContent = detail;
  renderQueue();
}

function runFilmEnd(ok, reason = '') {
  const f = run.films[run.index];
  f.state = ok ? 'done' : 'failed';
  f.reason = reason;
  if (ok) run.made++;
  else run.failed.push(reason ? `${f.title} (${reason})` : f.title);
  run.stepIndex = 0;
  renderRun();
  renderQueue();
}

function runFinish() {
  run.done = true;
  run.ended = Date.now();
  for (const f of run.films) {
    if (f.state === 'waiting') { f.state = 'skipped'; run.stopped++; }
  }
  clearInterval(run.timer);
  render();
  renderRun();
}

const FILM_CHIP = {
  waiting: { icon: 'radio_button_unchecked', cls: 'border-neutral-800 bg-neutral-950 text-neutral-500' },
  active: { icon: 'progress_activity', cls: 'border-emerald-400/70 bg-emerald-500/15 text-emerald-100', spin: true },
  done: { icon: 'check_circle', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  failed: { icon: 'error', cls: 'border-red-500/40 bg-red-500/10 text-red-300' },
  skipped: { icon: 'block', cls: 'border-neutral-800 bg-neutral-950 text-neutral-600' },
};

function renderRun() {
  els.run.classList.toggle('hidden', !run);
  if (!run) return;
  const total = run.films.length;
  const finished = run.films.filter((f) => f.state === 'done' || f.state === 'failed').length;
  const bad = run.failed.length > 0;

  if (run.done) {
    els.runIcon.textContent = bad ? 'warning' : run.stopped ? 'pause_circle' : 'task_alt';
    els.runIcon.className = `material-symbols-outlined text-[22px] leading-none ${bad ? 'text-amber-300' : 'text-emerald-300'}`;
    els.runTitle.textContent = runSummary({ made: run.made, failed: run.failed, stopped: run.stopped });
    els.runCount.textContent = '';
    els.runClock.textContent = clockLabel(run.ended - run.started);
  } else {
    els.runIcon.textContent = 'edit_note';
    els.runIcon.className = 'material-symbols-outlined animate-pulse text-[22px] leading-none text-emerald-300';
    els.runTitle.textContent = run.stopRequested ? 'Finishing this film, then stopping' : 'Writing drafts';
    els.runCount.textContent = run.index >= 0 ? `${Math.min(run.index + 1, total)} of ${total}` : `${total} films`;
    els.runClock.textContent = clockLabel(Date.now() - run.started);
  }
  els.runStop.classList.toggle('hidden', run.done);
  els.runStop.disabled = run.stopRequested;
  els.runStop.textContent = run.stopRequested ? 'Stopping after this film…' : 'Stop after this film';
  els.runNext.classList.toggle('hidden', !(run.done && run.made));
  els.runNext.classList.toggle('flex', !!(run.done && run.made));
  els.runClose.classList.toggle('hidden', !run.done);

  const frac = run.done ? 1 : runFraction({ total, finished, stepIndex: run.stepIndex, stepCount: run.steps.length });
  els.runBar.style.width = `${Math.round(frac * 100)}%`;
  els.runBar.className = `h-full rounded-full transition-[width] duration-500 ${run.done && bad ? 'bg-amber-400' : 'bg-emerald-500'}`;

  els.runFilms.innerHTML = '';
  for (const f of run.films) {
    const ui = FILM_CHIP[f.state] || FILM_CHIP.waiting;
    const li = document.createElement('li');
    li.className = `flex max-w-[15rem] items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${ui.cls}`;
    li.title = f.reason ? `${f.title} — ${f.reason}` : f.title;
    const icon = document.createElement('span');
    icon.className = `material-symbols-outlined text-[15px] leading-none ${ui.spin ? 'animate-spin' : ''}`;
    icon.textContent = ui.icon;
    const name = document.createElement('span');
    name.className = 'truncate';
    name.textContent = f.title;
    li.append(icon, name);
    els.runFilms.appendChild(li);
  }

  // The film in hand and its steps. Hidden once the run is over: the chips
  // above already say how every film ended, failures with their reasons.
  const cur = !run.done && run.index >= 0 ? run.films[run.index] : null;
  els.runCurrent.classList.toggle('hidden', !cur);
  els.runDetail.classList.toggle('hidden', !cur && !run.done);
  if (cur) {
    els.runFilm.textContent = cur.title;
    els.runSteps.innerHTML = '';
    run.steps.forEach((st, i) => {
      const li = document.createElement('li');
      const state = i < run.stepIndex ? 'past' : i === run.stepIndex ? 'now' : 'next';
      li.className = `flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold ${
        state === 'now' ? 'bg-emerald-500 text-neutral-950'
          : state === 'past' ? 'text-emerald-300' : 'text-neutral-600'}`;
      const icon = document.createElement('span');
      icon.className = `material-symbols-outlined text-[15px] leading-none ${state === 'now' ? 'animate-spin' : ''}`;
      icon.textContent = state === 'past' ? 'check' : state === 'now' ? 'progress_activity' : 'circle';
      li.append(icon, document.createTextNode(st.label));
      els.runSteps.appendChild(li);
      if (i < run.steps.length - 1) {
        const sep = document.createElement('li');
        sep.className = 'material-symbols-outlined text-[14px] leading-none text-neutral-700';
        sep.textContent = 'chevron_right';
        els.runSteps.appendChild(sep);
      }
    });
    els.runDetail.textContent = run.detail;
  } else if (run.done) {
    els.runDetail.textContent = run.failed.length ? `Failed: ${run.failed.join(' · ')}` : '';
    els.runDetail.className = `mt-1.5 min-h-4 text-xs ${run.failed.length ? 'text-red-300' : 'text-neutral-400'}`;
  }
  if (!run.done) els.runDetail.className = 'mt-1.5 min-h-4 text-xs text-neutral-400';
}

// The run's word on one queue row, while it is in the run.
function runLineFor(it) {
  if (!run) return null;
  const f = run.films.find((x) => x.key === it.key);
  if (!f) return null;
  if (f.state === 'active') {
    const step = run.steps[run.stepIndex]?.label || 'Working';
    return run.detail ? `${step} — ${run.detail}` : `${step}…`;
  }
  if (f.state === 'waiting') return 'Up next';
  if (f.state === 'skipped') return 'Not started — the run was stopped';
  if (f.state === 'failed') return `Failed${f.reason ? `: ${f.reason}` : ''}`;
  return null; // done: the usual "Draft written"
}

async function buildAll() {
  const ready = pendingMovies();
  if (!ready.length) return;
  setBusy(true);
  // Writing a film loads it, so nothing in the run is waiting for approval
  // any more — and the line above the panel would only be last step's news.
  for (const it of ready) it.held = false;
  say('');
  runStart(ready);

  let made = 0;
  const failed = [];
  for (const [i, it] of ready.entries()) {
    if (run.stopRequested) break;
    runFilm(i);
    // A movie the user never opened has no pool yet. Load it now rather than
    // skipping it: "write every draft" has to mean every one in the queue.
    runStep('pool', it.pool ? '' : `Pulling everything IMDb has for ${it.title}`);
    if (!it.pool) await ensurePool(it);
    // Curate before writing so an unopened movie still gets the agent's ten
    // rather than the raw vote order. Quotes skip this: the ranked IMDb list
    // is the source, and Autopilot boils the picked lines itself.
    if (batchFormat !== 'quotes') {
      runStep('rank', it.curated ? '' : 'Choosing the best 10 of the top 25');
      if (it.pool && !it.curated) await curateItem(it);
    }
    const picked = it.pool?.visible() || [];
    if (!picked.length) {
      const miss = batchFormat === 'quotes' ? 'no quotes found' : 'no trivia found';
      console.warn('[tik-batch] nothing to write', { movie: it.title, format: batchFormat, error: it.error });
      failed.push(`${it.title} (${it.error || miss})`);
      runFilmEnd(false, it.error || miss);
      continue;
    }
    try {
      let suggestions;
      let meta;
      if (batchFormat === 'quotes') {
        runStep('subs', 'Matching the lines to the film’s subtitles');
        const packSubs = await fetchSubtitles({ imdbId: it.imdbId, query: it.title, year: it.year });
        runStep('write', `${picked.length} quotes going in`);
        // Carried onto the draft so the editor can explain the guessed times
        // later, when whoever opens it has no idea this call ever happened.
        it.subsError = packSubs.missing ? (packSubs.error || 'Subtitle lookup failed') : null;
        if (packSubs.missing) console.warn('[tik-batch] no subtitles', { movie: it.title, error: packSubs.error });
        const result = await fetchQuotesPost({
          title: it.title,
          year: it.year,
          durationSeconds: it.runtimeSeconds || 0,
          count: Math.min(8, picked.length),
          quotes: picked,
          cues: packSubs.cues || [],
          includeTitleSlide: true,
          includeMeta: true,
          guidance: '',
          onProgress: runDetail,
        });
        suggestions = result.suggestions;
        meta = result.meta;
      } else {
        // A blank-line separated list is what the server reads as USER-CHOSEN
        // FACTS: it rewrites each one, in order, and adds nothing of its own.
        runStep('write', `${picked.length} facts going in`);
        const result = await fetchTriviaPost({
          title: it.title,
          year: it.year,
          durationSeconds: it.runtimeSeconds || 0,
          count: picked.length,
          // Same opener the hand-driven flow gets: the server prepends a title
          // slide ("Movie (Year)" + a lead-in) pointed at the film's title card,
          // so it arrives as suggestions[0] and the count above stays the number
          // of TRIVIA slides.
          includeTitleSlide: true,
          // Same call writes the post's own copy: hook, film hashtags, and
          // soundtrack picks. Doing it here is what lets the prompt forbid the
          // hook from spoiling a fact, since the model has the captions in hand.
          includeMeta: true,
          guidance: picked.map((p) => p.text).join('\n\n'),
          onProgress: runDetail,
        });
        suggestions = result.suggestions;
        meta = result.meta;
      }
      if (!suggestions?.length) {
        const miss = batchFormat === 'quotes' ? 'no quotes returned' : 'no trivia returned';
        failed.push(`${it.title} (${miss})`);
        runFilmEnd(false, miss);
        continue;
      }
      runStep('save', 'Saving the draft');
      it.draftId = await saveDraft(it, suggestions, meta, made);
      it.state = 'written';
      made++;
      runFilmEnd(true);
    } catch (e) {
      console.error(`[tik-batch] draft failed: ${it.title} — ${e.message}`, e);
      it.state = 'error';
      it.error = e.message;
      failed.push(it.title);
      runFilmEnd(false, e.message);
    }
  }

  setBusy(false);
  // Say what did NOT work as plainly as what did — a silent partial run is
  // how you end up publishing eight drafts and wondering where two went. The
  // panel stays up as the summary, failures named with their reasons, with
  // the way on to Shoot; it does not jump tabs on its own any more, because
  // the summary is the thing worth reading.
  runFinish();
  await refreshShoot();
  if (failed.length) console.warn('[tik-batch] run finished with failures', { made, failed });
}

async function saveDraft(item, suggestions, meta = null, batchIndex = 0) {
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

  const project = makeProject({ id, format: batchFormat, now });
  project.subsError = item.subsError || null;
  // Round-robin the house hashtag pair across the run rather than hashing ten
  // random ids: a batch of ten then covers all five sets twice, which is what
  // makes the tag report readable in weeks instead of months.
  const post = defaultPostFields(batchFormat, label, {
    meta, projectId: id, houseSetKey: houseSetAt(batchIndex).key,
  });
  Object.assign(project, {
    name: label,
    movie: { title: item.title, year: item.year, query: item.title },
    postTitle: post.title,
    postDesc: post.description,
    hashtagSet: post.hashtagSet,
    postMeta: meta || null,
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
        fontScale: i === 0 ? 1 : (batchFormat === 'quotes' ? fontScaleForQuote(s.caption) : 1),
        role: null, kind: i === 0 ? 'title' : null, entry: null, section: null,
        // Where the timecode came from, so Shoot and the editor can say whether
        // it was matched against the subtitles or estimated.
        cue: s.matched ? (s.cue || { start: s.start, end: s.end }) : null,
        frame,
        batchShot: i === 0 ? 'title' : (batchFormat === 'quotes' ? 'quotes' : 'trivia'),
      })),
      ...(outro ? [{
        id: String(suggestions.length + 1),
        caption: pickOutro(batchFormat),
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
// The caption now comes from project.js's shared pool rather than a copy kept
// in step by hand, so batch drafts get the same rotating sign-off.
const OUTRO_LOGO_URL = '/images/vhs-garage-logo-square.png';

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
