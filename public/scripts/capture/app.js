import {
  isChrome, hasFileSystemAccess, loadSettings, saveSettings,
  requestPermissions, enumerateDevices, matchDevice, onDeviceChange, openStream
} from './devices.js';
import {
  startRecording, stopRecording, isRecording, formatTime, formatSize, generateFilename, getLastFileHandle
} from './recorder.js';
import {
  getClips, addClip, updateClip, deleteClip, createClipEntry, captureThumbnail, exportCatalog, renderLibrary
} from './library.js';
import {
  initWebcam, stopWebcam, handleSleeveCapture, handleSleeveRetake, getSleeveData, getSleeveState,
  getVideoElement, getTargetRect, playShutter, resetSleeve, saveSleevePhotos
} from './sleeve.js';
import { startDetection, stopDetection, pauseDetection, resumeDetection } from './detector.js';
import { initMeter, initMeterFromElement, pauseMeter, stopMeter } from './meter.js';

let directoryHandle = null;
let captureStream = null;
let currentFilename = null;
let playbackBlobUrl = null;
let lastClipId = null;
let publishClip = null;

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
  wireMuteToggle();
  wireSaveData();
  wireResetButtons();
  wireYouTubePublish();
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

// --- Sidecar file saving ---

function generateYouTubeText(entry) {
  const lines = [];
  if (entry.description) lines.push(entry.description);
  lines.push('');
  lines.push('Home video captured from VHS tape.');
  lines.push('');
  if (entry.year) lines.push('Year: ' + entry.year);
  if (entry.tape) lines.push('Tape: ' + entry.tape);
  if (entry.distributor) lines.push('Distributor: ' + entry.distributor);
  if (entry.tapeLength) lines.push('Tape Length: ' + entry.tapeLength);
  if (entry.recordingSpeed) lines.push('Recording Speed: ' + entry.recordingSpeed);
  if (entry.condition) lines.push('Condition: ' + entry.condition);
  if (entry.tags) lines.push('\nTags: ' + entry.tags);
  if (entry.cassetteNotes) lines.push('\n' + entry.cassetteNotes);
  lines.push('');
  lines.push('Captured with VHS Garage');
  lines.push('https://vhsgarage.com');
  return lines.join('\n');
}

async function saveSidecarFiles(dirHandle, basename, entry) {
  if (!dirHandle) return;

  // Strip sleeve image data from JSON (too large for sidecar)
  const jsonEntry = { ...entry };
  delete jsonEntry.thumbnail;
  delete jsonEntry.sleeveFront;
  delete jsonEntry.sleeveBack;

  // Save JSON sidecar
  try {
    const jsonHandle = await dirHandle.getFileHandle(basename + '.json', { create: true });
    const w1 = await jsonHandle.createWritable();
    await w1.write(JSON.stringify(jsonEntry, null, 2));
    await w1.close();
  } catch (e) { console.warn('Could not save JSON sidecar:', e); }

  // Save YouTube plaintext
  try {
    const ytTitle = entry.title || 'Untitled';
    const ytBody = generateYouTubeText(entry);
    const ytText = 'TITLE: ' + ytTitle + '\n\n---\n\n' + ytBody;
    const txtHandle = await dirHandle.getFileHandle(basename + '_youtube.txt', { create: true });
    const w2 = await txtHandle.createWritable();
    await w2.write(ytText);
    await w2.close();
  } catch (e) { console.warn('Could not save YouTube text:', e); }
}

// --- Sleeve capture ---

