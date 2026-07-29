// VHS Studio — the /tik app controller. Screens: HOME (new + open) and EDITOR
// (per-format panes over a shared slide list). Projects autosave to IndexedDB
// (store.js) so drafts and posted TikToks survive reloads; the video file
// itself can't persist (browser limitation), but every slide's frame does.
import { loadVideoFile, grabFrame, awaitSeekSettled, seekAndSettle } from './capture.js';
import { initScrubber } from './scrubber.js';
import { addSlide, removeSlide, reorderSlide, editCaption, canAddSlide, MAX_SLIDES, updateSlideFrame } from './slides.js';
import { startAuth, handleRedirect, signOut, isSignedIn, clearLocalToken } from './auth.js';
import { publishSlideshow } from './publish.js';
import { fetchScenes, fetchRoles, fetchBlurbs, fetchYearSnapshot } from './autopilot.js';
import { parseMovieName } from './filename.js';
import { composeToCanvas, composeSlide } from './compose.js';
import {
  FORMATS, YEAR_LISTS, formatOf, makeProject, defaultPostFields, captionForRole,
  sectionCaption, captionForYearEntry, photoQueryFor, relativeTime, projectDisplayName,
} from './project.js';
import { storageAvailable, putProject, getProject, listProjects, deleteProject } from './store.js';
import { makeCardBitmap } from './placeholder.js';
import { composeMosaic, MOSAIC_MAX } from './mosaic.js';
import { fetchFollowerStats, renderFollowerChart, fmtCount } from './stats.js';

const $ = (id) => document.getElementById(id);
const els = {
  // app bar
  authBtn: $('auth-btn'), authStatus: $('auth-status'),
  saveState: $('save-state'), saveDot: $('save-dot'), saveLabel: $('save-label'),
  // screens
  home: $('screen-home'), editor: $('screen-editor'),
  // home
  newTrivia: $('new-trivia'), newGuys: $('new-guys'), newYear: $('new-year'),
  grid: $('project-grid'), libraryEmpty: $('library-empty'),
  statsCard: $('stats-card'), statsCount: $('stats-count'), statsDelta: $('stats-delta'),
  statsNote: $('stats-note'), statsPlot: $('stats-plot'), statsChart: $('stats-chart'), statsTip: $('stats-tip'),
  // editor bar
  back: $('back-btn'), formatChip: $('format-chip'), projectName: $('project-name'),
  download: $('download-btn'), post: $('post-btn'), status: $('post-status'),
  // trivia pane
  paneTrivia: $('pane-trivia'), file: $('file-input'), videoNote: $('video-note'),
  video: $('video'), range: $('scrub-range'), timecode: $('timecode'),
  grab: $('grab-btn'), grabIcon: $('grab-icon'), grabLabel: $('grab-label'),
  cancelEdit: $('cancel-edit'),
  titleToggle: $('title-toggle'), movieTitle: $('movie-title'),
  autopilot: $('autopilot-btn'), autopilotPrompt: $('autopilot-prompt'),
  // guys pane
  paneGuys: $('pane-guys'), actorInput: $('actor-input'), findRoles: $('find-roles-btn'),
  rolesBox: $('roles-box'), rolesList: $('roles-list'),
  rolesAll: $('roles-all'), rolesNone: $('roles-none'), pickedCount: $('picked-count'),
  writeBlurbs: $('write-blurbs-btn'), writeBlurbsLabel: $('write-blurbs-label'),
  // year pane
  paneYear: $('pane-year'), yearInput: $('year-input'),
  yearLookup: $('year-lookup-btn'), yearLookupLabel: $('year-lookup-label'),
  yearSummary: $('year-summary'), yearSummaryYear: $('year-summary-year'),
  yearSummaryLists: $('year-summary-lists'), yearRebuild: $('year-rebuild-btn'),
  // post details
  postTitleInput: $('post-title-input'), postDescInput: $('post-desc-input'), postReset: $('post-reset'),
  // slides pane
  count: $('slide-count'), list: $('slide-list'), addScene: $('add-scene'), slidesHint: $('slides-hint'),
  imgFile: $('img-file-input'),
};

// ---- State ----
let project = null;            // active project record (metadata; slides live below)
let slides = [];               // [{ id, bitmap, blob?, caption, timecode?, grabHint, fontScale, role? }]
let nextId = 1;
let dragFrom = null;
let editingId = null;          // slide id whose frame is being replaced, or null
let pickTargetId = null;       // slide id the hidden image-file input feeds
let videoReady = false;        // metadata loaded → grabbing is possible
let aiBusy = false;            // an AI action is in flight
let movie = { title: '', year: null, query: '' }; // parsed from the filename (trivia)
let dirty = false;
let saveTimer = null;
let savePromise = null;        // in-flight save chain — awaiting it guarantees the latest state hit IDB
let openSeq = 0;               // open/new/teardown generation — stale openProject loads abort
let thumbUrls = [];            // library-card object URLs, revoked on re-render
const PREVIEW_SCALE = 0.25;    // quarter-res preview thumbnails; uploads stay full-res
const MAX_PICK = 12;           // Some Guys: max roles per slideshow
const GUYS_ACCENT = '#22d3ee';
const YEAR_ACCENT = '#a78bfa';

const uuid = () => crypto.randomUUID?.() ??
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

// A Material Symbols icon element (for JS-created buttons).
function iconSpan(name, sizeClass = 'text-[18px]') {
  const s = document.createElement('span');
  s.className = `material-symbols-outlined ${sizeClass} leading-none`;
  s.textContent = name;
  return s;
}

initScrubber({
  video: els.video, range: els.range, timecode: els.timecode,
  steps: [...document.querySelectorAll('#scrubber [data-frames], #scrubber [data-seconds]')],
});

els.video.addEventListener('loadedmetadata', () => {
  videoReady = true;
  els.videoNote.classList.add('hidden');
  els.autopilot.disabled = aiBusy; // stay disabled if a job is mid-flight
  els.autopilot.title = '';
  render(); // updates the Add-scene button state
});

// One AI action at a time. Background jobs can run for minutes, so ALL the
// AI entry points must visibly disable together — not just the button clicked.
function setAiBusy(v) {
  aiBusy = v;
  els.autopilot.disabled = v || !videoReady;
  els.addScene.disabled = v || !videoReady || !canAddSlide(slides);
  els.findRoles.disabled = v;
  els.writeBlurbs.disabled = v || pickedRoles().length === 0;
  els.yearLookup.disabled = v;
  els.yearRebuild.disabled = v || !project?.snapshot;
}

// TikTok pulls slide images over the public internet, so posting only works from
// a publicly reachable origin. Everything else works anywhere.
function isPublicOrigin() {
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) return false;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false; // private ranges
  return true;
}

// Seek to a timecode and grab the settled frame.
async function grabAt(timecode) {
  await seekAndSettle(els.video, timecode);
  return grabFrame(els.video);
}

// Branded outro slide: the VHS Garage logo as the "frame" + a follow CTA,
// flowing through the normal slide pipeline (editable, reorderable).
const OUTRO_LOGO_URL = '/images/vhs-garage-logo-square.png'; // yellow lockup (V mark), black field
const OUTRO_CAPTIONS = {
  trivia: 'Follow VHS Garage for more movie trivia',
  guys: 'Follow VHS Garage, we remember more guys every week',
  year: 'Follow VHS Garage, we rewind another year every week',
};
async function makeOutroSlide() {
  const res = await fetch(OUTRO_LOGO_URL);
  if (!res.ok) throw new Error(`Couldn't load the outro logo (${res.status})`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  return {
    id: String(nextId++), bitmap, blob,
    caption: OUTRO_CAPTIONS[project?.format] || OUTRO_CAPTIONS.trivia,
    grabHint: '', fontScale: 1, role: null, kind: 'outro',
  };
}

// ================= Persistence =================
// Slides carry their frame as a cached Blob (`slide.blob`) so autosave never
// re-encodes 35 full-res JPEGs; any code that swaps `bitmap` must null it.
async function bitmapToBlob(bitmap) {
  const c = document.createElement('canvas');
  c.width = bitmap.width;
  c.height = bitmap.height;
  c.getContext('2d').drawImage(bitmap, 0, 0);
  return await new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Frame encode failed'))), 'image/jpeg', 0.92);
  });
}
async function frameBlobFor(slide) {
  if (!slide.blob) slide.blob = await bitmapToBlob(slide.bitmap);
  return slide.blob;
}

