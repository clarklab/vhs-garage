# VHS Capture Station Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a browser-based VHS digitization station at `/capture` that lets a non-technical operator record VHS content to disk, photograph tape sleeves, and manage a clip library — all from Chrome.

**Architecture:** Single Astro page (`capture.astro`) using the shared Base.astro layout. Client-side JavaScript split into ES modules: `app.js` (controller + state machine), `recorder.js` (MediaRecorder + File System Access), `devices.js` (enumeration + hot-plug), `library.js` (localStorage catalog), `sleeve.js` (webcam photo capture). No server, no backend — all browser APIs.

**Tech Stack:** Astro (from migration), Tailwind CSS, MediaRecorder API, File System Access API, Canvas API, localStorage

**Prerequisite:** The Astro migration plan must be complete before starting this plan.

---

### Task 1: Capture Page Shell + Browser Check

**Files:**
- Create: `src/pages/capture.astro`

- [ ] **Step 1: Create capture.astro with layout, browser check, and empty capture UI skeleton**

```astro
---
import Base from '../layouts/Base.astro';
---

<Base title="Capture" description="A browser-based VHS digitization station.">

  <style>
    .rec-btn {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      border: 3px solid #e53935;
      background: transparent;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s;
    }
    .rec-btn:hover { background: rgba(229, 57, 53, 0.1); }
    .rec-btn .rec-dot {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #e53935;
      transition: border-radius 0.2s, width 0.2s, height 0.2s;
    }
    .rec-btn.recording .rec-dot {
      border-radius: 4px;
      width: 28px;
      height: 28px;
    }
    .rec-btn.recording {
      border-color: #e53935;
      animation: rec-pulse 1.5s ease-in-out infinite;
    }
    @keyframes rec-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(229, 57, 53, 0.4); }
      50% { box-shadow: 0 0 0 12px rgba(229, 57, 53, 0); }
    }
    .scanlines {
      background: repeating-linear-gradient(
        0deg,
        transparent,
        transparent 2px,
        rgba(0, 0, 0, 0.08) 2px,
        rgba(0, 0, 0, 0.08) 4px
      );
      pointer-events: none;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }
    .status-dot.connected { background: #4caf50; }
    .status-dot.disconnected { background: #f44336; }
    .status-dot.ready { background: #ff9800; }
  </style>

  <!-- Browser check -->
  <div id="browser-check" class="hidden fixed inset-0 z-50 bg-black flex items-center justify-center p-8">
    <div class="max-w-md text-center">
      <p class="text-2xl mb-4">VHS Capture requires Chrome</p>
      <p class="text-gray-400 text-sm">This app uses the File System Access API to write recordings directly to disk. This API is only available in Chrome.</p>
    </div>
  </div>

  <!-- First-run wizard -->
  <div id="setup-wizard" class="hidden fixed inset-0 z-40 bg-black/95 flex items-center justify-center p-8">
    <div class="max-w-lg w-full">
      <p class="text-lg mb-6">Setup</p>

      <div id="wizard-step-1">
        <p class="text-gray-400 text-sm mb-2">Chrome will ask for camera and microphone access. This is needed to receive the video signal from your capture card.</p>
        <p class="text-sm mb-2">Which device is your VHS capture card?</p>
        <select id="wizard-video" class="w-full bg-black border border-white/30 text-white text-sm p-2 mb-4 focus:outline-none focus:border-white/60">
          <option value="">Select video device...</option>
        </select>
        <p class="text-sm mb-2">Audio source</p>
        <select id="wizard-audio" class="w-full bg-black border border-white/30 text-white text-sm p-2 mb-4 focus:outline-none focus:border-white/60">
          <option value="">Select audio device...</option>
        </select>
        <p class="text-sm mb-2">Which device is your MacBook webcam?</p>
        <select id="wizard-webcam" class="w-full bg-black border border-white/30 text-white text-sm p-2 mb-4 focus:outline-none focus:border-white/60">
          <option value="">Select webcam...</option>
        </select>
        <button id="wizard-next" class="w-full py-2 border border-white/30 text-white/60 hover:text-white hover:border-white/60 transition-colors text-sm">Next →</button>
      </div>

      <div id="wizard-step-2" class="hidden">
        <p class="text-sm mb-4">Where should recordings be saved?</p>
        <button id="wizard-pick-dir" class="w-full py-3 border border-white/30 text-white/60 hover:text-white hover:border-white/60 transition-colors text-sm mb-2">Choose Folder...</button>
        <p id="wizard-dir-name" class="text-gray-500 text-xs mb-4"></p>
        <button id="wizard-finish" class="hidden w-full py-2 bg-white/10 border border-white/30 text-white hover:bg-white/20 transition-colors text-sm">Start Capturing</button>
      </div>
    </div>
  </div>

  <!-- Main capture UI -->
  <div id="capture-app" class="min-h-screen flex flex-col p-4 max-w-4xl mx-auto">

    <!-- Status bar -->
    <div id="status-bar" class="border border-white/20 p-4 mb-4 text-xs">
      <div class="flex flex-wrap gap-x-6 gap-y-2 items-center">
        <span>Video: <span id="status-video-label" class="text-gray-400">—</span> <span id="status-video-dot" class="status-dot disconnected"></span></span>
        <span>Audio: <span id="status-audio-label" class="text-gray-400">—</span> <span id="status-audio-dot" class="status-dot disconnected"></span></span>
        <span>Camera: <span id="status-webcam-label" class="text-gray-400">—</span> <span id="status-webcam-dot" class="status-dot disconnected"></span></span>
        <button id="settings-btn" class="ml-auto text-white/40 hover:text-white/80 transition-colors">Settings</button>
      </div>
    </div>

    <!-- Mode toggle -->
    <div class="flex gap-4 mb-4 text-xs">
      <button id="mode-capture" class="text-white border-b border-white pb-1">Capture</button>
      <button id="mode-library" class="text-white/40 hover:text-white/80 transition-colors pb-1">Library</button>
    </div>

    <!-- Capture mode -->
    <div id="view-capture">
      <!-- Preview -->
      <div class="relative mb-4 bg-[#141214] border border-white/10 aspect-[4/3] max-w-2xl mx-auto overflow-hidden">
        <video id="preview" autoplay playsinline muted class="w-full h-full object-contain bg-black"></video>
        <div class="scanlines absolute inset-0"></div>
        <div id="no-signal" class="absolute inset-0 flex items-center justify-center text-white/20 text-sm">No signal</div>
      </div>

      <!-- Controls -->
      <div class="max-w-2xl mx-auto">
        <div class="mb-4">
          <label class="text-xs text-gray-400 block mb-1">Clip Title</label>
          <input id="clip-title" type="text" placeholder="My Home Videos 1994"
            class="w-full px-3 py-2 bg-black border border-white/30 text-white text-sm placeholder-white/20 focus:outline-none focus:border-white/60" />
        </div>

        <div class="flex items-center justify-center gap-6 mb-6">
          <button id="rec-btn" class="rec-btn" title="Record">
            <div class="rec-dot"></div>
          </button>
          <div class="text-right">
            <p id="rec-timer" class="text-2xl tabular-nums">00:00:00</p>
            <p id="rec-size" class="text-xs text-gray-400">0.0 MB</p>
          </div>
        </div>

        <div class="flex gap-4 text-xs">
          <button id="snap-sleeve-btn" class="text-white/40 hover:text-white/80 transition-colors">Snap Sleeve</button>
          <button id="to-library-btn" class="ml-auto text-white/40 hover:text-white/80 transition-colors">View Library →</button>
        </div>
      </div>
    </div>

    <!-- Library mode -->
    <div id="view-library" class="hidden">
      <div class="flex items-center justify-between mb-4">
        <button id="to-capture-btn" class="text-xs text-white/40 hover:text-white/80 transition-colors">← Back to Capture</button>
        <button id="export-catalog-btn" class="text-xs text-white/40 hover:text-white/80 transition-colors">Export catalog.json</button>
      </div>
      <div id="library-grid" class="grid grid-cols-2 md:grid-cols-3 gap-4">
        <!-- Populated by library.js -->
      </div>
      <p id="library-empty" class="text-gray-500 text-sm text-center py-12">No clips captured yet.</p>
    </div>
  </div>

  <!-- Settings panel -->
  <div id="settings-panel" class="hidden fixed inset-0 z-30 bg-black/90 flex items-center justify-center p-8">
    <div class="max-w-md w-full border border-white/20 p-6">
      <div class="flex items-center justify-between mb-6">
        <p class="text-sm">Settings</p>
        <button id="settings-close" class="text-white/40 hover:text-white/80 text-xs">Close</button>
      </div>

      <div class="space-y-4 text-xs">
        <div>
          <label class="text-gray-400 block mb-1">Video Source</label>
          <select id="setting-video" class="w-full bg-black border border-white/30 text-white text-xs p-2 focus:outline-none focus:border-white/60"></select>
        </div>
        <div>
          <label class="text-gray-400 block mb-1">Audio Source</label>
          <select id="setting-audio" class="w-full bg-black border border-white/30 text-white text-xs p-2 focus:outline-none focus:border-white/60"></select>
        </div>
        <div>
          <label class="text-gray-400 block mb-1">Webcam Source</label>
          <select id="setting-webcam" class="w-full bg-black border border-white/30 text-white text-xs p-2 focus:outline-none focus:border-white/60"></select>
        </div>
        <div>
          <label class="text-gray-400 block mb-1">Save Location</label>
          <button id="setting-pick-dir" class="w-full py-2 border border-white/30 text-white/60 hover:text-white hover:border-white/60 transition-colors text-left px-2">
            <span id="setting-dir-name">Choose folder...</span>
          </button>
        </div>
        <div>
          <label class="text-gray-400 block mb-1">Recording Quality</label>
          <select id="setting-quality" class="w-full bg-black border border-white/30 text-white text-xs p-2 focus:outline-none focus:border-white/60">
            <option value="8000000">Archival (8 Mbps)</option>
            <option value="5000000" selected>High (5 Mbps)</option>
            <option value="2500000">Standard (2.5 Mbps)</option>
          </select>
        </div>
        <div>
          <label class="text-gray-400 block mb-1">Auto-name Format</label>
          <select id="setting-name-format" class="w-full bg-black border border-white/30 text-white text-xs p-2 focus:outline-none focus:border-white/60">
            <option value="title">Title + timestamp</option>
            <option value="timestamp">Timestamp only</option>
          </select>
        </div>
      </div>
    </div>
  </div>

  <!-- Sleeve photo modal -->
  <div id="sleeve-modal" class="hidden fixed inset-0 z-30 bg-black/95 flex items-center justify-center p-8">
    <div class="max-w-lg w-full">
      <p class="text-sm mb-4">Snap VHS Sleeve</p>
      <div class="relative mb-4 bg-[#141214] border border-white/10 aspect-[4/3] overflow-hidden">
        <video id="sleeve-webcam" autoplay playsinline muted class="w-full h-full object-contain bg-black"></video>
      </div>
      <div class="flex gap-4 mb-4">
        <button id="snap-front" class="flex-1 py-2 border border-white/30 text-white/60 hover:text-white hover:border-white/60 transition-colors text-xs">Capture Front</button>
        <button id="snap-back" class="flex-1 py-2 border border-white/30 text-white/60 hover:text-white hover:border-white/60 transition-colors text-xs">Capture Back</button>
      </div>
      <div class="grid grid-cols-2 gap-4 mb-4">
        <div>
          <p class="text-xs text-gray-400 mb-1">Front</p>
          <div id="sleeve-front-preview" class="aspect-[4/3] bg-[#141214] border border-white/10 flex items-center justify-center text-white/10 text-xs">—</div>
        </div>
        <div>
          <p class="text-xs text-gray-400 mb-1">Back</p>
          <div id="sleeve-back-preview" class="aspect-[4/3] bg-[#141214] border border-white/10 flex items-center justify-center text-white/10 text-xs">—</div>
        </div>
      </div>
      <button id="sleeve-done" class="w-full py-2 border border-white/30 text-white/60 hover:text-white hover:border-white/60 transition-colors text-xs">Done</button>
    </div>
  </div>

  <!-- Hidden canvas for thumbnails and sleeve captures -->
  <canvas id="capture-canvas" class="hidden"></canvas>

  <script type="module" src="/scripts/capture/app.js"></script>

</Base>
```

