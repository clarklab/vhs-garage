// Every place the studio calls a model, what it costs, and why that model.
//
// This is documentation that can be wrong, so it is written as data and checked
// against the real constants in tests: the token budgets here are imported by
// modelmap.test.mjs from the modules that actually send them, and the model IDs
// are checked against the server's allow-list. A number that drifts fails a
// test rather than quietly lying on a page.
//
// Prices are Anthropic list, USD per million tokens, and are the one thing here
// that no test can verify — they are stamped with the date they were read.
//
// Pure — no DOM, no network. Unit-tested under node:test.

export const PRICES_READ_ON = '2026-08-12';

// $/million tokens. Sonnet 5 has introductory pricing running to 2026-08-31;
// the higher standard rate is used here so an estimate never flatters itself.
export const PRICING = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'gemini-2.5-flash': { in: 0.3, out: 2.5 },
  'gemini-2.5-flash-lite': { in: 0.1, out: 0.4 },
};

// A rough image-token count for one frame at the size the checker sends.
// Anthropic bills images at about (w × h) / 750 tokens.
export const FRAME_TOKENS = Math.round((560 * 315) / 750);

// One entry per call site. `budgetKey` names the constant the code actually
// sends, so the test can compare them; `inTokens`/`outTokens` are measured-ish
// estimates for cost maths, not caps.
export const CALLS = [
  {
    id: 'autopilot',
    group: 'Writing a set',
    what: 'Writes the slide captions',
    formats: ['trivia'],
    detail: 'Turns your pasted facts (or its own research) into one caption per slide, plus the title-slide opener and the post copy — hook, film hashtags, soundtrack picks.',
    model: 'claude-opus-5',
    thinking: true,
    budget: 8192,
    budgetKey: 'DEFAULT_MAX_TOKENS',
    inTokens: 3500,
    outTokens: 1400,
    perSlideshow: 1,
    why: 'The captions are the product. This is the one call where a better model shows up directly in what ships.',
  },
  {
    id: 'autopilot-sync',
    group: 'Writing a set',
    what: 'Fallback when the background job never starts',
    detail: 'Same prompt on a 9-second ceiling. Rarely runs — only when the background function fails to pick the job up.',
    model: 'claude-haiku-4-5',
    thinking: false,
    budget: 8192,
    budgetKey: 'DEFAULT_MAX_TOKENS',
    inTokens: 3500,
    outTokens: 1400,
    perSlideshow: 0,
    why: 'Speed over quality: a degraded answer beats a spinner that never resolves.',
  },
  {
    id: 'quotes-autopilot',
    group: 'Writing a set',
    what: 'Boils the Quote-a-long captions',
    detail: 'Reads the top 20 IMDb quotes plus a sample of the film\u2019s subtitle file, boils each pick to the one or two lines that land, and writes the post copy. It does NOT decide the timecodes: those are matched against the full subtitle file afterwards, in code.',
    model: 'claude-opus-5',
    thinking: true,
    budget: 8192,
    budgetKey: 'DEFAULT_MAX_TOKENS',
    // Much heavier input than the trivia prompt: 20 quotes and up to 400
    // subtitle cues ride along as context.
    inTokens: 11000,
    outTokens: 1200,
    perSlideshow: 1,
    formats: ['quotes'],
    why: 'Same call as the trivia writer, same reason: the captions are the product. Its input is roughly three times bigger because the subtitle context travels with it.',
  },
  {
    id: 'curate',
    group: 'Batch mode',
    formats: ['trivia'],
    what: 'Ranks the trivia',
    detail: 'Reads 25 IMDb items by helpful votes and picks the 10 that will actually land on a slide, with a reason for each.',
    model: 'claude-sonnet-5',
    thinking: true,
    budget: 1024,
    inTokens: 4000,
    outTokens: 600,
    perMovie: 1,
    why: 'A ranking task against a written rubric. Sonnet is near-Opus here for a third of the price, and it runs once per film.',
  },
  {
    id: 'queue',
    group: 'Batch mode',
    what: 'Picks the next 10 films',
    detail: 'Reads your post history and view counts, then suggests ten films worth covering that you have not done yet.',
    model: 'claude-sonnet-5',
    thinking: true,
    budget: 1536,
    inTokens: 2000,
    outTokens: 700,
    perBatch: 1,
    why: 'Runs once per batch, so its cost is amortised across ten drafts.',
  },
  {
    id: 'vision',
    group: 'Frame checking',
    formats: ['trivia'],
    what: 'Picks the right frame',
    detail: `Grabs ${6} frames spanning about six minutes of the film and asks which one actually illustrates the caption. Only if all six are rejected does it look again somewhere else.`,
    model: 'claude-sonnet-5',
    thinking: true,
    budget: 2048,
    inTokens: FRAME_TOKENS * 6 + 420,
    outTokens: 120,
    perSlide: 1,
    images: 6,
    why: 'Seeing six frames at once turns guessing into choosing. Images dominate the cost, so the model tier matters less than how many frames it sees.',
  },
];

