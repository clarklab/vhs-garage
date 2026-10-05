import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScanPrompt, buildPinpointPrompt, normalizeScan, normalizePinpoint, MAX_FACTS, ISSUES,
} from '../../netlify/functions/lib/locate.mjs';
import { planGrids, scanTimes } from '../../public/scripts/tik/scan.js';

const facts = [
  { kind: 'title', caption: 'The Thing (1982)' },
  { kind: 'trivia', caption: 'The blood-test scene used real petri dishes heated with a wire.', grab: 'men tied to chairs, a man holding a hot wire over a petri dish' },
  { kind: 'trivia', caption: 'Rob Bottin worked so hard on the effects he was hospitalised.', grab: '' },
];
const { grids } = planGrids(scanTimes(109 * 60));
const chunk = grids.slice(0, 3);

// ---- The prompt says the things the answer depends on ----

test('the scan prompt numbers every fact and names every grid it was sent', () => {
  const p = buildScanPrompt({ facts, grids: chunk, durationSeconds: 109 * 60 });
  assert.match(p, /^1\. \[TITLE CARD\]/m);
  assert.match(p, /^2\. Fact: "The blood-test scene/m);
  assert.match(p, /Shot to find: men tied to chairs/);
  assert.match(p, /^3\. Fact: "Rob Bottin/m);
  assert.match(p, /\(A, B, C\)/);
});

test('the scan prompt says cells count from 1, in reading order', () => {
  // The client maps cell N to times[N-1]; the prompt must say the same thing.
  const p = buildScanPrompt({ facts, grids: chunk });
  assert.match(p, /numbered from 1, left to right, then top to bottom/);
});

test('both prompts forbid identifying people by face', () => {
  for (const p of [buildScanPrompt({ facts, grids: chunk }), buildPinpointPrompt({ fact: facts[1] })]) {
    assert.match(p, /cannot identify real people from their faces/);
    assert.match(p, /Match on what is VISIBLE/);
  }
});

test('the scan prompt admits it only sees part of the film', () => {
  // Without this, every call confidently "finds" every fact in its own third.
  const p = buildScanPrompt({ facts, grids: chunk, durationSeconds: 109 * 60 });
  assert.match(p, /only part of the film/);
  assert.match(p, /"cell": null/);
  assert.match(p, /covers 0:01 to/);
});

test('an unnamed hint is left out rather than printed empty', () => {
  const p = buildScanPrompt({ facts, grids: chunk });
  const fact3 = p.slice(p.indexOf('3. Fact:'));
  assert.doesNotMatch(fact3.split('\n')[1] || '', /Shot to find:\s*$/);
});

test('a runaway fact list is capped', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ caption: `fact ${i}` }));
  const p = buildScanPrompt({ facts: many, grids: chunk });
  assert.match(p, new RegExp(`^${MAX_FACTS}\\. Fact`, 'm'));
  assert.doesNotMatch(p, new RegExp(`^${MAX_FACTS + 1}\\. Fact`, 'm'));
});

test('the pinpoint prompt states the spacing and the start of the run', () => {
  const p = buildPinpointPrompt({ fact: facts[1], cellCount: 12, firstSeconds: 3725, stepSeconds: 2.5 });
  assert.match(p, /12 consecutive frames/);
  assert.match(p, /2\.5 seconds apart/);
  assert.match(p, /starting at 1:02:05/);
  assert.match(p, /prefer the sharpest/);
});

// ---- Only answers that can be acted on survive ----

test('a clean scan answer comes through intact', () => {
  const out = normalizeScan({ matches: [
    { fact: 1, grid: 'A', cell: 3, score: 95, why: 'title logo' },
    { fact: 2, grid: 'c', cell: 40, score: 72, why: 'petri dish' },
    { fact: 3, grid: null, cell: null, score: 0, why: 'no scene named' },
  ] }, { factCount: 3, grids: chunk });
  assert.deepEqual(out.map((r) => [r.fact, r.grid, r.cell, r.score]), [
    [1, 'A', 3, 95], [2, 'C', 40, 72], [3, null, null, 0],
  ]);
});

test('a cell outside the grid it names is no match at all', () => {
  const out = normalizeScan({ matches: [
    { fact: 1, grid: 'A', cell: 49, score: 99 },
    { fact: 2, grid: 'Z', cell: 2, score: 99 },
    { fact: 3, grid: 'B', cell: 0, score: 99 },
  ] }, { factCount: 3, grids: chunk });
  assert.ok(out.every((r) => r.cell === null && r.score === 0));
});

test('facts that do not exist, and repeats, are dropped', () => {
  const out = normalizeScan({ matches: [
    { fact: 0, grid: 'A', cell: 1, score: 99 },
    { fact: 4, grid: 'A', cell: 1, score: 99 },
    { fact: 2, grid: 'A', cell: 1, score: 80 },
    { fact: 2, grid: 'A', cell: 9, score: 99 },
  ] }, { factCount: 3, grids: chunk });
  assert.deepEqual(out.map((r) => [r.fact, r.cell]), [[2, 1]], 'first answer for a fact wins');
});

