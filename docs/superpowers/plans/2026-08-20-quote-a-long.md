# Quote-a-long Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Quote-a-long (`format: 'quotes'`) to `/tik`: IMDb-ranked quotes boiled by Autopilot into 8 captions, matched to English OpenSubtitles cues, thumbs grabbed at the first quarter of each span, with a stamped title card — single maker and Batch.

**Architecture:** Fourth format next to trivia. Reuse `#pane-trivia`, compose, library, Shoot file matching. New IMDb `quotes` action, new `tik-subtitles` function (env `OpenSubtitles`), Autopilot `kind: 'quotes'` that sees quotes + SRT in one job. Shoot seeks and grabs with no `tik-vision`.

**Tech Stack:** Existing `/tik` stack — vanilla ES modules, Netlify Functions + Blobs, GraphQL IMDb, OpenSubtitles REST v1, `node:test`. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-20-quote-a-long-design.md`

---

## File structure

Create:

```
netlify/functions/lib/srt.mjs
netlify/functions/lib/opensubtitles.mjs
netlify/functions/tik-subtitles.mjs
test/tik/srt.test.mjs
test/tik/opensubtitles.test.mjs
test/tik/quotes.test.mjs
```

Modify:

```
public/scripts/tik/project.js
public/scripts/tik/caption.js
public/scripts/tik/timecode.js
public/scripts/tik/compose.js
public/scripts/tik/autopilot.js
public/scripts/tik/app.js
public/scripts/tik/batch.js
public/scripts/tik/shoot.js
public/scripts/tik/vision.js
src/pages/tik.astro
netlify/functions/lib/imdb.mjs
netlify/functions/tik-imdb.mjs
netlify/functions/lib/autopilot.mjs
netlify/functions/tik-autopilot.mjs
netlify/functions/tik-autopilot-job-background.mjs
netlify/functions/lib/queue.mjs
netlify/functions/tik-queue.mjs
netlify/functions/tik-queue-background.mjs
test/tik/project.test.mjs
test/tik/caption.test.mjs
test/tik/timecode.test.mjs
test/tik/imdb.test.mjs
test/tik/autopilot.test.mjs
test/tik/queue.test.mjs
test/tik/movielist.test.mjs
```

Conventions: `node --test 'test/tik/**/*.test.mjs'`. Pure modules only in unit tests. Env `OpenSubtitles` is server-only. Do not scrape `www.imdb.com`. Do not call `tik-vision` for quotes.

---

### Task 1: Format registry

**Files:**
- Modify: `public/scripts/tik/project.js`
- Modify: `test/tik/project.test.mjs`
- Modify: `test/tik/movielist.test.mjs`

- [ ] **Step 1: Write failing tests**

Add to `test/tik/project.test.mjs`:

```js
test('quotes post defaults use the load-bearing quotes title', () => {
  const d = defaultPostFields('quotes', 'Terminator 2 (1991)');
  assert.equal(d.title, 'Terminator 2 (1991) — movie quotes');
  assert.match(d.description, /follow VHS Garage/i);
  const tags = d.description.match(/#\w+/g) || [];
  assert.ok(tags.length <= 5, `expected ≤5 hashtags, got ${tags.length}`);
  const empty = defaultPostFields('quotes', '');
  assert.match(empty.title, /movie quotes/);
  assert.doesNotMatch(empty.title, /trivia/i);
});

test('quotes is a registered format with chrome', () => {
  assert.equal(FORMATS.quotes.key, 'quotes');
  assert.equal(FORMATS.quotes.label, 'Quote-a-long');
  assert.equal(formatOf({ format: 'quotes' }).label, 'Quote-a-long');
  const p = makeProject({ id: 'q', format: 'quotes', now: 1 });
  assert.equal(p.format, 'quotes');
});
```

Add to `test/tik/movielist.test.mjs` inside `pickOutro tails the follow line per format`:

```js
assert.match(pickOutro('quotes', 0), /more movie quotes/);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/tik/project.test.mjs test/tik/movielist.test.mjs`

Expected: FAIL — `FORMATS.quotes` undefined / title does not match.

- [ ] **Step 3: Implement**

In `public/scripts/tik/project.js` `FORMATS`, add after `trivia`:

```js
  quotes: {
    key: 'quotes',
    label: 'Quote-a-long',
    tagline: 'Famous lines over the frames they were spoken on',
    icon: 'format_quote',
    accent: 'rose',
    chip: 'bg-rose-400/15 text-rose-300',
    editorHint: 'Click a slide’s preview to re-grab its frame, or paste/drop/pick a custom image while it’s selected. Drag to reorder.',
  },
```

In `defaultPostFields`, after the `guys` block and **before** the trivia default, add:

```js
  if (format === 'quotes') {
    const movie = name;
    const houseSet = houseSetByKey(houseSetKey) || pickHouseSet(projectId || movie);
    const hashtags = buildHashtags({ filmTags: meta?.filmTags || [], houseSet });
    return {
      title: movie ? `${movie} — movie quotes` : 'Movie quotes',
      description: buildDescription({ hook: meta?.hook || '', movie, hashtags }),
      hashtags,
      hashtagSet: houseSet.key,
    };
  }
```

Add to `OUTRO_MORE`:

```js
  quotes: 'more movie quotes',
```

- [ ] **Step 4: Run tests**

Run: `node --test test/tik/project.test.mjs test/tik/movielist.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add public/scripts/tik/project.js test/tik/project.test.mjs test/tik/movielist.test.mjs
git commit -m "feat(tik): register Quote-a-long format and post title"
```

---

### Task 2: fontScaleForQuote + seekTime

**Files:**
- Modify: `public/scripts/tik/caption.js`
- Modify: `public/scripts/tik/timecode.js`
- Modify: `test/tik/caption.test.mjs`
- Modify: `test/tik/timecode.test.mjs`

- [ ] **Step 1: Write failing tests**

Add to `test/tik/caption.test.mjs`:

```js
import { wrapLines, fitFontSize, fontScaleForQuote } from '../../public/scripts/tik/caption.js';

test('fontScaleForQuote grows short lines and shrinks long ones', () => {
  assert.equal(fontScaleForQuote("I'll be back."), 1.35);
  assert.equal(fontScaleForQuote('Come with me if you want to live.'), 1.35);
  assert.equal(fontScaleForQuote('x'.repeat(50)), 1.15);
  assert.equal(fontScaleForQuote('x'.repeat(100)), 1.0);
  assert.equal(fontScaleForQuote('x'.repeat(200)), 0.85);
  assert.equal(fontScaleForQuote(''), 1);
  assert.equal(fontScaleForQuote(null), 1);
});
```

Add to `test/tik/timecode.test.mjs`:

```js
import { formatTimecode, frameStep, seekTime } from '../../public/scripts/tik/timecode.js';

test('seekTime is the first quarter of the cue span', () => {
  assert.equal(seekTime(12, 16), 13);
  assert.equal(seekTime(10, 10), 10);
  assert.equal(seekTime(0, 4), 1);
  assert.ok(Math.abs(seekTime(1.2, 5.2) - 2.2) < 1e-9);
});

test('seekTime spans several cues via first start and last end', () => {
  assert.equal(seekTime(8, 20), 11);
});

test('seekTime survives junk', () => {
  assert.equal(seekTime(null, 10), 0);
  assert.equal(seekTime(5, 'nope'), 5);
  assert.equal(seekTime(-2, 2), 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/tik/caption.test.mjs test/tik/timecode.test.mjs`

Expected: FAIL — `fontScaleForQuote` / `seekTime` not exported.

- [ ] **Step 3: Implement**

Add to `public/scripts/tik/caption.js`:

```js
export function fontScaleForQuote(text) {
  const n = String(text ?? '').trim().length;
  if (!n) return 1;
  if (n <= 40) return 1.35;
  if (n <= 80) return 1.15;
  if (n <= 140) return 1.0;
  return 0.85;
}
```

Add to `public/scripts/tik/timecode.js`:

```js
export function seekTime(start, end) {
  const a = Number(start);
  const b = Number(end);
  const from = Number.isFinite(a) ? Math.max(0, a) : 0;
  const to = Number.isFinite(b) ? Math.max(from, b) : from;
  return from + 0.25 * (to - from);
}
```

Fix the mid-length test if the 50-char string is the only assertion that matters; delete the unused `mid` variable from the test.

- [ ] **Step 4: Run tests**

Run: `node --test test/tik/caption.test.mjs test/tik/timecode.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add public/scripts/tik/caption.js public/scripts/tik/timecode.js test/tik/caption.test.mjs test/tik/timecode.test.mjs
git commit -m "feat(tik): quote caption scale and quarter-span seek"
```

---

### Task 3: SRT parse, quote text normalize, cue match

**Files:**
- Create: `netlify/functions/lib/srt.mjs`
- Create: `test/tik/srt.test.mjs`

- [ ] **Step 1: Write the failing test file**

Create `test/tik/srt.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSrt, srtTimeToSeconds, normalizeQuoteText, matchQuoteToCues } from '../../netlify/functions/lib/srt.mjs';
import { seekTime } from '../../public/scripts/tik/timecode.js';

const SAMPLE = `1
00:01:12,000 --> 00:01:16,000
I'll be back.

2
00:01:16,500 --> 00:01:19,000
Come with me if you want to live.

3
00:02:00,000 --> 00:02:02,000
Sarah Connor?

4
00:02:02,200 --> 00:02:05,000
No, it's just me.
`;

test('srtTimeToSeconds parses the SRT clock', () => {
  assert.equal(srtTimeToSeconds('00:01:12,000'), 72);
  assert.equal(srtTimeToSeconds('01:00:00,500'), 3600.5);
  assert.equal(srtTimeToSeconds('nope'), null);
});

test('parseSrt returns cues in seconds', () => {
  const cues = parseSrt(SAMPLE);
  assert.equal(cues.length, 4);
  assert.equal(cues[0].start, 72);
  assert.equal(cues[0].end, 76);
  assert.equal(cues[0].text, "I'll be back.");
});

test('parseSrt returns [] for empty or junk', () => {
  assert.deepEqual(parseSrt(''), []);
  assert.deepEqual(parseSrt(null), []);
  assert.deepEqual(parseSrt('not an srt'), []);
});

test('normalizeQuoteText strips speakers, quotes, and punctuation', () => {
  assert.equal(normalizeQuoteText(`[Terminator]: I'll be back.`), 'ill be back');
  assert.equal(normalizeQuoteText(`The Terminator: "I'll be back."`), 'ill be back');
  assert.equal(normalizeQuoteText("I'll be back."), 'ill be back');
  assert.equal(normalizeQuoteText('  '), '');
});

test('matchQuoteToCues finds a line ignoring IMDb formatting', () => {
  const cues = parseSrt(SAMPLE);
  const hit = matchQuoteToCues("The Terminator: I'll be back.", cues);
  assert.ok(hit);
  assert.equal(hit.start, 72);
  assert.equal(hit.end, 76);
  assert.equal(seekTime(hit.start, hit.end), 73);
});

test('matchQuoteToCues spans two adjacent cues when the quote covers both', () => {
  const cues = parseSrt(SAMPLE);
  const hit = matchQuoteToCues('Sarah Connor? No, it\'s just me.', cues);
  assert.ok(hit);
  assert.equal(hit.start, 120);
  assert.equal(hit.end, 125);
});

test('matchQuoteToCues returns null when nothing is close', () => {
  const cues = parseSrt(SAMPLE);
  assert.equal(matchQuoteToCues('Get to the chopper', cues), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tik/srt.test.mjs`

Expected: FAIL — cannot find module `srt.mjs`.

- [ ] **Step 3: Implement `netlify/functions/lib/srt.mjs`**

```js
const CLOCK = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/;

export function srtTimeToSeconds(raw) {
  const m = String(raw || '').trim().match(CLOCK);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  const ms = Number(m[4].padEnd(3, '0'));
  if (![hh, mm, ss, ms].every(Number.isFinite)) return null;
  return hh * 3600 + mm * 60 + ss + ms / 1000;
}

export function parseSrt(input) {
  const text = String(input || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.trim()) return [];
  const blocks = text.split(/\n\s*\n/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter((l, i, arr) => !(i === 0 && /^\d+$/.test(l) && arr.length > 1));
    const arrow = lines.find((l) => /-->/.test(l));
    if (!arrow) continue;
    const [left, right] = arrow.split(/-->/).map((s) => s.trim());
    const start = srtTimeToSeconds(left.split(/\s+/)[0]);
    const end = srtTimeToSeconds(right.split(/\s+/)[0]);
    if (start == null || end == null) continue;
    const body = lines.filter((l) => l !== arrow).join(' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    out.push({ start, end, text: body });
  }
  return out;
}

export function normalizeQuoteText(raw) {
  let s = String(raw || '');
  s = s.replace(/^\s*\[[^\]]+\]\s*:?\s*/gm, '');
  s = s.replace(/^\s*[A-Z][A-Za-z0-9 .'\-]{1,40}:\s*/gm, '');
  s = s.replace(/["“”']/g, '');
  s = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

function tokens(s) {
  return normalizeQuoteText(s).split(' ').filter((w) => w.length > 1);
}

export function matchQuoteToCues(quote, cues) {
  const list = Array.isArray(cues) ? cues : [];
  const want = tokens(quote);
  if (want.length < 2 || !list.length) return null;

  const scored = list.map((cue, i) => {
    const have = new Set(tokens(cue.text));
    const hits = want.filter((w) => have.has(w)).length;
    return { i, cue, ratio: hits / want.length };
  });
  const best = scored.reduce((a, b) => (b.ratio > a.ratio ? b : a), scored[0]);
  if (best.ratio < 0.6) return null;

  let start = best.cue.start;
  let end = best.cue.end;
  const leftover = new Set(want);
  tokens(best.cue.text).forEach((w) => leftover.delete(w));
  if (leftover.size) {
    const next = list[best.i + 1];
    if (next) {
      const nextHave = new Set(tokens(next.text));
      const extra = [...leftover].filter((w) => nextHave.has(w));
      if (extra.length / leftover.size >= 0.5) {
        end = next.end;
      }
    }
  }
  return { start, end, text: best.cue.text, index: best.i };
}
```

If the first-line index strip is too aggressive, keep the classic parser: drop a leading numeric index line, require an arrow line, join the rest as text.

- [ ] **Step 4: Run tests**

Run: `node --test test/tik/srt.test.mjs`

Expected: PASS. If the two-cue span test is flaky, tighten `matchQuoteToCues` until it passes — do not delete the test.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/lib/srt.mjs test/tik/srt.test.mjs
git commit -m "feat(tik): parse SRT cues and fuzzy-match quotes"
```

---

### Task 4: IMDb quotes

**Files:**
- Modify: `netlify/functions/lib/imdb.mjs`
- Modify: `netlify/functions/tik-imdb.mjs`
- Modify: `test/tik/imdb.test.mjs`

- [ ] **Step 1: Write failing tests**

Add to `test/tik/imdb.test.mjs`:

```js
import { triviaScore, normalizeTrivia, rankTrivia, normalizeTitle, quotePlainText, normalizeQuote, rankQuotes } from '../../netlify/functions/lib/imdb.mjs';

test('quotePlainText prefers plainText then joins character lines', () => {
  assert.equal(quotePlainText({ text: { plainText: "I'll be back." } }), "I'll be back.");
  assert.equal(quotePlainText({
    lines: [
      { characters: [{ displayName: 'Terminator' }], text: "I'll be back." },
    ],
  }), "Terminator: I'll be back.");
  assert.equal(quotePlainText({ text: { plainText: '  ' } }), '');
  assert.equal(quotePlainText(null), '');
});

test('normalizeQuote and rankQuotes reuse trivia scoring', () => {
  const a = normalizeQuote({
    id: 'q1', text: { plainText: "I'll be back." },
    interestScore: { usersInterested: 900, usersVoted: 910 }, isSpoiler: false,
  });
  const b = normalizeQuote({
    id: 'q2', text: { plainText: 'Get out.' },
    interestScore: { usersInterested: 10, usersVoted: 12 }, isSpoiler: true,
  });
  assert.equal(a.text, "I'll be back.");
  assert.equal(a.score, 890);
  const ranked = rankQuotes([b, a]);
  assert.deepEqual(ranked.map((x) => x.id), ['q1', 'q2']);
  assert.deepEqual(rankQuotes([b, a], { includeSpoilers: false }).map((x) => x.id), ['q1']);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/tik/imdb.test.mjs`

Expected: FAIL — `quotePlainText` not exported.

- [ ] **Step 3: Implement GraphQL + helpers**

In `netlify/functions/lib/imdb.mjs`, add:

```js
const QUOTES_QUERY = `query TikQuotes($id: ID!, $first: Int!, $after: ID) {
  title(id: $id) {
    id
    titleText { text }
    releaseYear { year }
    runtime { seconds }
    ratingsSummary { aggregateRating voteCount }
    quotes(first: $first, after: $after) {
      total
      pageInfo { hasNextPage endCursor }
      edges { node {
        id
        text { plainText }
        lines { text characters { displayName } }
        interestScore { usersInterested usersVoted }
        isSpoiler
      } }
    }
  }
}`;

export function quotePlainText(node) {
  const direct = String(node?.text?.plainText || '').replace(/\s+/g, ' ').trim();
  if (direct) return direct;
  const lines = Array.isArray(node?.lines) ? node.lines : [];
  const parts = [];
  for (const ln of lines) {
    const text = String(typeof ln?.text === 'string' ? ln.text : ln?.text?.plainText || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const who = String(ln?.characters?.[0]?.displayName || '').trim();
    parts.push(who ? `${who}: ${text}` : text);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function normalizeQuote(node) {
  const text = quotePlainText(node);
  if (!text) return null;
  const up = Math.max(0, Math.round(Number(node?.interestScore?.usersInterested) || 0));
  const total = Math.max(up, Math.round(Number(node?.interestScore?.usersVoted) || 0));
  return {
    id: String(node?.id || ''),
    text,
    up,
    down: total - up,
    score: up - (total - up),
    spoiler: node?.isSpoiler === true,
  };
}

export function rankQuotes(nodes, opts) {
  return rankTrivia((Array.isArray(nodes) ? nodes : []).map((n) => (
    n && typeof n.text === 'string' ? n : normalizeQuote(n)
  )), opts);
}

export async function fetchQuotes(imdbId, { signal, includeSpoilers = true } = {}) {
  if (!IMDB_ID_RE.test(String(imdbId || ''))) throw new Error('Invalid IMDb id');
  const nodes = [];
  let after = null;
  let pages = 0;
  let movie = null;
  let total = 0;
  let hasNextPage = false;

  do {
    const data = await imdbGraphQL(QUOTES_QUERY, { id: imdbId, first: PAGE_SIZE, after }, signal);
    const title = data?.title;
    if (!title) throw new Error('IMDb returned no title');
    if (!movie) {
      movie = normalizeTitle(title) || { id: imdbId, title: '', year: null, runtimeSeconds: null, rating: null, votes: null, poster: null };
    }
    const conn = title.quotes || {};
    total = Number(conn.total) || total;
    for (const edge of conn.edges || []) nodes.push(edge?.node);
    after = conn.pageInfo?.endCursor || null;
    hasNextPage = conn.pageInfo?.hasNextPage === true && !!after;
    pages += 1;
  } while (hasNextPage && pages < MAX_PAGES);

  return {
    movie,
    quotes: rankQuotes(nodes.map(normalizeQuote), { includeSpoilers }),
    total,
    truncated: hasNextPage,
  };
}
```

`rankQuotes` maps first because `rankTrivia` already accepts normalized `{ text }` items. If passing already-normalized objects, skip `normalizeQuote`. Match trivia: `rankTrivia(nodes.map(normalizeQuote), opts)` is enough if `normalizeQuote` returns the flat shape. **Do not** double-map. Use:

```js
export function rankQuotes(nodes, opts) {
  return rankTrivia(nodes, opts);
}
```

and in `fetchQuotes` call `rankQuotes(nodes.map(normalizeQuote), { includeSpoilers })`.

If GraphQL rejects `lines` or `quotes`, drop the unknown field from the query until it succeeds. Keep the normalized shape `{ id, text, up, down, score, spoiler }`. Never scrape HTML.

In `tik-imdb.mjs` import `fetchQuotes` and add an `action === 'quotes'` branch copied from trivia, with cache key `` `quotes:${target.id}:${includeSpoilers ? 'all' : 'nospoil'}` ``.

- [ ] **Step 4: Run tests**

Run: `node --test test/tik/imdb.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/lib/imdb.mjs netlify/functions/tik-imdb.mjs test/tik/imdb.test.mjs
git commit -m "feat(tik): fetch and rank IMDb quotes"
```

---

### Task 5: OpenSubtitles function

**Files:**
- Create: `netlify/functions/lib/opensubtitles.mjs`
- Create: `netlify/functions/tik-subtitles.mjs`
- Create: `test/tik/opensubtitles.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `test/tik/opensubtitles.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numericImdbId, pickBestSubtitle } from '../../netlify/functions/lib/opensubtitles.mjs';

test('numericImdbId strips the tt prefix', () => {
  assert.equal(numericImdbId('tt0103064'), '103064');
  assert.equal(numericImdbId('tt0120338'), '120338');
  assert.equal(numericImdbId('0103064'), '103064');
  assert.equal(numericImdbId(''), null);
  assert.equal(numericImdbId('nope'), null);
});

const file = (fileId, name = 'movie.srt') => ({ file_id: fileId, file_name: name });
const hit = (attrs) => ({ attributes: { files: [file(1, 'a.srt')], ...attrs } });

test('pickBestSubtitle prefers English, human, trusted, downloaded, srt', () => {
  const machine = hit({ language: 'en', ai_translated: true, machine_translated: true, from_trusted: false, download_count: 99999, files: [file(9, 'x.srt')] });
  const french = hit({ language: 'fr', ai_translated: false, machine_translated: false, from_trusted: true, download_count: 5000, files: [file(8, 'x.srt')] });
  const zip = hit({ language: 'en', ai_translated: false, machine_translated: false, from_trusted: true, download_count: 4000, files: [file(7, 'x.zip')] });
  const good = hit({ language: 'en', ai_translated: false, machine_translated: false, from_trusted: true, download_count: 1200, files: [file(3, 't2.srt')] });
  const ok = hit({ language: 'en', ai_translated: false, machine_translated: false, from_trusted: false, download_count: 8000, files: [file(4, 't2.srt')] });
  const picked = pickBestSubtitle([machine, french, zip, ok, good]);
  assert.equal(picked.file_id, 3);
});

test('pickBestSubtitle returns null when nothing is usable', () => {
  assert.equal(pickBestSubtitle([]), null);
  assert.equal(pickBestSubtitle(null), null);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/tik/opensubtitles.test.mjs`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement picker + HTTP function**

`netlify/functions/lib/opensubtitles.mjs`:

```js
import { IMDB_ID_RE } from './imdb.mjs';

export const OS_USER_AGENT = 'vhs-garage v1.0';
const SEARCH = 'https://api.opensubtitles.com/api/v1/subtitles';
const DOWNLOAD = 'https://api.opensubtitles.com/api/v1/download';

export function numericImdbId(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^tt(\d{5,10})$/i) || s.match(/^(\d{5,10})$/);
  return m ? String(Number(m[1])) : null;
}

function filesOf(row) {
  return Array.isArray(row?.attributes?.files) ? row.attributes.files : [];
}

function isEnglish(row) {
  const lang = String(row?.attributes?.language || '').toLowerCase();
  return lang === 'en' || lang.startsWith('en-');
}

function isHuman(row) {
  const a = row?.attributes || {};
  return a.ai_translated !== true && a.machine_translated !== true && a.auto_translated !== true;
}

function srtFile(file) {
  return /\.srt$/i.test(String(file?.file_name || '')) || !file?.file_name;
}

export function pickBestSubtitle(rows) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter(isEnglish)
    .filter(isHuman)
    .map((row) => {
      const file = filesOf(row).find(srtFile) || filesOf(row)[0];
      if (!file?.file_id) return null;
      if (file.file_name && !srtFile(file)) return null;
      return {
        file_id: file.file_id,
        file_name: file.file_name || '',
        trusted: row.attributes?.from_trusted === true ? 1 : 0,
        downloads: Number(row.attributes?.download_count) || 0,
      };
    })
    .filter(Boolean);
  list.sort((a, b) => b.trusted - a.trusted || b.downloads - a.downloads);
  return list[0] || null;
}

export async function searchSubtitles(imdbId, { apiKey, signal } = {}) {
  const numeric = numericImdbId(imdbId);
  if (!numeric) throw new Error('Invalid IMDb id');
  if (!apiKey) throw new Error('OpenSubtitles key missing');
  const url = new URL(SEARCH);
  url.searchParams.set('imdb_id', numeric);
  url.searchParams.set('languages', 'en');
  const res = await fetch(url, {
    headers: { 'Api-Key': apiKey, 'User-Agent': OS_USER_AGENT, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`OpenSubtitles search ${res.status}`);
  const body = await res.json();
  return pickBestSubtitle(body?.data || []);
}

export async function downloadSubtitle(fileId, { apiKey, signal } = {}) {
  if (!fileId) throw new Error('Missing subtitle file');
  if (!apiKey) throw new Error('OpenSubtitles key missing');
  const res = await fetch(DOWNLOAD, {
    method: 'POST',
    headers: {
      'Api-Key': apiKey,
      'User-Agent': OS_USER_AGENT,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file_id: fileId }),
    signal,
  });
  if (!res.ok) throw new Error(`OpenSubtitles download ${res.status}`);
  const body = await res.json();
  const link = body?.link;
  if (!link) throw new Error('OpenSubtitles returned no link');
  const file = await fetch(link, { signal, headers: { 'User-Agent': OS_USER_AGENT } });
  if (!file.ok) throw new Error(`Subtitle file ${file.status}`);
  const buf = Buffer.from(await file.arrayBuffer());
  const head = buf.slice(0, 4).toString('utf8');
  if (head.startsWith('PK')) throw new Error('Subtitle was a zip');
  return buf.toString('utf8');
}
```

`netlify/functions/tik-subtitles.mjs` — copy the cache pattern from `tik-imdb.mjs`:

- POST `{ imdbId }`
- Read `process.env.OpenSubtitles`
- Cache store `tik-subtitles`, key = numeric id, TTL 24h
- On success return `{ cues, cached, missing: false }`
- On any search/download/parse error: log, return `{ cues: [], missing: true, error: message }` with HTTP 200 (caller must not die)
- Parse with `parseSrt` from `./lib/srt.mjs`
- If no key, return `{ cues: [], missing: true, error: 'OpenSubtitles key missing' }`

```js
import { getStore } from '@netlify/blobs';
import { IMDB_ID_RE, resolveTitle } from './lib/imdb.mjs';
import { parseSrt } from './lib/srt.mjs';
import { downloadSubtitle, searchSubtitles } from './lib/opensubtitles.mjs';

const CACHE_STORE = 'tik-subtitles';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const imdbId = String(body?.imdbId || '').trim();
  let id = IMDB_ID_RE.test(imdbId) ? imdbId : '';
  if (!id) {
    const query = String(body?.query || '').trim();
    if (!query) return json({ error: 'Give an imdbId or a query' }, 400);
    const title = await resolveTitle(query, body?.year);
    if (!title) return json({ error: `No movie found for "${query}"` }, 404);
    id = title.id;
  }
  const cached = await readCache(id);
  if (cached) return json({ ...cached, cached: true });
  const apiKey = process.env.OpenSubtitles || '';
  try {
    const picked = await searchSubtitles(id, { apiKey });
    if (!picked) throw new Error('No English subtitle');
    const srt = await downloadSubtitle(picked.file_id, { apiKey });
    const cues = parseSrt(srt);
    const value = { cues, missing: false, error: null };
    await writeCache(id, value);
    return json({ ...value, cached: false });
  } catch (e) {
    console.warn('[tik-subtitles] miss', { id, message: e.message });
    const value = { cues: [], missing: true, error: e.message || 'OpenSubtitles lookup failed' };
    return json({ ...value, cached: false });
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

async function readCache(key) {
  try {
    const entry = await getStore(CACHE_STORE).get(key, { type: 'json' });
    if (!entry || !Number.isFinite(entry.at)) return null;
    if (Date.now() - entry.at > CACHE_TTL_MS) return null;
    return entry.value;
  } catch (e) {
    console.warn('[tik-subtitles] cache read failed', { key, message: e.message });
    return null;
  }
}

async function writeCache(key, value) {
  try {
    await getStore(CACHE_STORE).setJSON(key, { at: Date.now(), value });
  } catch (e) {
    console.warn('[tik-subtitles] cache write failed', { key, message: e.message });
  }
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/tik/opensubtitles.test.mjs test/tik/srt.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/lib/opensubtitles.mjs netlify/functions/tik-subtitles.mjs test/tik/opensubtitles.test.mjs
git commit -m "feat(tik): OpenSubtitles English SRT lookup"
```

---

### Task 6: Queue parsers (Trivia vs Quotes coverage)

**Files:**
- Modify: `netlify/functions/lib/queue.mjs`
- Modify: `test/tik/queue.test.mjs`
- Modify: `netlify/functions/tik-queue.mjs`
- Modify: `netlify/functions/tik-queue-background.mjs`

- [ ] **Step 1: Write failing tests**

Add to `test/tik/queue.test.mjs`:

```js
import {
  parsePostedMovie, parsePostedQuotes, movieKey, isAlreadyPosted, summarizeHistory,
  buildQueuePrompt, normalizeQueue, QUEUE_COUNT, parseHashtags, summarizeTagRows,
} from '../../netlify/functions/lib/queue.mjs';

test('parsePostedQuotes reads the quotes title and ignores trivia', () => {
  const q = defaultPostFields('quotes', 'Terminator 2');
  assert.equal(parsePostedQuotes(q.title, q.description), 'Terminator 2');
  const t = defaultPostFields('trivia', 'Terminator 2');
  assert.equal(parsePostedQuotes(t.title, t.description), null);
  assert.equal(parsePostedMovie(q.title, q.description), null);
  assert.equal(parsePostedMovie(t.title, t.description), 'Terminator 2');
});

test('parsePostedQuotes handles dash variants', () => {
  assert.equal(parsePostedQuotes('Jaws — movie quotes'), 'Jaws');
  assert.equal(parsePostedQuotes('Jaws - movie quotes'), 'Jaws');
  assert.equal(parsePostedQuotes('Alien (1979) — movie quotes'), 'Alien');
});

test('buildQueuePrompt quotes mode asks for quotable films', () => {
  const p = buildQueuePrompt({ format: 'quotes', posted: ['Jaws'] });
  assert.match(p, /quote/i);
  assert.match(p, /Jaws/);
  assert.doesNotMatch(p, /behind-the-scenes movie trivia/);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/tik/queue.test.mjs`

Expected: FAIL — `parsePostedQuotes` not exported.

- [ ] **Step 3: Implement**

In `queue.mjs`, add next to `parsePostedMovie`:

```js
export function parsePostedQuotes(title, description = '') {
  const t = String(title || '').trim();
  if (!t) return null;
  if (/^remembering some guys\s*:/i.test(t)) return null;
  if (/^\d{4}\s+at the movies\b/i.test(t)) return null;
  if (/\bmovie trivia\b/i.test(t)) return null;
  const dash = t.match(/^(.+?)\s*[—–-]\s*movie quotes\b/i);
  if (dash) return cleanMovieName(dash[1]);
  return null;
}
```

Keep `parsePostedMovie` rejecting quotes titles: after the guys/year checks, if `/\bmovie quotes\b/i.test(t) && !/\bmovie trivia\b/i.test(t)` return null **before** the trivia dash match. (Quotes titles never contain "movie trivia", so the existing trivia regex already misses them. Add an explicit test that quotes titles return null from `parsePostedMovie` — already in Step 1.)

Add optional `format` to `summarizeHistory`:

```js
export function summarizeHistory(rows, { format = 'trivia' } = {}) {
  const parse = format === 'quotes' ? parsePostedQuotes : parsePostedMovie;
  // ... same loop, using parse(row?.title, description) instead of parsePostedMovie
```

Default remains trivia so existing tests pass.

Update `buildQueuePrompt` to take `format = 'trivia'`. When `format === 'quotes'`, replace the account sentence with:

```
The account is VHS Garage: photo slideshows of famous movie quotes, one film per post, aimed at people who grew up renting tapes. Posts do well when the film is endlessly quoted, rewatched, and full of lines people say along.
```

and the pick rule "deep well of behind-the-scenes trivia" with "a deep well of famous, upvoted IMDb quotes".

Pass `format` through `tik-queue.mjs` and `tik-queue-background.mjs` from `body.format` into `buildQueuePrompt` and `summarizeHistory`.

- [ ] **Step 4: Run tests**

Run: `node --test test/tik/queue.test.mjs`

Expected: PASS, including existing trivia title tests.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/lib/queue.mjs netlify/functions/tik-queue.mjs netlify/functions/tik-queue-background.mjs test/tik/queue.test.mjs
git commit -m "feat(tik): parse Quote-a-long titles separately from trivia"
```

---

### Task 7: Autopilot `kind: 'quotes'`

**Files:**
- Modify: `netlify/functions/lib/autopilot.mjs`
- Modify: `test/tik/autopilot.test.mjs`
- Modify: `netlify/functions/tik-autopilot.mjs`
- Modify: `netlify/functions/tik-autopilot-job-background.mjs`

- [ ] **Step 1: Write failing tests**

Add to `test/tik/autopilot.test.mjs`:

```js
import {
  AUTOPILOT_COUNT, QUOTES_COUNT, buildAutopilotPrompt, buildQuotesPrompt, buildTitleSlidePrompt,
  normalizeSuggestions, applyCueSeek, normalizeMeta, META_HOOK_MAX,
  clampText, CAPTION_TARGET, CAPTION_MAX, META_HOOK_TARGET,
} from '../../netlify/functions/lib/autopilot.mjs';

test('buildQuotesPrompt asks for 8 boiled lines plus a name-only title', () => {
  const p = buildQuotesPrompt({
    title: 'Terminator 2',
    year: 1991,
    durationSeconds: 8220,
    quotes: [{ text: "Terminator: I'll be back.", score: 900 }],
    cues: [{ start: 72, end: 76, text: "I'll be back." }],
  });
  assert.match(p, /Quote-a-long|quote-a-long|movie quotes/i);
  assert.match(p, new RegExp(String(QUOTES_COUNT)));
  assert.match(p, /I'll be back/);
  assert.match(p, /TITLE slide/);
  assert.match(p, /movie name only|first line is the movie name/i);
  assert.doesNotMatch(p, /TWO short sentences/);
  assert.match(p, /character names/i);
  assert.match(p, /"start"/);
  assert.match(p, /"end"/);
});

test('buildQuotesPrompt still works with no cues', () => {
  const p = buildQuotesPrompt({ title: 'Jaws', durationSeconds: 7000, quotes: [{ text: "You're gonna need a bigger boat." }] });
  assert.match(p, /guess/i);
});

test('applyCueSeek prefers start/end quarter over model timecode', () => {
  assert.equal(applyCueSeek({ caption: 'x', timecode: 9, start: 12, end: 16 }, 1000).timecode, 13);
  assert.equal(applyCueSeek({ caption: 'x', timecode: 9 }, 1000).timecode, 9);
});

test('normalizeSuggestions keeps start and end when present', () => {
  const out = normalizeSuggestions({
    suggestions: [{ caption: "I'll be back.", timecode: 0, grab: 'close-up', start: 72, end: 76 }],
  }, 8000, 8);
  assert.equal(out[0].start, 72);
  assert.equal(out[0].end, 76);
  assert.equal(out[0].timecode, 73);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/tik/autopilot.test.mjs`

Expected: FAIL — `QUOTES_COUNT` / `buildQuotesPrompt` missing.

- [ ] **Step 3: Implement prompt + normalize**

In `autopilot.mjs`:

```js
export const QUOTES_COUNT = 8;
export const QUOTES_POOL = 20;
```

Add `applyCueSeek` using `seekTime` from `../../public/scripts/tik/timecode.js` **or** duplicate the one-liner here to avoid a functions→public import:

```js
export function applyCueSeek(item, durationSeconds) {
  const dur = Math.max(0, Math.floor(durationSeconds || 0));
  const start = Number(item?.start);
  const end = Number(item?.end);
  let tc = Number(item?.timecode);
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    tc = start + 0.25 * (end - start);
  }
  if (!Number.isFinite(tc)) tc = 0;
  tc = Math.min(dur || tc, Math.max(0, tc));
  return { ...item, timecode: tc };
}
```

Prefer importing `seekTime` from `../../public/scripts/tik/timecode.js` (ESM, works in node:test and Netlify bundling of this repo). If the bundler rejects it, keep the one-liner local.

Update `normalizeSuggestions` so each item may include finite `start`/`end`, then run `applyCueSeek` before push.

`buildQuotesPrompt({ title, year, durationSeconds, count = QUOTES_COUNT, quotes = [], cues = [], guidance = '', includeTitleSlide = true, includeMeta = true, hints = [] })`:

Prompt requirements (must appear in the string the tests match):

- Format name Quote-a-long / movie quotes
- FIRST suggestion is TITLE slide: caption is exactly the film name (`${title} (${year})` if year else title) and nothing else — no two sentences
- Then exactly `count` quote slides
- Source quotes listed in `<imdb_quotes>` (top `QUOTES_POOL`)
- Optional cue list in `<subtitles>` as `index | start | end | text` (cap ~400 cues; if longer, subsample evenly)
- Optional matcher hints `hints` as `quoteIndex -> cue start-end`
- Boil each IMDb block to one or two spoken lines; character name only when it helps
- Subtitles have no character names / different punctuation — match anyway
- Return `start` and `end` of the matched span in seconds, plus `timecode` and `grab`
- If no cue matches, omit start/end and guess timecode; never drop the quote
- No questions, no em dashes (same house rules)
- includeMeta: hook must not spoil a slide quote; filmTags may include moviequotes

Do **not** fetch Wikipedia for `kind === 'quotes'` (quotes are the source). In `tik-autopilot-job-background.mjs` `fetchSource`, skip wiki when `kind === 'quotes'`.

Wire `kind === 'quotes'` in both autopilot functions:

```js
} else if (kind === 'quotes') {
  prompt = buildQuotesPrompt({
    title, year, durationSeconds,
    count: Number(count) || QUOTES_COUNT,
    quotes: Array.isArray(body.quotes) ? body.quotes : [],
    cues: Array.isArray(body.cues) ? body.cues : [],
    hints: Array.isArray(body.hints) ? body.hints : [],
    guidance, includeTitleSlide, includeMeta,
  });
}
```

Destructure `quotes`, `cues`, `hints` from the job body. Require `title` for quotes like trivia. Default `count` to `QUOTES_COUNT`. Error text: `The AI returned no usable quotes — try again.`

Sync `tik-autopilot.mjs` the same way.

- [ ] **Step 4: Run tests**

Run: `node --test test/tik/autopilot.test.mjs`

Expected: PASS. Adjust `normalizeSuggestions` so existing trivia tests still have `{ caption, timecode, grab }` and extra `start`/`end` only when provided.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/lib/autopilot.mjs netlify/functions/tik-autopilot.mjs netlify/functions/tik-autopilot-job-background.mjs test/tik/autopilot.test.mjs
git commit -m "feat(tik): Autopilot quotes prompt with subtitle spans"
```

---

### Task 8: Title stamp helper + compose option

**Files:**
- Modify: `public/scripts/tik/compose.js`
- Create tests in `test/tik/quotes.test.mjs` for the pure helper (canvas is not required in node)

- [ ] **Step 1: Write failing tests**

Create `test/tik/quotes.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wantsQuoteStamp } from '../../public/scripts/tik/compose.js';
import { fontScaleForQuote } from '../../public/scripts/tik/caption.js';
import { defaultPostFields } from '../../public/scripts/tik/project.js';

test('wantsQuoteStamp only on quotes title slides', () => {
  assert.equal(wantsQuoteStamp({ format: 'quotes', kind: 'title' }), true);
  assert.equal(wantsQuoteStamp({ format: 'quotes', kind: null }), false);
  assert.equal(wantsQuoteStamp({ format: 'quotes', kind: 'outro' }), false);
  assert.equal(wantsQuoteStamp({ format: 'trivia', kind: 'title' }), false);
  assert.equal(wantsQuoteStamp({}), false);
});

test('quotes title is not a trivia title', () => {
  assert.doesNotMatch(defaultPostFields('quotes', 'Jaws').title, /trivia/i);
});
```

`compose.js` currently has no `wantsQuoteStamp`. Export it from there (or from `project.js` if you prefer compose to stay canvas-only). Prefer `compose.js` so the draw call and the predicate live together.

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/tik/quotes.test.mjs`

Expected: FAIL — `wantsQuoteStamp` not exported. `compose.js` imports `layout.js`/`caption.js` which are DOM-free, so node can import it **if** it does not touch `document` at import time. It currently reads `document.fonts` only inside `captionFontReady`. Importing `compose.js` in node should work.

If import fails on `document`, put `wantsQuoteStamp` in `public/scripts/tik/project.js` instead and import from there in the test **and** in compose.

- [ ] **Step 3: Implement stamp**

Add to `compose.js`:

```js
export function wantsQuoteStamp({ format, kind } = {}) {
  return format === 'quotes' && kind === 'title';
}

function drawQuoteStamp(ctx, frameX, frameY, frameW, frameH) {
  const cx = frameX + frameW * 0.52;
  const cy = frameY + frameH * 0.38;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-12 * Math.PI / 180);
  ctx.font = '900 86px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 14;
  ctx.strokeStyle = '#111';
  ctx.fillStyle = '#fb7185';
  const label = 'QUOTE-A-LONG';
  ctx.strokeText(label, 0, 0);
  ctx.fillText(label, 0, 0);
  ctx.restore();
}
```

Extend `composeToCanvas` / `composeSlide` opts with `format` and `kind`. After `ctx.drawImage(bitmap, frameX, frameY, F.w, F.h)`, if `wantsQuoteStamp({ format, kind })` call `drawQuoteStamp(ctx, frameX, frameY, F.w, F.h)`.

Every `composeToCanvas` / `composeSlide` call site in `app.js` and `publish.js` must pass `{ format: project.format, kind: slide.kind }` in addition to existing opts.

- [ ] **Step 4: Run tests**

Run: `node --test test/tik/quotes.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add public/scripts/tik/compose.js public/scripts/tik/app.js public/scripts/tik/publish.js test/tik/quotes.test.mjs
git commit -m "feat(tik): stamp QUOTE-A-LONG on quotes title slides"
```

---

### Task 9: Single-maker UI + client Autopilot

**Files:**
- Modify: `src/pages/tik.astro`
- Modify: `public/scripts/tik/app.js`
- Modify: `public/scripts/tik/autopilot.js`

- [ ] **Step 1: Home card + pane mapping**

In `src/pages/tik.astro`, after the Tape Trivia button, add:

```html
        <button id="new-quotes" class="group relative overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900 p-5 text-left transition hover:border-rose-400/60">
          <div class="tape-lines pointer-events-none absolute inset-0 opacity-40"></div>
          <div class="relative">
            <span class="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-rose-400/15 text-rose-300">
              <span class="material-symbols-outlined">format_quote</span>
            </span>
            <h3 class="mt-3 text-lg font-bold tracking-tight">Quote-a-long</h3>
            <p class="mt-1 text-sm text-neutral-400">Famous lines over the frames they were spoken on. IMDb quotes, matched to the subtitle file.</p>
            <p class="mt-3 text-xs font-semibold text-rose-300/90">Movie file + quotes <span aria-hidden="true">→</span></p>
          </div>
        </button>
```

Change the home grid if four cards feel cramped: keep `sm:grid-cols-2 lg:grid-cols-3` (fourth wraps).

Add ids used by JS: none new beyond `new-quotes`. Update Autopilot button label from JS (do not hard-split the pane). Update paste placeholder via JS.

In `app.js`:

```js
newQuotes: $('new-quotes'),
```

```js
els.newQuotes.addEventListener('click', () => { newProject('quotes').catch((e) => console.error('[tik] new project failed:', e)); });
```

```js
const PANES = { trivia: els.paneTrivia, quotes: els.paneTrivia, guys: els.paneGuys, year: els.paneYear };
```

`applyFormatUI`: show Add-scene for trivia **and** quotes:

```js
els.addScene.classList.toggle('hidden', f.key !== 'trivia' && f.key !== 'quotes');
```

`syncSeedControls`: treat quotes like trivia (`project?.format === 'trivia' || project?.format === 'quotes'`).

When format is quotes, set:

- `els.autopilotBtn` last child / label text: `Autopilot — title slide + quotes`
- paste placeholder: `Optional — paste quotes you want, or a direction`
- bookmarklet blurb can stay; it still works as optional paste guidance

- [ ] **Step 2: `fetchQuotesPost` in autopilot.js**

```js
export const QUOTES_COUNT = 8;

export async function fetchImdbQuotes({ imdbId, query, year, includeSpoilers = true } = {}) {
  const res = await fetch('/.netlify/functions/tik-imdb', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'quotes', imdbId, query, year, includeSpoilers }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'IMDb quotes lookup failed');
  return data;
}

export async function fetchSubtitles({ imdbId, query, year } = {}) {
  const res = await fetch('/.netlify/functions/tik-subtitles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imdbId, query, year }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { cues: [], missing: true, error: data.error || 'Subtitle lookup failed' };
  return { cues: Array.isArray(data.cues) ? data.cues : [], missing: !!data.missing, error: data.error || null };
}

export async function fetchQuotesPost(opts = {}) {
  const data = await runJob({
    kind: 'quotes',
    title: opts.title,
    year: opts.year,
    durationSeconds: opts.durationSeconds || 0,
    count: opts.count || QUOTES_COUNT,
    quotes: opts.quotes || [],
    cues: opts.cues || [],
    hints: opts.hints || [],
    exclude: opts.exclude || [],
    guidance: opts.guidance || '',
    includeTitleSlide: opts.includeTitleSlide !== false,
    includeMeta: !!opts.includeMeta,
    model: opts.model,
  }, opts.onProgress);
  if (!data.suggestions?.length) {
    throw new Error(data.error || 'Autopilot couldn’t generate quotes — try again.');
  }
  return { suggestions: data.suggestions, meta: data.meta || null };
}
```

- [ ] **Step 3: Wire the existing Autopilot click path**

In `app.js`, the current trivia Autopilot (~`fetchTriviaPost`) must branch:

```js
const quotesMode = project.format === 'quotes';
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
  const pool = pack.quotes.slice(0, 20);
  const hints = [];
  // matchQuoteToCues is server-side; skip client hints unless you also export a tiny copy. YAGNI: let the model match.
  const { suggestions, meta: m } = await fetchQuotesPost({
    title: movie.title || movie.query,
    year: movie.year,
    durationSeconds: duration,
    count: 8,
    quotes: pool,
    cues: subs.cues,
    includeTitleSlide: true,
    includeMeta: true,
    guidance: els.autopilotPrompt?.value || '',
    onProgress: (msg) => { els.status.textContent = msg; },
  });
  scenes = suggestions;
  meta = m;
} else {
  // existing fetchTriviaPost path
}
```

When building slides from `scenes`, if `quotesMode`:

- `fontScale: i === 0 ? 1 : fontScaleForQuote(scenes[i].caption)`
- `kind: i === 0 ? 'title' : null`
- status string mentions guesses when `subMissing`

Import `fontScaleForQuote` from `caption.js` and `fetchQuotesPost`, `fetchImdbQuotes`, `fetchSubtitles` from `autopilot.js`.

Outro still `pickOutro(project.format)`.

Title rewrite button: for quotes, do not use `buildTitleSlidePrompt` (two sentences). Either hide rewrite on quotes title, or POST `kind: 'quotes'` with `titleOnly: true` later. **YAGNI for this task:** if the current rewrite uses `fetchTitleSlide`, skip calling it when `project.format === 'quotes'` (leave the movie name).

- [ ] **Step 4: Manual check**

No unit test for app.js. Run: `node --test 'test/tik/**/*.test.mjs'`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pages/tik.astro public/scripts/tik/app.js public/scripts/tik/autopilot.js
git commit -m "feat(tik): Quote-a-long single maker Autopilot"
```

---

### Task 10: Batch Trivia | Quotes toggle + Shoot without vision

**Files:**
- Modify: `src/pages/tik.astro` (Write chrome)
- Modify: `public/scripts/tik/batch.js`
- Modify: `public/scripts/tik/shoot.js`
- Modify: `public/scripts/tik/vision.js`

- [ ] **Step 1: Batch Write toggle HTML**

In `src/pages/tik.astro`, inside `#screen-batch` header row (after the Batch mode chip, before the Write/Shoot tabs), add:

```html
        <div id="batch-format" class="flex items-center gap-1 rounded-lg border border-neutral-800 bg-neutral-900 p-1">
          <button type="button" data-batch-format="trivia" class="rounded-md px-3 py-1.5 text-xs font-semibold">Trivia</button>
          <button type="button" data-batch-format="quotes" class="rounded-md px-3 py-1.5 text-xs font-semibold">Quotes</button>
        </div>
```

Style the selected button in JS (`bg-neutral-800 text-white` vs muted).

Hide `#batch-curate` wrapper when format is quotes (the checkbox + note). Pool list still renders `item.text`.

- [ ] **Step 2: batch.js format state**

Module-level `let batchFormat = 'trivia';`

Wire `data-batch-format` clicks: set `batchFormat`, re-render, clear pools (`item.pool = null; item.state = 'idle'`) so Quotes does not reuse a trivia pool.

`ensurePool`: `action: batchFormat === 'quotes' ? 'quotes' : 'trivia'`. Create the pool from `data.quotes || data.trivia`. Reuse `createTriviaPool` — it only needs `{ id, text, up, down, score, spoiler }`.

Skip `curateSelected` / `curatePool` when `batchFormat === 'quotes'`.

`buildAll`: skip curate for quotes. Call `fetchQuotesPost` when quotes:

```js
const packSubs = await fetchSubtitles({ imdbId: it.imdbId, query: it.title, year: it.year });
const { suggestions, meta } = await fetchQuotesPost({
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
```

If `!picked.length` fail that movie and continue.

`saveDraft`: `format: batchFormat`, `defaultPostFields(batchFormat, ...)`, `pickOutro(batchFormat)`, `batchShot: i === 0 ? 'title' : (batchFormat === 'quotes' ? 'quotes' : 'trivia')`, `fontScale: i === 0 ? 1 : (batchFormat === 'quotes' ? fontScaleForQuote(s.caption) : 1)`, `kind: i === 0 ? 'title' : null`.

Posted-history skip list: when suggesting, send `format: batchFormat` to tik-queue. Filter local posted projects by `p.format === batchFormat`.

Queue POST body includes `{ format: batchFormat }`.

- [ ] **Step 3: Shoot**

`loadDrafts`:

```js
drafts = (await listProjects()).filter((p) => p.batch?.pendingFrames && (p.format === 'trivia' || p.format === 'quotes'));
```

Keep `format` on each row.

Add `grabSettledFrame` in `vision.js` (uses existing `seekAndSettle`, `grabFrame`, `frameStats` blank nudge, **no** `tik-vision`):

```js
export async function grabSettledFrame(video, { timecode, durationSeconds = 0, onProgress = () => {} } = {}) {
  const dur = Number(durationSeconds) || video.duration || 0;
  let t = Math.min(Math.max(0, Number(timecode) || 0), dur || Number(timecode) || 0);
  await seekAndSettle(video, t);
  let bitmap = await grabFrame(video);
  for (let n = 0; n < BLANK_NUDGES; n++) {
    const stats = frameStats(bitmap);
    if (!stats.blank) break;
    onProgress('nudge off a blank frame');
    t = Math.min(dur || t + BLANK_NUDGE_SECONDS, t + BLANK_NUDGE_SECONDS);
    bitmap.close?.();
    await seekAndSettle(video, t);
    bitmap = await grabFrame(video);
  }
  return { bitmap, timecode: t, verified: false };
}
```

In `shoot.js`, per slide:

```js
const grabber = project.format === 'quotes' ? grabSettledFrame : grabVerifiedFrame;
const out = await grabber(video, {
  timecode: slide.timecode,
  durationSeconds: row.duration || project.batch?.runtimeSeconds || 0,
  caption: slide.caption,
  grab: slide.grabHint,
  kind: slide.batchShot === 'title' ? 'title' : 'trivia',
  onProgress: (m) => pulse(`${row.name}: ${m}`),
});
```

Do not pass quotes slides to `grabVerifiedFrame`.

- [ ] **Step 4: Run the full unit suite**

Run: `node --test 'test/tik/**/*.test.mjs'`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pages/tik.astro public/scripts/tik/batch.js public/scripts/tik/shoot.js public/scripts/tik/vision.js
git commit -m "feat(tik): batch Trivia/Quotes toggle and math-only Shoot"
```

---

## Spec coverage

| Spec item | Task |
|-----------|------|
| Format `quotes`, label, outro, `{Movie} — movie quotes` | 1 |
| fontScale mapping | 2 |
| Seek `start + 0.25*(end-start)` | 2, 3 |
| SRT parse + fuzzy match | 3 |
| IMDb GraphQL quotes, rank, cache prefix | 4 |
| OpenSubtitles env `OpenSubtitles`, English, fail-open | 5 |
| Quotes titles ≠ trivia coverage | 6 |
| Queue prompt for quotable films | 6 |
| One Autopilot job, title name-only, 8 quotes, cues, meta | 7 |
| Stamp on quotes title only | 8 |
| Home card, reuse pane-trivia, single Autopilot | 9 |
| Batch toggle, skip curate, skip vision | 10 |
| No empty draft when IMDb has no quotes | 9, 10 |
| Subtitle miss → guess, status says so | 9 |
| No new npm deps, no HTML scrape, no vision | 5, 10 |

## Placeholder / consistency notes for the implementing agent

- `QUOTES_COUNT` is `8` in `autopilot.mjs` and `autopilot.js` — keep them equal.
- Pool size sent to the model is `20` (`QUOTES_POOL`).
- `batchShot` for quote content slides is `'quotes'` so Shoot can branch; vision `kind` is unused on that path.
- `createTriviaPool` is reused for quotes rows; do not add `quotepool.js`.
- Zip subtitle downloads are a miss (no unzip dependency).
- House hashtag sets do not gain a quotes pair.
