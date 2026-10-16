// Whole-film frame search — the arithmetic.
//
// The old checker looked at twelve frames within about four minutes of the
// writer's guess. The guess comes from the model's MEMORY of the film, and
// memory is routinely ten minutes out, so the right shot was often never in
// front of the judge at all. Search, not judgement, was the bottleneck.
//
// So: look at the whole film once. A frame every SCAN_STEP seconds, tiled 48 to
// a numbered grid, and every fact for the film asked about in the same pass.
// Then a tight second grid around whatever the first pass found.
//
// Image cost is ⌈w/28⌉ × ⌈h/28⌉ tokens — pixels, not pictures — so one
// 1536×648 grid of 48 thumbnails costs the same ~1,320 tokens as one frame of
// that size. That is the whole trick.
//
// Pure: no DOM, no network. Unit-tested under node:test.

export const SCAN_STEP = 6;          // seconds between samples; shorter than most shots
export const SCAN_MAX_FRAMES = 1300; // a three-hour film still fits; the step grows instead

// The coarse grid: 8 × 6 cells of 192 × 108. The image is 1536 × 648, which is
// under every model's long-edge limit, so nothing gets downscaled on arrival.
export const SCAN_GRID = { cols: 8, rows: 6, cellW: 192, cellH: 108 };
// The fine grid: 4 × 3 cells of 384 × 216 — same image size, four times the
// detail per cell, for the frame-exact pick.
export const PIN_GRID = { cols: 4, rows: 3, cellW: 384, cellH: 216 };
export const PIN_SPAN = 14;          // seconds either side of the scan's hit

// Grids per model call. Six coarse grids is ~1.2MB of JPEG — comfortably inside
// a function's request limit — and the chunks run in parallel.
export const GRIDS_PER_CALL = 6;

// Below this the scan's hit is not trusted at all and the slide falls back to
// the old checker around the writer's guess.
export const SCAN_MIN_SCORE = 50;
// Below this the final frame is kept, but flagged for a human look.
export const REVIEW_BELOW = 70;

export function cellsPer(grid) {
  return grid.cols * grid.rows;
}

export function gridSize(grid) {
  return { width: grid.cols * grid.cellW, height: grid.rows * grid.cellH };
}

// Where cell `i` (0-based, reading order) sits.
export function cellRect(grid, i) {
  const col = i % grid.cols;
  const row = Math.floor(i / grid.cols);
  return { x: col * grid.cellW, y: row * grid.cellH, w: grid.cellW, h: grid.cellH };
}

// The seconds to sample, start to finish.
//
// The step stretches for a very long film rather than the frame count
// growing without limit, and the first and last second are skipped: they are
// black on nearly every file.
export function scanTimes(durationSeconds, { step = SCAN_STEP, max = SCAN_MAX_FRAMES } = {}) {
  const dur = Number(durationSeconds);
  if (!Number.isFinite(dur) || dur <= 2) return [];
  const usable = dur - 2;
  const s = Math.max(step, usable / max);
  const out = [];
  for (let t = 1; t <= dur - 1; t += s) out.push(Math.round(t * 10) / 10);
  return out;
}

// Split sample times into grids, and grids into calls.
//
// Returns [{ label, times }] per grid — labels run A, B, … Z, AA, AB so a long
// film never runs out of names — and the calls as arrays of grid indexes.
export function gridLabel(n) {
  let s = '';
  let i = n;
  do {
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return s;
}

export function planGrids(times, grid = SCAN_GRID, perCall = GRIDS_PER_CALL) {
  const per = cellsPer(grid);
  const grids = [];
  for (let i = 0; i < times.length; i += per) {
    grids.push({ label: gridLabel(grids.length), times: times.slice(i, i + per) });
  }
  const calls = [];
  for (let i = 0; i < grids.length; i += perCall) {
    calls.push(grids.slice(i, i + perCall).map((_, k) => i + k));
  }
  return { grids, calls };
}

// The pinpoint grid's times: an even spread across ±span around the hit,
// clamped into the film.
export function pinTimes(center, durationSeconds, { span = PIN_SPAN, count = cellsPer(PIN_GRID) } = {}) {
  const dur = Number(durationSeconds);
  const c = Number(center);
  if (!Number.isFinite(c)) return [];
  const hi = Number.isFinite(dur) && dur > 0 ? dur - 0.5 : Infinity;
  const n = Math.max(2, Math.round(count));
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = c - span + (2 * span * k) / (n - 1);
    out.push(Math.round(Math.min(hi, Math.max(0.5, t)) * 10) / 10);
  }
  // Clamping at either end of the film can stack duplicates; keep one of each.
  return [...new Set(out)];
}

// Turn "grid C, cell 17" back into a time.
export function cellSeconds(grids, label, cell) {
  const g = (grids || []).find((x) => x.label === String(label || '').toUpperCase());
  const i = Number(cell) - 1; // the model counts from 1, because the labels do
  if (!g || !Number.isInteger(i) || i < 0 || i >= g.times.length) return null;
  return g.times[i];
}

// Merge every call's answers into one best guess per fact.
//
// Each call only saw part of the film, so each says "in my part, the best
// match for fact 3 is cell 17, score 80" — or nothing. The highest score
// across calls wins. A cell that does not exist is dropped, not trusted.
export function mergeScan(results, grids, factCount) {
  const best = Array.from({ length: Math.max(0, factCount) }, () => null);
  for (const res of Array.isArray(results) ? results : []) {
    for (const m of Array.isArray(res) ? res : []) {
      const f = Number(m?.fact) - 1;
      if (!Number.isInteger(f) || f < 0 || f >= best.length) continue;
      const seconds = cellSeconds(grids, m?.grid, m?.cell);
      if (seconds === null) continue;
      const score = clampScore(m?.score);
      if (!best[f] || score > best[f].score) {
        best[f] = { seconds, score, why: String(m?.why || '').slice(0, 200) };
      }
    }
  }
  return best;
}

export function clampScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

// How a frame came to be, and whether a human should look at it.
//
// This is the thing that turns "check all hundred frames" into "check these
// three": the batch does the work, and says which work it is unsure of.
export function frameVerdict({ source, score = null, verified = false, degraded = false } = {}) {
  // Number(null) is 0, and "no score" must not read as "scored zero".
  const s = score === null || score === undefined || !Number.isFinite(Number(score)) ? null : clampScore(score);
  let review;
  if (degraded) review = true;                          // a model was unavailable
  else if (source === 'scan') review = s === null || s < REVIEW_BELOW;
  else if (source === 'verify') review = !verified;     // the old checker never found one
  else review = true;                                   // a bare guess, never looked at
  return { source: source || 'guess', score: s, review };
}
