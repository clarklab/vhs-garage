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

  // Wire the welcome modal first so the Help button works from the very start
  // and the first-visit gate below can use it.
  wireWelcomeModal();

  // Block on the welcome modal for first-time visitors so they see the intro
  // *before* the browser's camera/mic permission prompts kick in.
  if (!localStorage.getItem(WELCOME_SEEN_KEY)) {
    await new Promise(resolve => openWelcomeModal({ onDismiss: resolve }));
  }

  await startApp();

  // After the main app is wired, handle any OAuth redirect we just came back
  // from and reflect the signed-in state in the modal.
  ytUpdateAccountUI();
  ytHandleOAuthReturn();
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
  wirePlayerSidebarAutosave();
  wireThumbnailPicker();
  wireKeyboardShortcuts();
  wireBeforeUnload();
}

// --- Welcome / Quick Start modal ---
// Shown on first visit (blocking the main init until dismissed) and again
// whenever the Help button in the status bar is clicked. Five slides: three
// ASCII intros, a three-panel tour, and a device-setup form that lets the
// user pick video/audio/webcam/save folder up front so they don't have to
// fuss with the inline pickers once they're recording.

const WELCOME_SEEN_KEY = 'vhsg_welcome_seen';
let welcomeSlideIdx = 0;
let welcomeDismissResolver = null;
let welcomeSlide5Prepared = false;

// --- VHS static backdrop (canvas noise, runs only while the modal is open) ---
// Low-res buffer (chunky pixels read as analog noise rather than fine grain).
// putImageData with a Uint8ClampedArray is the fast path; fillStyle'ing each
// pixel with rgba() strings tanks framerate because of string parsing.
const STATIC_W = 320;
const STATIC_H = 180;
let staticCtx = null;
let staticImageData = null;
let staticRafId = null;

function ensureStaticCanvas() {
  if (staticCtx) return true;
  const canvas = document.getElementById('welcome-static');
  if (!canvas) return false;
  canvas.width = STATIC_W;
  canvas.height = STATIC_H;
  staticCtx = canvas.getContext('2d');
  staticImageData = staticCtx.createImageData(STATIC_W, STATIC_H);
  // Opaque alpha channel once, so the tick loop only has to touch the RGB bytes.
  const data = staticImageData.data;
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return true;
}

function tickStatic() {
  if (!staticCtx) return;
  const data = staticImageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
  staticCtx.putImageData(staticImageData, 0, 0);
  staticRafId = requestAnimationFrame(tickStatic);
}

function startWelcomeStatic() {
  if (staticRafId) return;
  if (!ensureStaticCanvas()) return;
  tickStatic();
}

function stopWelcomeStatic() {
  if (staticRafId) {
    cancelAnimationFrame(staticRafId);
    staticRafId = null;
  }
}

function openWelcomeModal({ onDismiss } = {}) {
  const modal = document.getElementById('welcome-modal');
  if (!modal) return;
  welcomeSlideIdx = 0;
  welcomeSlide5Prepared = false;
  welcomeDismissResolver = typeof onDismiss === 'function' ? onDismiss : null;
  renderWelcomeSlide();
  modal.classList.remove('hidden');
  startWelcomeStatic();
}

function dismissWelcomeModal() {
  localStorage.setItem(WELCOME_SEEN_KEY, '1');
  const modal = document.getElementById('welcome-modal');
  if (modal) modal.classList.add('hidden');
  stopWelcomeStatic();
  const cb = welcomeDismissResolver;
  welcomeDismissResolver = null;
  if (cb) cb();
}

function renderWelcomeSlide() {
  const slides = Array.from(document.querySelectorAll('.welcome-slide'));
  const dots = Array.from(document.querySelectorAll('.welcome-dot'));
  const backBtn = document.getElementById('welcome-back');
  const nextBtn = document.getElementById('welcome-next');
  const skipBtn = document.getElementById('welcome-skip');
  if (!slides.length) return;
  const last = slides.length - 1;

  slides.forEach((s, i) => s.classList.toggle('hidden', i !== welcomeSlideIdx));
  dots.forEach((d, i) => {
    d.classList.toggle('bg-white/70', i === welcomeSlideIdx);
    d.classList.toggle('bg-white/20', i !== welcomeSlideIdx);
  });
  if (backBtn) backBtn.classList.toggle('invisible', welcomeSlideIdx === 0);

  if (welcomeSlideIdx === last) {
    if (nextBtn) nextBtn.textContent = "Let's go ▶";
    if (skipBtn) skipBtn.classList.remove('hidden');
    // Reaching the device-setup slide for the first time: prompt for camera/mic
    // permission and populate the device dropdowns. Permissions requested here
    // cover the rest of the session.
    if (!welcomeSlide5Prepared) {
      welcomeSlide5Prepared = true;
      prepareWelcomeDeviceSlide();
    }
  } else {
    if (nextBtn) nextBtn.textContent = 'Next →';
    if (skipBtn) skipBtn.classList.add('hidden');
  }
}

async function prepareWelcomeDeviceSlide() {
  try {
    await requestPermissions();
    const { video, audio } = await enumerateDevices();
    populateSelect('welcome-video', video);
    populateSelect('welcome-audio', audio);
    populateSelect('welcome-webcam', video);
    const settings = loadSettings();
    if (settings.videoDeviceId) document.getElementById('welcome-video').value = settings.videoDeviceId;
    if (settings.audioDeviceId) document.getElementById('welcome-audio').value = settings.audioDeviceId;
    if (settings.webcamDeviceId) document.getElementById('welcome-webcam').value = settings.webcamDeviceId;
    if (directoryHandle) document.getElementById('welcome-dir-name').textContent = directoryHandle.name;
  } catch (e) {
    console.warn('[welcome] permission/enumerate failed:', e);
  }
}

