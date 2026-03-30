# VHS Garage: Astro Migration & Capture Station Design

**Date:** 2026-03-30
**Status:** Draft

---

## Context

VHS Garage is a static site (3 HTML pages) with no build system, heavy duplication across pages, and Tailwind loaded via CDN. Adding a complex 4th page (/capture — a browser-based VHS digitization station) makes the current approach unsustainable. This spec covers two workstreams:

1. **Astro migration** — Convert the site to Astro with shared layouts, proper Tailwind, and Netlify build
2. **Capture station** — Build /capture as a full Phase 1 browser app for recording VHS content

---

## Workstream A: Astro Migration

### Project Structure

```
vhs-garage/
├── astro.config.mjs
├── tailwind.config.mjs
├── package.json
├── public/
│   ├── fonts/VCR.ttf
│   ├── images/
│   │   ├── bg-vertical.webp
│   │   ├── bg-vertical-dark.webp
│   │   ├── favicon.png
│   │   └── unfurl.png
│   ├── video/vhs-garage-loop.mp4
│   └── site.webmanifest
├── src/
│   ├── layouts/
│   │   └── Base.astro
│   ├── components/
│   │   └── Flicker.astro
│   ├── pages/
│   │   ├── index.astro
│   │   ├── watch.astro
│   │   ├── plan.astro
│   │   └── capture.astro
│   └── styles/
│       └── global.css
└── netlify.toml
```

### Base.astro Layout

Shared layout accepting `title` and `description` props. Handles:
- charset, viewport, theme-color
- OG tags (og:type, og:title, og:description, og:image)
- Twitter card tags
- Favicon + apple-touch-icon
- Manifest link
- Tailwind import via global.css
- VCR font loading

```astro
---
interface Props {
  title: string;
  description: string;
}
const { title, description } = Astro.props;
---
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title} — VHS Garage</title>
  <meta name="description" content={description}>
  <meta name="theme-color" content="#000000">
  <meta property="og:type" content="website">
  <meta property="og:title" content={`${title} — VHS Garage`}>
  <meta property="og:description" content={description}>
  <meta property="og:image" content="/unfurl.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content={`${title} — VHS Garage`}>
  <meta name="twitter:description" content={description}>
  <meta name="twitter:image" content="/unfurl.png">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="apple-touch-icon" href="/favicon.png">
  <link rel="manifest" href="/site.webmanifest">
  <slot name="head" />
</head>
<body class="bg-black text-white">
  <slot />
</body>
</html>
```

OG image and favicon use root-relative paths. Astro's build handles the rest.

### global.css

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@font-face {
  font-family: 'VCR';
  src: url('/fonts/VCR.ttf') format('truetype');
}

body {
  font-family: 'VCR', monospace;
}

html {
  scroll-behavior: smooth;
}

@keyframes vhs-dots {
  0%, 100% { content: '\2591\2591\2591'; }
  14% { content: '\2592\2591\2591'; }
  28% { content: '\2593\2592\2591'; }
  42% { content: '\2593\2593\2592'; }
  57% { content: '\2593\2593\2593'; }
  71% { content: '\2593\2593\2592'; }
  85% { content: '\2593\2592\2591'; }
}
```

### Flicker.astro Component

Encapsulates the background images and sine-wave flicker effect used by both index and watch pages:

```astro
<div class="relative w-full">
  <img id="bg-dark" src="/images/bg-vertical-dark.webp" alt="" class="w-full block relative z-10" />
  <img id="bg-light" src="/images/bg-vertical.webp" alt="" class="absolute inset-0 w-full block z-10 transition-opacity duration-150" />
  <slot />
</div>

<script>
  const light = document.getElementById('bg-light');
  const dark = document.getElementById('bg-dark');
  let ready = 0;

  function startFlicker() {
    let t = 0;
    function tick() {
      t += 0.002 + Math.random() * 0.003;
      const v = 0.5
        + 0.35 * Math.sin(t * 1.0)
        + 0.25 * Math.sin(t * 2.7 + 1.3)
        + 0.15 * Math.sin(t * 5.1 + 0.7);
      light.style.opacity = String(Math.max(0, Math.min(1, v)));
      requestAnimationFrame(tick);
    }
    tick();
  }

  [light, dark].forEach(img => {
    if (img.complete) { ready++; }
    else { img.addEventListener('load', () => { ready++; if (ready === 2) startFlicker(); }, { once: true }); }
  });
  if (ready === 2) startFlicker();
