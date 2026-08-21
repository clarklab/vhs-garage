// Step 2 of batch mode: filling in the frames.
//
// Rebuilt after the old version reliably appeared to freeze. Three things were
// wrong and all three are addressed here structurally, not cosmetically:
//
//   1. The folder crawl happened INSIDE the per-draft loop, so the first movie
//      silently paid for a full scan of a huge library. Crawling is now its own
//      explicit step with its own progress and a Stop button, and the result is
//      persisted so later sessions start instantly.
//   2. A <select> showed one draft at a time, so a four-movie run looked like a
//      one-movie job. Every draft is now a row you can watch.
//   3. There was no way to tell running from hung. A heartbeat ticks every
//      second on its own timer — independent of the work — and goes amber when
//      the work stops reporting, so "is this alive?" is answerable at a glance
//      from across the room.
//
// Owns its own DOM. batch.js only tells it when the tab is shown.

import { grabVerifiedFrame, grabSettledFrame } from './vision.js';
import { loadVideoFile } from './capture.js';
import {
  fsSupported, setMoviesFolder, getMoviesFolder, armHandle, pickMovieFile,
  indexFolder, invalidateFolderIndex, folderIndexInfo, loadFolderIndex,
  matchInIndex, nearMisses,
} from './filestore.js';
import { putProject, getProject, listProjects } from './store.js';

const $ = (id) => document.getElementById(id);
const HEARTBEAT_MS = 1000;
const STALL_WARN_MS = 20_000; // no report for this long → say so out loud

let els = null;
let rows = [];          // [{ id, name, title, year, slides, state, file, detail, done, total }]
let running = false;
let abort = null;       // AbortController for the current run
let beat = { at: 0, timer: null, phase: '' };
let video = null;

export function initShoot() {
  els = {
    root: $('batch-shoot'),
    folderStatus: $('batch-folder-status'), folderBtn: $('batch-folder-btn'),
    scan: $('batch-scan'), unlock: $('batch-unlock'), unlockLabel: $('batch-unlock-label'),
    run: $('batch-run'), phase: $('batch-run-phase'), detail: $('batch-run-detail'),
    bar: $('batch-run-bar'), cancel: $('batch-cancel'),
    pulse: $('batch-pulse'), beatText: $('batch-heartbeat-text'),
    list: $('batch-drafts'), empty: $('batch-drafts-empty'), summary: $('batch-draft-summary'),
    find: $('batch-find'), shootAll: $('batch-shoot-all'),
    video: $('batch-video'), file: $('batch-file'), shots: $('batch-shots'),
  };
  video = els.video;

  els.folderBtn.addEventListener('click', onSetFolder);
  els.scan.addEventListener('click', () => scanFolder({ rescan: true }));
  els.unlock.addEventListener('click', onUnlock);
  els.find.addEventListener('click', findFiles);
  els.shootAll.addEventListener('click', shootAll);
  els.cancel.addEventListener('click', () => abort?.abort());
}

// Called every time the Shoot tab is shown.
export async function refreshShoot() {
  if (!els) return;
  await loadDrafts();
  await refreshFolder();
}

export const isShooting = () => running;

// ================= the folder =================

async function refreshFolder() {
  if (!fsSupported()) {
    els.folderStatus.textContent = 'This browser cannot remember folders — pick each file by hand.';
    els.scan.disabled = true;
    return;
  }
  const folder = await getMoviesFolder().catch((e) => {
    console.error(`[tik-shoot] could not read the saved folder: ${e.message}`, e);
    return null;
  });
  if (!folder) {
    els.folderStatus.textContent = 'Not set. Pick it once and every draft finds its own file.';
    showUnlock(false);
    els.scan.disabled = true;
    return;
  }
  if (folder.state !== 'granted') {
    els.folderStatus.textContent = `“${folder.name}” remembered — unlock to use it.`;
    showUnlock(true, `Unlock “${folder.name}”`, folder.handle);
    els.scan.disabled = true;
    return;
  }
  showUnlock(false);
  els.scan.disabled = running;

  // A previous session's listing means no crawl at all this time.
  const restored = await loadFolderIndex().catch(() => null);
  const info = folderIndexInfo();
  els.folderStatus.textContent = info
    ? `“${folder.name}” · ${info.videos.toLocaleString()} videos${info.at ? ` · scanned ${ago(info.at)}` : ''}` +
      `${restored?.restored ? ' (remembered)' : ''}`
    : `“${folder.name}” · not scanned yet — hit Scan folder.`;
}

