// VHS Studio — the /tik app controller. Screens: HOME (new + open) and EDITOR
// (per-format panes over a shared slide list). Projects autosave to IndexedDB
// (store.js) so drafts and posted TikToks survive reloads; the video file
// itself can't persist (browser limitation), but every slide's frame does.
import { loadVideoFile, grabFrame, awaitSeekSettled, seekAndSettle } from './capture.js';
import { initScrubber } from './scrubber.js';
import { addSlide, addSlideBeforeOutro, removeSlide, reorderSlide, editCaption, canAddSlide, MAX_SLIDES, updateSlideFrame } from './slides.js';
// getRefreshToken is no longer needed here: the only fetch in this file that
// used it (the hashtag panel) now goes through reports.js loadPosts().
import { startAuth, handleRedirect, signOut, isSignedIn, clearLocalToken, connectHistory } from './auth.js';
import { publishSlideshow } from './publish.js';
import { fetchScenes, fetchTriviaPost, fetchTitleSlide, fetchRoles, fetchBlurbs, fetchYearSnapshot, fetchQuotesPost, fetchImdbQuotes, fetchSubtitles, fetchFreeform, QUOTES_COUNT } from './autopilot.js';
import { fontScaleForQuote } from './caption.js';
import { parseMovieName } from './filename.js';
import { composeToCanvas, composeSlide, captionFontReady, quoteStampReady, wantsQuoteStamp, clampStampNudge, canNudgeStamp } from './compose.js';
import { clockTimecode } from './timecode.js';
import { PRESETS, applyPreset, autoLevels, describeAdjust, isNeutral, NEUTRAL } from './adjust.js';
import {
  FORMATS, YEAR_LISTS, YEAR_LIST_SIZE, formatOf, makeProject, defaultPostFields, captionForRole,
  sectionCaption, captionForYearEntry, photoQueryFor, renumberYearEntries,
  relativeTime, projectDisplayName, pickOutro, nextOutro, isIntroSlide, isOutroSlide, matchesSearch, captionForFreeform,
  STATUSES, statusOf, statusLabel, statusAfterOutroEdit, toggleReady,
} from './project.js';
import { storageAvailable, putProject, getProject, listProjects, deleteProject } from './store.js';
import { makeCardBitmap } from './placeholder.js';
import { composeMosaic, MOSAIC_MAX } from './mosaic.js';
import { composePair, pairLayoutOf, otherLayout, PAIR_LAYOUT_LABELS } from './pair.js';
import {
  parseImdbList, toRatedEntries, imdbSearchUrl, formatVotes,
  parseGrossList, toGrossEntries, boxOfficeMojoUrl, formatGross,
} from './charts.js';
import { fetchFollowerStats, renderFollowerChart, fmtCount } from './stats.js';
import { forecastHtml } from './forecast.js';
import { modelMapHtml } from './modelmap.js';
import { tagReport, tagReportHtml } from './tagreport.js';
// Batch mode (beta) owns its own screen end to end; this file only shows it.
import { initBatch, refreshBatch } from './batch.js';
// Same deal for the Reports screen. loadPosts is shared with the hashtag panel
// below so a single home render does not page video/list twice.
import { initReports, showReports, loadPosts, resetPostsCache } from './reports.js';
import { cadence, lastPostAt, runway, dayLabel } from './cadence.js';
// Remembered movie-file handles (batch mode's folder grant). Read-only here:
// the editor offers a one-click reload when a reopened project's file is known.
import { fsSupported, resolveMovie, armHandle } from './filestore.js';

const $ = (id) => document.getElementById(id);
const els = {
  // app bar
  authBtn: $('auth-btn'), authStatus: $('auth-status'),
  saveState: $('save-state'), saveDot: $('save-dot'), saveLabel: $('save-label'),
  // screens
  home: $('screen-home'), editor: $('screen-editor'), batch: $('screen-batch'),
  reports: $('screen-reports'),
  // home
  newTrivia: $('new-trivia'), newQuotes: $('new-quotes'), newGuys: $('new-guys'), newYear: $('new-year'),
  newFreeform: $('new-freeform'),
  paneFreeform: $('pane-freeform'), freeformTopic: $('freeform-topic'),
  freeformCount: $('freeform-count'), freeformWrite: $('freeform-write'), freeformWriteLabel: $('freeform-write-label'),
  newBatch: $('new-batch'),
  grid: $('project-grid'), libraryEmpty: $('library-empty'),
  statsCard: $('stats-card'), statsCount: $('stats-count'), statsDelta: $('stats-delta'),
  statsNote: $('stats-note'), statsPlot: $('stats-plot'), statsChart: $('stats-chart'), statsTip: $('stats-tip'),
  // editor bar
  back: $('back-btn'), formatChip: $('format-chip'), projectName: $('project-name'),
  download: $('download-btn'), post: $('post-btn'), status: $('post-status'),
  statusChip: $('status-chip'), toast: $('toast'), toastBody: $('toast-body'),
  adjustBtn: $('adjust-btn'), adjustMenu: $('adjust-menu'), adjustLabel: $('adjust-label'),
  pairArmWrap: $('pair-arm-wrap'), pairArm: $('pair-arm'), pairArmLabel: $('pair-arm-label'),
  subsNote: $('subs-note'), subsNoteText: $('subs-note-text'),
  cadenceCard: $('cadence-card'), cadenceGhost: $('cadence-ghost'), cadenceLive: $('cadence-live'),
  cadenceIcon: $('cadence-icon'), cadenceHeadline: $('cadence-headline'),
  cadenceLabel: $('cadence-label'), cadenceDetail: $('cadence-detail'),
  cadenceReadyPill: $('cadence-ready'), cadenceDraftsPill: $('cadence-drafts'),
  // trivia pane
  paneTrivia: $('pane-trivia'), file: $('file-input'), videoNote: $('video-note'),
  triviaSeed: $('trivia-seed'), triviaSeedShow: $('trivia-seed-show'),
  triviaSeedShowLabel: $('trivia-seed-show-label'),
  slidePreview: $('slide-preview'), slidePreviewCanvas: $('slide-preview-canvas'),
  slidePreviewClose: $('slide-preview-close'), slidePreviewMeta: $('slide-preview-meta'),
  videoReload: $('video-reload'), videoReloadLabel: $('video-reload-label'),
  video: $('video'), range: $('scrub-range'), timecode: $('timecode'), play: $('play-btn'),
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
  minVotes: $('min-votes-input'), imdbSearchLink: $('imdb-search-link'),
  imdbPaste: $('imdb-paste'), imdbPasteNote: $('imdb-paste-note'),
  mojoLink: $('mojo-link'), mojoPaste: $('mojo-paste'), mojoPasteNote: $('mojo-paste-note'),
  // post details
  postTitleInput: $('post-title-input'), postDescInput: $('post-desc-input'), postReset: $('post-reset'),
  postDetails: $('post-details'), postDetailsBadge: $('post-details-badge'),
  songPicks: $('song-picks'), songList: $('song-list'),
  // hashtag performance, under the follower chart
  tagReport: $('tag-report'), tagReportNote: $('tag-report-note'), tagReportBody: $('tag-report-body'),
  openReports: $('open-reports'), connectHistoryBtn: $('connect-history'), reportsHint: $('reports-hint'),
  statsModes: $('stats-modes'), statsStyles: $('stats-styles'), statsForecast: $('stats-forecast'),
  statsLegend: $('stats-legend'),
  libraryFilters: $('library-filters'), libraryViews: $('library-views'),
  librarySearch: $('library-search'),
  homeNav: $('home-nav'), homeLink: $('home-link'), tabPosts: $('tab-posts'), tabStats: $('tab-stats'), tabModels: $('tab-models'),
  // slides pane
  count: $('slide-count'), list: $('slide-list'), addScene: $('add-scene'), slidesHint: $('slides-hint'),
  addManual: $('add-manual'), addManualLabel: $('add-manual-label'),
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
const DEFAULT_MIN_VOTES = 100_000; // IMDb vote floor, mirroring the server default

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
  play: els.play,
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
async function makeOutroSlide() {
  const res = await fetch(OUTRO_LOGO_URL);
  if (!res.ok) throw new Error(`Couldn't load the outro logo (${res.status})`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  return {
    id: String(nextId++), bitmap, blob,
    caption: pickOutro(project?.format),
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
    maxFrameHeightRatio: frameHeightRatio(),
    format: project.format, kind: slide.kind, adjust: slide.adjust, stampNudge: slide.stampNudge || 0,
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
      // Present only when the subtitle matcher placed this line. Its absence is
      // meaningful: the timecode was estimated, and the slide says so.
      cue: s.cue || null,
      // Freeform writes an image-search term per slide; it is the whole point.
      search: s.search || '',
      // The two source frames behind a paired slide, kept so switching layout
      // rebuilds rather than asking for the grabs again.
      pairFrames: s.pairFrames?.length === 2 ? s.pairFrames : null,
      pairLayout: s.pairFrames?.length === 2 ? pairLayoutOf(s.pairLayout) : null,
      // Correction is stored, never baked, so it stays reversible.
      adjust: s.adjust || null,
      // Where the Quote-a-long badge was nudged to on this title card.
      stampNudge: clampStampNudge(s.stampNudge),
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
  els.batch.classList.toggle('hidden', name !== 'batch');
  els.reports.classList.toggle('hidden', name !== 'reports');
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
  els.videoReload.classList.add('hidden');
  els.autopilot.disabled = true;
  els.autopilot.title = 'Load a video first';
  els.range.value = '0';
  els.yearSummary.classList.add('hidden');
  els.list.innerHTML = '';
  els.status.textContent = '';
  setSaveState('off');
}

// Leaving whatever screen you are on for a home tab.
//
// The nav sits in the app bar, so it is on screen from the editor, batch mode
// and reports too — clicking it there used to toggle a hidden panel and appear
// to do nothing, while the editor's #p/<id> stayed in the address bar. Routing
// through goHome() is what makes it navigation: it saves the open project,
// tears it down, and drops the hash.
async function goToHomeTab(tab) {
  const inEditor = !els.editor.classList.contains('hidden');
  if (inEditor && aiBusy && !confirm('An AI job is still running — leave this project anyway?')) return;
  // Remember the choice first, so goHome() restores the tab that was asked for
  // rather than the one from last session.
  homeTab = HOME_TABS.includes(tab) ? tab : 'posts';
  localStorage.setItem(LS_HOME_TAB, homeTab);
  if (!els.home.classList.contains('hidden')) {
    showHomeTab(homeTab); // already home: just switch panels
    return;
  }
  await goHome();
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
  showHomeTab(homeTab);
  refreshStatsCard(); // non-blocking; errors handled inside
  await renderLibrary();
}

// Previews drawn before Inter arrived wrap at the fallback font's widths,
// which is not where the uploaded slide will break. Redraw them once the real
// font is in. Cheap and idempotent: after the font has loaded this resolves
// immediately and the redraw is a no-op visually.
function syncThumbsToCaptionFont() {
  captionFontReady().then((ok) => {
    if (!ok) return;
    if (project) redrawAllThumbs();
  }).catch((e) => console.warn('[tik] caption font sync failed:', e));
  // The stamp arrives on its own schedule too, and a title slide drawn before
  // it decodes is missing its badge until something else forces a redraw.
  if (project?.format === 'quotes') {
    quoteStampReady().then((ok) => {
      if (ok && project?.format === 'quotes') redrawAllThumbs();
    }).catch((e) => console.warn('[tik] quote stamp sync failed:', e));
  }
}

function enterEditor() {
  showScreen('editor');
  history.replaceState({}, '', `${location.pathname}${location.search}#p/${project.id}`);
  applyFormatUI();
  renderStatusChip();
  renderSubsNote();
  syncAdjustButton();
  els.projectName.value = project.name || '';
  els.postTitleInput.value = project.postTitle || '';
  els.postDescInput.value = project.postDesc || '';
  renderSongPicks();
  els.titleToggle.checked = !!project.titleOn;
  els.movieTitle.value = project.titleLine || '';
  els.movieTitle.disabled = !project.titleOn;
  els.actorInput.value = project.actor || '';
  els.freeformTopic.value = project.topic || '';
  syncFreeformCount();
  els.yearInput.value = project.year || '';
  els.minVotes.value = project.minVotes ?? DEFAULT_MIN_VOTES;
  els.imdbPaste.value = project.imdbPaste || '';
  els.mojoPaste.value = project.mojoPaste || '';
  els.autopilotPrompt.value = '';
  renderRolesPicker();
  renderYearSummary();
  refreshSourceLinks();
  refreshImdbPasteNote();
  refreshMojoPasteNote();
  seedForced = false;
  setSaveState(storageAvailable() ? (dirty ? 'saving' : 'saved') : 'off');
  render();
  syncSeedControls();
  syncThumbsToCaptionFont();
}

// Appends a persistent warning when local saving can't work in this browser.
function withStorageWarning(msg) {
  return storageAvailable() ? msg : `${msg} (Local saving is unavailable in this browser — work here won’t persist.)`;
}

// Trivia and Quote-a-long both drive a local movie file (seek, grab, reload).
// Keep rewrite / Add-scene on trivia only — those still call fetchScenes.
function isMovieFileFormat(format = project?.format) {
  return format === 'trivia' || format === 'quotes';
}

async function newProject(format) {
  openSeq++; // abort any in-flight openProject load
  await teardownProject();
  project = makeProject({ id: uuid(), format, now: Date.now() });
  const d = defaultPostFields(format, '', { projectId: project.id });
  project.postTitle = d.title;
  project.postDesc = d.description;
  project.hashtagSet = d.hashtagSet || null;
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
        entry: s.entry || null, section: s.section || null, cue: s.cue || null,
        search: s.search || '', adjust: s.adjust || null,
        stampNudge: clampStampNudge(s.stampNudge),
        pairFrames: s.pairFrames?.length === 2 ? s.pairFrames : null,
        pairLayout: s.pairFrames?.length === 2 ? pairLayoutOf(s.pairLayout) : null,
      });
    } catch (e) {
      console.error('[tik] could not decode a saved frame; slide dropped', e);
    }
  }
  if (seq !== openSeq) { loaded.forEach((l) => l.bitmap?.close?.()); return; }
  slides = loaded;
  dirty = false;
  enterEditor();
  if (isMovieFileFormat()) {
    els.videoNote.classList.toggle('hidden', slides.length === 0);
    els.status.textContent = withStorageWarning(slides.length
      ? 'Reopened from your library — captions, fonts, and posting all work; re-pick the movie file to grab new frames.'
      : 'Reopened — pick the movie file to start.');
    offerRememberedReload(); // batch mode may know where this movie's file lives
  } else {
    els.status.textContent = withStorageWarning('Reopened from your library.');
  }
}