// Library-card thumbnail: the first slide, fully composed, small.
async function makeThumbBlob(slide) {
  const c = document.createElement('canvas');
  composeToCanvas(c, slide.bitmap, slide.caption, {
    titleLine: currentTitleLine(), scale: 0.12, fontScale: slide.fontScale || 1,
  });
  return await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.7));
}

async function serializeProject() {
  const slideRecs = [];
  for (const s of slides) {
    slideRecs.push({
      id: s.id, caption: s.caption, timecode: s.timecode, grabHint: s.grabHint || '',
      fontScale: s.fontScale || 1, role: s.role || null, kind: s.kind || null,
      entry: s.entry || null, section: s.section || null,
      frame: await frameBlobFor(s),
    });
  }
  let thumb = null;
  if (slides[0]) {
    try { thumb = await makeThumbBlob(slides[0]); }
    catch (e) { console.warn('[tik] thumb render failed:', e); }
  }
  return { ...project, updatedAt: Date.now(), slides: slideRecs, thumb };
}

function setSaveState(state) {
  const show = state !== 'off';
  els.saveState.classList.toggle('hidden', !show);
  els.saveState.classList.toggle('flex', show);
  els.saveDot.classList.remove('save-pulse', 'bg-amber-400', 'bg-green-500', 'bg-red-500', 'bg-neutral-600');
  if (state === 'saving') { els.saveDot.classList.add('bg-amber-400', 'save-pulse'); els.saveLabel.textContent = 'Saving…'; }
  else if (state === 'saved') { els.saveDot.classList.add('bg-green-500'); els.saveLabel.textContent = 'Saved'; }
  else if (state === 'error') { els.saveDot.classList.add('bg-red-500'); els.saveLabel.textContent = 'Save failed'; }
  else els.saveDot.classList.add('bg-neutral-600');
}

// Debounced autosave: call after ANY project/slide mutation.
function markDirty() {
  if (!project) return;
  if (!storageAvailable()) return;
  dirty = true;
  setSaveState('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveNow().catch((e) => console.error('[tik] autosave failed:', e)); }, 1200);
}

// Single-flight but awaitable: concurrent calls chain onto the in-flight save,
// so `await saveNow()` ALWAYS means "my latest state is in IndexedDB" — goHome
// and the post-success path rely on that. (The old savingNow flag returned
// early instead, silently dropping the caller's edits on the floor.)
function saveNow() {
  if (!project || !storageAvailable()) return Promise.resolve();
  clearTimeout(saveTimer);
  const run = async () => {
    if (!project) return; // torn down while queued
    setSaveState('saving');
    // Clear BEFORE serializing: an edit landing mid-save re-arms the flag, so
    // the goHome/pagehide "flush if dirty" gates can't skip an unsaved edit.
    dirty = false;
    try {
      const record = await serializeProject();
      await putProject(record);
      setSaveState('saved');
    } catch (e) {
      dirty = true; // this state did NOT persist
      console.error('[tik] save failed:', e);
      setSaveState('error');
      throw e; // awaiting callers (goHome flush, post-success) must see failures
    }
  };
  // Single-flight chain: a failed predecessor must not block the next attempt.
  const p = (savePromise ? savePromise.catch(() => {}) : Promise.resolve()).then(run);
  savePromise = p;
  p.catch(() => {}).finally(() => { if (savePromise === p) savePromise = null; });
  return p;
}

// ================= Routing =================
function showScreen(name) {
  els.home.classList.toggle('hidden', name !== 'home');
  els.editor.classList.toggle('hidden', name !== 'editor');
}

async function teardownProject() {
  clearTimeout(saveTimer);
  // Let any in-flight save finish before closing the bitmaps it may still be
  // encoding (drawImage on a closed ImageBitmap throws).
  if (savePromise) {
    try { await savePromise; } catch (e) { console.error('[tik] pending save failed during teardown:', e); }
  }
  slides.forEach((s) => s.bitmap?.close?.());
  slides = [];
  project = null;
  dirty = false;
  resetEditState();
  pickTargetId = null;
  editingId = null;
  videoReady = false;
  els.video.removeAttribute('src');
  els.video.load?.();
  movie = { title: '', year: null, query: '' };
  // Reset the trivia pane: a lingering file-input value means re-picking the
  // SAME movie file fires no 'change' event (silent no-op), and the reopened-
  // project banner/autopilot state must not leak into the next project.
  els.file.value = '';
  els.videoNote.classList.add('hidden');
  els.autopilot.disabled = true;
  els.autopilot.title = 'Load a video first';
  els.range.value = '0';
  els.yearSummary.classList.add('hidden');
  els.list.innerHTML = '';
  els.status.textContent = '';
  setSaveState('off');
}

async function goHome() {
  openSeq++; // abort any in-flight openProject load
  if (project && dirty) {
    try {
      await saveNow();
    } catch (e) {
      console.error('[tik] exit save failed:', e);
      if (!confirm('Saving failed (storage full?) — leave anyway and lose the latest changes?')) return;
    }
  }
  await teardownProject();
  history.replaceState({}, '', location.pathname + location.search);
  showScreen('home');
  refreshStatsCard(); // non-blocking; errors handled inside
  await renderLibrary();
}

function enterEditor() {
  showScreen('editor');
  history.replaceState({}, '', `${location.pathname}${location.search}#p/${project.id}`);
  applyFormatUI();
  els.projectName.value = project.name || '';
  els.postTitleInput.value = project.postTitle || '';
  els.postDescInput.value = project.postDesc || '';
  els.titleToggle.checked = !!project.titleOn;
  els.movieTitle.value = project.titleLine || '';
  els.movieTitle.disabled = !project.titleOn;
  els.actorInput.value = project.actor || '';
  els.yearInput.value = project.year || '';
  els.autopilotPrompt.value = '';
  renderRolesPicker();
  renderYearSummary();
  setSaveState(storageAvailable() ? (dirty ? 'saving' : 'saved') : 'off');
  render();
}

// Appends a persistent warning when local saving can't work in this browser.
function withStorageWarning(msg) {
  return storageAvailable() ? msg : `${msg} (Local saving is unavailable in this browser — work here won’t persist.)`;
}

async function newProject(format) {
  openSeq++; // abort any in-flight openProject load
  await teardownProject();
  project = makeProject({ id: uuid(), format, now: Date.now() });
  const d = defaultPostFields(format, '');
  project.postTitle = d.title;
  project.postDesc = d.description;
  nextId = 1;
  enterEditor();
  const opener = {
    guys: 'Name the guy, and the agent lists his most memorable roles.',
    year: 'Pick a year, and the agent pulls its top eight rated, grossing, and rented.',
  };
  els.status.textContent = withStorageWarning(opener[format]
    || 'Pick a movie file to start grabbing frames, or run Autopilot.');
}

async function openProject(id) {
  const seq = ++openSeq; // superseded by any later open/new/goHome
  const rec = await getProject(id);
  if (seq !== openSeq) return;
  if (!rec) throw new Error('Project not found');
  await teardownProject();
  if (seq !== openSeq) return; // superseded while flushing the previous save
  project = { ...rec, slides: [], thumb: null };
  movie = rec.movie || { title: '', year: null, query: '' };
  nextId = 1;
  const loaded = [];
  for (const s of rec.slides || []) {
    try {
      const bitmap = await createImageBitmap(s.frame);
      if (seq !== openSeq) { // another project opened while decoding — abort
        bitmap.close?.();
        loaded.forEach((l) => l.bitmap?.close?.());
        return;
      }
      loaded.push({
        id: String(nextId++), bitmap, blob: s.frame,
        caption: s.caption || '', timecode: s.timecode, grabHint: s.grabHint || '',
        fontScale: s.fontScale || 1, role: s.role || null, kind: s.kind || null,
        entry: s.entry || null, section: s.section || null,
      });
    } catch (e) {
      console.error('[tik] could not decode a saved frame; slide dropped', e);
    }
  }
  if (seq !== openSeq) { loaded.forEach((l) => l.bitmap?.close?.()); return; }
  slides = loaded;
  dirty = false;
  enterEditor();
  if (project.format === 'trivia') {
    els.videoNote.classList.toggle('hidden', slides.length === 0);
    els.status.textContent = withStorageWarning(slides.length
      ? 'Reopened from your library — captions, fonts, and posting all work; re-pick the movie file to grab new frames.'
      : 'Reopened — pick the movie file to start.');
  } else {
    els.status.textContent = withStorageWarning('Reopened from your library.');
  }
}

// ---- Format-specific UI wiring ----
// One source pane per format; only the active one is shown (panes are flex
// columns, so "hidden" has to be swapped for "flex", not just removed).
const PANES = { trivia: els.paneTrivia, guys: els.paneGuys, year: els.paneYear };
function applyFormatUI() {
  const f = formatOf(project);
  for (const [key, pane] of Object.entries(PANES)) {
    const on = key === f.key;
    pane.classList.toggle('hidden', !on);
    pane.classList.toggle('flex', on);
  }
  els.addScene.classList.toggle('hidden', f.key !== 'trivia');
  els.formatChip.textContent = f.label;
  els.formatChip.className = `rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${f.chip}`;
  els.slidesHint.textContent = f.editorHint;
}

// Keep the suggested post title/description fresh until the user edits them.
function syncPostDefaults() {
  if (!project || project.postEdited) return;
  const name = project.format === 'guys'
    ? (project.actor || project.name)
    : project.format === 'year'
      ? (project.year ? String(project.year) : project.name)
      : (movie.query || project.name);
  const d = defaultPostFields(project.format, name);
  project.postTitle = d.title;
  project.postDesc = d.description;
  els.postTitleInput.value = d.title;
  els.postDescInput.value = d.description;
}

// ================= Library =================
function formatBadge(rec) {
  const f = FORMATS[rec.format] || FORMATS.trivia;
  return `<span class="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${f.chip}">${f.label}</span>`;
}

async function renderLibrary() {
  thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  thumbUrls = [];
  els.grid.innerHTML = '';
  if (!storageAvailable()) {
    els.libraryEmpty.textContent = 'Local storage is unavailable in this browser, so projects can’t be saved here.';
    els.libraryEmpty.classList.remove('hidden');
    return;
  }
  let list = [];
  try {
    list = await listProjects();
  } catch (e) {
    console.error('[tik] library load failed:', e);
    els.libraryEmpty.textContent = 'Couldn’t open the local library — check the console.';
    els.libraryEmpty.classList.remove('hidden');
    return;
  }
  els.libraryEmpty.classList.toggle('hidden', list.length > 0);

  for (const rec of list) {
    const card = document.createElement('button');
    card.className = 'group relative overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 text-left transition hover:border-neutral-600';
    card.title = `Open ${projectDisplayName(rec)}`;

    const frame = document.createElement('div');
    frame.className = 'relative aspect-[9/14] w-full overflow-hidden bg-neutral-950';
    if (rec.thumb) {
      const url = URL.createObjectURL(rec.thumb);
      thumbUrls.push(url);
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      img.className = 'h-full w-full object-cover opacity-90 transition group-hover:opacity-100';
      frame.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'flex h-full w-full items-center justify-center text-neutral-700';
      ph.appendChild(iconSpan((FORMATS[rec.format] || FORMATS.trivia).icon, 'text-[40px]'));
      frame.appendChild(ph);
    }
    const posted = rec.status === 'posted';
    const badge = document.createElement('span');
    badge.className = `absolute left-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${posted ? 'bg-green-500/90 text-neutral-950' : 'bg-neutral-950/80 text-amber-300'}`;
    badge.textContent = posted ? 'Posted' : 'Draft';
    frame.appendChild(badge);

    const del = document.createElement('span');
    del.className = 'absolute right-2 top-2 hidden rounded-md bg-neutral-950/80 p-1 text-neutral-400 hover:text-red-400 group-hover:block';
    del.title = 'Delete project';
    del.setAttribute('role', 'button');
    del.appendChild(iconSpan('delete', 'text-[16px]'));
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${projectDisplayName(rec)}"? This can't be undone.`)) return;
      try {
        await deleteProject(rec.id);
        await renderLibrary();
      } catch (err) {
        console.error('[tik] delete failed:', err);
        alert('Couldn’t delete that project — check the console.');
      }
    });
    frame.appendChild(del);

    const meta = document.createElement('div');
    meta.className = 'flex flex-col gap-1 p-2.5';
    const name = document.createElement('span');
    name.className = 'truncate text-sm font-bold tracking-tight';
    name.textContent = projectDisplayName(rec);
    const sub = document.createElement('span');
    sub.className = 'flex items-center gap-1.5 text-[11px] text-neutral-500';
    sub.innerHTML = `${formatBadge(rec)} <span>${(rec.slides || []).length} slides · ${relativeTime(rec.updatedAt || 0, Date.now())}</span>`;
    meta.append(name, sub);

    card.append(frame, meta);
    card.addEventListener('click', () => {
      openProject(rec.id).catch((e) => {
        console.error('[tik] open failed:', e);
        alert('Couldn’t open that project — check the console.');
      });
    });
    els.grid.appendChild(card);
  }
}