let unlockTarget = null;
function showUnlock(on, label, handle) {
  els.unlock.classList.toggle('hidden', !on);
  els.unlock.classList.toggle('flex', !!on);
  if (on) { els.unlockLabel.textContent = label; unlockTarget = handle; }
}

async function onUnlock() {
  if (!unlockTarget || !(await armHandle(unlockTarget))) return;
  await refreshFolder();
}

async function onSetFolder() {
  const folder = await setMoviesFolder();
  if (!folder) return;
  invalidateFolderIndex();
  await refreshFolder();
  await scanFolder({ rescan: true });
}

// The crawl, as its own visible step. Cancelable, with live counts.
async function scanFolder({ rescan = false } = {}) {
  const folder = await getMoviesFolder();
  if (!folder || folder.state !== 'granted') return;
  if (rescan) invalidateFolderIndex();

  startRun('Scanning folder', 1);
  try {
    const info = await indexFolder(folder.handle, {
      signal: abort.signal,
      onProgress: ({ files, videos, dir }) => {
        // Every tick is proof of life AND a location, so a slow scan reads as
        // work in a named folder rather than a hang.
        pulse(`${dir ? `in “${dir}”` : ''} — ${files.toLocaleString()} files, ${videos.toLocaleString()} videos`);
      },
    });
    finishRun(`Scanned ${info.videos.toLocaleString()} videos${info.truncated ? ' (hit the file cap — pick a narrower folder)' : ''}.`);
    await refreshFolder();
    await findFiles();
  } catch (e) {
    if (e?.name === 'AbortError') { finishRun('Scan stopped.'); return; }
    console.error(`[tik-shoot] folder scan failed: ${e.message}`, e);
    finishRun(`Scan failed: ${e.message}`, true);
  }
}

// ================= the drafts =================

async function loadDrafts() {
  let drafts = [];
  try {
    drafts = (await listProjects()).filter((p) => p.batch?.pendingFrames && (p.format === 'trivia' || p.format === 'quotes'));
  } catch (e) {
    console.error(`[tik-shoot] could not list drafts: ${e.message}`, e);
  }
  const prev = new Map(rows.map((r) => [r.id, r]));
  rows = drafts.map((d) => {
    const old = prev.get(d.id);
    return {
      id: d.id,
      name: d.name || d.movie?.title || 'Untitled',
      title: d.movie?.title || '',
      year: d.movie?.year || null,
      format: d.format,
      total: (d.slides || []).filter((s) => s.batchShot !== 'skip' && s.kind !== 'outro').length,
      state: old?.state === 'done' ? 'done' : (old?.state || 'idle'),
      file: old?.file || null,
      detail: old?.detail || '',
      done: old?.done || 0,
    };
  });
  render();
}

// Match every draft against the already-scanned listing. Pure lookup, instant.
async function findFiles() {
  if (!rows.length) return;
  const info = folderIndexInfo();
  if (!info) {
    for (const r of rows) { r.state = 'unscanned'; r.detail = 'folder not scanned yet'; }
    render();
    return;
  }
  for (const r of rows) {
    if (r.state === 'done' || r.state === 'picked') continue;
    const hit = matchInIndex(r.title, r.year);
    if (hit) {
      r.state = 'matched';
      r.file = { name: hit.name, load: () => hit.handle.getFile() };
      r.detail = hit.name;
    } else {
      const near = nearMisses(r.title, r.year, 2);
      r.state = 'nofile';
      r.file = null;
      r.detail = near.length
        ? `no match — closest: ${near.map((n) => `${n.name} (${n.score})`).join(', ')}`
        : 'no matching file in your folder';
    }
  }
  render();
}

async function pickFor(row) {
  const picked = await pickMovieFile(row.title, row.year);
  if (!picked) return;
  row.state = 'picked';
  row.file = { name: picked.file.name, load: async () => picked.handle.getFile() };
  row.detail = `${picked.file.name} (remembered)`;
  render();
}

// ================= shooting =================

