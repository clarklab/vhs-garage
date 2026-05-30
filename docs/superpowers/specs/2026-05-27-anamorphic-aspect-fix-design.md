# Anamorphic 4:3 aspect fix at upload

**Date:** 2026-05-27
**Status:** Approved (Option A + auto-detect, default on, no UI change)

## Background

NTSC VHS is recorded at 720×480 pixels with NON-square pixels — the
proper display is 4:3 (640×480 with square pixels). Capture cards
deliver the raw 720×480 frame to the browser. The browser's `<video>`
element treats every pixel as square, so the preview shows the frame
stretched horizontally (1.50:1 / 3:2). MediaRecorder inherits this,
the file YouTube gets has 720×480 pixels with no aspect metadata
saying "treat as 4:3," and YouTube also displays it stretched.

Reddit and other data-nerd-class users have started flagging this as
"wrong aspect ratio." The native-resolution fix that shipped earlier
today (slice 3) keeps the source pixels but doesn't fix the display.

## Goals

When uploading to YouTube, detect if the source is anamorphic SD
(aspect ≈ 1.5:1) and tag the output container with `-aspect 4:3`
metadata so YouTube displays it correctly. Default-on auto-detect,
no UI change, no user opt-in.

The fix is metadata-only — `ffmpeg -c copy -aspect 4:3` rewrites the
container's display-aspect box without re-encoding any video bytes.
Output file is bit-identical to input except for the aspect tag.

## Non-goals

- Real video re-encode to square pixels (640×480 output). That's
  Option B from the discussion — much more CPU. Deferred unless
  YouTube's metadata handling proves unreliable.
- Aspect correction in the live preview. The preview still shows
  the raw 720×480 stretched. Could be a follow-up CSS-only fix
  (apply `aspect-ratio: 4/3` to the `<video>` element conditionally)
  but it's UX polish, not the headline problem.
- Aspect correction for already-uploaded videos. They stay as-is on
  YouTube; user can re-upload if they care.
- 16:9 → wide-screen handling, 480i deinterlacing, any other
  per-source fix.

## Design

### Detection

Read the source aspect ratio from the file itself (not from the
live capture stream — the captureStream may have changed since
recording). Method: create a hidden `<video>` element, set `src` to
a blob URL of the file, wait for `loadedmetadata`, read
`videoWidth`/`videoHeight`. Built-in browser API, no ffmpeg load
needed for detection.

A source is "anamorphic SD" if the aspect ratio is within ±0.02 of
1.5 (covers 720×480 and similar). Anything else passes through
unchanged.

This is safe because no real capture-card source delivers genuine
1.5:1 footage — only anamorphic SD lands there. PAL sources at
720×576 (1.25:1) are also anamorphic 4:3 and should get the same
treatment. Tolerance check should accept both:

- ~1.5 (NTSC anamorphic SD) → `-aspect 4:3`
- ~1.25 (PAL anamorphic SD) → `-aspect 4:3`

### Application

Two cases:

1. **User opted into "Clean audio."** The existing ffmpeg pass
   already runs. Extend it to accept an `aspect4_3` flag; when true,
   add `-aspect 4:3` to the ffmpeg command. Single ffmpeg
   invocation handles both audio cleanup + aspect tag.

2. **User did NOT opt into "Clean audio."** Need a NEW lightweight
   ffmpeg pass that ONLY rewrites aspect. Invocation:
   `ffmpeg -i in.x -c copy -aspect 4:3 out.x`. Both streams copied
   (no re-encode), just the container tag changes. Should run in
   1-3 seconds after ffmpeg.wasm is loaded.

   The 24MB ffmpeg.wasm download cost is real for users who haven't
   triggered any audio cleanup this session. Cached across sessions
   via the long max-age header on `/ffmpeg/*`. Single-session pay-once.

### Architecture

`public/scripts/capture/stream-stats.js` — add `readFileAspect(file)`:

```js
readFileAspect(file: File | Blob) → Promise<number | null>
// Resolves to width/height ratio of the video file's metadata,
// or null on failure. Uses a hidden <video> element + loadedmetadata.
// Always revokes the blob URL afterwards.
```

`public/scripts/capture/audio-processor.js` — extend `processClipAudio`'s
options shape and add a new lightweight entry point:

```js
processClipAudio(file, {
  onProgress,
  cleanAudio = true,   // run afftdn + loudnorm; default true for
                       //   back-compat with existing callers
  aspect4_3 = false,   // add -aspect 4:3 to the ffmpeg command
}) → Promise<Blob>

// New: lightweight aspect-only fix without re-encoding anything.
// Implemented as a thin wrapper that calls the same internal helper
// with cleanAudio=false, aspect4_3=true. Same serialization chain
// so it composes safely with the heavy pass.
applyAspectMetadata(file, { onProgress }) → Promise<Blob>
```

