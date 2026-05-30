# Anamorphic 4:3 aspect fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-detect anamorphic SD sources at upload time and tag them with `-aspect 4:3` metadata via ffmpeg.wasm, so YouTube displays VHS uploads in proper 4:3 instead of the current stretched 1.5:1. Default-on, no UI change, piggybacks on the existing ffmpeg pass when "Clean audio" is checked or runs a fast lightweight ffmpeg pass otherwise.

**Architecture:** New helper `readFileAspect(file)` in `stream-stats.js` reads aspect via a hidden `<video>` element's `loadedmetadata`. The existing `processClipAudio` in `audio-processor.js` gains a `{ cleanAudio, aspect4_3 }` options shape and a new sibling export `applyAspectMetadata(file, { onProgress })` for the no-audio-cleanup case. `runUploadItem` in `app.js` dispatches between the two based on `cleanAudio` flag and aspect-detection result, picks an appropriate toast label, and renames `cleanAudioFailed` to `prepFailed` for honesty.

**Tech Stack:** ffmpeg.wasm 0.11 (already pinned, already in `public/ffmpeg/`), vanilla ES modules. No new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-05-27-anamorphic-aspect-fix-design.md`.

**Verification note:** Project has no test runner. Manual verification per task; final end-to-end browser test deferred to controller.

---

## File map

- **Modify:** `public/scripts/capture/stream-stats.js` — add `readFileAspect(file)` export (alongside existing `readStreamStats` + `startFpsMeter`).
- **Modify:** `public/scripts/capture/audio-processor.js` — extend the `processClipAudio` options shape with `{ cleanAudio, aspect4_3 }`, update the internal ffmpeg invocation logic, add new `applyAspectMetadata` export.
- **Modify:** `public/scripts/capture/app.js` — import `readFileAspect`, import `applyAspectMetadata`, extend `runUploadItem` with detection + dispatch + toast-label adaptation, rename `cleanAudioFailed` → `prepFailed`, update `retryUpload` reset to match.

---

### Task 1: Add readFileAspect to stream-stats.js

**Files:**
- Modify: `public/scripts/capture/stream-stats.js`

- [ ] **Step 1: Add the new export**

Open `public/scripts/capture/stream-stats.js`. The file currently has two exports: `readStreamStats` and `startFpsMeter`. Add a third export at the END of the file:

```js
/**
 * Read the aspect ratio of a video file via a hidden <video> element.
 * Uses HTMLVideoElement.videoWidth/videoHeight which reflect the
 * intrinsic dimensions from the file's container metadata.
 *
 * Used by the upload path to decide whether to apply the 4:3 aspect
 * tag — we read from the FILE rather than the live captureStream
 * because the stream may have been swapped since recording, and the
 * file is the source of truth at upload time.
 *
 * @param {File | Blob} file
 * @returns {Promise<number | null>} width / height, or null if the
 *   file can't be probed (corrupt, unsupported codec, etc.). Callers
 *   should treat null as "skip the aspect fix" rather than fail.
 */
export function readFileAspect(file) {
  return new Promise((resolve) => {
    if (!file) { resolve(null); return; }
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { URL.revokeObjectURL(url); } catch {}
      resolve(val);
    };
    video.onloadedmetadata = () => {
      const w = video.videoWidth, h = video.videoHeight;
      finish((w > 0 && h > 0) ? w / h : null);
    };
    video.onerror = () => finish(null);
    // Safety timeout — some malformed files leave loadedmetadata
    // hanging indefinitely. 5s is generous; this only runs once
    // per upload anyway.
    setTimeout(() => finish(null), 5000);
    video.src = url;
  });
}
```

- [ ] **Step 2: Verify it parses**

Run: `node --check public/scripts/capture/stream-stats.js`
Expected: exit 0, no output.

- [ ] **Step 3: Commit**

```bash
git add public/scripts/capture/stream-stats.js
git commit -m "$(cat <<'EOF'
feat(capture): add readFileAspect helper for upload-time aspect detection

New export readFileAspect(file) — probes the file's intrinsic video
dimensions via a hidden <video> + loadedmetadata, returns the
width/height ratio (or null on failure). Used by the upcoming
upload path that decides whether to tag anamorphic SD sources
with -aspect 4:3 metadata.

5-second safety timeout protects against malformed files where
loadedmetadata never fires. Always revokes the blob URL.

Refs: docs/superpowers/specs/2026-05-27-anamorphic-aspect-fix-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Extend audio-processor.js with aspect4_3 option and applyAspectMetadata export

**Files:**
- Modify: `public/scripts/capture/audio-processor.js`

- [ ] **Step 1: Refactor doProcessClipAudio to accept the new options shape**

