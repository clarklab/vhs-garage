# Audio cleanup for VHS captures

**Date:** 2026-05-27
**Status:** Approved design, ready for implementation plan

## Background

Matt's main feedback after a few weeks of capturing is that his uploads
are noticeably quieter than other YouTube channels, and that tape hiss
is audible. Today the capture pipeline does zero audio processing — the
raw line-in from his capture device flows through `MediaRecorder`
straight to disk and then to YouTube. Two reasons this lands quiet:

1. VHS audio is recorded at low reference levels relative to modern
   digital sources, so the unprocessed signal is already 6-10dB below
   what YouTube viewers are accustomed to.
2. YouTube's automatic loudness normalization turns DOWN loud uploads
   to its −14 LUFS target but does NOT turn UP quiet ones, so quiet
   uploads stay quiet relative to channels that mastered to spec.

Hiss is a smaller-but-related problem. It's tolerable on the original
quiet file; any volume boost we apply amplifies it proportionally, so
loudness and denoising are linked.

## Goals

Ship two improvements that compose but are independent:

1. **Live capture chain (default ON):** silently lift the volume and
   cut the worst low-frequency junk so every file written to disk is
   already usable. No user action required.
2. **Heavy upload pass (default OFF, per-batch opt-in):** when the
   user wants the polish, run the file through a denoise + EBU R128
   loudness normalization pass before upload so the published video
   matches the loudness of other YouTube content.

Headline priority is volume. Denoise is the polish.

## Non-goals

- Per-clip audio editing (no waveform UI, no manual EQ).
- Saving processed files back to disk. The heavy pass output exists
  only in memory during upload — the original file on disk is the
  user's archival copy and is never modified.
- Re-processing already-uploaded videos. If the user wants to
  re-clean an upload, they re-upload from the editor.
- Per-clip override of the live chain. It's one global toggle. We
  can revisit if usage shows we need it.

## Architecture

### Live capture chain

New module `public/scripts/capture/audio-chain.js` exporting:

```js
buildProcessedStream(inputStream) → { stream, dispose }
isProcessingEnabled() → boolean
```

`buildProcessedStream` takes the raw `MediaStream` from `getUserMedia`,
builds a Web Audio graph that re-routes the audio track through
processing nodes, and returns a new `MediaStream` with:

- the original video track (unchanged), and
- a processed audio track (output of the graph).

The Web Audio graph:

```
audioTrack → MediaStreamSource
           → BiquadFilter(highpass, 80Hz, Q=0.7)
           → DynamicsCompressor(thresh=-30, ratio=6, attack=3ms, release=200ms)
           → GainNode(+10dB)
           → MediaStreamDestination
           → newAudioTrack
```

The three stages, in order of importance to the user:

- **GainNode at +10dB** — the headline. Makes Matt's files clearly
  louder.
- **DynamicsCompressor (aggressive)** — lifts quiet dialog toward the
  ceiling so the +10dB boost doesn't just amplify silence-and-shouts;
  it amplifies dialog more evenly.
- **BiquadFilter highpass at 80Hz** — defensive. Stops the boost from
  also amplifying 60Hz AC hum into a roar. Doesn't affect dialog.

Integration: in `app.js` where we currently pass `captureStream` to
`startRecording`, wrap it conditionally:

```js
const recordStream = audioProcessingEnabled
  ? buildProcessedStream(captureStream).stream
  : captureStream;
await startRecording(recordStream, ...);
```

The existing VU meter (`meter.js`) keeps reading from the raw track so
the on-screen level reflects what's coming in from the device, not what's
going to disk — better signal for diagnosing input problems.

Settings: new boolean `audioProcessingEnabled` in the existing settings
object, default `true`. Toggle takes effect on the next recording.

### Heavy upload pass

`ffmpeg.wasm` runs a three-stage chain on the recorded file before it
gets PUT to YouTube:

```
afftdn=nr=12:nf=-25  →  arnndn=m=cb.rnnn  →  loudnorm=I=-14:LRA=11:TP=-1.5
```

- **`afftdn`** — FFT-based noise reduction. Kills the steady tape-hiss
  floor amplified by the live chain's +10dB boost.
