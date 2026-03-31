import {
  isChrome, hasFileSystemAccess, loadSettings, saveSettings,
  requestPermissions, enumerateDevices, matchDevice, onDeviceChange, openStream
} from './devices.js';
import {
  startRecording, stopRecording, isRecording, formatTime, formatSize, generateFilename, getLastFileHandle
} from './recorder.js';
import {
  getClips, addClip, deleteClip, createClipEntry, captureThumbnail, exportCatalog, renderLibrary
} from './library.js';
import {
  initWebcam, stopWebcam, handleSleeveCapture, handleSleeveRetake, getSleeveData, resetSleeve, saveSleevePhotos
} from './sleeve.js';
import { initMeter, initMeterFromElement, pauseMeter, stopMeter } from './meter.js';

let directoryHandle = null;
let captureStream = null;
let currentFilename = null;
let playbackBlobUrl = null;
let lastClipId = null;

async function init() {
  // Browser check
  if (!isChrome() || !hasFileSystemAccess()) {
    document.getElementById('browser-check').classList.remove('hidden');
    return;
  }

  await startApp();
}

async function startApp() {
  const settings = loadSettings();

  // Try to open capture stream with saved devices
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
      initMeter(captureStream);
    }

    // Auto-connect webcam if saved
    if (webcamDevice) {
      await initWebcam(webcamDevice.deviceId);
    }

    // Load settings into popover
    if (settings.bitrate) document.getElementById('setting-quality').value = String(settings.bitrate);
    if (settings.videoFormat) document.getElementById('setting-format').value = settings.videoFormat;
    if (settings.nameFormat) document.getElementById('setting-name-format').value = settings.nameFormat;
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
  wireDeviceSelectors();
  wireWebcamSelector();
  wireRecordButton();
  wireSleeveCapture();
  wireViewToggle();
  wireDevicePopover();
  wireLibrary();
  wirePlaybackTabs();
  wireBeforeUnload();
}

// --- Inline device selection (capture card) ---

function wireDeviceSelectors() {
  const container = document.getElementById('preview-container');
  const selector = document.getElementById('device-selector');
  const okBtn = document.getElementById('select-video-ok');

  container.addEventListener('click', async (e) => {
    // Don't open selector if stream is active or already showing selector
    if (captureStream || !selector.classList.contains('hidden')) return;
    // Don't trigger from child button clicks inside selector
    if (e.target.closest('#device-selector')) return;

    try {
      await requestPermissions();
    } catch {}
    const { video, audio } = await enumerateDevices();
    populateSelect('select-video', video);
    populateSelect('select-audio', audio);
    selector.classList.remove('hidden');
  });

  okBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const videoId = document.getElementById('select-video').value;
    const audioId = document.getElementById('select-audio').value;
    if (!videoId) return;

    const videoLabel = document.getElementById('select-video').options[document.getElementById('select-video').selectedIndex]?.textContent || '';
    const audioLabel = document.getElementById('select-audio').options[document.getElementById('select-audio').selectedIndex]?.textContent || '';

    try {
      captureStream = await openStream(videoId, audioId);
      const preview = document.getElementById('preview');
      preview.srcObject = captureStream;
      document.getElementById('no-signal').classList.add('hidden');
      selector.classList.add('hidden');
      stopMeter();
      initMeter(captureStream);

      saveSettings({
        ...loadSettings(),
        videoDeviceId: videoId,
        videoDeviceLabel: videoLabel,
        audioDeviceId: audioId,
        audioDeviceLabel: audioLabel,
      });

      updateStatus('video', { label: videoLabel, deviceId: videoId });
      updateStatus('audio', audioId ? { label: audioLabel, deviceId: audioId } : null);
    } catch (err) {
      console.warn('Could not open capture stream:', err);
    }
  });
}

// --- Inline webcam selection ---

