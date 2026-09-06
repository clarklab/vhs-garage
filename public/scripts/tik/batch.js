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
    build: $('batch-build'), buildLabel: $('batch-build-label'),
    pickerTitle: $('batch-picker-title'), pickerMeta: $('batch-picker-meta'),
    size: $('batch-size'), spoilers: $('batch-spoilers'), curate: $('batch-curate'),
    curateWrap: $('batch-curate-wrap'),
    curateNote: $('batch-curate-note'),
    replaceAll: $('batch-replace-all'), reset: $('batch-reset'),
    trivia: $('batch-trivia'), triviaEmpty: $('batch-trivia-empty'),
  };

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
  if (!on) refreshBuildButton();
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
    const posted = (await listProjects().catch(() => []))
      .filter((p) => p.format === batchFormat && p.movie?.title)
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

    let added = 0;
    for (const pick of picks) if (addToQueue(pick) === 'added') added++;
    const steered = guidance ? ` for “${guidance}”` : '';
    say(added
      ? `Queued ${added} movie${added === 1 ? '' : 's'}${steered}.`
      : `Nothing new to add${steered} — all of those are already queued.`, added ? 'good' : 'idle');
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
function addToQueue(pick) {
  const verdict = queueAdmission(pick, queue, MAX_QUEUE);
  if (!verdict.ok) return verdict.reason;
  queue.push({
    key: verdict.key, title: String(pick.title).trim(), year: pick.year ?? null, why: pick.why || '',
    imdbId: pick.imdbId || pick.id || null,
    runtimeSeconds: pick.runtimeSeconds || null,
    pool: null, state: 'idle', error: '', draftId: null,
  });
  // The list grows downward, so with a few films queued a new row lands well
  // below the search box that was just clicked. renderQueue scrolls to this.
  justAdded = { key: verdict.key, at: Date.now() };
  if (!selectedKey) selectMovie(verdict.key);
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
  render();
  const it = find(key);
  if (it) ensurePool(it);
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

  // Curate in the background once the pool is on screen: the vote-ranked ten
  // shows instantly, then re-ranks when the agent answers. Only the movie
  // being looked at — the rest get curated during buildAll, so a ten-movie
  // queue doesn't fire ten agent calls just from being queued.
  if (item.state === 'ready' && selectedKey === item.key && format !== 'quotes') curateSelected(item);
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
        if (!it.pool && it.state === 'idle') await ensurePool(it);
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
  const size = item.pool.size();
  const all = item.pool.top(CANDIDATES);
  if (all.length <= size) return false; // nothing to choose between

  announce('Agent is picking the best of the top 25…');
  try {
    const res = await runCurateJob({
      title: item.title,
      year: item.year,
      count: size,
      candidates: all.map((c) => ({ id: c.id, text: c.text })),
    });
    if (!res?.order?.length) return false;
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
    for (const it of queue) { it.pool = null; it.state = 'idle'; it.curated = 0; }
    render();
    const it = find(selectedKey);
    if (it) ensurePool(it);
    return;
  }
  const it = find(selectedKey);
  if (it?.pool) curateSelected(it);
}

async function curateSelected(item) {
  if (batchFormat === 'quotes') return false;
  const changed = await curatePool(item, { announce: (m) => { els.curateNote.textContent = m; els.curateNote.classList.remove('hidden'); } });
  if (find(selectedKey) === item) renderPicker();
  renderQueue();
  return changed;
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
  poolGeneration += 1;
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
  let fresh = null;
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
    return `${n} picked of ${it.pool.total()}${it.pool.exhausted() ? ' (all used)' : ''}`;
  }
  return it.why || 'Queued';
}

function renderPicker() {
  const it = find(selectedKey);
  els.trivia.innerHTML = '';

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
      say(`Loading ${batchFormat === 'quotes' ? 'quotes' : 'trivia'} for ${it.title} (${i + 1} of ${ready.length})…`);
      await ensurePool(it);
    }
    // Curate before writing so an unopened movie still gets the agent's ten
    // rather than the raw vote order. Quotes skip this: the ranked IMDb list
    // is the source, and Autopilot boils the picked lines itself.
    if (batchFormat !== 'quotes' && it.pool && !it.curated) {
      say(`Choosing the best trivia for ${it.title} (${i + 1} of ${ready.length})…`);
      await curatePool(it);
      if (selectedKey === it.key) renderPicker();
    }
    const picked = it.pool?.visible() || [];
    if (!picked.length) {
      const miss = batchFormat === 'quotes' ? 'no quotes found' : 'no trivia found';
      console.warn('[tik-batch] nothing to write', { movie: it.title, format: batchFormat, error: it.error });
      failed.push(`${it.title} (${it.error || miss})`);
      continue;
    }
    say(`Writing ${it.title} (${i + 1} of ${ready.length}) — ${picked.length} ${batchFormat === 'quotes' ? 'quotes' : 'facts'}…`);
    try {
      let suggestions;
      let meta;
      if (batchFormat === 'quotes') {
        const packSubs = await fetchSubtitles({ imdbId: it.imdbId, query: it.title, year: it.year });
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
          onProgress: (m) => say(`${it.title} — ${m}`),
        });
        suggestions = result.suggestions;
        meta = result.meta;
      } else {
        // A blank-line separated list is what the server reads as USER-CHOSEN
        // FACTS: it rewrites each one, in order, and adds nothing of its own.
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
          onProgress: (m) => say(`${it.title} (${i + 1} of ${ready.length}) — ${m}`),
        });
        suggestions = result.suggestions;
        meta = result.meta;
      }
      if (!suggestions?.length) {
        failed.push(`${it.title} (${batchFormat === 'quotes' ? 'no quotes returned' : 'no trivia returned'})`);
        continue;
      }
      it.draftId = await saveDraft(it, suggestions, meta, made);
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
  await refreshShoot();
  // Say what did NOT work as plainly as what did — a silent partial run is
  // how you end up publishing eight drafts and wondering where two went.
  say(
    failed.length
      ? `Wrote ${made} draft${made === 1 ? '' : 's'}. Failed: ${failed.join(', ')}.`
      : `Wrote ${made} draft${made === 1 ? '' : 's'} — now find their frames.`,
    failed.length ? 'bad' : 'good',
  );
  // Step 1 done, so move to step 2 instead of leaving the user to find the
  // tab. Only on a clean run: with failures the queue still needs attention.
  if (made && !failed.length) {
    showTab('shoot', { animate: true });
    refreshShoot();                 // and the new drafts appear already matched
  }
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
        cue: s.matched ? { start: s.start, end: s.end } : null,
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