Open `public/scripts/capture/audio-processor.js`. Find the inner function `async function doProcessClipAudio(file, { onProgress } = {})` (around line 121 after Task 2 slice 2 fix).

Change the signature to accept the new options:

```js
async function doProcessClipAudio(file, { onProgress, cleanAudio = true, aspect4_3 = false } = {}) {
```

Then find the existing ffmpeg.run() invocation block inside doProcessClipAudio. It currently looks like (varies — read the file to see current shape):

```js
    const filterChain = 'afftdn=nr=12:nf=-25,loudnorm=I=-14:LRA=11:TP=-1.5';

    await ffmpeg.run(
      '-i', inputName,
      '-c:v', 'copy',
      '-c:a', audioCodec,
      '-b:a', audioBitrate,
      '-af', filterChain,
      outputName,
    );
```

Replace with logic that builds the ffmpeg args based on the flags:

```js
    // Build ffmpeg args based on what processing is requested:
    //   cleanAudio  → run afftdn + loudnorm via -af
    //   aspect4_3   → add -aspect 4:3 metadata to the output container
    //   neither     → caller shouldn't have invoked us; defensive no-op
    //                  via -c copy with no filters (safe re-mux)
    const args = ['-i', inputName, '-c:v', 'copy'];

    if (cleanAudio) {
      const filterChain = 'afftdn=nr=12:nf=-25,loudnorm=I=-14:LRA=11:TP=-1.5';
      args.push('-c:a', audioCodec, '-b:a', audioBitrate, '-af', filterChain);
    } else {
      // No audio filters — copy audio stream too. Aspect-only path.
      args.push('-c:a', 'copy');
    }

    if (aspect4_3) {
      // Tag the container's display-aspect-ratio metadata as 4:3.
      // YouTube reads this and renders the video unstretched even
      // though the pixel dimensions stay anamorphic. -c copy means
      // no video bytes are re-encoded.
      args.push('-aspect', '4:3');
    }

    args.push(outputName);

    await ffmpeg.run(...args);
```

- [ ] **Step 2: Add the new applyAspectMetadata export**

Find the existing `export async function processClipAudio` wrapper (the thin one that queues onto `processingChain`). Add a new sibling export RIGHT AFTER it:

```js
/**
 * Apply a 4:3 aspect-ratio tag to the file's container metadata.
 * No re-encoding — both streams are copied through; only the
 * container's display-aspect-ratio box is updated. Fast (~1-3 sec
 * for a typical clip after ffmpeg.wasm is loaded).
 *
 * Used by the upload path when the source is anamorphic SD but the
 * user didn't opt into the heavy 'Clean audio' pass. Composes with
 * processClipAudio via the same internal serialization chain.
 */
export async function applyAspectMetadata(file, options = {}) {
  const myTurn = processingChain.then(() => doProcessClipAudio(file, {
    onProgress: options.onProgress,
    cleanAudio: false,
    aspect4_3: true,
  }));
  processingChain = myTurn.catch(() => {});
  return myTurn;
}
```

- [ ] **Step 3: Update processClipAudio's wrapper to forward the aspect4_3 flag**

Find the existing exported wrapper:

```js
export async function processClipAudio(file, options = {}) {
  const myTurn = processingChain.then(() => doProcessClipAudio(file, options));
  processingChain = myTurn.catch(() => {});
  return myTurn;
}
```

It already forwards the full `options` object, so `{ onProgress, cleanAudio, aspect4_3 }` will flow through automatically. NO change needed — verify by reading the wrapper and confirming it just passes `options` through.

- [ ] **Step 4: Verify it parses**

Run: `node --check public/scripts/capture/audio-processor.js`
Expected: exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add public/scripts/capture/audio-processor.js
git commit -m "$(cat <<'EOF'
feat(audio-processor): add aspect4_3 option and applyAspectMetadata export

doProcessClipAudio now takes { onProgress, cleanAudio, aspect4_3 }
and builds the ffmpeg args conditionally:
- cleanAudio  → adds the existing afftdn + loudnorm chain
- aspect4_3   → adds -aspect 4:3 metadata tag to the output
                container (no video re-encode)
- both        → single pass handles audio cleanup AND aspect tag

New sibling export applyAspectMetadata(file, { onProgress }) wraps
the aspect-only path: -c copy on both streams with -aspect 4:3.
Composes with processClipAudio via the same processingChain so
two callers don't race the shared ffmpeg instance.

The cleanAudio=true default on the options shape preserves
backward compatibility with the existing processClipAudio call
site in app.js until that gets updated in the next task.

Refs: docs/superpowers/specs/2026-05-27-anamorphic-aspect-fix-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Wire detection + dispatch into runUploadItem, rename cleanAudioFailed → prepFailed