function wireWebcamSelector() {
  const container = document.getElementById('webcam-container');
  const selector = document.getElementById('webcam-selector');
  const okBtn = document.getElementById('select-webcam-ok');

  container.addEventListener('click', async (e) => {
    if (!selector.classList.contains('hidden')) return;
    if (e.target.closest('#webcam-selector')) return;

    try {
      await requestPermissions();
    } catch {}
    const { video } = await enumerateDevices();
    populateSelect('select-webcam', video);
    selector.classList.remove('hidden');
  });

  okBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const webcamId = document.getElementById('select-webcam').value;
    if (!webcamId) return;

    const webcamLabel = document.getElementById('select-webcam').options[document.getElementById('select-webcam').selectedIndex]?.textContent || '';

    await initWebcam(webcamId);
    selector.classList.add('hidden');

    saveSettings({
      ...loadSettings(),
      webcamDeviceId: webcamId,
      webcamDeviceLabel: webcamLabel,
    });

    updateStatusWebcam({ label: webcamLabel, deviceId: webcamId });
  });
}

// --- Sleeve capture ---

function wireSleeveCapture() {
  document.getElementById('sleeve-capture-btn').addEventListener('click', () => {
    const result = handleSleeveCapture();
    if (result && result.captured === 'front') {
      analyzeSleevePhoto(result.data);
    }
  });
  document.getElementById('sleeve-retake-btn').addEventListener('click', () => {
    handleSleeveRetake();
  });
}

function resizeForAI(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 800;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        const scale = MAX / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', 0.7));
    };
    img.src = dataUrl;
  });
}

async function analyzeSleevePhoto(imageData) {
  const loader = document.getElementById('clip-info-loader');
  const aiFields = document.getElementById('ai-fields');

  // Show loader, dim only AI-filled fields (leave Title & Description editable)
  loader.classList.remove('hidden');
  aiFields.classList.add('opacity-30', 'pointer-events-none');

  try {
    const smallImage = await resizeForAI(imageData);
    // Send only base64 data, strip the data URL prefix
    const base64 = smallImage.replace(/^data:image\/\w+;base64,/, '');
    const res = await fetch('/.netlify/functions/sleeve-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64 }),
    });
    const info = await res.json();

    if (!res.ok) {
      console.error('Sleeve AI error:', res.status, info);
    } else if (!info.error) {
      if (info.tape) document.getElementById('clip-tape').value = info.tape;
      if (info.year) document.getElementById('clip-year').value = info.year;
      if (info.tags) document.getElementById('clip-tags').value = info.tags;
      if (info.cassetteNotes) document.getElementById('clip-notes').value = info.cassetteNotes;
    }
  } catch (e) {
    console.warn('Sleeve AI analysis failed:', e);
  }

  // Hide loader, restore AI fields
  loader.classList.add('hidden');
  aiFields.classList.remove('opacity-30', 'pointer-events-none');
}

// --- Record button ---