</script>
```

### Page Migrations

Each existing HTML file becomes an `.astro` file that imports `Base.astro` and contains only its unique content. The migration is mechanical — extract the body content, remove duplicated head/font/meta, wrap in the layout.

- **index.astro**: Layout + hero section (Flicker component + video) + content section + form + footer
- **watch.astro**: Layout + Flicker component + YouTube player + corner UI + all watch JS
- **plan.astro**: Layout + plan content (simplest page, just styled lists)

### Netlify Configuration

`netlify.toml` replaces `_redirects`:

```toml
[build]
  command = "npm run build"
  publish = "dist"

[build.environment]
  NODE_VERSION = "20"
```

Astro generates clean URLs by default (`/watch/index.html` served as `/watch`), so no redirect rules needed.

### Assets to Move

| Current location | New location | Notes |
|---|---|---|
| `bg-vertical.webp` | `public/images/bg-vertical.webp` | |
| `bg-vertical-dark.webp` | `public/images/bg-vertical-dark.webp` | |
| `favicon.png` | `public/favicon.png` | Keep at root for browser auto-discovery |
| `unfurl.png` | `public/unfurl.png` | Keep at root for OG |
| `VCR.ttf` | `public/fonts/VCR.ttf` | |
| `vhs-garage-loop.mp4` | `public/video/vhs-garage-loop.mp4` | |
| `site.webmanifest` | `public/site.webmanifest` | Update icon path |

### Assets to Remove

These are not referenced by any page:
- `bg-vertical-dark.png` (2.7MB) — WebP version is used
- `bg-vertical.png` (2.4MB) — WebP version is used
- `garage-vertical.png` (2.5MB) — unused
- `vhs-garage-bg.png` (3.3MB) — unused
- `vhs-garage-bg-empty.png` (35KB) — unused
- `vhs-loop.mp4` (3.6MB) — replaced by vhs-garage-loop.mp4
- `video/edits/` directory — ScreenFlow source files, not for production

### Verification

After migration, every page must render identically to the current site:
- Homepage hero with flicker + video + sound toggle + form submission
- /watch with YouTube player, corner UI, settings, fullscreen
- /plan with the three lists
- All meta tags / OG / Twitter cards correct
- Netlify forms still work (data-netlify attribute)
- Site.webmanifest icon resolves

---

## Workstream B: Capture Station (Phase 1)

### Overview

A browser-based VHS digitization station at `/capture`. A non-technical operator plugs in a VCR via USB capture card, opens the page in Chrome, and presses one button to record tape content to disk. No terminal, no drivers.

**Chrome is required** — the File System Access API (`showDirectoryPicker`, `createWritable`) is Chrome-only. The page displays a browser check on load and shows a clear message if not Chrome.

### Visual Design

Uses the same VHS Garage aesthetic as the rest of the site:
- Black background, VCR font, white text
- Accent: warm red-orange (`#e53935`) for the Record button and active states
- Monospace data readouts (timer, file size) in VCR font
- Faint scanline overlay on the video preview (CSS repeating-linear-gradient, low opacity)
- Large touch targets (48px minimum)
- High contrast (WCAG AA)

### Page Structure

The capture page has two modes toggled by a view switcher:

**Capture Mode (default):**
```
┌─ Status Bar ──────────────────────────────────┐
│  Video: USB Video Device        ● Connected   │
│  Audio: USB Digital Audio       ● Connected   │
│  Camera: FaceTime HD Camera     ● Ready       │
│                                    Settings   │
└───────────────────────────────────────────────┘

┌─ Preview ─────────────────────────────────────┐
│                                               │
│         [ Live feed from capture card ]       │
│              4:3 aspect ratio                 │
│                                               │
└───────────────────────────────────────────────┘

┌─ Controls ────────────────────────────────────┐
│  Clip Title: [ __________________________ ]   │
│                                               │
│              ┌──────────────┐                 │
│              │   ● RECORD   │    00:00:00     │
│              └──────────────┘    0.0 MB        │
│                                               │
│  [ Snap Sleeve ]              [ View Library ]│
└───────────────────────────────────────────────┘
```