els.newTrivia.addEventListener('click', () => { newProject('trivia').catch((e) => console.error('[tik] new project failed:', e)); });
els.newGuys.addEventListener('click', () => { newProject('guys').catch((e) => console.error('[tik] new project failed:', e)); });
els.newYear.addEventListener('click', () => { newProject('year').catch((e) => console.error('[tik] new project failed:', e)); });

// ---- Followers card (home) ----
// Current count from TikTok when signed in (snapshotted at most hourly);
// the accumulated series renders as a line chart once it has 2+ days.
let lastStatsSeries = null;
async function refreshStatsCard() {
  try {
    const data = await fetchFollowerStats();
    const series = data.series || [];
    const latest = data.profile?.followers ?? (series.length ? series[series.length - 1].c : null);
    if (latest === null && !isSignedIn()) { els.statsCard.classList.add('hidden'); return; }
    els.statsCard.classList.remove('hidden');
    els.statsCount.textContent = latest === null ? '—' : fmtCount(latest);
    if (data.delta) {
      const { delta, days } = data.delta;
      els.statsDelta.textContent = `${delta >= 0 ? '+' : '−'}${fmtCount(Math.abs(delta))} · last ${days}d`;
      els.statsDelta.className = `text-xs font-semibold tabular-nums ${delta > 0 ? 'text-green-400' : delta < 0 ? 'text-red-400' : 'text-neutral-500'}`;
    } else {
      els.statsDelta.textContent = '';
    }
    els.statsNote.textContent = series.length < 2
      ? 'First snapshot logged — the line starts with tomorrow’s visit (TikTok has no history API)'
      : 'Logged each time you open the studio';
    if (series.length >= 2) {
      els.statsPlot.classList.remove('hidden');
      lastStatsSeries = series;
      // Render on the next frame so layout reflects the just-unhidden plot —
      // measuring too early bakes a 0-width fallback into the raster.
      requestAnimationFrame(() => renderFollowerChart(els.statsChart, series, els.statsTip));
    } else {
      els.statsPlot.classList.add('hidden');
      lastStatsSeries = null;
    }
  } catch (e) {
    console.error('[tik] follower stats failed:', e);
    if (e.reauth) { clearLocalToken(); refreshAuthUI(); }
    if (!isSignedIn()) { els.statsCard.classList.add('hidden'); return; }
    els.statsCard.classList.remove('hidden');
    els.statsNote.textContent = e.scope
      ? (e.hint || e.message)
      : (e.reauth ? 'Sign in again to track followers.' : 'Follower stats are unavailable right now.');
  }
}

// Re-render the chart on resize (debounced) so it tracks the card's width.
let statsResizeTimer = null;
window.addEventListener('resize', () => {
  if (!lastStatsSeries || els.home.classList.contains('hidden')) return;
  clearTimeout(statsResizeTimer);
  statsResizeTimer = setTimeout(() => renderFollowerChart(els.statsChart, lastStatsSeries, els.statsTip), 150);
});

// A drop that misses a slide card must not navigate the tab away to the
// dropped file (the UI actively invites drag-and-drop onto slides).
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// Best-effort flush when the tab is backgrounded/closed mid-debounce — async
// IndexedDB writes generally complete during pagehide.
window.addEventListener('pagehide', () => {
  if (project && dirty) saveNow().catch((e) => console.error('[tik] pagehide save failed:', e));
});
els.back.addEventListener('click', () => {
  if (aiBusy && !confirm('An AI job is still running — leave this project anyway?')) return;
  goHome().catch((e) => console.error('[tik] goHome failed:', e));
});

els.projectName.addEventListener('input', () => {
  if (!project) return;
  project.name = els.projectName.value.trim();
  syncPostDefaults();
  markDirty();
});

// ================= Auth =================
function refreshAuthUI() {
  const signed = isSignedIn();
  els.authStatus.textContent = signed ? 'signed in' : 'not signed in';
  els.authBtn.textContent = signed ? 'Sign out' : 'Sign in to TikTok';
  updatePostButton();
}
els.authBtn.addEventListener('click', async () => {
  try {
    if (isSignedIn()) { await signOut(); } else { await startAuth(); return; }
  } catch (e) { console.error('[tik] auth failed:', e); alert(e.message); }
  refreshAuthUI();
});

