# Capture native resolution + Stream Info debug popup

**Date:** 2026-05-27
**Status:** Approved design, ready for implementation plan

## Background

Reddit feedback on a recent VHS Garage capture surfaced four
concerns: jitter, combing (interlacing artifacts), low frame rate
(30 vs 60), and the video being 480p in a "wrong aspect ratio." Some
of those are physical-pipeline issues we can't fix in software
(jitter wants a Time Base Corrector; deinterlacing wants either
hardware or a heavy post-process pass). But two are software-side
and addressable today:

1. **We're locking capture to 480p.** `openStream` in `devices.js`
   currently calls `getUserMedia` with `width: { ideal: 720 }, height:
   { ideal: 480 }`. `ideal:` is a soft preference, but capture cards
   that can deliver higher resolutions sometimes honor it and
   downsample. We're paying for the worst-case interpretation on
   every device.

2. **We have zero visibility into what the card is actually
   delivering.** When Matt complains that a recording "looks wrong,"
   we can't tell whether the card is sending 480p or 1080p, what fps
   it's reporting, or what the source aspect ratio is. Debug is a
   round trip through "open DevTools, paste this snippet, send me
   the output."

## Goals

Two changes that compose:

1. **Let cards deliver their native resolution** by removing the
   480p hint from `getUserMedia`. One-line behavior change.
2. **Add a small Stream Info popup** triggered by a tiny ⓘ icon
   next to the "░ Live Feed ░" tab, showing device label, current
   resolution, display aspect (with friendly label), declared fps,
   live-measured fps, and the card's reported max capability.

Together: we stop bottlenecking the capture, and we get permanent
visibility into what the card is delivering so future "looks wrong"
reports can be diagnosed in a screenshot of the popup.

## Non-goals

- Aspect-ratio correction at encode time. If a card delivers 720×480
  with non-square pixels (anamorphic SD), we display and encode at
  the raw pixel dimensions; we don't try to stretch to 4:3 in
  MediaRecorder. That's a separate problem with its own design.
- Frame-rate forcing. We can't ask a card to deliver 60 fps if it's
  sending 30. The popup shows what we have; the user picks a better
  card if they need more.
- Deinterlacing. Out of scope; needs ffmpeg.wasm post-process
  similar to slice 2, deferred until and unless the demand is real.
- A user-facing "resolution preference" UI. The card decides; we
  just expose what it picked. Adding a picker would invite the same
  bottleneck we're removing.

## Architecture

### Drop the constraint

`public/scripts/capture/devices.js:50`:

```js
// Before
video: { deviceId: { exact: videoDeviceId }, width: { ideal: 720 }, height: { ideal: 480 } },

// After
video: { deviceId: { exact: videoDeviceId } },
```

`getUserMedia` without resolution constraints returns the device's
native delivery format. No defaults are added by the browser for
capture-card class devices.

The audio constraints in the same call (`echoCancellation: false`,
etc.) are unrelated and stay as-is.

### Stream-stats module

New file `public/scripts/capture/stream-stats.js` exporting:

```js
readStreamStats(mediaStream) → {
  deviceLabel,    // string from videoTrack.label
  width, height,  // numbers from videoTrack.getSettings()
  aspectRatio,    // width / height, number
  aspectLabel,    // pretty label, e.g. "1.33 — 4:3 NTSC"
  declaredFps,    // from videoTrack.getSettings().frameRate, may be null
  capabilities,   // { maxWidth, maxHeight, maxFrameRate } | null
}

startFpsMeter(videoEl, onTick) → stop()
// requestVideoFrameCallback-based loop counting actually delivered
// frames. Calls onTick(measuredFps) about once per second.
// Returns a stop() function that cancels the loop.
```

Aspect-label mapping covers the common cases with tolerances of
±0.02 so e.g. 1.5005 still resolves to "3:2":

| Ratio range | Label |
|---|---|
| ~1.000 | `1.00 — square` |
| ~1.333 | `1.33 — 4:3 NTSC` |
| ~1.500 | `1.50 — 3:2 (anamorphic SD)` |
| ~1.777 | `1.78 — 16:9 HD` |
| ~2.000 | `2.00 — 2:1` |
| other | `<ratio> — non-standard` |

The 3:2 entry is annotated "anamorphic SD" because that's what a
typical NTSC capture card delivers at 720×480 pixel dimensions even
when the source is logically 4:3 (the pixels are non-square).
Useful diagnostic context for the user.

The module has zero DOM coupling beyond the optional `videoEl`
argument to `startFpsMeter`. Pure data helpers.

### UI changes

**Icon next to the live tab.** `src/pages/capture.astro:629`:

