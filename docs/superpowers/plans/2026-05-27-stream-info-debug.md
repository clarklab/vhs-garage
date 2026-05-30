# Stream info debug + native resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop hinting `getUserMedia` to give us 480p so capture cards deliver native resolution, and add a small ⓘ icon next to the "░ Live Feed ░" tab that opens a popup showing device label, current size, display aspect (with friendly name), declared+measured fps, and the card's reported max capability.

**Architecture:** One-line edit in `devices.js` drops the resolution constraint. New module `public/scripts/capture/stream-stats.js` holds `readStreamStats(mediaStream)` for the one-shot snapshot and `startFpsMeter(videoEl, onTick)` for the live measurement (returns a `stop()` function). `capture.astro` gets an icon button next to the live tab and a hidden popover `<div>`. `app.js` gains a small `wireStreamInfo()` setup function that handles open/close/repopulate using the existing settings-popover outside-click pattern as the template.

**Tech Stack:** Vanilla ES modules, MediaStream Track APIs (`getSettings`, `getCapabilities`, `label`), `requestVideoFrameCallback` (modern Chromium, with a Safari fallback). No new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-05-27-stream-info-debug-design.md`.

**Verification note:** This project has no test runner (`package.json` has no test deps). Verification is manual via the browser, matching the spec's approach. Each task has explicit verification steps.

---

## File map

- **Modify:** `public/scripts/capture/devices.js` line 50 — drop the `width:`/`height:` constraint from the video `getUserMedia` call.
- **Create:** `public/scripts/capture/stream-stats.js` — new module exporting `readStreamStats(mediaStream)` and `startFpsMeter(videoEl, onTick)`. One responsibility: read/measure stream stats. No DOM coupling beyond an optional `<video>` element for the FPS meter.
- **Modify:** `src/pages/capture.astro` — add the ⓘ icon button next to `#tab-live` (around line 629), and the new `#stream-info-popover` markup near the existing settings popover (around line 1742).
- **Modify:** `public/scripts/capture/app.js` — import `stream-stats`, add `wireStreamInfo()` that handles open/close + populates the body + manages the FPS meter lifecycle, call `wireStreamInfo()` from the existing `wireXxx()` block at line 178-192. Also tap into `onDeviceChange` (line 165) so the popup re-renders when the active device changes.

---

### Task 1: Drop the 480p constraint from openStream

**Files:**
- Modify: `public/scripts/capture/devices.js:50`

- [ ] **Step 1: Make the one-line edit**

Open `public/scripts/capture/devices.js`. Find line 50:

```js
      video: { deviceId: { exact: videoDeviceId }, width: { ideal: 720 }, height: { ideal: 480 } },
```

Change to:

```js
      video: { deviceId: { exact: videoDeviceId } },
```

Leave the rest of the call (audio constraints, the Promise.all, the combined stream) unchanged.

- [ ] **Step 2: Verify the module still parses**

Run: `node --check public/scripts/capture/devices.js`
Expected: exit 0, no output.

- [ ] **Step 3: Manual smoke test (deferred)**

Browser verification (does the live preview still work, do you see a different resolution than before) requires `npm run dev` + a real capture card. Defer to the controller — they'll verify after the popup (Task 4) ships so they can READ the new resolution from the popup directly.

- [ ] **Step 4: Commit**