**Library Mode:**
Grid of clip cards showing thumbnail, title, date, duration, file size, sleeve photos. Metadata editor on card click. Export catalog.json button.

### JavaScript Architecture

```
src/scripts/capture/
├── app.js          ← main controller, state machine, UI orchestration
├── recorder.js     ← MediaRecorder + File System Access write pipeline
├── devices.js      ← enumeration, matching, hot-plug, preferences
├── library.js      ← localStorage catalog CRUD, thumbnail gen, export
└── sleeve.js       ← webcam stream, canvas capture, JPEG blob storage
```

#### app.js — Main Controller

Manages application state and coordinates modules:

```
State: {
  mode: 'capture' | 'library',
  recordingState: 'idle' | 'recording' | 'stopping' | 'interrupted',
  devices: { video: DeviceInfo, audio: DeviceInfo, webcam: DeviceInfo },
  currentClip: { title, startTime, chunks, fileSize },
  settings: { videoDeviceId, audioDeviceId, webcamDeviceId, bitrate, autoNameFormat },
  directoryHandle: FileSystemDirectoryHandle | null,
  isFirstRun: boolean
}
```

Exports an `init()` function called from the page's inline script. Wires up all event listeners and initializes sub-modules.

#### recorder.js — Recording Pipeline

Core recording flow:

1. **Start**: `getUserMedia({ video: { deviceId, width: 720, height: 480 }, audio: { deviceId } })` → `new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond })` → `directoryHandle.getFileHandle(filename, { create: true })` → `fileHandle.createWritable()` → `recorder.start(1000)`
2. **During**: Each `ondataavailable` writes chunk to `WritableStream`. Update timer and cumulative file size.
3. **Stop**: `recorder.stop()` → final chunk written → `writable.close()` → capture thumbnail via canvas → create catalog entry

Exports: `startRecording(stream, directoryHandle, filename, bitrate)`, `stopRecording()`, `getElapsedTime()`, `getFileSize()`

#### devices.js — Device Management

- `enumerateDevices()` on init and on `devicechange` event
- Match stored devices by label first, deviceId second
- Separate video devices into "capture card" and "webcam" based on stored preference
- Hot-plug: if capture card disconnects during recording, call `stopRecording()` gracefully and show alert
- Exports: `getDevices()`, `selectVideoDevice(id)`, `selectAudioDevice(id)`, `selectWebcam(id)`, `onDeviceChange(callback)`

#### library.js — Catalog

- CRUD operations on localStorage key `vhsg_catalog`
- Each entry follows the schema from the spec (id, title, filename, date, duration, fileSize, bitrate, thumbnail, sleeveFront, sleeveBack, metadata, status, youtubeUrl)
- Thumbnail generation: draw video frame to offscreen canvas, export as JPEG base64
- Export: serialize full catalog to JSON, write to directory via File System Access
- Exports: `addClip(entry)`, `getClips()`, `updateClip(id, fields)`, `deleteClip(id)`, `exportCatalog(directoryHandle)`

#### sleeve.js — Sleeve Photo Capture

- Opens webcam stream independently of capture card
- Modal overlay with live preview
- "Capture Front" / "Capture Back" buttons draw current frame to canvas, export as JPEG blob
- Stores as base64 in the current clip's catalog entry
- Exports: `openSleeveModal(webcamDeviceId)`, `capturePhoto(side)`, `closeSleeveModal()`

### First-Run Setup Wizard

Overlay shown when no stored preferences exist:

1. **Step 1**: "Which device is your VHS capture card?" — dropdown of videoinput devices
2. **Step 2**: "Which device is your MacBook webcam?" — dropdown of remaining videoinput devices
3. **Step 3**: "Where should recordings be saved?" — triggers `showDirectoryPicker()`

