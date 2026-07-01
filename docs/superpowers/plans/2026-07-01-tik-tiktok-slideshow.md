# /tik — TikTok Movie-Trivia Slideshow Maker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone `/tik` page that lets you pick a local video, scrub and grab frames, caption each grab, and post the set to TikTok as a photo slideshow (draft-to-inbox).

**Architecture:** All image work (grab frame → composite frame + caption band onto a 1080×1920 canvas → JPEG) happens client-side, matching the site's `public/scripts/<page>/*.js` ES-module pattern. Three thin Netlify functions do only what the browser can't: hold the OAuth secret (`tik-auth`), host the finished JPEGs at a public URL via Netlify Blobs (`tik-media`), and call TikTok's Content Posting API (`tik-publish`). No new npm dependencies.

**Tech Stack:** Astro page shell + Tailwind v4; vanilla ES-module client JS in `public/scripts/tik/`; Netlify Functions (`.mjs`) + `@netlify/blobs` (already a dep); TikTok Content Posting API (`PULL_FROM_URL`, `MEDIA_UPLOAD`); `node:test` for unit tests (built into Node 22, no new dep).

**Spec:** `docs/superpowers/specs/2026-07-01-tik-tiktok-slideshow-design.md`

---

## File Structure

Created by this plan:

```
src/pages/tik.astro                       # page shell (HTML + Tailwind), loads the client entry
public/scripts/tik/
  timecode.js         (pure, unit-tested) # time formatting + frame stepping
  slides.js           (pure, unit-tested) # slide-array reducers, MAX_SLIDES cap
  layout.js           (pure, unit-tested) # computeSlideLayout() — frame/band rects
  caption.js          (pure, unit-tested) # word-wrap + font-fit (injected text measurer)
  capture.js          (DOM)               # load video file, grab a frame to an ImageBitmap
  scrubber.js         (DOM)               # chunky scrubber control
  compose.js          (canvas)            # composeToCanvas() + composeSlide() → final JPEG
  auth.js             (browser + tested)  # TikTok OAuth (Web flow) client helpers
  publish.js          (network)           # upload slides + publish + poll status
  app.js              (DOM)               # entry: wires everything, live slide-list UI
netlify/functions/
  tik-auth.mjs                            # GET client_key; POST exchange/refresh/revoke
  tik-media.mjs                           # POST store JPEG in Blobs; GET stream it publicly
  tik-publish.mjs                         # refresh→access token, init draft, poll status
  lib/tiktok-payload.mjs (pure, tested)   # buildInitPayload() + validateForInit()
test/tik/
  timecode.test.mjs
  slides.test.mjs
  layout.test.mjs
  caption.test.mjs
  tiktok-payload.test.mjs
  auth.test.mjs
```

Modified:

```
package.json                              # add "test" script
```

**Conventions to follow (verified in the codebase):**
- **Pages MUST use the `Base` layout.** Tailwind v4 CSS ships only through `@import "tailwindcss"` in `src/styles/global.css`, which is imported **only** by `src/layouts/Base.astro`. A hand-written `<!doctype html>` page ships **zero** stylesheet (verified: an unwrapped page builds but emits no `<link rel="stylesheet">`, so every Tailwind class is inert). Every page in `src/pages` wraps its body in `<Base title=… description=…>` — see `src/pages/capture.astro:6` and `src/pages/recorder.astro:30`. `Base` provides `<slot name="head" />` and `<slot />`; its `<body>` is `bg-black text-white`.
- Client JS is served statically from `public/scripts/…` and referenced from the Astro page as `<script type="module" src={`/scripts/tik/app.js?v=${BUILD_ID}`}>` — see `src/pages/capture.astro:1942` and `src/utils/build-id.js`.
- `package.json` has `"type": "module"`, so `.js` files are ES modules; `node:test` can import them directly.
- Netlify functions are `export default async (req) => Response`; Blobs via `import { getStore } from '@netlify/blobs'` — see `netlify/functions/signup-count.mjs` and `netlify/functions/youtube-auth.mjs`.
- Pure modules must not touch `document`/`window`/`location` at import time (only inside functions) so Node can import them for tests.

---

## Task 1: Test harness + timecode module

**Files:**
- Create: `public/scripts/tik/timecode.js`
- Create: `test/tik/timecode.test.mjs`
- Modify: `package.json` (add `test` script)

- [ ] **Step 1: Add the test script to package.json**

In `package.json`, add a `test` entry to `"scripts"`:

```json
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview",
    "astro": "astro",
    "test": "node --test 'test/tik/**/*.test.mjs'"
  },
```

> **Why the glob, not a directory:** verified on Node v22.22.2 — `node --test test/tik/` treats the path as a single *module* and errors `Cannot find module`. The glob form `node --test 'test/tik/**/*.test.mjs'` correctly discovers and runs every test file. Keep the single quotes so the shell passes the glob through to Node.

- [ ] **Step 2: Write the failing test**

Create `test/tik/timecode.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTimecode, frameStep } from '../../public/scripts/tik/timecode.js';

test('formatTimecode pads minutes, seconds, milliseconds', () => {
  assert.equal(formatTimecode(0), '00:00.000');
  assert.equal(formatTimecode(5.2), '00:05.200');
  assert.equal(formatTimecode(75.019), '01:15.019');
});

test('formatTimecode clamps negatives to zero', () => {
  assert.equal(formatTimecode(-3), '00:00.000');
});

test('frameStep advances and rewinds by one frame at the given fps', () => {
  // 30fps → one frame = 1/30 s ≈ 0.03333
  assert.ok(Math.abs(frameStep(1.0, 1, 30) - (1.0 + 1 / 30)) < 1e-9);
  assert.ok(Math.abs(frameStep(1.0, -1, 30) - (1.0 - 1 / 30)) < 1e-9);
});

test('frameStep never returns a negative time', () => {
  assert.equal(frameStep(0, -1, 30), 0);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../public/scripts/tik/timecode.js'`.

- [ ] **Step 4: Write the implementation**

Create `public/scripts/tik/timecode.js`:

```js
// Pure time helpers for the /tik scrubber. No DOM access — unit-tested with node:test.

// Format seconds as mm:ss.mmm (e.g. 75.019 → "01:15.019"). Negatives clamp to 0.
export function formatTimecode(seconds) {
  const t = Math.max(0, Number(seconds) || 0);
  const mm = Math.floor(t / 60);
  const ss = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(mm)}:${pad(ss)}.${pad(ms, 3)}`;
}