- [ ] **Step 2: Verify the page loads**

```bash
npm run dev
```

Open http://localhost:4321/capture — should show the capture UI shell with "No signal" in the preview area. Nothing is wired up yet.

- [ ] **Step 3: Commit**

```bash
git add src/pages/capture.astro
git commit -m "feat: add capture page shell with all UI elements"
```

---

### Task 2: Device Management Module

**Files:**
- Create: `public/scripts/capture/devices.js`

- [ ] **Step 1: Create devices.js**

```javascript
const SETTINGS_KEY = 'vhsg_capture_settings';

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
}

export function saveSettings(settings) {
  const existing = loadSettings();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...existing, ...settings }));
}

export async function requestPermissions() {
  await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
}

export async function enumerateDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    video: devices.filter(d => d.kind === 'videoinput'),
    audio: devices.filter(d => d.kind === 'audioinput'),
  };
}

export function matchDevice(devices, savedLabel, savedId) {
  if (savedLabel) {
    const byLabel = devices.find(d => d.label === savedLabel);
    if (byLabel) return byLabel;
  }
  if (savedId) {
    const byId = devices.find(d => d.deviceId === savedId);
    if (byId) return byId;
  }
  return null;
}

export function onDeviceChange(callback) {
  navigator.mediaDevices.addEventListener('devicechange', callback);
}

export async function openStream(videoDeviceId, audioDeviceId) {
  return navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: videoDeviceId }, width: { ideal: 720 }, height: { ideal: 480 } },
    audio: { deviceId: { exact: audioDeviceId } },
  });
}

export async function openWebcamStream(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: deviceId } },
    audio: false,
  });
}

export function isChrome() {
  return /Chrome/.test(navigator.userAgent) && !/Edg/.test(navigator.userAgent);
}

export function hasFileSystemAccess() {
  return 'showDirectoryPicker' in window;
}
```