// ---- Format-specific UI wiring ----
// One source pane per format; only the active one is shown (panes are flex
// columns, so "hidden" has to be swapped for "flex", not just removed).
const PANES = { trivia: els.paneTrivia, quotes: els.paneTrivia, freeform: els.paneFreeform, guys: els.paneGuys, year: els.paneYear };
const TRIVIA_PASTE_PLACEHOLDER = 'Optional starter prompt — paste trivia you found (IMDb, Reddit, anywhere) or give a direction; autopilot verifies and riffs on it';
const QUOTES_PASTE_PLACEHOLDER = 'Optional — paste quotes you want, or a direction';
function applyFormatUI() {
  const f = formatOf(project);
  // quotes reuses the trivia movie-file pane. Unique the values so iterating
  // both keys can't hide Tape Trivia when the quotes entry runs second.
  const activePane = PANES[f.key];
  for (const pane of new Set(Object.values(PANES))) {
    const on = pane === activePane;
    pane.classList.toggle('hidden', !on);
    pane.classList.toggle('flex', on);
  }
  els.addScene.classList.toggle('hidden', f.key !== 'trivia');
  // Hand-written slide: for a quote you already know, or a fact the agent
  // missed. Both movie-file formats get it — the frame comes from the playhead,
  // which only those two have.
  const manual = isMovieFileFormat(f.key);
  els.addManual.classList.toggle('hidden', !manual);
  els.addManual.classList.toggle('flex', manual);
  els.addManualLabel.textContent = f.key === 'quotes' ? 'Add quote' : 'Add slide';
  els.addManual.title = f.key === 'quotes'
    ? 'Add a slide at this frame and type the quote yourself'
    : 'Add a slide at this frame and write it yourself';
  els.formatChip.textContent = f.label;
  els.formatChip.className = `rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${f.chip}`;
  els.slidesHint.textContent = f.editorHint;
  const quotes = f.key === 'quotes';
  if (els.autopilot?.lastChild) {
    els.autopilot.lastChild.textContent = quotes
      ? 'Autopilot — title slide + quotes'
      : 'Autopilot — title slide + trivia scenes';
  }
  if (els.autopilotPrompt) {
    els.autopilotPrompt.placeholder = quotes ? QUOTES_PASTE_PLACEHOLDER : TRIVIA_PASTE_PLACEHOLDER;
  }
}

// Once a set is written, the starter prompt / bookmarklet help / Autopilot
// button are setup instructions for work already done, and they push the frame
// picker below the fold. Collapse them behind a one-line toggle instead.
let seedForced = false;
function syncSeedControls() {
  if (!els.triviaSeed) return;
  const trivia = isMovieFileFormat();
  const written = slides.length > 0;
  const show = trivia && (!written || seedForced);
  els.triviaSeed.classList.toggle('hidden', !show);
  els.triviaSeed.classList.toggle('flex', show);
  const offerToggle = trivia && written;
  els.triviaSeedShow.classList.toggle('hidden', !offerToggle);
  els.triviaSeedShow.classList.toggle('flex', offerToggle);
  els.triviaSeedShowLabel.textContent = seedForced
    ? 'Hide autopilot & paste box'
    : 'Show autopilot & paste box';
  // The amber note only repeats what the reload button already says, and that
  // button names the actual file. Two warnings for one fact is one too many.
  const reloadVisible = !els.videoReload.classList.contains('hidden');
  if (reloadVisible) els.videoNote.classList.add('hidden');
}

// Keep the suggested post title/description fresh until the user edits them.
function syncPostDefaults() {
  if (!project || project.postEdited) return;
  const name = project.format === 'guys'
    ? (project.actor || project.name)
    : project.format === 'year'
      ? (project.year ? String(project.year) : project.name)
      : (movie.query || project.name);
  const d = defaultPostFields(project.format, name, { meta: project.postMeta, projectId: project.id });
  project.postTitle = d.title;
  project.postDesc = d.description;
  if (d.hashtagSet) project.hashtagSet = d.hashtagSet;
  els.postTitleInput.value = d.title;
  els.postDescInput.value = d.description;
}

// ================= Library =================
// ---- status: draft → ready → posted ----
//
// One place decides what each state looks like, because the same three colors
// appear on the editor chip, the grid card and the list row. Ready is violet
// (the app's accent) so a queue of finished sets reads at a glance against the
// amber drafts and green posted.
const STATUS_STYLE = {
  draft: { chip: 'bg-neutral-800 text-amber-300', onImage: 'bg-neutral-950/80 text-amber-300' },
  ready: { chip: 'bg-violet-500 text-neutral-950', onImage: 'bg-violet-500/90 text-neutral-950' },
  posted: { chip: 'bg-green-500 text-neutral-950', onImage: 'bg-green-500/90 text-neutral-950' },
};

let toastTimer = null;
// A short confirmation for something that happened without the user clicking
// the thing it happened to — auto-promotion to Ready being the case that
// prompted it. A silent status change is indistinguishable from a bug.
function toast(message, tone = 'ready') {
  const style = STATUS_STYLE[tone] || STATUS_STYLE.ready;
  els.toastBody.textContent = message;
  els.toastBody.className = `flex items-center gap-2 rounded-full border border-neutral-950/20 px-4 py-2 text-sm font-bold shadow-lg ${style.chip}`;
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 2600);
}

// Why every timecode on this set is a guess.
//
// Without subtitles the matcher has nothing to match against, so every slide
// falls back to the model's estimate. That is a legitimate outcome, but it is
// also what a broken install looks like, and the two are indistinguishable
// unless the reason is written down where it survives a reload.
function renderSubsNote() {
  const show = project?.format === 'quotes' && !!project?.subsError;
  els.subsNote.classList.toggle('hidden', !show);
  els.subsNote.classList.toggle('flex', show);
  if (show) {
    els.subsNoteText.textContent =
      `No subtitles for this film, so every timecode below is the model's estimate rather than a subtitle match. Reason: ${project.subsError}`;
  }
}

function renderStatusChip() {
  if (!project) return;
  const key = statusOf(project);
  els.statusChip.textContent = statusLabel(project);
  els.statusChip.className = `rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide transition ${STATUS_STYLE[key].chip} ${
    key === 'posted' ? 'cursor-default' : 'hover:opacity-80'}`;
  els.statusChip.title = key === 'posted'
    ? 'Posted to TikTok'
    : key === 'ready'
      ? 'Reviewed and queued — click to send it back to drafts'
      : 'Still a draft — editing the sign-off marks it Ready, or click to mark it now';
  els.statusChip.disabled = key === 'posted';
}

// Editing the sign-off means the review reached the bottom of the set, so the
// set is done. Fires from every path that can change that slide (typing, the
// font nudges, swapping the line), and is a no-op once the set has left draft.
function noteOutroReviewed(slide) {
  if (!project || !isOutroSlide(slide)) return;
  const next = statusAfterOutroEdit(project.status);
  if (next === statusOf(project)) return;
  project.status = next;
  renderStatusChip();
  toast('Marked as READY');
}

els.statusChip.addEventListener('click', () => {
  if (!project) return;
  const next = toggleReady(project.status);
  if (next === statusOf(project)) return;
  project.status = next;
  renderStatusChip();
  markDirty();
  toast(next === 'ready' ? 'Marked as READY' : 'Back to draft', next);
});

function formatBadge(rec) {
  const f = FORMATS[rec.format] || FORMATS.trivia;
  return `<span class="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${f.chip}">${f.label}</span>`;
}

// ---- home tabs ----
//
// Posts, Stats and Models are three views of the same screen rather than three
// screens, so the editor's back button still has one place to return to.
const LS_HOME_TAB = 'tik_home_tab';
const HOME_TABS = ['posts', 'stats', 'models'];
let homeTab = HOME_TABS.includes(localStorage.getItem(LS_HOME_TAB))
  ? localStorage.getItem(LS_HOME_TAB) : 'posts';
let modelsRendered = false;

function showHomeTab(tab) {
  homeTab = HOME_TABS.includes(tab) ? tab : 'posts';
  localStorage.setItem(LS_HOME_TAB, homeTab);
  els.tabPosts.classList.toggle('hidden', homeTab !== 'posts');
  els.tabStats.classList.toggle('hidden', homeTab !== 'stats');
  els.tabModels.classList.toggle('hidden', homeTab !== 'models');
  for (const btn of els.homeNav.querySelectorAll('button')) {
    const on = btn.dataset.tab === homeTab;
    btn.classList.toggle('bg-neutral-800', on);
    btn.classList.toggle('text-neutral-100', on);
    btn.classList.toggle('text-neutral-500', !on);
  }
  // The chart measures 0 wide while its panel is hidden, so it can only be
  // drawn once Stats is actually on screen.
  if (homeTab === 'stats' && lastStatsSeries) drawStats(lastStatsSeries, { animate: true });
  if (homeTab === 'models' && !modelsRendered) {
    els.tabModels.innerHTML = modelMapHtml();
    modelsRendered = true;
  }
}
els.homeNav.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) goToHomeTab(btn.dataset.tab).catch((err) => console.error('[tik] nav failed:', err));
});
// The wordmark is the other way home, the way every site's logo is.
els.homeLink.addEventListener('click', () => {
  goToHomeTab('posts').catch((err) => console.error('[tik] nav failed:', err));
});