// Anything outside the studio, listed so the page is honest about being a map
// of the whole site's model use and not just /tik.
export const ELSEWHERE = [
  { what: 'Sleeve scanner (/capture)', model: 'gemini-2.5-flash', why: 'Reads a VHS sleeve photo into fields. Cheap, high volume, not text quality sensitive.' },
  { what: 'YouTube descriptions', model: 'gemini-2.5-flash-lite', why: 'Boilerplate-shaped writing where the cheapest capable model is the right call.' },
];

export const cost = (model, inTok, outTok) => {
  const p = PRICING[model];
  if (!p) return null;
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
};

// What a batch of `movies` films actually costs, walking the same call sites.
// Returns per-line detail so the page shows its work instead of one number.
// A batch is one format or the other — the toggle in batch mode is exclusive —
// so the estimate has to be too. `formats` on a call says which runs it takes
// part in; a call with no `formats` runs in both (picking the films).
//
// The two bills are shaped differently in a way worth seeing: Quote-a-long
// pays more per set to write (the subtitle context rides along) and nothing at
// all to shoot, because its frames come from arithmetic instead of the frame
// checker, which is the largest line in a trivia batch.
export function batchEstimate({ movies = 10, slidesPerMovie = 6, format = 'trivia' } = {}) {
  const lines = CALLS
    .filter((c) => !c.formats || c.formats.includes(format))
    .filter((c) => c.perSlideshow || c.perMovie || c.perBatch || c.perSlide)
    .map((c) => {
      const runs = (c.perBatch || 0)
        + (c.perMovie || 0) * movies
        + (c.perSlideshow || 0) * movies
        + (c.perSlide || 0) * movies * slidesPerMovie;
      const each = cost(c.model, c.inTokens, c.outTokens) || 0;
      return { id: c.id, what: c.what, model: c.model, runs, each, total: runs * each };
    })
    .filter((l) => l.runs > 0)
    .sort((a, b) => b.total - a.total);
  return { movies, slidesPerMovie, format, lines, total: lines.reduce((n, l) => n + l.total, 0) };
}

// ---- rendering ----

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
const money = (n) => (n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `${(n * 100).toFixed(1)}¢` : `${(n * 100).toFixed(2)}¢`);
const TIER = {
  'claude-opus-5': 'bg-amber-400/15 text-amber-300',
  'claude-sonnet-5': 'bg-sky-400/15 text-sky-300',
  'claude-haiku-4-5': 'bg-neutral-700/60 text-neutral-300',
  'gemini-2.5-flash': 'bg-violet-400/15 text-violet-300',
  'gemini-2.5-flash-lite': 'bg-violet-400/10 text-violet-300/80',
};
const chip = (model) => `<span class="rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${TIER[model] || 'bg-neutral-800 text-neutral-300'}">${esc(model)}</span>`;

function callCard(c) {
  const each = cost(c.model, c.inTokens, c.outTokens);
  const per = c.perSlide ? 'per slide' : c.perMovie ? 'per film' : c.perBatch ? 'per batch' : c.perSlideshow ? 'per set' : 'rarely';
  return `
    <div class="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
      <div class="flex flex-wrap items-center gap-2">
        <h4 class="text-sm font-bold tracking-tight text-neutral-100">${esc(c.what)}</h4>
        ${chip(c.model)}
        ${c.thinking ? '<span class="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-400">thinking</span>' : ''}
        ${c.images ? `<span class="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-400">${c.images} images</span>` : ''}
      </div>
      <p class="mt-1.5 text-xs leading-relaxed text-neutral-400">${esc(c.detail)}</p>
      <p class="mt-2 text-[11px] leading-relaxed text-neutral-500"><span class="text-neutral-400">Why this model:</span> ${esc(c.why)}</p>
      <dl class="mt-3 grid grid-cols-3 gap-2 border-t border-neutral-800 pt-2.5 text-[11px]">
        <div><dt class="text-neutral-600">Runs</dt><dd class="font-semibold tabular-nums text-neutral-300">${per}</dd></div>
        <div><dt class="text-neutral-600">Tokens</dt><dd class="font-semibold tabular-nums text-neutral-300">~${c.inTokens.toLocaleString()} in / ${c.outTokens.toLocaleString()} out</dd></div>
        <div><dt class="text-neutral-600">Each</dt><dd class="font-semibold tabular-nums text-neutral-300">${each === null ? '—' : money(each)}</dd></div>
      </dl>
    </div>`;
}