- [ ] **Step 2: Commit**

```bash
mkdir -p public/scripts/capture
git add public/scripts/capture/devices.js
git commit -m "feat: add device management module"
```

---

### Task 3: Recording Pipeline Module

**Files:**
- Create: `public/scripts/capture/recorder.js`

- [ ] **Step 1: Create recorder.js**

```javascript
let mediaRecorder = null;
let writableStream = null;
let startTime = 0;
let totalBytes = 0;
let onTickCallback = null;
let onStopCallback = null;
let timerInterval = null;

export function isRecording() {
  return mediaRecorder && mediaRecorder.state === 'recording';
}

export function getElapsed() {
  if (!startTime) return 0;
  return Math.floor((Date.now() - startTime) / 1000);
}

export function getTotalBytes() {
  return totalBytes;
}

export async function startRecording(stream, directoryHandle, filename, bitrate, { onTick, onStop, onError }) {
  onTickCallback = onTick;
  onStopCallback = onStop;
  totalBytes = 0;

  const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
  writableStream = await fileHandle.createWritable();

  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';

  mediaRecorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: bitrate,
  });

  mediaRecorder.ondataavailable = async (event) => {
    if (event.data.size > 0) {
      try {
        await writableStream.write(event.data);
        totalBytes += event.data.size;
      } catch (err) {
        if (onError) onError(err);
        stopRecording();
      }
    }
  };

  mediaRecorder.onstop = async () => {
    clearInterval(timerInterval);
    try {
      await writableStream.close();
    } catch {}
    writableStream = null;
    const elapsed = getElapsed();
    startTime = 0;
    if (onStopCallback) onStopCallback({ duration: elapsed, fileSize: totalBytes });
  };

  startTime = Date.now();
  mediaRecorder.start(1000);

  timerInterval = setInterval(() => {
    if (onTickCallback) onTickCallback({ elapsed: getElapsed(), bytes: totalBytes });
  }, 500);
}

export function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

export function formatTime(seconds) {
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function formatSize(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export function generateFilename(title, nameFormat) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');

  if (nameFormat === 'timestamp' || !title.trim()) {
    return `VHS_Capture_${date}_${time}.webm`;
  }

  const sanitized = title.trim().replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '_');
  return `${sanitized}_${date}_${time}.webm`;
}
```