// ================= Tape Trivia =================
els.file.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file || !project) return;
  movie = parseMovieName(file.name);
  project.movie = movie;
  if (!project.name) {
    project.name = movie.query;
    els.projectName.value = movie.query;
  }
  syncPostDefaults();
  try {
    await loadVideoFile(file, els.video);
    els.status.textContent = `Loaded ${movie.query}. Scrub and grab frames, or run Autopilot.`;
  } catch (err) {
    console.error('[tik] failed to load video file:', err);
    els.status.textContent = err.message;
  }
  markDirty();
});

// ---- Title prefix toggle ----
els.titleToggle.addEventListener('change', () => {
  els.movieTitle.disabled = !els.titleToggle.checked;
  if (project) project.titleOn = els.titleToggle.checked;
  redrawAllThumbs(); // title line appears/disappears on every slide preview
  markDirty();
});
els.movieTitle.addEventListener('input', () => {
  if (project) project.titleLine = els.movieTitle.value;
  redrawAllThumbs();
  markDirty();
});
function currentTitleLine() {
  // The title prefix is a Tape Trivia affordance; the other formats bake their
  // heading into the caption itself.
  if (project && project.format !== 'trivia') return '';
  return els.titleToggle.checked ? els.movieTitle.value.trim() : '';
}

// ---- Grab / Save frame ----
els.grab.addEventListener('click', async () => {
  try {
    await awaitSeekSettled(els.video); // don't grab a stale frame mid-seek
    const bitmap = await grabFrame(els.video);
    if (editingId) {
      slides = updateSlideFrame(slides, editingId, bitmap, els.video.currentTime);
      slides = slides.map((s) => (s.id === editingId ? { ...s, blob: null } : s));
      exitEdit();
      els.status.textContent = 'Frame updated.';
    } else {
      if (!canAddSlide(slides)) { els.status.textContent = `Max ${MAX_SLIDES} slides.`; return; }
      slides = addSlide(slides, { id: String(nextId++), bitmap, blob: null, caption: '', timecode: els.video.currentTime, fontScale: 1 });
      render();
    }
    markDirty();
  } catch (err) { console.error('[tik] grab failed:', err); els.status.textContent = err.message; }
});

// ---- Autopilot: preload a full slideshow ----
els.autopilot.addEventListener('click', async () => {
  if (!videoReady) { els.status.textContent = 'Load a video first.'; return; }
  if (!canAddSlide(slides)) { els.status.textContent = `Slide cap reached (${MAX_SLIDES}) — delete some first.`; return; }
  if (aiBusy) return;
  setAiBusy(true);
  const ticket = project?.id; // bail if the user opens another project mid-job
  try {
    els.status.textContent = `Researching ${movie.query || 'the film'}…`;
    // If the starter box holds a list of pasted facts, make one slide per fact
    // (capped); otherwise the default 5. Title slide is always added on top.
    const guidance = els.autopilotPrompt.value.trim();
    const pasteItems = guidance.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    const count = pasteItems.length >= 2 ? Math.min(pasteItems.length, 12) : 5;
    const scenes = await fetchScenes({
      title: movie.title, year: movie.year, durationSeconds: els.video.duration,
      count, includeTitleSlide: true, guidance,
      onProgress: (m) => { els.status.textContent = `Researching ${movie.query || 'the film'} — ${m}`; },
    });
    let added = 0;
    for (let i = 0; i < scenes.length; i++) {
      if (project?.id !== ticket) return; // navigated away — don't pollute another project
      if (!canAddSlide(slides)) break;
      els.status.textContent = `Grabbing frame ${i + 1}/${scenes.length}…`;
      const bitmap = await grabAt(scenes[i].timecode);
      slides = addSlide(slides, {
        id: String(nextId++), bitmap, blob: null,
        caption: scenes[i].caption, timecode: scenes[i].timecode, grabHint: scenes[i].grab || '', fontScale: 1,
      });
      added++;
    }
    // Cap off with the branded outro (logo + follow CTA). Never fatal.
    if (project?.id !== ticket) return;
    let outroAdded = false;
    if (added > 0 && canAddSlide(slides)) {
      try {
        slides = addSlide(slides, await makeOutroSlide());
        outroAdded = true;
      } catch (e) { console.error('[tik] outro slide failed:', e); }
    }
    render();
    markDirty();
    if (added === 0) {
      els.status.textContent = `Slide cap reached (${MAX_SLIDES}) — nothing added.`;
    } else {
      const trivia = added - 1; // first added slide is the title slide
      els.status.textContent = `Added a title slide + ${trivia} AI scene${trivia === 1 ? '' : 's'}${outroAdded ? ' + outro' : ''} — verify the trivia, tweak captions & frames, then post.`;
    }
  } catch (err) {
    console.error('[tik] autopilot failed:', err);
    els.status.textContent = err.message;
  } finally {
    setAiBusy(false);
  }
});

// ---- Add one more AI scene (with context so it doesn't repeat) ----
els.addScene.addEventListener('click', async () => {
  if (!videoReady) { els.status.textContent = 'Load a video first.'; return; }
  if (!canAddSlide(slides)) { els.status.textContent = `Max ${MAX_SLIDES} slides.`; return; }
  if (aiBusy) return;
  setAiBusy(true);
  const ticket = project?.id; // bail if the user opens another project mid-job
  try {
    els.status.textContent = 'Finding another scene…';
    const [scene] = await fetchScenes({
      title: movie.title, year: movie.year, durationSeconds: els.video.duration,
      count: 1, exclude: slides.map((s) => s.caption),
      onProgress: (m) => { els.status.textContent = `Finding another scene — ${m}`; },
    });
    if (project?.id !== ticket) return;
    const bitmap = await grabAt(scene.timecode);
    if (project?.id !== ticket) return;
    slides = addSlide(slides, {
      id: String(nextId++), bitmap, blob: null,
      caption: scene.caption, timecode: scene.timecode, grabHint: scene.grab || '', fontScale: 1,
    });
    render();
    markDirty();
    els.status.textContent = 'Added a new AI scene — tweak it or add more.';
  } catch (err) {
    console.error('[tik] add scene failed:', err);
    els.status.textContent = err.message;
  } finally {
    setAiBusy(false);
    render(); // restores the Add-scene disabled state for the current cap
  }
});

// ================= Remembering Some Guys =================
function pickedRoles() {
  return (project?.roles || []).filter((r) => r.picked);
}

els.findRoles.addEventListener('click', async () => {
  if (!project || aiBusy) return;
  const actor = els.actorInput.value.trim();
  if (!actor) { els.status.textContent = 'Enter an actor name first.'; return; }
  setAiBusy(true);
  try {
    project.actor = actor;
    if (!project.name) { project.name = actor; els.projectName.value = actor; }
    syncPostDefaults();
    markDirty(); // persist the actor/draft even if the lookup fails
    const ticket = project.id; // bail if the user opens another project mid-job
    els.status.textContent = `Remembering ${actor}…`;
    const roles = await fetchRoles({
      actor, count: 20,
      onProgress: (m) => { els.status.textContent = `Remembering ${actor} — ${m}`; },
    });
    if (project?.id !== ticket) return;
    project.roles = roles.map((r) => ({ ...r, picked: false }));
    renderRolesPicker();
    markDirty();
    els.status.textContent = `Found ${roles.length} roles — pick up to ${MAX_PICK}, then write the slides.`;
  } catch (err) {
    console.error('[tik] find roles failed:', err);
    els.status.textContent = err.message;
  } finally {
    setAiBusy(false);
  }
});

function updatePickedCount() {
  const n = pickedRoles().length;
  els.pickedCount.textContent = `${n} picked`;
  els.writeBlurbs.disabled = aiBusy || n === 0;
  els.writeBlurbsLabel.textContent = n ? `Write the slides for ${n} role${n === 1 ? '' : 's'}` : 'Write the slides';
}