// Library view state. Persisted because a view preference you have to re-pick
// every visit is not a preference.
const LS_LIB_VIEW = 'tik_library_view';
const LS_LIB_FILTER = 'tik_library_filter';
const LIB_VIEWS = ['large', 'grid', 'list'];
let libView = LIB_VIEWS.includes(localStorage.getItem(LS_LIB_VIEW)) ? localStorage.getItem(LS_LIB_VIEW) : 'grid';
let libFilter = ['all', 'draft', 'posted'].includes(localStorage.getItem(LS_LIB_FILTER))
  ? localStorage.getItem(LS_LIB_FILTER) : 'all';

// Live search over the library. Deliberately not persisted: a filter that
// survives a reload leaves you staring at three of your forty drafts with no
// memory of why.
let librarySearch = '';
els.librarySearch.addEventListener('input', () => {
  librarySearch = els.librarySearch.value;
  renderLibrary();
});

const GRID_CLASS = {
  large: 'mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3',
  grid: 'mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4',
  list: 'mt-3 flex flex-col gap-1.5',
};

function renderLibraryChrome(counts) {
  els.libraryFilters.innerHTML = '';
  const pills = [['all', 'All'], ...STATUSES.map((st) => [st.key, st.plural])];
  for (const [key, label] of pills) {
    const n = counts[key] || 0;
    const on = libFilter === key;
    const pill = document.createElement('button');
    pill.className = `flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${
      on ? 'border-neutral-600 bg-neutral-800 text-neutral-100' : 'border-neutral-800 text-neutral-500 hover:text-neutral-300'}`;
    // Ready is the count that matters day to day — it is the size of the
    // queue — so it keeps its accent even when the pill is not selected.
    const tint = key === 'ready' && n ? 'text-violet-300' : on ? 'text-neutral-400' : 'text-neutral-600';
    pill.innerHTML = `${label}<span class="tabular-nums ${tint}">${n}</span>`;
    // A filter that empties the screen is a dead end, so an empty bucket is
    // shown with its zero but cannot be selected.
    pill.disabled = n === 0 && key !== 'all';
    if (pill.disabled) pill.classList.add('opacity-40');
    else pill.addEventListener('click', () => {
      libFilter = key;
      localStorage.setItem(LS_LIB_FILTER, key);
      renderLibrary();
    });
    els.libraryFilters.appendChild(pill);
  }
  for (const btn of els.libraryViews.querySelectorAll('button')) {
    const on = btn.dataset.view === libView;
    btn.classList.toggle('bg-neutral-800', on);
    btn.classList.toggle('text-neutral-100', on);
    btn.classList.toggle('text-neutral-500', !on);
  }
}

els.libraryViews.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn || btn.dataset.view === libView) return;
  libView = btn.dataset.view;
  localStorage.setItem(LS_LIB_VIEW, libView);
  renderLibrary();
});

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
  // Search first, so the pills count what you can actually see. A search that
  // says "12 drafts" while showing two is worse than no counts at all.
  // Before the search box narrows anything: the cadence row reports on the
  // whole library, since a search for "jaws" does not change when you last
  // posted or how many sets are queued.
  refreshCadence(list).catch((e) => console.error('[tik] cadence render failed:', e));

  const q = librarySearch.trim().toLowerCase();
  if (q) list = list.filter((r) => matchesSearch(r, q));

  const counts = { all: list.length };
  for (const st of STATUSES) counts[st.key] = list.filter((r) => statusOf(r) === st.key).length;
  // A filter whose bucket emptied (last draft posted) would otherwise strand
  // the screen on an empty list with no obvious way back.
  if (libFilter !== 'all' && !counts[libFilter]) libFilter = 'all';
  renderLibraryChrome(counts);

  const shown = libFilter === 'all' ? list : list.filter((r) => statusOf(r) === libFilter);
  els.grid.className = GRID_CLASS[libView] || GRID_CLASS.grid;
  els.libraryEmpty.classList.toggle('hidden', shown.length > 0);
  if (!shown.length) {
    els.libraryEmpty.textContent = q
      ? `Nothing matches “${librarySearch.trim()}”.`
      : 'Nothing saved yet — drafts, ready-to-post sets and posted TikToks land here automatically as you work.';
  }

  const listView = libView === 'list';
  for (const rec of shown) {
    const card = document.createElement('button');
    card.className = listView
      ? 'group relative flex w-full items-center gap-3 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 p-2 text-left transition hover:border-neutral-600'
      : 'group relative overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 text-left transition hover:border-neutral-600';
    card.title = `Open ${projectDisplayName(rec)}`;

    const frame = document.createElement('div');
    frame.className = listView
      ? 'relative h-12 w-9 flex-none overflow-hidden rounded bg-neutral-950'
      : 'relative aspect-[9/14] w-full overflow-hidden bg-neutral-950';
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
    const key = statusOf(rec);
    const badge = document.createElement('span');
    const badgeSkin = listView ? STATUS_STYLE[key].chip : STATUS_STYLE[key].onImage;
    badge.className = listView
      ? `flex-none rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${badgeSkin}`
      : `absolute left-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${badgeSkin}`;
    badge.textContent = statusLabel(rec);
    // Flipping a set in or out of the queue without opening it: the whole point
    // of Ready is bulk, and bulk means doing it from the grid.
    if (key !== 'posted') {
      badge.classList.add('cursor-pointer', 'hover:opacity-80');
      badge.setAttribute('role', 'button');
      badge.title = key === 'ready' ? 'Send back to drafts' : 'Mark Ready to post';
      badge.addEventListener('click', async (e) => {
        e.stopPropagation();
        const next = toggleReady(rec.status);
        try {
          await putProject({ ...rec, status: next, updatedAt: Date.now() });
          toast(next === 'ready' ? 'Marked as READY' : 'Back to draft', next);
          await renderLibrary();
        } catch (err) {
          console.error('[tik] status change failed:', err);
          alert('Couldn’t change that status — check the console.');
        }
      });
    }
    if (!listView) frame.appendChild(badge);

    const del = document.createElement('span');
    del.className = listView
      ? 'ml-auto flex-none rounded-md p-1 text-neutral-600 hover:text-red-400'
      : 'absolute right-2 top-2 hidden rounded-md bg-neutral-950/80 p-1 text-neutral-400 hover:text-red-400 group-hover:block';
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
    if (!listView) frame.appendChild(del);

    const meta = document.createElement('div');
    meta.className = listView ? 'flex min-w-0 flex-1 flex-col gap-0.5' : 'flex flex-col gap-1 p-2.5';
    const name = document.createElement('span');
    name.className = 'truncate text-sm font-bold tracking-tight';
    name.textContent = projectDisplayName(rec);
    const sub = document.createElement('span');
    sub.className = 'flex items-center gap-1.5 text-[11px] text-neutral-500';
    sub.innerHTML = `${formatBadge(rec)} <span>${(rec.slides || []).length} slides · ${relativeTime(rec.updatedAt || 0, Date.now())}</span>`;
    meta.append(name, sub);

    card.append(frame, meta);
    if (listView) card.append(badge, del);
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
els.newQuotes.addEventListener('click', () => { newProject('quotes').catch((e) => console.error('[tik] new project failed:', e)); });
els.newGuys.addEventListener('click', () => { newProject('guys').catch((e) => console.error('[tik] new project failed:', e)); });
els.newFreeform.addEventListener('click', () => { newProject('freeform').catch((e) => console.error('[tik] new project failed:', e)); });
els.newYear.addEventListener('click', () => { newProject('year').catch((e) => console.error('[tik] new project failed:', e)); });

// ---- Batch mode (beta) ----
// Its own screen, wired once. Leaving it returns to home the same way the
// editor does, so the library picks up whatever drafts it wrote.
initBatch({ onExit: () => { goHome().catch((e) => console.error('[tik] leaving batch failed:', e)); } });
els.newBatch.addEventListener('click', () => { showScreen('batch'); refreshBatch(); });

// ---- Reports ----
initReports({
  onExit: () => { goHome().catch((e) => console.error('[tik] leaving reports failed:', e)); },
  // The Reports screen learns the scope state from its own fetch; the home
  // screen's Connect button follows it rather than guessing separately.
  onScope: (scope) => setHistoryPrompt(scope),
});
els.openReports.addEventListener('click', () => {
  showScreen('reports');
  showReports().catch((e) => console.error('[tik] reports failed to open:', e));
});
els.connectHistoryBtn.addEventListener('click', async () => {
  try {
    // Navigates away to TikTok and comes back through handleRedirect().
    await connectHistory();
  } catch (e) {
    console.error('[tik] connecting post history failed:', e);
    alert(e.message);
  }
});

// ---- Remembered movie file (batch mode's folder grant) ----
// When a reopened trivia project's file is remembered (the movies folder, or a
// past pick in batch mode), offer a one-click reload. The File is injected
// into the normal file input via DataTransfer so the EXISTING change handler
// does all the work — no second load path to keep in sync.
async function offerRememberedReload() {
  els.videoReload.classList.add('hidden');
  try {
    if (!fsSupported() || !project || !isMovieFileFormat() || videoReady) return;
    const title = project.movie?.title;
    if (!title) return;
    const openedFor = project.id;
    const res = await resolveMovie(title, project.movie?.year);
    if (!res || project?.id !== openedFor) return;
    els.videoReloadLabel.textContent = res.state === 'granted'
      ? `Load ${res.label} again`
      : `Unlock and load ${res.label}`;
    els.videoReload.classList.remove('hidden');
    els.videoReload.classList.add('flex');
    els.videoReload.onclick = async () => {
      try {
        if (res.state !== 'granted' && !(await armHandle(res.armTarget))) return;
        // Re-resolve after arming: a locked folder can only be searched now.
        const armed = res.state === 'granted' ? res : await resolveMovie(title, project.movie?.year);
        if (!armed || armed.state !== 'granted' || project?.id !== openedFor) return;
        const file = await armed.load();
        const dt = new DataTransfer();
        dt.items.add(file);
        els.file.files = dt.files;
        els.file.dispatchEvent(new Event('change', { bubbles: true }));
        els.videoReload.classList.add('hidden');
      } catch (e) {
        console.error('[tik] remembered reload failed:', e);
        els.status.textContent = 'Could not reload the remembered file — pick it by hand.';
      }
    };
  } catch (e) {
    // The offer is a convenience; a failure must never break reopening.
    console.warn('[tik] remembered-file check failed:', e);
  }
}
// A manual pick supersedes the offer.
els.file.addEventListener('change', () => els.videoReload.classList.add('hidden'));
els.triviaSeedShow.addEventListener('click', () => { seedForced = !seedForced; syncSeedControls(); });

// ================= Two frames on one slide =================
//
// A Quote-a-long middle slide can hold two grabs, for the setup and the payoff
// of an exchange. Only the middle ones: the opener is a title card and the
// sign-off is house art, and neither has a second half.
//
// The two source frames live on the slide and the composite is rebuilt from
// them, so switching layout is not a re-grab. Same shape as the Some Guys
// mosaic, and for the same reason.
function canPairSlide(slide) {
  return project?.format === 'quotes' && slide && slide.kind !== 'title' && !isOutroSlide(slide);
}

// The grab button REPLACES by default and always has; that is the muscle
// memory. Adding is opt-in per grab, and disarms itself the moment it fires so
// the next grab behaves the way every other grab in the app does.
let pairArmed = false;

function syncPairArm() {
  const slide = adjustTarget();
  const usable = !!(project?.format === 'quotes' && slide && canPairSlide(slide) && slide.bitmap);
  els.pairArmWrap.classList.toggle('hidden', !usable);
  els.pairArmWrap.classList.toggle('flex', usable);
  if (!usable && pairArmed) { pairArmed = false; els.pairArm.checked = false; }
  const paired = !!slide?.pairFrames?.length;
  els.pairArmLabel.textContent = paired ? 'Replace 2nd frame' : 'Add 2nd frame';
  els.pairArmWrap.title = paired
    ? 'The next grab replaces the second frame instead of the whole slide'
    : 'Keep this slide’s current frame and add the next grab beside it';
}

els.pairArm.addEventListener('change', () => {
  pairArmed = els.pairArm.checked;
  const slide = adjustTarget();
  if (pairArmed) {
    els.status.textContent = slide?.pairFrames?.length
      ? 'Next grab replaces the second frame.'
      : 'Next grab lands beside this slide’s frame. Grab as normal.';
  }
});

// Build (or rebuild) a slide's composite from its two source frames.
async function applyPair(id, frames, layout) {
  const slide = slides.find((s) => s.id === id);
  if (!slide || frames.length < 2) return false;
  const ticket = project?.id;
  try {
    const bitmap = await composePair(frames, layout);
    if (project?.id !== ticket) return false;
    const old = slide.bitmap;
    slides = slides.map((sl) => (sl.id === id
      ? { ...sl, bitmap, blob: null, pairFrames: frames, pairLayout: pairLayoutOf(layout) }
      : sl));
    old?.close?.();
    return true;
  } catch (e) {
    console.error('[tik] pairing the frames failed:', e);
    els.status.textContent = 'Couldn’t put the two frames together.';
    return false;
  }
}

async function togglePairLayout(id) {
  const slide = slides.find((s) => s.id === id);
  if (!slide?.pairFrames?.length) return;
  const next = otherLayout(slide.pairLayout);
  if (await applyPair(id, slide.pairFrames, next)) {
    render();
    markDirty();
    els.status.textContent = `${PAIR_LAYOUT_LABELS[next]}.`;
  }
}

// ================= Frame correction =================
//
// Films are dark. A grabbed still often needs a lift before a caption sits on
// it legibly, and doing that here beats re-grabbing and hoping.
//
// The target is whichever slide the editor is pointed at: the one being
// re-framed if you clicked its preview, otherwise the one Grab frame just
// appended. Correction is stored on the slide as multipliers rather than baked
// into the pixels, so every step is reversible and repeatable.
function adjustTarget() {
  if (editingId) return slides.find((s) => s.id === editingId) || null;
  return slides.length ? slides[slides.length - 1] : null;
}

// Measure the frame so Auto has something to stretch against.
//
// Sampled small and on a stride: a full 1080p read is two million pixels for a
// number that only needs to be roughly right, and this runs on a click.
function measureLevels(bitmap) {
  const W = 160;
  const H = Math.max(1, Math.round((bitmap.height / bitmap.width) * W));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const hist = new Array(256).fill(0);
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    // Rec. 601 luma is close enough for deciding how dark a frame is.
    hist[(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0]++;
    n++;
  }
  // Percentiles, not min and max: one specular highlight or one crushed pixel
  // would otherwise decide the stretch for the whole frame.
  const at = (p) => {
    let seen = 0;
    const want = n * p;
    for (let v = 0; v < 256; v++) { seen += hist[v]; if (seen >= want) return v / 255; }
    return 1;
  };
  return { black: at(0.01), white: at(0.99) };
}

function syncAdjustButton() {
  syncPairArm();
  const target = adjustTarget();
  const movieFormat = isMovieFileFormat();
  els.adjustBtn.disabled = !movieFormat || !target;
  const summary = target ? describeAdjust(target.adjust) : '';
  els.adjustLabel.textContent = summary || 'Adjust';
  els.adjustBtn.classList.toggle('text-amber-300', !!summary);
  els.adjustBtn.title = !movieFormat || !target
    ? 'Grab a frame first'
    : summary
      ? `This frame: ${summary}. Reset from the menu.`
      : 'Brighten or correct this frame';
}

function closeAdjustMenu() { els.adjustMenu.classList.add('hidden'); }

function renderAdjustMenu() {
  els.adjustMenu.innerHTML = '';
  const target = adjustTarget();
  for (const preset of PRESETS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'block w-full px-3 py-2 text-left hover:bg-neutral-800';
    const label = document.createElement('span');
    label.className = 'block text-sm font-semibold text-neutral-100';
    label.textContent = preset.label;
    const hint = document.createElement('span');
    hint.className = 'block text-[11px] leading-snug text-neutral-500';
    hint.textContent = preset.hint;
    item.append(label, hint);
    if (preset.key === 'reset' && target && isNeutral(target.adjust)) item.disabled = true;
    if (item.disabled) item.classList.add('opacity-40');
    else item.addEventListener('click', () => applyAdjust(preset.key));
    els.adjustMenu.appendChild(item);
  }
}

function applyAdjust(key) {
  const target = adjustTarget();
  if (!target) return;
  // Auto is the only one that has to look at the picture.
  const levels = key === 'auto' ? autoLevels(measureLevels(target.bitmap)) : null;
  const next = applyPreset(target.adjust || NEUTRAL, key, levels);
  slides = slides.map((s) => (s.id === target.id ? { ...s, adjust: next, blob: null } : s));
  closeAdjustMenu();
  render();
  syncAdjustButton();
  markDirty();
  const summary = describeAdjust(next);
  els.status.textContent = summary
    ? `Frame corrected: ${summary}.`
    : 'Frame back to how it was grabbed.';
}

els.adjustBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (els.adjustBtn.disabled) return;
  const open = els.adjustMenu.classList.contains('hidden');
  if (open) { renderAdjustMenu(); els.adjustMenu.classList.remove('hidden'); }
  else closeAdjustMenu();
});
// Same lesson as the batch search box: a menu that will not close is its own
// bug, and pointerdown does not depend on focus behaving.
document.addEventListener('pointerdown', (e) => {
  if (els.adjustMenu.classList.contains('hidden')) return;
  if (els.adjustMenu.contains(e.target) || els.adjustBtn.contains(e.target)) return;
  closeAdjustMenu();
});