- [ ] **Step 2: Commit**

```bash
git add public/scripts/capture/recorder.js
git commit -m "feat: add recording pipeline module"
```

---

### Task 4: Library / Catalog Module

**Files:**
- Create: `public/scripts/capture/library.js`

- [ ] **Step 1: Create library.js**

```javascript
const CATALOG_KEY = 'vhsg_catalog';

export function getClips() {
  try {
    return JSON.parse(localStorage.getItem(CATALOG_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveClips(clips) {
  localStorage.setItem(CATALOG_KEY, JSON.stringify(clips));
}

export function addClip(entry) {
  const clips = getClips();
  clips.unshift(entry);
  saveClips(clips);
}

export function updateClip(id, fields) {
  const clips = getClips();
  const idx = clips.findIndex(c => c.id === id);
  if (idx !== -1) {
    clips[idx] = { ...clips[idx], ...fields };
    saveClips(clips);
  }
}

export function deleteClip(id) {
  const clips = getClips().filter(c => c.id !== id);
  saveClips(clips);
}

export function createClipEntry(title, filename, duration, fileSize, bitrate) {
  return {
    id: 'clip_' + Date.now(),
    title: title || 'Untitled',
    filename,
    date: new Date().toISOString(),
    duration,
    fileSize,
    bitrate,
    thumbnail: null,
    sleeveFront: null,
    sleeveBack: null,
    metadata: { description: '', tags: [], notes: '' },
    status: 'captured',
    youtubeUrl: null,
  };
}

export function captureThumbnail(videoElement) {
  const canvas = document.getElementById('capture-canvas');
  canvas.width = videoElement.videoWidth || 320;
  canvas.height = videoElement.videoHeight || 240;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.7);
}

export async function exportCatalog(directoryHandle) {
  const clips = getClips();
  const json = JSON.stringify(clips, null, 2);
  const fileHandle = await directoryHandle.getFileHandle('catalog.json', { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(json);
  await writable.close();
}

export function renderLibrary(container, emptyMsg, clips, onDelete) {
  if (!clips.length) {
    container.innerHTML = '';
    emptyMsg.classList.remove('hidden');
    return;
  }

  emptyMsg.classList.add('hidden');
  container.innerHTML = clips.map(clip => `
    <div class="border border-white/20 p-3 text-xs" data-id="${clip.id}">
      <div class="aspect-[4/3] bg-[#141214] mb-2 overflow-hidden flex items-center justify-center">
        ${clip.thumbnail ? `<img src="${clip.thumbnail}" class="w-full h-full object-contain" alt="">` : '<span class="text-white/10">No thumbnail</span>'}
      </div>
      <p class="text-white truncate mb-1">${clip.title}</p>
      <p class="text-gray-500">${new Date(clip.date).toLocaleDateString()} · ${formatDuration(clip.duration)} · ${formatLibSize(clip.fileSize)}</p>
      ${clip.sleeveFront ? '<p class="text-gray-500 mt-1">Sleeve: Front' + (clip.sleeveBack ? ' + Back' : '') + '</p>' : ''}
      <button class="delete-clip text-red-400/50 hover:text-red-400 mt-2 transition-colors" data-id="${clip.id}">Delete</button>
    </div>
  `).join('');

  container.querySelectorAll('.delete-clip').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Delete this clip from the catalog?')) {
        onDelete(btn.dataset.id);
      }
    });
  });
}

function formatDuration(seconds) {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function formatLibSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}
```