function renderRolesPicker() {
  const roles = project?.roles || [];
  els.rolesBox.classList.toggle('hidden', roles.length === 0);
  els.rolesList.innerHTML = '';
  roles.forEach((r, i) => {
    const row = document.createElement('label');
    row.className = 'flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-neutral-800/60';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!r.picked;
    cb.className = 'mt-1 accent-cyan-400';
    cb.addEventListener('change', () => {
      if (cb.checked && pickedRoles().length >= MAX_PICK) {
        cb.checked = false;
        els.status.textContent = `Max ${MAX_PICK} roles per slideshow — uncheck one first.`;
        return;
      }
      project.roles[i].picked = cb.checked;
      updatePickedCount();
      markDirty();
    });
    const txt = document.createElement('span');
    txt.className = 'min-w-0 flex-1 text-sm leading-snug';
    const yr = r.year ? ` <span class="text-neutral-500">(${r.year})</span>` : '';
    txt.innerHTML = `<b>${escapeHtml(r.movie)}</b>${yr} · ${escapeHtml(r.role)}` +
      (r.hook ? `<br><span class="text-[11px] text-neutral-500">${escapeHtml(r.hook)}</span>` : '');
    row.append(cb, txt);
    els.rolesList.appendChild(row);
  });
  updatePickedCount();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

els.rolesAll.addEventListener('click', () => {
  if (!project?.roles) return;
  let n = pickedRoles().length;
  project.roles.forEach((r) => { if (!r.picked && n < MAX_PICK) { r.picked = true; n++; } });
  renderRolesPicker();
  markDirty();
});
els.rolesNone.addEventListener('click', () => {
  if (!project?.roles) return;
  project.roles.forEach((r) => { r.picked = false; });
  renderRolesPicker();
  markDirty();
});

els.writeBlurbs.addEventListener('click', async () => {
  if (!project || aiBusy) return;
  const picked = pickedRoles();
  if (!picked.length) return;
  if (slides.length && !confirm('Replace the current slides with fresh ones for these picks?')) return;
  setAiBusy(true);
  try {
    const ticket = project.id; // bail if the user opens another project mid-job
    els.status.textContent = `Writing blurbs for ${picked.length} role${picked.length === 1 ? '' : 's'}…`;
    const { intro, blurbs } = await fetchBlurbs({
      actor: project.actor,
      roles: picked.map(({ movie: m, year, role }) => ({ movie: m, year, role })),
      onProgress: (m) => { els.status.textContent = `Writing blurbs — ${m}`; },
    });
    if (project?.id !== ticket) return;

    // Blurbs can come back short (blurbless entries are dropped server-side),
    // which would shift blurbs[i] off picked[i] — match on the movie+role echo
    // first, index second; captionForRole falls back to the picker hook last.
    const keyOf = (m, r) => `${String(m || '').toLowerCase()}::${String(r || '').toLowerCase()}`;
    const byKey = new Map();
    blurbs.forEach((b) => { const k = keyOf(b.movie, b.role); if (!byKey.has(k)) byKey.set(k, b); });
    const blurbFor = (role, i) => (byKey.get(keyOf(role.movie, role.role)) || blurbs[i])?.blurb || '';

    resetEditState(); // the selected slide is about to be replaced wholesale
    pickTargetId = null;
    slides.forEach((s) => s.bitmap?.close?.());
    const next = [];
    // Title slide: the actor's name card; paste a good photo of the guy over it.
    const titleBitmap = await makeCardBitmap({
      heading: project.actor, sub: 'Remembering some guys', hint: 'Paste 2–4 photos for a mosaic', accent: GUYS_ACCENT,
    });
    next.push({
      id: String(nextId++), bitmap: titleBitmap, blob: null,
      caption: `${project.actor}\n${intro || 'Remembering some guys tonight.'}`,
      grabHint: '', fontScale: 1, role: null, kind: 'title',
    });
    // One slide per picked role, blurbs matched by index (fall back to the hook).
    for (let i = 0; i < picked.length && next.length < MAX_SLIDES - 1; i++) {
      const role = picked[i];
      const bitmap = await makeCardBitmap({
        heading: role.movie,
        sub: [role.year, role.role].filter(Boolean).join(' · '),
        accent: GUYS_ACCENT,
      });
      next.push({
        id: String(nextId++), bitmap, blob: null,
        caption: captionForRole(role, blurbFor(role, i)),
        grabHint: '', fontScale: 1,
        role: { movie: role.movie, year: role.year, role: role.role },
      });
    }
    try { next.push(await makeOutroSlide()); }
    catch (e) { console.error('[tik] outro slide failed:', e); }
    slides = next;
    render();
    markDirty();
    els.status.textContent = 'Slides ready — the opener takes 2–4 photos as a mosaic; other slides take one photo of the guy. Click a slide, then paste, drop, or pick. Captions are editable.';
  } catch (err) {
    console.error('[tik] write blurbs failed:', err);
    els.status.textContent = err.message;
  } finally {
    setAiBusy(false);
  }
});

// ================= Year Snapshot =================
// One year, three ranked top-eight lists. Unlike Some Guys there's no picking
// step: the lookup writes every slide, and the user's whole job is dropping the
// right artwork onto each one (every slide carries an image-search link).

// Read the year box, or null when it isn't a plausible film year.
function yearFromInput() {
  const y = Number(els.yearInput.value.trim());
  return Number.isInteger(y) && y >= 1930 && y <= 2035 ? y : null;
}

// What came back, per list — including the lists that came back empty, since
// "no VHS rental chart for that year" is a real answer worth showing.
function renderYearSummary() {
  const snap = project?.snapshot;
  const show = project?.format === 'year' && !!snap;
  els.yearSummary.classList.toggle('hidden', !show);
  els.yearRebuild.disabled = aiBusy || !snap;
  if (!show) return;
  els.yearSummaryYear.textContent = project.year || '';
  els.yearSummaryLists.innerHTML = '';
  for (const list of YEAR_LISTS) {
    const n = (snap[list.key] || []).length;
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 text-sm';
    const label = document.createElement('span');
    label.className = 'flex-1 text-neutral-300';
    label.textContent = list.label;
    const count = document.createElement('span');
    count.className = `text-xs font-semibold tabular-nums ${n ? 'text-violet-300' : 'text-neutral-600'}`;
    count.textContent = n ? `${n} of 8` : 'no data found';
    row.append(label, count);
    els.yearSummaryLists.appendChild(row);
  }
}

// Build the whole slideshow from a snapshot: opener, then a lead-in slide plus
// eight entries per list that came back, then the branded outro. Lists that
// came back empty are skipped entirely, lead-in and all.
async function buildYearSlides(snapshot) {
  const y = project.year;
  const next = [];
  const room = () => next.length < MAX_SLIDES - 1; // always leave the outro a seat

  // Opener: the year as a big card, with the agent's lead-in as the caption.
  // Like the Some Guys opener it takes a 2–4 photo mosaic.
  const openerBitmap = await makeCardBitmap({
    heading: String(y), sub: 'The year in movies', hint: 'Paste 2–4 posters for a mosaic', accent: YEAR_ACCENT,
  });
  next.push({
    id: String(nextId++), bitmap: openerBitmap, blob: null,
    caption: `${y}\n${snapshot.intro || `Let's see how ${y} did. What were you watching?`}`,
    grabHint: '', fontScale: 1, kind: 'title',
  });

  let sections = 0;
  let entries = 0;
  for (const list of YEAR_LISTS) {
    const items = snapshot[list.key] || [];
    if (!items.length || !room()) continue;
    const sectionBitmap = await makeCardBitmap({ heading: list.heading, sub: String(y), accent: YEAR_ACCENT });
    next.push({
      id: String(nextId++), bitmap: sectionBitmap, blob: null,
      caption: sectionCaption(list.key, y),
      grabHint: '', fontScale: 1, kind: 'section', section: list.key,
    });
    sections++;
    for (const item of items) {
      if (!room()) break;
      const bitmap = await makeCardBitmap({
        heading: item.title,
        sub: [`#${item.rank}`, item.value].filter(Boolean).join(' · '),
        accent: YEAR_ACCENT,
      });
      next.push({
        id: String(nextId++), bitmap, blob: null,
        caption: captionForYearEntry(item),
        grabHint: '', fontScale: 1,
        entry: { list: list.key, rank: item.rank, title: item.title, value: item.value, note: item.note },
      });
      entries++;
    }
  }

  try { next.push(await makeOutroSlide()); }
  catch (e) { console.error('[tik] outro slide failed:', e); }

  resetEditState(); // the selected slide is about to be replaced wholesale
  pickTargetId = null;
  slides.forEach((s) => s.bitmap?.close?.());
  slides = next;
  render();
  markDirty();
  return { sections, entries };
}

// Look up a year, then build its slides. Re-running on a project that already
// has slides replaces them (the snapshot is kept either way, so "Rebuild" can
// re-run the slide build without spending another AI call).
els.yearLookup.addEventListener('click', async () => {
  if (!project || aiBusy) return;
  const y = yearFromInput();
  if (!y) { els.status.textContent = 'Enter a four digit year between 1930 and 2035.'; return; }
  if (slides.length && !confirm(`Replace the current slides with a fresh ${y} snapshot?`)) return;
  setAiBusy(true);
  try {
    project.year = y;
    if (!project.name) { project.name = String(y); els.projectName.value = String(y); }
    syncPostDefaults();
    markDirty(); // persist the year/draft even if the lookup fails
    const ticket = project.id; // bail if the user opens another project mid-job
    els.status.textContent = `Looking up ${y}…`;
    const snapshot = await fetchYearSnapshot({
      year: y,
      onProgress: (m) => { els.status.textContent = `Looking up ${y} — ${m}`; },
    });
    if (project?.id !== ticket) return;
    project.snapshot = snapshot;
    renderYearSummary();
    const { sections, entries } = await buildYearSlides(snapshot);
    if (project?.id !== ticket) return;
    const missing = YEAR_LISTS.filter((l) => !(snapshot[l.key] || []).length).map((l) => l.label);
    els.status.textContent = `Built ${sections} list${sections === 1 ? '' : 's'} and ${entries} movie slides for ${y}` +
      (missing.length ? ` (no data for: ${missing.join(', ')}).` : '.') +
      ' Click a slide, hit Find images, then paste the artwork in.';
  } catch (err) {
    console.error('[tik] year lookup failed:', err);
    els.status.textContent = err.message;
  } finally {
    setAiBusy(false);
  }
});

// Enter in the year box runs the lookup (it's a one-field form).
els.yearInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  els.yearLookup.click();
});