```bash
git add public/scripts/capture/devices.js
git commit -m "$(cat <<'EOF'
fix(capture): stop hinting 480p — let cards deliver native resolution

getUserMedia's width:ideal/height:ideal is a soft preference, but
some capture cards honor it and downsample even when they could
deliver more. Drop the hint and let the card pick its native format.
The next task adds a stream-info popup so we can see what each
card actually returns.

Refs: docs/superpowers/specs/2026-05-27-stream-info-debug-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Create the stream-stats module

**Files:**
- Create: `public/scripts/capture/stream-stats.js`

- [ ] **Step 1: Create the module file**

Write the following to `public/scripts/capture/stream-stats.js`:

```js
// stream-stats — read-only helpers for inspecting a MediaStream's
// video track. Used by the Stream Info popup to surface what the
// capture card is actually delivering (resolution, aspect, fps).
//
// Two entry points:
//   readStreamStats(mediaStream)   — one-shot snapshot of declared
//                                    settings + capabilities + a
//                                    friendly aspect-ratio label
//   startFpsMeter(videoEl, onTick) — live measurement loop using
//                                    requestVideoFrameCallback;
//                                    calls onTick(fps) ~1×/sec;
//                                    returns a stop() function
//
// Zero DOM coupling in readStreamStats. startFpsMeter takes an
// optional <video> element only because requestVideoFrameCallback
// lives on the HTMLVideoElement, not the track itself.

const ASPECT_LABELS = [
  { ratio: 1.00,  label: '1.00 — square' },
  { ratio: 1.333, label: '1.33 — 4:3 NTSC' },
  { ratio: 1.500, label: '1.50 — 3:2 (anamorphic SD)' },
  { ratio: 1.778, label: '1.78 — 16:9 HD' },
  { ratio: 2.000, label: '2.00 — 2:1' },
];

const ASPECT_TOLERANCE = 0.02;

function aspectLabelFor(ratio) {
  if (!isFinite(ratio) || ratio <= 0) return 'unknown';
  for (const entry of ASPECT_LABELS) {
    if (Math.abs(ratio - entry.ratio) <= ASPECT_TOLERANCE) {
      return entry.label;
    }
  }
  return `${ratio.toFixed(2)} — non-standard`;
}

/**
 * Read a one-shot snapshot of a MediaStream's video track.
 *
 * @param {MediaStream | null} mediaStream
 * @returns {object | null} stats object, or null if the stream has
 *   no video track. Shape:
 *     deviceLabel    string
 *     width, height  numbers (may be 0 if the device hasn't reported)
 *     aspectRatio    number (width/height) or null
 *     aspectLabel    pretty string, e.g. '1.33 — 4:3 NTSC'
 *     declaredFps    number from track.getSettings().frameRate, or null
 *     capabilities   { maxWidth, maxHeight, maxFrameRate } or null
 */
export function readStreamStats(mediaStream) {
  if (!mediaStream) return null;
  const tracks = mediaStream.getVideoTracks();
  if (tracks.length === 0) return null;
  const track = tracks[0];

  const settings = (typeof track.getSettings === 'function')
    ? (track.getSettings() || {}) : {};
  const caps = (typeof track.getCapabilities === 'function')
    ? (track.getCapabilities() || {}) : {};

  const width = Number(settings.width) || 0;
  const height = Number(settings.height) || 0;
  const aspectRatio = (width > 0 && height > 0) ? width / height : null;

  // getCapabilities() returns ranges like { width: { min, max }, ... }.
  // Surface only the max values — that's what the user cares about
  // when asking "is the card capable of more than what I'm getting?"
  let capabilities = null;
  if (caps.width || caps.height || caps.frameRate) {
    capabilities = {
      maxWidth: (caps.width && Number(caps.width.max)) || null,
      maxHeight: (caps.height && Number(caps.height.max)) || null,
      maxFrameRate: (caps.frameRate && Number(caps.frameRate.max)) || null,
    };
    // If every field came back null/zero, treat as "no useful caps".
    if (!capabilities.maxWidth && !capabilities.maxHeight && !capabilities.maxFrameRate) {
      capabilities = null;
    }
  }

  return {
    deviceLabel: track.label || 'unknown device',
    width,
    height,
    aspectRatio,
    aspectLabel: aspectRatio == null ? 'unknown' : aspectLabelFor(aspectRatio),
    declaredFps: (typeof settings.frameRate === 'number') ? settings.frameRate : null,
    capabilities,
  };
}

