# Heavy upload audio pass — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in audio cleanup pass that runs each clip's saved file through ffmpeg.wasm (denoise + EBU R128 loudness normalization to YouTube's −14 LUFS) before uploading, so polished clips match the loudness of established YouTube channels.

**Architecture:** New module `public/scripts/capture/audio-processor.js` lazy-loads `@ffmpeg/ffmpeg` (v0.11.6, single-threaded — chosen to avoid COOP/COEP header changes) on first use, then exposes `processClipAudio(file, { onProgress })` returning a processed `Blob`. `app.js`'s `runUploadItem` invokes it before the existing upload PUT when the new per-item `cleanAudio` flag is set. A checkbox in the existing batch-review modal captures user intent at confirm-time and flows through `enqueueUpload`.

**Tech Stack:** `@ffmpeg/ffmpeg` 0.11.6 + `@ffmpeg/core` 0.11.0 (single-threaded wasm, served from `public/ffmpeg/` for same-origin loading). Existing vanilla ES modules. No new build steps.

**Reference spec:** `docs/superpowers/specs/2026-05-27-audio-cleanup-design.md` (Section 3 "Heavy upload pass — denoise + final loudness", Section 4 "Publish modal" + "Upload toast" subsections).

**Spec deviation:** The spec's filter chain was `afftdn → arnndn → loudnorm`. This plan ships `afftdn → loudnorm` only and defers `arnndn`. Reason: `arnndn` requires loading an external RNN model file (`cb.rnnn`) into ffmpeg's virtual filesystem, and the v0.11 single-threaded core doesn't ship the standard model bundle. `afftdn` alone handles the steady-state tape hiss that's the headline noise problem; `arnndn`'s residual crackle/pop cleanup is a nice-to-have we can layer on later without changing the toast UX or the surrounding code shape.

**Verification note:** This project has no test runner (`package.json` has no test deps), so verification is manual via the browser, consistent with the spec's testing approach. Each task has explicit verification steps that must be run before committing.

---

## File map

- **Modify:** `package.json` — add `@ffmpeg/ffmpeg` and `@ffmpeg/core` dependencies (Task 1).
- **Create:** `public/ffmpeg/ffmpeg-core.js`, `public/ffmpeg/ffmpeg-core.wasm`, `public/ffmpeg/ffmpeg-core.worker.js` — copied from `node_modules/@ffmpeg/core/dist/` so the wasm/js are served same-origin (Task 1).
- **Create:** `public/scripts/capture/audio-processor.js` — new module: lazy `loadFFmpeg()`, `processClipAudio(file, { onProgress })`. One responsibility: wrap ffmpeg.wasm for audio-only filtering. No DOM, no app state (Task 2).
- **Modify:** `src/pages/capture.astro` — add a checkbox row inside the batch-review modal's master section (~line 1620, alongside `batch-master-playlists`). (Task 3.)
- **Modify:** `public/scripts/capture/app.js` —
  - Read the checkbox at batch-confirm and pass through to `enqueueUpload` (Task 3).
  - Accept `cleanAudio` in `enqueueUpload`'s 4th-positional param, persist on the queue item (Task 3).
  - Add new `processing` state to the toast state machine and update `renderToast` (Task 4).
  - In `runUploadItem`, when `item.cleanAudio` is true, run `processClipAudio` on the file blob before the upload PUT (Task 4).

---

### Task 1: Add ffmpeg.wasm dependency and copy core files into public/

**Files:**
- Modify: `package.json` (add 2 dependencies)
- Create: `public/ffmpeg/ffmpeg-core.js`, `public/ffmpeg/ffmpeg-core.wasm`, `public/ffmpeg/ffmpeg-core.worker.js`
- Modify: `.gitignore` (verify `public/ffmpeg/` is tracked, not ignored)

- [ ] **Step 1: Add npm dependencies**

Run:
```bash
npm install @ffmpeg/ffmpeg@0.11.6 @ffmpeg/core@0.11.0 --save-exact
```

Expected: `package.json` gains two entries under `dependencies`. `package-lock.json` updates.