test('a bare array answer is accepted too', () => {
  const out = normalizeScan([{ fact: 1, grid: 'A', cell: 1, score: 50 }], { factCount: 1, grids: chunk });
  assert.equal(out.length, 1);
  assert.deepEqual(normalizeScan(null, { factCount: 1, grids: chunk }), []);
});

test('a pinpoint answer is bounded to the frames it was shown', () => {
  assert.deepEqual(normalizePinpoint({ cell: 7, score: 88, issue: 'ok', why: 'sharp' }, 12),
    { cell: 7, score: 88, issue: 'ok', why: 'sharp' });
  const out = normalizePinpoint({ cell: 13, score: 99 }, 12);
  assert.equal(out.cell, null);
  assert.equal(out.score, 0);
  assert.equal(out.issue, 'wrong-scene');
});

test('an invented issue word is replaced with one we act on', () => {
  assert.equal(normalizePinpoint({ cell: 2, score: 70, issue: 'vibes' }, 12).issue, 'ok');
  assert.ok(ISSUES.includes('credits'));
});

// ---- The function itself, with a stand-in for the model ----

import { runLocate } from '../../netlify/functions/tik-locate-background.mjs';

const grid = (label, n = 48, t0 = 0) => ({ label, base64: 'QUJD', times: Array.from({ length: n }, (_, i) => t0 + i * 6) });

test('a scan sends every grid, labelled, and maps the answer', async () => {
  let sent = null;
  const call = async (prompt, items, model) => {
    sent = { prompt, items, model };
    return JSON.stringify({ matches: [{ fact: 1, grid: 'B', cell: 4, score: 77, why: 'x' }] });
  };
  const out = await runLocate({ mode: 'scan', grids: [grid('A'), grid('B', 48, 288)], facts: [{ caption: 'a fact' }] }, { call, model: 'm' });
  assert.deepEqual(sent.items.map((i) => i.label), ['Grid A', 'Grid B']);
  assert.equal(sent.model, 'm');
  assert.match(sent.prompt, /1\. Fact: "a fact"/);
  assert.equal(out.ok, true);
  assert.deepEqual(out.matches.map((m) => [m.grid, m.cell, m.score]), [['B', 4, 77]]);
});

test('a pinpoint sends one grid and states its spacing', async () => {
  let sent = null;
  const call = async (prompt, items) => { sent = { prompt, items }; return '{"cell":3,"score":80,"issue":"ok"}'; };
  const g = { label: 'P', base64: 'QUJD', times: [100, 102.5, 105, 107.5] };
  const out = await runLocate({ mode: 'pinpoint', grids: [g, grid('X')], facts: [{ caption: 'f' }] }, { call });
  assert.equal(sent.items.length, 1, 'only the first grid is a pinpoint');
  assert.match(sent.prompt, /2\.5 seconds apart/);
  assert.deepEqual([out.pick.cell, out.pick.score], [3, 80]);
});

test('a model answer wrapped in prose or fences still parses', async () => {
  const call = async () => 'Here you go:\n```json\n{"matches":[{"fact":1,"grid":"A","cell":2,"score":60}]}\n```';
  const out = await runLocate({ mode: 'scan', grids: [grid('A')], facts: [{ caption: 'f' }] }, { call });
  assert.equal(out.matches[0].cell, 2);
});

test('nothing to look at, or nothing to find, is refused before any model call', async () => {
  let called = false;
  const call = async () => { called = true; return '{}'; };
  await assert.rejects(runLocate({ mode: 'scan', grids: [], facts: [{ caption: 'f' }] }, { call }), /No grids/);
  await assert.rejects(runLocate({ mode: 'scan', grids: [grid('A')], facts: [] }, { call }), /No facts/);
  await assert.rejects(runLocate({ mode: 'scan', grids: [{ label: 'A', base64: 'QUJD', times: [] }], facts: [{ caption: 'f' }] }, { call }), /No grids/);
  assert.equal(called, false);
});

test('an oversized grid is refused rather than sent', async () => {
  const huge = { label: 'A', base64: 'A'.repeat(3 * 1024 * 1024), times: [1, 2] };
  await assert.rejects(runLocate({ mode: 'scan', grids: [huge], facts: [{ caption: 'f' }] }, { call: async () => '{}' }), /too large/);
});

test('a model outage surfaces as an error the job records', async () => {
  const call = async () => { throw new Error('Anthropic vision 529: overloaded'); };
  await assert.rejects(runLocate({ mode: 'scan', grids: [grid('A')], facts: [{ caption: 'f' }] }, { call }), /529/);
});

test('the default model is Haiku, overridable by env', async () => {
  let used = null;
  await runLocate({ mode: 'scan', grids: [grid('A')], facts: [{ caption: 'f' }] }, { call: async (p, i, m) => { used = m; return '{"matches":[]}'; } });
  assert.equal(used, process.env.TIK_LOCATE_MODEL || 'claude-haiku-4-5');
});