- [ ] **Step 2: Commit**

```bash
git add public/scripts/capture/library.js
git commit -m "feat: add library/catalog module"
```

---

### Task 5: Sleeve Photo Module

**Files:**
- Create: `public/scripts/capture/sleeve.js`

- [ ] **Step 1: Create sleeve.js**

```javascript
import { openWebcamStream } from './devices.js';

let webcamStream = null;

export async function openSleeveModal(webcamDeviceId) {
  const modal = document.getElementById('sleeve-modal');
  const video = document.getElementById('sleeve-webcam');

  try {
    webcamStream = await openWebcamStream(webcamDeviceId);
    video.srcObject = webcamStream;
    modal.classList.remove('hidden');
  } catch (err) {
    alert('Could not open webcam. Check that it is connected.');
  }
}

export function closeSleeveModal() {
  const modal = document.getElementById('sleeve-modal');
  const video = document.getElementById('sleeve-webcam');

  if (webcamStream) {
    webcamStream.getTracks().forEach(t => t.stop());
    webcamStream = null;
  }
  video.srcObject = null;
  modal.classList.add('hidden');
}

export function capturePhoto() {
  const video = document.getElementById('sleeve-webcam');
  const canvas = document.getElementById('capture-canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

export function showPreview(side, dataUrl) {
  const container = document.getElementById(`sleeve-${side}-preview`);
  container.innerHTML = `<img src="${dataUrl}" class="w-full h-full object-contain" alt="${side}">`;
}

export function clearPreviews() {
  document.getElementById('sleeve-front-preview').innerHTML = '<span class="text-white/10 text-xs">—</span>';
  document.getElementById('sleeve-back-preview').innerHTML = '<span class="text-white/10 text-xs">—</span>';
}

export async function saveSleevePhoto(directoryHandle, basename, side, dataUrl) {
  const filename = `${basename}_${side}.jpg`;
  const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();

  const response = await fetch(dataUrl);
  const blob = await response.blob();
  await writable.write(blob);
  await writable.close();
}
```

- [ ] **Step 2: Commit**

```bash
git add public/scripts/capture/sleeve.js
git commit -m "feat: add sleeve photo capture module"
```

---

### Task 6: Main App Controller

**Files:**
- Create: `public/scripts/capture/app.js`

- [ ] **Step 1: Create app.js — the main controller that wires everything together**