// ================= Full-slide preview =================
// The thumbnail is 72px wide, which is enough to spot a missing frame and not
// enough to judge a line break. This renders the same composed slide big, from
// the same code path the upload uses, so what you tune is what ships.
const PREVIEW_MODAL_SCALE = 0.5;
function openSlidePreview(slide) {
  captionFontReady().then(() => {
    composeToCanvas(els.slidePreviewCanvas, slide.bitmap, slide.caption, {
      titleLine: currentTitleLine(),
      scale: PREVIEW_MODAL_SCALE,
      fontScale: slide.fontScale || 1,
      maxFrameHeightRatio: frameHeightRatio(),
      format: project.format, kind: slide.kind, adjust: slide.adjust, stampNudge: slide.stampNudge || 0,
    });
    const idx = slides.findIndex((s) => s.id === slide.id);
    const scale = Math.round((slide.fontScale || 1) * 100);
    els.slidePreviewMeta.textContent =
      `Slide ${idx + 1} of ${slides.length} · text ${scale}%${scale === 100 ? ' (auto)' : ''}`;
    els.slidePreview.classList.remove('hidden');
    els.slidePreview.classList.add('flex');
  }).catch((e) => console.error('[tik] slide preview failed:', e));
}
function closeSlidePreview() {
  els.slidePreview.classList.add('hidden');
  els.slidePreview.classList.remove('flex');
}
els.slidePreviewClose.addEventListener('click', closeSlidePreview);
// Click the backdrop (not the slide itself) to dismiss.
els.slidePreview.addEventListener('click', (e) => { if (e.target === els.slidePreview) closeSlidePreview(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.slidePreview.classList.contains('hidden')) closeSlidePreview();
});

// ---- Followers card (home) ----
// Current count from TikTok when signed in (snapshotted at most hourly);
// the accumulated series renders as a line chart once it has 2+ days.
let lastStatsSeries = null;
// When each post went out, in ms, for the dots on the follower line. Cached
// alongside the series so a redraw (style toggle, resize) does not re-ask
// TikTok — and stays an empty list when the history is not connected, which
// simply means no dots rather than a broken chart.
let lastPostTimes = [];

// 'history' (what happened, with the fitted trend) or 'forecast' (both paces
// extended into dated future). The milestone table only belongs to the latter.
const LS_CHART_STYLE = 'tik_chart_style';
let statsMode = 'history';
let statsStyle = ['area', 'bars', 'retro'].includes(localStorage.getItem(LS_CHART_STYLE))
  ? localStorage.getItem(LS_CHART_STYLE) : 'area';

function drawStats(series, { animate = false } = {}) {
  if (!series?.length) return;
  renderFollowerChart(els.statsChart, series, els.statsTip, {
    mode: statsMode, style: statsStyle, legendEl: els.statsLegend, animate,
    posts: lastPostTimes,
  });
  for (const btn of els.statsStyles.querySelectorAll('button')) {
    const on = btn.dataset.style === statsStyle;
    btn.classList.toggle('bg-neutral-800', on);
    btn.classList.toggle('text-neutral-100', on);
    btn.classList.toggle('text-neutral-500', !on);
  }
  const forecasting = statsMode === 'forecast';
  els.statsForecast.classList.toggle('hidden', !forecasting);
  if (forecasting) els.statsForecast.innerHTML = forecastHtml(series);
  for (const btn of els.statsModes.querySelectorAll('button')) {
    const on = btn.dataset.mode === statsMode;
    btn.classList.toggle('bg-neutral-800', on);
    btn.classList.toggle('text-neutral-100', on);
    btn.classList.toggle('text-neutral-500', !on);
  }
}
els.statsStyles.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-style]');
  if (!btn || btn.dataset.style === statsStyle) return;
  statsStyle = btn.dataset.style;
  localStorage.setItem(LS_CHART_STYLE, statsStyle);
  drawStats(lastStatsSeries, { animate: true });
});
els.statsModes.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn || btn.dataset.mode === statsMode) return;
  statsMode = btn.dataset.mode;
  drawStats(lastStatsSeries, { animate: true });
});
// Post dates for the chart's dots. Shares loadPosts()'s cache with the tag
// report and the cadence row, so this is not a third call to TikTok. A failure
// is not fatal: no dots is a fine chart.
async function loadPostTimes() {
  if (!isSignedIn() || tagReportScopeMissing) return [];
  try {
    const data = await loadPosts();
    if (data.scope === 'missing') return [];
    return (data.posts || [])
      .map((p) => Number(p?.created) * 1000)
      .filter((t) => Number.isFinite(t) && t > 0);
  } catch (e) {
    console.warn('[tik] post dates for the chart unavailable:', e);
    return [];
  }
}