**Files:**
- Modify: `public/scripts/capture/app.js`

- [ ] **Step 1: Update imports**

Find the existing imports for the audio modules at the top of `public/scripts/capture/app.js`:

```js
import { buildProcessedStream } from './audio-chain.js';
import { processClipAudio, releaseFFmpeg } from './audio-processor.js';
import { readStreamStats, startFpsMeter } from './stream-stats.js';
```

Add `applyAspectMetadata` to the audio-processor import and `readFileAspect` to the stream-stats import:

```js
import { buildProcessedStream } from './audio-chain.js';
import { processClipAudio, applyAspectMetadata, releaseFFmpeg } from './audio-processor.js';
import { readStreamStats, startFpsMeter, readFileAspect } from './stream-stats.js';
```

- [ ] **Step 2: Replace the existing cleanAudio block in runUploadItem with the new dispatch**

Find `runUploadItem(item)` (around line 4828). The current shape, starting after the file is read from disk:

```js
    const fh = await directoryHandle.getFileHandle(clip.filename);
    const file = await fh.getFile();
    const contentType = clip.filename.endsWith('.webm') ? 'video/webm' : 'video/mp4';

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
        // If the user cancelled mid-processing, ffmpeg.exit() above
        // caused this rejection. Don't log a failure or flip the
        // cleanAudioFailed flag — the cancel handler set state to
        // 'cancelled' and dismissed the toast already.
        if (item.state !== 'cancelled') {
          console.warn('[upload] audio cleanup failed, uploading original:', e);
          uploadFile = file;
          item.cleanAudioFailed = true;
        }
      }
      if (item.state === 'cancelled') return;
      item.state = 'uploading';
      renderToast(item);
    }
```

Replace the WHOLE block from `let uploadFile = file;` through the closing `}` of the `if (item.cleanAudio)` (and the `item.state = 'uploading'` line + renderToast that follows) with this new dispatch:

```js
    // Pre-upload pass — runs ffmpeg.wasm over the file when either:
    //   - the user opted into 'Clean audio' in the batch review modal
    //     (afftdn denoise + loudnorm to -14 LUFS), OR
    //   - the source is anamorphic SD (~1.5 NTSC or ~1.25 PAL), in
    //     which case we add -aspect 4:3 metadata so YouTube renders
    //     it unstretched. No video re-encode for the aspect-only
    //     path — just a container remux, ~1-3 sec.
    //
    // The two fixes compose: if both apply, one ffmpeg pass handles
    // both via the cleanAudio + aspect4_3 flags on processClipAudio.
    //
    // On failure: fall back to uploading the original file with a
    // non-blocking warning flag. A bad ffmpeg pass shouldn't block
    // the user's upload.
    let uploadFile = file;
    const sourceAspect = await readFileAspect(file);
    const needsAspectFix =
      sourceAspect != null &&
      (Math.abs(sourceAspect - 1.5) <= 0.02 ||
       Math.abs(sourceAspect - 1.25) <= 0.02);
    const willCleanAudio = !!item.cleanAudio;
    const willFixAspect = needsAspectFix;

    if (willCleanAudio || willFixAspect) {
      item.state = 'processing';
      item.progress = 0;
      // Label the toast based on which pass is actually running.
      // 'Cleaning audio' wins if audio cleanup is on, since the
      // aspect tag is invisibly piggybacked into the same pass.
      item.processingLabel = willCleanAudio
        ? 'Cleaning audio'
        : 'Fixing aspect';
      renderToast(item);
      try {
        const processFn = willCleanAudio ? processClipAudio : applyAspectMetadata;
        const opts = willCleanAudio
          ? {
              onProgress: (pct) => { item.progress = pct; renderToast(item); },
              cleanAudio: true,
              aspect4_3: willFixAspect,
            }
          : {
              onProgress: (pct) => { item.progress = pct; renderToast(item); },
            };
        uploadFile = await processFn(file, opts);
        item.progress = 0;
      } catch (e) {
        // If the user cancelled mid-processing, ffmpeg.exit() above
        // caused this rejection. Don't log a failure or flip the
        // prepFailed flag — the cancel handler set state to
        // 'cancelled' and dismissed the toast already.
        if (item.state !== 'cancelled') {
          console.warn('[upload] pre-upload processing failed, uploading original:', e);
          uploadFile = file;
          item.prepFailed = true;
        }
      }
      if (item.state === 'cancelled') return;
      item.state = 'uploading';
      renderToast(item);
    }
```

- [ ] **Step 3: Rename cleanAudioFailed to prepFailed across the file**