// Apply the user's slide-5 selections. Always writes them to localStorage so
// startApp() picks them up on first visit. If the main app is already running
// (help button case), also switches the live streams in place — same work as
// the Device Settings modal's Apply button.
async function applyWelcomeDevices() {
  const videoSel = document.getElementById('welcome-video');
  const audioSel = document.getElementById('welcome-audio');
  const webcamSel = document.getElementById('welcome-webcam');
  if (!videoSel || !audioSel || !webcamSel) return;

  const videoId = videoSel.value;
  const audioId = audioSel.value;
  const webcamId = webcamSel.value;
  const videoLabel = videoSel.options[videoSel.selectedIndex]?.textContent || '';
  const audioLabel = audioSel.options[audioSel.selectedIndex]?.textContent || '';
  const webcamLabel = webcamSel.options[webcamSel.selectedIndex]?.textContent || '';

  saveSettings({
    ...loadSettings(),
    videoDeviceId: videoId,
    videoDeviceLabel: videoLabel,
    audioDeviceId: audioId,
    audioDeviceLabel: audioLabel,
    webcamDeviceId: webcamId,
    webcamDeviceLabel: webcamLabel,
  });

  const appAlreadyRunning = captureStream !== null;
  if (!appAlreadyRunning) return;

  if (videoId && audioId) {
    try {
      captureStream.getTracks().forEach(t => t.stop());
      captureStream = await openStream(videoId, audioId);
      document.getElementById('preview').srcObject = captureStream;
      document.getElementById('no-signal').classList.add('hidden');
      stopMeter();
      initMeter(captureStream);
      updateStatus('video', { deviceId: videoId, label: videoLabel });
      updateStatus('audio', { deviceId: audioId, label: audioLabel });
    } catch (e) {
      console.warn('[welcome] stream switch failed:', e);
    }
  }
  if (webcamId) {
    try {
      await initWebcam(webcamId);
      updateStatusWebcam({ deviceId: webcamId, label: webcamLabel });
    } catch (e) {
      console.warn('[welcome] webcam switch failed:', e);
    }
  }
}

function wireWelcomeModal() {
  const modal = document.getElementById('welcome-modal');
  if (!modal) return;

  const nextBtn = document.getElementById('welcome-next');
  const backBtn = document.getElementById('welcome-back');
  const skipBtn = document.getElementById('welcome-skip');
  const closeBtn = document.getElementById('welcome-close');
  const pickDirBtn = document.getElementById('welcome-pick-dir');
  const helpBtn = document.getElementById('help-btn');

  if (nextBtn) {
    nextBtn.addEventListener('click', async () => {
      const slides = document.querySelectorAll('.welcome-slide');
      const last = slides.length - 1;
      if (welcomeSlideIdx < last) {
        welcomeSlideIdx++;
        renderWelcomeSlide();
      } else {
        await applyWelcomeDevices();
        dismissWelcomeModal();
      }
    });
  }
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      if (welcomeSlideIdx > 0) {
        welcomeSlideIdx--;
        renderWelcomeSlide();
      }
    });
  }
  if (skipBtn) skipBtn.addEventListener('click', dismissWelcomeModal);
  if (closeBtn) closeBtn.addEventListener('click', dismissWelcomeModal);

  // Backdrop click dismisses
  modal.addEventListener('click', (e) => {
    if (e.target === modal) dismissWelcomeModal();
  });

  // Folder picker on slide 5
  if (pickDirBtn) {
    pickDirBtn.addEventListener('click', async () => {
      try {
        directoryHandle = await window.showDirectoryPicker();
        const name = directoryHandle.name;
        document.getElementById('welcome-dir-name').textContent = name;
        const settingDir = document.getElementById('setting-dir-name');
        if (settingDir) settingDir.textContent = name;
        const statusDir = document.getElementById('status-dir-label');
        if (statusDir) statusDir.textContent = name;
      } catch {}
    });
  }

  // Help button opens the welcome modal (resets to slide 1)
  if (helpBtn) {
    helpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const devicePopover = document.getElementById('device-popover');
      if (devicePopover) devicePopover.classList.add('hidden');
      openWelcomeModal();
    });
  }
}

