import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCAN_STEP, SCAN_MAX_FRAMES, SCAN_GRID, PIN_GRID, PIN_SPAN, GRIDS_PER_CALL, SCAN_MIN_SCORE, REVIEW_BELOW,
  cellsPer, gridSize, cellRect, scanTimes, gridLabel, planGrids, pinTimes, cellSeconds, mergeScan,
  clampScore, frameVerdict,
} from '../../public/scripts/tik/scan.js';

// ---- The grids cost what we think they cost ----

const tokens = ({ width, height }) => Math.ceil(width / 28) * Math.ceil(height / 28);

test('a coarse grid fits the smallest model limit, so nothing is downscaled', () => {
  const s = gridSize(SCAN_GRID);
  assert.ok(s.width <= 1568 && s.height <= 1568, `${s.width}x${s.height} would be resized on arrival`);
  assert.ok(tokens(s) <= 1568, `${tokens(s)} tokens is over the standard-tier image budget`);
});

test('the fine grid is the same size, with four times the detail per cell', () => {
  assert.deepEqual(gridSize(PIN_GRID), gridSize(SCAN_GRID));
  assert.equal(PIN_GRID.cellW * PIN_GRID.cellH, 4 * SCAN_GRID.cellW * SCAN_GRID.cellH);
});

test('a call stays well under the image-count threshold', () => {
  // Over 20 images a stricter per-image size limit applies.
  assert.ok(GRIDS_PER_CALL <= 20);
});

test('cells are laid out in reading order', () => {
  assert.deepEqual(cellRect(SCAN_GRID, 0), { x: 0, y: 0, w: 192, h: 108 });
  assert.deepEqual(cellRect(SCAN_GRID, 7), { x: 7 * 192, y: 0, w: 192, h: 108 });
  assert.deepEqual(cellRect(SCAN_GRID, 8), { x: 0, y: 108, w: 192, h: 108 }, 'cell 9 starts row two');
  const last = cellRect(SCAN_GRID, cellsPer(SCAN_GRID) - 1);
  const { width, height } = gridSize(SCAN_GRID);
  assert.equal(last.x + last.w, width);
  assert.equal(last.y + last.h, height);
});

// ---- Sampling the film ----

test('a feature film is sampled every few seconds, end to end', () => {
  const t = scanTimes(110 * 60);
  assert.equal(t[0], 1, 'skips the black first second');
  assert.ok(t.at(-1) <= 110 * 60 - 1, 'and the black last one');
  assert.ok(t.at(-1) > 110 * 60 - 1 - SCAN_STEP, 'but reaches the end');
  for (let i = 1; i < t.length; i++) assert.ok(Math.abs(t[i] - t[i - 1] - SCAN_STEP) < 0.11);
});

test('a very long film stretches the step instead of the frame count', () => {
  const t = scanTimes(4 * 3600);
  assert.ok(t.length <= SCAN_MAX_FRAMES + 1, `${t.length} frames`);
  assert.ok(t.length > SCAN_MAX_FRAMES * 0.95, 'and still uses nearly all of them');
});

test('nothing to sample in a film too short to have one', () => {
  assert.deepEqual(scanTimes(0), []);
  assert.deepEqual(scanTimes(2), []);
  assert.deepEqual(scanTimes(NaN), []);
});

// ---- Grids and calls ----

test('grid labels never run out', () => {
  assert.equal(gridLabel(0), 'A');
  assert.equal(gridLabel(25), 'Z');
  assert.equal(gridLabel(26), 'AA');
  assert.equal(gridLabel(27), 'AB');
});

test('every sample lands in exactly one grid, and every grid in exactly one call', () => {
  const times = scanTimes(110 * 60);
  const { grids, calls } = planGrids(times);
  assert.deepEqual(grids.flatMap((g) => g.times), times);
  assert.ok(grids.slice(0, -1).every((g) => g.times.length === cellsPer(SCAN_GRID)), 'all full but the last');
  assert.deepEqual(calls.flat(), grids.map((_, i) => i));
  assert.ok(calls.every((c) => c.length <= GRIDS_PER_CALL));
  assert.equal(new Set(grids.map((g) => g.label)).size, grids.length, 'labels are unique');
});

// ---- From the model's answer back to a time ----

test('grid C, cell 1 is the first sample of grid C', () => {
  // The off-by-one that would silently ruin every frame: the model counts
  // cells from 1 because the labels do.
  const { grids } = planGrids(scanTimes(110 * 60));
  assert.equal(cellSeconds(grids, 'C', 1), grids[2].times[0]);
  assert.equal(cellSeconds(grids, 'c', 48), grids[2].times[47], 'labels are case-insensitive');
});