Internal ffmpeg invocation logic:
- If `cleanAudio && aspect4_3`: existing audio chain + `-aspect 4:3`
- If `cleanAudio && !aspect4_3`: existing audio chain only (today's behavior)
- If `!cleanAudio && aspect4_3`: `-c copy -aspect 4:3` (no audio filters, no video re-encode)
- If `!cleanAudio && !aspect4_3`: not invoked (caller decides)

`public/scripts/capture/app.js` — `runUploadItem` extended:

1. After reading `file` from disk, compute `needsAspectFix` via
   `readFileAspect(file)`. Match if aspect ≈ 1.5 OR ≈ 1.25 (with
   ±0.02 tolerance).
2. Determine the processing combination:
   - `cleanAudio && needsAspectFix`: call `processClipAudio(file, { onProgress, cleanAudio: true, aspect4_3: true })`
   - `cleanAudio && !needsAspectFix`: call `processClipAudio(file, { onProgress, cleanAudio: true, aspect4_3: false })`
   - `!cleanAudio && needsAspectFix`: call `applyAspectMetadata(file, { onProgress })`
   - `!cleanAudio && !needsAspectFix`: skip ffmpeg entirely, upload original file
3. Same fallback behavior as the existing pass: on ffmpeg failure,
   upload original file with a warning flag.

### UI

No new UI. The existing toast `'processing'` state covers both cases.
Label adapts based on what's running:
- If `cleanAudio` is on: "Cleaning audio · N%" (existing label,
  unchanged — aspect tag is invisibly piggybacked)
- If only `aspect4_3` is on: "Fixing aspect · N%" (new label,
  briefly visible since the pass is fast)

The Cancel button works for either pass — already wired to the
'processing' state from the previous follow-up.

The `cleanAudioFailed` flag becomes a misnomer when only the aspect
pass ran and failed. Rename to `prepFailed` (or `preprocessFailed`)
for accuracy. Warning text changes from "Audio cleanup unavailable —
uploaded original file." to "Pre-upload processing failed — uploaded
original file."

### Failure modes

- `readFileAspect` fails → treat as "no fix needed" (false negative).
  Upload proceeds without aspect tag. User can still re-upload later.
  Better than a broken upload.
- `processClipAudio` / `applyAspectMetadata` throw → fall back to
  uploading the original file with the existing warning flag
  (renamed `prepFailed`). User sees amber warning on the success
  toast.
- ffmpeg.wasm fails to load → same fallback. Warning toast.

### Spec deviation note

The aspect detection uses the FILE's metadata, NOT the live capture
stream's stats. Two reasons: (a) the captureStream may have been
swapped since recording; (b) some capture cards report different
declared aspect via getSettings() vs. what the file actually contains.
The file is the source of truth at upload time.

## Testing

No automated tests (project has no test runner). Manual verification:

**Detection:**

- Record a clip from an anamorphic NTSC card (720×480 1.5:1).
- In DevTools console after upload-start, verify
  `readFileAspect(file)` returns ~1.5.
- Same with a square-pixel source (e.g., 1920×1080 from an HDMI card)
  → returns ~1.78 → no aspect fix applied.

**End-to-end aspect fix:**

- Upload an anamorphic clip with "Clean audio" OFF.
- Confirm toast shows "Fixing aspect · N%" briefly (or that
  ffmpeg.wasm download happens on first session use).
- Confirm upload succeeds.
- On YouTube, confirm the published video displays as 4:3 (not
  stretched to 1.5:1).

**Composed with Clean Audio:**

- Upload an anamorphic clip with "Clean audio" ON.
- Confirm toast shows "Cleaning audio · N%" (unchanged label, aspect
  tag is piggybacked invisibly).
- On YouTube, confirm both: loudness near -14 LUFS AND aspect 4:3.

**Regression checks:**

- Upload a 16:9 native clip → no ffmpeg pass triggered, upload is
  fast, no behavior change.
- Upload an anamorphic clip with "Clean audio" ON → behaves as
  before this fix (audio chain runs), PLUS aspect tag is correct.
- Cancel button during the lightweight aspect pass still works.

## Phasing

One slice, ships in a single PR. Detection + extended
processClipAudio + new applyAspectMetadata + runUploadItem
integration + toast-label adaptation + flag rename.