Verify:
```bash
grep -E '"@ffmpeg/(ffmpeg|core)"' package.json
```
Expected output:
```
"@ffmpeg/core": "0.11.0",
"@ffmpeg/ffmpeg": "0.11.6",
```

- [ ] **Step 2: Copy core wasm files to public/ for same-origin serving**

The default ffmpeg.wasm loader fetches the core wasm from a CDN, which triggers CORS preflights and adds a third-party runtime dependency. Copy the files into `public/ffmpeg/` so they're served from our own origin — predictable, cacheable, no CDN coupling.

```bash
mkdir -p public/ffmpeg
cp node_modules/@ffmpeg/ffmpeg/dist/ffmpeg.min.js public/ffmpeg/
cp node_modules/@ffmpeg/core/dist/ffmpeg-core.js public/ffmpeg/
cp node_modules/@ffmpeg/core/dist/ffmpeg-core.wasm public/ffmpeg/
cp node_modules/@ffmpeg/core/dist/ffmpeg-core.worker.js public/ffmpeg/
```

Verify all four exist:
```bash
ls -la public/ffmpeg/
```
Expected: four files visible, `ffmpeg-core.wasm` ~25-30MB, `ffmpeg.min.js` ~few hundred KB.

If `node_modules/@ffmpeg/ffmpeg/dist/ffmpeg.min.js` doesn't exist (the package layout has shifted across versions), the alternative paths to check are `node_modules/@ffmpeg/ffmpeg/dist/ffmpeg.dev.js` or `node_modules/@ffmpeg/ffmpeg/dist/index.js`. Use whichever UMD-style bundle is present and adjust the cp + the `<script src>` path in Task 2 to match.

- [ ] **Step 3: Verify .gitignore doesn't exclude public/ffmpeg/**

Run:
```bash
git check-ignore public/ffmpeg/ffmpeg-core.wasm
```
Expected: no output (file is NOT ignored — it will be tracked).

If the file IS ignored (the command prints a path), check `.gitignore` and add a negation (`!public/ffmpeg/`) so the wasm files commit.

- [ ] **Step 4: Verify Astro build still succeeds with the new public assets**

Run: `npm run build`
Expected: build completes with "Complete!", and `public/ffmpeg/*` files appear in the build output (`dist/ffmpeg/`).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json public/ffmpeg/
git commit -m "$(cat <<'EOF'
deps: add ffmpeg.wasm (single-threaded) for heavy audio pass

Pins @ffmpeg/ffmpeg@0.11.6 and @ffmpeg/core@0.11.0 — the last
single-threaded ffmpeg.wasm versions. Avoids requiring COOP/COEP
response headers on the capture page (the multi-threaded builds in
0.12+ need SharedArrayBuffer, which forces cross-origin isolation
and breaks any cross-origin assets we load elsewhere on the page).

Core wasm + worker + js loader copied into public/ffmpeg/ so they're
served same-origin instead of from unpkg CDN. ~28MB wasm, cached by
the browser HTTP cache after first load.

Not yet wired up — that's the next tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Create the audio-processor module

**Files:**
- Create: `public/scripts/capture/audio-processor.js`

- [ ] **Step 1: Create the module file**

Write the following to `public/scripts/capture/audio-processor.js`:

```js
// audio-processor — wraps ffmpeg.wasm (single-threaded v0.11) for the
// heavy upload pass. Lazy-loads ffmpeg on first call so a user who
// never checks the "Clean audio" box never pays the ~28MB download.
//
// What it does: takes a recorded video file (webm or mp4), runs the
// audio track through ffmpeg's afftdn (FFT denoiser) + loudnorm
// (EBU R128 loudness normalization to YouTube's -14 LUFS target),
// re-muxes with the ORIGINAL video stream copied as-is (no re-encode,
// fast), and returns a new Blob ready for upload.
//
// Why this exists: even after the live capture chain boosts loudness,
// VHS clips often end up either (a) loud-but-hissy because the +10dB
// boost amplifies tape noise, or (b) quieter than other YouTube
// content because they weren't mastered to the platform's -14 LUFS
// target. Loudnorm matches the platform standard; afftdn knocks down
// the hiss that the live boost made more audible.
//
// Tradeoff: this is slow (single-threaded wasm + serial processing).
// Hence opt-in per batch, not default-on. UI gates this and surfaces
// progress via the toast's new 'processing' state.

// Lazy global — initialized on first processClipAudio call. Kept
// alive across calls so we don't re-download the ~28MB wasm for every
// clip in a batch.
let ffmpegInstance = null;
let loadPromise = null;

/**
 * Load the ffmpeg.wasm module. Idempotent — repeated calls share the
 * same in-flight promise / cached instance.
 *
 * @returns {Promise<FFmpeg>}
 * @throws if the script tag or wasm fetch fails.
 */
export async function loadFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    // Inject the UMD bundle via a <script> tag — that's the only
    // reliable way to load @ffmpeg/ffmpeg's 0.11 dist in the browser
    // without bundler involvement. The bundle assigns window.FFmpeg
    // on load. We host the file in public/ffmpeg/ so it's served
    // same-origin (no CORS preflight) and not from a third-party CDN.
    if (!window.FFmpeg) {
      await new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-ffmpeg-loader]');
        if (existing) {
          existing.addEventListener('load', resolve, { once: true });
          existing.addEventListener('error', () => reject(new Error('ffmpeg script load failed')), { once: true });
          return;
        }
        const script = document.createElement('script');
        script.src = '/ffmpeg/ffmpeg.min.js';
        script.dataset.ffmpegLoader = '1';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('ffmpeg script load failed'));
        document.head.appendChild(script);
      });
    }

    const createFFmpeg = window.FFmpeg && window.FFmpeg.createFFmpeg;
    if (!createFFmpeg) {
      throw new Error('audio-processor: window.FFmpeg.createFFmpeg not available after script load');
    }

    const inst = createFFmpeg({
      // Point at our same-origin core files (see Task 1) instead of
      // the default unpkg CDN URL.
      corePath: '/ffmpeg/ffmpeg-core.js',
      log: false,
    });
    await inst.load();
    ffmpegInstance = inst;
    return inst;
  })().catch((e) => {
    // Reset on failure so a retry can try again.
    loadPromise = null;
    throw e;
  });

  return loadPromise;
}

/**
 * Process the audio of a video file. Video stream is copied through
 * unchanged; audio is filtered with afftdn (denoise) + loudnorm
 * (loudness match).
 *
 * @param {File|Blob} file - input video, MUST be webm or mp4.
 * @param {object} options
 * @param {(percent: number) => void} [options.onProgress] - called with
 *   integer 0-100 as ffmpeg reports its progress. Best-effort — not
 *   every ffmpeg progress line maps cleanly to a percent.
 * @returns {Promise<Blob>} processed file, same container as input.
 * @throws if loading ffmpeg fails or processing fails for any reason.
 */
export async function processClipAudio(file, { onProgress } = {}) {
  const ffmpeg = await loadFFmpeg();

  // Pick container + audio codec based on input. webm → opus, mp4 → aac.
  const isWebm = (file.type && file.type.includes('webm')) ||
                 (file.name && file.name.toLowerCase().endsWith('.webm'));
  const ext = isWebm ? 'webm' : 'mp4';
  const audioCodec = isWebm ? 'libopus' : 'aac';
  const audioBitrate = '192k';

  const inputName = `in.${ext}`;
  const outputName = `out.${ext}`;

  // Progress reporting — ffmpeg.wasm 0.11 exposes setProgress(({ratio}))
  // which fires as the filter pipeline advances. ratio is 0..1.
  if (typeof onProgress === 'function') {
    ffmpeg.setProgress(({ ratio }) => {
      if (typeof ratio === 'number' && ratio >= 0) {
        onProgress(Math.min(100, Math.max(0, Math.round(ratio * 100))));
      }
    });
  }

  try {
    // Write input file into ffmpeg's virtual FS.
    const buf = new Uint8Array(await file.arrayBuffer());
    ffmpeg.FS('writeFile', inputName, buf);

    // The filter chain. Comma-separated, applied left-to-right:
    //   afftdn=nr=12:nf=-25  — FFT noise reduction, moderate strength.
    //                          nr=12 dB reduction, nf=-25 dB noise floor.
    //                          Aggressive enough to hear, gentle enough
    //                          not to make vocals sound underwater.
    //   loudnorm=I=-14:LRA=11:TP=-1.5
    //                        — EBU R128 normalization. I=-14 LUFS is
    //                          YouTube's integrated target; LRA=11 is
    //                          a reasonable loudness range; TP=-1.5
    //                          true peak ceiling keeps a bit of
    //                          headroom below clipping.
    const filterChain = 'afftdn=nr=12:nf=-25,loudnorm=I=-14:LRA=11:TP=-1.5';

    await ffmpeg.run(
      '-i', inputName,
      '-c:v', 'copy',           // copy video stream unchanged
      '-c:a', audioCodec,       // re-encode audio (filters output PCM)
      '-b:a', audioBitrate,
      '-af', filterChain,
      outputName,
    );

    const outData = ffmpeg.FS('readFile', outputName);
    const outBlob = new Blob([outData.buffer], {
      type: isWebm ? 'video/webm' : 'video/mp4',
    });

    return outBlob;
  } finally {
    // Always clean up the virtual FS, even on error. Per-clip FS
    // entries are tiny relative to the wasm runtime, but they
    // accumulate if a batch runs many uploads.
    try { ffmpeg.FS('unlink', inputName); } catch {}
    try { ffmpeg.FS('unlink', outputName); } catch {}
    if (typeof onProgress === 'function') {
      // Clear our handler so the next call's setProgress override
      // doesn't see stale state from this one.
      try { ffmpeg.setProgress(() => {}); } catch {}
    }
  }
}
```