async function refreshStatsCard() {
  refreshTagReport(); // non-blocking, separate scope, handles its own errors
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
      requestAnimationFrame(() => drawStats(series, { animate: true }));
      // The dots arrive on their own schedule; redraw when they do rather than
      // holding the whole chart behind a TikTok call.
      loadPostTimes().then((times) => {
        if (!times.length || lastStatsSeries !== series) return;
        lastPostTimes = times;
        drawStats(series);
      });
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

// ================= Hashtag report =================
// TikTok exposes no hashtag volume data to us (the Creative Center endpoint
// answers "no permission" and /tag/<name> pages carry no counts), so the only
// honest signal is our own posts. This reads the tags back off what shipped.
//
// Needs the video.list scope, which may not be granted — that is an expected
// state, and the panel simply stays hidden rather than showing a broken widget.
//
// The fetch itself lives in reports.js and is shared with the Reports screen.
// Both used to page video/list independently, which meant a single visit to
// the home screen could cost twenty TikTok API calls to answer one question
// twice.
let tagReportScopeMissing = false;

// Called when the signed-in account changes, so a fresh sign-in isn't written
// off because the previous account lacked the scope, and the previous
// account's posts are not reported as this one's.
function resetTagReport() {
  tagReportScopeMissing = false;
  cadenceReady = false;   // a different account's cadence is not this one's
  resetPostsCache();
}

// Whether to offer the video.list opt-in, and what to say about it. Shown only
// when signed in: "Connect post history" is meaningless to a signed-out user,
// who needs to sign in first.
function setHistoryPrompt(scope) {
  const needed = isSignedIn() && (scope === 'missing' || scope === 'stored');
  els.connectHistoryBtn.classList.toggle('hidden', !needed);
  els.connectHistoryBtn.classList.toggle('flex', needed);
  els.reportsHint.textContent = needed
    ? 'Post-level stats need TikTok’s video.list permission, which is a separate approval from sign-in.'
    : '';
}

// ---- posting cadence ----
//
// Tones live here rather than in cadence.js so the pure module stays free of
// Tailwind: it decides WHICH state, this decides what that state looks like.
const CADENCE_TONE = {
  green: { wrap: 'border-green-500/30 bg-green-500/5', icon: 'text-green-400', label: 'text-green-400' },
  amber: { wrap: 'border-amber-400/30 bg-amber-400/5', icon: 'text-amber-300', label: 'text-amber-300' },
  red: { wrap: 'border-red-500/40 bg-red-500/10', icon: 'text-red-400', label: 'text-red-400' },
  blue: { wrap: 'border-sky-500/25 bg-sky-500/5', icon: 'text-sky-300', label: 'text-sky-300' },
  grey: { wrap: 'border-neutral-800 bg-neutral-900', icon: 'text-neutral-500', label: 'text-neutral-500' },
};

const CADENCE_CARD = 'flex items-center gap-3 rounded-xl border px-4 py-3';

// Has a real answer ever been painted? renderLibrary re-runs on every search
// keystroke, and loadPosts serves those from cache, so ghosting each time
// would strobe a row that is not actually reloading. The ghost is for the
// first paint only; after that the last answer stays up while a new one is
// fetched, which is at most one TTL stale and never blank.
let cadenceReady = false;

// The shelf. Both counts are local, so they land immediately — no reason to
// make them wait behind a network call they have nothing to do with.
function renderCadenceShelf(counts) {
  const shelf = runway(counts);
  const pill = (el, n, word, days) => {
    el.classList.toggle('hidden', n === 0);
    if (n > 0) el.textContent = `${n} ${word} · ${dayLabel(days)}`;
  };
  pill(els.cadenceReadyPill, shelf.ready, 'ready', shelf.readyDays);
  pill(els.cadenceDraftsPill, shelf.drafts, shelf.drafts === 1 ? 'draft' : 'drafts', shelf.draftDays);
}

// Shown while TikTok is being asked. The card holds its own space from the
// first paint: a row that appears only once the answer lands reads as a
// finished page that then shoves everything down.
function showCadenceLoading(counts) {
  els.cadenceCard.className = `${CADENCE_CARD} ${CADENCE_TONE.grey.wrap}`;
  els.cadenceCard.setAttribute('aria-busy', 'true');
  els.cadenceGhost.classList.remove('hidden');
  els.cadenceLive.classList.add('hidden');
  els.cadenceLive.classList.remove('flex');
  renderCadenceShelf(counts);
}

function renderCadence(state, counts) {
  cadenceReady = true;
  const tone = CADENCE_TONE[state.tone] || CADENCE_TONE.grey;
  els.cadenceCard.className = `${CADENCE_CARD} ${tone.wrap}`;
  els.cadenceCard.setAttribute('aria-busy', 'false');
  els.cadenceGhost.classList.add('hidden');
  els.cadenceLive.classList.remove('hidden');
  els.cadenceLive.classList.add('flex');
  els.cadenceIcon.textContent = state.icon;
  els.cadenceIcon.className = `material-symbols-outlined text-[22px] leading-none ${tone.icon}`;
  els.cadenceHeadline.textContent = state.headline;
  els.cadenceLabel.textContent = state.label;
  els.cadenceLabel.className = `text-[11px] font-bold uppercase tracking-wider ${tone.label}`;
  els.cadenceDetail.textContent = state.detail;
  renderCadenceShelf(counts);
}

async function refreshCadence(all) {
  const counts = {
    ready: all.filter((r) => statusOf(r) === 'ready').length,
    drafts: all.filter((r) => statusOf(r) === 'draft').length,
  };
  // The shelf is local either way, so it updates on every render.
  if (cadenceReady) renderCadenceShelf(counts);
  else showCadenceLoading(counts);
  if (!isSignedIn() || tagReportScopeMissing) {
    // Without TikTok's history the studio only knows about sets posted through
    // the API from here, and most are finished by hand in the app. Guessing
    // from that partial record would show red on a day of manual posting,
    // which is precisely the wrong answer, so say nothing instead.
    renderCadence(cadence(null), counts);
    return;
  }
  try {
    // Shares loadPosts()'s cache and in-flight de-duplication with the tag
    // report, so opening the Posts view is still one TikTok call, not two.
    const data = await loadPosts();
    if (data.scope === 'missing') { renderCadence(cadence(null), counts); return; }
    const at = lastPostAt({ posts: data.posts || [], projects: all });
    renderCadence(cadence(at), counts);
  } catch (e) {
    console.error('[tik] cadence check failed:', e);
    renderCadence(cadence(null), counts);
  }
}

async function refreshTagReport() {
  if (!isSignedIn() || tagReportScopeMissing) { els.tagReport.classList.add('hidden'); return; }
  try {
    // TTL and in-flight de-duplication are handled inside loadPosts().
    const data = await loadPosts();
    const rows = Array.isArray(data.posts) ? data.posts.filter((p) => p?.tags?.length) : [];
    setHistoryPrompt(data.scope);
    if (data.scope === 'missing' || !rows.length) {
      if (data.scope === 'missing') {
        // Once per session: the panel is hidden with no on-screen explanation,
        // so say why exactly once rather than on every render.
        tagReportScopeMissing = true;
        console.warn('[tik] tag report needs the video.list scope', { hint: data.hint });
      }
      els.tagReport.classList.add('hidden');
      return;
    }
    // Lifetime basis here on purpose: this panel has no post ages to work
    // with beyond what tik-posts sends, and the Reports screen carries the
    // age-adjusted version with the extra column to explain itself.
    const { note, body } = tagReportHtml(tagReport(rows));
    els.tagReport.classList.remove('hidden');
    els.tagReportNote.textContent = note;
    els.tagReportBody.innerHTML = body;
  } catch (e) {
    console.error('[tik] tag report failed:', e);
    els.tagReport.classList.add('hidden');
  }
}

// ================= Song picks =================
// No TikTok API mode can attach a specific song (auto_add_music is DIRECT_POST
// only and never names a track), so the agent's picks exist to be searched by
// hand in the app while finishing the draft.
function renderSongPicks() {
  const songs = project?.postMeta?.songs || [];
  // Any format whose writing call returns song picks, not just trivia. The
  // panel is driven by whether there ARE picks, so a format that does not ask
  // for them simply never shows it.
  const show = songs.length > 0;
  els.songPicks.classList.toggle('hidden', !show);
  // Picks buried in a collapsed panel are picks nobody uses: badge the summary
  // so they are visible without expanding, and open it once when they arrive.
  els.postDetailsBadge.classList.toggle('hidden', !show);
  els.postDetailsBadge.textContent = show
    ? `${songs.length} sound pick${songs.length === 1 ? '' : 's'}`
    : '';
  if (show) els.postDetails.open = true;
  if (!show) { els.songList.innerHTML = ''; return; }
  els.songList.innerHTML = songs.map((s) => `
    <li class="text-xs leading-snug text-neutral-300">
      <span class="font-semibold text-neutral-100">${escapeHtml(s.title)}</span>${s.artist ? ` <span class="text-neutral-500">${escapeHtml(s.artist)}</span>` : ''}
      ${s.why ? `<br><span class="text-[11px] text-neutral-600">${escapeHtml(s.why)}</span>` : ''}
    </li>`).join('');
}

// Re-render the chart on resize (debounced) so it tracks the card's width.
let statsResizeTimer = null;
window.addEventListener('resize', () => {
  if (!lastStatsSeries || els.home.classList.contains('hidden')) return;
  clearTimeout(statsResizeTimer);
  statsResizeTimer = setTimeout(() => renderFollowerChart(els.statsChart, lastStatsSeries, els.statsTip, {
    mode: statsMode, style: statsStyle, legendEl: els.statsLegend, posts: lastPostTimes,
  }), 150);
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
  // Every auth transition funnels through here, so this is where the tag
  // report's cached verdict is dropped: a new account may hold the video.list
  // scope the previous one lacked.
  resetTagReport();
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

    // Opted in for this grab only: keep what is there and put this beside it.
    const pairTarget = pairArmed ? adjustTarget() : null;
    if (pairTarget && canPairSlide(pairTarget) && pairTarget.bitmap) {
      pairArmed = false;
      els.pairArm.checked = false;
      const shot = await bitmapToBlob(bitmap);
      bitmap.close?.();
      // Already a pair? This replaces its SECOND frame, so a bad second grab
      // costs one grab rather than the whole slide.
      const first = pairTarget.pairFrames?.[0] || await frameBlobFor(pairTarget);
      const layout = pairLayoutOf(pairTarget.pairLayout);
      if (await applyPair(pairTarget.id, [first, shot], layout)) {
        if (editingId === pairTarget.id) exitEdit(); else render();
        syncAdjustButton();
        markDirty();
        els.status.textContent = `Two frames on this slide, ${PAIR_LAYOUT_LABELS[layout].toLowerCase()}. Use the slide's own button to switch.`;
      }
      return;
    }

    if (editingId) {
      slides = updateSlideFrame(slides, editingId, bitmap, els.video.currentTime);
      // A replace is a replace: whatever pairing was on this slide is gone,
      // which is also the only way back to a single frame.
      slides = slides.map((s) => (s.id === editingId ? { ...s, blob: null, pairFrames: null, pairLayout: null } : s));
      exitEdit();
      syncAdjustButton();
      els.status.textContent = 'Frame updated.';
    } else {
      if (!canAddSlide(slides)) { els.status.textContent = `Max ${MAX_SLIDES} slides.`; return; }
      // Same rule as the Add button: a new frame belongs before the sign-off.
      slides = addSlideBeforeOutro(slides, { id: String(nextId++), bitmap, blob: null, caption: '', timecode: els.video.currentTime, fontScale: 1 }, isOutroSlide);
      render();
      syncAdjustButton();
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
    const quotesMode = project.format === 'quotes';
    const duration = els.video.duration;
    let scenes;
    let meta;
    let subMissing = false;
    if (quotesMode) {
      els.status.textContent = 'Fetching IMDb quotes…';
      const pack = await fetchImdbQuotes({ query: movie.title || movie.query, year: movie.year });
      if (!pack.quotes?.length) throw new Error('IMDb has no quotes for this title.');
      els.status.textContent = 'Fetching English subtitles…';
      const subs = await fetchSubtitles({ imdbId: pack.movie?.id, query: movie.title, year: movie.year });
      subMissing = !!subs.missing;
      // Keep the REASON on the project, not just in a status line that the next
      // message overwrites. A whole set of guessed timecodes with no
      // explanation anywhere is how a broken install passes for a bad matcher.
      project.subsError = subMissing ? (subs.error || 'Subtitle lookup failed') : null;
      const pool = pack.quotes.slice(0, 20);
      const result = await fetchQuotesPost({
        title: movie.title || movie.query,
        year: movie.year,
        durationSeconds: duration,
        count: QUOTES_COUNT,
        quotes: pool,
        cues: subs.cues,
        includeTitleSlide: true,
        includeMeta: true,
        guidance: els.autopilotPrompt?.value || '',
        onProgress: (msg) => { els.status.textContent = msg; },
      });
      scenes = result.suggestions;
      meta = result.meta;
    } else {
      els.status.textContent = `Researching ${movie.query || 'the film'}…`;
      // If the starter box holds a list of pasted facts, make one slide per fact
      // (capped); otherwise the default 5. Title slide is always added on top.
      const guidance = els.autopilotPrompt.value.trim();
      const pasteItems = guidance.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
      const count = pasteItems.length >= 2 ? Math.min(pasteItems.length, 12) : 5;
      // Same call writes the post's own copy (hook, film hashtags, songs). Doing
      // it here rather than in a second call is what lets the prompt forbid the
      // hook from spoiling a fact: the model has the captions it just wrote.
      const result = await fetchTriviaPost({
        title: movie.title, year: movie.year, durationSeconds: duration,
        count, includeTitleSlide: true, includeMeta: true, guidance,
        onProgress: (m) => { els.status.textContent = `Researching ${movie.query || 'the film'} — ${m}`; },
      });
      scenes = result.suggestions;
      meta = result.meta;
    }
    if (project?.id === ticket && meta) {
      project.postMeta = meta;
      syncPostDefaults();  // no-op once the user has hand-edited the copy
      renderSongPicks();
    }
    let added = 0;
    for (let i = 0; i < scenes.length; i++) {
      if (project?.id !== ticket) return; // navigated away — don't pollute another project
      if (!canAddSlide(slides)) break;
      els.status.textContent = `Grabbing frame ${i + 1}/${scenes.length}…`;
      const bitmap = await grabAt(scenes[i].timecode);
      const caption = scenes[i].caption;
      slides = addSlide(slides, {
        id: String(nextId++), bitmap, blob: null,
        caption, timecode: scenes[i].timecode, grabHint: scenes[i].grab || '',
        // Only when applyCueTimes actually matched it — a model guess is not a cue.
        cue: scenes[i].matched ? { start: scenes[i].start, end: scenes[i].end } : null,
        fontScale: quotesMode ? (i === 0 ? 1 : fontScaleForQuote(caption)) : 1,
        // includeTitleSlide above means the first item is the intro, not a
        // fact. Marking it is what lets its editor buttons differ from a
        // fact's — an unmarked intro gets rewritten as another fact.
        kind: i === 0 ? 'title' : null,
      });
      added++;
    }
    // Cap off with the branded outro (logo + follow CTA). Never fatal.
    // pickOutro(project.format) so quotes get "more movie quotes".
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
    } else if (quotesMode) {
      const quotes = added - 1; // first added slide is the title slide
      renderSubsNote();
      const guessNote = subMissing ? ' — no subtitles, every time is a guess' : '';
      els.status.textContent = `Added a title slide + ${quotes} quote${quotes === 1 ? '' : 's'}${outroAdded ? ' + outro' : ''}${guessNote} — verify captions & frames, then post.`;
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

// ---- Add one slide by hand, at the current frame ----
//
// The agent is not always the one who knows the quote. This grabs the playhead
// frame, drops the slide in ahead of the sign-off, and puts the cursor in its
// caption box so the line can be typed straight away.
els.addManual.addEventListener('click', async () => {
  if (!videoReady) { els.status.textContent = 'Load a video first.'; return; }
  if (!canAddSlide(slides)) { els.status.textContent = `Max ${MAX_SLIDES} slides.`; return; }
  const quotes = project?.format === 'quotes';
  try {
    if (editingId) exitEdit(); // a hand-added slide is a new one, never a re-grab
    await awaitSeekSettled(els.video); // don't grab a stale frame mid-seek
    const bitmap = await grabFrame(els.video);
    const id = String(nextId++);
    slides = addSlideBeforeOutro(slides, {
      id, bitmap, blob: null, caption: '', timecode: els.video.currentTime, grabHint: '', fontScale: 1,
    }, isOutroSlide);
    render();
    syncAdjustButton();
    markDirty();
    focusSlideCaption(id);
    els.status.textContent = quotes
      ? 'Blank slide added at this frame — type the quote.'
      : 'Blank slide added at this frame — write it.';
  } catch (err) {
    console.error('[tik] manual add failed:', err);
    els.status.textContent = err.message;
  }
});

// Put the cursor in a slide's caption box and bring the row into view. A new
// blank slide is added to be typed into, and on a long set it lands off-screen.
function focusSlideCaption(id) {
  const thumb = els.list.querySelector(`canvas[data-thumb="${CSS.escape(String(id))}"]`);
  const ta = thumb?.closest('li')?.querySelector('textarea');
  if (!ta) return;
  ta.scrollIntoView({ block: 'center', behavior: 'smooth' });
  ta.focus();
}

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
      heading: project.actor, sub: 'Remembering some guys', hint: 'Paste one photo, or 2–4 to tile them', accent: GUYS_ACCENT,
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
    els.status.textContent = 'Slides ready — the opener takes one photo whole, or 2–4 tiled; other slides take one photo of the guy. Click a slide, then paste, drop, or pick. Captions are editable.';
  } catch (err) {
    console.error('[tik] write blurbs failed:', err);
    els.status.textContent = err.message;
  } finally {
    setAiBusy(false);
  }
});

// ================= Freeform =================
//
// One brief, one call, a whole set. Some Guys needs two rounds because IMDb
// supplies the roles and the user picks among them; here the prompt IS the
// brief, so there is nothing to choose between and nothing to wait for twice.
//
// Every slide lands as a placeholder card carrying its own image-search term,
// because on this format the pictures are the whole job.
const FREEFORM_ACCENT = '#a3e635';
const FREEFORM_MIN = 3;
const FREEFORM_MAX = 15;
const FREEFORM_DEFAULT = 8;

function syncFreeformCount() {
  const want = Number(project?.freeformCount) || FREEFORM_DEFAULT;
  if (!els.freeformCount.options.length) {
    for (let n = FREEFORM_MIN; n <= FREEFORM_MAX; n++) {
      els.freeformCount.appendChild(new Option(`${n}`, String(n)));
    }
  }
  els.freeformCount.value = String(Math.min(FREEFORM_MAX, Math.max(FREEFORM_MIN, want)));
}

els.freeformWrite.addEventListener('click', async () => {
  if (aiBusy || !project) return;
  const topic = els.freeformTopic.value.trim();
  if (!topic) { els.status.textContent = 'Say what the set is about first.'; els.freeformTopic.focus(); return; }
  const count = Number(els.freeformCount.value) || FREEFORM_DEFAULT;
  setAiBusy(true);
  const ticket = project.id; // bail if the user opens another project mid-job
  try {
    els.status.textContent = `Writing ${count} slides…`;
    const { title, intro, items, meta } = await fetchFreeform({
      topic, count, includeMeta: true,
      onProgress: (m) => { els.status.textContent = `Writing the set — ${m}`; },
    });
    if (project?.id !== ticket) return;

    project.topic = topic;
    project.freeformCount = count;
    // The agent names the set; the brief is the fallback so a project is never
    // called "Untitled" in the library.
    if (!project.name?.trim()) project.name = title || topic.slice(0, 60);
    els.projectName.value = project.name;
    if (meta) { project.postMeta = meta; syncPostDefaults(); renderSongPicks(); }

    resetEditState();  // the selected slide is about to be replaced wholesale
    pickTargetId = null;
    slides.forEach((s) => s.bitmap?.close?.());
    const next = [];
    next.push({
      id: String(nextId++), bitmap: await makeCardBitmap({
        heading: title || project.name, sub: 'VHS Garage', hint: 'Paste, drop, or pick an image', accent: FREEFORM_ACCENT,
      }), blob: null,
      caption: `${title || project.name}\n${intro || ''}`.trim(),
      grabHint: '', fontScale: 1, kind: 'title',
      // The opener searches for the subject itself.
      search: title || topic.slice(0, 80),
    });
    for (let i = 0; i < items.length && next.length < MAX_SLIDES - 1; i++) {
      const it = items[i];
      next.push({
        id: String(nextId++), bitmap: await makeCardBitmap({
          heading: it.heading, sub: it.sub || '', accent: FREEFORM_ACCENT,
        }), blob: null,
        caption: captionForFreeform(it),
        grabHint: '', fontScale: 1,
        // What photoQueryFor reads for this slide's image-search button.
        search: it.search,
      });
    }
    try { next.push(await makeOutroSlide()); }
    catch (e) { console.error('[tik] outro slide failed:', e); }
    slides = next;
    render();
    markDirty();
    els.status.textContent = `${items.length} slides ready — click a slide, hit Find images, and drop the picture in. Captions are editable.`;
  } catch (err) {
    console.error('[tik] freeform write failed:', err);
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

// The IMDb vote floor. A blank or junk box means the default, never "no floor"
// — an unfloored rating list is exactly what this control exists to prevent.
function minVotesFromInput() {
  const n = Math.round(Number(els.minVotes.value));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 10_000_000) : DEFAULT_MIN_VOTES;
}

// The year in play: what's typed, or failing that what this project was last
// looked up for. The box can be empty in a reopened project while the snapshot
// is not, and a chart link is useless if it forgets which year it is for.
function currentYear() {
  return yearFromInput() ?? (Number.isInteger(project?.year) ? project.year : null);
}

// Keep the source links pointed at the current year + floor. This is only for
// what the user sees on hover: the href that actually gets followed is rebuilt
// on click (see wireSourceLink), so no missed event can send them to the wrong
// year's chart.
function refreshSourceLinks() {
  const y = currentYear();
  const floor = minVotesFromInput();
  els.imdbSearchLink.href = y ? imdbSearchUrl(y, floor) : '#';
  els.imdbSearchLink.title = y
    ? `IMDb ${y} features, rated highest first, ${floor.toLocaleString()}+ votes`
    : 'Enter a year first';
  els.mojoLink.href = y ? boxOfficeMojoUrl(y) : '#';
  els.mojoLink.title = y ? `Box Office Mojo ${y} worldwide chart` : 'Enter a year first';
  for (const el of [els.imdbSearchLink, els.mojoLink]) el.classList.toggle('opacity-50', !y);
}

// Rebuild a chart link's href in the click handler, immediately before the
// browser follows it. Deriving it from an 'input' event alone meant any path
// that set the year without one (reopening a project, autofill, a programmatic
// fill) left a stale link pointing at the wrong year, or at no year at all.
function wireSourceLink(el, build) {
  el.addEventListener('click', (e) => {
    const y = currentYear();
    if (!y) {
      e.preventDefault();
      els.status.textContent = 'Enter a year first, then open the chart.';
      els.yearInput.focus();
      return;
    }
    el.href = build(y);
  });
}
wireSourceLink(els.imdbSearchLink, (y) => imdbSearchUrl(y, minVotesFromInput()));
wireSourceLink(els.mojoLink, (y) => boxOfficeMojoUrl(y));

// What each paste box currently yields. Told separately from "what the agent
// will do with it" so the notes can say which path is live.
function pastedRated() {
  return parseImdbList(els.imdbPaste.value, YEAR_LIST_SIZE);
}
function pastedGross() {
  return parseGrossList(els.mojoPaste.value, YEAR_LIST_SIZE);
}

const NOTE_IDLE = 'mt-1 text-[11px] leading-snug text-neutral-500';
const NOTE_LIVE = 'mt-1 text-[11px] leading-snug text-violet-300';

function refreshImdbPasteNote() {
  const parsed = pastedRated();
  if (!parsed.length) {
    els.imdbPasteNote.textContent = 'Leave this empty and the agent picks the rated list from memory, applying the vote floor itself.';
    els.imdbPasteNote.className = NOTE_IDLE;
    return;
  }
  const rated = parsed.filter((p) => p.rating !== null).length;
  const lowest = parsed.reduce((min, p) => (p.votes !== null && (min === null || p.votes < min) ? p.votes : min), null);
  els.imdbPasteNote.textContent =
    `Read ${parsed.length} title${parsed.length === 1 ? '' : 's'}` +
    (rated < parsed.length ? ` (${rated} with a rating)` : '') +
    (lowest !== null ? `, lowest ${formatVotes(lowest)}` : '') +
    '. These become the rated list exactly as pasted; the agent only writes the notes.';
  els.imdbPasteNote.className = NOTE_LIVE;
}

function refreshMojoPasteNote() {
  const parsed = pastedGross();
  if (!parsed.length) {
    els.mojoPasteNote.textContent = 'Leave this empty and the agent recalls the box office list itself.';
    els.mojoPasteNote.className = NOTE_IDLE;
    return;
  }
  const top = parsed.find((p) => Number.isFinite(p.gross));
  els.mojoPasteNote.textContent =
    `Read ${parsed.length} release${parsed.length === 1 ? '' : 's'}` +
    (top ? `, top ${formatGross(top.gross)}` : '') +
    '. These become the box office list exactly as pasted; the agent only writes the notes.';
  els.mojoPasteNote.className = NOTE_LIVE;
}

// What came back, per list — including a list that came back empty, since
// "the agent wasn't confident enough to fill this" is worth seeing before you
// start hunting posters. Also flags whether the rated list is your data or the
// model's recall.
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
    // Say where the rated list came from: pasted IMDb results are verified
    // data, recall is not, and the difference should never be invisible.
    label.textContent = snap[`${list.key}FromPaste`]
      ? `${list.label} (from your paste)`
      : list.label;
    const count = document.createElement('span');
    count.className = `text-xs font-semibold tabular-nums ${n ? 'text-violet-300' : 'text-neutral-600'}`;
    count.textContent = n ? `${n} of ${YEAR_LIST_SIZE}` : 'no data found';
    row.append(label, count);
    els.yearSummaryLists.appendChild(row);
  }
}

// Overwrite one of the snapshot's lists with the rows the user pasted, keeping
// only the agent's notes. Titles, order, and figures stay exactly as pasted —
// the whole point of pasting is that those are not the model's to revise.
function applyGivenList(snapshot, key, given) {
  if (!given.length) return;
  const replied = snapshot[key] || [];
  const byTitle = new Map();
  for (const r of replied) {
    const k = String(r.title || '').toLowerCase();
    if (!byTitle.has(k)) byTitle.set(k, r);
  }
  snapshot[key] = given.map((g, i) => ({
    ...g,
    note: (byTitle.get(g.title.toLowerCase()) || replied[i])?.note || '',
  }));
  snapshot[`${key}FromPaste`] = true;
}

// Build the whole slideshow from a snapshot: opener, then a lead-in slide plus
// the entries of each list that came back, then the branded outro. Lists that
// came back empty are skipped entirely, lead-in and all.
async function buildYearSlides(snapshot) {
  const y = project.year;
  const next = [];
  const room = () => next.length < MAX_SLIDES - 1; // always leave the outro a seat

  // Opener: the year as a big card, with the agent's lead-in as the caption.
  // One image, like every other slide in this format.
  const openerBitmap = await makeCardBitmap({
    heading: String(y), sub: 'The year in movies', hint: 'Paste your opener image', accent: YEAR_ACCENT,
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

// Renumber the year lists and redraw. Every edit that moves an entry slide
// (insert, delete, drag) goes through here, so a "#4" on screen always means
// fourth in its section.
function reRankAndRender() {
  if (project?.format === 'year') slides = renumberYearEntries(slides);
  render();
  markDirty();
}

// Slip a missed film into a list. `title` is required; `value` is the number
// line ("8.7 on IMDb", "$210M worldwide") and may be blank. The new slide is
// the same generated card as its neighbours, so it takes a poster the same way
// and carries the same image-search link.
async function insertYearEntry(index, { title, value }) {
  const list = slides[index]?.entry?.list || slides[index]?.section || 'rated';
  const bitmap = await makeCardBitmap({
    heading: title, sub: value || String(project.year || ''), accent: YEAR_ACCENT,
  });
  const slide = {
    id: String(nextId++), bitmap, blob: null,
    // The rank here is a placeholder; renumbering below assigns the real one.
    caption: captionForYearEntry({ rank: 1, title, value, note: '' }),
    grabHint: '', fontScale: 1,
    entry: { list, rank: 1, title, value, note: '' },
  };
  slides = [...slides.slice(0, index + 1), slide, ...slides.slice(index + 1)];
  reRankAndRender();
}

// The inline "add a film here" form, opened from a slide's toolbar. Kept inside
// the slide's <li> so the insertion point is unambiguous.
function openInsertForm(li, index) {
  if (li.querySelector('[data-insert-form]')) return;
  const form = document.createElement('div');
  form.dataset.insertForm = '1';
  form.className = 'mt-2 flex flex-wrap items-center gap-1 rounded-lg border border-violet-400/40 bg-neutral-950 p-2';

  const titleIn = document.createElement('input');
  titleIn.placeholder = 'Film we missed';
  titleIn.maxLength = 120;
  titleIn.className = 'min-w-0 flex-[2] basis-40 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 placeholder:text-neutral-600';

  const valueIn = document.createElement('input');
  valueIn.placeholder = 'e.g. 8.7 on IMDb';
  valueIn.maxLength = 44;
  valueIn.className = 'min-w-0 flex-1 basis-28 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 placeholder:text-neutral-600';

  const add = document.createElement('button');
  add.className = 'rounded-md bg-violet-500 px-3 py-1 text-xs font-bold text-neutral-950 hover:bg-violet-400 disabled:opacity-40';
  add.textContent = 'Add';
  const cancel = document.createElement('button');
  cancel.className = 'rounded-md bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700';
  cancel.textContent = 'Cancel';

  // A form inside a draggable <li> loses text selection to the drag handler.
  [titleIn, valueIn].forEach((f) => {
    f.addEventListener('pointerdown', () => { li.draggable = false; });
    f.addEventListener('blur', () => { li.draggable = true; });
  });

  const submit = async () => {
    const title = titleIn.value.trim();
    if (!title) { titleIn.focus(); return; }
    if (!canAddSlide(slides)) { els.status.textContent = `Max ${MAX_SLIDES} slides — delete one first.`; return; }
    add.disabled = true;
    try {
      await insertYearEntry(index, { title, value: valueIn.value.trim() });
      els.status.textContent = `Added ${title}. The list renumbered itself, so check the ranks below it.`;
    } catch (err) {
      console.error('[tik] insert entry failed:', err);
      els.status.textContent = 'Couldn’t add that slide.';
      add.disabled = false;
    }
  };
  add.addEventListener('click', submit);
  cancel.addEventListener('click', () => { form.remove(); li.draggable = true; });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); form.remove(); li.draggable = true; }
  });

  form.append(titleIn, valueIn, add, cancel);
  li.append(form);
  titleIn.focus();
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
    project.minVotes = minVotesFromInput();
    project.imdbPaste = els.imdbPaste.value;
    project.mojoPaste = els.mojoPaste.value;
    if (!project.name) { project.name = String(y); els.projectName.value = String(y); }
    syncPostDefaults();
    markDirty(); // persist the year/draft even if the lookup fails
    const ticket = project.id; // bail if the user opens another project mid-job

    // A paste makes that list the user's data, not the model's: it goes out as
    // a fixed list and comes back with only notes attached.
    const givenRated = toRatedEntries(pastedRated(), YEAR_LIST_SIZE);
    const givenBox = toGrossEntries(pastedGross(), YEAR_LIST_SIZE);
    const pastedCount = givenRated.length + givenBox.length;
    els.status.textContent = pastedCount
      ? `Looking up ${y} from your ${pastedCount} pasted titles…`
      : `Looking up ${y}…`;

    // A paste is data we already hold, so an AI failure must not throw it away:
    // fall back to a snapshot built entirely from what was pasted.
    let snapshot;
    let aiFailed = '';
    try {
      snapshot = await fetchYearSnapshot({
        year: y, count: YEAR_LIST_SIZE, minVotes: project.minVotes,
        ratedGiven: givenRated, boxofficeGiven: givenBox,
        onProgress: (m) => { els.status.textContent = `Looking up ${y} — ${m}`; },
      });
    } catch (err) {
      if (!pastedCount) throw err;
      console.warn('[tik] year lookup failed; building from your pasted lists alone', err);
      snapshot = { intro: '', rated: [], boxoffice: [] };
      aiFailed = err.message;
    }
    if (project?.id !== ticket) return;

    // Belt and braces: the prompt says copy the pasted titles and values
    // verbatim, and this makes sure of it. The model's notes are matched by
    // title, then by position, so a reordered or renamed reply can't shuffle
    // the ranking the user pulled off the source site.
    applyGivenList(snapshot, 'rated', givenRated);
    applyGivenList(snapshot, 'boxoffice', givenBox);
    project.snapshot = snapshot;
    renderYearSummary();
    const { sections, entries } = await buildYearSlides(snapshot);
    if (project?.id !== ticket) return;
    const missing = YEAR_LISTS.filter((l) => !(snapshot[l.key] || []).length).map((l) => l.label);
    els.status.textContent = (aiFailed ? `${aiFailed} Built what your paste covers instead: ` : '') +
      `${sections} list${sections === 1 ? '' : 's'} and ${entries} movie slides for ${y}` +
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

// The year and the vote floor both feed the IMDb link, so it re-points as they
// change rather than going stale behind a collapsed <details>.
els.yearInput.addEventListener('input', refreshSourceLinks);
els.minVotes.addEventListener('input', () => {
  refreshSourceLinks();
  if (project) { project.minVotes = minVotesFromInput(); markDirty(); }
});
els.imdbPaste.addEventListener('input', () => {
  refreshImdbPasteNote();
  if (project) { project.imdbPaste = els.imdbPaste.value; markDirty(); }
});
els.mojoPaste.addEventListener('input', () => {
  refreshMojoPasteNote();
  if (project) { project.mojoPaste = els.mojoPaste.value; markDirty(); }
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
  syncAdjustButton(); // the menu now points at this slide
  if (isMovieFileFormat()) {
    els.status.textContent = slide.grabHint
      ? `Editing — GRAB: ${slide.grabHint}  (or paste/drop an image)`
      : 'Editing this slide — scrub to a new frame and Save, or paste/drop an image. Esc cancels.';
    if (videoReady && Number.isFinite(slide.timecode)) await seekAndSettle(els.video, slide.timecode);
  } else if (isMosaicSlide(slide)) {
    els.status.textContent = 'Opener selected — paste, drop, or pick one photo to show it whole, or 2–4 to tile them. Esc cancels.';
  } else {
    els.status.textContent = 'Slide selected — paste, drop, or pick an image for it. Esc cancels.';
  }
}

function resetEditState() {
  editingId = null;
  els.grabIcon.textContent = 'photo_camera';
  els.grabLabel.textContent = 'Grab frame';
  els.cancelEdit.classList.add('hidden');
  closeAdjustMenu();
  syncAdjustButton();
}
function exitEdit() { resetEditState(); render(); }
els.cancelEdit.addEventListener('click', () => { exitEdit(); els.status.textContent = 'Edit cancelled.'; });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && editingId) { exitEdit(); els.status.textContent = 'Edit cancelled.'; }
});

