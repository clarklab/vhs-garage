import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CALLS, ELSEWHERE, PRICING, FRAME_TOKENS, cost, batchEstimate, modelMapHtml,
} from '../../public/scripts/tik/modelmap.js';
import { DEFAULT_MAX_TOKENS } from '../../netlify/functions/lib/ai-providers.mjs';
import { SHEET_SIZE } from '../../public/scripts/tik/sheet.js';

const src = (f) => readFileSync(new URL(`../../netlify/functions/${f}`, import.meta.url), 'utf8');
const byId = (id) => CALLS.find((c) => c.id === id);

// ---- the page describes the code, so the code is the assertion ----
//
// A readme that drifts is worse than no readme: it is confidently wrong. Each
// of these reads the constant the running code actually uses.

test('every documented model is the one the function really defaults to', () => {
  const declared = [
    ['autopilot', 'tik-autopilot-job-background.mjs', 'TIK_AUTOPILOT_MODEL'],
    ['quotes-autopilot', 'tik-autopilot-job-background.mjs', 'TIK_AUTOPILOT_MODEL'],
    ['freeform', 'tik-autopilot-job-background.mjs', 'TIK_AUTOPILOT_MODEL'],
    ['autopilot-sync', 'tik-autopilot.mjs', 'TIK_AUTOPILOT_SYNC_MODEL'],
    ['curate', 'tik-curate-background.mjs', 'TIK_CURATE_MODEL'],
    ['queue', 'tik-queue-background.mjs', 'TIK_QUEUE_MODEL'],
    ['vision', 'tik-vision.mjs', 'TIK_VISION_MODEL'],
  ];
  for (const [id, file, envVar] of declared) {
    const m = src(file).match(new RegExp(`${envVar}\\s*\\|\\|\\s*'([^']+)'`));
    assert.ok(m, `could not find ${envVar} in ${file}`);
    assert.equal(byId(id).model, m[1], `${id}: page says ${byId(id).model}, ${file} uses ${m[1]}`);
  }
});

test('the documented token budgets are the numbers the code sends', () => {
  const queue = src('tik-queue-background.mjs').match(/callModel\([^)]*?,\s*(\d+)\)/);
  assert.ok(queue, 'no explicit budget found in tik-queue-background');
  assert.equal(byId('queue').budget, Number(queue[1]));

  const curate = src('tik-curate-background.mjs').match(/callModel\([^)]*?,\s*(\d+)\)/);
  assert.ok(curate, 'no explicit budget found in tik-curate-background');
  assert.equal(byId('curate').budget, Number(curate[1]));

  // Both autopilot prompts ride the shared default rather than passing their own.
  assert.equal(byId('autopilot').budget, DEFAULT_MAX_TOKENS);
  assert.equal(byId('quotes-autopilot').budget, DEFAULT_MAX_TOKENS);
});

test('the frame-check card matches the sheet the client actually grabs', () => {
  assert.equal(byId('vision').images, SHEET_SIZE);
  assert.match(byId('vision').detail, new RegExp(`${SHEET_SIZE} frames`));
  // Its input estimate should be dominated by those images, not by the prompt.
  assert.ok(byId('vision').inTokens > FRAME_TOKENS * SHEET_SIZE);
  assert.ok(byId('vision').inTokens < FRAME_TOKENS * SHEET_SIZE + 1000);
});

test('every model named anywhere on the page has a price', () => {
  for (const c of [...CALLS, ...ELSEWHERE]) {
    assert.ok(PRICING[c.model], `no price for ${c.model}`);
  }
});

test('the thinking flag matches whether that model supports it', async () => {
  const { supportsThinking } = await import('../../netlify/functions/lib/ai-providers.mjs');
  for (const c of CALLS) {
    assert.equal(c.thinking, supportsThinking(c.model), `${c.id} claims thinking=${c.thinking}`);
  }
});

// ---- the arithmetic ----

test('cost multiplies both directions', () => {
  // 1M in + 1M out on Opus 5 is 5 + 25.
  assert.equal(cost('claude-opus-5', 1e6, 1e6), 30);
  assert.equal(cost('nonsense-model', 1e6, 1e6), null);
});

test('batchEstimate scales runs by what each call is per', () => {
  const est = batchEstimate({ movies: 10, slidesPerMovie: 6 });
  assert.equal(est.lines.find((l) => l.id === 'queue').runs, 1, 'queue runs once per batch');
  assert.equal(est.lines.find((l) => l.id === 'curate').runs, 10, 'curate runs per film');
  assert.equal(est.lines.find((l) => l.id === 'autopilot').runs, 10, 'one set per film');
  assert.equal(est.lines.find((l) => l.id === 'vision').runs, 60, 'one sheet per slide');
});