- [ ] **Step 2: Verify the module parses**

Run: `node --check public/scripts/capture/audio-processor.js`
Expected: exit 0, no output.

- [ ] **Step 3: Skip browser smoke test**

Browser smoke test for this module is deferred until Task 4 wires it into the upload flow. The module is standalone and not yet imported anywhere.

- [ ] **Step 4: Commit**

```bash
git add public/scripts/capture/audio-processor.js
git commit -m "$(cat <<'EOF'
feat(capture): add audio-processor module wrapping ffmpeg.wasm

New module public/scripts/capture/audio-processor.js with two exports:
  loadFFmpeg() — lazy-loads ffmpeg.wasm + core from same-origin URLs,
                 returns a cached instance after the first call
  processClipAudio(file, { onProgress }) — runs the audio through
                 afftdn (denoise) + loudnorm (EBU R128 to -14 LUFS),
                 video copied through unchanged, returns processed Blob

Not yet imported anywhere — wiring lands in the next tasks. Filter
chain is afftdn + loudnorm only (spec called for arnndn too but the
RNN model bundle isn't included in @ffmpeg/core v0.11; afftdn alone
handles the steady-state tape hiss that's the headline problem).

Refs: docs/superpowers/specs/2026-05-27-audio-cleanup-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Add the publish-modal checkbox + plumb it to enqueueUpload

**Files:**
- Modify: `src/pages/capture.astro` (add checkbox row in batch-review modal, ~line 1620)
- Modify: `public/scripts/capture/app.js` (read checkbox at batch-confirm; extend `enqueueUpload` and queue item shape)

- [ ] **Step 1: Add the checkbox markup to the batch-review modal**

Open `src/pages/capture.astro` and find lines 1616-1622 (the batch-review modal body). The current shape:

```astro
      <p class="px-4 pt-3 text-white/40 text-[10px] uppercase tracking-wider shrink-0">Edit title or description for any clip before uploading.</p>
      <div id="batch-master-playlists" class="hidden px-4 pt-3 pb-1 shrink-0 border-b border-white/10">
        <p class="text-white/40 text-[10px] uppercase tracking-widest mb-1.5">Add all clips to playlists</p>
        <div id="batch-master-playlists-list" class="space-y-1"></div>
      </div>
      <div id="batch-review-list" class="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3"></div>