async function shootAll() {
  const queue = rows.filter((r) => r.file && r.state !== 'done');
  if (!queue.length) return;

  const totalFrames = queue.reduce((n, r) => n + (r.total || 0), 0);
  let doneFrames = 0;
  startRun('Shooting', totalFrames || queue.length);
  els.shots.innerHTML = '';

  try {
    for (const [i, row] of queue.entries()) {
      if (abort.signal.aborted) break;
      row.state = 'shooting';
      row.done = 0;
      render();

      let project;
      try {
        project = await getProject(row.id);
        if (!project) throw new Error('draft is gone');
        pulse(`loading ${row.file.name}`);
        const meta = await loadVideoFile(await row.file.load(), video);
        video.classList.remove('hidden');
        row.duration = meta.duration;
      } catch (e) {
        console.error(`[tik-shoot] could not open ${row.name}: ${e.message}`, e);
        row.state = 'failed';
        row.detail = e.message;
        render();
        continue;
      }

      const slides = project.slides || [];
      const shootable = slides.filter((s) => s.batchShot !== 'skip' && s.kind !== 'outro');
      let verified = 0;

      for (const [n, slide] of shootable.entries()) {
        if (abort.signal.aborted) break;
        setPhase('Shooting', `${row.name} — movie ${i + 1} of ${queue.length}, frame ${n + 1} of ${shootable.length}`);
        try {
          const grabber = project.format === 'quotes' ? grabSettledFrame : grabVerifiedFrame;
          const out = await grabber(video, {
            timecode: slide.timecode,
            durationSeconds: row.duration || project.batch?.runtimeSeconds || 0,
            caption: slide.caption,
            grab: slide.grabHint,
            kind: slide.batchShot === 'title' ? 'title' : 'trivia',
            onProgress: (m) => pulse(`${row.name}: ${m}`),
          });
          slide.frame = await bitmapToBlob(out.bitmap);
          slide.timecode = out.timecode;
          out.bitmap.close?.();
          if (out.verified) verified++;
        } catch (e) {
          console.error(`[tik-shoot] frame ${n + 1} of ${row.name} failed: ${e.message}`, e);
        }
        row.done = n + 1;
        doneFrames++;
        progress(doneFrames);
        render();
      }

      if (!abort.signal.aborted) {
        project.slides = slides;
        project.thumb = slides[0]?.frame || project.thumb;
        project.batch = { ...project.batch, pendingFrames: false };
        project.updatedAt = Date.now();
        await putProject(project);
        row.state = 'done';
        row.detail = project.format === 'quotes'
          ? `${shootable.length} frames grabbed`
          : `${verified} of ${shootable.length} frames verified`;
      } else {
        row.state = 'stopped';
        row.detail = `stopped after ${row.done} frames (not saved)`;
      }
      render();
    }

    const done = rows.filter((r) => r.state === 'done').length;
    const left = rows.filter((r) => r.state !== 'done').length;
    const stopped = abort.signal.aborted;
    finishRun(
      stopped
        ? `Stopped. ${done} finished and saved, ${left} still to do.`
        : `Finished ${done} draft${done === 1 ? '' : 's'}${left ? `, ${left} still need a file` : ''}. Open them from your library.`,
      stopped, // label it Stopped, not Done — they mean different things
    );
    await loadDrafts();
  } catch (e) {
    console.error(`[tik-shoot] run failed: ${e.message}`, e);
    finishRun(`Run failed: ${e.message}`, true);
  }
}

async function bitmapToBlob(bitmap) {
  const c = document.createElement('canvas');
  c.width = bitmap.width;
  c.height = bitmap.height;
  c.getContext('2d').drawImage(bitmap, 0, 0);
  return await new Promise((res, rej) =>
    c.toBlob((b) => (b ? res(b) : rej(new Error('Frame encode failed'))), 'image/jpeg', 0.92));
}

// ================= run state, progress, heartbeat =================

function startRun(phase, total) {
  running = true;
  abort = new AbortController();
  els.run.classList.remove('hidden');
  els.bar.style.width = '0%';
  els.run.dataset.total = String(Math.max(1, total));
  setPhase(phase, '');
  setBusy(true);
  beat.at = Date.now();
  beat.phase = phase;
  clearInterval(beat.timer);
  // The heartbeat runs on ITS OWN timer, so it keeps ticking even when the
  // work reports nothing — which is exactly the case where you need to know
  // whether it is alive.
  beat.timer = setInterval(tickHeartbeat, HEARTBEAT_MS);
  tickHeartbeat();
}