test('the fallback path is costed at zero — it should almost never run', () => {
  assert.ok(!batchEstimate().lines.some((l) => l.id === 'autopilot-sync'));
});

test('batchEstimate totals its own lines and sorts biggest first', () => {
  const est = batchEstimate();
  const summed = est.lines.reduce((n, l) => n + l.total, 0);
  assert.ok(Math.abs(est.total - summed) < 1e-9);
  for (let i = 1; i < est.lines.length; i++) {
    assert.ok(est.lines[i - 1].total >= est.lines[i].total, 'lines out of order');
  }
});

test('a batch of ten lands in a believable range', () => {
  // Wide bounds on purpose: this guards against a unit slip (cents vs dollars,
  // a missing /1e6), not against the number changing as the code changes.
  const total = batchEstimate({ movies: 10 }).total;
  assert.ok(total > 0.05 && total < 15, `a batch of 10 estimated at $${total}`);
});

test('scaling the batch scales the bill', () => {
  const ten = batchEstimate({ movies: 10 }).total;
  const twenty = batchEstimate({ movies: 20 }).total;
  // Not exactly double: the queue call is once per batch either way.
  assert.ok(twenty > ten * 1.9 && twenty < ten * 2, `10:${ten} 20:${twenty}`);
});

// ---- rendering ----

test('modelMapHtml lists every call site and both outside uses', () => {
  const html = modelMapHtml();
  for (const c of CALLS) {
    assert.ok(html.includes(c.what), `missing card: ${c.what}`);
    assert.ok(html.includes(c.model), `missing model: ${c.model}`);
  }
  for (const e of ELSEWHERE) assert.ok(html.includes(e.what), `missing: ${e.what}`);
});

test('modelMapHtml says which figures are unverified', () => {
  const html = modelMapHtml();
  assert.match(html, /list rates read on \d{4}-\d{2}-\d{2}/);
  assert.match(html, /cannot drift without failing a test/);
});

test('modelMapHtml escapes rather than injects', () => {
  const html = modelMapHtml();
  assert.ok(!html.includes('<script'));
  for (const tag of ['div', 'section', 'table']) {
    const open = (html.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    assert.equal(open, close, `unbalanced <${tag}>`);
  }
});

// ---- the two batch formats are costed apart ----

test('a batch is one format or the other, never both at once', () => {
  // The toggle in batch mode is exclusive, so an estimate that summed both
  // would describe a run nobody can start.
  const trivia = batchEstimate({ movies: 10, format: 'trivia' });
  const quotes = batchEstimate({ movies: 10, format: 'quotes' });
  const ids = (e) => e.lines.map((l) => l.id);
  assert.ok(ids(trivia).includes('autopilot'));
  assert.ok(!ids(trivia).includes('quotes-autopilot'));
  assert.ok(ids(quotes).includes('quotes-autopilot'));
  assert.ok(!ids(quotes).includes('autopilot'));
  // Picking the films is the one call both runs share.
  assert.ok(ids(trivia).includes('queue') && ids(quotes).includes('queue'));
});

test('Quote-a-long pays nothing to the frame checker', () => {
  // Its frames come from matching the line against the subtitle file, which is
  // arithmetic. If this ever starts costing something, the math stopped being
  // the source of truth and the page should say so.
  const quotes = batchEstimate({ movies: 10, format: 'quotes' });
  assert.ok(!quotes.lines.some((l) => l.id === 'vision'));
  assert.ok(!quotes.lines.some((l) => l.id === 'curate'));
});

test('trivia stays the default estimate, so the page reads the same as before', () => {
  assert.equal(batchEstimate({ movies: 10 }).total, batchEstimate({ movies: 10, format: 'trivia' }).total);
});

test('the page shows both bills, not just the trivia one', () => {
  const html = modelMapHtml();
  assert.ok(html.includes('Tape Trivia'));
  assert.ok(html.includes('Quote-a-long'));
  assert.ok(html.includes('Boils the Quote-a-long captions'));
  // And it explains why one of them has no frame-checking line.
  assert.match(html, /subtitle file/i);
});

test('Freeform is costed on its own, not inside a batch', () => {
  // Batch mode writes trivia or quotes; Freeform is a one-off from a prompt,
  // so it must not turn up in either batch bill.
  for (const format of ['trivia', 'quotes']) {
    assert.ok(!batchEstimate({ movies: 10, format }).lines.some((l) => l.id === 'freeform'), format);
  }
  const own = batchEstimate({ movies: 1, format: 'freeform' });
  assert.ok(own.lines.some((l) => l.id === 'freeform'));
  assert.ok(own.total > 0);
});