```

Insert a new `<div>` block between `batch-master-playlists` and `batch-review-list`. After insertion:

```astro
      <p class="px-4 pt-3 text-white/40 text-[10px] uppercase tracking-wider shrink-0">Edit title or description for any clip before uploading.</p>
      <div id="batch-master-playlists" class="hidden px-4 pt-3 pb-1 shrink-0 border-b border-white/10">
        <p class="text-white/40 text-[10px] uppercase tracking-widest mb-1.5">Add all clips to playlists</p>
        <div id="batch-master-playlists-list" class="space-y-1"></div>
      </div>
      <div class="px-4 pt-3 pb-2 shrink-0 border-b border-white/10">
        <label class="flex items-start gap-2 cursor-pointer">
          <input id="batch-clean-audio" type="checkbox" class="mt-0.5 accent-white" />
          <span>
            <span class="block text-white/85 text-[11px] tracking-wider">Clean audio + match YouTube loudness</span>
            <span class="block text-[10px] text-white/40">Adds ~1 min per clip. Recommended for tapes with hiss or that sound quieter than other channels.</span>
          </span>
        </label>
      </div>
      <div id="batch-review-list" class="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3"></div>
```

- [ ] **Step 2: Reset the checkbox each time the modal opens**

The spec says the opt-in is session-scoped and resets on reload. Each open of the modal should also start unchecked (no surprise carry-over from a prior batch — the user just sat through a long processing wait, may not want it again).

Find the `renderBatchReview` function in `public/scripts/capture/app.js`. (Use grep: `grep -n "function renderBatchReview" public/scripts/capture/app.js` — it's the function that builds the modal body.) Inside that function, find the line that populates `count.textContent` (around line 2827). Immediately AFTER that line, add:

```js
  // Reset the heavy-audio opt-in for each batch — user re-decides
  // every time (no persistence, see spec §4 publish-modal).
  const cleanAudioBox = document.getElementById('batch-clean-audio');
  if (cleanAudioBox) cleanAudioBox.checked = false;
```

- [ ] **Step 3: Read the checkbox at batch-confirm and pass to enqueueUpload**

Find the line `enqueueUpload(id, token, perCardPlaylists.get(id));` (around line 2986) in `public/scripts/capture/app.js`. It's inside the batch-confirm click handler. Capture the checkbox state BEFORE the loop that calls `enqueueUpload`:

Find the structure around lines 2980-2990 (a loop that iterates selected clips calling `enqueueUpload` for each). Add ONE line just before the loop body so it reads the checkbox once:

The current shape will look something like:
```js
    for (const id of orderedIds) {
      // ... per-clip setup ...
      enqueueUpload(id, token, perCardPlaylists.get(id));
    }
```

Add the read above the loop:

```js
    const cleanAudio = document.getElementById('batch-clean-audio')?.checked === true;
    for (const id of orderedIds) {
      // ... per-clip setup ...
      enqueueUpload(id, token, perCardPlaylists.get(id), cleanAudio);
    }