```javascript
import {
  isChrome, hasFileSystemAccess, loadSettings, saveSettings,
  requestPermissions, enumerateDevices, matchDevice, onDeviceChange, openStream
} from './devices.js';
import {
  startRecording, stopRecording, isRecording, formatTime, formatSize, generateFilename
} from './recorder.js';
import {
  getClips, addClip, deleteClip, createClipEntry, captureThumbnail, exportCatalog, renderLibrary
} from './library.js';
import {
  openSleeveModal, closeSleeveModal, capturePhoto, showPreview, clearPreviews, saveSleevePhoto
} from './sleeve.js';

let directoryHandle = null;
let captureStream = null;
let currentSleeveFront = null;
let currentSleeveBack = null;
let currentFilename = null;

async function init() {
  // Browser check
  if (!isChrome() || !hasFileSystemAccess()) {
    document.getElementById('browser-check').classList.remove('hidden');
    return;
  }

  const settings = loadSettings();

  // Check if first run
  if (!settings.videoDeviceLabel) {
    await showSetupWizard();
  } else {
    await startApp();
  }
}

async function showSetupWizard() {
  const wizard = document.getElementById('setup-wizard');
  wizard.classList.remove('hidden');

  try {
    await requestPermissions();
  } catch {
    // Permission denied — wizard will show empty dropdowns
  }

  const { video, audio } = await enumerateDevices();
  populateSelect('wizard-video', video);
  populateSelect('wizard-audio', audio);
  populateSelect('wizard-webcam', video);

  document.getElementById('wizard-next').addEventListener('click', () => {
    const videoSel = document.getElementById('wizard-video');
    const audioSel = document.getElementById('wizard-audio');
    const webcamSel = document.getElementById('wizard-webcam');

    if (!videoSel.value) return;

    const videoDevice = video.find(d => d.deviceId === videoSel.value);
    const audioDevice = audio.find(d => d.deviceId === audioSel.value);
    const webcamDevice = video.find(d => d.deviceId === webcamSel.value);

    saveSettings({
      videoDeviceId: videoSel.value,
      videoDeviceLabel: videoDevice?.label || '',
      audioDeviceId: audioSel.value || '',
      audioDeviceLabel: audioDevice?.label || '',
      webcamDeviceId: webcamSel.value || '',
      webcamDeviceLabel: webcamDevice?.label || '',
      bitrate: 5000000,
      nameFormat: 'title',
    });

    document.getElementById('wizard-step-1').classList.add('hidden');
    document.getElementById('wizard-step-2').classList.remove('hidden');
  });

  document.getElementById('wizard-pick-dir').addEventListener('click', async () => {
    try {
      directoryHandle = await window.showDirectoryPicker();
      document.getElementById('wizard-dir-name').textContent = directoryHandle.name;
      document.getElementById('wizard-finish').classList.remove('hidden');
    } catch {}
  });

  document.getElementById('wizard-finish').addEventListener('click', () => {
    wizard.classList.add('hidden');
    startApp();
  });
}

async function startApp() {
  const settings = loadSettings();

  // Try to open capture stream
  try {
    await requestPermissions();
    const { video, audio } = await enumerateDevices();

    const videoDevice = matchDevice(video, settings.videoDeviceLabel, settings.videoDeviceId);
    const audioDevice = matchDevice(audio, settings.audioDeviceLabel, settings.audioDeviceId);

    updateStatus('video', videoDevice);
    updateStatus('audio', audioDevice);

    const webcamDevice = matchDevice(video, settings.webcamDeviceLabel, settings.webcamDeviceId);
    updateStatusWebcam(webcamDevice);

    if (videoDevice && audioDevice) {
      captureStream = await openStream(videoDevice.deviceId, audioDevice.deviceId);
      const preview = document.getElementById('preview');
      preview.srcObject = captureStream;
      document.getElementById('no-signal').classList.add('hidden');
    }

    populateSettingsDropdowns(video, audio, settings);
  } catch (err) {
    console.warn('Could not open capture stream:', err);
  }

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

  // Wire up all UI
  wireRecordButton();
  wireViewToggle();
  wireSettings();
  wireSleeve();
  wireLibrary();
  wireBeforeUnload();
}

function wireRecordButton() {
  const btn = document.getElementById('rec-btn');
  const titleInput = document.getElementById('clip-title');
  const timerEl = document.getElementById('rec-timer');
  const sizeEl = document.getElementById('rec-size');

  btn.addEventListener('click', async () => {
    if (isRecording()) {
      btn.classList.remove('recording');
      titleInput.readOnly = false;
      stopRecording();
      return;
    }

    if (!directoryHandle) {
      try {
        directoryHandle = await window.showDirectoryPicker();
      } catch {
        return;
      }
    }

    // Verify we still have permission
    const perm = await directoryHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      const req = await directoryHandle.requestPermission({ mode: 'readwrite' });
      if (req !== 'granted') {
        alert('File system permission needed. Please re-select the save folder.');
        try { directoryHandle = await window.showDirectoryPicker(); } catch { return; }
      }
    }

    if (!captureStream) {
      alert('No capture card signal. Check your USB connection.');
      return;
    }

    const settings = loadSettings();
    const title = titleInput.value;
    currentFilename = generateFilename(title, settings.nameFormat || 'title');
    const bitrate = settings.bitrate || 5000000;

    titleInput.readOnly = true;
    btn.classList.add('recording');
    currentSleeveFront = null;
    currentSleeveBack = null;

    await startRecording(captureStream, directoryHandle, currentFilename, bitrate, {
      onTick: ({ elapsed, bytes }) => {
        timerEl.textContent = formatTime(elapsed);
        sizeEl.textContent = formatSize(bytes);
      },
      onStop: ({ duration, fileSize }) => {
        timerEl.textContent = formatTime(duration);
        sizeEl.textContent = formatSize(fileSize);

        const thumbnail = captureThumbnail(document.getElementById('preview'));
        const basename = currentFilename.replace('.webm', '');

        const entry = createClipEntry(title || 'Untitled', currentFilename, duration, fileSize, bitrate);
        entry.thumbnail = thumbnail;
        entry.sleeveFront = currentSleeveFront;
        entry.sleeveBack = currentSleeveBack;
        addClip(entry);

        // Save sleeve photos to disk if captured
        if (currentSleeveFront) {
          saveSleevePhoto(directoryHandle, basename, 'front', currentSleeveFront).catch(() => {});
        }
        if (currentSleeveBack) {
          saveSleevePhoto(directoryHandle, basename, 'back', currentSleeveBack).catch(() => {});
        }

        currentFilename = null;
      },
      onError: (err) => {
        btn.classList.remove('recording');
        titleInput.readOnly = false;
        alert('Recording error: ' + err.message);
      },
    });
  });
}

function wireViewToggle() {
  const captureBtn = document.getElementById('mode-capture');
  const libraryBtn = document.getElementById('mode-library');
  const captureView = document.getElementById('view-capture');
  const libraryView = document.getElementById('view-library');
  const toLibrary = document.getElementById('to-library-btn');
  const toCapture = document.getElementById('to-capture-btn');

  function showCapture() {
    captureView.classList.remove('hidden');
    libraryView.classList.add('hidden');
    captureBtn.classList.add('border-b', 'border-white');
    captureBtn.classList.remove('text-white/40');
    captureBtn.classList.add('text-white');
    libraryBtn.classList.remove('border-b', 'border-white', 'text-white');
    libraryBtn.classList.add('text-white/40');
  }

  function showLibrary() {
    captureView.classList.add('hidden');
    libraryView.classList.remove('hidden');
    libraryBtn.classList.add('border-b', 'border-white');
    libraryBtn.classList.remove('text-white/40');
    libraryBtn.classList.add('text-white');
    captureBtn.classList.remove('border-b', 'border-white', 'text-white');
    captureBtn.classList.add('text-white/40');
    refreshLibrary();
  }

  captureBtn.addEventListener('click', showCapture);
  libraryBtn.addEventListener('click', showLibrary);
  toLibrary.addEventListener('click', showLibrary);
  toCapture.addEventListener('click', showCapture);
}

function wireSettings() {
  const btn = document.getElementById('settings-btn');
  const panel = document.getElementById('settings-panel');
  const close = document.getElementById('settings-close');
  const pickDir = document.getElementById('setting-pick-dir');

  btn.addEventListener('click', () => panel.classList.remove('hidden'));
  close.addEventListener('click', () => {
    panel.classList.add('hidden');
    applySettings();
  });

  pickDir.addEventListener('click', async () => {
    try {
      directoryHandle = await window.showDirectoryPicker();
      document.getElementById('setting-dir-name').textContent = directoryHandle.name;
    } catch {}
  });

  // Load current directory name
  if (directoryHandle) {
    document.getElementById('setting-dir-name').textContent = directoryHandle.name;
  }
}

function applySettings() {
  const settings = {
    bitrate: parseInt(document.getElementById('setting-quality').value),
    nameFormat: document.getElementById('setting-name-format').value,
  };

  const videoSel = document.getElementById('setting-video');
  const audioSel = document.getElementById('setting-audio');
  const webcamSel = document.getElementById('setting-webcam');

  if (videoSel.value) {
    const opt = videoSel.options[videoSel.selectedIndex];
    settings.videoDeviceId = videoSel.value;
    settings.videoDeviceLabel = opt.textContent;
  }
  if (audioSel.value) {
    const opt = audioSel.options[audioSel.selectedIndex];
    settings.audioDeviceId = audioSel.value;
    settings.audioDeviceLabel = opt.textContent;
  }
  if (webcamSel.value) {
    const opt = webcamSel.options[webcamSel.selectedIndex];
    settings.webcamDeviceId = webcamSel.value;
    settings.webcamDeviceLabel = opt.textContent;
  }

  saveSettings(settings);
}

function wireSleeve() {
  const settings = loadSettings();

  document.getElementById('snap-sleeve-btn').addEventListener('click', () => {
    const s = loadSettings();
    if (!s.webcamDeviceId) {
      alert('No webcam configured. Set one in Settings.');
      return;
    }
    clearPreviews();
    openSleeveModal(s.webcamDeviceId);
  });

  document.getElementById('snap-front').addEventListener('click', () => {
    currentSleeveFront = capturePhoto();
    showPreview('front', currentSleeveFront);
  });

  document.getElementById('snap-back').addEventListener('click', () => {
    currentSleeveBack = capturePhoto();
    showPreview('back', currentSleeveBack);
  });

  document.getElementById('sleeve-done').addEventListener('click', () => {
    closeSleeveModal();
  });
}

function wireLibrary() {
  document.getElementById('export-catalog-btn').addEventListener('click', async () => {
    if (!directoryHandle) {
      try {
        directoryHandle = await window.showDirectoryPicker();
      } catch { return; }
    }
    await exportCatalog(directoryHandle);
    alert('catalog.json exported.');
  });
}

function refreshLibrary() {
  const clips = getClips();
  const grid = document.getElementById('library-grid');
  const empty = document.getElementById('library-empty');
  renderLibrary(grid, empty, clips, (id) => {
    deleteClip(id);
    refreshLibrary();
  });
}

function wireBeforeUnload() {
  window.addEventListener('beforeunload', (e) => {
    if (isRecording()) {
      e.preventDefault();
      e.returnValue = 'Recording in progress. Are you sure you want to leave?';
    }
  });
}

// Helpers
function populateSelect(id, devices) {
  const sel = document.getElementById(id);
  devices.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Device ${d.deviceId.slice(0, 8)}`;
    sel.appendChild(opt);
  });
}

