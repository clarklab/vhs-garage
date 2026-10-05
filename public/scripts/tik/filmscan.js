// Whole-film frame search, browser side.
//
// The arithmetic lives in scan.js (tested). This is the part that has to touch
// a <video>, a canvas and the network: seek, draw the numbered grids, hand them
// to tik-locate-background, and poll for the answer.
//
// Built for an unattended ten-film batch, so two rules run through it:
//   - nothing waits forever: every seek, kick and poll has a ceiling;
//   - a dead endpoint is found on the FIRST chunk, before two minutes of
//     seeking are spent on a film that cannot be searched anyway.

import { seekAndSettle } from './capture.js';
import {
  SCAN_GRID, PIN_GRID, GRIDS_PER_CALL, gridSize, cellRect,
  scanTimes, planGrids, pinTimes, mergeScan, clampScore,
} from './scan.js';

const LOCATE_URL = '/.netlify/functions/tik-locate-background';
const POLL_URL = '/.netlify/functions/tik-autopilot';
const POLL_MS = 1200;
const SCAN_WAIT_MS = 150_000;
const PIN_WAIT_MS = 75_000;
const NEVER_STARTED_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jobId = () => (crypto.randomUUID?.() ??
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));

function aborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { stopped: true });
}

// ---- Drawing ----

// One grid, drawn straight from the video: seek, draw into the cell, next.
// No ImageBitmaps are held, so a 1,100-frame film costs one canvas of memory.
export async function drawGrid(video, times, grid, { label = '', fontPx = 16, signal, onFrame = () => {} } = {}) {
  const { width, height } = gridSize(grid);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;

  for (const [i, t] of times.entries()) {
    aborted(signal);
    await seekAndSettle(video, t);
    const r = cellRect(grid, i);
    // Contain, not cover: a scope film's edges are often where the subject is.
    const scale = Math.min(r.w / vw, r.h / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    ctx.drawImage(video, r.x + (r.w - dw) / 2, r.y + (r.h - dh) / 2, dw, dh);
    numberCell(ctx, r, i + 1, fontPx);
    onFrame(i + 1, times.length);
  }
  // A thin grid line, so two dark frames side by side do not read as one shot.
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  for (let c = 1; c < grid.cols; c++) line(ctx, c * grid.cellW + 0.5, 0, c * grid.cellW + 0.5, height);
  for (let r = 1; r < grid.rows; r++) line(ctx, 0, r * grid.cellH + 0.5, width, r * grid.cellH + 0.5);

  const base64 = canvas.toDataURL('image/jpeg', 0.74).split(',')[1];
  return { label, times, base64 };
}

function numberCell(ctx, r, n, px) {
  const text = String(n);
  ctx.font = `bold ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textBaseline = 'top';
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fillRect(r.x + 2, r.y + 2, w, px + 6);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, r.x + 6, r.y + 5);
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}

// ---- Talking to the job ----

async function kick(payload) {
  const id = jobId();
  const res = await fetch(LOCATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, jobId: id }),
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => ({ ok: false, status: 0, error: e }));
  if (!res.ok) {
    throw Object.assign(new Error(`Frame search unavailable (${res.status || 'network'})`), { unavailable: true });
  }
  return id;
}

async function waitForJob(id, { maxMs, signal }) {
  const t0 = Date.now();
  let fails = 0;
  let started = false;
  while (Date.now() - t0 < maxMs) {
    aborted(signal);
    await sleep(POLL_MS);
    const res = await fetch(`${POLL_URL}?job=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15_000) })
      .catch(() => null);
    if (!res || !res.ok) {
      if (++fails >= 6) throw new Error('Frame search kept failing to answer.');
      continue;
    }
    fails = 0;
    const data = await res.json().catch(() => ({}));
    if (data.started) started = true;
    if (!data.done) {
      if (!started && Date.now() - t0 > NEVER_STARTED_MS) {
        throw Object.assign(new Error('Frame search never started.'), { unavailable: true });
      }
      continue;
    }
    if (!data.ok) throw new Error(data.error || 'Frame search failed.');
    return data;
  }
  throw new Error('Frame search took too long.');
}

// ---- The two passes ----

// facts: [{ caption, grab, kind }] in slide order.
// → { best: [{ seconds, score, why } | null] per fact, grids, calls, frames }
export async function scanFilm(video, { facts, durationSeconds, onProgress = () => {}, signal } = {}) {
  const dur = Number(durationSeconds) || video.duration || 0;
  const times = scanTimes(dur);
  if (!times.length || !facts?.length) return { best: facts?.map(() => null) || [], grids: [], calls: 0, frames: 0 };
  const plan = planGrids(times, SCAN_GRID, GRIDS_PER_CALL);
  const total = times.length;
  let drawn = 0;

  // Pipelined: each chunk is sent the moment it is drawn, so the model works on
  // chunk N while chunk N+1 is still being seeked out of the film.
  const pending = [];
  for (const [c, gridIdx] of plan.calls.entries()) {
    const grids = [];
    for (const gi of gridIdx) {
      const g = plan.grids[gi];
      grids.push(await drawGrid(video, g.times, SCAN_GRID, {
        label: g.label,
        signal,
        onFrame: () => {
          drawn += 1;
          if (drawn % 24 === 0 || drawn === total) onProgress(`scanning the whole film — ${drawn}/${total} frames`);
        },
      }));
    }
    // The first kick doubles as the health check: if the endpoint is down, stop
    // here instead of seeking through the rest of the film for nothing.
    const id = await kick({ mode: 'scan', grids, facts, durationSeconds: dur });
    pending.push({ id, grids, call: c });
  }

  onProgress(`asking which frames match ${facts.length} facts…`);
  const answers = await Promise.all(pending.map(async (p) => {
    try {
      const data = await waitForJob(p.id, { maxMs: SCAN_WAIT_MS, signal });
      return data.matches || [];
    } catch (e) {
      if (e.stopped) throw e;
      // One chunk failing costs that stretch of the film, not the whole scan.
      console.warn(`[tik-scan] chunk ${p.call + 1} of ${pending.length} failed: ${e.message}`);
      return [];
    }
  }));

  return {
    best: mergeScan(answers, plan.grids, facts.length),
    grids: plan.grids.length,
    calls: pending.length,
    frames: total,
  };
}

// Twelve consecutive frames around a scan hit; pick the exact one.
// → { seconds, score, issue, why } or null when none of them shows it.
export async function pinpoint(video, { fact, center, durationSeconds, onProgress = () => {}, signal } = {}) {
  const times = pinTimes(center, durationSeconds || video.duration);
  if (!times.length) return null;
  onProgress('pinpointing the frame');
  const grid = await drawGrid(video, times, PIN_GRID, { label: 'P', fontPx: 22, signal });
  const id = await kick({ mode: 'pinpoint', grids: [grid], facts: [fact], durationSeconds });
  const data = await waitForJob(id, { maxMs: PIN_WAIT_MS, signal });
  const pick = data.pick || {};
  if (!Number.isInteger(pick.cell)) return null;
  const seconds = times[pick.cell - 1];
  if (!Number.isFinite(seconds)) return null;
  return { seconds, score: clampScore(pick.score), issue: pick.issue || 'ok', why: pick.why || '' };
}