test('a cell that does not exist is not a time', () => {
  const { grids } = planGrids(scanTimes(110 * 60));
  assert.equal(cellSeconds(grids, 'A', 0), null);
  assert.equal(cellSeconds(grids, 'A', 49), null);
  assert.equal(cellSeconds(grids, 'A', 2.5), null);
  assert.equal(cellSeconds(grids, 'ZZZ', 3), null);
  const last = grids.at(-1);
  assert.equal(cellSeconds(grids, last.label, last.times.length + 1), null, 'past the end of a short last grid');
});

test('the best answer across calls wins, per fact', () => {
  const { grids } = planGrids(scanTimes(110 * 60));
  const callA = [{ fact: 1, grid: 'A', cell: 5, score: 60 }, { fact: 2, grid: 'B', cell: 3, score: 90 }];
  const callB = [{ fact: 1, grid: 'H', cell: 20, score: 85 }, { fact: 2, grid: 'I', cell: 1, score: 40 }];
  const best = mergeScan([callA, callB], grids, 3);
  assert.equal(best[0].seconds, cellSeconds(grids, 'H', 20), 'the 85 beats the 60');
  assert.equal(best[0].score, 85);
  assert.equal(best[1].seconds, cellSeconds(grids, 'B', 3), 'the 90 beats the 40');
  assert.equal(best[2], null, 'a fact nobody found stays unfound');
});

test('nonsense in the answer is dropped, not trusted', () => {
  const { grids } = planGrids(scanTimes(600));
  const best = mergeScan([[
    { fact: 1, grid: 'Q', cell: 3, score: 99 },   // a grid we never sent
    { fact: 1, grid: 'A', cell: 999, score: 99 },  // a cell that does not exist
    { fact: 9, grid: 'A', cell: 1, score: 99 },    // a fact that does not exist
    { fact: 1, grid: 'A', cell: 2, score: 70 },
  ]], grids, 1);
  assert.equal(best[0].seconds, cellSeconds(grids, 'A', 2));
  assert.deepEqual(mergeScan(null, grids, 2), [null, null]);
});

// ---- Pinpointing ----

test('the fine grid is centred on the hit and evenly spread', () => {
  const t = pinTimes(1000, 6000);
  assert.equal(t.length, cellsPer(PIN_GRID));
  assert.equal(t[0], 1000 - PIN_SPAN);
  assert.equal(t.at(-1), 1000 + PIN_SPAN);
});

test('the fine grid never leaves the film', () => {
  const start = pinTimes(3, 6000);
  assert.ok(start.every((x) => x >= 0.5));
  const end = pinTimes(5998, 6000);
  assert.ok(end.every((x) => x <= 6000));
  assert.equal(new Set(end).size, end.length, 'no duplicate frames from clamping');
  assert.deepEqual(pinTimes(NaN, 6000), []);
});

// ---- Asking a human only when it matters ----

test('a confident scan hit needs no look', () => {
  assert.equal(frameVerdict({ source: 'scan', score: 92 }).review, false);
  assert.equal(frameVerdict({ source: 'scan', score: REVIEW_BELOW }).review, false);
});

test('an unsure scan hit is flagged', () => {
  assert.equal(frameVerdict({ source: 'scan', score: REVIEW_BELOW - 1 }).review, true);
  assert.equal(frameVerdict({ source: 'scan', score: null }).review, true);
});

test('the old checker flags only what it could not verify', () => {
  assert.equal(frameVerdict({ source: 'verify', verified: true }).review, false);
  assert.equal(frameVerdict({ source: 'verify', verified: false }).review, true);
});

test('anything that ran without its model is flagged, however it scored', () => {
  assert.equal(frameVerdict({ source: 'scan', score: 99, degraded: true }).review, true);
  assert.equal(frameVerdict({ source: 'verify', verified: true, degraded: true }).review, true);
});

test('a bare guess is always flagged', () => {
  assert.equal(frameVerdict({}).review, true);
  assert.equal(frameVerdict({}).source, 'guess');
});

test('the thresholds are in the right order', () => {
  // Below MIN the scan is not trusted at all; between MIN and REVIEW it is used
  // but flagged; above REVIEW it is used quietly.
  assert.ok(SCAN_MIN_SCORE < REVIEW_BELOW);
  assert.equal(clampScore(150), 100);
  assert.equal(clampScore(-3), 0);
  assert.equal(clampScore('x'), 0);
});

test('no score is not a score of zero', () => {
  // The old checker gives no score; it must not show up as "0% sure".
  assert.equal(frameVerdict({ source: 'verify', verified: false }).score, null);
  assert.equal(frameVerdict({ source: 'scan', score: undefined }).score, null);
  assert.equal(frameVerdict({ source: 'scan', score: 0 }).score, 0, 'but a real zero stays zero');
});
