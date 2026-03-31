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
  initWebcam, stopWebcam, handleSleeveCapture, getSleeveData, resetSleeve, saveSleevePhotos
} from './sleeve.js';
import { initMeter, stopMeter } from './meter.js';

let directoryHandle = null;
let captureStream = null;
let currentFilename = null;

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
    handleSleeveCapture();
  });
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
      titleInput.readOnly = false;
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
    currentFilename = generateFilename(title, settings.nameFormat || 'title');
    const bitrate = settings.bitrate || 5000000;

    titleInput.readOnly = true;
    btn.classList.add('recording');
    resetSleeve();

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

        // Read metadata fields
        const description = document.getElementById('clip-description')?.value || '';
        const tags = document.getElementById('clip-tags')?.value || '';
        const tape = document.getElementById('clip-tape')?.value || '';
        const notes = document.getElementById('clip-notes')?.value || '';

        const entry = createClipEntry(title || 'Untitled', currentFilename, duration, fileSize, bitrate);
        entry.thumbnail = thumbnail;
        entry.description = description;
        entry.tags = tags;
        entry.tape = tape;
        entry.notes = notes;

        // Attach sleeve data
        const sleeveData = getSleeveData();
        entry.sleeveFront = sleeveData.front;
        entry.sleeveBack = sleeveData.back;
        addClip(entry);

        // Save sleeve photos to disk if captured
        saveSleevePhotos(directoryHandle, basename).catch(() => {});

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
