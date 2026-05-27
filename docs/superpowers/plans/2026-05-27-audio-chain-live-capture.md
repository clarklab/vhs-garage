# Live capture audio chain — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert a Web Audio chain (high-pass + compressor + +10dB makeup gain) between the capture device and `MediaRecorder` so every recording on disk is audibly louder and free of low-frequency hum. Gated by a single checkbox in the existing Capture Settings popover, default ON.

**Architecture:** New module `public/scripts/capture/audio-chain.js` exporting `buildProcessedStream(inputStream)` that returns a `MediaStream` with the original video track and a processed audio track (output of the Web Audio graph). `app.js` wraps `captureStream` with this helper conditionally before passing to `startRecording`. Existing settings store (`devices.js` `loadSettings`/`saveSettings`) gains one new boolean key.

**Tech Stack:** Vanilla ES modules, Web Audio API (`AudioContext`, `BiquadFilterNode`, `DynamicsCompressorNode`, `GainNode`, `MediaStreamAudioSourceNode`, `MediaStreamAudioDestinationNode`). No new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-05-27-audio-cleanup-design.md` (Section 2 "Live chain architecture", Section 4 "Capture settings panel" subsection).

**Verification note:** This project has no test runner (`package.json` has no test script or deps), so verification is manual via the browser, consistent with the spec's testing approach. Each task has explicit verification steps that must be run before committing.

---

## File map

- **Create:** `public/scripts/capture/audio-chain.js` — Web Audio graph builder. One responsibility: take a `MediaStream`, return a new `MediaStream` with processed audio.
- **Modify:** `public/scripts/capture/app.js` — wrap `captureStream` at the `startRecording` call site (~line 962), hydrate checkbox on page load (~line 156), persist on popover close (~line 1287).
- **Modify:** `src/pages/capture.astro` — add one checkbox row in the settings popover (~line 1765, after the File naming `<div>`).

---

### Task 1: Create the audio-chain module

**Files:**
- Create: `public/scripts/capture/audio-chain.js`

- [ ] **Step 1: Create the module file**

Write the following to `public/scripts/capture/audio-chain.js`:

```js
// audio-chain — Web Audio graph that boosts and cleans VHS line-in audio
// before MediaRecorder writes it to disk.
//
// Why this exists: VHS audio is captured at low reference levels and
// usually carries 60Hz hum and tape hiss. Sent straight through, Matt's
// recordings land noticeably quieter than other YouTube content and
// YouTube's auto-leveler doesn't turn them up (it only turns loud
// uploads down). This chain fixes the loudness side at capture time so
// the on-disk file is already usable.
//
// Graph:
//   sourceTrack → MediaStreamSource
//               → BiquadFilter(highpass, 80Hz, Q=0.7)
//               → DynamicsCompressor(thresh=-30, ratio=6, attack=3ms, release=200ms)
//               → GainNode(+10dB)
//               → MediaStreamDestination → newAudioTrack
//
// The returned stream contains the ORIGINAL video track (passed through
// unchanged) and the PROCESSED audio track. MediaRecorder doesn't know
// the difference.

const HIGHPASS_HZ = 80;
const HIGHPASS_Q = 0.7;
const COMPRESSOR_THRESHOLD = -30;
const COMPRESSOR_KNEE = 12;
const COMPRESSOR_RATIO = 6;
const COMPRESSOR_ATTACK = 0.003;
const COMPRESSOR_RELEASE = 0.2;
const MAKEUP_GAIN_DB = 10;

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

/**
 * Build a processed MediaStream from a raw capture stream.
 *
 * @param {MediaStream} inputStream - Stream from getUserMedia. Must
 *   contain at least one audio track. May contain a video track,
 *   which is forwarded unchanged.
 * @returns {{ stream: MediaStream, dispose: () => void }}
 *   - stream: the new MediaStream to hand to MediaRecorder
 *   - dispose: call when the recording is done — closes the
 *     AudioContext and stops the processed audio track. Idempotent.
 *
 * Throws if inputStream has no audio track.
 */