function wireRecordButton() {
  const btn = document.getElementById('rec-btn');
  const titleInput = document.getElementById('clip-title');
  const timerEl = document.getElementById('rec-timer');
  const sizeEl = document.getElementById('rec-size');

  btn.addEventListener('click', async () => {
    if (isRecording()) {
      btn.classList.remove('recording');
      btn.querySelector('.rec-label').textContent = 'REC';
      titleInput.readOnly = false;
      document.getElementById('preview-container').classList.remove('recording-active');
      document.getElementById('rec-overlay-timer').classList.add('hidden');
      stopRecording();
      return;
    }

    if (!directoryHandle) {
      try {
        directoryHandle = await window.showDirectoryPicker();
        document.getElementById('setting-dir-name').textContent = directoryHandle.name;
        document.getElementById('status-dir-label').textContent = directoryHandle.name;
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
    const videoFormat = settings.videoFormat || 'mp4';
    currentFilename = generateFilename(title, settings.nameFormat || 'title', videoFormat);
    const bitrate = settings.bitrate || 5000000;

    titleInput.readOnly = true;
    btn.classList.add('recording');
    btn.querySelector('.rec-label').textContent = 'STOP';
    document.getElementById('preview-container').classList.add('recording-active');
    document.getElementById('rec-overlay-timer').classList.remove('hidden');
    resetSleeve();

    await startRecording(captureStream, directoryHandle, currentFilename, bitrate, videoFormat, {
      onTick: ({ elapsed, bytes }) => {
        const timeStr = formatTime(elapsed);
        timerEl.textContent = timeStr;
        sizeEl.textContent = formatSize(bytes);
        document.getElementById('rec-overlay-timer').textContent = timeStr;
      },
      onStop: async ({ duration, fileSize }) => {
        timerEl.textContent = formatTime(duration);
        sizeEl.textContent = formatSize(fileSize);

        const thumbnail = captureThumbnail(document.getElementById('preview'));
        const basename = currentFilename.replace(/\.(webm|mp4)$/, '');

        // Read metadata fields
        const year = document.getElementById('clip-year')?.value || '';
        const description = document.getElementById('clip-description')?.value || '';
        const tags = document.getElementById('clip-tags')?.value || '';
        const tape = document.getElementById('clip-tape')?.value || '';
        const notes = document.getElementById('clip-notes')?.value || '';

        const entry = createClipEntry(title || 'Untitled', currentFilename, duration, fileSize, bitrate);
        entry.thumbnail = thumbnail;
        entry.year = year;
        entry.description = description;
        entry.tags = tags;
        entry.tape = tape;
        entry.cassetteNotes = notes;

        // Attach sleeve data
        const sleeveData = getSleeveData();
        entry.sleeveFront = sleeveData.front;
        entry.sleeveBack = sleeveData.back;
        addClip(entry);
        lastClipId = entry.id;

        // Save sleeve photos to disk if captured
        saveSleevePhotos(directoryHandle, basename).catch(() => {});

        // Create blob URL from the recorded file for playback
        try {
          const fh = getLastFileHandle();
          if (fh) {
            const file = await fh.getFile();
            if (playbackBlobUrl) URL.revokeObjectURL(playbackBlobUrl);
            playbackBlobUrl = URL.createObjectURL(file);
            const playbackVideo = document.getElementById('playback');
            playbackVideo.src = playbackBlobUrl;
            playbackVideo.load();
            const onReady = () => {
              clearTimeout(fallbackTimer);
              showPlaybackTab();
            };
            playbackVideo.addEventListener('loadeddata', onReady, { once: true });
            const fallbackTimer = setTimeout(() => {
              playbackVideo.removeEventListener('loadeddata', onReady);
              showPlaybackTab();
            }, 3000);
          }
        } catch (err) {
          console.warn('Could not load playback:', err);
        }

        currentFilename = null;
      },
      onError: (err) => {
        btn.classList.remove('recording');
        titleInput.readOnly = false;
        document.getElementById('preview-container').classList.remove('recording-active');
        document.getElementById('rec-overlay-timer').classList.add('hidden');
        alert('Recording error: ' + err.message);
      },
    });
  });
}

// --- View toggle (library overlay) ---

function wireViewToggle() {
  const libraryView = document.getElementById('view-library');
  const toLibrary = document.getElementById('to-library-btn');
  const toCapture = document.getElementById('to-capture-btn');

  toLibrary.addEventListener('click', () => {
    libraryView.classList.remove('hidden');
    refreshLibrary();
  });

  toCapture.addEventListener('click', () => {
    libraryView.classList.add('hidden');
  });
}

// --- Device popover (triggered by clicking status bar) ---

function wireDevicePopover() {
  const statusBar = document.getElementById('status-bar');
  const popover = document.getElementById('device-popover');
  const closeBtn = document.getElementById('device-popover-close');
  const applyBtn = document.getElementById('dp-apply');
  const pickDir = document.getElementById('dp-pick-dir');
  const settingsPopover = document.getElementById('settings-popover');

  statusBar.addEventListener('click', async (e) => {
    e.stopPropagation();
    // Close settings popover if open
    if (settingsPopover) settingsPopover.classList.add('hidden');

    if (!popover.classList.contains('hidden')) {
      popover.classList.add('hidden');
      return;
    }

    // Populate device dropdowns
    try {
      const { video, audio } = await enumerateDevices();
      const settings = loadSettings();

      populateSelect('dp-video', video);
      populateSelect('dp-audio', audio);
      populateSelect('dp-webcam', video);

      if (settings.videoDeviceId) document.getElementById('dp-video').value = settings.videoDeviceId;
      if (settings.audioDeviceId) document.getElementById('dp-audio').value = settings.audioDeviceId;
      if (settings.webcamDeviceId) document.getElementById('dp-webcam').value = settings.webcamDeviceId;
      if (directoryHandle) document.getElementById('dp-dir-name').textContent = directoryHandle.name;
    } catch {}

    popover.classList.remove('hidden');
  });

  closeBtn.addEventListener('click', () => {
    popover.classList.add('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!popover.classList.contains('hidden') && !popover.contains(e.target) && !statusBar.contains(e.target)) {
      popover.classList.add('hidden');
    }
  });

  pickDir.addEventListener('click', async () => {
    try {
      directoryHandle = await window.showDirectoryPicker();
      document.getElementById('dp-dir-name').textContent = directoryHandle.name;
      document.getElementById('status-dir-label').textContent = directoryHandle.name;
    } catch {}
  });

  applyBtn.addEventListener('click', async () => {
    const videoSel = document.getElementById('dp-video');
    const audioSel = document.getElementById('dp-audio');
    const webcamSel = document.getElementById('dp-webcam');

    const videoId = videoSel.value;
    const audioId = audioSel.value;
    const webcamId = webcamSel.value;

    const videoLabel = videoSel.options[videoSel.selectedIndex]?.textContent || '';
    const audioLabel = audioSel.options[audioSel.selectedIndex]?.textContent || '';
    const webcamLabel = webcamSel.options[webcamSel.selectedIndex]?.textContent || '';

    // Save device preferences
    saveSettings({
      ...loadSettings(),
      videoDeviceId: videoId,
      videoDeviceLabel: videoLabel,
      audioDeviceId: audioId,
      audioDeviceLabel: audioLabel,
      webcamDeviceId: webcamId,
      webcamDeviceLabel: webcamLabel,
    });

    // Reopen capture stream if device changed
    if (videoId && audioId) {
      try {
        if (captureStream) captureStream.getTracks().forEach(t => t.stop());
        captureStream = await openStream(videoId, audioId);
        document.getElementById('preview').srcObject = captureStream;
        document.getElementById('no-signal').classList.add('hidden');
        stopMeter();
        initMeter(captureStream);
        updateStatus('video', { label: videoLabel });
        updateStatus('audio', { label: audioLabel });
      } catch (err) {
        console.warn('Could not open stream:', err);
      }
    }

    // Reopen webcam if changed
    if (webcamId) {
      await initWebcam(webcamId);
      updateStatusWebcam({ label: webcamLabel });
    }

    popover.classList.add('hidden');
  });

  // Also wire the settings popover gear for quality/format
  const settingsGear = statusBar; // gear is inside status bar, handled above
  if (settingsPopover) {
    // Settings popover close on outside click
    document.addEventListener('click', (e) => {
      if (!settingsPopover.classList.contains('hidden') && !settingsPopover.contains(e.target)) {
        settingsPopover.classList.add('hidden');
        applyQualitySettings();
      }
    });
  }
}

function applyQualitySettings() {
  const settings = loadSettings();
  settings.bitrate = parseInt(document.getElementById('setting-quality').value);
  settings.videoFormat = document.getElementById('setting-format').value;
  settings.nameFormat = document.getElementById('setting-name-format').value;
  saveSettings(settings);
}

// --- Library ---

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
  }, async (id, filename) => {
    if (!directoryHandle || !filename) {
      alert('Save folder not available. Please re-select it from settings to open files.');
      return;
    }
    try {
      const fileHandle = await directoryHandle.getFileHandle(filename);
      const file = await fileHandle.getFile();
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      console.warn('Could not open file:', err);
      alert('Could not open file. The save folder may need to be re-selected, or the file may have been moved.');
    }
  });
}