// The "Remembering Some Guys" opener is a photo mosaic: its frame is built from
// 1–4 pasted photos instead of a single image. Only that first title slide gets
// the mosaic treatment; every other guy slide is a plain single photo.
//
// A Year Snapshot never mosaics: every slide there takes one already-composed
// image, so combining several would only fight what the user pasted in.
function isMosaicSlide(slide) {
  return project?.format === 'guys' && slide?.kind === 'title';
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
      ? 'One photo, shown whole. Paste, drop, or pick up to 3 more to tile them instead.'
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
  els.addManual.disabled = !videoReady || !canAddSlide(slides); // no model involved, so aiBusy is irrelevant
  els.download.disabled = slides.length === 0;
  els.list.innerHTML = '';
  slides.forEach((slide, index) => els.list.appendChild(renderSlide(slide, index)));
  syncSeedControls();
  updatePostButton();
}

// A Year Snapshot's slides are pasted, already-composed artwork, shown whole:
// bounded by HEIGHT so the caption never gets pushed down the slide, while a
// square or widescreen image still runs the full width.
const YEAR_FRAME_HEIGHT_RATIO = 0.6;
function frameHeightRatio() {
  return project?.format === 'year' ? YEAR_FRAME_HEIGHT_RATIO : null;
}

// Redraw the preview thumbnails in place (no full re-render) so editing a caption
// or the title updates the live preview without rebuilding the list / losing focus.
function redrawAllThumbs() {
  slides.forEach((slide) => {
    const thumb = els.list.querySelector(`canvas[data-thumb="${slide.id}"]`);
    if (thumb) composeToCanvas(thumb, slide.bitmap, slide.caption, { titleLine: currentTitleLine(), scale: PREVIEW_SCALE, fontScale: slide.fontScale || 1, maxFrameHeightRatio: frameHeightRatio(), format: project.format, kind: slide.kind, adjust: slide.adjust, stampNudge: slide.stampNudge || 0 });
  });
}