- **`arnndn`** — RNNoise-based denoiser tuned for speech. Cleans the
  residual crackle/pops around dialog that `afftdn` can't catch.
  Pre-trained model `cb.rnnn` ships with ffmpeg.
- **`loudnorm`** — EBU R128 loudness normalization to −14 LUFS
  (YouTube's target). This is what makes the published video match
  other channels in perceived loudness.

ffmpeg.wasm loading:

- Lazy-loaded on first publish where the box is checked. ~30MB,
  cached by browser HTTP cache for subsequent runs. No service worker.
- Processing is serial per clip: process clip 1 → upload clip 1 →
  process clip 2 → upload clip 2. Existing toast UI gets a new
  "Cleaning audio…" stage with progress parsed from ffmpeg's
  `time=HH:MM:SS.MS / total_duration` stderr lines.
- Output blob is held in memory and passed to the existing upload
  code. The on-disk file is never modified.
- Expected processing time: ~0.5x realtime on a modern Mac. A 30-min
  clip takes ~15 min; a 5-min clip ~2.5 min.

### Failure modes

- **ffmpeg.wasm CDN load fails** → toast shows "Couldn't load audio
  cleaner — uploading original" and continues with the unprocessed
  file. User's opt-in shouldn't block their upload.
- **ffmpeg processing throws** (corrupt input, OOM, malformed audio)
  → same fallback: log error, upload original, non-blocking warning.
- **User cancels mid-process** → kill ffmpeg worker, remove toast, no
  upload starts. Existing toast cancel button is wired to this path.

## UI changes

### Capture settings panel

New checkbox near the audio device selector:

```
[✓] Auto-boost audio (recommended)
    Cleans hum and lifts quiet dialog. Baked into every recording.
```

Setting key `audioProcessingEnabled`, default `true`, persists in
localStorage like other capture settings.

### Publish modal

New row near the playlist pickers, applies to the whole batch:

```
[ ] Clean audio + match YouTube loudness  (adds ~1 min per clip)
    Recommended for tapes with hiss or that sound quieter than other channels.
```

Default unchecked. Session-scoped — resets on page reload (no
persistence, opt-in each time because it's slow).

### Upload toast

When the box is checked, the per-clip toast gains a stage:

```
1. "Cleaning audio…  43%"     ← while ffmpeg processes
2. "Uploading…       72%"     ← existing PUT progress
3. "Uploaded ✓"               ← existing success
```

Same toast widget, same error/dismiss behavior; one extra state in
the state machine.

## Testing approach

No test runner is configured (verified — `package.json` has no test
script and no test deps). Verification is manual and observational.

**Live chain (Section 2):**

- Record a 10-second baseline clip with the checkbox OFF — note
  volume in headphones.
- Record same source with the checkbox ON — verify audibly louder,
  no clipping, hum noticeably reduced.
- Confirm on-disk file matches what was heard (open in QuickTime,
  check VU).
- Test toggle persistence across page reload.
- Test toggle mid-session: change setting → start new recording →
  confirm new setting takes effect.

**Heavy upload pass (Section 3):**

- Take a known-hissy clip (one of Matt's existing tapes), upload
  twice — once with box off, once with box on. Compare on YouTube
  post-publish via the YouTube Studio "loudness target" metric and
  by ear (hiss audible vs not).
- Confirm fallback: temporarily break the ffmpeg CDN URL → upload
  still succeeds with original file + warning toast.
- Confirm toast progress states render correctly
  (cleaning → uploading → success).
- Confirm batch behavior: 3 clips with box checked → see them
  process+upload one at a time, not all at once.

**Regression checks:**

- Upload with both boxes OFF should behave exactly like today (no
  audio-chain code path entered, no ffmpeg load).
- Existing CORS-recovery loop on `xhr.error` still works — uploads
  that hit a lost response still self-heal to success.

## Phasing

Two independent slices, can ship in either order. Recommended order:

1. **Live chain first.** Smallest code, no dependencies, biggest
   immediate impact for Matt. Fixes the headline "too quiet" complaint
   with one ON-by-default checkbox.
2. **Heavy upload pass second.** Adds the YouTube-match polish and
   denoise for tapes where the live chain alone amplifies too much
   hiss. Requires ffmpeg.wasm integration, which is the larger lift.

Each slice gets its own implementation plan and PR.