// --- Before unload ---

function wireBeforeUnload() {
  window.addEventListener('beforeunload', (e) => {
    if (isRecording()) {
      e.preventDefault();
      e.returnValue = 'Recording in progress. Are you sure you want to leave?';
    }
  });
}

// --- Playback tabs ---

function wirePlaybackTabs() {
  const tabLive = document.getElementById('tab-live');
  const tabPlayback = document.getElementById('tab-playback');
  const deleteBtn = document.getElementById('delete-recording-btn');

  tabLive.addEventListener('click', () => showLiveTab());
  tabPlayback.addEventListener('click', () => showPlaybackTab());

  deleteBtn.addEventListener('click', async () => {
    if (!lastClipId) return;
    if (!confirm('Delete this recording? The file and catalog entry will be removed.')) return;

    // Remove from catalog
    deleteClip(lastClipId);

    // Remove the file from disk
    try {
      const fh = getLastFileHandle();
      if (fh && directoryHandle) {
        await directoryHandle.removeEntry(fh.name);
      }
    } catch (err) {
      console.warn('Could not delete file:', err);
    }

    // Clean up playback
    const playbackVideo = document.getElementById('playback');
    playbackVideo.src = '';
    if (playbackBlobUrl) {
      URL.revokeObjectURL(playbackBlobUrl);
      playbackBlobUrl = null;
    }
    lastClipId = null;

    showLiveTab();
    document.getElementById('tab-playback').classList.add('hidden');
    deleteBtn.classList.add('hidden');
  });
}