// Global keyboard shortcuts. Space snaps a sleeve photo, R toggles recording.
// Both are ignored when the user is typing in a form field so they don't
// hijack "Press space to scroll" or typing spaces in titles/descriptions.
function wireKeyboardShortcuts() {
  const isEditable = (el) => {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  };
  const isModalOpen = () => {
    const ids = ['clip-player-modal', 'settings-popover', 'device-popover', 'welcome-modal'];
    return ids.some(id => {
      const el = document.getElementById(id);
      return el && !el.classList.contains('hidden');
    });
  };

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isEditable(e.target)) return;
    if (isModalOpen()) return;

    // Space: trigger sleeve snap, but only if the webcam is actually live
    // and we're still capturing (idle or front_captured, not done).
    if (e.code === 'Space') {
      const sleeveBtn = document.getElementById('sleeve-capture-btn');
      const captureView = document.getElementById('sleeve-capture-view');
      if (!sleeveBtn || !captureView || captureView.classList.contains('hidden')) return;
      e.preventDefault();
      sleeveBtn.click();
      return;
    }

    // R: toggle main recording (same button behavior as clicking REC)
    if (e.key === 'r' || e.key === 'R') {
      const recBtn = document.getElementById('rec-btn');
      if (!recBtn) return;
      e.preventDefault();
      recBtn.click();
      return;
    }
  });
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
      const liveTab = document.getElementById('tab-live');
      if (liveTab) liveTab.textContent = '░ Live Feed ░';
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
    const liveTab = document.getElementById('tab-live');
    if (liveTab) liveTab.textContent = '░ Recording ░';
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

        // If the user typed (or changed) the title during the recording, the
        // saved filename is still the title-less / pre-edit version. Rename
        // the file on disk now so the catalog filename matches what the user
        // sees as the title — fixes the long-running "Untitled" footgun.
        const settingsNow = loadSettings();
        const desiredFilename = regenerateFilenameWithTitle(
          currentFilename,
          currentTitle,
          settingsNow.nameFormat || 'title'
        );
        if (desiredFilename && desiredFilename !== currentFilename) {
          const renamed = await renameFileOnDisk(currentFilename, desiredFilename);
          if (renamed) currentFilename = renamed;
        }

        const basename = currentFilename.replace(/\.(webm|mp4)$/, '');
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

        // Create blob URL from the recorded file for playback. Pull the file
        // by name from the directory handle in case the file was just renamed
        // — the recorder's cached handle still points at the old name.
        try {
          const fh = currentFilename && directoryHandle
            ? await directoryHandle.getFileHandle(currentFilename).catch(() => getLastFileHandle())
            : getLastFileHandle();
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
  const trigger = document.getElementById('status-segments');
  const popover = document.getElementById('device-popover');
  const closeBtn = document.getElementById('device-popover-close');
  const applyBtn = document.getElementById('dp-apply');
  const pickDir = document.getElementById('dp-pick-dir');
  const settingsPopover = document.getElementById('settings-popover');
  const welcomeModal = document.getElementById('welcome-modal');

  trigger.addEventListener('click', async (e) => {
    e.stopPropagation();
    // Close other popovers if open
    if (settingsPopover) settingsPopover.classList.add('hidden');
    if (welcomeModal) welcomeModal.classList.add('hidden');

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

  // Click on the backdrop (popover element itself, not the card content) dismisses.
  popover.addEventListener('click', (e) => {
    if (e.target === popover) popover.classList.add('hidden');
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

  // Settings popover close on outside click. The gear glyph itself lives
  // inside the status bar and is handled by the trigger handler above.
  if (settingsPopover) {
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

  // Banner CTA: pick the local save folder from inside the Library so users
  // who land here without a folder selected can fix it without bouncing
  // through Device Settings.
  const pickDirBtn = document.getElementById('library-pick-dir');
  if (pickDirBtn) {
    pickDirBtn.addEventListener('click', async () => {
      try {
        directoryHandle = await window.showDirectoryPicker();
        const name = directoryHandle.name;
        const settingDir = document.getElementById('setting-dir-name');
        if (settingDir) settingDir.textContent = name;
        const statusDir = document.getElementById('status-dir-label');
        if (statusDir) statusDir.textContent = name;
        const dpDir = document.getElementById('dp-dir-name');
        if (dpDir) dpDir.textContent = name;
        refreshLibrary();
      } catch {}
    });
  }
}

function updateLibraryFolderBanner() {
  const banner = document.getElementById('library-folder-banner');
  if (!banner) return;
  banner.classList.toggle('hidden', !!directoryHandle);
}

function refreshLibrary() {
  updateLibraryFolderBanner();
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
let playerClipId = null;        // ID of the clip currently shown in the player modal
let playerAutoSaveTimer = null; // debounced live-save timer

// Convenience opener for places that have a clip ID but not a blob URL — e.g.
// the "▶ YouTube" button after recording, library card publish buttons, or any
// place we want to drop the user straight into the player workspace for a clip.
async function openPlayerForClip(clipId) {
  if (!clipId) return;
  const clips = getClips();
  const clip = clips.find(c => c.id === clipId);
  if (!clip) return;
  let url = '';
  if (directoryHandle && clip.filename) {
    try {
      const fh = await directoryHandle.getFileHandle(clip.filename);
      const file = await fh.getFile();
      url = URL.createObjectURL(file);
    } catch (e) {
      console.warn('[player] open-by-clip: could not load file:', e.message);
    }
  }
  openPlayerModal(url, clip);
}

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
  playerClipId = clip?.id || null;

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

  // Populate the editable sidebar from the clip. yt-pub-* IDs serve double-
  // duty as the publish form fields — the sidebar IS the publish form now.
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  setVal('yt-pub-title', clip?.title);
  setVal('yt-pub-desc', clip?.description);
  setVal('yt-pub-tags', clip?.tags);
  setVal('sb-year', clip?.year);
  setVal('sb-tape', clip?.tape);
  setVal('sb-distributor', clip?.distributor);
  setVal('sb-tape-length', clip?.tapeLength);
  setVal('sb-speed', clip?.recordingSpeed);
  setVal('sb-condition', clip?.condition);
  setVal('sb-notes', clip?.cassetteNotes);

  if (url) {
    video.src = url;
    video.playbackRate = 1;
    video.play().catch(() => {});
  } else {
    video.removeAttribute('src');
    video.load();
  }

  playBtn.textContent = 'Pause';
  setSpeedActive(btn1x, [btn1x, btn2x, btn4x]);

  modal.classList.remove('hidden');

  // Reset the thumbnail picker so it doesn't show the previous clip's frames.
  if (typeof resetThumbnailPicker === 'function') resetThumbnailPicker();

  // Hand the clip context to the publish wiring so the right state shows.
  if (typeof publishStateForClip_external === 'function') {
    publishStateForClip_external(clip?.id, clip);
  }

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

// Thumbnail picker for the player modal sidebar. Generates 6 random frames
// on demand, lets the user click to pick one, and Refresh pulls 6 more.
// Selection persists per-clip and doubles as the library tile thumbnail.
let resetThumbnailPicker = null;

function wireThumbnailPicker() {
  const pickBtn = document.getElementById('player-thumb-pick');
  const refreshBtn = document.getElementById('player-thumb-refresh');
  const emptyState = document.getElementById('player-thumb-empty');
  const loadingState = document.getElementById('player-thumb-loading');
  const gridWrap = document.getElementById('player-thumb-grid-wrap');
  const grid = document.getElementById('player-thumb-grid');
  if (!pickBtn || !grid) return;

  let currentThumbnails = [];

  function showState(state) {
    emptyState.classList.toggle('hidden', state !== 'empty');
    loadingState.classList.toggle('hidden', state !== 'loading');
    gridWrap.classList.toggle('hidden', state !== 'grid');
  }

  function renderGrid() {
    const clips = getClips();
    const clip = clips.find(c => c.id === playerClipId);
    const selected = clip && clip.ytThumbnailDataUrl;

    grid.innerHTML = '';
    currentThumbnails.forEach((dataUrl, i) => {
      const isSelected = dataUrl === selected;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'aspect-video bg-black border-2 transition-all overflow-hidden ' +
        (isSelected ? 'border-red-500 ring-2 ring-red-500/40' : 'border-white/15 hover:border-white/40');
      const img = document.createElement('img');
      img.src = dataUrl;
      img.className = 'w-full h-full object-cover';
      img.alt = 'Thumbnail option ' + (i + 1);
      cell.appendChild(img);
      cell.addEventListener('click', () => selectThumbnail(dataUrl));
      grid.appendChild(cell);
    });
  }

  async function selectThumbnail(dataUrl) {
    if (!playerClipId) return;
    // ytThumbnailDataUrl is what gets uploaded to YouTube; thumbnail is the
    // library tile preview. Reusing the same data URL for both keeps them
    // visually in sync (per the user's "library tile uses the same picked
    // thumbnail" requirement).
    updateClip(playerClipId, { ytThumbnailDataUrl: dataUrl, thumbnail: dataUrl });
    refreshLibrary();
    renderGrid();
  }

  async function generate() {
    if (!playerModalBlobUrl) {
      // No video loaded — likely the folder isn't picked. Bail quietly.
      console.warn('[thumb] No blob URL available; pick a save folder first.');
      return;
    }
    showState('loading');
    try {
      currentThumbnails = await extractThumbnailsFromBlob(playerModalBlobUrl, 6);
      renderGrid();
      showState('grid');
    } catch (e) {
      console.warn('[thumb] generation failed:', e.message);
      showState('empty');
    }
  }

  function reset() {
    currentThumbnails = [];
    grid.innerHTML = '';
    showState('empty');
  }
  resetThumbnailPicker = reset;

  pickBtn.addEventListener('click', generate);
  refreshBtn.addEventListener('click', generate);
}

// Wire live auto-save on the editable sidebar fields. Every keystroke schedules
// a debounced save: catalog update, sidecar JSON refresh, and a filename rename
// when the title change drives a new on-disk name. Editing one clip can't bleed
// into another because we capture the playerClipId at debounce-fire time.
function wirePlayerSidebarAutosave() {
  const fieldMap = {
    'yt-pub-title': 'title',
    'yt-pub-desc': 'description',
    'yt-pub-tags': 'tags',
    'sb-year': 'year',
    'sb-tape': 'tape',
    'sb-distributor': 'distributor',
    'sb-tape-length': 'tapeLength',
    'sb-speed': 'recordingSpeed',
    'sb-condition': 'condition',
    'sb-notes': 'cassetteNotes',
  };

  function flushAutoSave() {
    const id = playerClipId;
    if (!id) return;
    const updates = {};
    for (const [domId, key] of Object.entries(fieldMap)) {
      const el = document.getElementById(domId);
      if (el) updates[key] = el.value;
    }
    updateClip(id, updates);

    // If we have a save folder and the clip has a file, also rewrite the
    // sidecar JSON / .youtube.txt and (if the title implies a new filename)
    // rename the video on disk so it keeps tracking the catalog title.
    (async () => {
      if (!directoryHandle) return;
      let clips = getClips();
      let clip = clips.find(c => c.id === id);
      if (!clip || !clip.filename) return;

      const settings = loadSettings();
      const desired = regenerateFilenameWithTitle(
        clip.filename,
        clip.title,
        settings.nameFormat || 'title'
      );
      if (desired && desired !== clip.filename) {
        const oldBase = clip.filename.replace(/\.(webm|mp4)$/, '');
        const renamed = await renameFileOnDisk(clip.filename, desired);
        if (renamed) {
          updateClip(id, { filename: renamed });
          await renameSiblings(oldBase, renamed.replace(/\.(webm|mp4)$/, ''));
          clips = getClips();
          clip = clips.find(c => c.id === id);
          // Keep the player modal header in sync.
          const filenameEl = document.getElementById('player-modal-filename');
          if (filenameEl && id === playerClipId) filenameEl.textContent = clip.filename;
        }
      }
      const basename = clip.filename.replace(/\.(webm|mp4)$/, '');
      saveSidecarFiles(directoryHandle, basename, clip).catch(() => {});
    })();

    // Reflect title changes in the player-modal header right away (the rename
    // path above only fires when filename changes too; this updates on every
    // keystroke so the header doesn't lag the input).
    const titleEl = document.getElementById('yt-pub-title');
    const headerTitle = document.getElementById('player-modal-title');
    if (titleEl && headerTitle && id === playerClipId) {
      headerTitle.textContent = titleEl.value || 'Untitled';
    }

    // The library tile derived its label from the clip title — refresh it.
    refreshLibrary();
  }

  function scheduleAutoSave() {
    if (!playerClipId) return;
    if (playerAutoSaveTimer) clearTimeout(playerAutoSaveTimer);
    playerAutoSaveTimer = setTimeout(flushAutoSave, 500);
  }

  Object.keys(fieldMap).forEach(domId => {
    const el = document.getElementById(domId);
    if (!el) return;
    el.addEventListener('input', scheduleAutoSave);
    // On blur, force a save so we don't lose the last few characters when the
    // user closes the modal mid-debounce.
    el.addEventListener('blur', flushAutoSave);
  });
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
  video.removeAttribute('src');
  video.load();
  modal.classList.add('hidden');
  if (playerModalBlobUrl) {
    URL.revokeObjectURL(playerModalBlobUrl);
    playerModalBlobUrl = null;
  }
  playerClipId = null;
  if (playerAutoSaveTimer) { clearTimeout(playerAutoSaveTimer); playerAutoSaveTimer = null; }
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

// --- Thumbnail extraction + YouTube thumbnail upload ---

// Pull `count` random JPEG frames from a blob URL by spinning up an offscreen
// <video>, seeking, and drawing to a canvas. Random offsets (sorted ascending
// so the seek goes one direction) keep "Refresh" returning a fresh sample of
// the clip each time.
async function extractThumbnailsFromBlob(blobUrl, count = 6) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = blobUrl;

    v.addEventListener('loadedmetadata', async () => {
      const duration = v.duration;
      if (!duration || !isFinite(duration)) {
        reject(new Error('Could not read video duration'));
        return;
      }
      const offsets = Array.from({ length: count }, () =>
        0.05 * duration + Math.random() * 0.9 * duration
      ).sort((a, b) => a - b);

      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth || 1280;
      canvas.height = v.videoHeight || 720;
      const ctx = canvas.getContext('2d');

      const out = [];
      for (const t of offsets) {
        try {
          await new Promise((r, rej) => {
            const onSeek = () => { cleanup(); r(); };
            const onErr = () => { cleanup(); rej(new Error('seek error')); };
            const cleanup = () => {
              v.removeEventListener('seeked', onSeek);
              v.removeEventListener('error', onErr);
            };
            v.addEventListener('seeked', onSeek);
            v.addEventListener('error', onErr);
            v.currentTime = t;
          });
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          out.push(canvas.toDataURL('image/jpeg', 0.85));
        } catch (e) {
          console.warn('[thumb] frame at', t.toFixed(1), 's failed:', e.message);
        }
      }

      // Tear down the offscreen video so the blob URL can be GC'd.
      v.removeAttribute('src');
      v.load();
      resolve(out);
    });

    v.addEventListener('error', () => reject(new Error('Video failed to load for thumbnail extraction')));
  });
}

// POST a chosen frame to the YouTube thumbnails.set endpoint. Requires the
// channel to have custom-thumbnail privileges (post-verification); a 403
// from an unverified channel surfaces as an error the caller should treat
// as a soft failure (the video upload itself stays good).
async function uploadYouTubeThumbnail(videoId, accessToken, dataUrl) {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) throw new Error('Invalid data URL');
  const meta = dataUrl.slice(0, commaIdx);
  const b64 = dataUrl.slice(commaIdx + 1);
  const mimeType = (meta.match(/data:([^;]+)/) || [, 'image/jpeg'])[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const res = await fetch(
    `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': mimeType,
      },
      body: bytes,
    }
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(errText || `thumbnails.set failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// --- Filename / disk-rename helpers ---
//
// Rename the saved video on disk so the filename tracks the user's title.
// This addresses a long-standing footgun where a clip stayed labelled with
// its original (often title-less) timestamp filename even after the user
// added a real title in the editor or sidebar.

// Build a new filename that swaps the title portion but keeps the original
// date/time suffix from the source filename, so a recording stays anchored
// to when it was made even after a title edit. Returns null if the source
// filename doesn't match our naming convention.
function regenerateFilenameWithTitle(oldFilename, newTitle, nameFormat) {
  if (!oldFilename) return null;
  const m = oldFilename.match(/^(.+?)_(\d{4}-\d{2}-\d{2})_(\d{4})\.(webm|mp4)$/);
  if (!m) return null;
  const [, , date, time, ext] = m;
  const trimmed = (newTitle || '').trim();
  if (nameFormat === 'timestamp' || !trimmed) {
    return `VHS_Capture_${date}_${time}.${ext}`;
  }
  const sanitized = trimmed.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '_');
  return `${sanitized}_${date}_${time}.${ext}`;
}

// Rename a file in the user's save folder. Prefers the modern
// FileSystemFileHandle.move() and falls back to copy-then-delete. Returns
// the new filename on success, null on failure.
async function renameFileOnDisk(oldName, newName) {
  if (!directoryHandle || !oldName || !newName || oldName === newName) return null;
  try {
    const oldHandle = await directoryHandle.getFileHandle(oldName);
    if (typeof oldHandle.move === 'function') {
      await oldHandle.move(newName);
      return newName;
    }
    // Fallback: copy bytes to a new handle, then remove the original.
    const file = await oldHandle.getFile();
    const newHandle = await directoryHandle.getFileHandle(newName, { create: true });
    const writable = await newHandle.createWritable();
    await writable.write(file);
    await writable.close();
    await directoryHandle.removeEntry(oldName);
    return newName;
  } catch (e) {
    console.warn('[rename] failed:', e.message);
    return null;
  }
}

// Rename any matching sleeve / sidecar files alongside the video. Best-effort
// — silently no-ops when a sibling doesn't exist.
async function renameSiblings(oldBasename, newBasename) {
  if (!directoryHandle || oldBasename === newBasename) return;
  const siblings = [
    `${oldBasename}.json`,
    `${oldBasename}.youtube.txt`,
    `${oldBasename}_front.jpg`,
    `${oldBasename}_back.jpg`,
  ];
  const targets = [
    `${newBasename}.json`,
    `${newBasename}.youtube.txt`,
    `${newBasename}_front.jpg`,
    `${newBasename}_back.jpg`,
  ];
  for (let i = 0; i < siblings.length; i++) {
    await renameFileOnDisk(siblings[i], targets[i]).catch(() => {});
  }
}

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

    // If the title has changed since recording, rename the video on disk
    // and any sidecar files so the on-disk name keeps tracking the title.
    let clips = getClips();
    let clip = clips.find(c => c.id === lastClipId);
    if (clip && clip.filename) {
      const settingsNow = loadSettings();
      const desired = regenerateFilenameWithTitle(
        clip.filename,
        clip.title,
        settingsNow.nameFormat || 'title'
      );
      if (desired && desired !== clip.filename) {
        const oldBase = clip.filename.replace(/\.(webm|mp4)$/, '');
        const renamed = await renameFileOnDisk(clip.filename, desired);
        if (renamed) {
          updateClip(lastClipId, { filename: renamed });
          await renameSiblings(oldBase, renamed.replace(/\.(webm|mp4)$/, ''));
          // Re-read the catalog so subsequent saves use the new filename.
          clips = getClips();
          clip = clips.find(c => c.id === lastClipId);
        }
      }
    }

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

// --- YouTube OAuth (PKCE, browser-stored refresh token) ---

const YT_REFRESH_KEY = 'yt_refresh_token';
const YT_CHANNEL_KEY = 'yt_channel';
const YT_PKCE_KEY = 'yt_pkce_verifier';
const YT_PENDING_PUBLISH_KEY = 'yt_pending_publish_clip_id';
const YT_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
].join(' ');

function ytGetRefreshToken() {
  return localStorage.getItem(YT_REFRESH_KEY);
}

function ytGetChannel() {
  try { return JSON.parse(localStorage.getItem(YT_CHANNEL_KEY) || 'null'); }
  catch { return null; }
}

function ytStoreCredentials(refreshToken, channel) {
  localStorage.setItem(YT_REFRESH_KEY, refreshToken);
  if (channel) localStorage.setItem(YT_CHANNEL_KEY, JSON.stringify(channel));
}

function ytClearCredentials() {
  localStorage.removeItem(YT_REFRESH_KEY);
  localStorage.removeItem(YT_CHANNEL_KEY);
}

function ytRedirectUri() {
  return window.location.origin + '/capture';
}

function ytBase64UrlEncode(bytes) {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function ytGeneratePkcePair() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const verifier = ytBase64UrlEncode(raw);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = ytBase64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

async function ytStartSignIn() {
  const configRes = await fetch('/api/youtube-auth');
  const config = await configRes.json().catch(() => ({}));
  if (!config.clientId) {
    alert('YouTube sign-in is not configured on the server.');
    return;
  }

  const { verifier, challenge } = await ytGeneratePkcePair();
  sessionStorage.setItem(YT_PKCE_KEY, verifier);

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: ytRedirectUri(),
    response_type: 'code',
    scope: YT_SCOPES,
    access_type: 'offline',
    include_granted_scopes: 'true',
    // prompt=consent ensures we get a refresh_token every time, even on re-auth
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  window.location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

async function ytFetchChannelInfo(accessToken) {
  try {
    const res = await fetch('https://www.googleapis.com/youtube/v3/channels?mine=true&part=snippet', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    const ch = data.items?.[0];
    if (!ch) return null;
    return {
      id: ch.id,
      title: ch.snippet.title,
      handle: ch.snippet.customUrl || '',
      thumbnail: ch.snippet.thumbnails?.default?.url || '',
    };
  } catch { return null; }
}

async function ytHandleOAuthReturn() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (!code && !error) return;

  // Always strip the query string once we've noticed it, regardless of outcome.
  const cleanUrl = () => window.history.replaceState({}, '', window.location.pathname);

  if (error) {
    cleanUrl();
    alert('Sign-in cancelled or failed: ' + error);
    return;
  }

  const verifier = sessionStorage.getItem(YT_PKCE_KEY);
  sessionStorage.removeItem(YT_PKCE_KEY);
  if (!verifier) {
    cleanUrl();
    alert('Sign-in state lost. Please try again.');
    return;
  }

  try {
    const res = await fetch('/api/youtube-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'exchange',
        code,
        codeVerifier: verifier,
        redirectUri: ytRedirectUri(),
      }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.refreshToken) {
      cleanUrl();
      alert('Sign-in failed: ' + (data.error || 'unknown error'));
      return;
    }

    const channel = await ytFetchChannelInfo(data.accessToken);
    ytStoreCredentials(data.refreshToken, channel);
    cleanUrl();
    ytUpdateAccountUI();

    // If sign-in was triggered mid-publish, reopen the modal for that clip.
    const pendingClipId = sessionStorage.getItem(YT_PENDING_PUBLISH_KEY);
    sessionStorage.removeItem(YT_PENDING_PUBLISH_KEY);
    if (pendingClipId && typeof publishClip === 'function') {
      publishClip(pendingClipId);
    }
  } catch (e) {
    cleanUrl();
    alert('Sign-in failed: ' + e.message);
  }
}

async function ytSignOut() {
  const token = ytGetRefreshToken();
  ytClearCredentials();
  ytUpdateAccountUI();
  if (token) {
    fetch('/api/youtube-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'revoke', token }),
    }).catch(() => {});
  }
}

function ytUpdateAccountUI() {
  const channel = ytGetChannel();
  const accountEl = document.getElementById('yt-pub-account');
  const nameEl = document.getElementById('yt-pub-account-name');
  const avatarEl = document.getElementById('yt-pub-account-avatar');
  if (!accountEl) return;

  if (channel) {
    accountEl.classList.remove('hidden');
    if (nameEl) nameEl.textContent = channel.handle ? '@' + channel.handle.replace(/^@/, '') : (channel.title || 'your channel');
    if (avatarEl) avatarEl.src = channel.thumbnail || '';
  } else {
    accountEl.classList.add('hidden');
  }
}

// --- YouTube publish ---

function wireYouTubePublish() {
  const btn = document.getElementById('publish-yt-btn');
  const loading = document.getElementById('yt-pub-loading');
  const errorPanel = document.getElementById('yt-pub-error');
  const errorMsg = document.getElementById('yt-pub-error-msg');
  const retryBtn = document.getElementById('yt-pub-retry');
  const errorCloseBtn = document.getElementById('yt-pub-error-close');
  const signinPanel = document.getElementById('yt-pub-signin');
  const signinBtn = document.getElementById('yt-pub-signin-btn');
  const signoutBtn = document.getElementById('yt-pub-signout');
  const form = document.getElementById('yt-pub-form');
  const done = document.getElementById('yt-pub-done');
  const titleInput = document.getElementById('yt-pub-title');
  const descInput = document.getElementById('yt-pub-desc');
  const tagsInput = document.getElementById('yt-pub-tags');
  const privacySelect = document.getElementById('yt-pub-privacy');
  const uploadBtn = document.getElementById('yt-pub-upload');
  const progressDiv = document.getElementById('yt-pub-progress');
  const progressBar = document.getElementById('yt-pub-progress-bar');
  const statusEl = document.getElementById('yt-pub-status');
  const linkEl = document.getElementById('yt-pub-link');
  const thumbWarn = document.getElementById('yt-pub-thumb-warn');

  // On-demand AI sparkle buttons + suggestion preview panel
  const aiAllBtn = document.getElementById('yt-pub-ai-all');
  const aiTitleBtn = document.getElementById('yt-pub-ai-title');
  const aiDescBtn = document.getElementById('yt-pub-ai-desc');
  const suggestionPanel = document.getElementById('yt-pub-suggestion');
  const suggestionMeta = document.getElementById('yt-pub-suggestion-meta');
  const suggestionFallback = document.getElementById('yt-pub-suggestion-fallback');
  const suggestionTitleGroup = document.getElementById('yt-pub-suggestion-title-group');
  const suggestionTitle = document.getElementById('yt-pub-suggestion-title');
  const suggestionDescGroup = document.getElementById('yt-pub-suggestion-desc-group');
  const suggestionDesc = document.getElementById('yt-pub-suggestion-desc');
  const suggestionTagsGroup = document.getElementById('yt-pub-suggestion-tags-group');
  const suggestionTags = document.getElementById('yt-pub-suggestion-tags');
  const suggestionUseBtn = document.getElementById('yt-pub-suggestion-use');
  const suggestionRetryBtn = document.getElementById('yt-pub-suggestion-retry');
  const suggestionCancelBtn = document.getElementById('yt-pub-suggestion-cancel');

  let currentToken = null;
  // Clip being published in this modal session. May differ from `lastClipId`
  // when the publish is triggered from the library card.
  let publishClipId = null;
  let loadingTimer = null;
  // Last fetched suggestion + which fields were asked for (so "Use this" only
  // applies the visible fields, and "Try again" re-fetches the same scope).
  let currentSuggestion = null;
  let currentSuggestionScope = 'all'; // 'all' | 'title' | 'description'

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

  // Reset only the upload-state bits — never the editable metadata fields,
  // which are the user's authoritative copy of the clip and persist across
  // open/close of the player modal.
  function resetUploadUI() {
    currentToken = null;
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload to YouTube';
    progressDiv.classList.add('hidden');
    progressBar.style.width = '0%';
    statusEl.textContent = '';
    linkEl.href = '';
    linkEl.textContent = '';
    if (thumbWarn) {
      thumbWarn.classList.add('hidden');
      thumbWarn.textContent = '';
    }
    currentSuggestion = null;
  }

  function hideAllPanels() {
    loading.classList.add('hidden');
    errorPanel.classList.add('hidden');
    form.classList.add('hidden');
    done.classList.add('hidden');
    signinPanel.classList.add('hidden');
    suggestionPanel.classList.add('hidden');
  }

  function showForm() {
    stopLoadingAnim();
    hideAllPanels();
    form.classList.remove('hidden');
  }

  function showError(msg) {
    stopLoadingAnim();
    hideAllPanels();
    errorMsg.textContent = msg;
    errorPanel.classList.remove('hidden');
  }

  function showSignInPanel() {
    stopLoadingAnim();
    hideAllPanels();
    signinPanel.classList.remove('hidden');
  }

  // Called by openPlayerModal once the sidebar is showing a clip; re-syncs the
  // publish UI state machine (signin vs form vs done) for whichever clip just
  // loaded. The publish elements are now permanent residents of the sidebar
  // rather than elements that get unhidden on demand.
  function publishStateForClip(clipId, clip) {
    publishClipId = clipId;
    resetUploadUI();
    ytUpdateAccountUI();
    if (!ytGetRefreshToken()) {
      showSignInPanel();
      return;
    }
    // If the clip has already been published, jump straight to "Uploaded"
    // with the saved YouTube link instead of dropping the user back into the
    // pre-upload form (less confusing than offering "Upload" on a published
    // clip with no obvious indication it's already up).
    if (clip && clip.youtubeUrl) {
      hideAllPanels();
      linkEl.href = clip.youtubeUrl;
      linkEl.textContent = clip.youtubeUrl;
      done.classList.remove('hidden');
    } else {
      showForm();
    }
    fetchAccessTokenInBackground();
  }
  publishStateForClip_external = publishStateForClip;

  // Build the metadata payload sent to the AI rewrite endpoint. For the active
  // clip we merge in the live editor form so the AI sees the user's most
  // recent edits; for library clips we use the stored fields. Modal field
  // values override both so any tweaks the user made inside the modal flow
  // through to the next suggestion.
  function buildMetadata() {
    const clips = getClips();
    const storedClip = clips.find(c => c.id === publishClipId);
    if (!storedClip) return null;
    const base = publishClipId === lastClipId
      ? { ...storedClip, ...readFormFields() }
      : storedClip;
    return {
      ...base,
      title: titleInput.value || base.title,
      description: descInput.value || base.description,
      tags: tagsInput.value || base.tags,
    };
  }

  // Pre-warm the upload access token in the background so that 1) Upload
  // can start instantly without an extra round trip, and 2) a stale refresh
  // token surfaces immediately as a re-sign-in prompt instead of after the
  // user has spent time editing copy.
  async function fetchAccessTokenInBackground() {
    if (currentToken) return currentToken;
    try {
      const res = await fetch('/api/youtube-publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'token',
          refreshToken: ytGetRefreshToken(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        ytClearCredentials();
        ytUpdateAccountUI();
        showSignInPanel();
        return null;
      }
      if (!res.ok || !data.accessToken) {
        console.warn('[publish] token fetch failed:', data.error);
        return null;
      }
      currentToken = data.accessToken;
      return currentToken;
    } catch (e) {
      console.warn('[publish] token fetch threw:', e.message);
      return null;
    }
  }

  // Triggered by the "▶ YouTube" button after recording, library card publish
  // buttons, etc. Opens the player modal for the clip; the sidebar takes over
  // from there.
  async function startPublish(clipId = lastClipId) {
    if (!clipId) return;
    if (typeof openPlayerForClip === 'function') {
      await openPlayerForClip(clipId);
    } else {
      // Fallback if the player loader isn't wired yet — at least populate
      // the publish state for the clip.
      publishStateForClip(clipId);
    }
  }

  function showSuggestionPanel(scope, data) {
    currentSuggestion = data;
    currentSuggestionScope = scope;

    hideAllPanels();
    suggestionPanel.classList.remove('hidden');

    suggestionMeta.textContent = data.elapsedMs
      ? `${data.model || 'AI'} · ${(data.elapsedMs / 1000).toFixed(1)}s`
      : '';

    if (data.aiFallback) {
      suggestionFallback.textContent = '⚠ AI rewrite failed — showing template copy.';
      suggestionFallback.classList.remove('hidden');
    } else {
      suggestionFallback.classList.add('hidden');
    }

    const showTitle = scope === 'all' || scope === 'title';
    const showDesc = scope === 'all' || scope === 'description';
    const showTags = scope === 'all';

    suggestionTitleGroup.classList.toggle('hidden', !showTitle);
    suggestionDescGroup.classList.toggle('hidden', !showDesc);
    suggestionTagsGroup.classList.toggle('hidden', !showTags);

    suggestionTitle.textContent = data.title || '';
    suggestionDesc.textContent = data.description || '';
    suggestionTags.textContent = data.tags || '';
  }

  async function fetchSuggestion(scope) {
    const metadata = buildMetadata();
    if (!metadata) {
      showError('Clip not found.');
      return;
    }

    hideAllPanels();
    loading.classList.remove('hidden');
    startLoadingAnim('Generating');

    try {
      const res = await fetch('/api/youtube-publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'rewrite',
          metadata,
          refreshToken: ytGetRefreshToken(),
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 401) {
        ytClearCredentials();
        ytUpdateAccountUI();
        showSignInPanel();
        return;
      }
      if (res.status === 504) {
        showError('AI rewrite timed out. Click Retry — it usually succeeds on a second attempt, and falls back to template copy after that.');
        return;
      }
      if (!res.ok || data.error) {
        showError(data.error || `AI request failed (${res.status})`);
        return;
      }

      stopLoadingAnim();
      showSuggestionPanel(scope, data);
    } catch (e) {
      showError(e.message);
    }
  }

  function applySuggestion() {
    if (!currentSuggestion) return;
    const s = currentSuggestion;
    if (currentSuggestionScope === 'all' || currentSuggestionScope === 'title') {
      if (s.title) titleInput.value = s.title;
    }
    if (currentSuggestionScope === 'all' || currentSuggestionScope === 'description') {
      if (s.description) descInput.value = s.description;
    }
    if (currentSuggestionScope === 'all') {
      if (s.tags) tagsInput.value = s.tags;
    }
    currentSuggestion = null;
    showForm();
  }

  btn.addEventListener('click', () => startPublish());
  retryBtn.addEventListener('click', () => {
    // Retry returns to the form for the same clip — the upload XHR can be
    // restarted from there (or the user can edit + re-upload).
    showForm();
  });
  errorCloseBtn.addEventListener('click', () => showForm());
  publishClip = startPublish;

  // Sparkle buttons — main button rewrites everything; per-field sparkles
  // scope the suggestion panel to just that one field.
  if (aiAllBtn) aiAllBtn.addEventListener('click', () => fetchSuggestion('all'));
  if (aiTitleBtn) aiTitleBtn.addEventListener('click', () => fetchSuggestion('title'));
  if (aiDescBtn) aiDescBtn.addEventListener('click', () => fetchSuggestion('description'));

  // Suggestion panel: Use this writes the visible fields back into the form,
  // Try again re-fetches with the same scope, Cancel just discards.
  if (suggestionUseBtn) suggestionUseBtn.addEventListener('click', applySuggestion);
  if (suggestionRetryBtn) suggestionRetryBtn.addEventListener('click', () => fetchSuggestion(currentSuggestionScope));
  if (suggestionCancelBtn) suggestionCancelBtn.addEventListener('click', () => {
    currentSuggestion = null;
    showForm();
  });

  // Sign-in button inside the modal. Remember which clip was being published
  // so we can resume after the OAuth round-trip redirects us back to /capture.
  signinBtn.addEventListener('click', () => {
    if (publishClipId) {
      sessionStorage.setItem(YT_PENDING_PUBLISH_KEY, publishClipId);
    }
    ytStartSignIn();
  });

  signoutBtn.addEventListener('click', async () => {
    await ytSignOut();
    showSignInPanel();
  });

  uploadBtn.addEventListener('click', async () => {
    if (!publishClipId || !directoryHandle) return;

    const clips = getClips();
    const clip = clips.find(c => c.id === publishClipId);
    if (!clip || !clip.filename) return;

    // If the background token fetch hasn't returned yet (slow network) or
    // hasn't been kicked off, do it now before we attempt the upload.
    if (!currentToken) {
      uploadBtn.disabled = true;
      uploadBtn.textContent = 'Preparing...';
      const tok = await fetchAccessTokenInBackground();
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Upload to YouTube';
      if (!tok) return;
    }

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

      xhr.addEventListener('load', async () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const result = JSON.parse(xhr.responseText);
          const ytUrl = 'https://youtube.com/watch?v=' + result.id;

          // Save YouTube URL back to clip
          updateClip(publishClipId, { youtubeUrl: ytUrl, youtubeId: result.id });

          // If a custom thumbnail was picked, post it to thumbnails.set. A
          // 403 here means the channel hasn't been verified for custom
          // thumbnails — surface a soft warning but keep the video upload's
          // success state intact.
          const clipsAfter = getClips();
          const clipAfter = clipsAfter.find(c => c.id === publishClipId);
          const thumbDataUrl = clipAfter && clipAfter.ytThumbnailDataUrl;
          if (thumbDataUrl) {
            try {
              await uploadYouTubeThumbnail(result.id, currentToken, thumbDataUrl);
            } catch (e) {
              console.warn('[publish] thumbnail upload failed:', e.message);
              if (thumbWarn) {
                thumbWarn.classList.remove('hidden');
                thumbWarn.textContent = e.status === 403
                  ? '⚠ Custom thumbnail requires channel verification.'
                  : '⚠ Custom thumbnail upload failed.';
              }
            }
          }

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
}

// Module-level handle so openPlayerModal can re-init the publish UI when a
// clip is opened. Set by wireYouTubePublish.
let publishStateForClip_external = null;

// --- Before unload ---

function wireBeforeUnload() {
  window.addEventListener('beforeunload', (e) => {
    if (isRecording()) {
      e.preventDefault();
      e.returnValue = 'Recording in progress. Are you sure you want to leave?';
    }
  });
}

// --- Source toggle: Live vs. Last Recording ---

// Does a "Last Recording" currently exist? (set when recording ends)
let hasPlayback = false;
// Which pane is showing — both tabs reflect this.
let previewMode = 'live'; // 'live' | 'playback'

// Render the two source tabs to match the current state. Both tabs always
// exist in the DOM; the playback tab stays hidden until a recording lands.
function syncSourceTabs() {
  const liveTab = document.getElementById('tab-live');
  const playbackTab = document.getElementById('tab-playback');
  if (!liveTab || !playbackTab) return;

  playbackTab.classList.toggle('hidden', !hasPlayback);

  const activate = (el) => {
    el.classList.add('text-white/70');
    el.classList.remove('text-white/30', 'cursor-pointer');
  };
  const deactivate = (el) => {
    el.classList.add('text-white/30', 'cursor-pointer');
    el.classList.remove('text-white/70');
  };

  if (previewMode === 'live') {
    activate(liveTab);
    deactivate(playbackTab);
  } else {
    activate(playbackTab);
    deactivate(liveTab);
  }
}

function wirePlaybackTabs() {
  const liveTab = document.getElementById('tab-live');
  const playbackTab = document.getElementById('tab-playback');
  const deleteBtn = document.getElementById('delete-recording-btn');

  if (liveTab) {
    liveTab.addEventListener('click', () => {
      if (previewMode === 'live') return;
      showLiveTab();
    });
  }
  if (playbackTab) {
    playbackTab.addEventListener('click', () => {
      if (!hasPlayback || previewMode === 'playback') return;
      showPlaybackTab();
    });
  }

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

    hasPlayback = false;
    showLiveTab();
    deleteBtn.classList.add('hidden');
    deleteBtn.textContent = 'Delete';
    deleteBtn.classList.remove('text-red-400');
  });
}

function showPlaybackTab() {
  const preview = document.getElementById('preview');
  const playback = document.getElementById('playback');
  const deleteBtn = document.getElementById('delete-recording-btn');

  previewMode = 'playback';
  hasPlayback = true;

  preview.classList.add('hidden');
  preview.muted = true;
  playback.classList.remove('hidden');
  deleteBtn.classList.remove('hidden');
  document.getElementById('save-data-btn').classList.remove('hidden');
  document.getElementById('publish-yt-btn').classList.remove('hidden');

  // Update mute icon to reflect muted state
  document.getElementById('mute-icon-on').classList.add('hidden');
  document.getElementById('mute-icon-off').classList.remove('hidden');

  syncSourceTabs();

  // Switch meter to playback audio
  pauseMeter();
  try {
    initMeterFromElement(playback);
  } catch {}
}

function showLiveTab() {
  const preview = document.getElementById('preview');
  const playback = document.getElementById('playback');
  const deleteBtn = document.getElementById('delete-recording-btn');

  previewMode = 'live';

  playback.classList.add('hidden');
  preview.classList.remove('hidden');
  deleteBtn.classList.add('hidden');
  document.getElementById('save-data-btn').classList.add('hidden');
  document.getElementById('publish-yt-btn').classList.add('hidden');

  syncSourceTabs();

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