Brief permission explainer before Step 1: "Chrome will ask for camera and microphone access. This is needed to receive the video signal from your capture card."

### Settings Panel

Drawer/modal accessed via Settings button. Contents:

- **Video Source**: dropdown of videoinput devices
- **Audio Source**: dropdown of audioinput devices
- **Webcam Source**: dropdown of remaining videoinput devices
- **Save Location**: button → `showDirectoryPicker()`, shows current directory name
- **Recording Quality**: dropdown
  - Archival (8 Mbps)
  - High (5 Mbps) — default
  - Standard (2.5 Mbps)
- **Auto-name format**: toggle
  - Title + timestamp: `My_Tape_2026-03-30_1415.webm`
  - Timestamp only: `VHS_Capture_2026-03-30_1415.webm`

All settings persisted to localStorage key `vhsg_capture_settings`.

### Error Handling

| Scenario | Behavior |
|---|---|
| Capture card disconnects during recording | Stop recording, finalize file, alert: "Capture card disconnected. Recording saved." |
| Disk full | Catch write error, stop recording, alert with file size |
| Tab close during recording | `beforeunload` warning; partial file remains on disk |
| getUserMedia denied | Instructions: "Chrome needs camera permission. Click the camera icon in the address bar." |
| Directory handle expired | Prompt to re-select save directory |
| Not Chrome | Show message: "VHS Capture requires Chrome for direct-to-disk recording." |

### File Output

**Naming**: `{Sanitized_Title}_{YYYY-MM-DD}_{HHMM}.webm` (or timestamp-only based on setting)

**Sleeve photos**: `{basename}_front.jpg`, `{basename}_back.jpg`

**All files flat** in the selected directory — no subdirectories.

### Catalog JSON Schema

```json
{
  "id": "clip_1711817100000",
  "title": "My Home Videos 1994",
  "filename": "My_Home_Videos_1994_2026-03-30_1415.webm",
  "date": "2026-03-30T14:15:00",
  "duration": 3847,
  "fileSize": 2415000000,
  "bitrate": 5000000,
  "thumbnail": "data:image/jpeg;base64,...",
  "sleeveFront": "data:image/jpeg;base64,...",
  "sleeveBack": null,
  "metadata": {
    "description": "",
    "tags": [],
    "notes": ""
  },
  "status": "captured",
  "youtubeUrl": null
}
```

### Known Limitations (Phase 1)

- Chrome-only (File System Access API)
- WebM output (VP9), not MP4 — YouTube accepts it; Phase 2 can convert
- No deinterlacing in browser — Phase 2 handles via ffmpeg
- localStorage ~5-10MB limit for sleeve photos — export catalog to disk for large collections
- Directory handle may expire between sessions — app detects and prompts re-selection

### Phase 2 Hooks (not built, but prepared for)

- Catalog schema includes `description`, `tags`, `status`, `youtubeUrl` fields
- Sleeve photos stored and associated with clips for future OCR
- Consistent file naming for pipeline parsing
- Flat directory for script access
- `catalog.json` export gives Phase 2 a machine-readable manifest

---

## Verification Plan

### Astro Migration
1. `npm run build` succeeds with no errors
2. `npm run dev` serves all 4 pages locally
3. Homepage hero flicker + video + sound toggle work identically to current site
4. /watch YouTube player, corner UI, settings, fullscreen all work
5. /plan renders correctly
6. All meta tags / OG / Twitter cards present on every page
7. Netlify deploy succeeds, forms still work
8. No unused assets in build output

### Capture Station
1. Device enumeration lists connected capture card and webcam
2. Live preview shows capture card feed
3. Record/stop produces a valid .webm file in the selected directory
4. Timer and file size update during recording
5. File naming matches the selected format
6. Sleeve photo modal captures front/back JPEGs
7. Library view shows all captured clips with thumbnails
8. Catalog export writes valid JSON
9. Settings persist across page reloads
10. Hot-unplug during recording saves partial file gracefully
11. First-run wizard completes without confusion
12. Works on Chrome; shows browser warning on Safari/Firefox