function populateSettingsDropdowns(videoDevices, audioDevices, settings) {
  populateSelect('setting-video', videoDevices);
  populateSelect('setting-audio', audioDevices);
  populateSelect('setting-webcam', videoDevices);

  if (settings.videoDeviceId) document.getElementById('setting-video').value = settings.videoDeviceId;
  if (settings.audioDeviceId) document.getElementById('setting-audio').value = settings.audioDeviceId;
  if (settings.webcamDeviceId) document.getElementById('setting-webcam').value = settings.webcamDeviceId;
  if (settings.bitrate) document.getElementById('setting-quality').value = String(settings.bitrate);
  if (settings.nameFormat) document.getElementById('setting-name-format').value = settings.nameFormat;
}

function updateStatus(type, device) {
  const label = document.getElementById(`status-${type}-label`);
  const dot = document.getElementById(`status-${type}-dot`);
  if (device) {
    label.textContent = device.label || 'Connected';
    dot.className = 'status-dot connected';
  } else {
    label.textContent = 'Not found';
    dot.className = 'status-dot disconnected';
  }
}

function updateStatusWebcam(device) {
  const label = document.getElementById('status-webcam-label');
  const dot = document.getElementById('status-webcam-dot');
  if (device) {
    label.textContent = device.label || 'Ready';
    dot.className = 'status-dot ready';
  } else {
    label.textContent = 'Not found';
    dot.className = 'status-dot disconnected';
  }
}

// Boot
init();
```

- [ ] **Step 2: Verify the full capture app loads**

```bash
npm run dev
```

Open http://localhost:4321/capture in Chrome — verify:
- Browser check passes (or shows warning if not Chrome)
- Setup wizard appears on first visit
- After setup, the capture UI shows with status bar
- Preview shows "No signal" if no capture card is connected (expected)
- Mode toggle switches between Capture and Library views
- Settings panel opens and closes

- [ ] **Step 3: Commit**

```bash
git add public/scripts/capture/app.js
git commit -m "feat: add main capture app controller"
```

---

### Task 7: Build and Deploy

- [ ] **Step 1: Run production build**

```bash
npm run build
```

Expected: Build succeeds. Verify capture page exists in output:

```bash
ls dist/capture/index.html
```

- [ ] **Step 2: Preview production build**

```bash
npm run preview
```

Open http://localhost:4321/capture and verify the app loads correctly.

- [ ] **Step 3: Commit and push**

```bash
git add -A
git commit -m "feat: VHS Capture Station - Phase 1 complete"
git push
```

Verify Netlify deploy succeeds and /capture is accessible at vhsgarage.com/capture.