```astro
<!-- Before -->
<button id="tab-live" ...>░ Live Feed ░</button>

<!-- After -->
<button id="tab-live" ...>░ Live Feed ░</button>
<button id="stream-info-btn" type="button" class="text-white/30 hover:text-white/70 transition-colors leading-none text-[11px]" title="Show stream info">ⓘ</button>
```

**Popup markup.** New `<div id="stream-info-popover">` near the
existing settings popover (around line 1742). Hidden by default,
absolutely positioned near the trigger:

```astro
<div id="stream-info-popover" class="hidden fixed z-30 bg-black/95 border border-white/20 p-3 text-[10px] font-mono uppercase tracking-wider" style="min-width: 240px; max-width: 320px;">
  <div class="flex items-center justify-between mb-2">
    <span class="text-white/85">░ Stream Info ░</span>
    <button id="stream-info-close" class="text-white/40 hover:text-white/80">×</button>
  </div>
  <div id="stream-info-body" class="space-y-1.5 text-white/70"></div>
</div>
```

**JS behavior** (lives in `app.js`):
- Click ⓘ → popup opens, anchored under the icon. Calls
  `readStreamStats(captureStream)`, renders rows into
  `#stream-info-body`. Calls `startFpsMeter(previewEl, fps =>
  updateFpsRow(fps))` so the measured-fps row updates live.
- Click ✕ / click outside / Escape → popup closes, FPS meter
  stops, JS releases the `videoEl` reference.
- No active stream → popup body shows `No live stream. Pick a
  device first.` instead of the stat rows.
- Device-swap while popup is open: re-render within ~1 sec
  (FPS meter detects the track change naturally; for the
  one-shot stats, hook into the same device-change pathway that
  `onDeviceChange` already wires).

**Rendered body example:**

```
DEVICE     USB Video Class
SIZE       720 × 480
ASPECT     1.50 — 3:2 (anamorphic SD)
FPS        29.97 declared / 29.8 measured
CARD MAX   1920 × 1080 @ 30
```

Two-column layout (label left, value right) with mono spacing so
the values align even across rows of different label widths.

### Failure modes

- **Stream has no video track** (audio-only or pre-permission state):
  popup shows the empty-state copy, doesn't crash.
- **`videoTrack.getCapabilities()` returns nothing useful** (some
  browsers / older capture cards omit it): popup omits the CARD MAX
  row instead of rendering blanks.
- **`requestVideoFrameCallback` unsupported** (older Safari): popup
  falls back to "n/a measured" and the declared FPS still renders.
- **Native resolution unexpectedly huge** (e.g., a webcam device
  was accidentally selected): nothing crashes; the popup will
  surface the absurd numbers and the user can re-select the right
  device. No automatic clamping — the spec says we trust the card.

## UI consistency

Popup uses the same visual treatment as the existing settings
popover at `capture.astro:1742`: black `bg-black/95`, 1px white/20
border, monospace VCR-aligned with the rest of the chrome. Icon
glyph (ⓘ U+24D8) matches the unicode block style already used
elsewhere in the page header.

## Testing approach

No test runner configured (verified — `package.json` has no test
deps). Manual verification:

**Constraint drop (Section "Architecture / Drop the constraint"):**

- Before deploy: in DevTools console on the current production
  capture page, run `document.getElementById('preview').srcObject
  .getVideoTracks()[0].getSettings()` and note width/height/frameRate.
- After deploy: same check. Larger width/height means a card was
  honoring the 480p hint and we just got better. Same numbers means
  the card was ignoring the hint — no harm, no improvement.

**Stream Info popup (Sections "Stream-stats module" + "UI changes"):**

- Open `/capture` with a real capture card connected.
- Click ⓘ next to "░ Live Feed ░".
- Verify all 5 rows render with real numbers (not undefined / NaN).
- Watch the measured-fps tick at roughly once per second.
- Swap the active capture device via the toolbar VID menu — popup
  contents update within ~1 sec.
- Close via ✕ / outside-click / Escape. Verify in DevTools that no
  `requestVideoFrameCallback` callbacks are still firing.
- Open popup with no device selected → empty-state copy renders.

**Regression checks:**

- Recording still works at the new native resolution (no
  MediaRecorder errors in console).
- Existing recordings on disk are unaffected (we only changed
  capture, not anything post).
- Slice 1's audio chain still engages on the new stream (it operates
  on audio tracks, which are independent).
- Slice 2's ffmpeg upload pass still runs against the new files.

## Phasing

One slice. The constraint drop and the popup ship in the same PR so
we can validate both together: the constraint change is one line,
the popup is the diagnostic that tells us whether the line worked.