export function buildProcessedStream(inputStream) {
  const audioTracks = inputStream.getAudioTracks();
  if (audioTracks.length === 0) {
    throw new Error('buildProcessedStream: input stream has no audio track');
  }

  const ctx = new AudioContext();

  // Source — wrap just the audio side of the input stream.
  const audioOnly = new MediaStream(audioTracks);
  const source = ctx.createMediaStreamSource(audioOnly);

  // Highpass — defensive cut so the +10dB boost doesn't amplify hum.
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = HIGHPASS_HZ;
  highpass.Q.value = HIGHPASS_Q;

  // Compressor — lifts quiet dialog toward the ceiling so the makeup
  // gain doesn't just amplify silence-and-shouts.
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = COMPRESSOR_THRESHOLD;
  compressor.knee.value = COMPRESSOR_KNEE;
  compressor.ratio.value = COMPRESSOR_RATIO;
  compressor.attack.value = COMPRESSOR_ATTACK;
  compressor.release.value = COMPRESSOR_RELEASE;

  // Makeup gain — the headline +10dB.
  const makeup = ctx.createGain();
  makeup.gain.value = dbToGain(MAKEUP_GAIN_DB);

  // Destination — produces a MediaStream we can use as the processed
  // audio track.
  const destination = ctx.createMediaStreamDestination();

  source.connect(highpass);
  highpass.connect(compressor);
  compressor.connect(makeup);
  makeup.connect(destination);

  // Combine: original video tracks (untouched) + processed audio track.
  const processedTrack = destination.stream.getAudioTracks()[0];
  const out = new MediaStream([
    ...inputStream.getVideoTracks(),
    processedTrack,
  ]);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try { processedTrack.stop(); } catch {}
    try { ctx.close(); } catch {}
  };

  return { stream: out, dispose };
}
```

- [ ] **Step 2: Verify the module loads without errors**

Run: `node --check public/scripts/capture/audio-chain.js`
Expected: command exits 0 with no output.

- [ ] **Step 3: Manual smoke test in browser console**

Start the dev server: `npm run dev` (runs in foreground; use Ctrl+C to stop later).

Open `http://localhost:4321/capture`, get past the welcome modal, and once the preview is showing live video, open DevTools console and paste:

```js
const mod = await import('/scripts/capture/audio-chain.js');
const probe = mod.buildProcessedStream(document.getElementById('preview').srcObject);
console.log('audio tracks:', probe.stream.getAudioTracks().length);
console.log('video tracks:', probe.stream.getVideoTracks().length);
probe.dispose();
console.log('disposed OK');
```

Expected:
```
audio tracks: 1
video tracks: 1
disposed OK
```

No exceptions in the console. If `srcObject` is `null`, the preview hasn't initialized — wait a few seconds and retry.

- [ ] **Step 4: Commit**