function showPlaybackTab() {
  const tabLive = document.getElementById('tab-live');
  const tabPlayback = document.getElementById('tab-playback');
  const preview = document.getElementById('preview');
  const playback = document.getElementById('playback');
  const deleteBtn = document.getElementById('delete-recording-btn');

  tabPlayback.classList.remove('hidden');
  tabPlayback.classList.replace('text-white/30', 'text-white/70');
  tabPlayback.classList.replace('bg-black', 'bg-[#141214]');
  tabPlayback.classList.replace('border-white/10', 'border-white/20');
  tabLive.classList.replace('text-white/70', 'text-white/30');
  tabLive.classList.replace('bg-[#141214]', 'bg-black');
  tabLive.classList.replace('border-white/20', 'border-white/10');

  preview.classList.add('hidden');
  playback.classList.remove('hidden');
  deleteBtn.classList.remove('hidden');

  // Switch meter to playback audio
  pauseMeter();
  try {
    initMeterFromElement(playback);
  } catch {}
}

function showLiveTab() {
  const tabLive = document.getElementById('tab-live');
  const tabPlayback = document.getElementById('tab-playback');
  const preview = document.getElementById('preview');
  const playback = document.getElementById('playback');
  const deleteBtn = document.getElementById('delete-recording-btn');

  tabLive.classList.replace('text-white/30', 'text-white/70');
  tabLive.classList.replace('bg-black', 'bg-[#141214]');
  tabLive.classList.replace('border-white/10', 'border-white/20');
  if (!tabPlayback.classList.contains('hidden')) {
    tabPlayback.classList.replace('text-white/70', 'text-white/30');
    tabPlayback.classList.replace('bg-[#141214]', 'bg-black');
    tabPlayback.classList.replace('border-white/20', 'border-white/10');
  }

  playback.classList.add('hidden');
  preview.classList.remove('hidden');
  deleteBtn.classList.add('hidden');

  // Switch meter back to live capture stream
  pauseMeter();
  if (captureStream) {
    try {
      initMeter(captureStream);
    } catch {}
  }
}

// --- Helpers ---

function populateSelect(id, devices) {
  const sel = document.getElementById(id);
  sel.innerHTML = '';
  devices.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Device ${d.deviceId.slice(0, 8)}`;
    sel.appendChild(opt);
  });
}

function updateStatus(type, device) {
  const label = document.getElementById(`status-${type}-label`);
  const dot = document.getElementById(`status-${type}-dot`);
  if (device) {
    label.textContent = device.label || 'Connected';
    dot.textContent = '\u2593';
    dot.style.color = '#4caf50';
  } else {
    label.textContent = 'Not found';
    dot.textContent = '\u2591';
    dot.style.color = '#f44336';
  }
}

function updateStatusWebcam(device) {
  const label = document.getElementById('status-webcam-label');
  const dot = document.getElementById('status-webcam-dot');
  if (device) {
    label.textContent = device.label || 'Ready';
    dot.textContent = '\u2592';
    dot.style.color = '#ff9800';
  } else {
    label.textContent = 'Not found';
    dot.textContent = '\u2591';
    dot.style.color = '#f44336';
  }
}

// Boot
init();