/**
 * Start a live FPS meter on a <video> element.
 *
 * Uses requestVideoFrameCallback (rVFC) to count actual delivered
 * frames. Falls back to a no-op stop() function if rVFC isn't
 * supported (older Safari).
 *
 * @param {HTMLVideoElement} videoEl
 * @param {(fps: number) => void} onTick - called ~once per second
 *   with the measured frames-per-second over the previous interval
 * @returns {() => void} stop function. Idempotent — second call is
 *   a no-op.
 */
export function startFpsMeter(videoEl, onTick) {
  if (!videoEl || typeof videoEl.requestVideoFrameCallback !== 'function') {
    return () => {};
  }

  let stopped = false;
  let frames = 0;
  let windowStartMs = performance.now();

  const tick = (now) => {
    if (stopped) return;
    frames += 1;
    const elapsed = now - windowStartMs;
    if (elapsed >= 1000) {
      const fps = (frames * 1000) / elapsed;
      try { onTick(fps); } catch {}
      frames = 0;
      windowStartMs = now;
    }
    try { videoEl.requestVideoFrameCallback(tick); } catch {}
  };

  try { videoEl.requestVideoFrameCallback(tick); } catch { return () => {}; }

  return () => { stopped = true; };
}
```

- [ ] **Step 2: Verify the module parses**

Run: `node --check public/scripts/capture/stream-stats.js`
Expected: exit 0, no output.

- [ ] **Step 3: Manual smoke test in browser console (optional)**

If `npm run dev` is already running and a capture card is connected, paste this in DevTools:

```js
const mod = await import('/scripts/capture/stream-stats.js');
console.log(mod.readStreamStats(document.getElementById('preview').srcObject));
```

Expected: an object with `deviceLabel`, `width`, `height`, `aspectLabel`, `declaredFps`, and `capabilities`. Real numbers (not undefined / NaN). If `capabilities` is `null`, that's OK — some browsers don't expose it.

Then test the FPS meter:

```js
const stop = mod.startFpsMeter(document.getElementById('preview'), fps => console.log('fps:', fps.toFixed(2)));
// wait ~3 seconds, watch console
stop();
// console output stops
```

Skip if a card isn't connected — the module just won't have anything meaningful to measure.

- [ ] **Step 4: Commit**

```bash
git add public/scripts/capture/stream-stats.js
git commit -m "$(cat <<'EOF'
feat(capture): add stream-stats module for live stream diagnostics