function updateTargetOverlay(state, progress) {
  const target = document.getElementById('sleeve-target');
  const inner = target?.querySelector('.scan-border');
  const status = document.getElementById('scan-status');
  const dot = document.getElementById('detect-dot');
  const label = document.getElementById('detect-label');
  const countdown = document.getElementById('detect-countdown');
  const bar = document.getElementById('detect-progress');
  if (!inner || !status) return;

  // Progress bar
  if (bar) bar.style.width = (progress * 100) + '%';

  switch (state) {
    case 'loading':
      inner.style.borderColor = 'rgba(255,255,255,0.15)';
      inner.classList.remove('scanning');
      status.textContent = 'Loading scanner...';
      status.style.color = 'rgba(255,255,255,0.2)';
      if (dot) dot.style.background = '#555';
      if (label) { label.textContent = 'Loading OpenCV...'; label.style.color = 'rgba(255,255,255,0.3)'; }
      if (countdown) countdown.textContent = '';
      break;
    case 'idle':
      inner.style.borderColor = 'rgba(255,255,255,0.25)';
      inner.classList.add('scanning');
      status.textContent = getSleeveState() === 'front_captured' ? 'Flip & scan back' : 'Scanning';
      status.style.color = 'rgba(255,255,255,0.3)';
      if (dot) dot.style.background = '#555';
      if (label) { label.textContent = 'No rectangle'; label.style.color = 'rgba(255,255,255,0.3)'; }
      if (countdown) countdown.textContent = '';
      break;
    case 'detected':
      inner.style.borderColor = 'rgba(234,179,8,0.5)';
      inner.classList.add('scanning');
      status.textContent = 'Hold steady...';
      status.style.color = 'rgba(234,179,8,0.7)';
      if (dot) dot.style.background = '#eab308';
      if (label) { label.textContent = 'Rectangle found'; label.style.color = 'rgba(234,179,8,0.7)'; }
      if (countdown) countdown.textContent = 'hold still';
      break;
    case 'capturing':
      inner.style.borderColor = 'rgba(34,197,94,0.6)';
      inner.classList.add('scanning');
      const remaining = Math.ceil((1 - progress) * 0.6 * 10) / 10;
      status.textContent = 'Capturing...';
      status.style.color = 'rgba(34,197,94,0.8)';
      if (dot) dot.style.background = '#22c55e';
      if (label) { label.textContent = 'Steady...'; label.style.color = 'rgba(34,197,94,0.8)'; }
      if (countdown) { countdown.textContent = remaining.toFixed(1) + 's'; countdown.style.color = 'rgba(34,197,94,0.6)'; }
      break;
    case 'snapped':
      inner.style.borderColor = 'rgba(34,197,94,0.9)';
      inner.classList.remove('scanning');
      status.textContent = 'Captured!';
      status.style.color = 'rgba(34,197,94,0.9)';
      if (dot) dot.style.background = '#22c55e';
      if (label) { label.textContent = 'Captured!'; label.style.color = 'rgba(34,197,94,0.9)'; }
      if (countdown) countdown.textContent = '';
      if (bar) bar.style.background = '#22c55e';
      break;
  }
}

async function tryStartDetection() {
  const video = getVideoElement();
  const rect = getTargetRect();
  console.log('[sleeve] tryStartDetection', { video: !!video, rect, srcObject: !!video?.srcObject, state: getSleeveState() });
  if (!video || !rect || !video.srcObject) return;
  const state = getSleeveState();
  if (state === 'done') return;

  updateTargetOverlay('idle');
  await startDetection(video, rect, () => {
    // Auto-snap triggered
    playShutter();
    const result = handleSleeveCapture();
    if (result && result.captured === 'front') {
      // Don't analyze yet — wait for back
      setTimeout(() => tryStartDetection(), 1500);
    } else if (result && result.captured === 'back') {
      // Both captured — now analyze with both images
      const sleeveData = getSleeveData();
      analyzeSleevePhotos(sleeveData.front, sleeveData.back);
    }
  }, updateTargetOverlay);
}