export function modelMapHtml({ movies = 10, slidesPerMovie = 6 } = {}) {
  const groups = [...new Set(CALLS.map((c) => c.group))];
  const est = batchEstimate({ movies, slidesPerMovie });
  const quoteEst = batchEstimate({ movies, slidesPerMovie, format: 'quotes' });

  return `
    <p class="max-w-2xl text-sm leading-relaxed text-neutral-400">
      Every place the studio calls a model, what it is for, and roughly what it costs.
      Token counts are estimates from real runs; budgets are the ceilings the code actually sends.
    </p>

    ${groups.map((g) => `
      <section class="mt-7">
        <h3 class="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">${esc(g)}</h3>
        <div class="mt-3 grid gap-3 lg:grid-cols-2">
          ${CALLS.filter((c) => c.group === g).map(callCard).join('')}
        </div>
      </section>`).join('')}

    <section class="mt-8 rounded-2xl border border-neutral-800 bg-neutral-900 p-5">
      <h3 class="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">
        What a batch of ${movies} costs
      </h3>
      <p class="mt-1 text-[11px] text-neutral-600">Assuming ${slidesPerMovie} slides per film, every draft written and every frame checked.</p>
      <p class="mt-2 text-[11px] font-semibold uppercase tracking-wide text-amber-300/80">Tape Trivia</p>
      <div class="mt-2 overflow-x-auto">
        <table class="w-full min-w-[26rem] text-xs">
          <thead>
            <tr class="text-[10px] uppercase tracking-wide text-neutral-600">
              <th class="py-1 pr-3 text-left font-semibold">Call</th>
              <th class="py-1 pr-3 text-right font-semibold">Runs</th>
              <th class="py-1 pr-3 text-right font-semibold">Each</th>
              <th class="py-1 text-right font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            ${est.lines.map((l) => `
              <tr>
                <td class="py-1 pr-3 text-neutral-300">${esc(l.what)} <span class="text-neutral-600">${esc(l.model.replace('claude-', ''))}</span></td>
                <td class="py-1 pr-3 text-right tabular-nums text-neutral-400">${l.runs}</td>
                <td class="py-1 pr-3 text-right tabular-nums text-neutral-500">${money(l.each)}</td>
                <td class="py-1 text-right font-semibold tabular-nums text-neutral-100">${money(l.total)}</td>
              </tr>`).join('')}
            <tr class="border-t border-neutral-800">
              <td class="py-1.5 pr-3 font-bold text-neutral-200">Whole batch</td>
              <td></td><td></td>
              <td class="py-1.5 text-right font-bold tabular-nums text-amber-300">${money(est.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="mt-5 text-[11px] font-semibold uppercase tracking-wide text-rose-300/80">Quote-a-long</p>
      <div class="mt-2 overflow-x-auto">
        <table class="w-full min-w-[26rem] text-xs">
          <thead>
            <tr class="text-[10px] uppercase tracking-wide text-neutral-600">
              <th class="py-1 pr-3 text-left font-semibold">Call</th>
              <th class="py-1 pr-3 text-right font-semibold">Runs</th>
              <th class="py-1 pr-3 text-right font-semibold">Each</th>
              <th class="py-1 text-right font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            ${quoteEst.lines.map((l) => `
              <tr>
                <td class="py-1 pr-3 text-neutral-300">${esc(l.what)} <span class="text-neutral-600">${esc(l.model.replace('claude-', ''))}</span></td>
                <td class="py-1 pr-3 text-right tabular-nums text-neutral-400">${l.runs}</td>
                <td class="py-1 pr-3 text-right tabular-nums text-neutral-500">${money(l.each)}</td>
                <td class="py-1 text-right font-semibold tabular-nums text-neutral-100">${money(l.total)}</td>
              </tr>`).join('')}
            <tr class="border-t border-neutral-800">
              <td class="py-1.5 pr-3 font-bold text-neutral-200">Whole batch</td>
              <td></td><td></td>
              <td class="py-1.5 text-right font-bold tabular-nums text-rose-300">${money(quoteEst.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="mt-3 text-[11px] leading-relaxed text-neutral-600">
        In a Tape Trivia batch, frame checking is the largest line, and it is images rather than intelligence: six frames cost more to send than the caption costs to write.
        Quote-a-long does not appear on that line at all — its frames come from matching the quote against the film's subtitle file, which is arithmetic and costs nothing.
        It pays for that up front instead, in a heavier writing prompt that carries the subtitle context.
      </p>
    </section>

    <section class="mt-8">
      <h3 class="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">Elsewhere on the site</h3>
      <div class="mt-3 flex flex-col gap-2">
        ${ELSEWHERE.map((e) => `
          <div class="flex flex-wrap items-baseline gap-2 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2">
            <span class="text-xs font-semibold text-neutral-200">${esc(e.what)}</span>
            ${chip(e.model)}
            <span class="text-[11px] text-neutral-500">${esc(e.why)}</span>
          </div>`).join('')}
      </div>
    </section>

    <p class="mt-6 text-[11px] leading-relaxed text-neutral-600">
      Prices are Anthropic and Google list rates read on ${esc(PRICES_READ_ON)} and are the only figures here nothing checks —
      the token budgets are asserted against the constants the code sends, so those cannot drift without failing a test.
      Sonnet 5 has introductory pricing through 2026-08-31; the standard rate is used above so an estimate never flatters itself.
    </p>`;
}