New module with two exports:
  readStreamStats(mediaStream) — one-shot snapshot of device label,
    resolution, aspect ratio (with friendly label like '1.33 — 4:3
    NTSC'), declared fps, and the card's reported max capability
  startFpsMeter(videoEl, onTick) — requestVideoFrameCallback loop
    that reports measured fps ~1×/sec; returns idempotent stop()

Not yet wired into the UI — the popup that consumes these lands
in the next tasks.

Refs: docs/superpowers/specs/2026-05-27-stream-info-debug-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Add the icon + popup markup to capture.astro

**Files:**
- Modify: `src/pages/capture.astro` line 629 (add icon) and around line 1772 (add popup markup)

- [ ] **Step 1: Add the icon button next to the Live tab**

Find line 629 in `src/pages/capture.astro`:

```astro
          <button id="tab-live" type="button" class="text-white/70 transition-colors leading-none">░ Live Feed ░</button>
          <button id="tab-playback" type="button" class="hidden text-white/30 hover:text-white/70 transition-colors leading-none">░ Last Recording ░</button>
```

Insert the new icon button between them so the line block becomes:

```astro
          <button id="tab-live" type="button" class="text-white/70 transition-colors leading-none">░ Live Feed ░</button>
          <button id="stream-info-btn" type="button" class="text-white/30 hover:text-white/70 transition-colors leading-none text-[11px]" title="Show stream info">ⓘ</button>
          <button id="tab-playback" type="button" class="hidden text-white/30 hover:text-white/70 transition-colors leading-none">░ Last Recording ░</button>
```

- [ ] **Step 2: Add the popup markup**

Find the existing settings popover block at line 1742-1772. Just AFTER its closing `</div>` (so the new popup sits at the same level in the document), insert:

```astro
  <!-- Stream info popover — opened by the ⓘ icon next to the Live
       Feed tab. Shows what the active capture card is actually
       delivering (size, aspect, declared+measured fps, the card's
       reported max capability). Populated by wireStreamInfo() in
       app.js; positioning is set in JS relative to the trigger. -->
  <div id="stream-info-popover" class="hidden fixed z-30 bg-black/95 border border-white/20 p-3 text-[10px] font-mono uppercase tracking-wider" style="min-width: 240px; max-width: 320px;">
    <div class="flex items-center justify-between mb-2">
      <span class="text-white/85">░ Stream Info ░</span>
      <button id="stream-info-close" type="button" class="text-white/40 hover:text-white/80 leading-none px-1">×</button>
    </div>
    <div id="stream-info-body" class="space-y-1.5 text-white/70"></div>
  </div>
```

If you can't find the exact line, search:

```bash
grep -n "settings-popover" src/pages/capture.astro | head -5
```

The popup goes AFTER the closing `</div>` of `#settings-popover`. Insert blank line above for readability.

- [ ] **Step 3: Verify the build succeeds**

Run: `npm run build`
Expected: build completes with "Complete!", page count unchanged. Any malformed markup will fail here.

- [ ] **Step 4: Commit**

```bash
git add src/pages/capture.astro
git commit -m "$(cat <<'EOF'
feat(capture): add ⓘ icon + Stream Info popover markup

New ⓘ button next to '░ Live Feed ░' opens a popover showing the
active capture card's live stream stats. Markup-only commit; JS
wiring (open/close, populate, fps meter lifecycle) lands in the
next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Wire wireStreamInfo() in app.js

**Files:**
- Modify: `public/scripts/capture/app.js` — add import, add `wireStreamInfo()` function, call it from the wire-everything block, hook into `onDeviceChange` to re-render while popup is open.

- [ ] **Step 1: Add the import**

Open `public/scripts/capture/app.js`. Find the existing imports for the audio modules near the top (added in slice 1 and slice 2):

```js
import { buildProcessedStream } from './audio-chain.js';
import { processClipAudio } from './audio-processor.js';
```

Add immediately below them:

```js
import { readStreamStats, startFpsMeter } from './stream-stats.js';
```

- [ ] **Step 2: Define wireStreamInfo()**

Find the existing `wireXxx()` style functions (search `grep -n "^function wire" public/scripts/capture/app.js | head -10` — there are several like `wireDeviceSelectors`, `wireWebcamSelector`, etc.). The exact placement isn't important — convention is each `wire*` lives near the others. A safe spot is immediately before `wireDevicePopover` (around line 1242):

```bash
grep -n "^function wireDevicePopover" public/scripts/capture/app.js
```

Insert the entire function BEFORE that line:

```js
// Stream Info popover — small diagnostic UI accessible via the ⓘ
// icon next to the ░ Live Feed ░ tab. Shows what the active capture
// card is actually delivering: size, aspect, declared+measured fps,
// and the card's reported max capability. Useful for the Reddit-
// style "is this 480p?" / "is this 4:3?" diagnostics.
function wireStreamInfo() {
  const btn = document.getElementById('stream-info-btn');
  const popover = document.getElementById('stream-info-popover');
  const closeBtn = document.getElementById('stream-info-close');
  const body = document.getElementById('stream-info-body');
  if (!btn || !popover || !body) return;

  let stopFpsMeter = null;
  let lastMeasuredFps = null;

  const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const renderBody = () => {
    const stats = readStreamStats(captureStream);
    if (!stats) {
      body.innerHTML = `<div class="text-white/50">No live stream. Pick a device first.</div>`;
      return;
    }

    const sizeStr = (stats.width > 0 && stats.height > 0)
      ? `${stats.width} × ${stats.height}`
      : 'unknown';

    const declared = (stats.declaredFps != null)
      ? stats.declaredFps.toFixed(2)
      : 'unknown';
    const measured = (lastMeasuredFps != null)
      ? lastMeasuredFps.toFixed(1)
      : 'measuring…';

    let capRow = '';
    if (stats.capabilities) {
      const c = stats.capabilities;
      const dim = (c.maxWidth && c.maxHeight)
        ? `${c.maxWidth} × ${c.maxHeight}` : '—';
      const fps = c.maxFrameRate ? `@ ${Math.round(c.maxFrameRate)}` : '';
      capRow = `<div class="flex gap-3"><span class="text-white/40 w-20 shrink-0">Card Max</span><span>${escapeHtml(dim)} ${escapeHtml(fps)}</span></div>`;
    }

    body.innerHTML = `
      <div class="flex gap-3"><span class="text-white/40 w-20 shrink-0">Device</span><span class="break-all">${escapeHtml(stats.deviceLabel)}</span></div>
      <div class="flex gap-3"><span class="text-white/40 w-20 shrink-0">Size</span><span>${escapeHtml(sizeStr)}</span></div>
      <div class="flex gap-3"><span class="text-white/40 w-20 shrink-0">Aspect</span><span>${escapeHtml(stats.aspectLabel)}</span></div>
      <div class="flex gap-3"><span class="text-white/40 w-20 shrink-0">Fps</span><span>${escapeHtml(declared)} declared / ${escapeHtml(measured)} measured</span></div>
      ${capRow}
    `;
  };

  const positionPopover = () => {
    // Anchor under the trigger, aligned to its left edge. Use fixed
    // positioning (matches the class on the popover) so scroll
    // doesn't desync.
    const rect = btn.getBoundingClientRect();
    popover.style.top = `${rect.bottom + 6}px`;
    popover.style.left = `${rect.left}px`;
  };

  const openPopover = () => {
    positionPopover();
    popover.classList.remove('hidden');
    renderBody();
    // Start measuring frames so the row updates live. Re-render on
    // each tick to swap the 'measuring…' text for the fresh value.
    const previewEl = document.getElementById('preview');
    if (previewEl) {
      stopFpsMeter = startFpsMeter(previewEl, (fps) => {
        lastMeasuredFps = fps;
        renderBody();
      });
    }
  };

  const closePopover = () => {
    popover.classList.add('hidden');
    if (stopFpsMeter) { stopFpsMeter(); stopFpsMeter = null; }
    lastMeasuredFps = null;
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popover.classList.contains('hidden')) openPopover();
    else closePopover();
  });

  if (closeBtn) closeBtn.addEventListener('click', closePopover);

  // Outside-click dismiss — same pattern as the settings popover
  // (see line ~1318). Ignore clicks on the trigger itself; its own
  // handler above toggles.
  document.addEventListener('click', (e) => {
    if (popover.classList.contains('hidden')) return;
    if (popover.contains(e.target) || btn.contains(e.target)) return;
    closePopover();
  });

  // Escape dismiss.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popover.classList.contains('hidden')) {
      closePopover();
    }
  });
}
```

- [ ] **Step 3: Call wireStreamInfo() from the wire-everything block**

Find the block of `wireXxx()` calls around line 178-192:

```js
  wireDeviceSelectors();
  wireWebcamSelector();
  wireRecordButton();
  wireSleeveCapture();
  wireViewToggle();
  wireDevicePopover();
  wireToolbarMenus();
  wireLibrary();
  wirePlaybackTabs();
  wireMuteToggle();
  wireSaveData();
  wireTrim();
  wireShorts();
  wireResetButtons();
  wireYouTubePublish();