```

(If the existing loop has a different exact shape, the principle is: read `cleanAudio` once outside the loop, pass it as the new 4th positional arg into every `enqueueUpload` call inside.)

- [ ] **Step 4: Accept cleanAudio in enqueueUpload + persist on the item**

Find `function enqueueUpload(clipId, token, playlistIdsOverride) {` at line ~4770. Change the signature to accept a 4th param and add it to the item shape.

Before:
```js
function enqueueUpload(clipId, token, playlistIdsOverride) {
  if (uploadQueue.items.some(it => it.clipId === clipId &&
      (it.state === 'queued' || it.state === 'uploading'))) {
    return null;
  }
  const clips = getClips();
  const clip = clips.find(c => c.id === clipId);
  if (!clip) return null;

  const item = {
    id: 'upload_' + (nextUploadId++),
    clipId,
    title: clip.title || 'Untitled',
    state: 'queued',
    progress: 0,
    xhr: null,
    ytUrl: null,
    errorMsg: null,
    token,
    snippet: snapshotPublishForm(),
    playlistIds: Array.isArray(playlistIdsOverride) ? playlistIdsOverride : getCheckedPlaylistIds(),
    queuePosition: 1,
    queueLength: 1,
  };
```

After:
```js
function enqueueUpload(clipId, token, playlistIdsOverride, cleanAudio = false) {
  if (uploadQueue.items.some(it => it.clipId === clipId &&
      (it.state === 'queued' || it.state === 'uploading'))) {
    return null;
  }
  const clips = getClips();
  const clip = clips.find(c => c.id === clipId);
  if (!clip) return null;

  const item = {
    id: 'upload_' + (nextUploadId++),
    clipId,
    title: clip.title || 'Untitled',
    state: 'queued',
    progress: 0,
    xhr: null,
    ytUrl: null,
    errorMsg: null,
    token,
    snippet: snapshotPublishForm(),
    playlistIds: Array.isArray(playlistIdsOverride) ? playlistIdsOverride : getCheckedPlaylistIds(),
    queuePosition: 1,
    queueLength: 1,
    // Heavy audio pass — opt-in per batch via the batch-review
    // checkbox. When true, runUploadItem runs the file through
    // ffmpeg.wasm before the upload PUT. See audio-processor.js.
    cleanAudio: cleanAudio === true,
  };
```

The two other `enqueueUpload` call sites (single-clip publish path around lines 2986 and 6051) do NOT pass `cleanAudio`. The default `= false` covers them — single-clip publish ignores this feature entirely (only batch publish exposes the toggle). Don't touch those call sites.

- [ ] **Step 5: Verify both files parse + build**

Run: `node --check public/scripts/capture/app.js`
Expected: exit 0, no output.

Run: `npm run build`
Expected: build completes with "Complete!".

- [ ] **Step 6: Manual UI verification**

Start dev server: `npm run dev` (background it or run in a separate terminal).

Open `http://localhost:4321/capture`, get to the library view, select 2+ clips, and click "Upload (N of M)". The batch-review modal should now show the "Clean audio + match YouTube loudness" checkbox between the playlist picker and the clip list. The checkbox should be UNCHECKED.

Close the modal and re-open it — checkbox should still be UNCHECKED (no carry-over).

Check the box, click Confirm. The upload should start as today (no processing yet — Task 4 wires the actual processing). In DevTools console, run:
```js
console.log(uploadQueue.items.map(i => ({ id: i.id, cleanAudio: i.cleanAudio })));
```
Expected: each item shows `cleanAudio: true`.

Then repeat with the box UNCHECKED — each item should show `cleanAudio: false`.

- [ ] **Step 7: Commit**

```bash
git add src/pages/capture.astro public/scripts/capture/app.js
git commit -m "$(cat <<'EOF'
feat(upload): add 'Clean audio' opt-in to batch review modal

New checkbox in the batch-review modal between the playlist picker
and the clip list. Default unchecked (resets on each open — the user
re-decides every batch since the processing is slow). On Confirm,
the value flows through enqueueUpload as a new positional arg and
lands on each queue item as item.cleanAudio.

No behavior change yet — the runUploadItem wiring that actually runs
ffmpeg lands in the next task. This commit is just plumbing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Wire processClipAudio into the upload flow + add 'processing' toast state

**Files:**
- Modify: `public/scripts/capture/app.js` (import audio-processor, add 'processing' state, intercept runUploadItem before PUT, update renderToast)

- [ ] **Step 1: Add the import**

In `public/scripts/capture/app.js`, find the existing line (added in slice 1):
```js
import { buildProcessedStream } from './audio-chain.js';
```

Add immediately below it:
```js
import { processClipAudio } from './audio-processor.js';
```

- [ ] **Step 2: Insert processing before the upload PUT inside runUploadItem**

Find `runUploadItem(item)` (around line 4828). The current shape reads the file from disk at:

```js
    const fh = await directoryHandle.getFileHandle(clip.filename);
    const file = await fh.getFile();
    const contentType = clip.filename.endsWith('.webm') ? 'video/webm' : 'video/mp4';
```

Immediately AFTER `const contentType = ...` (and BEFORE the `const uploadMeta = { ... }` block), insert the audio-processing block:

```js
    // Heavy audio pass — when the user opted into 'Clean audio' in
    // the batch review modal, run ffmpeg.wasm over the file before
    // upload. afftdn knocks down tape hiss; loudnorm brings the
    // clip to YouTube's -14 LUFS target so it matches other channels.
    //
    // We surface progress via a new 'processing' state on the toast
    // (renderToast handles the label). On failure we fall back to
    // uploading the original file with a non-blocking warning — a
    // bad ffmpeg pass shouldn't block the user's upload.
    let uploadFile = file;
    if (item.cleanAudio) {
      item.state = 'processing';
      item.progress = 0;
      renderToast(item);
      try {
        uploadFile = await processClipAudio(file, {
          onProgress: (pct) => {
            item.progress = pct;
            renderToast(item);
          },
        });
        // Reset progress for the upload stage — the toast UI reuses
        // item.progress for both processing and uploading bars.
        item.progress = 0;
      } catch (e) {
        console.warn('[upload] audio cleanup failed, uploading original:', e);
        uploadFile = file;
        // Surface a one-time warning in the toast so the user knows
        // the loudness-match step didn't happen for this clip. Doesn't
        // block the upload itself — we continue with raw bytes.
        item.cleanAudioFailed = true;
      }
      item.state = 'uploading';
      renderToast(item);
    }
```

- [ ] **Step 3: Use uploadFile instead of file for the upload bytes**

Still inside `runUploadItem`, find the `contentLength: file.size,` line in the init-upload body (around line 4868) and change it to use `uploadFile`:

Before:
```js
          contentLength: file.size,
```

After:
```js
          contentLength: uploadFile.size,
```

Then find the `xhr.send(file);` line further down (around line 5078, inside the PUT promise) and change to:

Before:
```js
      xhr.send(file);
```

After:
```js
      xhr.send(uploadFile);
```

(Verify there are only TWO references in `runUploadItem`: `contentLength: file.size` for the init body, and `xhr.send(file)` for the PUT body. Search for `file.size` and `xhr.send(file` in the function range to confirm.)

Inside the success branch where `item.mimeType: contentType` flows into log-upload (around line 5018), leave `contentType` alone — the processed file has the same container, so the mime type is still correct.

- [ ] **Step 4: Update the toast state machine to render 'processing'**

Find `renderToast` (around line 5274). It currently handles four states: queued, uploading, success, error. Add a new branch for `processing`.

Find the state-label block (around line 5276-5286):

```js
  const label =
    item.state === 'queued'
      ? (uploadQueue.countdownItemId === item.id ? 'Starting…' : `Queued · ${item.queuePosition}/${item.queueLength}`) :
    item.state === 'uploading'
      ? `Uploading · ${item.progress}%` :
    item.state === 'success'
      ? 'Uploaded ✓' :
    item.state === 'error'
      ? 'Failed' :
    '';
```

Add the processing state above `uploading`:

```js
  const label =
    item.state === 'queued'
      ? (uploadQueue.countdownItemId === item.id ? 'Starting…' : `Queued · ${item.queuePosition}/${item.queueLength}`) :
    item.state === 'processing'
      ? `Cleaning audio · ${item.progress}%` :
    item.state === 'uploading'
      ? `Uploading · ${item.progress}%` :
    item.state === 'success'
      ? 'Uploaded ✓' :
    item.state === 'error'
      ? 'Failed' :
    '';
```

Then find the `showProgress` line (around 5289):

```js
  const showProgress = item.state === 'uploading' || item.state === 'success';
```

Change to also include processing so the progress bar renders during the ffmpeg pass:

```js
  const showProgress = item.state === 'processing' || item.state === 'uploading' || item.state === 'success';
```

Finally find the success-message rendering (around line 5316) — if the item's `cleanAudioFailed` flag is set, surface a one-line warning under the title so the user knows the polish step didn't happen. Find:

```js
    ${item.state === 'error' ? `<p class="toast-error-msg">${escapeHtml(item.errorMsg || '')}</p>` : ''}
```

Add a sibling line right BEFORE it:

```js
    ${item.cleanAudioFailed && item.state === 'success' ? `<p class="toast-error-msg" style="color:#fbbf24;">Audio cleanup unavailable — uploaded original file.</p>` : ''}
    ${item.state === 'error' ? `<p class="toast-error-msg">${escapeHtml(item.errorMsg || '')}</p>` : ''}
```

(The amber `#fbbf24` is a warning color distinct from the error red, so success-with-warning reads as "OK but here's a note" not as a failure.)

- [ ] **Step 5: Verify the file parses + build succeeds**

Run: `node --check public/scripts/capture/app.js`
Expected: exit 0, no output.

Run: `npm run build`
Expected: build completes with "Complete!". Watch for any "Cannot resolve @ffmpeg/ffmpeg" errors — if you see one, the bundler can't find the dynamic import path. The fix is to ensure the bundler treats it as an external dependency or that the package is correctly installed.

- [ ] **Step 6: Manual end-to-end verification**

Start dev server: `npm run dev` (background or separate terminal).

**Scenario A — Box UNchecked (regression baseline):**
- Open `/capture`, select 2 clips, open batch review, leave box unchecked, click Confirm.
- Expect: upload progresses immediately to "Uploading · N%" toast, no "Cleaning audio" state, no warning. Same speed as before.
- Open DevTools Network tab and confirm no `ffmpeg-core.wasm` request is made.

**Scenario B — Box CHECKED, short clip (~30s):**
- Re-open library, select 1 short clip, batch review, CHECK the box, Confirm.
- Expect: toast shows "Cleaning audio · 0%" → counts up → switches to "Uploading · 0%" → counts up → "Uploaded ✓".
- Network tab: first run downloads `ffmpeg-core.wasm` (~28MB), subsequent runs in the same session reuse the cached instance.
- On YouTube, verify the uploaded clip's loudness via YouTube Studio "Audio" tab — should be at or very close to -14 LUFS.

**Scenario C — Box CHECKED, processing fails (simulate):**
- In DevTools console, before clicking Confirm, set: `window.__forceFFmpegFail = true;` (the code doesn't read this flag, so this is a no-op — skip this scenario for now unless you want to add a synthetic failure path).
- A more practical failure check: try a corrupt or zero-byte file. The fallback should kick in: toast goes from "Cleaning audio" → "Uploading" → "Uploaded ✓" with the amber "Audio cleanup unavailable — uploaded original file" warning under the title.

**Scenario D — Batch of 3 clips, box CHECKED:**
- Select 3 clips, check the box, Confirm.
- Expect: clip 1 cleans, clip 1 uploads, clip 2 cleans, clip 2 uploads, clip 3 cleans, clip 3 uploads. SERIAL, not parallel. (This matches the existing `tryStartNext` behavior — only one upload runs at a time.)

- [ ] **Step 7: Commit**

```bash
git add public/scripts/capture/app.js
git commit -m "$(cat <<'EOF'
feat(upload): run ffmpeg loudnorm pass when 'Clean audio' is checked

When item.cleanAudio is true, runUploadItem now calls processClipAudio
on the file blob before the existing upload PUT. afftdn + loudnorm
runs server-free in the browser via ffmpeg.wasm, with progress
reported via a new 'processing' toast state ("Cleaning audio · N%")
that uses the existing progress bar.

Failure mode: any ffmpeg error (load, run, parse) catches and falls
back to uploading the original file with an amber warning on the
success toast — a bad polish pass shouldn't block the user.

Single-clip publish path is unaffected (default cleanAudio=false on
enqueueUpload). Closes the heavy upload pass slice of the audio
cleanup spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Done state

After all four tasks land:

- `package.json` has pinned `@ffmpeg/ffmpeg@0.11.6` and `@ffmpeg/core@0.11.0`.
- `public/ffmpeg/` contains the three core files (js + wasm + worker), served same-origin.
- New module `public/scripts/capture/audio-processor.js` exports `loadFFmpeg()` and `processClipAudio()`.
- New checkbox in the batch-review modal: "Clean audio + match YouTube loudness". Default unchecked, resets each open.
- When checked, each clip in the batch runs through `afftdn + loudnorm` via ffmpeg.wasm before its upload PUT. Toast shows "Cleaning audio · N%" then "Uploading · N%".
- When unchecked, upload behavior is identical to today — no ffmpeg download, no processing time, no behavior change.
- Failure mode: any ffmpeg error falls back to uploading the original file with an amber "Audio cleanup unavailable" warning on the success toast.

Combined with slice 1 (already shipped), the audio-cleanup spec is now fully implemented except for the deferred `arnndn` denoiser, which can be added later if `afftdn` alone proves insufficient.