// Step currentTime by `dir` frames (dir is +1 or -1) at `fps`. Clamps to >= 0.
export function frameStep(currentTime, dir, fps = 30) {
  const next = (Number(currentTime) || 0) + dir / (fps || 30);
  return Math.max(0, next);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 4 tests passing.

- [ ] **Step 6: Commit**

```bash
git add package.json test/tik/timecode.test.mjs public/scripts/tik/timecode.js
git commit -m "feat(tik): timecode helpers + node:test harness"
```

---

## Task 2: Slides reducer module

**Files:**
- Create: `public/scripts/tik/slides.js`
- Create: `test/tik/slides.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/tik/slides.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SLIDES, addSlide, removeSlide, reorderSlide, editCaption, canAddSlide,
} from '../../public/scripts/tik/slides.js';

const s = (id, caption = '') => ({ id, caption });

test('addSlide appends and does not mutate the input array', () => {
  const a = [s('1')];
  const b = addSlide(a, s('2'));
  assert.deepEqual(b.map(x => x.id), ['1', '2']);
  assert.equal(a.length, 1); // original untouched
});

test('addSlide refuses to exceed MAX_SLIDES', () => {
  let arr = [];
  for (let i = 0; i < MAX_SLIDES; i++) arr = addSlide(arr, s(String(i)));
  assert.equal(arr.length, MAX_SLIDES);
  const same = addSlide(arr, s('overflow'));
  assert.equal(same.length, MAX_SLIDES); // unchanged, rejected
});

test('canAddSlide reflects the cap', () => {
  assert.equal(canAddSlide([]), true);
  const full = Array.from({ length: MAX_SLIDES }, (_, i) => s(String(i)));
  assert.equal(canAddSlide(full), false);
});

test('removeSlide drops by id', () => {
  const a = [s('1'), s('2'), s('3')];
  assert.deepEqual(removeSlide(a, '2').map(x => x.id), ['1', '3']);
});

test('reorderSlide moves an item from one index to another', () => {
  const a = [s('1'), s('2'), s('3')];
  assert.deepEqual(reorderSlide(a, 0, 2).map(x => x.id), ['2', '3', '1']);
  assert.deepEqual(reorderSlide(a, 2, 0).map(x => x.id), ['3', '1', '2']);
});

test('editCaption updates only the matching slide, immutably', () => {
  const a = [s('1', 'old'), s('2', 'keep')];
  const b = editCaption(a, '1', 'new');
  assert.equal(b[0].caption, 'new');
  assert.equal(b[1].caption, 'keep');
  assert.equal(a[0].caption, 'old'); // original untouched
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `slides.js`.

- [ ] **Step 3: Write the implementation**

Create `public/scripts/tik/slides.js`:

```js
// Pure reducers over the slide array. A slide is { id, bitmap?, caption }.
// bitmap is irrelevant to ordering/captioning, so these functions never read it.

// TikTok allows up to 35 images per photo post.
export const MAX_SLIDES = 35;

export function canAddSlide(slides) {
  return slides.length < MAX_SLIDES;
}

export function addSlide(slides, slide) {
  if (!canAddSlide(slides)) return slides;
  return [...slides, slide];
}

export function removeSlide(slides, id) {
  return slides.filter(x => x.id !== id);
}

export function reorderSlide(slides, fromIndex, toIndex) {
  if (fromIndex === toIndex) return slides;
  const next = [...slides];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export function editCaption(slides, id, caption) {
  return slides.map(x => (x.id === id ? { ...x, caption } : x));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — all slides tests green (plus Task 1's still passing).

- [ ] **Step 5: Commit**

```bash
git add test/tik/slides.test.mjs public/scripts/tik/slides.js
git commit -m "feat(tik): pure slide-array reducers with 35-slide cap"
```

---

## Task 3: Slide layout math

**Files:**
- Create: `public/scripts/tik/layout.js`
- Create: `test/tik/layout.test.mjs`

Layout A: a 1080×1920 portrait canvas, the frame letterboxed across the top (full, uncropped), and a solid caption band filling the rest below it. The frame height is capped so the band never disappears on already-tall sources.

- [ ] **Step 1: Write the failing test**

Create `test/tik/layout.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSlideLayout, CANVAS_W, CANVAS_H } from '../../public/scripts/tik/layout.js';

test('canvas constants are TikTok portrait', () => {
  assert.equal(CANVAS_W, 1080);
  assert.equal(CANVAS_H, 1920);
});

test('16:9 frame fills width, letterboxed at top, band fills the rest', () => {
  const L = computeSlideLayout(1920, 1080); // 16:9 source
  assert.equal(L.frame.w, 1080);
  assert.equal(L.frame.h, Math.round(1080 * 1080 / 1920)); // 608
  assert.equal(L.frame.x, 0);
  assert.equal(L.frame.y, 0);
  assert.equal(L.band.x, 0);
  assert.equal(L.band.y, L.frame.h);
  assert.equal(L.band.w, 1080);
  assert.equal(L.band.h, CANVAS_H - L.frame.h);
});

test('very tall source is capped so the band survives, frame centered horizontally', () => {
  const L = computeSlideLayout(1080, 1920); // portrait source, ar 0.5625
  const maxH = Math.round(CANVAS_H * 0.6); // 1152 cap
  assert.equal(L.frame.h, maxH);
  assert.ok(L.frame.w < CANVAS_W);          // narrower than canvas
  assert.equal(L.frame.x, Math.round((CANVAS_W - L.frame.w) / 2)); // centered
  assert.equal(L.band.y, maxH);
  assert.equal(L.band.h, CANVAS_H - maxH);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `layout.js`.

- [ ] **Step 3: Write the implementation**

Create `public/scripts/tik/layout.js`:

```js
// Pure geometry for Layout A. Given a source frame's pixel dimensions, return
// the rects to draw on the 1080x1920 slide canvas: the letterboxed frame on
// top and the caption band filling the remainder. No canvas/DOM here.

export const CANVAS_W = 1080;
export const CANVAS_H = 1920;
// Cap the frame height so a tall/portrait source can't swallow the caption band.
export const MAX_FRAME_H_RATIO = 0.6;

export function computeSlideLayout(frameW, frameH, opts = {}) {
  const CW = opts.canvasW ?? CANVAS_W;
  const CH = opts.canvasH ?? CANVAS_H;
  const maxFrameH = Math.round(CH * (opts.maxFrameHRatio ?? MAX_FRAME_H_RATIO));

  const ar = frameH / frameW; // height per unit width
  let w = CW;
  let h = Math.round(CW * ar);

  if (h > maxFrameH) {
    // Constrain by height instead; frame becomes narrower than the canvas.
    h = maxFrameH;
    w = Math.round(maxFrameH / ar);
  }

  const x = Math.round((CW - w) / 2);
  const y = 0;

  return {
    canvas: { w: CW, h: CH },
    frame: { x, y, w, h },
    band: { x: 0, y: h, w: CW, h: CH - h },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/tik/layout.test.mjs public/scripts/tik/layout.js
git commit -m "feat(tik): pure slide layout geometry (letterbox + caption band)"
```

---

## Task 4: Caption wrapping + font fit

**Files:**
- Create: `public/scripts/tik/caption.js`
- Create: `test/tik/caption.test.mjs`

Text width depends on the font, which only a canvas context can measure. To keep the logic pure and testable, `wrapLines` takes a `measure(str) => widthPx` callback. In the browser we pass `s => ctx.measureText(s).width`; in tests we pass a fake measurer.

- [ ] **Step 1: Write the failing test**

Create `test/tik/caption.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapLines, fitFontSize } from '../../public/scripts/tik/caption.js';

// Fake measurer: every character is 10px wide.
const measure10 = (s) => s.length * 10;

test('wrapLines greedily fills lines up to maxWidth', () => {
  // maxWidth 100 → 10 chars per line
  const lines = wrapLines('hello world foo', 100, measure10);
  assert.deepEqual(lines, ['hello', 'world foo']);
});

test('wrapLines keeps a single over-long word on its own line', () => {
  const lines = wrapLines('supercalifragilistic hi', 100, measure10);
  assert.deepEqual(lines, ['supercalifragilistic', 'hi']);
});

test('wrapLines preserves explicit newlines', () => {
  const lines = wrapLines('a\nb c', 100, measure10);
  assert.deepEqual(lines, ['a', 'b c']);
});

test('wrapLines on empty/whitespace returns a single empty line', () => {
  assert.deepEqual(wrapLines('   ', 100, measure10), ['']);
});

test('fitFontSize shrinks so all lines fit the band height', () => {
  // 4 lines, band 400px, lineHeightFactor 1.25 → 400/(4*1.25)=80, capped at maxFont
  assert.equal(fitFontSize(4, 400, { lineHeightFactor: 1.25, maxFont: 100 }), 80);
  // capped by maxFont when there's plenty of room
  assert.equal(fitFontSize(1, 4000, { lineHeightFactor: 1.25, maxFont: 100 }), 100);
  // never below minFont
  assert.equal(fitFontSize(50, 100, { lineHeightFactor: 1.25, maxFont: 100, minFont: 24 }), 24);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `caption.js`.

- [ ] **Step 3: Write the implementation**

Create `public/scripts/tik/caption.js`:

```js
// Pure caption layout: word-wrap by measured width, and choose a font size that
// fits N lines into the band. `measure` is injected so this stays DOM-free.

// Greedy word wrap. `measure(str) => widthPx`. Honors explicit "\n".
export function wrapLines(text, maxWidth, measure) {
  const source = String(text ?? '');
  const paragraphs = source.split('\n');
  const out = [];

  for (const para of paragraphs) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]}`;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
      } else {
        out.push(line);
        line = words[i];
      }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

// Largest font (px) so `lineCount` lines fit `bandHeight`, clamped to [minFont, maxFont].
export function fitFontSize(lineCount, bandHeight, opts = {}) {
  const lineHeightFactor = opts.lineHeightFactor ?? 1.25;
  const maxFont = opts.maxFont ?? 72;
  const minFont = opts.minFont ?? 24;
  const n = Math.max(1, lineCount);
  const ideal = Math.floor(bandHeight / (n * lineHeightFactor));
  return Math.max(minFont, Math.min(maxFont, ideal));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/tik/caption.test.mjs public/scripts/tik/caption.js
git commit -m "feat(tik): pure caption word-wrap + font-fit (injected measurer)"
```

---

## Task 5: TikTok init-payload builder (server lib)

**Files:**
- Create: `netlify/functions/lib/tiktok-payload.mjs`
- Create: `test/tik/tiktok-payload.test.mjs`

This is the exact JSON body sent to `content/init/`. It lives server-side (built by `tik-publish`) but is pure and unit-tested.

- [ ] **Step 1: Write the failing test**

Create `test/tik/tiktok-payload.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PHOTOS, validateForInit, buildInitPayload,
} from '../../netlify/functions/lib/tiktok-payload.mjs';

test('validateForInit rejects empty photo list', () => {
  const r = validateForInit({ photoUrls: [], coverIndex: 0 });
  assert.equal(r.ok, false);
});

test('validateForInit rejects more than MAX_PHOTOS', () => {
  const photoUrls = Array.from({ length: MAX_PHOTOS + 1 }, (_, i) => `https://x/${i}.jpg`);
  assert.equal(validateForInit({ photoUrls, coverIndex: 0 }).ok, false);
});

test('validateForInit rejects a cover index out of range', () => {
  assert.equal(validateForInit({ photoUrls: ['https://x/0.jpg'], coverIndex: 5 }).ok, false);
});

test('validateForInit rejects non-https urls', () => {
  assert.equal(validateForInit({ photoUrls: ['http://x/0.jpg'], coverIndex: 0 }).ok, false);
});

test('validateForInit accepts a good set', () => {
  assert.equal(validateForInit({ photoUrls: ['https://x/0.jpg'], coverIndex: 0 }).ok, true);
});

test('buildInitPayload produces the PHOTO / MEDIA_UPLOAD / PULL_FROM_URL body', () => {
  const body = buildInitPayload({
    photoUrls: ['https://x/0.jpg', 'https://x/1.jpg'],
    coverIndex: 1,
    title: 'Jaws (1975)',
    description: '#movietrivia',
  });
  assert.equal(body.media_type, 'PHOTO');
  assert.equal(body.post_mode, 'MEDIA_UPLOAD');
  assert.equal(body.source_info.source, 'PULL_FROM_URL');
  assert.deepEqual(body.source_info.photo_images, ['https://x/0.jpg', 'https://x/1.jpg']);
  assert.equal(body.source_info.photo_cover_index, 1);
  assert.equal(body.post_info.title, 'Jaws (1975)');
  assert.equal(body.post_info.description, '#movietrivia');
});

test('buildInitPayload truncates title to 90 and description to 4000 UTF-16 units', () => {
  const body = buildInitPayload({
    photoUrls: ['https://x/0.jpg'],
    coverIndex: 0,
    title: 'x'.repeat(200),
    description: 'y'.repeat(5000),
  });
  assert.equal(body.post_info.title.length, 90);       // .length == UTF-16 code units
  assert.equal(body.post_info.description.length, 4000);
});

test('buildInitPayload does not split a surrogate pair when truncating', () => {
  // '😀' is 2 UTF-16 units. A title of 46 emoji = 92 units; truncating to 90
  // must drop the last whole emoji, not leave a dangling half-surrogate.
  const body = buildInitPayload({
    photoUrls: ['https://x/0.jpg'], coverIndex: 0, title: '😀'.repeat(46),
  });
  assert.ok(body.post_info.title.length <= 90);
  assert.equal(body.post_info.title, '😀'.repeat(45)); // 90 units, no broken pair
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `lib/tiktok-payload.mjs`.

- [ ] **Step 3: Write the implementation**

Create `netlify/functions/lib/tiktok-payload.mjs`:

```js
// Pure builder + validator for the TikTok Content Posting API photo init body.
// Endpoint: POST https://open.tiktokapis.com/v2/post/publish/content/init/
// Docs verified 2026-07-01: media_type PHOTO, post_mode MEDIA_UPLOAD (draft to
// inbox), source PULL_FROM_URL, up to 35 https photo_images, title<=90,
// description<=4000 (UTF-16 runes).

export const MAX_PHOTOS = 35;
const TITLE_MAX = 90;
const DESC_MAX = 4000;

// TikTok counts title/description limits in UTF-16 code units (its "runes").
// Truncate by code units to match, but never split a surrogate pair (which
// would leave a broken emoji), so drop a trailing lone high surrogate.
function truncateUtf16(str, max) {
  const s = String(str ?? '');
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // dangling high surrogate
  return cut;
}

export function validateForInit({ photoUrls, coverIndex }) {
  if (!Array.isArray(photoUrls) || photoUrls.length === 0) {
    return { ok: false, error: 'No photos to post' };
  }
  if (photoUrls.length > MAX_PHOTOS) {
    return { ok: false, error: `Too many photos (max ${MAX_PHOTOS})` };
  }
  if (!photoUrls.every(u => typeof u === 'string' && u.startsWith('https://'))) {
    return { ok: false, error: 'All photo URLs must be https' };
  }
  if (!Number.isInteger(coverIndex) || coverIndex < 0 || coverIndex >= photoUrls.length) {
    return { ok: false, error: 'Cover index out of range' };
  }
  return { ok: true };
}

export function buildInitPayload({ photoUrls, coverIndex = 0, title = '', description = '' }) {
  return {
    media_type: 'PHOTO',
    post_mode: 'MEDIA_UPLOAD',
    post_info: {
      title: truncateUtf16(title, TITLE_MAX),
      description: truncateUtf16(description, DESC_MAX),
    },
    source_info: {
      source: 'PULL_FROM_URL',
      photo_cover_index: coverIndex,
      photo_images: photoUrls,
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/tik/tiktok-payload.test.mjs netlify/functions/lib/tiktok-payload.mjs
git commit -m "feat(tik): TikTok init-payload builder + validator"
```

---

## Task 6: `tik-auth` Netlify function (TikTok OAuth)

**Files:**
- Create: `netlify/functions/tik-auth.mjs`

Uses TikTok's **Login Kit for Web** flow (confidential client): the browser redirects to `https://www.tiktok.com/v2/auth/authorize/` with `client_key`/`scope`/`response_type=code`/`redirect_uri`/`state` (no PKCE — `/tik` is server-backed and holds the secret), then this function exchanges the returned `code` at `https://open.tiktokapis.com/v2/oauth/token/` using `client_key` + `client_secret`. Revoke at `https://open.tiktokapis.com/v2/oauth/revoke/`. No unit test (pure network I/O against TikTok); verified manually in Task 13/16.

> **Why Web flow, not PKCE:** TikTok documents `code_challenge` only for the Desktop/Mobile Login Kit, and its PKCE requires a **hex**-encoded SHA-256 challenge (not RFC-7636 base64url) — an easy footgun. A server-backed web app that already holds `TIKTOK_CLIENT_SECRET` should use the Web flow and authenticate the exchange with the secret. Source: https://developers.tiktok.com/doc/login-kit-web

- [ ] **Step 1: Write the function**

Create `netlify/functions/tik-auth.mjs`:

```js
// TikTok OAuth helper for the /tik page. Mirrors youtube-auth.mjs.
// - GET  → returns the public client_key so the browser can build the auth URL.
// - POST action=exchange → swaps a PKCE auth code for access + refresh tokens.
// - POST action=refresh  → swaps a refresh token for a fresh access token.
// - POST action=revoke   → revokes a token at TikTok.

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const REVOKE_URL = 'https://open.tiktokapis.com/v2/oauth/revoke/';

export default async (req) => {
  if (req.method === 'GET') {
    if (!CLIENT_KEY) return json({ error: 'TikTok OAuth not configured' }, 500);
    return json({ clientKey: CLIENT_KEY });
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!CLIENT_KEY || !CLIENT_SECRET) return json({ error: 'TikTok OAuth not configured' }, 500);

  const body = await req.json().catch(() => ({}));

  if (body.action === 'exchange') {
    const { code, redirectUri } = body;
    if (!code || !redirectUri) {
      return json({ error: 'Missing code or redirectUri' }, 400);
    }
    const data = await postForm({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    if (data.error && data.error !== 'ok') {
      return json({ error: data.error_description || data.error }, 400);
    }
    if (!data.refresh_token) {
      return json({ error: 'TikTok did not return a refresh token — try signing in again.' }, 400);
    }
    return json({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      openId: data.open_id,
    });
  }

  if (body.action === 'refresh') {
    const { refreshToken } = body;
    if (!refreshToken) return json({ error: 'Missing refreshToken' }, 400);
    const data = await postForm({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    if (!data.access_token) {
      return json({ error: data.error_description || 'Could not refresh token' }, 401);
    }
    return json({
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresIn: data.expires_in,
    });
  }

  if (body.action === 'revoke') {
    const { token } = body;
    if (!token) return json({ error: 'Missing token' }, 400);
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_key: CLIENT_KEY, client_secret: CLIENT_SECRET, token }),
    }).catch(() => {});
    return json({ ok: true });
  }

  return json({ error: 'Unknown action. Use exchange, refresh, or revoke.' }, 400);
};

async function postForm(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return res.json().catch(() => ({}));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

- [ ] **Step 2: Sanity-check the module loads (no syntax errors)**

Run: `node --check netlify/functions/tik-auth.mjs`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/tik-auth.mjs
git commit -m "feat(tik): tik-auth function (TikTok PKCE OAuth exchange/refresh/revoke)"
```

---

## Task 7: `tik-media` Netlify function (host JPEGs on Blobs)

**Files:**
- Create: `netlify/functions/tik-media.mjs`

`POST` stores raw JPEG bytes in Netlify Blobs under a random id and returns a public HTTPS URL on the deployed domain. `GET ?id=…` streams the bytes back with `Content-Type: image/jpeg` and **no redirect** (TikTok forbids redirects). Old blobs are swept on write.

- [ ] **Step 1: Write the function**

Create `netlify/functions/tik-media.mjs`:

```js
// Hosts composited slide JPEGs so TikTok's PULL_FROM_URL can fetch them.
// POST (image/jpeg bytes) → store in Blobs, return { url }.
// GET ?id=<id>            → stream the JPEG (no redirect, https on the deployed domain).
import { getStore } from '@netlify/blobs';

const STORE = 'tik-slides';
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h — well past TikTok's 1h pull window.
const MAX_BYTES = 8 * 1024 * 1024;     // guardrail per image.

export default async (req) => {
  const store = getStore(STORE);
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const id = url.searchParams.get('id');
    if (!id) return new Response('Missing id', { status: 400 });
    const buf = await store.get(id, { type: 'arrayBuffer' });
    if (!buf) return new Response('Not found', { status: 404 });
    return new Response(buf, {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' },
    });
  }

  if (req.method === 'POST') {
    const buf = await req.arrayBuffer();
    if (!buf || buf.byteLength === 0) return json({ error: 'Empty body' }, 400);
    if (buf.byteLength > MAX_BYTES) return json({ error: 'Image too large' }, 413);

    await sweepOldBlobs(store);

    const id = crypto.randomUUID();
    await store.set(id, buf, { metadata: { createdAt: Date.now() } });
    // Build an absolute, non-redirecting URL on this deployed origin.
    const publicUrl = `${url.origin}/.netlify/functions/tik-media?id=${id}`;
    return json({ url: publicUrl, id });
  }

  return json({ error: 'Method not allowed' }, 405);
};

async function sweepOldBlobs(store) {
  try {
    const { blobs } = await store.list();
    const now = Date.now();
    await Promise.all(
      blobs.map(async (b) => {
        const meta = await store.getMetadata(b.key).catch(() => null);
        const createdAt = meta?.metadata?.createdAt ?? 0;
        if (now - createdAt > MAX_AGE_MS) await store.delete(b.key).catch(() => {});
      })
    );
  } catch {
    // Sweeping is best-effort; never block an upload on cleanup.
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

- [ ] **Step 2: Sanity-check the module loads**

Run: `node --check netlify/functions/tik-media.mjs`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/tik-media.mjs
git commit -m "feat(tik): tik-media function (Blobs-hosted slide JPEGs for PULL_FROM_URL)"
```

---

## Task 8: `tik-publish` Netlify function (init draft + poll)

**Files:**
- Create: `netlify/functions/tik-publish.mjs`

Takes the caller's refresh token + hosted photo URLs, gets a fresh access token via `tik-auth`'s refresh logic (re-implemented here to avoid an internal HTTP hop), calls `content/init/`, then polls `status/fetch/`.

- [ ] **Step 1: Write the function**

Create `netlify/functions/tik-publish.mjs`:

```js
// Creates a TikTok photo-slideshow draft from hosted image URLs.
// Body: { refreshToken, photoUrls:[https...], coverIndex, title?, description? }
import { buildInitPayload, validateForInit } from './lib/tiktok-payload.mjs';

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/content/init/';
const STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  if (!CLIENT_KEY || !CLIENT_SECRET) return json({ error: 'TikTok OAuth not configured' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { refreshToken, photoUrls, coverIndex = 0, title = '', description = '' } = body;
  if (!refreshToken) return json({ error: 'Not signed in' }, 401);

  const check = validateForInit({ photoUrls, coverIndex });
  if (!check.ok) return json({ error: check.error }, 400);

  const accessToken = await getAccessToken(refreshToken);
  if (!accessToken) return json({ error: 'Could not get access token — please sign in again' }, 401);

  // Initialize the draft.
  const initRes = await fetch(INIT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(buildInitPayload({ photoUrls, coverIndex, title, description })),
  });
  const initData = await initRes.json().catch(() => ({}));
  const publishId = initData?.data?.publish_id;
  if (!publishId) {
    const msg = initData?.error?.message || 'TikTok rejected the post';
    return json({ error: msg, hint: hintForError(initData?.error), tiktok: initData?.error }, 400);
  }

  // Poll status a bounded number of times.
  const status = await pollStatus(accessToken, publishId);
  return json({ publishId, status });
};

// Map known TikTok init errors to a one-line developer-portal hint, so the UI
// can show the verbatim TikTok message PLUS actionable guidance.
function hintForError(err) {
  const code = String(err?.code || '').toLowerCase();
  const msg = String(err?.message || '').toLowerCase();
  const blob = code + ' ' + msg;
  if (blob.includes('url_ownership') || blob.includes('unverified') || blob.includes('domain')) {
    return 'Add this site’s domain (and the /.netlify/functions/tik-media URL prefix) under “URL properties” in the TikTok developer portal.';
  }
  if (blob.includes('unaudited') || blob.includes('private')) {
    return 'Unaudited apps can only post private drafts — this is expected for the draft-to-inbox MVP.';
  }
  if (blob.includes('scope') || blob.includes('permission')) {
    return 'Request the video.upload scope for your app and re-authorize.';
  }
  if (blob.includes('user') && (blob.includes('target') || blob.includes('tester'))) {
    return 'Add this TikTok account as a target user / tester on your app in the developer portal.';
  }
  return '';
}

async function getAccessToken(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json().catch(() => ({}));
  return data.access_token || null;
}

// TikTok status enum (get-status reference): PROCESSING_DOWNLOAD / PROCESSING_UPLOAD
// are non-terminal; SEND_TO_USER_INBOX is the terminal SUCCESS for a MEDIA_UPLOAD
// (draft-to-inbox) post; PUBLISH_COMPLETE for direct posts; FAILED on error.
// For PULL_FROM_URL photos the in-flight state is PROCESSING_DOWNLOAD.
async function pollStatus(accessToken, publishId, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(STATUS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({ publish_id: publishId }),
    });
    const data = await res.json().catch(() => ({}));
    const status = data?.data?.status;
    if (status && status !== 'PROCESSING_UPLOAD' && status !== 'PROCESSING_DOWNLOAD') {
      return status; // terminal: SEND_TO_USER_INBOX | PUBLISH_COMPLETE | FAILED
    }
    await sleep(1500);
  }
  return 'PROCESSING_DOWNLOAD'; // timed out still downloading; the draft may still land shortly.
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

- [ ] **Step 2: Sanity-check the module loads**

Run: `node --check netlify/functions/tik-publish.mjs`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/tik-publish.mjs
git commit -m "feat(tik): tik-publish function (content/init draft + status poll)"
```

---

## Task 9: `tik.astro` page shell + responsive layout

**Files:**
- Create: `src/pages/tik.astro`

Two-pane on desktop (capture left, slides right), single column on mobile. Uses Tailwind v4 (already wired via `@tailwindcss/vite`). Loads the client entry `app.js` with the `BUILD_ID` cache-buster, exactly like `capture.astro`.

- [ ] **Step 1: Write the page**

Create `src/pages/tik.astro`:

```astro
---
import Base from '../layouts/Base.astro';
import { BUILD_ID } from '../utils/build-id.js';
---
<Base title="/tik" description="Movie-trivia TikTok slideshow maker">
  <meta slot="head" name="robots" content="noindex" />

  <div class="min-h-screen bg-neutral-950 text-neutral-100">
    <header class="flex items-center gap-3 px-4 py-3 border-b border-neutral-800">
      <span class="text-xl">🎬 → 📱</span>
      <h1 class="text-lg font-bold">/tik</h1>
      <span class="text-xs text-neutral-500">movie-trivia slideshow maker</span>
      <div class="ml-auto flex items-center gap-2">
        <span id="auth-status" class="text-xs text-neutral-400">not signed in</span>
        <button id="auth-btn" class="rounded bg-neutral-800 px-3 py-1.5 text-xs font-semibold">Sign in to TikTok</button>
      </div>
    </header>

    <main class="grid gap-4 p-4 lg:grid-cols-2">
      <!-- Capture pane -->
      <section class="flex flex-col gap-3">
        <label class="block">
          <span class="text-xs uppercase tracking-wide text-neutral-500">Video file</span>
          <input id="file-input" type="file" accept="video/*"
                 class="mt-1 block w-full text-sm file:mr-3 file:rounded file:border-0 file:bg-red-600 file:px-3 file:py-2 file:text-white" />
        </label>

        <video id="video" class="w-full rounded-lg bg-black" playsinline muted></video>

        <!-- Chunky scrubber -->
        <div id="scrubber" class="select-none">
          <input id="scrub-range" type="range" min="0" max="1000" value="0"
                 class="h-7 w-full cursor-pointer accent-red-600" />
          <div class="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span id="timecode" class="tabular-nums text-neutral-300">00:00.000</span>
            <button id="step-back" class="rounded bg-neutral-800 px-2 py-1">⏮ −1f</button>
            <button id="step-fwd" class="rounded bg-neutral-800 px-2 py-1">+1f ⏭</button>
            <button id="grab-btn" class="ml-auto rounded bg-red-600 px-4 py-2 font-bold text-white">＋ Grab frame</button>
          </div>
        </div>

        <label class="flex items-center gap-2 text-sm text-neutral-400">
          <input id="title-toggle" type="checkbox" class="accent-red-600" />
          Prefix every slide with a title
          <input id="movie-title" type="text" placeholder="e.g. Jaws (1975)"
                 class="ml-1 flex-1 rounded bg-neutral-900 px-2 py-1 text-neutral-100" disabled />
        </label>
      </section>

      <!-- Slides pane -->
      <section class="flex flex-col gap-3">
        <div class="flex items-center justify-between">
          <h2 class="text-sm uppercase tracking-wide text-neutral-500">
            Slides (<span id="slide-count">0</span>/35)
          </h2>
          <button id="post-btn" class="rounded bg-red-600 px-4 py-2 font-bold text-white disabled:opacity-40" disabled>
            Post to TikTok ▲
          </button>
        </div>
        <p id="post-status" class="text-xs text-neutral-400"></p>
        <ol id="slide-list" class="flex flex-col gap-2"></ol>
      </section>
    </main>
  </div>

  <script type="module" src={`/scripts/tik/app.js?v=${BUILD_ID}`}></script>
</Base>
```

> **Why `<Base>`:** Tailwind ships only via `global.css`, which only `Base.astro` imports. A bare `<!doctype html>` page builds but ships no CSS — every class would be inert. `Base` also supplies `<meta charset>`, viewport, title, and the `<slot name="head" />` used above for `noindex`. The thumbnails in Task 15 render at full 1080×1920 and are shrunk with CSS, so no hidden compose canvas is needed in the page.

- [ ] **Step 2: Create a temporary no-op entry so the page loads**

Create `public/scripts/tik/app.js` with a placeholder (replaced in Task 15):

```js
console.log('[tik] loaded');
```

- [ ] **Step 3: Verify the page builds and renders**

Run: `npm run build`
Expected: build succeeds; `dist/tik/index.html` exists.

Then run `npm run dev`, open `http://localhost:4321/tik`, and confirm the two-pane layout renders (single column when the window is narrow) and the console prints `[tik] loaded`.

- [ ] **Step 4: Commit**

```bash
git add src/pages/tik.astro public/scripts/tik/app.js
git commit -m "feat(tik): page shell with responsive two-pane/stacked layout"
```

---

## Task 10: `capture.js` — load video + grab a frame

**Files:**
- Create: `public/scripts/tik/capture.js`

DOM/canvas code (verified manually). Loads a local file into the `<video>` and grabs the current frame as an `ImageBitmap` at native resolution.

- [ ] **Step 1: Write the module**

Create `public/scripts/tik/capture.js`:

```js
// Load a local video file into a <video> element and grab frames from it.
// Browser-only (uses URL, canvas, createImageBitmap). Verified manually.

let objectUrl = null;

// Point the <video> at a local File. Resolves once metadata (dimensions,
// duration) is known. Rejects if the browser can't decode the file.
export function loadVideoFile(file, videoEl) {
  return new Promise((resolve, reject) => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    videoEl.src = objectUrl;
    videoEl.onloadedmetadata = () => resolve({
      duration: videoEl.duration,
      width: videoEl.videoWidth,
      height: videoEl.videoHeight,
    });
    videoEl.onerror = () =>
      reject(new Error("This browser can't decode that video file."));
  });
}

// Draw the current video frame to an offscreen canvas and return an ImageBitmap
// at the source's native resolution.
export async function grabFrame(videoEl) {
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;
  if (!w || !h) throw new Error('No video frame available yet.');
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(videoEl, 0, 0, w, h);
  return await createImageBitmap(canvas);
}
```

- [ ] **Step 2: Syntax-check**

Run: `node --check public/scripts/tik/capture.js`
Expected: no output (exit 0). (Full behavior is verified in Task 15's manual run.)

- [ ] **Step 3: Commit**

```bash
git add public/scripts/tik/capture.js
git commit -m "feat(tik): capture module (load video file, grab frame to ImageBitmap)"
```

---

## Task 11: `scrubber.js` — chunky scrubber control

**Files:**
- Create: `public/scripts/tik/scrubber.js`

Binds the range input + timecode + frame-step buttons to the `<video>`. Uses `frameStep`/`formatTimecode` from `timecode.js`.

- [ ] **Step 1: Write the module**

Create `public/scripts/tik/scrubber.js`:

```js
// Wire the chunky scrubber (range input, timecode readout, ±1 frame buttons)
// to a <video>. Browser-only. Pure time math lives in timecode.js.
import { formatTimecode, frameStep } from './timecode.js';

const RANGE_MAX = 1000; // range input resolution (0..1000 mapped to 0..duration)

export function initScrubber({ video, range, timecode, stepBack, stepFwd, fps = 30 }) {
  const sync = () => {
    const d = video.duration || 0;
    if (d > 0) range.value = String(Math.round((video.currentTime / d) * RANGE_MAX));
    timecode.textContent = formatTimecode(video.currentTime);
  };

  const seekToRange = () => {
    const d = video.duration || 0;
    video.currentTime = (Number(range.value) / RANGE_MAX) * d;
  };

  range.addEventListener('input', seekToRange);
  video.addEventListener('timeupdate', sync);
  video.addEventListener('loadedmetadata', sync);
  video.addEventListener('seeked', sync);

  stepBack.addEventListener('click', () => { video.currentTime = frameStep(video.currentTime, -1, fps); });
  stepFwd.addEventListener('click', () => { video.currentTime = frameStep(video.currentTime, 1, fps); });

  return { sync };
}
```

- [ ] **Step 2: Syntax-check**

Run: `node --check public/scripts/tik/scrubber.js`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add public/scripts/tik/scrubber.js
git commit -m "feat(tik): chunky scrubber control (range + timecode + frame step)"
```

---

## Task 12: `compose.js` — render the final slide JPEG

**Files:**
- Create: `public/scripts/tik/compose.js`

Exports `composeToCanvas()` — draws the composed slide onto any canvas you pass, reused by the live preview thumbnails (Task 15) — and `composeSlide()`, which renders offscreen and returns a JPEG `Blob` for upload. Uses `computeSlideLayout` (layout.js) + `wrapLines`/`fitFontSize` (caption.js). Re-wraps at the *final* font size so the drawn lines are the measured lines, with a vertical-overflow guard.

- [ ] **Step 1: Write the module**

Create `public/scripts/tik/compose.js`:

```js
// Compose one slide: frame (letterboxed, top) + solid caption band (below) on a
// 1080x1920 canvas. composeToCanvas() draws onto a canvas you own (used by the
// live preview thumbnails); composeSlide() renders offscreen → JPEG Blob (upload).
import { computeSlideLayout } from './layout.js';
import { wrapLines, fitFontSize } from './caption.js';

const BAND_BG = '#111111';
const TEXT_COLOR = '#ffffff';
const FONT = (size) => `600 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
const PAD = 56;         // padding inside the band
const LINE_HEIGHT = 1.25;
const MIN_FONT = 28;
const MAX_FONT = 84;

// Draw the composed slide onto `cvs`. Only touches the canvas you pass in.
// Reused for the preview thumbnails (scale < 1, cheap raster) and the upload
// path (scale 1 → full 1080x1920). Layout math stays in 1080x1920 space; we
// scale the raster with ctx.scale so text stays crisp.
// bitmap: ImageBitmap; caption: string; titleLine?: prefix; scale?: raster scale.
export function composeToCanvas(cvs, bitmap, caption, { titleLine = '', scale = 1 } = {}) {
  const L = computeSlideLayout(bitmap.width, bitmap.height);
  cvs.width = Math.round(L.canvas.w * scale);
  cvs.height = Math.round(L.canvas.h * scale);
  const ctx = cvs.getContext('2d');
  ctx.scale(scale, scale); // draw in 1080x1920 coords regardless of raster size

  // Background + frame.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, L.canvas.w, L.canvas.h);
  ctx.drawImage(bitmap, L.frame.x, L.frame.y, L.frame.w, L.frame.h);

  // Caption band.
  ctx.fillStyle = BAND_BG;
  ctx.fillRect(L.band.x, L.band.y, L.band.w, L.band.h);

  const fullText = titleLine ? `${titleLine}\n${caption}` : caption;
  const maxTextW = L.band.w - PAD * 2;
  const maxTextH = L.band.h - PAD * 2;

  // measureText width scales ~linearly with font-size for a fixed string, so we
  // measure once at a reference size and scale. Converge the font size over 2
  // passes, then RE-WRAP at the final size so the drawn lines ARE the measured
  // lines (fixing stale-lines overflow), with a vertical-overflow guard.
  const REF = 100;
  ctx.font = FONT(REF);
  const measureAtRef = (s) => ctx.measureText(s).width;
  const wrapAt = (size) => wrapLines(fullText, maxTextW / (size / REF), measureAtRef);

  let fontSize = 64;
  for (let pass = 0; pass < 2; pass++) {
    fontSize = fitFontSize(wrapAt(fontSize).length, maxTextH, { maxFont: MAX_FONT, minFont: MIN_FONT });
  }
  let lines = wrapAt(fontSize);
  while (fontSize > MIN_FONT && lines.length * fontSize * LINE_HEIGHT > maxTextH) {
    fontSize -= 2;
    lines = wrapAt(fontSize);
  }

  ctx.font = FONT(fontSize);
  ctx.fillStyle = TEXT_COLOR;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const lh = fontSize * LINE_HEIGHT;
  let y = L.band.y + (L.band.h - lines.length * lh) / 2;
  const cx = L.canvas.w / 2;
  for (const line of lines) { ctx.fillText(line, cx, y); y += lh; }
}

// Render to an offscreen canvas and return a JPEG Blob for upload.
export async function composeSlide(bitmap, caption, opts = {}) {
  const cvs = document.createElement('canvas');
  composeToCanvas(cvs, bitmap, caption, opts);
  return await new Promise((resolve) => cvs.toBlob(resolve, 'image/jpeg', 0.9));
}
```

- [ ] **Step 2: Syntax-check**

Run: `node --check public/scripts/tik/compose.js`
Expected: no output (exit 0). (Pixel output is verified in Task 15's manual run.)

- [ ] **Step 3: Commit**

```bash
git add public/scripts/tik/compose.js
git commit -m "feat(tik): compose module (frame + caption band → JPEG blob)"
```

---

## Task 13: `auth.js` — TikTok PKCE client flow

**Files:**
- Create: `public/scripts/tik/auth.js`
- Create: `test/tik/auth.test.mjs`

TikTok **Login Kit for Web**: redirect to the authorize URL, then exchange the returned `code` server-side in `tik-auth`. No PKCE (server-backed confidential client). Refresh token in `localStorage`. `buildAuthorizeUrl` is pure and unit-tested; the redirect handling is browser-only.

- [ ] **Step 1: Write the failing test (for the pure URL builder)**

Create `test/tik/auth.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthorizeUrl } from '../../public/scripts/tik/auth.js';

test('buildAuthorizeUrl builds the TikTok Web login URL', () => {
  const u = new URL(buildAuthorizeUrl({
    clientKey: 'ck123',
    redirectUri: 'https://vhs.example/tik',
    state: 'st',
  }));
  assert.equal(u.origin + u.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
  assert.equal(u.searchParams.get('client_key'), 'ck123');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('scope'), 'user.info.basic,video.upload');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://vhs.example/tik');
  assert.equal(u.searchParams.get('state'), 'st');
});

test('buildAuthorizeUrl omits PKCE params (Web flow)', () => {
  const u = new URL(buildAuthorizeUrl({ clientKey: 'ck', redirectUri: 'https://x/tik', state: 's' }));
  assert.equal(u.searchParams.get('code_challenge'), null);
  assert.equal(u.searchParams.get('code_challenge_method'), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `auth.js`.

- [ ] **Step 3: Write the module**

Create `public/scripts/tik/auth.js`:

```js
// TikTok OAuth (Login Kit for Web) on the client. /tik is server-backed and the
// code exchange happens in tik-auth.mjs with the client secret, so there is no
// PKCE. The refresh token lives in localStorage, same trust model as the YouTube
// flow. buildAuthorizeUrl is pure (unit-tested); the rest is browser-only
// (sessionStorage, localStorage, location) and only inside functions.

const AUTHORIZE_BASE = 'https://www.tiktok.com/v2/auth/authorize/';
const SCOPE = 'user.info.basic,video.upload';
const LS_REFRESH = 'tik_refresh_token';
const SS_STATE = 'tik_oauth_state';

export function buildAuthorizeUrl({ clientKey, redirectUri, state }) {
  const p = new URLSearchParams({
    client_key: clientKey,
    scope: SCOPE,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
  });
  return `${AUTHORIZE_BASE}?${p.toString()}`;
}

export function isSignedIn() {
  return !!localStorage.getItem(LS_REFRESH);
}
export function getRefreshToken() {
  return localStorage.getItem(LS_REFRESH);
}
// Drop the stored token WITHOUT revoking — for when TikTok reports it already
// invalid (401) and we just want to force a fresh sign-in.
export function clearLocalToken() {
  localStorage.removeItem(LS_REFRESH);
}

function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Kick off sign-in: fetch client_key, set a CSRF state, redirect to TikTok.
export async function startAuth() {
  const { clientKey } = await fetch('/.netlify/functions/tik-auth').then((r) => r.json());
  if (!clientKey) throw new Error('TikTok OAuth is not configured on the server.');
  const state = randomHex(16);
  sessionStorage.setItem(SS_STATE, state);
  const redirectUri = location.origin + location.pathname;
  location.href = buildAuthorizeUrl({ clientKey, redirectUri, state });
}

// On page load: if we came back with ?code=&state=, exchange it for tokens.
// Returns true if a sign-in was completed on this load.
export async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const state = params.get('state');
  if (!code) return false;
  const expectedState = sessionStorage.getItem(SS_STATE);
  // Clean the URL regardless of outcome.
  history.replaceState({}, '', location.origin + location.pathname);
  if (!expectedState || state !== expectedState) throw new Error('OAuth state mismatch — try again.');

  const redirectUri = location.origin + location.pathname;
  const res = await fetch('/.netlify/functions/tik-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'exchange', code, redirectUri }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  localStorage.setItem(LS_REFRESH, data.refreshToken);
  sessionStorage.removeItem(SS_STATE);
  return true;
}

export async function signOut() {
  const token = getRefreshToken();
  clearLocalToken();
  if (token) {
    await fetch('/.netlify/functions/tik-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'revoke', token }),
    }).catch(() => {});
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — both `buildAuthorizeUrl` tests green. (The test only imports `buildAuthorizeUrl`; `localStorage`/`sessionStorage`/`location`/`crypto` are referenced only inside other functions, so the module imports cleanly under Node.)

- [ ] **Step 5: Commit**

```bash
git add test/tik/auth.test.mjs public/scripts/tik/auth.js
git commit -m "feat(tik): TikTok PKCE client auth (authorize/exchange/refresh/revoke)"
```

---

## Task 14: `publish.js` — compose, upload, publish

**Files:**
- Create: `public/scripts/tik/publish.js`

Orchestrates the network side from the browser: compose each slide → upload each JPEG to `tik-media` → POST the URL list to `tik-publish`. Reports progress via a callback.

- [ ] **Step 1: Write the module**

Create `public/scripts/tik/publish.js`:

```js
// Client-side publish orchestration: compose → upload each JPEG to tik-media →
// send URL list + refresh token to tik-publish. onProgress(msg) drives the UI.
import { composeSlide } from './compose.js';
import { getRefreshToken } from './auth.js';

async function uploadJpeg(blob) {
  const res = await fetch('/.netlify/functions/tik-media', {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: blob,
  });
  const data = await res.json();
  if (!res.ok || !data.url) throw new Error(data.error || 'Upload failed');
  return data.url;
}

// slides: [{ bitmap, caption }]; opts: { title, description, coverIndex, titleLine, onProgress }
export async function publishSlideshow(slides, opts = {}) {
  const { title = '', description = '', coverIndex = 0, titleLine = '', onProgress = () => {} } = opts;
  const refreshToken = getRefreshToken();
  if (!refreshToken) throw new Error('Sign in to TikTok first.');
  if (slides.length === 0) throw new Error('Grab at least one frame first.');

  const photoUrls = [];
  for (let i = 0; i < slides.length; i++) {
    onProgress(`Rendering slide ${i + 1}/${slides.length}…`);
    const blob = await composeSlide(slides[i].bitmap, slides[i].caption, { titleLine });
    onProgress(`Uploading slide ${i + 1}/${slides.length}…`);
    photoUrls.push(await uploadJpeg(blob));
  }

  onProgress('Sending to TikTok…');
  const res = await fetch('/.netlify/functions/tik-publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken, photoUrls, coverIndex, title, description }),
  });
  const data = await res.json().catch(() => ({}));
  // 401 → token dead; signal the caller to clear it and re-auth.
  if (res.status === 401) {
    throw Object.assign(new Error('Your TikTok session expired — please sign in again.'), { reauth: true });
  }
  if (!res.ok || data.error) {
    // Append the server's developer-portal hint when present (verbatim + hint).
    throw new Error(data.hint ? `${data.error} — ${data.hint}` : (data.error || 'Post failed'));
  }
  return data; // { publishId, status }
}
```

- [ ] **Step 2: Syntax-check**

Run: `node --check public/scripts/tik/publish.js`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add public/scripts/tik/publish.js
git commit -m "feat(tik): publish orchestration (compose → upload → post)"
```

---

## Task 15: `app.js` — wire everything + slide-list UI

**Files:**
- Modify: `public/scripts/tik/app.js` (replace the Task 9 placeholder)

The entry module: file input → capture, scrubber, slide state (via `slides.js` reducers), slide-list rendering with **live composed-slide preview thumbnails** + per-slide caption textareas + drag-to-reorder, auth button, and a post button gated on sign-in / slide count / public origin (with re-auth on a 401).

- [ ] **Step 1: Replace the placeholder with the full entry module**

Overwrite `public/scripts/tik/app.js`:

```js
import { loadVideoFile, grabFrame } from './capture.js';
import { initScrubber } from './scrubber.js';
import { addSlide, removeSlide, reorderSlide, editCaption, canAddSlide, MAX_SLIDES } from './slides.js';
import { startAuth, handleRedirect, signOut, isSignedIn, clearLocalToken } from './auth.js';
import { publishSlideshow } from './publish.js';
import { composeToCanvas } from './compose.js';

const $ = (id) => document.getElementById(id);
const els = {
  file: $('file-input'), video: $('video'),
  range: $('scrub-range'), timecode: $('timecode'),
  stepBack: $('step-back'), stepFwd: $('step-fwd'), grab: $('grab-btn'),
  titleToggle: $('title-toggle'), movieTitle: $('movie-title'),
  count: $('slide-count'), list: $('slide-list'), post: $('post-btn'), status: $('post-status'),
  authBtn: $('auth-btn'), authStatus: $('auth-status'),
};

let slides = [];               // [{ id, bitmap, caption }]
let nextId = 1;
let dragFrom = null;
const PREVIEW_SCALE = 0.25;    // quarter-res preview thumbnails; uploads stay full-res

initScrubber({
  video: els.video, range: els.range, timecode: els.timecode,
  stepBack: els.stepBack, stepFwd: els.stepFwd,
});

// TikTok pulls slide images over the public internet, so posting only works from
// a publicly reachable origin. Grab / caption / compose work anywhere.
function isPublicOrigin() {
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) return false;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false; // private ranges
  return true;
}

// ---- Auth ----
function refreshAuthUI() {
  const signed = isSignedIn();
  els.authStatus.textContent = signed ? 'signed in ✓' : 'not signed in';
  els.authBtn.textContent = signed ? 'Sign out' : 'Sign in to TikTok';
  updatePostButton();
}
els.authBtn.addEventListener('click', async () => {
  try {
    if (isSignedIn()) { await signOut(); } else { await startAuth(); return; }
  } catch (e) { alert(e.message); }
  refreshAuthUI();
});

// ---- File load ----
els.file.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    await loadVideoFile(file, els.video);
    els.status.textContent = 'Loaded. Scrub and grab frames.';
  } catch (err) {
    els.status.textContent = err.message;
  }
});

// ---- Title prefix toggle ----
els.titleToggle.addEventListener('change', () => {
  els.movieTitle.disabled = !els.titleToggle.checked;
  redrawAllThumbs(); // title line appears/disappears on every slide preview
});
els.movieTitle.addEventListener('input', redrawAllThumbs);
function currentTitleLine() {
  return els.titleToggle.checked ? els.movieTitle.value.trim() : '';
}

// ---- Grab ----
els.grab.addEventListener('click', async () => {
  if (!canAddSlide(slides)) { els.status.textContent = `Max ${MAX_SLIDES} slides.`; return; }
  try {
    const bitmap = await grabFrame(els.video);
    slides = addSlide(slides, { id: String(nextId++), bitmap, caption: '' });
    render();
  } catch (err) { els.status.textContent = err.message; }
});

// ---- Slide list rendering ----
function render() {
  els.count.textContent = String(slides.length);
  els.grab.disabled = !canAddSlide(slides);
  els.list.innerHTML = '';
  slides.forEach((slide, index) => els.list.appendChild(renderSlide(slide, index)));
  updatePostButton();
}

// Redraw the preview thumbnails in place (no full re-render) so editing a caption
// or the title updates the live preview without rebuilding the list / losing focus.
function redrawAllThumbs() {
  slides.forEach((slide) => {
    const thumb = els.list.querySelector(`canvas[data-thumb="${slide.id}"]`);
    if (thumb) composeToCanvas(thumb, slide.bitmap, slide.caption, { titleLine: currentTitleLine(), scale: PREVIEW_SCALE });
  });
}

function renderSlide(slide, index) {
  const li = document.createElement('li');
  li.className = 'flex gap-2 rounded-lg bg-neutral-900 p-2';
  li.draggable = true;
  li.dataset.index = String(index);

  // Live preview: the FULL composed slide (frame + caption band), rendered at
  // 1080x1920 by composeToCanvas and shrunk to a thumbnail with CSS.
  const thumb = document.createElement('canvas');
  thumb.dataset.thumb = slide.id;
  thumb.className = 'flex-none rounded bg-black w-[72px] h-auto';
  composeToCanvas(thumb, slide.bitmap, slide.caption, { titleLine: currentTitleLine(), scale: PREVIEW_SCALE });

  const ta = document.createElement('textarea');
  ta.className = 'flex-1 rounded bg-neutral-950 border border-neutral-800 p-2 text-sm text-neutral-100';
  ta.rows = 3;
  ta.placeholder = 'Trivia for this frame…';
  ta.value = slide.caption;
  ta.addEventListener('input', () => {
    slides = editCaption(slides, slide.id, ta.value);
    composeToCanvas(thumb, slide.bitmap, ta.value, { titleLine: currentTitleLine(), scale: PREVIEW_SCALE }); // live preview
  });

  const del = document.createElement('button');
  del.className = 'flex-none self-start rounded bg-neutral-800 px-2 py-1 text-xs';
  del.textContent = '✕';
  del.addEventListener('click', () => { slides = removeSlide(slides, slide.id); render(); });

  li.append(thumb, ta, del);

  // Drag to reorder.
  li.addEventListener('dragstart', () => { dragFrom = index; });
  li.addEventListener('dragover', (e) => e.preventDefault());
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    const to = Number(li.dataset.index);
    if (dragFrom !== null && dragFrom !== to) { slides = reorderSlide(slides, dragFrom, to); render(); }
    dragFrom = null;
  });

  return li;
}

// ---- Post ----
function updatePostButton() {
  const publicOrigin = isPublicOrigin();
  els.post.disabled = !(isSignedIn() && slides.length > 0 && publicOrigin);
  els.post.title = publicOrigin ? '' : 'Posting to TikTok needs the deployed site';
}
els.post.addEventListener('click', async () => {
  els.post.disabled = true;
  try {
    // The movie-title line is intentionally reused as the draft's post title —
    // an editable hint the creator can change in the TikTok app.
    const titleLine = currentTitleLine();
    const result = await publishSlideshow(slides, {
      titleLine,
      title: titleLine,
      onProgress: (m) => { els.status.textContent = m; },
    });
    if (result.status === 'FAILED') {
      els.status.textContent = '⚠️ TikTok reported a failure — check the app.';
    } else if (result.status === 'SEND_TO_USER_INBOX' || result.status === 'PUBLISH_COMPLETE') {
      els.status.textContent = '✅ Draft sent to your TikTok inbox. Open the app to publish.';
    } else {
      els.status.textContent = '⏳ Uploaded — still processing. Check your TikTok inbox shortly.';
    }
  } catch (err) {
    if (err.reauth) { clearLocalToken(); refreshAuthUI(); } // token dead → back to signed-out
    els.status.textContent = '⚠️ ' + err.message;
  } finally {
    updatePostButton();
  }
});

// ---- Boot ----
(async () => {
  try {
    if (await handleRedirect()) els.status.textContent = 'Signed in to TikTok ✓';
  } catch (e) { els.status.textContent = e.message; }
  if (!isPublicOrigin()) {
    els.status.textContent = 'ℹ️ Grab & caption work here; posting to TikTok needs the deployed site (TikTok can’t fetch images from a local address).';
  }
  refreshAuthUI();
  render();
})();
```

- [ ] **Step 2: Syntax-check**

Run: `node --check public/scripts/tik/app.js`
Expected: no output (exit 0).

- [ ] **Step 3: Manual smoke test (local, no TikTok)**

Run `npm run dev`, open `http://localhost:4321/tik`:
- Load a local `.mp4`; the video appears; the page is dark-themed and two-pane (single column when narrow) — confirming Tailwind shipped via `<Base>`.
- Drag the scrubber; timecode updates; ±1f buttons nudge.
- Click **Grab frame** a few times; each slide's thumbnail shows the **composed** slide (letterboxed frame + caption band), not a bare frame.
- Type a caption; the thumbnail preview updates live. Toggle "Prefix every slide with a title" and type a title; every preview updates.
- Delete a slide; drag to reorder.
- **Post to TikTok** stays disabled with the "needs the deployed site" notice (expected on localhost — TikTok can't fetch local URLs; the full post is verified on a deploy in Task 16).

- [ ] **Step 4: Commit**

```bash
git add public/scripts/tik/app.js
git commit -m "feat(tik): wire capture, scrubber, slide list, auth, and posting"
```

---

## Task 16: End-to-end verification against a deploy

**Files:** none (verification + docs only)

The post step needs the deployed site (public URLs, verified domain). Everything else was verified locally in Task 15.

- [ ] **Step 1: Confirm the one-time TikTok setup is in place**

Verify with the operator (or document as prerequisites):
- Netlify env vars `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` are set.
- The deployed domain (and the `/.netlify/functions/tik-media` URL prefix) is added under **URL properties** in the TikTok developer app.
- The TikTok account used for testing is registered as a tester on the app, and `video.upload` scope is requested.
- The deployed `/tik` URL is added as a redirect URI in the app's login settings.

- [ ] **Step 2: Deploy and run the full flow**

Deploy the branch (Netlify branch deploy or production). On the deployed `/tik`:
- Click **Sign in to TikTok** → complete OAuth → returns to `/tik` showing "signed in ✓".
- Load a video, grab 3–4 frames, caption them.
- Click **Post to TikTok** → status walks through "Rendering… / Uploading… / Sending…" → ends at "✅ Draft sent to your TikTok inbox."
- In the TikTok app, open the inbox notification → the slideshow draft is there with the captioned frames → publish.

- [ ] **Step 3: Verify blob cleanup**

Confirm `tik-media` blobs are created on post and swept after their TTL (they only need to survive TikTok's ~1h pull window).

- [ ] **Step 4: Decide nav exposure**

Keep `/tik` unlinked from main nav until setup is confirmed working (the page has `noindex` already). Link it in once the flow is validated.

- [ ] **Step 5: Final commit (if any doc/nav changes were made)**

```bash
git add -A
git commit -m "chore(tik): finalize /tik after end-to-end verification"
```

---

## Notes for the implementer

- **Run `npm test` after every pure-logic task** — it runs all `test/tik/*.test.mjs` via `node:test` (built into Node 22; no dependency to install).
- **The post step cannot be exercised on `localhost`** — TikTok pulls images over the public internet. Compose/caption/grab all work locally; validate posting on a deploy (Task 16).
- **Unaudited app = private drafts to registered testers only.** That's expected for the MVP; going public is a later audit step, and the interface (`tik-publish`) is where `post_mode`/`privacy` would change.
- **Don't add npm dependencies.** All image work is canvas-based; all tests use `node:test`.
```