```

Add `wireStreamInfo();` to the end of this block (after `wireYouTubePublish();`):

```js
  wireYouTubePublish();
  wireStreamInfo();
```

- [ ] **Step 4: Tap onDeviceChange to re-render the popup body**

Find the existing `onDeviceChange` block at line 165:

```js
  // Hot-plug handling
  onDeviceChange(async () => {
    const { video, audio } = await enumerateDevices();
    const s = loadSettings();
    const videoDevice = matchDevice(video, s.videoDeviceLabel, s.videoDeviceId);
    updateStatus('video', videoDevice);

    if (!videoDevice && isRecording()) {
      stopRecording();
      alert('Capture card disconnected. Recording saved.');
    }
  });
```

Add a re-render trigger at the end of the callback. Final shape:

```js
  // Hot-plug handling
  onDeviceChange(async () => {
    const { video, audio } = await enumerateDevices();
    const s = loadSettings();
    const videoDevice = matchDevice(video, s.videoDeviceLabel, s.videoDeviceId);
    updateStatus('video', videoDevice);

    if (!videoDevice && isRecording()) {
      stopRecording();
      alert('Capture card disconnected. Recording saved.');
    }

    // If the Stream Info popup is open, refresh it so the new
    // device's stats render. The popup's own renderBody isn't
    // exposed; fire a synthetic click on the close+open sequence
    // by dispatching from the trigger if the popup is visible.
    const infoPopover = document.getElementById('stream-info-popover');
    const infoBtn = document.getElementById('stream-info-btn');
    if (infoPopover && infoBtn && !infoPopover.classList.contains('hidden')) {
      infoBtn.click(); // close
      infoBtn.click(); // reopen — restarts fps meter against new track
    }
  });