function wireSleeveCapture() {
  // Manual button click — still works as override
  document.getElementById('sleeve-capture-btn').addEventListener('click', () => {
    pauseDetection();
    playShutter();
    const result = handleSleeveCapture();
    if (result && result.captured === 'front') {
      // Don't analyze yet — wait for back
      setTimeout(() => tryStartDetection(), 1500);
    } else if (result && result.captured === 'back') {
      // Both captured — analyze with both images
      const sleeveData = getSleeveData();
      analyzeSleevePhotos(sleeveData.front, sleeveData.back);
    }
  });
  document.getElementById('sleeve-retake-btn').addEventListener('click', () => {
    handleSleeveRetake();
    tryStartDetection();
  });

  // Start detection once webcam video is playing
  const video = getVideoElement();
  if (video) {
    video.addEventListener('playing', () => {
      // Small delay to let video dimensions stabilize
      setTimeout(() => tryStartDetection(), 500);
    });
  }
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

async function analyzeSleevePhotos(frontData, backData) {
  const loader = document.getElementById('clip-info-loader');
  const aiFields = document.getElementById('ai-fields');

  // Show loader, dim only AI-filled fields (leave Clip Title & Description editable)
  loader.classList.remove('hidden');
  aiFields.classList.add('opacity-30', 'pointer-events-none');

  try {
    const smallFront = await resizeForAI(frontData);
    const base64Front = smallFront.replace(/^data:image\/\w+;base64,/, '');

    const payload = { image: base64Front };
    if (backData) {
      const smallBack = await resizeForAI(backData);
      payload.imageBack = smallBack.replace(/^data:image\/\w+;base64,/, '');
    }

    const res = await fetch('/.netlify/functions/sleeve-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const info = await res.json();

    if (!res.ok) {
      console.error('Sleeve AI error:', res.status, info);
    } else if (!info.error) {
      if (info.tape) document.getElementById('clip-tape').value = info.tape;
      if (info.year) document.getElementById('clip-year').value = info.year;
      if (info.tags) document.getElementById('clip-tags').value = info.tags;
      if (info.distributor) document.getElementById('clip-distributor').value = info.distributor;
      if (info.tapeLength) document.getElementById('clip-tape-length').value = info.tapeLength;
      if (info.recordingSpeed) document.getElementById('clip-speed').value = info.recordingSpeed;
      if (info.condition) document.getElementById('clip-condition').value = info.condition;
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
      document.getElementById('preview-container').classList.remove('recording-active');
      document.getElementById('rec-overlay-timer').classList.add('hidden');
      const legend = document.getElementById('preview-legend');
      if (legend) legend.textContent = '░ Live ░';
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

    btn.classList.add('recording');
    btn.querySelector('.rec-label').textContent = 'STOP';
    document.getElementById('preview-container').classList.add('recording-active');
    document.getElementById('rec-overlay-timer').classList.remove('hidden');
    const legend = document.getElementById('preview-legend');
    if (legend) legend.textContent = '░ Recording ░';
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
        const distributor = document.getElementById('clip-distributor')?.value || '';
        const tapeLength = document.getElementById('clip-tape-length')?.value || '';
        const speed = document.getElementById('clip-speed')?.value || '';
        const condition = document.getElementById('clip-condition')?.value || '';

        // Read title fresh (user may have edited during recording)
        const currentTitle = titleInput.value || title || 'Untitled';
        const entry = createClipEntry(currentTitle, currentFilename, duration, fileSize, bitrate);
        entry.thumbnail = thumbnail;
        entry.year = year;
        entry.description = description;
        entry.tags = tags;
        entry.tape = tape;
        entry.cassetteNotes = notes;
        entry.distributor = distributor;
        entry.tapeLength = tapeLength;
        entry.recordingSpeed = speed;
        entry.condition = condition;

        // Attach sleeve data
        const sleeveData = getSleeveData();
        entry.sleeveFront = sleeveData.front;
        entry.sleeveBack = sleeveData.back;
        addClip(entry);
        lastClipId = entry.id;

        // Save sleeve photos to disk if captured
        saveSleevePhotos(directoryHandle, basename).catch(() => {});

        // Save sidecar JSON + YouTube plaintext to disk
        saveSidecarFiles(directoryHandle, basename, entry).catch(() => {});

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

  // Only provide onOpen if we have a directoryHandle this session
  const onOpen = directoryHandle ? async (id, filename) => {
    if (!filename) return;
    try {
      const fileHandle = await directoryHandle.getFileHandle(filename);
      const file = await fileHandle.getFile();
      const url = URL.createObjectURL(file);
      const clip = clips.find(c => c.id === id);
      openPlayerModal(url, clip);
    } catch (err) {
      console.warn('Could not open file:', err);
      alert('Could not open file. The save folder may need to be re-selected.');
    }
  } : null;

  // Only offer Upload when the user has a directory handle this session
  // (so we can read the video file) AND the publish flow is wired up.
  const onUpload = directoryHandle && publishClip
    ? (id) => publishClip(id)
    : null;

  renderLibrary(grid, empty, clips, (id) => {
    deleteClip(id);
    refreshLibrary();
  }, onOpen, onUpload);
}

// --- Clip playback modal ---

let playerModalBlobUrl = null;

function openPlayerModal(url, clip) {
  const modal = document.getElementById('clip-player-modal');
  const video = document.getElementById('player-modal-video');
  const title = document.getElementById('player-modal-title');
  const filename = document.getElementById('player-modal-filename');
  const meta = document.getElementById('player-modal-meta');
  const playBtn = document.getElementById('player-modal-play');
  const btn1x = document.getElementById('player-modal-1x');
  const btn2x = document.getElementById('player-modal-2x');
  const btn4x = document.getElementById('player-modal-4x');

  if (playerModalBlobUrl) URL.revokeObjectURL(playerModalBlobUrl);
  playerModalBlobUrl = url;

  title.textContent = clip?.title || 'Untitled';
  filename.textContent = clip?.filename || '';

  const parts = [];
  if (clip?.date) parts.push(new Date(clip.date).toLocaleDateString());
  if (clip?.duration) parts.push(Math.floor(clip.duration / 60) + 'm ' + (clip.duration % 60) + 's');
  if (clip?.fileSize) {
    const mb = clip.fileSize / (1024 * 1024);
    parts.push(mb < 1024 ? mb.toFixed(0) + ' MB' : (mb / 1024).toFixed(1) + ' GB');
  }
  if (clip?.tape) parts.push(clip.tape);
  if (clip?.year) parts.push(clip.year);
  meta.textContent = parts.join(' · ');

  video.src = url;
  video.playbackRate = 1;
  video.play();

  playBtn.textContent = 'Pause';
  setSpeedActive(btn1x, [btn1x, btn2x, btn4x]);

  modal.classList.remove('hidden');

  // Play/Pause
  playBtn.onclick = () => {
    if (video.paused) { video.play(); playBtn.textContent = 'Pause'; }
    else { video.pause(); playBtn.textContent = 'Play'; }
  };

  video.onplay = () => playBtn.textContent = 'Pause';
  video.onpause = () => playBtn.textContent = 'Play';

  // Speed buttons
  btn1x.onclick = () => { video.playbackRate = 1; setSpeedActive(btn1x, [btn1x, btn2x, btn4x]); };
  btn2x.onclick = () => { video.playbackRate = 2; setSpeedActive(btn2x, [btn1x, btn2x, btn4x]); };
  btn4x.onclick = () => { video.playbackRate = 4; setSpeedActive(btn4x, [btn1x, btn2x, btn4x]); };

  // Close
  document.getElementById('player-modal-close').onclick = () => closePlayerModal();
}

function setSpeedActive(active, all) {
  all.forEach(b => {
    b.classList.remove('bg-white/10', 'border-white/30', 'text-white/70');
    b.classList.add('border-white/20', 'text-white/40');
  });
  active.classList.remove('border-white/20', 'text-white/40');
  active.classList.add('bg-white/10', 'border-white/30', 'text-white/70');
}

function closePlayerModal() {
  const modal = document.getElementById('clip-player-modal');
  const video = document.getElementById('player-modal-video');
  video.pause();
  video.src = '';
  modal.classList.add('hidden');
  if (playerModalBlobUrl) {
    URL.revokeObjectURL(playerModalBlobUrl);
    playerModalBlobUrl = null;
  }
}

// --- Mute toggle ---

function wireMuteToggle() {
  const btn = document.getElementById('mute-btn');
  const preview = document.getElementById('preview');
  const iconOn = document.getElementById('mute-icon-on');
  const iconOff = document.getElementById('mute-icon-off');

  btn.addEventListener('click', () => {
    preview.muted = !preview.muted;
    iconOn.classList.toggle('hidden', preview.muted);
    iconOff.classList.toggle('hidden', !preview.muted);
  });
}

// --- Save data button ---

function readFormFields() {
  const sleeveData = getSleeveData();
  return {
    title: document.getElementById('clip-title')?.value || 'Untitled',
    year: document.getElementById('clip-year')?.value || '',
    description: document.getElementById('clip-description')?.value || '',
    tags: document.getElementById('clip-tags')?.value || '',
    tape: document.getElementById('clip-tape')?.value || '',
    cassetteNotes: document.getElementById('clip-notes')?.value || '',
    distributor: document.getElementById('clip-distributor')?.value || '',
    tapeLength: document.getElementById('clip-tape-length')?.value || '',
    recordingSpeed: document.getElementById('clip-speed')?.value || '',
    condition: document.getElementById('clip-condition')?.value || '',
    sleeveFront: sleeveData.front,
    sleeveBack: sleeveData.back,
  };
}

function wireSaveData() {
  const btn = document.getElementById('save-data-btn');

  btn.addEventListener('click', async () => {
    if (!lastClipId || !directoryHandle) return;

    // Update the clip in the catalog with all current form data
    const fields = readFormFields();
    updateClip(lastClipId, fields);

    // Get the updated clip from catalog (has the correct filename)
    const clips = getClips();
    const clip = clips.find(c => c.id === lastClipId);
    if (clip && clip.filename) {
      const basename = clip.filename.replace(/\.(webm|mp4)$/, '');

      // Save sidecar JSON + YouTube text (named to match the video file)
      await saveSidecarFiles(directoryHandle, basename, clip);

      // Re-save sleeve photos (named to match the video file)
      await saveSleevePhotos(directoryHandle, basename).catch(() => {});
    }

    // Flash confirmation
    const orig = btn.textContent;
    btn.textContent = 'Saved!';
    btn.classList.add('bg-red-500', 'text-black');
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove('bg-red-500', 'text-black');
    }, 1500);
  });
}

// --- Reset buttons ---

function wireResetButtons() {
  document.getElementById('reset-sleeve-btn').addEventListener('click', () => {
    resetSleeve();
    tryStartDetection();
  });

  document.getElementById('reset-info-btn').addEventListener('click', () => {
    document.getElementById('clip-title').value = '';
    document.getElementById('clip-description').value = '';
    document.getElementById('clip-year').value = '';
    document.getElementById('clip-tags').value = '';
    document.getElementById('clip-tape').value = '';
    document.getElementById('clip-distributor').value = '';
    document.getElementById('clip-tape-length').value = '';
    document.getElementById('clip-speed').value = '';
    document.getElementById('clip-condition').value = '';
    document.getElementById('clip-notes').value = '';
  });
}

// --- YouTube publish ---

function wireYouTubePublish() {
  const btn = document.getElementById('publish-yt-btn');
  const modal = document.getElementById('yt-publish-modal');
  const loading = document.getElementById('yt-pub-loading');
  const errorPanel = document.getElementById('yt-pub-error');
  const errorMsg = document.getElementById('yt-pub-error-msg');
  const aiNotice = document.getElementById('yt-pub-ai-notice');
  const retryBtn = document.getElementById('yt-pub-retry');
  const errorCloseBtn = document.getElementById('yt-pub-error-close');
  const dismissBtn = document.getElementById('yt-pub-dismiss');
  const form = document.getElementById('yt-pub-form');
  const done = document.getElementById('yt-pub-done');
  const titleInput = document.getElementById('yt-pub-title');
  const descInput = document.getElementById('yt-pub-desc');
  const tagsInput = document.getElementById('yt-pub-tags');
  const privacySelect = document.getElementById('yt-pub-privacy');
  const uploadBtn = document.getElementById('yt-pub-upload');
  const cancelBtn = document.getElementById('yt-pub-cancel');
  const closeBtn = document.getElementById('yt-pub-close');
  const progressDiv = document.getElementById('yt-pub-progress');
  const progressBar = document.getElementById('yt-pub-progress-bar');
  const statusEl = document.getElementById('yt-pub-status');
  const linkEl = document.getElementById('yt-pub-link');

  let currentToken = null;
  // Clip being published in this modal session. May differ from `lastClipId`
  // when the publish is triggered from the library card.
  let publishClipId = null;
  let loadingTimer = null;

  const BRAILLE = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

  function startLoadingAnim(label) {
    stopLoadingAnim();
    const t0 = Date.now();
    let i = 0;
    const tick = () => {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      loading.textContent = `${BRAILLE[i % BRAILLE.length]}  ${label}  ${elapsed}s`;
      i++;
    };
    tick();
    loadingTimer = setInterval(tick, 100);
  }

  function stopLoadingAnim() {
    if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
  }

  function closeModal() {
    stopLoadingAnim();
    modal.classList.add('hidden');
    loading.classList.add('hidden');
    errorPanel.classList.add('hidden');
    form.classList.add('hidden');
    done.classList.add('hidden');
    loading.textContent = 'Preparing AI copy...';
  }

  function showError(msg) {
    stopLoadingAnim();
    loading.classList.add('hidden');
    form.classList.add('hidden');
    done.classList.add('hidden');
    errorMsg.textContent = msg;
    errorPanel.classList.remove('hidden');
  }

  async function startPrepare(clipId = lastClipId) {
    if (!clipId) return;
    publishClipId = clipId;

    let password = sessionStorage.getItem('yt-publish-password');
    if (!password) {
      password = prompt('Publish password:');
      if (!password) return;
      sessionStorage.setItem('yt-publish-password', password);
    }

    modal.classList.remove('hidden');
    loading.classList.remove('hidden');
    errorPanel.classList.add('hidden');
    form.classList.add('hidden');
    done.classList.add('hidden');
    startLoadingAnim('Preparing AI copy');

    const clips = getClips();
    const storedClip = clips.find(c => c.id === publishClipId);
    if (!storedClip) { showError('Clip not found.'); return; }

    // For the active clip, merge live form values so edits after (or without)
    // "Save Data" still reach the AI prompt. For a library clip, use stored
    // metadata — the form reflects a different clip or nothing.
    const metadata = publishClipId === lastClipId
      ? { ...storedClip, ...readFormFields() }
      : storedClip;

    try {
      const res = await fetch('/api/youtube-publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'prepare', metadata, password }),
      });

      let data = {};
      try { data = await res.json(); } catch {}

      if (res.status === 401 || data.error === 'Wrong password') {
        sessionStorage.removeItem('yt-publish-password');
        showError('Wrong publish password. Click Retry to re-enter.');
        return;
      }

      if (res.status === 504) {
        showError('AI rewrite timed out on the server. Click Retry — it usually succeeds on a second attempt, and falls back to template copy after that.');
        return;
      }

      if (!res.ok || data.error) {
        showError(data.error || `Server error (${res.status})`);
        return;
      }

      currentToken = data.accessToken;
      titleInput.value = data.title;
      descInput.value = data.description;
      tagsInput.value = data.tags;

      aiNotice.classList.remove('hidden', 'text-yellow-400/80', 'text-white/40');
      if (data.aiFallback) {
        aiNotice.textContent = `⚠ AI rewrite failed — using template copy. (${data.model || '?'}, ${((data.elapsedMs || 0) / 1000).toFixed(1)}s)`;
        aiNotice.classList.add('text-yellow-400/80');
      } else if (data.elapsedMs) {
        aiNotice.textContent = `✓ ${data.model || 'AI'} · ${(data.elapsedMs / 1000).toFixed(1)}s`;
        aiNotice.classList.add('text-white/40');
      } else {
        aiNotice.classList.add('hidden');
      }

      stopLoadingAnim();
      loading.classList.add('hidden');
      form.classList.remove('hidden');
    } catch (e) {
      showError(e.message);
    }
  }

  btn.addEventListener('click', () => startPrepare());
  retryBtn.addEventListener('click', () => startPrepare(publishClipId));
  publishClip = startPrepare;
  errorCloseBtn.addEventListener('click', closeModal);
  dismissBtn.addEventListener('click', closeModal);
  // Modal only closes via the X button — no backdrop click or Escape, so
  // a stray click or drag-to-select inside the form can't wipe the AI copy.

  uploadBtn.addEventListener('click', async () => {
    if (!currentToken || !publishClipId || !directoryHandle) return;

    const clips = getClips();
    const clip = clips.find(c => c.id === publishClipId);
    if (!clip || !clip.filename) return;

    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Uploading...';
    progressDiv.classList.remove('hidden');

    try {
      // Read the video file from disk
      const fh = await directoryHandle.getFileHandle(clip.filename);
      const file = await fh.getFile();
      const contentType = clip.filename.endsWith('.webm') ? 'video/webm' : 'video/mp4';

      const tags = tagsInput.value.split(',').map(t => t.trim()).filter(Boolean);
      const uploadMeta = {
        snippet: {
          title: titleInput.value,
          description: descInput.value,
          tags,
          categoryId: '22',
        },
        status: {
          privacyStatus: privacySelect.value,
          selfDeclaredMadeForKids: false,
        },
      };

      // Init resumable upload
      statusEl.textContent = 'Initializing...';
      const initRes = await fetch(
        'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${currentToken}`,
            'Content-Type': 'application/json',
            'X-Upload-Content-Type': contentType,
            'X-Upload-Content-Length': String(file.size),
          },
          body: JSON.stringify(uploadMeta),
        }
      );

      if (!initRes.ok) {
        const err = await initRes.text();
        statusEl.textContent = 'Error: ' + err;
        uploadBtn.disabled = false;
        uploadBtn.textContent = 'Upload to YouTube';
        return;
      }

      const uploadUrl = initRes.headers.get('location');

      // Upload with XHR for progress
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('Content-Type', contentType);

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          progressBar.style.width = pct + '%';
          statusEl.textContent = pct + '% uploaded';
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const result = JSON.parse(xhr.responseText);
          const ytUrl = 'https://youtube.com/watch?v=' + result.id;

          // Save YouTube URL back to clip
          updateClip(publishClipId, { youtubeUrl: ytUrl, youtubeId: result.id });
          refreshLibrary();

          linkEl.href = ytUrl;
          linkEl.textContent = ytUrl;
          form.classList.add('hidden');
          done.classList.remove('hidden');
        } else {
          statusEl.textContent = 'Upload failed: ' + xhr.status;
          uploadBtn.disabled = false;
          uploadBtn.textContent = 'Upload to YouTube';
        }
      });

      xhr.addEventListener('error', () => {
        statusEl.textContent = 'Network error';
        uploadBtn.disabled = false;
        uploadBtn.textContent = 'Upload to YouTube';
      });

      statusEl.textContent = 'Uploading...';
      xhr.send(file);
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Upload to YouTube';
    }
  });

  cancelBtn.addEventListener('click', () => {
    modal.classList.add('hidden');
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload to YouTube';
    progressDiv.classList.add('hidden');
    progressBar.style.width = '0%';
  });

  closeBtn.addEventListener('click', () => {
    modal.classList.add('hidden');
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload to YouTube';
    progressDiv.classList.add('hidden');
    progressBar.style.width = '0%';
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

  let deleteConfirmPending = false;
  deleteBtn.addEventListener('click', async () => {
    if (!lastClipId) return;

    // Two-click confirm: first click shows "ARE YOU SURE?", second click deletes
    if (!deleteConfirmPending) {
      deleteConfirmPending = true;
      deleteBtn.textContent = 'ARE YOU SURE?';
      deleteBtn.classList.add('text-red-400');
      // Reset after 3 seconds if not confirmed
      setTimeout(() => {
        if (deleteConfirmPending) {
          deleteConfirmPending = false;
          deleteBtn.textContent = 'Delete';
          deleteBtn.classList.remove('text-red-400');
        }
      }, 3000);
      return;
    }

    deleteConfirmPending = false;

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

    // Clean up playback — but do NOT clear form fields
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
    deleteBtn.textContent = 'Delete';
    deleteBtn.classList.remove('text-red-400');
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
  preview.muted = true;
  playback.classList.remove('hidden');
  deleteBtn.classList.remove('hidden');
  document.getElementById('save-data-btn').classList.remove('hidden');
  document.getElementById('publish-yt-btn').classList.remove('hidden');

  // Update mute icon to reflect muted state
  document.getElementById('mute-icon-on').classList.add('hidden');
  document.getElementById('mute-icon-off').classList.remove('hidden');

  // Update legend
  const legend = document.getElementById('preview-legend');
  if (legend) legend.textContent = '░ Last Recording ░';

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
  document.getElementById('save-data-btn').classList.add('hidden');
  document.getElementById('publish-yt-btn').classList.add('hidden');

  // Update legend
  const legend = document.getElementById('preview-legend');
  if (legend) legend.textContent = '░ Live ░';

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
