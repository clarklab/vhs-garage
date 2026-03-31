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