```

Note: the close-then-reopen pattern is a deliberately simple workaround — exposing `renderBody` from `wireStreamInfo` would require a module-level state handle and isn't worth the ceremony for a one-line refresh.

- [ ] **Step 5: Verify the file still parses + the build still succeeds**

Run: `node --check public/scripts/capture/app.js`
Expected: exit 0, no output.

Run: `npm run build`
Expected: build completes with "Complete!".

- [ ] **Step 6: Manual end-to-end verification — DEFER**

Browser end-to-end testing deferred — controller will run after commit lands. Specifically the controller will check:
- Click ⓘ → popup opens anchored under the icon
- All 5 rows render with real numbers
- Measured fps ticks roughly once per second
- Swap devices via toolbar → popup re-renders
- Outside click / × / Escape → popup closes and fps meter stops

- [ ] **Step 7: Commit**

```bash
git add public/scripts/capture/app.js
git commit -m "$(cat <<'EOF'
feat(capture): wire Stream Info popup with live fps measurement

New wireStreamInfo() function handles open/close/populate of the
popup added in the previous task. Uses the existing settings-
popover outside-click pattern. Starts a requestVideoFrameCallback-
based fps meter on open and tears it down on close. Hooks into
the existing onDeviceChange callback so a hot-swap during an open
popup refreshes the displayed stats and rebinds the fps meter to
the new track.

Closes the stream-info-debug spec slice.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Done state

After all four tasks land:

- `openStream` no longer hints `getUserMedia` for 480p. Capture cards deliver native resolution.
- New module `public/scripts/capture/stream-stats.js` exports `readStreamStats` and `startFpsMeter`.
- New ⓘ icon next to the "░ Live Feed ░" tab opens a small popover.
- Popover shows device label, current size, aspect (with friendly label like "1.33 — 4:3 NTSC"), declared+measured fps, and the card's max capability.
- Popover closes on ✕, outside-click, or Escape. FPS meter stops cleanly.
- Hot-swap during an open popover refreshes the displayed stats.
- No regressions to recording, audio chain, or upload flow.