// Rebuild from the snapshot already on the project — no AI call, so it's the
// cheap way back after deleting or mangling slides.
els.yearRebuild.addEventListener('click', async () => {
  if (!project?.snapshot || aiBusy) return;
  if (slides.length && !confirm('Rebuild the slides from this snapshot? Your current slides and pasted images are replaced.')) return;
  setAiBusy(true);
  try {
    const { sections, entries } = await buildYearSlides(project.snapshot);
    els.status.textContent = `Rebuilt ${sections} list${sections === 1 ? '' : 's'} and ${entries} movie slides for ${project.year}.`;
  } catch (err) {
    console.error('[tik] year rebuild failed:', err);
    els.status.textContent = err.message;
  } finally {
    setAiBusy(false);
  }
});

// ================= Slide images: edit / paste / drop / pick =================
// ---- Select a slide: in trivia the scrubber jumps there for a re-grab; in
// both formats a selected slide accepts paste / drop / picked images. ----
async function enterEdit(id) {
  const slide = slides.find((s) => s.id === id);
  if (!slide) return;
  editingId = id;
  els.grabIcon.textContent = 'save';
  els.grabLabel.textContent = 'Save frame';
  els.cancelEdit.classList.remove('hidden');
  render(); // apply the highlight
  const isTrivia = project?.format === 'trivia';
  if (isTrivia) {
    els.status.textContent = slide.grabHint
      ? `Editing — GRAB: ${slide.grabHint}  (or paste/drop an image)`
      : 'Editing this slide — scrub to a new frame and Save, or paste/drop an image. Esc cancels.';
    if (videoReady && Number.isFinite(slide.timecode)) await seekAndSettle(els.video, slide.timecode);
  } else if (isMosaicSlide(slide)) {
    els.status.textContent = 'Opener selected — paste, drop, or pick 2–4 images for a mosaic. Esc cancels.';
  } else {
    els.status.textContent = 'Slide selected — paste, drop, or pick an image for it. Esc cancels.';
  }
}

function resetEditState() {
  editingId = null;
  els.grabIcon.textContent = 'photo_camera';
  els.grabLabel.textContent = 'Grab frame';
  els.cancelEdit.classList.add('hidden');
}
function exitEdit() { resetEditState(); render(); }
els.cancelEdit.addEventListener('click', () => { exitEdit(); els.status.textContent = 'Edit cancelled.'; });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && editingId) { exitEdit(); els.status.textContent = 'Edit cancelled.'; }
});

// The bring-your-own-image openers are photo mosaics: the frame is built from
// 1–4 pasted photos instead of a single image (a few faces for Some Guys, a few
// posters for a Year Snapshot). Only that first title slide gets the mosaic
// treatment; every other slide is a plain single photo.
function isMosaicSlide(slide) {
  return (project?.format === 'guys' || project?.format === 'year') && slide?.kind === 'title';
}

// Build the title slide's frame from 1–4 photos. A batch (multi-file paste/drop/
// pick) replaces the set; a single photo appends to it, up to MOSAIC_MAX — and a
// single photo pasted once the mosaic is full starts a fresh mosaic. The source
// photos live on the slide (in memory) so each add can recomposite from scratch.
async function setMosaicPhotos(id, blobs) {
  const slide = slides.find((s) => s.id === id);
  if (!slide || !blobs?.length) return;
  const cur = slide.mosaicPhotos || [];
  let next;
  if (blobs.length > 1) next = blobs.slice(0, MOSAIC_MAX);            // batch: replace
  else if (cur.length >= MOSAIC_MAX) next = blobs.slice(0, 1);        // full: start over
  else next = [...cur, blobs[0]].slice(0, MOSAIC_MAX);               // append one
  const ticket = project?.id;
  try {
    const bitmap = await composeMosaic(next);
    if (project?.id !== ticket) return; // navigated away mid-decode/compose
    const old = slide.bitmap;
    slides = slides.map((s) => (s.id === id
      ? { ...s, bitmap, blob: null, grabHint: '', timecode: undefined, mosaicPhotos: next }
      : s));
    old?.close?.();
    if (id === editingId) exitEdit(); else render();
    markDirty();
    const n = next.length;
    els.status.textContent = n === 1
      ? 'Mosaic: 1 photo. Paste, drop, or pick up to 3 more for a side-by-side or 2×2.'
      : `Mosaic: ${n} photos ${n === 4 ? 'in a 2×2 grid' : 'side by side'}. ` +
        (n < MOSAIC_MAX ? 'Paste another to add one, or a fresh set to restart.'
                        : 'Paste a new photo to start the mosaic over.');
  } catch (err) {
    console.error('[tik] mosaic compose failed:', err);
    els.status.textContent = 'Couldn’t build the photo mosaic.';
  }
}

// Set a custom image (paste/drop/pick) as a slide's frame. Custom images have
// no movie timecode, and any stale GRAB hint is cleared so a later thumb-tap
// doesn't re-seek the video to an unrelated frame.
async function setSlideImage(id, blob) {
  const ticket = project?.id;
  try {
    const bitmap = await createImageBitmap(blob);
    if (project?.id !== ticket) return; // navigated away mid-decode
    slides = updateSlideFrame(slides, id, bitmap, undefined);
    slides = slides.map((s) => (s.id === id ? { ...s, grabHint: '', blob } : s));
    if (id === editingId) exitEdit(); else render();
    markDirty();
    els.status.textContent = 'Image set as this slide’s frame.';
  } catch (err) {
    console.error('[tik] set image failed:', err);
    els.status.textContent = 'Couldn’t read that image.';
  }
}

// While a slide is selected, pasting an image from the clipboard sets its
// frame. Text pastes and pastes with nothing selected fall through untouched
// (so caption/prompt paste keeps working).
document.addEventListener('paste', async (e) => {
  if (!editingId) return;
  const blobs = [...(e.clipboardData?.items || [])]
    .filter((i) => i.type.startsWith('image/'))
    .map((i) => i.getAsFile())
    .filter(Boolean);
  if (!blobs.length) return;
  e.preventDefault();
  const slide = slides.find((s) => s.id === editingId);
  if (slide && isMosaicSlide(slide)) await setMosaicPhotos(editingId, blobs);
  else await setSlideImage(editingId, blobs[0]);
});

// Hidden file input, shared by every slide's "pick image" button.
els.imgFile.addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])].filter((f) => f.type.startsWith('image/'));
  const target = pickTargetId;
  pickTargetId = null;
  els.imgFile.value = ''; // same file can be re-picked later
  if (!files.length || !target) return;
  const slide = slides.find((s) => s.id === target);
  if (slide && isMosaicSlide(slide)) await setMosaicPhotos(target, files);
  else await setSlideImage(target, files[0]);
});