function finishRun(message, bad = false) {
  running = false;
  clearInterval(beat.timer);
  beat.timer = null;
  els.bar.style.width = '100%';
  setPhase(bad ? 'Stopped' : 'Done', message);
  els.phase.className = `text-sm font-bold tracking-tight ${bad ? 'text-amber-300' : 'text-emerald-300'}`;
  els.pulse.className = `inline-block h-1.5 w-1.5 rounded-full ${bad ? 'bg-amber-400' : 'bg-emerald-500'}`;
  els.beatText.textContent = message;
  setBusy(false);
  render();
}

function setPhase(phase, detail) {
  els.phase.textContent = phase;
  els.detail.textContent = detail;
}

function progress(done) {
  const total = Number(els.run.dataset.total) || 1;
  els.bar.style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
  beat.at = Date.now();
}

// Called by the work whenever anything at all happens.
function pulse(detail) {
  beat.at = Date.now();
  if (detail) els.detail.textContent = detail;
}

function tickHeartbeat() {
  const idle = Date.now() - beat.at;
  const stalled = idle > STALL_WARN_MS;
  els.pulse.className = `inline-block h-1.5 w-1.5 rounded-full ${stalled ? 'bg-amber-400' : 'bg-emerald-500 save-pulse'}`;
  els.beatText.textContent = stalled
    ? `Still going, but nothing has reported for ${Math.round(idle / 1000)}s — big folders can be slow. Stop is safe.`
    : `Working — last update ${idle < 1500 ? 'just now' : `${Math.round(idle / 1000)}s ago`}`;
  els.beatText.className = stalled ? 'text-amber-300/90' : '';
}

function setBusy(on) {
  for (const b of [els.find, els.shootAll, els.scan, els.folderBtn]) b.disabled = on;
  els.cancel.disabled = !on;
}

// ================= rendering =================

const STATE_UI = {
  idle:      { dot: 'bg-neutral-600', label: 'waiting' },
  unscanned: { dot: 'bg-amber-400',   label: 'scan the folder first' },
  matched:   { dot: 'bg-emerald-500', label: 'ready' },
  picked:    { dot: 'bg-emerald-500', label: 'ready' },
  nofile:    { dot: 'bg-red-500',     label: 'no file' },
  shooting:  { dot: 'bg-emerald-400 save-pulse', label: 'shooting' },
  done:      { dot: 'bg-emerald-500', label: 'done' },
  failed:    { dot: 'bg-red-500',     label: 'failed' },
  stopped:   { dot: 'bg-amber-400',   label: 'stopped' },
};

function render() {
  els.list.innerHTML = '';
  els.empty.classList.toggle('hidden', rows.length > 0);
  const ready = rows.filter((r) => r.file && r.state !== 'done').length;
  const done = rows.filter((r) => r.state === 'done').length;
  els.summary.textContent = rows.length
    ? `${rows.length} draft${rows.length === 1 ? '' : 's'} · ${ready} ready · ${done} done`
    : '';
  els.shootAll.disabled = running || !ready;
  els.find.disabled = running || !rows.length;

  for (const r of rows) {
    const ui = STATE_UI[r.state] || STATE_UI.idle;
    const li = document.createElement('li');
    li.className = 'flex flex-wrap items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2';

    const dot = document.createElement('span');
    dot.className = `h-2 w-2 shrink-0 rounded-full ${ui.dot}`;

    const name = document.createElement('span');
    name.className = 'text-sm font-semibold';
    name.textContent = r.name;

    const state = document.createElement('span');
    state.className = 'rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-neutral-400';
    state.textContent = r.state === 'shooting' ? `${r.done}/${r.total}` : ui.label;

    const detail = document.createElement('span');
    detail.className = 'min-w-0 flex-1 truncate text-[11px] text-neutral-500';
    detail.textContent = r.detail || (r.total ? `${r.total} frames` : '');
    detail.title = r.detail || '';

    li.append(dot, name, state, detail);

    if (r.state !== 'done' && r.state !== 'shooting') {
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'shrink-0 rounded-md bg-neutral-800 px-2.5 py-1 text-xs font-semibold hover:bg-neutral-700 disabled:opacity-40';
      pick.textContent = r.file ? 'Change' : 'Pick file';
      pick.disabled = running;
      pick.addEventListener('click', () => pickFor(r));
      li.append(pick);
    }
    els.list.appendChild(li);
  }
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