function renderSlide(slide, index) {
  const isTrivia = project?.format === 'trivia';
  const movieFile = isMovieFileFormat();
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
  thumb.title = movieFile ? 'Click to re-grab or replace this frame' : 'Click to select, then paste/drop/pick an image';
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
  ta.placeholder = project?.format === 'quotes' ? 'Quote for this frame…'
    : isTrivia ? 'Trivia for this frame…'
    : project?.format === 'year' ? 'Caption for this slide…'
      : 'Blurb for this guy…';
  ta.value = slide.caption;
  suspendDragWhileEditing(ta);

  // Redraw this slide's preview from the live caption + its per-slide font scale.
  const redrawThumb = () => composeToCanvas(thumb, slide.bitmap, ta.value, {
    titleLine: currentTitleLine(), scale: PREVIEW_SCALE, fontScale: slide.fontScale || 1,
    maxFrameHeightRatio: frameHeightRatio(),
    format: project.format, kind: slide.kind, adjust: slide.adjust, stampNudge: slide.stampNudge || 0,
  });
  redrawThumb();

  ta.addEventListener('input', () => {
    slides = editCaption(slides, slide.id, ta.value);
    redrawThumb();
    noteOutroReviewed(slide);
    markDirty();
  });
  mid.append(ta);

  // Where in the film this slide is supposed to come from.
  //
  // The number was invisible until you clicked the thumbnail and watched the
  // scrubber move, which is no way to check eight slides. Clicking it parks the
  // playhead there so Play can confirm the line by ear — the fastest way to know
  // a quote slide is on the wrong scene is to hear the wrong words.
  //
  // On a Quote-a-long it also says where the number came from: a cue span the
  // subtitle matcher found, or an estimate the model made because nothing
  // matched. Those two deserve very different amounts of trust.
  if (isMovieFileFormat() && Number.isFinite(Number(slide.timecode))) {
    const row = document.createElement('div');
    row.className = 'flex flex-wrap items-center gap-1.5';

    const jump = document.createElement('button');
    const matched = !!slide.cue;
    jump.className = `flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums transition ${
      matched ? 'bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'}`;
    jump.append(iconSpan('schedule', 'text-[13px]'), document.createTextNode(clockTimecode(slide.timecode)));
    jump.title = videoReady
      ? 'Jump the player here, then press play to hear it'
      : 'Load the movie file to jump here';
    jump.addEventListener('click', () => {
      if (!videoReady) { els.status.textContent = 'Load the movie file first.'; return; }
      els.video.pause();
      els.video.currentTime = Math.min(slide.timecode, els.video.duration || slide.timecode);
      els.video.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      els.status.textContent = `Player at ${clockTimecode(slide.timecode)} — press play to hear it.`;
    });
    row.append(jump);

    if (project?.format === 'quotes' && slide.kind !== 'title' && slide.kind !== 'outro') {
      const src = document.createElement('span');
      src.className = `text-[10px] uppercase tracking-wide ${matched ? 'text-emerald-400/70' : 'text-amber-300/70'}`;
      src.textContent = matched ? 'from subtitles' : 'estimated';
      src.title = matched
        ? `Matched to the subtitle cue at ${clockTimecode(slide.cue.start)}–${clockTimecode(slide.cue.end)}.`
        : 'No subtitle cue matched this line, so the time is the model\u2019s guess. Worth checking.';
      row.append(src);
    }
    mid.append(row);
  }

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
    noteOutroReviewed(slide);
    markDirty();
  };
  fontDown.addEventListener('click', () => nudgeFont(-0.1));
  fontUp.addEventListener('click', () => nudgeFont(0.1));

  // Quote-a-long title card: slide the badge up or down the poster.
  //
  // The badge sits high by default, and posters put their own lettering
  // wherever they like — on plenty of them the wordmark lands right on the
  // film's title. Nothing here can guess that, so it is a pair of arrows.
  let stampUp = null;
  let stampDown = null;
  if (wantsQuoteStamp({ format: project?.format, kind: slide.kind })) {
    const at = () => clampStampNudge(slide.stampNudge);
    stampUp = tbBtn('keyboard_arrow_up', '', 'Move the Quote-a-long badge up', 'text-amber-300');
    stampDown = tbBtn('keyboard_arrow_down', '', 'Move the Quote-a-long badge down', 'text-amber-300');
    // How far the badge can go depends on the frame it is on, so the arrows go
    // by where the last draw actually put it, not by a step count.
    const syncArrows = (placement) => {
      stampUp.disabled = !canNudgeStamp(at(), -1, placement);
      stampDown.disabled = !canNudgeStamp(at(), 1, placement);
      stampUp.classList.toggle('opacity-40', stampUp.disabled);
      stampDown.classList.toggle('opacity-40', stampDown.disabled);
    };
    const nudgeStamp = (delta) => {
      const next = clampStampNudge(at() + delta);
      if (next === at()) return;
      slide.stampNudge = next; // keep the closure current for redraws
      slides = slides.map((x) => (x.id === slide.id ? { ...x, stampNudge: next } : x));
      const drawn = redrawThumb();
      syncArrows(drawn?.stamp);
      markDirty();
      els.status.textContent = next === 0 ? 'Badge back at its default height.' : 'Badge moved.';
    };
    stampUp.addEventListener('click', () => nudgeStamp(-1));
    stampDown.addEventListener('click', () => nudgeStamp(1));
    // The badge may not have decoded yet on a first paint; a null placement
    // leaves both arrows live, which is the harmless way to be wrong.
    syncArrows(redrawThumb()?.stamp);
  }

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

  // Year Snapshot: slip a film in below this one. Offered on entry slides and
  // on the lead-in slide (so a missed #1 can go straight to the top of a list),
  // because ordering alone can't recover a film that was never in the list.
  let insertBtn = null;
  if (project?.format === 'year' && (slide.entry || slide.kind === 'section')) {
    insertBtn = tbBtn('playlist_add', 'Add film below', 'Insert a film we missed, directly below this slide', 'text-violet-300');
    insertBtn.addEventListener('click', () => openInsertForm(li, index));
  }

  // A paired slide can flip between the two arrangements from its own row,
  // which is where the slide is and where its other controls already live.
  let pairBtn = null;
  if (slide.pairFrames?.length === 2) {
    const layout = pairLayoutOf(slide.pairLayout);
    pairBtn = tbBtn(
      layout === 'stack' ? 'vertical_split' : 'horizontal_split',
      PAIR_LAYOUT_LABELS[otherLayout(layout)],
      `Two frames, ${PAIR_LAYOUT_LABELS[layout].toLowerCase()} — switch to ${PAIR_LAYOUT_LABELS[otherLayout(layout)].toLowerCase()}`,
      'text-rose-300',
    );
    pairBtn.addEventListener('click', () => {
      togglePairLayout(slide.id).catch((e) => console.error('[tik] layout switch failed:', e));
    });
  }

  toolbar.append(pickBtn, ...(photoSearch ? [photoSearch] : []), ...(pairBtn ? [pairBtn] : []), ...(insertBtn ? [insertBtn] : []), ...(stampUp ? [stampUp, stampDown] : []), fontDown, fontUp);

  // The sign-off is house copy and format-agnostic (nextOutro knows what
  // "more" means per format), so Quote-a-long gets the swap too even though it
  // has no per-slide AI actions of its own.
  if (isMovieFileFormat() && isOutroSlide(slide)) {
    // The sign-off is house copy from a fixed pool, so "another one" is a pool
    // pick, not a model call: there is nothing here for an LLM to know, and
    // paying Opus to re-say "follow VHS Garage" would be silly.
    const swapBtn = tbBtn('auto_awesome', 'Try another sign-off', 'A different closing line from the set', 'text-fuchsia-300');
    swapBtn.addEventListener('click', () => {
      const line = nextOutro(project?.format, slide.caption);
      slides = editCaption(slides, slide.id, line);
      ta.value = line;
      redrawThumb();
      noteOutroReviewed(slide);
      markDirty();
      els.status.textContent = 'New sign-off.';
    });
    toolbar.append(swapBtn);
  } else if (isTrivia) {
    // The intro is a different writing job from a fact: it opens the post
    // rather than paying one off, so it gets its own prompt on the server and
    // has no "new fact" twin (its frame is the title card, which does not
    // move). Everything else on the slideshow is a fact and keeps both.
    const isIntro = isIntroSlide(slide, index, project?.format);
    const rewriteBtn = isIntro
      ? tbBtn('auto_awesome', 'Rewrite the intro', 'A fresh opening line, keeps the title card', 'text-fuchsia-300')
      : tbBtn('auto_awesome', 'Rewrite this fact', 'New wording for this same fact, keeps the frame', 'text-fuchsia-300');
    const newFactBtn = isIntro ? null : tbBtn('refresh', 'Create a new fact', 'A different fact, with a new frame');
    const btns = [rewriteBtn, ...(newFactBtn ? [newFactBtn] : [])];

    const runAi = async (mode) => {
      if (aiBusy) return;
      if (mode === 'newFact' && !videoReady) { els.status.textContent = 'Load the movie file first — a new fact needs a new frame.'; return; }
      setAiBusy(true);
      const ticket = project?.id; // bail if the user opens another project mid-job
      for (const b of btns) b.disabled = true;
      try {
        if (mode === 'rewrite' && isIntro) {
          // Quote-a-long title is the movie name only — never the two-sentence
          // trivia intro rewrite.
          if (project?.format === 'quotes') {
            els.status.textContent = 'Quote-a-long intro stays the movie name.';
          } else {
            // A fresh opener; the title card stays. Every other caption goes in
            // as "already used" so the new intro can neither repeat itself nor
            // spoil a fact the slides are about to pay off.
            els.status.textContent = 'Rewriting the intro…';
            const scene = await fetchTitleSlide({
              title: movie.title || project.name, year: movie.year,
              durationSeconds: els.video.duration || 7200,
              exclude: slides.map((s) => s.caption),
              onProgress: (m) => { els.status.textContent = `Rewriting the intro — ${m}`; },
            });
            if (project?.id !== ticket) return;
            slides = editCaption(slides, slide.id, scene.caption);
            ta.value = scene.caption;
            redrawThumb();
            els.status.textContent = 'Intro rewritten.';
          }
        } else if (mode === 'rewrite') {
          // A fresh take on THIS fact; the frame stays.
          els.status.textContent = 'Rewriting this fact…';
          const exclude = slides.filter((s) => s.id !== slide.id).map((s) => s.caption);
          const [scene] = await fetchScenes({
            title: movie.title || project.name, year: movie.year,
            durationSeconds: els.video.duration || 7200,
            count: 1, exclude, focusTimecode: slide.timecode,
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
            count: 1, exclude,
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
        for (const b of btns) b.disabled = false;
      }
    };
    rewriteBtn.addEventListener('click', () => runAi('rewrite'));
    newFactBtn?.addEventListener('click', () => runAi('newFact'));
    toolbar.append(...btns);
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

  // Delete, then preview, stacked at the top-right.
  const side = document.createElement('div');
  side.className = 'flex flex-none flex-col gap-1';

  const del = document.createElement('button');
  del.className = 'rounded-md bg-neutral-800 px-2 py-1 text-neutral-400 hover:bg-neutral-700 hover:text-red-400 disabled:opacity-40';
  del.title = 'Delete slide';
  del.append(iconSpan('delete'));
  del.addEventListener('click', () => {
    slides = removeSlide(slides, slide.id);
    if (slide.id === editingId) resetEditState(); // don't leave edit mode dangling
    reRankAndRender(); // the films below just moved up a place
  });

  // The 72px thumb is enough to notice a wrong frame and nowhere near enough to
  // judge where a line breaks, which is the thing actually being tuned here.
  const preview = document.createElement('button');
  preview.className = 'rounded-md bg-neutral-800 px-2 py-1 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-100';
  preview.title = 'Preview this slide full size';
  preview.append(iconSpan('visibility'));
  preview.addEventListener('click', () => openSlidePreview(slide));

  side.append(del, preview);
  row.append(thumb, mid, side);
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
      reRankAndRender(); // dragging changes ranks, and can change sections
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
      const blob = await composeSlide(slides[i].bitmap, slides[i].caption, { titleLine, fontScale: slides[i].fontScale || 1, maxFrameHeightRatio: frameHeightRatio(), format: project.format, kind: slides[i].kind, adjust: slides[i].adjust, stampNudge: slides[i].stampNudge || 0 });
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
      maxFrameHeightRatio: frameHeightRatio(),
      format: project.format,
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
      renderStatusChip();
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

  // Font readiness is armed once here and re-checked whenever a project opens
  // (see enterEditor). The old one-shot fired at boot behind `if (project)`,
  // which at boot is almost always false — so the single repair opportunity was
  // spent doing nothing and previews kept the fallback font's line breaks.
  syncThumbsToCaptionFont();

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