// ================= Slide list =================
function render() {
  if (!project) return;
  els.count.textContent = String(slides.length);
  els.grab.disabled = !editingId && !canAddSlide(slides); // Save stays enabled at the cap
  els.addScene.disabled = aiBusy || !videoReady || !canAddSlide(slides);
  els.download.disabled = slides.length === 0;
  els.list.innerHTML = '';
  slides.forEach((slide, index) => els.list.appendChild(renderSlide(slide, index)));
  updatePostButton();
}

// Redraw the preview thumbnails in place (no full re-render) so editing a caption
// or the title updates the live preview without rebuilding the list / losing focus.
function redrawAllThumbs() {
  slides.forEach((slide) => {
    const thumb = els.list.querySelector(`canvas[data-thumb="${slide.id}"]`);
    if (thumb) composeToCanvas(thumb, slide.bitmap, slide.caption, { titleLine: currentTitleLine(), scale: PREVIEW_SCALE, fontScale: slide.fontScale || 1 });
  });
}

function renderSlide(slide, index) {
  const isTrivia = project?.format === 'trivia';
  const li = document.createElement('li');
  li.className = 'flex flex-col gap-2 rounded-xl border border-neutral-800 bg-neutral-900 p-2';
  if (slide.id === editingId) li.className += ' ring-2 ring-red-500';
  li.draggable = true;
  li.dataset.index = String(index);

  const row = document.createElement('div');
  row.className = 'flex gap-2';

  // Live preview: the FULL composed slide (frame + caption pills), rendered at
  // 1080x1920 by composeToCanvas and shrunk to a thumbnail with CSS.
  const thumb = document.createElement('canvas');
  thumb.dataset.thumb = slide.id;
  thumb.className = 'w-[72px] flex-none cursor-pointer rounded-md bg-black h-auto';
  thumb.title = isTrivia ? 'Click to re-grab or replace this frame' : 'Click to select, then paste/drop/pick an image';
  thumb.addEventListener('click', () => {
    if (slide.id === editingId) { exitEdit(); els.status.textContent = 'Edit cancelled.'; return; }
    enterEdit(slide.id);
  });

  // Text fields inside a draggable <li> lose mouse text-selection to the drag
  // handler — suspend dragging while a field is being used.
  const suspendDragWhileEditing = (field) => {
    field.addEventListener('pointerdown', () => { li.draggable = false; });
    field.addEventListener('blur', () => { li.draggable = true; });
  };

  const mid = document.createElement('div');
  mid.className = 'flex min-w-0 flex-1 flex-col gap-1';

  const ta = document.createElement('textarea');
  ta.className = 'w-full rounded-md border border-neutral-800 bg-neutral-950 p-2 text-sm text-neutral-100';
  ta.rows = 3;
  ta.maxLength = 300; // AI caps at 180; give manual edits headroom but keep slides renderable
  ta.placeholder = isTrivia ? 'Trivia for this frame…'
    : project?.format === 'year' ? 'Caption for this slide…'
      : 'Blurb for this guy…';
  ta.value = slide.caption;
  suspendDragWhileEditing(ta);

  // Redraw this slide's preview from the live caption + its per-slide font scale.
  const redrawThumb = () => composeToCanvas(thumb, slide.bitmap, ta.value, {
    titleLine: currentTitleLine(), scale: PREVIEW_SCALE, fontScale: slide.fontScale || 1,
  });
  redrawThumb();

  ta.addEventListener('input', () => {
    slides = editCaption(slides, slide.id, ta.value);
    redrawThumb();
    markDirty();
  });
  mid.append(ta);

  // Editor-only hint from the AI: what shot to look for when (re)grabbing.
  // Never baked into the slide or sent to TikTok.
  if (slide.grabHint) {
    const hint = document.createElement('p');
    hint.className = 'truncate text-[11px] uppercase tracking-wide text-neutral-500';
    hint.title = slide.grabHint;
    hint.textContent = `GRAB: ${slide.grabHint}`;
    mid.append(hint);
  }

  // Per-slide toolbar: image pick + caption font sizing + AI actions.
  const toolbar = document.createElement('div');
  toolbar.className = 'flex flex-wrap items-center gap-1';
  const tbBtn = (icon, label, tip, extra = '') => {
    const b = document.createElement('button');
    b.className = `flex items-center gap-1 rounded-md bg-neutral-800 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700 disabled:opacity-40 ${extra}`;
    b.title = tip;
    b.append(iconSpan(icon, 'text-[16px]'));
    if (label) b.append(document.createTextNode(label));
    return b;
  };

  // Bring-your-own-image: opens a file picker for this slide.
  const pickBtn = tbBtn('add_photo_alternate', '', 'Use your own image (or paste/drop one while the slide is selected)');
  pickBtn.addEventListener('click', () => {
    pickTargetId = slide.id;
    els.imgFile.click();
  });

  // Font sizing (per slide): scales the caption up/down for the amount of text.
  const fontDown = tbBtn('text_decrease', '', 'Smaller caption');
  const fontUp = tbBtn('text_increase', '', 'Bigger caption');
  const nudgeFont = (delta) => {
    const next = Math.min(Math.max((slide.fontScale || 1) + delta, 0.5), 1.6);
    slide.fontScale = next; // keep the closure current for redraws
    slides = slides.map((s) => (s.id === slide.id ? { ...s, fontScale: next } : s));
    redrawThumb();
    markDirty();
  };
  fontDown.addEventListener('click', () => nudgeFont(-0.1));
  fontUp.addEventListener('click', () => nudgeFont(0.1));

  // Bring-your-own-image formats get a one-tap link to a Google image search for
  // this slide's subject — the actor or "actor + movie" for Some Guys, the film
  // and year for a Year Snapshot entry — so grabbing real artwork and coming
  // right back is a single click. No API: just a preloaded URL.
  let photoSearch = null;
  const photoQuery = photoQueryFor(project, slide);
  if (photoQuery) {
    const isYear = project?.format === 'year';
    photoSearch = document.createElement('a');
    photoSearch.href = 'https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(photoQuery);
    photoSearch.target = '_blank';
    photoSearch.rel = 'noopener noreferrer';
    photoSearch.className = 'flex items-center gap-1 rounded-md bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700 ' +
      (isYear ? 'text-violet-300' : 'text-cyan-300');
    photoSearch.title = `Search Google Images for “${photoQuery}”`;
    photoSearch.append(iconSpan('image_search', 'text-[16px]'), document.createTextNode(isYear ? 'Find images' : 'Find photos'));
  }

  toolbar.append(pickBtn, ...(photoSearch ? [photoSearch] : []), fontDown, fontUp);

  if (isTrivia) {
    // Two AI actions, no prompt: one rewrites this fact, the other creates a
    // new one (new frame). Both run on Opus.
    const rewriteBtn = tbBtn('auto_awesome', 'Rewrite this fact', 'New wording for this same fact, keeps the frame', 'text-fuchsia-300');
    const newFactBtn = tbBtn('refresh', 'Create a new fact', 'A different fact, with a new frame');

    const runAi = async (mode) => {
      if (aiBusy) return;
      if (mode === 'newFact' && !videoReady) { els.status.textContent = 'Load the movie file first — a new fact needs a new frame.'; return; }
      setAiBusy(true);
      const ticket = project?.id; // bail if the user opens another project mid-job
      rewriteBtn.disabled = true; newFactBtn.disabled = true;
      try {
        if (mode === 'rewrite') {
          // A fresh take on THIS fact; the frame stays.
          els.status.textContent = 'Rewriting this fact…';
          const exclude = slides.filter((s) => s.id !== slide.id).map((s) => s.caption);
          const [scene] = await fetchScenes({
            title: movie.title || project.name, year: movie.year,
            durationSeconds: els.video.duration || 7200,
            count: 1, exclude, focusTimecode: slide.timecode, model: 'claude-opus-4-8',
            onProgress: (m) => { els.status.textContent = `Rewriting this fact — ${m}`; },
          });
          if (project?.id !== ticket) return;
          slides = editCaption(slides, slide.id, scene.caption);
          ta.value = scene.caption;
          redrawThumb();
          els.status.textContent = 'Fact rewritten.';
        } else {
          // A different fact entirely, with a new frame at its timecode.
          els.status.textContent = 'Creating a new fact…';
          const exclude = slides.map((s) => s.caption);
          const [scene] = await fetchScenes({
            title: movie.title, year: movie.year, durationSeconds: els.video.duration,
            count: 1, exclude, model: 'claude-opus-4-8',
            onProgress: (m) => { els.status.textContent = `Creating a new fact — ${m}`; },
          });
          if (project?.id !== ticket) return;
          const bitmap = await grabAt(scene.timecode);
          if (project?.id !== ticket) return;
          slides = updateSlideFrame(slides, slide.id, bitmap, scene.timecode);
          slides = editCaption(slides, slide.id, scene.caption);
          slides = slides.map((s) => (s.id === slide.id ? { ...s, grabHint: scene.grab || '', blob: null } : s));
          render();
          els.status.textContent = 'Created a new fact and frame.';
        }
        markDirty();
      } catch (err) {
        console.error('[tik] slide AI action failed:', err);
        els.status.textContent = err.message;
      } finally {
        setAiBusy(false);
        rewriteBtn.disabled = false; newFactBtn.disabled = false;
      }
    };
    rewriteBtn.addEventListener('click', () => runAi('rewrite'));
    newFactBtn.addEventListener('click', () => runAi('newFact'));
    toolbar.append(rewriteBtn, newFactBtn);
  } else if (slide.role) {
    // Some Guys: rewrite this role's blurb (title/outro slides have no role).
    const rewriteBtn = tbBtn('auto_awesome', 'Rewrite blurb', 'A fresh blurb for this role', 'text-cyan-300');
    rewriteBtn.addEventListener('click', async () => {
      if (aiBusy) return;
      setAiBusy(true);
      const ticket = project?.id; // bail if the user opens another project mid-job
      rewriteBtn.disabled = true;
      try {
        els.status.textContent = `Rewriting the ${slide.role.movie} blurb…`;
        const { blurbs } = await fetchBlurbs({
          actor: project.actor, roles: [slide.role], exclude: [ta.value], model: 'claude-opus-4-8',
          onProgress: (m) => { els.status.textContent = `Rewriting the blurb — ${m}`; },
        });
        if (project?.id !== ticket) return;
        const caption = captionForRole(slide.role, blurbs[0]?.blurb || '');
        slides = editCaption(slides, slide.id, caption);
        ta.value = caption;
        redrawThumb();
        markDirty();
        els.status.textContent = 'Blurb rewritten.';
      } catch (err) {
        console.error('[tik] rewrite blurb failed:', err);
        els.status.textContent = err.message;
      } finally {
        setAiBusy(false);
        rewriteBtn.disabled = false;
      }
    });
    toolbar.append(rewriteBtn);
  }
  mid.append(toolbar);

  // Delete (top-right).
  const del = document.createElement('button');
  del.className = 'self-start rounded-md bg-neutral-800 px-2 py-1 text-neutral-400 hover:bg-neutral-700 hover:text-red-400 disabled:opacity-40';
  del.title = 'Delete slide';
  del.append(iconSpan('delete'));
  del.addEventListener('click', () => {
    slides = removeSlide(slides, slide.id);
    if (slide.id === editingId) resetEditState(); // don't leave edit mode dangling
    render();
    markDirty();
  });

  row.append(thumb, mid, del);
  li.append(row);

  // Drag: reorder slides, or drop an image FILE from the desktop onto a slide.
  li.addEventListener('dragstart', () => { dragFrom = index; });
  li.addEventListener('dragover', (e) => e.preventDefault());
  li.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      dragFrom = null;
      if (isMosaicSlide(slide)) await setMosaicPhotos(slide.id, files);
      else await setSlideImage(slide.id, files[0]);
      return;
    }
    const to = Number(li.dataset.index);
    if (dragFrom !== null && dragFrom !== to) {
      slides = reorderSlide(slides, dragFrom, to);
      render();
      markDirty();
    }
    dragFrom = null;
  });

  return li;
}