Find all remaining references to `cleanAudioFailed` in `public/scripts/capture/app.js`:

```bash
grep -n "cleanAudioFailed" public/scripts/capture/app.js
```

There should be 2 places to rename (besides the catch block you already updated):

**3a. retryUpload reset** — find `retryUpload` (around line 5232) and change:

```js
  item.cleanAudioFailed = false;
```

to:

```js
  item.prepFailed = false;
```

**3b. renderToast warning render** — find the existing warning render (around line 5365):

```js
    ${item.cleanAudioFailed && item.state === 'success' ? `<p class="toast-error-msg" style="color:#fbbf24;">Audio cleanup unavailable — uploaded original file.</p>` : ''}
```

Change to:

```js
    ${item.prepFailed && item.state === 'success' ? `<p class="toast-error-msg" style="color:#fbbf24;">Pre-upload processing failed — uploaded original file.</p>` : ''}
```

Verify no references remain:

```bash
grep -n "cleanAudioFailed" public/scripts/capture/app.js
```

Expected: no output (all renamed).

- [ ] **Step 4: Update renderToast's 'processing' label to use item.processingLabel**

Find the existing state-label block in `renderToast` (around line 5326). Current:

```js
    item.state === 'processing'
      ? `Cleaning audio · ${item.progress}%` :
```

Change to:

```js
    item.state === 'processing'
      ? `${item.processingLabel || 'Cleaning audio'} · ${item.progress}%` :
```

(Falls back to 'Cleaning audio' for back-compat if processingLabel wasn't set — defensive.)

- [ ] **Step 5: Verify the file parses + build succeeds**

Run: `node --check public/scripts/capture/app.js`
Expected: exit 0, no output.

Run: `npm run build`
Expected: build completes with "Complete!".

- [ ] **Step 6: Manual browser verification — defer to controller**

Controller will run end-to-end tests after the commit lands: upload an anamorphic clip without Clean Audio (verify "Fixing aspect" toast briefly, verify YouTube displays 4:3); upload anamorphic clip WITH Clean Audio (verify same "Cleaning audio" label, verify YouTube displays 4:3 AND has correct loudness); upload 16:9 native clip with no Clean Audio (verify no ffmpeg pass runs at all, no behavior change).

- [ ] **Step 7: Commit**

```bash
git add public/scripts/capture/app.js
git commit -m "$(cat <<'EOF'
feat(upload): auto-detect anamorphic SD sources, tag as 4:3 on upload

Reads the source file's aspect ratio at upload time. If it's
within ±0.02 of 1.5 (NTSC anamorphic 720×480) or 1.25 (PAL
anamorphic 720×576), the upload path runs ffmpeg.wasm with
-aspect 4:3 to tag the output container. YouTube reads this and
displays the video unstretched.

Three dispatch paths in runUploadItem:
- Clean Audio ON + anamorphic   → processClipAudio with cleanAudio
                                  + aspect4_3 (one ffmpeg pass)
- Clean Audio ON + square pix    → processClipAudio with cleanAudio
                                  only (existing behavior)
- Clean Audio OFF + anamorphic  → applyAspectMetadata (lightweight
                                  -c copy -aspect 4:3 remux, no
                                  re-encode, ~1-3 sec after wasm
                                  is loaded)
- Clean Audio OFF + square pix   → no ffmpeg, upload original

Toast label adapts: 'Cleaning audio · N%' when audio runs (aspect
is piggybacked invisibly), 'Fixing aspect · N%' when only aspect
runs.

Rename item.cleanAudioFailed → item.prepFailed (the flag now
covers both audio-cleanup failures and aspect-tag failures).
Warning copy updated to 'Pre-upload processing failed — uploaded
original file.'

Closes the anamorphic-aspect-fix spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Done state

After all three tasks land:

- New `readFileAspect(file)` export in `stream-stats.js`
- `processClipAudio(file, { onProgress, cleanAudio, aspect4_3 })` accepts the new options shape; new `applyAspectMetadata(file, { onProgress })` sibling export for aspect-only path
- `runUploadItem` reads source aspect from the file, dispatches between processClipAudio and applyAspectMetadata based on `cleanAudio` flag and aspect-detection result
- Anamorphic SD sources (NTSC 720×480 or PAL 720×576) get `-aspect 4:3` tagged on the upload's container metadata
- Toast label adapts to the actual pass being run
- `cleanAudioFailed` flag renamed to `prepFailed` everywhere; warning copy updated
- Square-pixel sources (16:9 HD, etc.) with Clean Audio OFF bypass ffmpeg entirely — no behavior change for the common modern-capture case
- Cancel button still works because we still use the 'processing' state
- No new UI; ships behind the existing UX