```bash
git add public/scripts/capture/audio-chain.js
git commit -m "$(cat <<'EOF'
feat(capture): add audio-chain module for live VHS audio boost

Web Audio graph (highpass 80Hz → compressor → +10dB gain) that takes
a raw capture stream and returns a new MediaStream with the audio
processed and the video track passed through unchanged. Not yet wired
into the recording flow — that's the next task.

Refs: docs/superpowers/specs/2026-05-27-audio-cleanup-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire the audio chain into the recording flow

**Files:**
- Modify: `public/scripts/capture/app.js:1` (add import) and `:962` (wrap `captureStream`)

- [ ] **Step 1: Add the import**

Find line 1-10 of `public/scripts/capture/app.js`. The file currently starts with an `import` block. Add this import below the existing imports from `./devices.js`:

```js
import { buildProcessedStream } from './audio-chain.js';
```

(Exact placement: right after the `recorder.js` and before any other module imports; if unsure, after the `./devices.js` import line.)

- [ ] **Step 2: Wrap `captureStream` at the `startRecording` call site**

Find line ~962 in `public/scripts/capture/app.js`, the line that currently reads:

```js
    await startRecording(captureStream, directoryHandle, currentFilename, bitrate, videoFormat, {
```

Replace the surrounding block (from line 917 where `settings = loadSettings()` is read, through the `await startRecording(...)` call) so that:

1. We decide if processing is enabled (defaulting to `true`).
2. We build the processed stream and capture its dispose handle.
3. We pass the processed stream to `startRecording`.
4. The existing `onStop` callback also disposes the audio context.

Concretely, change the existing code:

```js
    const settings = loadSettings();
    const title = titleInput.value;
    const videoFormat = settings.videoFormat || 'mp4';
```

…to add the processing decision right after `loadSettings()`:

```js
    const settings = loadSettings();
    // Live audio processing — boosts loudness and cuts hum at the
    // Web Audio level before MediaRecorder sees the stream. Default
    // on; user toggle in the settings popover. See audio-chain.js.
    const audioProcessingEnabled = settings.audioProcessingEnabled !== false;
    let processedDispose = null;
    let recordStream = captureStream;
    if (audioProcessingEnabled) {
      try {
        const built = buildProcessedStream(captureStream);
        recordStream = built.stream;
        processedDispose = built.dispose;
      } catch (e) {
        console.warn('[audio-chain] failed to build, recording raw:', e.message);
        // Fall through — record unprocessed rather than block the user.
      }
    }
    const title = titleInput.value;
    const videoFormat = settings.videoFormat || 'mp4';
```

Then change the `startRecording` call from:

```js
    await startRecording(captureStream, directoryHandle, currentFilename, bitrate, videoFormat, {
```

to:

```js
    await startRecording(recordStream, directoryHandle, currentFilename, bitrate, videoFormat, {
```

Finally, the `onStop` callback that follows (starts at `onStop: async ({ duration, fileSize }) => {`) needs to dispose the audio context when recording ends. Wrap its existing body so the dispose always runs (even if the body throws). Find the existing line:

```js
      onStop: async ({ duration, fileSize }) => {
```

Replace it with:

```js
      onStop: async ({ duration, fileSize }) => {
        // Always tear down the audio chain when recording ends, even
        // if the post-record bookkeeping below throws.
        const finalizeProcessedAudio = () => {
          if (processedDispose) {
            try { processedDispose(); } catch {}
            processedDispose = null;
          }
        };
        try {
```

…and then find the closing `}` of the onStop callback (the matching brace before the next `,` in the `startRecording` options object — currently after the final `}` of the existing body) and insert the `finally` block + closing brace there. The structure should end up looking like:

```js
      onStop: async ({ duration, fileSize }) => {
        const finalizeProcessedAudio = () => { ... };
        try {
          // ... all the existing onStop logic, unchanged ...
        } finally {
          finalizeProcessedAudio();
        }
      },
```

If the existing onStop body is long, leave its contents intact between the `try {` and `} finally {` — only the wrapping changes.

- [ ] **Step 3: Verify the file still parses**

Run: `node --check public/scripts/capture/app.js`
Expected: command exits 0 with no output.

- [ ] **Step 4: Manual verification — record with processing ON**

If the dev server isn't running: `npm run dev`. Open `http://localhost:4321/capture`. Get to the main capture page with a live preview.

In DevTools console, set the flag explicitly (the checkbox doesn't exist yet — that's Task 3):

```js
localStorage.setItem('vhsg_capture_settings', JSON.stringify({
  ...JSON.parse(localStorage.getItem('vhsg_capture_settings') || '{}'),
  audioProcessingEnabled: true,
}));
```

Refresh the page. Play a quiet audio source through the capture card (or sing softly into the line). Record a 5-second clip. After it stops, open the saved file in QuickTime or VLC and confirm:
- Audio plays back clearly louder than the live preview's headphone monitor.
- No clipping (no harsh distortion at peaks).
- Low rumble / 60Hz hum is reduced or gone.

- [ ] **Step 5: Manual verification — record with processing OFF (regression)**

In DevTools console:

```js
localStorage.setItem('vhsg_capture_settings', JSON.stringify({
  ...JSON.parse(localStorage.getItem('vhsg_capture_settings') || '{}'),
  audioProcessingEnabled: false,
}));
```

Refresh. Record another 5-second clip from the same source. Open in QuickTime/VLC and confirm:
- Audio level matches the unprocessed live preview (back to today's behavior).
- No console errors during or after recording.

- [ ] **Step 6: Commit**

```bash
git add public/scripts/capture/app.js
git commit -m "$(cat <<'EOF'
feat(capture): route recording through audio-chain when enabled

Wraps captureStream with buildProcessedStream before passing it to
MediaRecorder, gated by a new audioProcessingEnabled setting (default
true). The processed AudioContext is disposed when recording stops,
including the error path. Falls back to recording raw if the Web
Audio graph fails to build.

The UI toggle for this setting lands in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Add the settings checkbox UI

**Files:**
- Modify: `src/pages/capture.astro:1765` (add checkbox row in settings popover)
- Modify: `public/scripts/capture/app.js:156` (hydrate on load) and `:1287` (persist on popover close)

- [ ] **Step 1: Add the checkbox markup**

Find lines 1759-1765 in `src/pages/capture.astro` — the existing "File naming" `<div>` block:

```astro
      <div>
        <label class="text-gray-400 block mb-1">File naming</label>
        <select id="setting-name-format" class="w-full bg-black border border-white/20 text-white text-xs p-1">
          <option value="title">Title + timestamp</option>
          <option value="timestamp">Timestamp only</option>
        </select>
      </div>
      <div>
        <button id="setting-pick-dir" class="w-full py-1 border border-white/20 text-white/60 hover:text-white text-left px-2">
```

Insert a new `<div>` block between the File naming `</div>` and the directory picker `<div>`. After insertion the markup should read:

```astro
      <div>
        <label class="text-gray-400 block mb-1">File naming</label>
        <select id="setting-name-format" class="w-full bg-black border border-white/20 text-white text-xs p-1">
          <option value="title">Title + timestamp</option>
          <option value="timestamp">Timestamp only</option>
        </select>
      </div>
      <div>
        <label class="text-gray-400 flex items-start gap-2 cursor-pointer">
          <input id="setting-audio-process" type="checkbox" class="mt-0.5 accent-white" />
          <span>
            <span class="block text-white">Auto-boost audio (recommended)</span>
            <span class="block text-[10px] text-white/40">Cleans hum and lifts quiet dialog. Baked into every recording.</span>
          </span>
        </label>
      </div>
      <div>
        <button id="setting-pick-dir" class="w-full py-1 border border-white/20 text-white/60 hover:text-white text-left px-2">
```

- [ ] **Step 2: Hydrate the checkbox on page load**

Find line 156 in `public/scripts/capture/app.js`, currently:

```js
    if (settings.nameFormat) document.getElementById('setting-name-format').value = settings.nameFormat;
```

Add a line immediately after it:

```js
    if (settings.nameFormat) document.getElementById('setting-name-format').value = settings.nameFormat;
    document.getElementById('setting-audio-process').checked = settings.audioProcessingEnabled !== false;
```

(Default behavior: checkbox is checked unless the user has explicitly turned it off. New users with no setting saved get `undefined !== false` → `true` → checked.)

- [ ] **Step 3: Persist the checkbox value on popover close**

Find line 1282-1288 in `public/scripts/capture/app.js`, the `applyQualitySettings` function:

```js
function applyQualitySettings() {
  const settings = loadSettings();
  settings.bitrate = parseInt(document.getElementById('setting-quality').value);
  settings.videoFormat = document.getElementById('setting-format').value;
  settings.nameFormat = document.getElementById('setting-name-format').value;
  saveSettings(settings);
}
```

Add one line so it becomes:

```js
function applyQualitySettings() {
  const settings = loadSettings();
  settings.bitrate = parseInt(document.getElementById('setting-quality').value);
  settings.videoFormat = document.getElementById('setting-format').value;
  settings.nameFormat = document.getElementById('setting-name-format').value;
  settings.audioProcessingEnabled = document.getElementById('setting-audio-process').checked;
  saveSettings(settings);
}
```

- [ ] **Step 4: Verify both files still parse**

Run: `node --check public/scripts/capture/app.js`
Expected: command exits 0 with no output.

Run: `npm run build`
Expected: build completes with "Complete!" — Astro parses `capture.astro` as part of the build. Any markup error fails here.

- [ ] **Step 5: Manual verification — UI default state**

Clear all settings:

```bash
# In the browser DevTools console:
localStorage.removeItem('vhsg_capture_settings');
```

Refresh `/capture`. Click the gear icon (status bar) to open the settings popover. Confirm:
- "Auto-boost audio (recommended)" checkbox is visible between File naming and Choose save folder.
- It's CHECKED by default.
- The description text "Cleans hum and lifts quiet dialog…" renders correctly.

- [ ] **Step 6: Manual verification — toggle persists across reload**

Uncheck the checkbox. Click anywhere outside the popover to close it. Refresh the page. Open the popover again — checkbox should be UNCHECKED.

Re-check it. Close popover. Refresh. Confirm CHECKED.

- [ ] **Step 7: Manual verification — toggle wires through to recording**

Leave the checkbox CHECKED. Record a 5-second clip from a quiet source. Confirm in QuickTime/VLC the file is loud (processed).

Open settings, UNCHECK the box, click outside to close. Record another 5-second clip from the same source. Confirm in QuickTime/VLC the file is back to quiet/unprocessed.

Open settings, CHECK the box again, close. Record once more. Confirm loud again.

- [ ] **Step 8: Commit**

```bash
git add src/pages/capture.astro public/scripts/capture/app.js
git commit -m "$(cat <<'EOF'
feat(capture): add Auto-boost audio checkbox to settings popover

Adds the user-facing toggle for the audio-chain. Default on. Persists
across reload via the existing settings store. Verified end-to-end:
toggling the checkbox in the popover changes whether the next
recording goes through the Web Audio graph.

Closes the live-capture slice of the audio-cleanup spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Done state

After all three tasks land:

- New file `public/scripts/capture/audio-chain.js` exports `buildProcessedStream`.
- `app.js` imports it, wraps `captureStream` conditionally before recording, and disposes the AudioContext on stop.
- Settings popover has a new checkbox "Auto-boost audio (recommended)", default on.
- New recordings are clearly louder with the checkbox on, identical to today's behavior with it off.
- No new dependencies; no build / runtime regressions.

The heavy upload pass (ffmpeg.wasm loudnorm) is a separate plan, to be written after this slice is verified in production.