// ================= Download =================
els.download.addEventListener('click', async () => {
  if (!slides.length) return;
  els.download.disabled = true;
  try {
    const slug = projectDisplayName(project).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'slides';
    const titleLine = currentTitleLine();
    for (let i = 0; i < slides.length; i++) {
      els.status.textContent = `Rendering slide ${i + 1}/${slides.length}…`;
      const blob = await composeSlide(slides[i].bitmap, slides[i].caption, { titleLine, fontScale: slides[i].fontScale || 1 });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${slug}-${String(i + 1).padStart(2, '0')}.jpg`;
      a.click();
      URL.revokeObjectURL(a.href);
      // Small gap so the browser doesn't coalesce/drop rapid downloads.
      await new Promise((r) => setTimeout(r, 250));
    }
    els.status.textContent = `Downloaded ${slides.length} slide${slides.length === 1 ? '' : 's'} — post them from the TikTok app (photo post), in order.`;
  } catch (err) {
    console.error('[tik] download failed:', err);
    els.status.textContent = err.message;
  } finally {
    els.download.disabled = slides.length === 0;
  }
});

// ================= Post details =================
els.postTitleInput.addEventListener('input', () => {
  if (!project) return;
  project.postTitle = els.postTitleInput.value;
  project.postEdited = true;
  markDirty();
});
els.postDescInput.addEventListener('input', () => {
  if (!project) return;
  project.postDesc = els.postDescInput.value;
  project.postEdited = true;
  markDirty();
});
els.postReset.addEventListener('click', () => {
  if (!project) return;
  project.postEdited = false;
  syncPostDefaults();
  markDirty();
});

// ================= Post =================
function updatePostButton() {
  const publicOrigin = isPublicOrigin();
  els.post.disabled = !(project && isSignedIn() && slides.length > 0 && publicOrigin);
  els.post.title = publicOrigin ? '' : 'Posting to TikTok needs the deployed site';
}
els.post.addEventListener('click', async () => {
  els.post.disabled = true;
  const ticket = project?.id; // navigating mid-post must not mark another project posted
  try {
    const titleLine = currentTitleLine();
    const fallback = defaultPostFields(project.format, projectDisplayName(project));
    const result = await publishSlideshow(slides, {
      titleLine,
      title: (project.postTitle || '').trim() || fallback.title,
      description: (project.postDesc || '').trim() || fallback.description,
      onProgress: (m) => { els.status.textContent = m; },
    });
    if (project?.id !== ticket) {
      console.warn('[tik] post finished after navigating away; library status left as draft', { ticket, status: result?.status });
      return;
    }
    if (result.status === 'FAILED') {
      console.error('[tik] TikTok post FAILED', result);
      els.status.textContent = result.failReason
        ? `TikTok rejected the post: ${result.failReason}`
        : 'TikTok reported a failure — check the app.';
    } else {
      // Mark it posted and save immediately, so the library reflects reality.
      project.status = 'posted';
      project.postedAt = Date.now();
      let savedNote = 'Saved to your library as posted.';
      try {
        await saveNow();
      } catch (e) {
        console.error('[tik] post-success save failed:', e);
        savedNote = 'Heads up: saving to your library failed (storage full?) — the post itself went through.';
      }
      els.status.textContent = (result.status === 'SEND_TO_USER_INBOX' || result.status === 'PUBLISH_COMPLETE')
        ? `Draft sent to your TikTok inbox — open the app to publish. ${savedNote}`
        : `Uploaded — still processing. Check your TikTok inbox shortly. ${savedNote}`;
    }
  } catch (err) {
    console.error('[tik] post failed:', err);
    if (err.reauth) { clearLocalToken(); refreshAuthUI(); } // token dead → back to signed-out
    els.status.textContent = err.message;
  } finally {
    updatePostButton();
  }
});

// ================= Boot =================
(async () => {
  let authMsg = '';
  try {
    if (await handleRedirect()) authMsg = 'Signed in to TikTok.';
  } catch (e) { console.error('[tik] sign-in failed:', e); authMsg = e.message; }
  refreshAuthUI();

  // Canvas previews render with the system stack until Inter arrives; upgrade
  // them in place once it has.
  document.fonts?.ready?.then(() => { if (project) redrawAllThumbs(); })
    .catch((e) => console.warn('[tik] fonts.ready failed:', e));

  // Deep link: #p/<id> reopens a saved project (survives reloads).
  const m = location.hash.match(/^#p\/([A-Za-z0-9-]+)$/);
  if (m && storageAvailable()) {
    try {
      await openProject(m[1]);
      if (authMsg) els.status.textContent = authMsg;
      return;
    } catch (e) {
      console.warn('[tik] deep link failed; falling back to home', e);
    }
  }
  history.replaceState({}, '', location.pathname + location.search);
  showScreen('home');
  setSaveState('off');
  refreshStatsCard(); // non-blocking; errors handled inside
  await renderLibrary();
  if (!isPublicOrigin()) {
    console.warn('[tik] local origin: posting to TikTok is disabled here (it can’t fetch images from a local address)');
  }
})();
