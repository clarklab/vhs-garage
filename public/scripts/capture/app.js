import {
  isChrome, hasFileSystemAccess, loadSettings, saveSettings,
  requestPermissions, enumerateDevices, matchDevice, onDeviceChange, openStream
} from './devices.js';
import {
  startRecording, stopRecording, isRecording, formatTime, formatSize, generateFilename, getLastFileHandle
} from './recorder.js';
import {
  getClips, addClip, updateClip, deleteClip, createClipEntry, captureThumbnail, exportCatalog, renderLibrary, shrinkDataUrlForCatalog
} from './library.js';
import {
  initWebcam, stopWebcam, handleSleeveCapture, handleSleeveRetake, getSleeveData, getSleeveState,
  getVideoElement, getTargetRect, playShutter, resetSleeve, restoreSleeve, saveSleevePhotos
} from './sleeve.js';
import { startDetection, stopDetection, pauseDetection, resumeDetection } from './detector.js';
import { initMeter, initMeterFromElement, pauseMeter, stopMeter } from './meter.js';
import {
  saveDirectoryHandle, loadDirectoryHandle, clearDirectoryHandle,
  queryHandlePermission, tryRequestHandlePermission,
} from './handle-store.js';

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

  // Restore the previously-picked save folder. Chrome remembers permission
  // for "recently used" folders, so usually queryPermission returns
  // 'granted' without re-prompting. If the browser downgraded permission to
  // 'prompt' (long gap, cleared site data, etc.), we silently fall back —
  // the user picks again via the toolbar's DIR menu like before.
  try {
    const savedDir = await loadDirectoryHandle();
    if (savedDir) {
      const perm = await queryHandlePermission(savedDir, 'readwrite');
      if (perm === 'granted') {
        directoryHandle = savedDir;
        document.getElementById('status-dir-label').textContent = savedDir.name;
      } else if (perm === 'prompt') {
        // Try a silent re-grant — Chrome's heuristic decides if it shows a
        // prompt or grants without one. If a prompt would have shown, this
        // resolves to 'prompt' and we just leave the user-pick path.
        const granted = await tryRequestHandlePermission(savedDir, 'readwrite');
        if (granted === 'granted') {
          directoryHandle = savedDir;
          document.getElementById('status-dir-label').textContent = savedDir.name;
        }
      }
    }
  } catch (e) {
    console.warn('[startApp] could not restore save folder:', e.message);
  }

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
  wireToolbarMenus();
  wireLibrary();
  wirePlaybackTabs();
  wireMuteToggle();
  wireSaveData();
  wireResetButtons();
  wireYouTubePublish();
  wireMainEditorAutosave();
  wireThumbnailPicker();
  wireLibraryDrag();
  wireLibraryBatchUpload();
  wireCustomScrollbars();
  wireKeyboardShortcuts();
  wireBeforeUnload();
  // No clip loaded at first paint — keep the clip-dependent fieldsets hidden.
  updateClipDependentPanels();

  // If the user just clicked "Show me again" on the Demo Complete modal, the
  // exit-handler reloads with this session flag set and we kick the demo
  // back off here. Cleared either way so a manual refresh doesn't re-trigger.
  if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('vhsg_autostart_demo') === '1') {
    sessionStorage.removeItem('vhsg_autostart_demo');
    setTimeout(() => startDemoCountdown(), 400);
  }
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
        directoryHandle = await window.showDirectoryPicker(); saveDirectoryHandle(directoryHandle).catch(() => {});
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

// Read the per-clip {basename}.json sidecar from disk if present. Returns
// the parsed object or null. Used by loadClipIntoEditor as a defense-in-
// depth metadata source — the catalog (localStorage) is primary, but if
// quota errors caused stale entries the sidecar fills in.
async function readSidecarJson(dirHandle, basename) {
  if (!dirHandle || !basename) return null;
  try {
    const fh = await dirHandle.getFileHandle(basename + '.json');
    const file = await fh.getFile();
    const text = await file.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
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
  // Both elements are optional — #clip-info-loader was removed from the
  // markup at some point but the JS reference was left. Without the guard
  // the call throws "Cannot read properties of null (reading 'classList')"
  // and any downstream sleeve-AI work bails early. Keep aiFields dimming
  // since that element does still exist; loader-toggling becomes a no-op
  // when the element isn't present.
  const loader = document.getElementById('clip-info-loader');
  const aiFields = document.getElementById('ai-fields');

  loader?.classList.remove('hidden');
  aiFields?.classList.add('opacity-30', 'pointer-events-none');

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
  loader?.classList.add('hidden');
  aiFields?.classList.remove('opacity-30', 'pointer-events-none');
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
        directoryHandle = await window.showDirectoryPicker(); saveDirectoryHandle(directoryHandle).catch(() => {});
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
        try { directoryHandle = await window.showDirectoryPicker(); saveDirectoryHandle(directoryHandle).catch(() => {}); } catch { return; }
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

        // Sleeve photos are persisted to disk via saveSleevePhotos below and
        // re-read from disk on demand by readSleeveFromDisk — keeping the
        // full data URLs in the catalog blew the localStorage quota after a
        // few clips and broke the rest of this onStop handler.
        try {
          addClip(entry);
        } catch (e) {
          console.error('[capture] catalog save failed:', e);
        }
        lastClipId = entry.id;
        // Reveal Thumbnail + Publish fieldsets in column 3 for the new clip.
        updateClipDependentPanels();

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
            // Now that the blob is ready, fire the thumbnail picker
            // automatically so the user doesn't have to click anything.
            triggerThumbnailGenForActiveClip();
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
  const backdrop = document.getElementById('library-backdrop');
  const toLibrary = document.getElementById('to-library-btn');
  const toCapture = document.getElementById('to-capture-btn');

  function openLibrary() {
    libraryView.classList.remove('hidden');
    if (backdrop) backdrop.classList.remove('hidden');

    // Replay the "shoop" open animation on the inner chrome each time the
    // library is shown — remove the class, force a reflow, then re-add so
    // the keyframes restart instead of being skipped on the second open.
    const inner = libraryView.firstElementChild;
    if (inner) {
      inner.classList.remove('library-shoop-in');
      void inner.offsetWidth;
      inner.classList.add('library-shoop-in');
    }

    refreshLibrary();
  }
  function closeLibrary() {
    libraryView.classList.add('hidden');
    if (backdrop) backdrop.classList.add('hidden');
  }

  toLibrary.addEventListener('click', openLibrary);
  toCapture.addEventListener('click', closeLibrary);
  // Backdrop click dismisses (standard modal pattern).
  if (backdrop) backdrop.addEventListener('click', closeLibrary);
}

// --- Device popover (triggered by clicking status bar) ---

function wireDevicePopover() {
  // The old #status-segments single-trigger button was replaced with
  // per-segment dropdowns (see wireToolbarMenus). The modal it used to
  // open is still here and still useful — the dropdowns' last item,
  // "Open Device Settings…", routes to it via openDeviceSettingsModal().
  // So this function now only wires the modal's own controls (close,
  // apply, pickDir, backdrop) and the unrelated quality-settings popover.
  const popover = document.getElementById('device-popover');
  const closeBtn = document.getElementById('device-popover-close');
  const applyBtn = document.getElementById('dp-apply');
  const pickDir = document.getElementById('dp-pick-dir');
  const settingsPopover = document.getElementById('settings-popover');

  closeBtn.addEventListener('click', () => {
    popover.classList.add('hidden');
  });

  // Click on the backdrop (popover element itself, not the card content) dismisses.
  popover.addEventListener('click', (e) => {
    if (e.target === popover) popover.classList.add('hidden');
  });

  pickDir.addEventListener('click', async () => {
    try {
      directoryHandle = await window.showDirectoryPicker(); saveDirectoryHandle(directoryHandle).catch(() => {});
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

// --- Toolbar drop-down menus (System 7 / Win 3.1 style) ---
//
// Each top-bar segment (VID / AUD / CAM / DIR) is its own clickable trigger
// that opens a small drop-down anchored under the click point. Replaces the
// older "click anything in the bar to open a full modal" pattern — picking
// a device shouldn't take a modal. The full Device Settings modal is still
// available as the last item in each menu for the bigger view.
//
// The shared host element is #toolbar-menu (in capture.astro). One menu open
// at a time; clicks-outside / Escape / scroll dismiss. Item shape:
//   { label, checked?, disabled?, separator?, header?, onClick? }

let toolbarMenuOpenForTrigger = null;

function openToolbarMenu(triggerEl, items) {
  const menu = document.getElementById('toolbar-menu');
  if (!menu || !triggerEl) return;

  // Toggle: if this same trigger is already open, close it.
  if (toolbarMenuOpenForTrigger === triggerEl) {
    closeToolbarMenu();
    return;
  }
  closeToolbarMenu();

  // Build items.
  menu.innerHTML = '';
  items.forEach((it) => {
    if (it.separator) {
      const sep = document.createElement('div');
      sep.className = 'toolbar-menu-divider';
      menu.appendChild(sep);
      return;
    }
    if (it.header) {
      const h = document.createElement('div');
      h.className = 'toolbar-menu-header';
      h.textContent = it.label;
      menu.appendChild(h);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toolbar-menu-item';
    if (it.checked) btn.classList.add('is-checked');
    if (it.disabled) btn.classList.add('is-disabled');
    btn.textContent = it.label;
    if (!it.disabled && typeof it.onClick === 'function') {
      btn.addEventListener('click', () => {
        closeToolbarMenu();
        // Defer one frame so the menu is visually gone before any modal /
        // file picker spawned by the handler shows up — feels less abrupt.
        requestAnimationFrame(() => it.onClick());
      });
    }
    menu.appendChild(btn);
  });

  // Anchor under the trigger's bottom-left in viewport coords; clamp to the
  // viewport so triggers near the right edge don't push the menu off-screen.
  menu.classList.remove('hidden');
  const tRect = triggerEl.getBoundingClientRect();
  const W = window.innerWidth;
  const H = window.innerHeight;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const left = Math.min(tRect.left, W - w - 4);
  const top = Math.min(tRect.bottom, H - h - 4);
  menu.style.left = Math.max(4, left) + 'px';
  menu.style.top = Math.max(4, top) + 'px';

  triggerEl.classList.add('is-active');
  toolbarMenuOpenForTrigger = triggerEl;
}

function closeToolbarMenu() {
  const menu = document.getElementById('toolbar-menu');
  if (menu) menu.classList.add('hidden');
  if (toolbarMenuOpenForTrigger) {
    toolbarMenuOpenForTrigger.classList.remove('is-active');
    toolbarMenuOpenForTrigger = null;
  }
}

// Global dismissers wired once. Outside-click / Escape / scroll all close.
// We do NOT close on a click that originated inside a trigger button — the
// trigger's own click handler decides whether to toggle vs. swap.
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('toolbar-menu');
    if (!menu || menu.classList.contains('hidden')) return;
    if (menu.contains(e.target)) return;
    if (e.target.closest('.toolbar-trigger')) return;
    closeToolbarMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeToolbarMenu();
  });
  // Scroll-to-dismiss feels right on the main viewport but NOT inside the
  // open menu itself — capture-phase listener with a contains() check.
  document.addEventListener('scroll', (e) => {
    const menu = document.getElementById('toolbar-menu');
    if (!menu || menu.classList.contains('hidden')) return;
    if (menu.contains(e.target)) return;
    closeToolbarMenu();
  }, true);
}

// Connect handlers for the menu items — these mirror the modal's "apply"
// path so picking a device from the menu has the same effect as picking it
// from Device Settings + clicking Apply.

async function selectVideoDevice(videoId, videoLabel) {
  const settings = loadSettings();
  saveSettings({ ...settings, videoDeviceId: videoId, videoDeviceLabel: videoLabel });
  // Need an audio device too in order to open a stream — fall back to the
  // saved one (or default) if it's not set.
  const audioId = settings.audioDeviceId || '';
  try {
    if (captureStream) captureStream.getTracks().forEach(t => t.stop());
    captureStream = await openStream(videoId, audioId);
    document.getElementById('preview').srcObject = captureStream;
    document.getElementById('no-signal').classList.add('hidden');
    stopMeter();
    initMeter(captureStream);
    updateStatus('video', { label: videoLabel });
    if (settings.audioDeviceLabel) updateStatus('audio', { label: settings.audioDeviceLabel });
  } catch (err) {
    console.warn('Could not open video stream:', err);
  }
}

async function selectAudioDevice(audioId, audioLabel) {
  const settings = loadSettings();
  saveSettings({ ...settings, audioDeviceId: audioId, audioDeviceLabel: audioLabel });
  const videoId = settings.videoDeviceId || '';
  if (!videoId) {
    // Audio-only doesn't make sense for capture; just save the choice and
    // surface the new label in the status bar.
    updateStatus('audio', { label: audioLabel });
    return;
  }
  try {
    if (captureStream) captureStream.getTracks().forEach(t => t.stop());
    captureStream = await openStream(videoId, audioId);
    document.getElementById('preview').srcObject = captureStream;
    document.getElementById('no-signal').classList.add('hidden');
    stopMeter();
    initMeter(captureStream);
    updateStatus('audio', { label: audioLabel });
    if (settings.videoDeviceLabel) updateStatus('video', { label: settings.videoDeviceLabel });
  } catch (err) {
    console.warn('Could not open audio stream:', err);
  }
}

async function selectWebcamDevice(webcamId, webcamLabel) {
  const settings = loadSettings();
  saveSettings({ ...settings, webcamDeviceId: webcamId, webcamDeviceLabel: webcamLabel });
  try {
    await initWebcam(webcamId);
    updateStatusWebcam({ label: webcamLabel });
  } catch (err) {
    console.warn('Could not open webcam:', err);
  }
}

// "Unset" handlers — clear the saved device, stop the active stream, and
// reset the matching status segment to the empty state. Lets the user
// undo a device pick from the toolbar without going into Device Settings.

function unsetVideoDevice() {
  const settings = loadSettings();
  saveSettings({ ...settings, videoDeviceId: '', videoDeviceLabel: '' });
  // Capture stream carries video+audio together — stopping it kills both
  // tracks. We keep the audio device PICK intact (so the next video
  // selection re-uses it), but the live preview goes empty.
  try { if (captureStream) captureStream.getTracks().forEach(t => t.stop()); } catch {}
  captureStream = null;
  const preview = document.getElementById('preview');
  if (preview) {
    try { preview.pause(); } catch {}
    preview.srcObject = null;
  }
  document.getElementById('no-signal')?.classList.remove('hidden');
  stopMeter();
  updateStatus('video', null);
}

function unsetAudioDevice() {
  const settings = loadSettings();
  saveSettings({ ...settings, audioDeviceId: '', audioDeviceLabel: '' });
  // Same reasoning as above — stopping the capture stream is the clean
  // way to release the audio track. Preview goes blank since you can't
  // capture without audio either.
  try { if (captureStream) captureStream.getTracks().forEach(t => t.stop()); } catch {}
  captureStream = null;
  const preview = document.getElementById('preview');
  if (preview) {
    try { preview.pause(); } catch {}
    preview.srcObject = null;
  }
  document.getElementById('no-signal')?.classList.remove('hidden');
  stopMeter();
  updateStatus('audio', null);
}

function unsetWebcamDevice() {
  const settings = loadSettings();
  saveSettings({ ...settings, webcamDeviceId: '', webcamDeviceLabel: '' });
  try { stopWebcam(); } catch {}
  const sleeveWebcam = document.getElementById('sleeve-webcam');
  if (sleeveWebcam) {
    try { sleeveWebcam.pause(); } catch {}
    sleeveWebcam.srcObject = null;
  }
  document.getElementById('no-webcam')?.classList.remove('hidden');
  // Re-hide the rectangle-detector overlay group — it was revealed when
  // initWebcam ran, and shouldn't sit on top of the empty-state placeholder
  // once the webcam is released.
  document.getElementById('sleeve-target')?.classList.add('hidden');
  document.getElementById('detect-hud')?.classList.add('hidden');
  document.getElementById('detect-snap-bar')?.classList.add('hidden');
  updateStatusWebcam(null);
}

async function pickSaveFolder() {
  try {
    directoryHandle = await window.showDirectoryPicker(); saveDirectoryHandle(directoryHandle).catch(() => {});
    const name = directoryHandle.name;
    const dpDirName = document.getElementById('dp-dir-name');
    if (dpDirName) dpDirName.textContent = name;
    document.getElementById('status-dir-label').textContent = name;
  } catch {
    // User cancelled — no-op.
  }
}

function openDeviceSettingsModal() {
  // Re-uses the existing modal trigger by simulating the segments click,
  // but we have to do the work the trigger handler used to do (populate
  // selects from current devices) ourselves since the trigger no longer
  // exists. Easiest: surface the modal and let its existing handlers run.
  const popover = document.getElementById('device-popover');
  if (!popover) return;
  popover.classList.remove('hidden');
  // Populate fresh — same as the old wireDevicePopover trigger.
  enumerateDevices().then(({ video, audio }) => {
    const settings = loadSettings();
    const populate = (id, list) => {
      const sel = document.getElementById(id);
      if (!sel) return;
      sel.innerHTML = '';
      list.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Device ${d.deviceId.slice(0, 8)}`;
        sel.appendChild(opt);
      });
    };
    populate('dp-video', video);
    populate('dp-audio', audio);
    populate('dp-webcam', video);
    if (settings.videoDeviceId) document.getElementById('dp-video').value = settings.videoDeviceId;
    if (settings.audioDeviceId) document.getElementById('dp-audio').value = settings.audioDeviceId;
    if (settings.webcamDeviceId) document.getElementById('dp-webcam').value = settings.webcamDeviceId;
    if (directoryHandle) {
      const el = document.getElementById('dp-dir-name');
      if (el) el.textContent = directoryHandle.name;
    }
  }).catch(() => {});
}

function wireToolbarMenus() {
  const vidTrigger = document.getElementById('status-vid-trigger');
  const audTrigger = document.getElementById('status-aud-trigger');
  const camTrigger = document.getElementById('status-cam-trigger');
  const dirTrigger = document.getElementById('status-dir-trigger');
  const legalTrigger = document.getElementById('status-legal-trigger');
  const demoTrigger = document.getElementById('status-demo-trigger');

  // Helper: build a per-device menu. `kind` selects which saved-setting key
  // the checkmark / connect handler keys off of.
  const buildDeviceItems = async (kind) => {
    let video = [], audio = [];
    try {
      const out = await enumerateDevices();
      video = out.video || [];
      audio = out.audio || [];
    } catch {}
    const settings = loadSettings();
    const list = (kind === 'audio') ? audio : video;
    const currentId = (
      kind === 'video' ? settings.videoDeviceId :
      kind === 'audio' ? settings.audioDeviceId :
      settings.webcamDeviceId
    ) || '';

    const items = [];
    if (!list.length) {
      items.push({ label: 'No devices found', disabled: true });
    } else {
      list.forEach(d => {
        const label = d.label || `Device ${d.deviceId.slice(0, 8)}`;
        items.push({
          label,
          checked: d.deviceId === currentId,
          onClick: () => {
            if (kind === 'video') selectVideoDevice(d.deviceId, label);
            else if (kind === 'audio') selectAudioDevice(d.deviceId, label);
            else selectWebcamDevice(d.deviceId, label);
          },
        });
      });
    }
    // Unset — only useful when a device is currently picked. Disabled
    // (greyed) when nothing's selected so the row's still visible (consistent
    // menu shape across states) but not a confusing no-op.
    items.push({ separator: true });
    items.push({
      label: 'Unset',
      disabled: !currentId,
      onClick: () => {
        if (kind === 'video') unsetVideoDevice();
        else if (kind === 'audio') unsetAudioDevice();
        else unsetWebcamDevice();
      },
    });
    items.push({ separator: true });
    items.push({
      label: 'Open Device Settings…',
      onClick: () => openDeviceSettingsModal(),
    });
    return items;
  };

  if (vidTrigger) {
    vidTrigger.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Build items first; only swap to the new menu after they're ready so
      // we don't show an empty bevel for a frame.
      const items = await buildDeviceItems('video');
      openToolbarMenu(vidTrigger, items);
    });
  }
  if (audTrigger) {
    audTrigger.addEventListener('click', async (e) => {
      e.stopPropagation();
      const items = await buildDeviceItems('audio');
      openToolbarMenu(audTrigger, items);
    });
  }
  if (camTrigger) {
    camTrigger.addEventListener('click', async (e) => {
      e.stopPropagation();
      const items = await buildDeviceItems('webcam');
      openToolbarMenu(camTrigger, items);
    });
  }
  if (dirTrigger) {
    dirTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const items = [];
      if (directoryHandle) {
        items.push({ header: true, label: 'Current Folder' });
        items.push({ label: directoryHandle.name, disabled: true });
        items.push({ separator: true });
        items.push({ label: 'Choose Different Folder…', onClick: () => pickSaveFolder() });
      } else {
        items.push({ label: 'No folder selected', disabled: true });
        items.push({ separator: true });
        items.push({ label: 'Choose Save Folder…', onClick: () => pickSaveFolder() });
      }
      items.push({ separator: true });
      items.push({ label: 'Open Device Settings…', onClick: () => openDeviceSettingsModal() });
      openToolbarMenu(dirTrigger, items);
    });
  }
  if (legalTrigger) {
    legalTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      openToolbarMenu(legalTrigger, [
        { label: 'Terms of Use', onClick: () => window.open('https://vhsgarage.com/terms', '_blank', 'noopener') },
        { label: 'Privacy Policy', onClick: () => window.open('https://vhsgarage.com/privacy', '_blank', 'noopener') },
      ]);
    });
  }
  if (demoTrigger) {
    demoTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      openToolbarMenu(demoTrigger, [
        { label: 'Run Sample Footage', onClick: () => startDemoCountdown() },
      ]);
    });
  }
}

// --- Demo (puppeteered "player piano" capture session) ---
//
// All visual, no real backend touched: no MediaRecorder, no FileSystemAccess
// writes, no Gemini call, no YouTube upload. The sequence drives the existing
// DOM directly so it looks like the real product. Tape is "3 Ninjas" (1992).
// ESC at any point cancels and jumps to the Demo Complete modal.
//
// Sample assets live in /public/puppet/:
//   vhs-sample.mp4  — the "captured" footage (also used as playback)
//   box-front.jpg   — front sleeve
//   box-back.png    — back sleeve
//
// Sequence:
//   countdown (3-2-1) → "recording" 8s → stop/playback → front sleeve →
//   back sleeve → type title → AI sparkle (loading→suggestion→use this) →
//   thumbnails appear → pick #4 → fake upload progress → success state →
//   hold 6s → Demo Complete modal (Show me again / Exit)

let demoActive = false;
let demoTimers = [];

// AbortController-style sleep that resolves when the timer fires OR rejects
// when ESC cancels the demo. Every async step in the puppet sequence awaits
// this, so cancellation halts cleanly between beats.
function demoSleep(ms) {
  return new Promise((resolve, reject) => {
    if (!demoActive) { reject(new Error('demo cancelled')); return; }
    const t = setTimeout(() => {
      demoTimers = demoTimers.filter(x => x !== t);
      resolve();
    }, ms);
    demoTimers.push(t);
  });
}

function startDemoCountdown() {
  if (demoActive) return;
  demoActive = true;

  // Wire ESC once — removed in finishDemo / cancelDemo.
  document.addEventListener('keydown', demoEscHandler);

  // Dismiss anything else that might be visible: welcome modal, help, the
  // device popovers — we want a clean stage.
  ['welcome-modal', 'help-modal', 'device-popover', 'settings-popover'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  closeToolbarMenu();

  // Wipe everything that might be on screen so the demo starts from a true
  // blank canvas (rather than playing on top of the user's actual webcam,
  // existing form data, sleeves, etc.). Done DURING the countdown so the
  // viewer sees the page reset to empty just before the puppet starts.
  resetForDemo();

  const modal = document.getElementById('demo-countdown');
  const numEl = document.getElementById('demo-countdown-num');
  if (!modal || !numEl) { demoActive = false; return; }
  modal.classList.remove('hidden');

  let n = 3;
  numEl.textContent = String(n);
  const tick = () => {
    n -= 1;
    if (!demoActive) return;
    if (n > 0) {
      numEl.textContent = String(n);
      const t = setTimeout(tick, 1000);
      demoTimers.push(t);
    } else {
      modal.classList.add('hidden');
      runDemo().catch((e) => {
        if (e && e.message === 'demo cancelled') return;
        console.warn('[demo] aborted:', e);
      });
    }
  };
  const t = setTimeout(tick, 1000);
  demoTimers.push(t);
}

function demoEscHandler(e) {
  if (e.key !== 'Escape') return;
  if (!demoActive) return;
  cancelDemo();
}

function cancelDemo() {
  demoTimers.forEach(t => clearTimeout(t));
  demoTimers = [];
  demoActive = false;
  document.removeEventListener('keydown', demoEscHandler);
  document.getElementById('demo-countdown')?.classList.add('hidden');
  // Land on the Complete modal so the user has a clear way out (otherwise
  // they're stranded in whatever half-puppeteered state we were in).
  showDemoComplete();
}

// Wipe every panel / video / form back to its first-paint state so the
// puppet sequence starts from a true blank page. Called during the
// countdown so the viewer sees the reset happen, then the demo begins
// from zero. We DON'T touch toolbar / device pickers — those stay live
// so the menus still work mid-demo if someone goes hunting.
function resetForDemo() {
  // 1. Live preview: stop the active capture stream and clear the video
  // element so the live camera feed isn't visible behind the demo.
  try { if (captureStream) captureStream.getTracks().forEach(t => t.stop()); } catch {}
  captureStream = null;
  const preview = document.getElementById('preview');
  if (preview) {
    try { preview.pause(); } catch {}
    preview.srcObject = null;
    preview.removeAttribute('src');
    preview.load();
    preview.classList.remove('hidden');
  }
  // Show the no-signal placeholder briefly so col 1 reads as empty.
  document.getElementById('no-signal')?.classList.remove('hidden');

  // 2. Playback video: clear so no leftover playback bleeds through.
  const playback = document.getElementById('playback');
  if (playback) {
    try { playback.pause(); } catch {}
    playback.removeAttribute('src');
    playback.load();
    playback.classList.add('hidden');
  }

  // 3. Recording overlays / chrome.
  document.getElementById('preview-container')?.classList.remove('recording-active');
  const recOverlay = document.getElementById('rec-overlay-timer');
  if (recOverlay) {
    recOverlay.classList.add('hidden');
    recOverlay.textContent = '00:00:00';
  }
  document.getElementById('rec-btn')?.classList.remove('recording');
  const recTimer = document.getElementById('rec-timer');
  if (recTimer) recTimer.textContent = '00:00:00';
  const recSize = document.getElementById('rec-size');
  if (recSize) recSize.textContent = '0.0 MB';
  // Hide the Last Recording tab + Delete button (both gated on having a clip).
  const tabPlayback = document.getElementById('tab-playback');
  tabPlayback?.classList.add('hidden');
  tabPlayback?.classList.remove('text-white/70');
  tabPlayback?.classList.add('text-white/30');
  document.getElementById('tab-live')?.classList.remove('text-white/30');
  document.getElementById('tab-live')?.classList.add('text-white/70');
  document.getElementById('delete-recording-btn')?.classList.add('hidden');

  // 4. Sleeve column: stop the webcam stream, hide any captured previews,
  // restore the back skeleton + capture controls to their first-paint state.
  try { stopWebcam(); } catch {}
  const sleeveWebcam = document.getElementById('sleeve-webcam');
  if (sleeveWebcam) {
    try { sleeveWebcam.pause(); } catch {}
    sleeveWebcam.srcObject = null;
  }
  // Re-hide the detection overlay group so it doesn't sit on top of the
  // "No webcam" placeholder during the demo countdown.
  document.getElementById('sleeve-target')?.classList.add('hidden');
  document.getElementById('detect-hud')?.classList.add('hidden');
  document.getElementById('detect-snap-bar')?.classList.add('hidden');
  const sleeveFront = document.getElementById('sleeve-front-preview');
  if (sleeveFront) {
    sleeveFront.classList.add('hidden');
    sleeveFront.innerHTML = '<span class="flex items-center justify-center w-full h-full text-white/10 text-[10px]">--</span>';
  }
  const sleeveBack = document.getElementById('sleeve-back-preview');
  if (sleeveBack) {
    sleeveBack.classList.add('hidden');
    sleeveBack.innerHTML = '<span class="flex items-center justify-center w-full h-full text-white/10 text-[10px]">--</span>';
  }
  document.getElementById('sleeve-back-skeleton')?.classList.remove('hidden');
  document.getElementById('sleeve-capture-view')?.classList.remove('hidden');
  document.getElementById('sleeve-review-view')?.classList.add('hidden');

  // 5. Form fields: empty all of them so no prior text leaks into the demo.
  ['clip-title','clip-description','clip-year','clip-tags','clip-tape',
   'clip-distributor','clip-tape-length','clip-speed','clip-condition',
   'clip-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  // 6. Thumbnail panel: collapse to first-paint placeholder grid.
  document.getElementById('cap-thumb-fieldset')?.classList.add('hidden');
  document.getElementById('player-thumb-empty')?.classList.remove('hidden');
  document.getElementById('player-thumb-loading')?.classList.add('hidden');
  document.getElementById('player-thumb-grid-wrap')?.classList.add('hidden');
  const thumbGrid = document.getElementById('player-thumb-grid');
  if (thumbGrid) thumbGrid.innerHTML = '';

  // 7. Publish panel: collapse the entire fieldset and reset its inner
  // panels so the next reveal starts on the form (not on whatever state
  // the prior demo run left behind).
  document.getElementById('cap-pub-fieldset')?.classList.add('hidden');
  ['yt-pub-account','yt-pub-signin','yt-pub-form','yt-pub-loading',
   'yt-pub-suggestion','yt-pub-progress','yt-pub-done','yt-pub-error',
   'yt-pub-thumb-warn'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });
  const upBtn = document.getElementById('yt-pub-upload');
  if (upBtn) {
    upBtn.disabled = false;
    upBtn.textContent = 'Upload to YouTube';
  }
  const bar = document.getElementById('yt-pub-progress-bar');
  if (bar) bar.style.width = '0%';
}

function finishDemo() {
  demoActive = false;
  document.removeEventListener('keydown', demoEscHandler);
  showDemoComplete();
}

function showDemoComplete() {
  const m = document.getElementById('demo-complete');
  if (!m) return;
  m.classList.remove('hidden');
  const again = document.getElementById('demo-again-btn');
  const exit = document.getElementById('demo-exit-btn');
  if (again) again.onclick = () => {
    // Re-running mid-page is fragile (lots of state to undo). Reload with
    // a session flag and auto-start on the next boot — guarantees a clean
    // canvas without us hand-resetting every panel.
    sessionStorage.setItem('vhsg_autostart_demo', '1');
    window.location.reload();
  };
  if (exit) exit.onclick = () => {
    sessionStorage.removeItem('vhsg_autostart_demo');
    window.location.reload();
  };
}

// Type a string into an <input>/<textarea> char-by-char, dispatching the
// same input/change events real typing would, so any autosave / live UI
// listeners react. ~40ms per char with ±15ms jitter for a human cadence.
async function demoType(el, text) {
  if (!el) return;
  el.focus();
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  for (let i = 0; i < text.length; i++) {
    if (!demoActive) return;
    el.value += text[i];
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const jitter = Math.random() * 30 - 15;
    await demoSleep(40 + jitter);
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.blur();
}

// Brief white flash on an element — mimics the shutter/flash effect used
// when the real sleeve photo is taken.
async function demoFlash(el) {
  if (!el) return;
  const prevPos = el.style.position;
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  const flash = document.createElement('div');
  flash.style.cssText = 'position:absolute;inset:0;background:#fff;z-index:50;pointer-events:none;opacity:0.95;transition:opacity 0.4s;';
  el.appendChild(flash);
  await demoSleep(60);
  flash.style.opacity = '0';
  await demoSleep(400);
  flash.remove();
  el.style.position = prevPos;
}

// Stream text into an element. Handles <p>/<span> (textContent) AND
// <input>/<textarea> (value) — the suggestion preview targets are now
// real form fields so the user can edit them, but we still want the demo
// to type-stream into them for the LLM-streaming illusion.
//   'char' — one character every `delay` ms (good for short titles)
//   'word' — one word every `delay` ms (good for descriptions; faster apparent)
async function demoStreamText(el, text, mode = 'word', delay = 60) {
  if (!el) return;
  const isField = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
  const get = () => (isField ? el.value : el.textContent) || '';
  const set = (v) => { if (isField) el.value = v; else el.textContent = v; };
  set('');
  if (mode === 'char') {
    for (let i = 0; i < text.length; i++) {
      if (!demoActive) return;
      set(get() + text[i]);
      await demoSleep(delay);
    }
    return;
  }
  // Word mode — preserve newlines as paragraph breaks. Split on spaces but
  // keep newlines as their own tokens so the text reflows correctly.
  const tokens = text.split(/(\s+)/);
  for (let i = 0; i < tokens.length; i++) {
    if (!demoActive) return;
    set(get() + tokens[i]);
    // Don't sleep on whitespace tokens — only on content tokens, otherwise
    // the cadence drags.
    if (tokens[i].trim()) await demoSleep(delay);
  }
}

// Quick VHS-style static blast over a container — drawn as canvas noise so
// it actually looks like analog interference rather than a tinted overlay.
// Fire-and-forget by default (no await) so it doesn't delay the timeline
// it's blasted into; the canvas removes itself when the duration elapses or
// when the demo gets cancelled.
function demoStaticBlast(container, ms = 300) {
  if (!container) return;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:25;pointer-events:none;mix-blend-mode:screen;';
  canvas.width = 320;
  canvas.height = 240;
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const start = performance.now();
  let raf = 0;
  const draw = () => {
    if (!demoActive || performance.now() - start > ms) {
      cancelAnimationFrame(raf);
      canvas.remove();
      return;
    }
    const img = ctx.createImageData(canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.random() < 0.5 ? Math.random() * 80 : Math.random() * 255;
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    raf = requestAnimationFrame(draw);
  };
  draw();
}

async function runDemo() {
  // ~12s end-to-end, packed with overlapping action. Every await goes
  // through demoSleep so ESC cancels cleanly between beats. Goal isn't
  // realism — it's "lots happening at once" for social capture.
  //
  // Timeline (approximate, all clocks measured from REC start):
  //   0.0  REC starts; preview plays + recording-active border + REC blinks
  //   0.4  Front sleeve flash → photo
  //   1.1  Back sleeve flash → photo
  //   1.7  Thumbnail + Publish + signed-in panels reveal
  //   2.0  Type "3 Ninjas" into title (~0.25s)
  //   2.4  Click AI → loading panel with .ai-loader scanning bars
  //   3.0  Static blast + 6s playhead jump
  //   3.2  Suggestion panel; stream title char-by-char (~1s)
  //   4.2  Stream description word-by-word (~1.5s)
  //   5.7  Tags appear; "Use this" populates all clip fields
  //   5.9  Thumbnails populate progressively (one cell every ~250ms)
  //   6.0  Static blast + jump
  //   7.5  Pick the 4th thumbnail (red outline + check)
  //   8.0  REC stops → switch to playback tab
  //   8.4  Click Upload → progress 0→100% over ~1.5s
  //   9.9  Success row appears
  //  ~12   Demo Complete modal

  // STAGE
  document.getElementById('status-dir-label').textContent = 'Sample Tapes';
  document.getElementById('no-signal')?.classList.add('hidden');

  const preview = document.getElementById('preview');
  const playback = document.getElementById('playback');
  const previewContainer = document.getElementById('preview-container');
  const recOverlay = document.getElementById('rec-overlay-timer');
  const recBtn = document.getElementById('rec-btn');
  const recTimer = document.getElementById('rec-timer');
  const recSize = document.getElementById('rec-size');

  // Preload the playback element early so thumbnail seeks later are instant
  // — by the time we need to grab frames (~6s in) it's been buffered for
  // plenty of time. Hidden, muted, looping in the background.
  if (playback) {
    playback.src = '/puppet/vhs-sample.mp4';
    playback.muted = true;
    playback.loop = true;
    playback.play().catch(() => {});
  }

  // Live preview shows the sample mid-recording.
  if (preview) {
    preview.srcObject = null;
    preview.src = '/puppet/vhs-sample.mp4';
    preview.muted = true;
    preview.loop = true;
    try { await preview.play(); } catch {}
  }
  previewContainer?.classList.add('recording-active');
  recOverlay?.classList.remove('hidden');
  recBtn?.classList.add('recording');

  const REC_SECONDS = 8;
  const sleeveCaptureView = document.getElementById('sleeve-capture-view');
  const webcamContainer = document.getElementById('webcam-container');
  const sleeveFront = document.getElementById('sleeve-front-preview');
  const sleeveBackSkeleton = document.getElementById('sleeve-back-skeleton');
  const sleeveBackPreview = document.getElementById('sleeve-back-preview');
  const sugTitle = document.getElementById('yt-pub-suggestion-title');
  const sugDesc = document.getElementById('yt-pub-suggestion-desc');
  const sugTags = document.getElementById('yt-pub-suggestion-tags');
  const loadingEl = document.getElementById('yt-pub-loading');
  const thumbEmpty = document.getElementById('player-thumb-empty');
  const thumbWrap = document.getElementById('player-thumb-grid-wrap');
  const thumbGrid = document.getElementById('player-thumb-grid');

  const TITLE = '3 Ninjas (1992) — Original VHS Capture';
  const DESC =
    "Original 1992 VHS release of 3 Ninjas, the family martial-arts comedy starring Victor Wong as Grandpa Mori and Michael Treanor, Max Elliott Slade, and Chad Power as Rocky, Colt, and Tum-Tum.\n\nCaptured from a well-loved tape — minor tracking artifacts and the warm color cast that only a 30+ year old VHS gives you.\n\nCaptured with VHS Garage\nhttps://vhsgarage.com";
  const TAGS = '3 ninjas, 1992, family movie, martial arts, vhs, kids movie, 90s, victor wong';

  // RECORDING TASK — timer ticks 00:00:00 → 00:00:08; static blasts at
  // t=3 and t=6 (every 3s of the 8s window). Static is fire-and-forget so
  // the 1s timer cadence isn't shifted.
  const recordingTask = (async () => {
    for (let s = 0; s <= REC_SECONDS; s++) {
      if (!demoActive) return;
      const ss = String(s % 60).padStart(2, '0');
      const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const hh = String(Math.floor(s / 3600)).padStart(2, '0');
      const t = `${hh}:${mm}:${ss}`;
      if (recTimer) recTimer.textContent = t;
      if (recOverlay) recOverlay.textContent = t;
      if (recSize) recSize.textContent = (s * 4.4).toFixed(1) + ' MB';
      if (s > 0 && s < REC_SECONDS && s % 3 === 0) {
        demoStaticBlast(previewContainer, 300);
        if (preview && preview.duration && isFinite(preview.duration)) {
          preview.currentTime = (preview.currentTime + 6) % preview.duration;
        }
      }
      await demoSleep(1000);
    }
  })();

  // ACTIONS TASK — every UI beat in the right column packed into the same
  // ~8s window. Heavy use of fire-and-forget (demoFlash, demoStaticBlast)
  // so beats overlap rather than gating each other.
  const actionsTask = (async () => {
    // t=0.4s — front sleeve
    await demoSleep(400);
    if (!demoActive) return;
    demoFlash(webcamContainer);
    await demoSleep(150);
    if (sleeveFront) {
      sleeveFront.innerHTML = '<img src="/puppet/box-front.jpg" class="w-full h-full object-cover" alt="">';
      sleeveFront.classList.remove('hidden');
    }

    // t=1.1s — back sleeve
    await demoSleep(550);
    if (!demoActive) return;
    demoFlash(sleeveBackSkeleton || webcamContainer);
    await demoSleep(150);
    if (sleeveBackSkeleton) sleeveBackSkeleton.classList.add('hidden');
    if (sleeveBackPreview) {
      sleeveBackPreview.innerHTML = '<img src="/puppet/box-back.png" class="w-full h-full object-cover" alt="">';
      sleeveBackPreview.classList.remove('hidden');
    }
    if (sleeveCaptureView) sleeveCaptureView.classList.add('hidden');

    // t=1.7s — reveal panels + signed-in banner
    await demoSleep(450);
    if (!demoActive) return;
    document.getElementById('cap-thumb-fieldset')?.classList.remove('hidden');
    document.getElementById('cap-pub-fieldset')?.classList.remove('hidden');
    document.getElementById('yt-pub-form')?.classList.remove('hidden');
    document.getElementById('yt-pub-signin')?.classList.add('hidden');
    const acct = document.getElementById('yt-pub-account');
    const acctName = document.getElementById('yt-pub-account-name');
    if (acct && acctName) {
      acctName.textContent = '@vhsgaragevideo';
      acct.classList.remove('hidden');
    }

    // t=2.0s — type title
    await demoSleep(300);
    if (!demoActive) return;
    await demoType(document.getElementById('clip-title'), '3 Ninjas');

    // t=2.4s — click AI; loading panel with the scanning ai-loader bars.
    // Adding the .ai-loader class wires up the existing CSS that animates
    // a ░░▒▓█ scanline as a ::after pseudo-element on the loader text.
    await demoSleep(150);
    if (!demoActive) return;
    document.getElementById('yt-pub-form')?.classList.add('hidden');
    if (loadingEl) {
      loadingEl.textContent = 'Generating AI copy ';
      loadingEl.classList.add('ai-loader');
      loadingEl.classList.remove('hidden');
    }

    // t=3.2s — hide loading; show suggestion panel; STREAM title and desc
    // in like an LLM response. Title is char-by-char (short, snappy);
    // description is word-by-word (longer text reads better that way).
    await demoSleep(800);
    if (!demoActive) return;
    if (loadingEl) {
      loadingEl.classList.add('hidden');
      loadingEl.classList.remove('ai-loader');
    }
    document.getElementById('yt-pub-suggestion-title-group')?.classList.remove('hidden');
    document.getElementById('yt-pub-suggestion-desc-group')?.classList.remove('hidden');
    document.getElementById('yt-pub-suggestion-tags-group')?.classList.remove('hidden');
    document.getElementById('yt-pub-suggestion')?.classList.remove('hidden');
    document.getElementById('yt-pub-suggestion-meta').textContent = 'Generated from your sleeve photos and clip metadata.';
    if (sugTitle) await demoStreamText(sugTitle, TITLE, 'char', 22);
    if (sugDesc) await demoStreamText(sugDesc, DESC, 'word', 32);
    // sugTags is an <input> now, not a <p> — write to .value, not textContent.
    if (sugTags) sugTags.value = TAGS;

    // t≈5.7s — "Use this" populates fields (instant), suggestion hides
    await demoSleep(300);
    if (!demoActive) return;
    document.getElementById('clip-title').value = TITLE;
    document.getElementById('clip-description').value = DESC;
    document.getElementById('clip-tags').value = TAGS;
    document.getElementById('clip-year').value = '1992';
    document.getElementById('clip-tape').value = '3 Ninjas';
    document.getElementById('clip-distributor').value = 'Touchstone Pictures';
    document.getElementById('clip-tape-length').value = 'T-120';
    document.getElementById('clip-speed').value = 'SP';
    document.getElementById('clip-condition').value = 'Good';
    document.getElementById('yt-pub-suggestion')?.classList.add('hidden');
    document.getElementById('yt-pub-form')?.classList.remove('hidden');

    // t≈5.9s — thumbnails populate ONE AT A TIME (~250ms apart) so the
    // viewer sees them appear progressively rather than dumping all six
    // at once. We grab from the preloaded playback element so seeks are
    // fast (it's been buffering since demo start).
    if (thumbGrid && playback) {
      thumbGrid.innerHTML = '';
      thumbEmpty?.classList.add('hidden');
      thumbWrap?.classList.remove('hidden');
      const dur = playback.duration && isFinite(playback.duration) ? playback.duration : 0;
      for (let i = 0; i < 6; i++) {
        if (!demoActive) return;
        const cell = document.createElement('div');
        cell.className = 'aspect-video bg-black border border-white/10 cursor-pointer overflow-hidden relative';
        try {
          if (dur > 0) {
            const t = (dur / 7) * (i + 1);
            const c = document.createElement('canvas');
            c.width = playback.videoWidth || 320;
            c.height = playback.videoHeight || 180;
            const cx = c.getContext('2d');
            playback.pause();
            playback.currentTime = t;
            await new Promise(r => playback.addEventListener('seeked', r, { once: true }));
            cx.drawImage(playback, 0, 0, c.width, c.height);
            const img = document.createElement('img');
            img.src = c.toDataURL('image/jpeg', 0.7);
            img.className = 'w-full h-full object-cover';
            cell.appendChild(img);
          }
        } catch {}
        thumbGrid.appendChild(cell);
        // Small explicit beat between cells so the appearance reads as
        // "popping in one by one" even if the seek itself was instant.
        await demoSleep(180);
      }
      try { await playback.play(); } catch {}
    }

    // Pick #4 — red outline + check overlay (mirrors the real picker UI).
    if (!demoActive) return;
    if (thumbGrid && thumbGrid.children[3]) {
      const pick = thumbGrid.children[3];
      pick.style.outline = '2px solid #dc2626';
      pick.style.outlineOffset = '-2px';
      const check = document.createElement('div');
      check.style.cssText = 'position:absolute;top:4px;right:4px;width:14px;height:14px;background:#dc2626;color:#fff;font-size:10px;display:flex;align-items:center;justify-content:center;font-weight:bold;';
      check.textContent = '✓';
      pick.appendChild(check);
    }
  })();

  await Promise.all([recordingTask, actionsTask]);
  if (!demoActive) return;

  // Stop recording — switch to the playback tab. Playback was already
  // loaded + playing in the background since demo start, so swapping
  // visibility is the only thing left to do here.
  previewContainer?.classList.remove('recording-active');
  recOverlay?.classList.add('hidden');
  recBtn?.classList.remove('recording');
  if (preview) { try { preview.pause(); } catch {} }
  preview?.classList.add('hidden');
  playback?.classList.remove('hidden');
  try { await playback?.play(); } catch {}
  const tabPlayback = document.getElementById('tab-playback');
  const tabLive = document.getElementById('tab-live');
  tabPlayback?.classList.remove('hidden');
  tabPlayback?.classList.remove('text-white/30');
  tabPlayback?.classList.add('text-white/70');
  tabLive?.classList.remove('text-white/70');
  tabLive?.classList.add('text-white/30');
  document.getElementById('delete-recording-btn')?.classList.remove('hidden');

  // Brief beat then upload — fast (~1.5s) so we don't drag the demo out.
  await demoSleep(400);
  if (!demoActive) return;

  document.getElementById('yt-pub-progress')?.classList.remove('hidden');
  const bar = document.getElementById('yt-pub-progress-bar');
  const status = document.getElementById('yt-pub-status');
  const upBtn = document.getElementById('yt-pub-upload');
  if (upBtn) {
    upBtn.disabled = true;
    upBtn.textContent = 'Uploading...';
  }
  for (let p = 0; p <= 100; p += 10) {
    if (!demoActive) return;
    if (bar) bar.style.width = p + '%';
    if (status) status.textContent = p + '% uploaded';
    await demoSleep(140);
  }
  document.getElementById('yt-pub-progress')?.classList.add('hidden');
  document.getElementById('yt-pub-form')?.classList.add('hidden');
  const link = document.getElementById('yt-pub-link');
  if (link) {
    link.href = 'https://youtube.com/@vhsgaragevideo';
    link.title = 'https://youtube.com/@vhsgaragevideo';
  }
  document.getElementById('yt-pub-done')?.classList.remove('hidden');

  // Brief hold on the success row (~2s) so the viewer registers the
  // "uploaded" state, then surface the Demo Complete modal.
  await demoSleep(2000);
  finishDemo();
}

// --- Library ---

function wireLibrary() {
  document.getElementById('export-catalog-btn').addEventListener('click', async () => {
    if (!directoryHandle) {
      try {
        directoryHandle = await window.showDirectoryPicker(); saveDirectoryHandle(directoryHandle).catch(() => {});
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
        directoryHandle = await window.showDirectoryPicker(); saveDirectoryHandle(directoryHandle).catch(() => {});
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
  const grid = document.getElementById('library-grid');
  const empty = document.getElementById('library-empty');
  if (!banner) return;
  if (directoryHandle) {
    banner.classList.add('hidden');
    if (grid) grid.classList.remove('hidden');
    // The empty state's own visibility is owned by renderLibrary.
  } else {
    banner.classList.remove('hidden');
    // No file grid until they pick a folder — drives home that we don't
    // know where the clips live yet.
    if (grid) grid.classList.add('hidden');
    if (empty) empty.classList.add('hidden');
  }
}

// Vintage-OS dragging for the library window. Position is held in fixed
// top/left after the first drag; the initial centered transform is dropped
// on first mousedown so subsequent moves are absolute, not relative to the
// translate(-50%, -50%) origin.
function wireLibraryDrag() {
  const win = document.getElementById('view-library');
  const handle = document.getElementById('library-titlebar');
  if (!win || !handle) return;

  let dragging = false;
  let startX = 0, startY = 0, originLeft = 0, originTop = 0;

  function clamp(left, top) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const w = win.offsetWidth;
    const h = win.offsetHeight;
    // Keep at least 80px of width and 30px of height visible so the user can
    // always grab the title bar back if they drag too far.
    const minLeft = 80 - w;
    const maxLeft = W - 80;
    const minTop = 0;
    const maxTop = H - 30;
    return [
      Math.max(minLeft, Math.min(maxLeft, left)),
      Math.max(minTop, Math.min(maxTop, top)),
    ];
  }

  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, a')) return;
    dragging = true;
    handle.style.cursor = 'grabbing';
    // Convert the centered transform into an absolute top/left pair so the
    // window can stay where it is at the start of the drag.
    const rect = win.getBoundingClientRect();
    win.style.transform = 'none';
    win.style.left = rect.left + 'px';
    win.style.top = rect.top + 'px';
    startX = e.clientX;
    startY = e.clientY;
    originLeft = rect.left;
    originTop = rect.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const [left, top] = clamp(originLeft + (e.clientX - startX), originTop + (e.clientY - startY));
    win.style.left = left + 'px';
    win.style.top = top + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.style.cursor = 'grab';
  });
}

// Custom always-visible scrollbar — red pill thumb on a dark track. Native
// Always-visible scrollbars via OverlayScrollbars (no dependency on the OS's
// native scrollbar settings). The earlier hand-rolled CSS+JS approach didn't
// reliably defeat macOS's "Show scroll bars: Always" system setting — Matt's
// testers (running with that setting) saw the OS draw native bars on top of
// our content. OverlayScrollbars removes the native scrollbars from the
// layout entirely and renders DOM-based bars, which look identical on every
// OS / system-pref combo.
//
// Apply by adding the `vhs-scroll` class to any scrollable element. We also
// stamp the data-overlayscrollbars-initialize attribute so the layout shifts
// for the bar BEFORE first paint (avoids a flash of native scrollbars).
async function wireCustomScrollbars() {
  let mod;
  try {
    mod = await import('/vendor/overlayscrollbars/overlayscrollbars.esm.js');
  } catch (e) {
    console.warn('[scrollbars] failed to load OverlayScrollbars:', e);
    return;
  }
  const { OverlayScrollbars } = mod;
  document.querySelectorAll('.vhs-scroll').forEach((el) => {
    if (el.dataset.osInited === '1') return;
    el.dataset.osInited = '1';
    OverlayScrollbars(el, {
      scrollbars: {
        theme: 'os-theme-vhs',
        // Always visible — the whole point is non-technical users seeing
        // that there's more content. No fade-out on idle.
        autoHide: 'never',
        clickScroll: true,
      },
      overflow: { x: 'hidden', y: 'scroll' },
    });
  });
}

function refreshLibrary() {
  updateLibraryFolderBanner();
  const clips = getClips();
  const grid = document.getElementById('library-grid');
  const empty = document.getElementById('library-empty');

  // Whole-card click loads the clip back into the main capture editor, just
  // like a fresh recording — preview switches to "Last Recording", catalog
  // metadata fills the Clip Info form, sleeves restore in column 2. The
  // dedicated player modal is no longer the workspace.
  const onOpen = directoryHandle ? async (id) => {
    await loadClipIntoEditor(id);
  } : null;

  // Library card publish button still routes through the same publish path.
  const onUpload = directoryHandle && publishClip
    ? (id) => publishClip(id)
    : null;

  renderLibrary(grid, empty, clips, async (id) => {
    // 1. Snapshot the filename BEFORE removing from catalog (deleteClip wipes
    //    the entry from localStorage so we lose the filename otherwise).
    const allClips = getClips();
    const target = allClips.find(c => c.id === id);
    const filename = target && target.filename;

    // 2. If the user is currently editing this clip, tear down the editor —
    //    otherwise the playback element keeps a blob URL pointing at a file
    //    we're about to delete and any subsequent action against the active
    //    clip ID becomes a no-op (catalog already gone) or worse.
    if (lastClipId === id) {
      const playbackVideo = document.getElementById('playback');
      if (playbackVideo) {
        try { playbackVideo.pause(); } catch {}
        playbackVideo.removeAttribute('src');
        playbackVideo.load();
      }
      if (playbackBlobUrl) {
        URL.revokeObjectURL(playbackBlobUrl);
        playbackBlobUrl = null;
      }
      lastClipId = null;
      hasPlayback = false;
      showLiveTab();
      document.getElementById('delete-recording-btn')?.classList.add('hidden');
      updateClipDependentPanels();
    }

    // 3. Remove from catalog.
    deleteClip(id);

    // 4. Remove from disk too (the previous behavior left the file behind,
    //    which meant a "deleted" clip's file could surface again on import
    //    or persist as orphaned bytes). Wipes the video AND its sidecars
    //    (json, .youtube.txt, sleeve photos). Best-effort — missing files
    //    are silently skipped.
    if (filename && directoryHandle) {
      const basename = filename.replace(/\.(webm|mp4)$/, '');
      const targets = [
        filename,
        `${basename}.json`,
        `${basename}.youtube.txt`,
        `${basename}_front.jpg`,
        `${basename}_back.jpg`,
      ];
      for (const name of targets) {
        try { await directoryHandle.removeEntry(name); } catch {}
      }
    }

    refreshLibrary();
  }, onOpen, onUpload, {
    mode: batchSelection.mode,
    selectedIds: batchSelection.ids,
    onToggleSelect: toggleBatchSelection,
  });
}

// --- Library batch upload (Upload Many) ---
//
// Toggles the library into a selection mode where every un-uploaded tile
// gets a checkbox. User picks up to 6 clips; the titlebar button becomes
// the "Upload (N of 6)" counter. Clicking it (with N > 0) opens a review
// modal where the user can quick-edit title/description per clip before
// confirming. Confirm enqueues all of them into the existing toast upload
// queue (concurrency 2) and exits selection mode.

const BATCH_CAP = 6;
const batchSelection = {
  mode: false,
  ids: new Set(),
};

function setBatchMode(on) {
  batchSelection.mode = on;
  if (!on) batchSelection.ids.clear();
  updateBatchCounterButton();
  refreshLibrary();
}

function toggleBatchSelection(clipId) {
  if (batchSelection.ids.has(clipId)) {
    batchSelection.ids.delete(clipId);
  } else {
    if (batchSelection.ids.size >= BATCH_CAP) return; // silently cap
    batchSelection.ids.add(clipId);
  }
  updateBatchCounterButton();
  refreshLibrary();
}

function updateBatchCounterButton() {
  const btn = document.getElementById('library-upload-many-btn');
  if (!btn) return;
  if (!batchSelection.mode) {
    btn.textContent = 'Upload Many';
    btn.classList.remove('is-active');
    return;
  }
  const n = batchSelection.ids.size;
  btn.textContent = `Upload (${n} of ${BATCH_CAP})`;
  btn.classList.toggle('is-active', n > 0);
}

function wireLibraryBatchUpload() {
  const btn = document.getElementById('library-upload-many-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!batchSelection.mode) {
      // Enter selection mode.
      setBatchMode(true);
      return;
    }
    // Already in selection mode — count = 0 → exit; count > 0 → open review.
    if (batchSelection.ids.size === 0) {
      setBatchMode(false);
      return;
    }
    openBatchReviewModal();
  });

  // Esc exits selection mode (only when no other modal owns the key).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!batchSelection.mode) return;
    const reviewOpen = !document.getElementById('batch-review-modal')?.classList.contains('hidden');
    if (reviewOpen) return; // let the review modal handle Esc itself
    setBatchMode(false);
  });

  // Wire the review modal's Cancel + Confirm + backdrop dismiss.
  const modal = document.getElementById('batch-review-modal');
  const cancelBtn = document.getElementById('batch-review-cancel');
  const confirmBtn = document.getElementById('batch-review-confirm');
  if (cancelBtn) cancelBtn.addEventListener('click', closeBatchReviewModal);
  if (modal) modal.addEventListener('click', (e) => {
    // Only the backdrop (the modal element itself) dismisses; clicks on
    // the inner card don't bubble through.
    if (e.target === modal) closeBatchReviewModal();
  });
  if (confirmBtn) confirmBtn.addEventListener('click', confirmBatchUpload);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const isOpen = !document.getElementById('batch-review-modal')?.classList.contains('hidden');
    if (isOpen) closeBatchReviewModal();
  });
}

function openBatchReviewModal() {
  const modal = document.getElementById('batch-review-modal');
  const list = document.getElementById('batch-review-list');
  const count = document.getElementById('batch-review-count');
  if (!modal || !list) return;

  const clips = getClips();
  const selected = Array.from(batchSelection.ids)
    .map(id => clips.find(c => c.id === id))
    .filter(Boolean);

  if (count) count.textContent = `${selected.length} clip${selected.length === 1 ? '' : 's'}`;

  list.innerHTML = '';
  selected.forEach(clip => {
    const row = document.createElement('div');
    row.className = 'flex gap-3 items-start border border-white/15 p-3';
    row.dataset.clipId = clip.id;
    const titleVal = clip.title || '';
    const descVal = clip.description || '';
    row.innerHTML = `
      <div class="shrink-0 w-20 aspect-video bg-black border border-white/10 overflow-hidden flex items-center justify-center">
        ${clip.thumbnail
          ? `<img src="${clip.thumbnail}" class="w-full h-full object-cover" alt="">`
          : '<span class="text-white/15 text-[10px]">--</span>'}
      </div>
      <div class="flex-1 min-w-0 flex flex-col gap-1.5">
        <input type="text" data-field="title" value="${escapeHtml(titleVal)}"
          placeholder="(no title)"
          class="w-full bg-black border border-white/15 text-white text-[12px] px-2 py-1 focus:outline-none focus:border-white/40">
        <textarea data-field="description" rows="3" placeholder="(no description)"
          class="w-full bg-black border border-white/15 text-white text-[11px] px-2 py-1 resize-none focus:outline-none focus:border-white/40">${escapeHtml(descVal)}</textarea>
      </div>
      <button type="button" data-action="remove" title="Remove from batch"
        class="shrink-0 w-5 h-5 flex items-center justify-center text-white/40 hover:text-red-400 text-sm leading-none">×</button>
    `;
    // Per-row remove button — drops the clip from this batch (selection set
    // also updates so on Cancel you can see the new state).
    const removeBtn = row.querySelector('[data-action=remove]');
    if (removeBtn) removeBtn.addEventListener('click', () => {
      batchSelection.ids.delete(clip.id);
      updateBatchCounterButton();
      refreshLibrary();
      // Re-render or close the modal if no clips remain.
      if (batchSelection.ids.size === 0) {
        closeBatchReviewModal();
      } else {
        openBatchReviewModal();
      }
    });
    list.appendChild(row);
  });

  modal.classList.remove('hidden');
}

function closeBatchReviewModal() {
  document.getElementById('batch-review-modal')?.classList.add('hidden');
  // Selection is preserved so the user can re-open and continue editing.
}

async function confirmBatchUpload() {
  const list = document.getElementById('batch-review-list');
  if (!list) return;

  // 1) Persist the in-modal edits back to the catalog so they survive
  // the upload AND show in the library tile next time.
  const rows = list.querySelectorAll('[data-clip-id]');
  rows.forEach(row => {
    const clipId = row.dataset.clipId;
    const titleEl = row.querySelector('[data-field=title]');
    const descEl = row.querySelector('[data-field=description]');
    const updates = {};
    if (titleEl) updates.title = titleEl.value;
    if (descEl) updates.description = descEl.value;
    updateClip(clipId, updates);
  });

  // 2) Make sure we have a token before queueing the batch — refresh once
  // and reuse for all items so we don't fire N parallel token fetches.
  let token = currentToken;
  if (!token) {
    token = await fetchAccessTokenInBackground();
    if (!token) return;
  }

  // 3) Enqueue every selected clip. The existing queue handles
  // concurrency (2 at a time) and toast rendering. Snapshotting happens
  // inside enqueueUpload — it reads the now-updated catalog title/desc.
  // We bypass the per-clip publish-form snapshot by writing the values
  // straight to the form for each enqueue (form snapshot reads the form,
  // not the catalog — see snapshotPublishForm). Since the form is keyed
  // to a single active clip, easiest is to populate the form per enqueue
  // before calling.
  const orderedIds = rows ? Array.from(rows).map(r => r.dataset.clipId)
                          : Array.from(batchSelection.ids);

  for (const id of orderedIds) {
    // Make snapshotPublishForm see this clip's saved values by writing
    // them into the form briefly. Restore the form values we just
    // overwrote at the very end so the editor doesn't mutate behind
    // the user's back if they happen to be editing a different clip.
    const clips = getClips();
    const clip = clips.find(c => c.id === id);
    if (!clip) continue;
    const titleEl = document.getElementById('clip-title');
    const descEl = document.getElementById('clip-description');
    const tagsEl = document.getElementById('clip-tags');
    const prevTitle = titleEl ? titleEl.value : '';
    const prevDesc = descEl ? descEl.value : '';
    const prevTags = tagsEl ? tagsEl.value : '';
    if (titleEl) titleEl.value = clip.title || '';
    if (descEl) descEl.value = clip.description || '';
    if (tagsEl) tagsEl.value = clip.tags || '';
    enqueueUpload(id, token);
    // Restore on the next microtask so enqueueUpload has time to snapshot.
    if (titleEl) titleEl.value = prevTitle;
    if (descEl) descEl.value = prevDesc;
    if (tagsEl) tagsEl.value = prevTags;
  }

  // 4) Close the modal, exit selection mode, close the library window so
  //    the user sees the toast stack take over.
  closeBatchReviewModal();
  setBatchMode(false);
  document.getElementById('view-library')?.classList.add('hidden');
  document.getElementById('library-backdrop')?.classList.add('hidden');
}

// Read a saved sleeve image from disk and return it as a data URL. Returns
// null if the file isn't present or can't be read. Used as a fallback for
// clips whose catalog entry doesn't carry the sleeve data URLs (older
// recordings, transferred catalogs, etc.).
async function readSleeveFromDisk(dirHandle, basename, side) {
  if (!dirHandle || !basename) return null;
  const filename = `${basename}_${side}.jpg`;
  try {
    const fh = await dirHandle.getFileHandle(filename);
    const file = await fh.getFile();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  } catch {
    return null;
  }
}

// Load a previously-captured clip back into the main capture screen so the
// user can review / edit / publish it using the same UI as a fresh capture.
// This is the new "primary" way to interact with library clips — it replaces
// the player modal as the editing workspace per Matt's feedback.
async function loadClipIntoEditor(clipId) {
  if (!clipId || !directoryHandle) return;
  const clips = getClips();
  const clip = clips.find(c => c.id === clipId);
  if (!clip) return;

  // 1. Load the file from disk → blob URL for the playback preview.
  let url = '';
  if (clip.filename) {
    try {
      const fh = await directoryHandle.getFileHandle(clip.filename);
      const file = await fh.getFile();
      url = URL.createObjectURL(file);
    } catch (e) {
      console.warn('[loadClip] could not open file:', e.message);
      alert('Could not open file. The save folder may need to be re-selected.');
      return;
    }
  }

  // 2. Make this the active clip so Save Data / ▶ YouTube / etc. all act on it.
  lastClipId = clipId;

  // 2b. Merge in the sidecar JSON from disk (defense-in-depth).
  // The catalog is the primary metadata source, but localStorage can drop
  // updates silently when quota explodes — leaving the catalog stale or
  // empty for the very fields we want to populate here. Every save also
  // writes a per-clip {basename}.json sidecar to disk; read that and
  // overlay any fields the catalog is missing. Catalog values always win
  // when present (they're the freshest edits); sidecar fills in gaps.
  let merged = clip;
  if (clip.filename) {
    const basename = clip.filename.replace(/\.(webm|mp4)$/, '');
    const sidecar = await readSidecarJson(directoryHandle, basename);
    if (sidecar) {
      merged = { ...sidecar };
      for (const [k, v] of Object.entries(clip)) {
        if (v != null && v !== '') merged[k] = v;
      }
    }
  }

  // 3. Populate the main Clip Info form from the merged entry.
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  setVal('clip-title', merged.title);
  setVal('clip-description', merged.description);
  setVal('clip-year', merged.year);
  setVal('clip-tags', merged.tags);
  setVal('clip-tape', merged.tape);
  setVal('clip-distributor', merged.distributor);
  setVal('clip-tape-length', merged.tapeLength);
  setVal('clip-speed', merged.recordingSpeed);
  setVal('clip-condition', merged.condition);
  setVal('clip-notes', merged.cassetteNotes);

  // 4. Restore sleeve previews. Sleeves now live on disk only (storing the
  // full data URLs in the catalog blew localStorage quota and broke the
  // record→playback flow). Prefer in-catalog data for back-compat with old
  // entries, then fall back to {basename}_front.jpg / _back.jpg from disk.
  // We don't write back to the catalog — the disk file is the source of truth.
  let frontData = clip.sleeveFront || null;
  let backData = clip.sleeveBack || null;
  if (clip.filename && directoryHandle) {
    const baseForSleeve = clip.filename.replace(/\.(webm|mp4)$/, '');
    if (!frontData) frontData = await readSleeveFromDisk(directoryHandle, baseForSleeve, 'front');
    if (!backData) backData = await readSleeveFromDisk(directoryHandle, baseForSleeve, 'back');
  }
  // restoreSleeve also re-syncs the sleeve module's internal state machine
  // so Retake / Capture Back behave naturally afterward — both captured
  // sits at "done" with the Retake button visible; front-only sits at
  // "front_captured" with the webcam moved into the back slot.
  restoreSleeve(frontData, backData);

  // 5. Wire up the Last Recording playback with this clip's blob URL and
  // switch to that tab so the user sees the clip immediately. Library-open
  // is a user-gesture-driven action, so autoplay-with-sound is allowed —
  // explicitly unmute and reset playbackRate in case a previous clip left
  // them at non-defaults.
  if (url) {
    if (playbackBlobUrl) URL.revokeObjectURL(playbackBlobUrl);
    playbackBlobUrl = url;
    const playbackVideo = document.getElementById('playback');
    if (playbackVideo) {
      playbackVideo.src = url;
      playbackVideo.muted = false;
      playbackVideo.playbackRate = 1;
      playbackVideo.load();
      playbackVideo.play().catch(() => {
        // Autoplay refused (rare from a user click, but possible if the
        // browser deems otherwise) — leave it to the user to hit play.
      });
    }
    showPlaybackTab();
  }

  // 6. Close the library overlay so the user is back on the main capture screen.
  const libraryView = document.getElementById('view-library');
  if (libraryView) libraryView.classList.add('hidden');
  const libraryBackdrop = document.getElementById('library-backdrop');
  if (libraryBackdrop) libraryBackdrop.classList.add('hidden');

  // 7. Reveal the Thumbnail + Publish fieldsets and re-init the publish UI
  //    state machine for the loaded clip (signin / form / done).
  updateClipDependentPanels();

  // 8. Auto-generate 6 thumbnail frames now that the blob is ready.
  triggerThumbnailGenForActiveClip();
}

// --- Active-clip-dependent panels ---
//
// The Thumbnail and Publish to YouTube fieldsets in column 3 are only
// relevant when a clip is loaded into the editor (either freshly recorded
// or re-opened from the library). This toggles their visibility off
// `lastClipId` and re-syncs the publish state machine to the current clip.

let mainEditorAutoSaveTimer = null;
// Tracks which clip the thumbnail picker last generated frames for, so
// publishStateForClip refreshes (which call updateClipDependentPanels for
// the same clip) don't re-trigger generation needlessly.
let lastThumbedClipId = null;

function updateClipDependentPanels() {
  const thumb = document.getElementById('cap-thumb-fieldset');
  const pub = document.getElementById('cap-pub-fieldset');
  const visible = !!lastClipId;
  if (thumb) thumb.classList.toggle('hidden', !visible);
  if (pub) pub.classList.toggle('hidden', !visible);

  // Re-init the publish flow's state machine for whichever clip is now active.
  if (visible && typeof publishStateForClip_external === 'function') {
    const clips = getClips();
    const clip = clips.find(c => c.id === lastClipId);
    if (clip) publishStateForClip_external(lastClipId, clip);
  }

  // Thumbnail picker visibility only — actual frame generation is gated on
  // the playback blob URL being ready (see triggerThumbnailGenForActiveClip)
  // since updateClipDependentPanels can run before the blob exists.
  if (!visible) {
    if (typeof resetThumbnailPicker === 'function') resetThumbnailPicker();
    lastThumbedClipId = null;
  }
}

// Kick off thumbnail generation for the active clip once both the clip ID
// and the playback blob URL are set. Idempotent per clip — calling it
// repeatedly for the same clip is a no-op once we've already generated.
function triggerThumbnailGenForActiveClip() {
  if (!lastClipId || !playbackBlobUrl) return;
  if (lastClipId === lastThumbedClipId) return;
  if (typeof resetThumbnailPicker === 'function') resetThumbnailPicker();
  if (typeof autoGenerateThumbnails === 'function') autoGenerateThumbnails();
  lastThumbedClipId = lastClipId;
}

// Thumbnail picker. Generates 6 random frames from the currently-loaded
// clip's playback blob URL, lets the user click to pick one, and Refresh
// pulls 6 more. Selection persists per-clip and doubles as the library tile.
//
// Generation now fires automatically the moment a clip's blob is available
// (no "Pick thumbnail" button to click), via autoGenerateThumbnails which
// updateClipDependentPanels invokes on every new active clip.
let resetThumbnailPicker = null;
let autoGenerateThumbnails = null;

function wireThumbnailPicker() {
  const refreshBtn = document.getElementById('player-thumb-refresh');
  const emptyState = document.getElementById('player-thumb-empty');
  const loadingState = document.getElementById('player-thumb-loading');
  const gridWrap = document.getElementById('player-thumb-grid-wrap');
  const grid = document.getElementById('player-thumb-grid');
  if (!grid) return;

  let currentThumbnails = [];

  function showState(state) {
    emptyState.classList.toggle('hidden', state !== 'empty');
    loadingState.classList.toggle('hidden', state !== 'loading');
    gridWrap.classList.toggle('hidden', state !== 'grid');
  }

  function renderGrid() {
    const clips = getClips();
    const clip = clips.find(c => c.id === lastClipId);
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
    if (!lastClipId) return;
    // ytThumbnailDataUrl is the full-res frame uploaded to YouTube; thumbnail
    // is the library-tile preview and has to stay tiny so the catalog fits in
    // localStorage. Both come from the same source frame so they stay in sync.
    const small = await shrinkDataUrlForCatalog(dataUrl);
    updateClip(lastClipId, { ytThumbnailDataUrl: dataUrl, thumbnail: small });
    refreshLibrary();
    renderGrid();
  }

  async function generate() {
    // Use the same blob URL the Last Recording playback is showing — that's
    // what corresponds to the active lastClipId.
    if (!playbackBlobUrl) {
      console.warn('[thumb] No playback URL available — record a clip or open one from the library first.');
      return;
    }
    showState('loading');
    try {
      currentThumbnails = await extractThumbnailsFromBlob(playbackBlobUrl, 6);
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
  // Auto-generate is identical to manual generate — exposed at module level
  // so updateClipDependentPanels can fire it whenever a new clip becomes
  // active without the user clicking anything.
  autoGenerateThumbnails = generate;

  refreshBtn.addEventListener('click', generate);
}

// Wire live auto-save on the editable Clip Info fields. Every keystroke
// schedules a debounced save: catalog update, sidecar JSON refresh, and a
// filename rename when the title change drives a new on-disk name. Editing
// while no clip is loaded (live preview, no recording yet) is a no-op — the
// fields are just scratch then. Once a clip is active (REC stop, or library
// click) the same edits start persisting to it.
function wireMainEditorAutosave() {
  const fieldMap = {
    'clip-title': 'title',
    'clip-description': 'description',
    'clip-tags': 'tags',
    'clip-year': 'year',
    'clip-tape': 'tape',
    'clip-distributor': 'distributor',
    'clip-tape-length': 'tapeLength',
    'clip-speed': 'recordingSpeed',
    'clip-condition': 'condition',
    'clip-notes': 'cassetteNotes',
  };

  function flushAutoSave() {
    const id = lastClipId;
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

          // Renaming the file on disk invalidates the existing blob URL —
          // it was created from a File handle bound to the OLD path, and
          // Chrome's File System Access reads lazily, so dereferencing it
          // now returns ERR_FILE_NOT_FOUND. Symptoms: playback breaks
          // silently, thumbnail "Refresh" fails with "Video failed to load
          // for thumbnail extraction." Re-create the blob URL from the new
          // file handle and rewire the playback element + module-level ref
          // so subsequent reads (refresh thumbs, scrub, play) work.
          try {
            const newFh = await directoryHandle.getFileHandle(renamed);
            const newFile = await newFh.getFile();
            if (playbackBlobUrl) URL.revokeObjectURL(playbackBlobUrl);
            playbackBlobUrl = URL.createObjectURL(newFile);
            const playbackVideo = document.getElementById('playback');
            if (playbackVideo) {
              const wasTime = playbackVideo.currentTime;
              const wasPaused = playbackVideo.paused;
              playbackVideo.src = playbackBlobUrl;
              playbackVideo.load();
              // Restore playhead position so the user doesn't jump back to
              // 0 every time they edit the title.
              playbackVideo.addEventListener('loadedmetadata', () => {
                try { playbackVideo.currentTime = wasTime; } catch {}
                if (!wasPaused) { try { playbackVideo.play(); } catch {} }
              }, { once: true });
            }
          } catch (e) {
            console.warn('[autosave] could not refresh blob URL after rename:', e.message);
          }
        }
      }
      const basename = clip.filename.replace(/\.(webm|mp4)$/, '');
      saveSidecarFiles(directoryHandle, basename, clip).catch(() => {});
    })();

    // Library tile is title-derived; nudge it to redraw.
    refreshLibrary();
  }

  function scheduleAutoSave() {
    if (!lastClipId) return;
    if (mainEditorAutoSaveTimer) clearTimeout(mainEditorAutoSaveTimer);
    mainEditorAutoSaveTimer = setTimeout(flushAutoSave, 500);
  }

  Object.keys(fieldMap).forEach(domId => {
    const el = document.getElementById(domId);
    if (!el) return;
    el.addEventListener('input', scheduleAutoSave);
    // Blur forces an immediate flush so we never lose the last few keystrokes
    // when the user clicks elsewhere or closes the page mid-debounce.
    el.addEventListener('blur', flushAutoSave);
  });
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
//
// The move() path can throw InvalidModificationError on user-visible folder
// handles (e.g. immediately after the recorder closed its writable, before
// the OS releases the lock). We catch that and fall through to the copy
// path instead of giving up — the previous version only attempted the
// fallback when move was undefined, leaving the file mis-named whenever
// the new API was present but unhappy.
async function renameFileOnDisk(oldName, newName) {
  if (!directoryHandle || !oldName || !newName || oldName === newName) return null;
  let oldHandle;
  try {
    oldHandle = await directoryHandle.getFileHandle(oldName);
  } catch (e) {
    console.warn('[rename] could not open source:', e.message);
    return null;
  }
  if (typeof oldHandle.move === 'function') {
    try {
      await oldHandle.move(newName);
      return newName;
    } catch (e) {
      console.warn('[rename] move() failed, falling back to copy:', e.message);
    }
  }
  try {
    const file = await oldHandle.getFile();
    const newHandle = await directoryHandle.getFileHandle(newName, { create: true });
    const writable = await newHandle.createWritable();
    await writable.write(file);
    await writable.close();
    await directoryHandle.removeEntry(oldName);
    return newName;
  } catch (e) {
    console.warn('[rename] copy fallback failed:', e.message);
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
  // Save Data button is gone — Clip Info auto-saves on every keystroke now.
  // Bail out cleanly if the element isn't present.
  if (!btn) return;

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

// --- Upload queue + toast notifications ---
//
// Background non-blocking upload pipeline with a stack of toast cards in the
// bottom-right. Clicking Upload in the publish panel:
//   1. Snapshots the form state (title/desc/tags/privacy) into a queue item
//   2. Spawns a toast card showing progress
//   3. The first toast in a fresh interface triggers a 3-2-1 countdown +
//      "Keep Tape Info" bail-out link; on completion the editor wipes back
//      to live-feed-ready state so the user can immediately record again
//   4. Up to 2 uploads run concurrently; the rest sit Queued in the stack
//   5. Success → green border + View link, auto-dismiss after 6s
//   6. Failure → red border + retry icon; toast persists until dismissed,
//      catalog stays untouched (no youtubeUrl), so the clip is re-queue-able
//      by either clicking the retry icon OR (later) selecting + batch-
//      uploading from the library

const uploadQueue = {
  items: [],
  concurrencyLimit: 2,
  // Tracks which toast id "owns" the current 3-2-1 countdown. Null means no
  // countdown active and the next enqueueUpload() will spawn a new one.
  countdownItemId: null,
};

let nextUploadId = 1;
let countdownTimerId = null;

// Snapshot the publish form values at the moment the user clicks Upload.
// We freeze them onto the queue item so a later "Use this" / autosave / new
// clip captured behind the toast can't mutate what gets sent to YouTube.
function snapshotPublishForm() {
  const tagsRaw = document.getElementById('clip-tags')?.value || '';
  return {
    title: document.getElementById('clip-title')?.value || '',
    description: document.getElementById('clip-description')?.value || '',
    tags: tagsRaw.split(',').map(t => t.trim()).filter(Boolean),
    privacyStatus: document.getElementById('yt-pub-privacy')?.value || 'public',
  };
}

function enqueueUpload(clipId, token) {
  // Dedupe — if the same clip is already queued or uploading, ignore the
  // double-click. Successful/errored items can be re-queued (retry path)
  // because they're not in queued/uploading state.
  if (uploadQueue.items.some(it => it.clipId === clipId &&
      (it.state === 'queued' || it.state === 'uploading'))) {
    return null;
  }
  const clips = getClips();
  const clip = clips.find(c => c.id === clipId);
  if (!clip) return null;

  const item = {
    id: 'upload_' + (nextUploadId++),
    clipId,
    title: clip.title || 'Untitled',
    state: 'queued',
    progress: 0,
    xhr: null,
    ytUrl: null,
    errorMsg: null,
    token,
    snippet: snapshotPublishForm(),
    queuePosition: 1,
    queueLength: 1,
  };
  uploadQueue.items.push(item);
  renderToast(item);

  // First toast in a fresh interface state owns the countdown. If a previous
  // countdown is still running (rare — would mean two uploads inside 3s),
  // skip; the existing one will clear for everyone.
  if (uploadQueue.countdownItemId === null) {
    startCountdownForItem(item);
  }
  refreshQueuePositions();
  tryStartNext();
  return item;
}

function tryStartNext() {
  const active = uploadQueue.items.filter(it => it.state === 'uploading').length;
  if (active >= uploadQueue.concurrencyLimit) return;
  const next = uploadQueue.items.find(it => it.state === 'queued');
  if (!next) return;
  next.state = 'uploading';
  renderToast(next);
  refreshQueuePositions();
  runUploadItem(next).finally(() => tryStartNext());
}

function refreshQueuePositions() {
  const queued = uploadQueue.items.filter(it => it.state === 'queued');
  queued.forEach((it, i) => {
    it.queuePosition = i + 1;
    it.queueLength = queued.length;
    renderToast(it);
  });
}

async function runUploadItem(item) {
  try {
    const clips = getClips();
    const clip = clips.find(c => c.id === item.clipId);
    if (!clip || !clip.filename) {
      throw new Error('Clip file is missing — was it deleted from disk?');
    }
    const fh = await directoryHandle.getFileHandle(clip.filename);
    const file = await fh.getFile();
    const contentType = clip.filename.endsWith('.webm') ? 'video/webm' : 'video/mp4';

    const uploadMeta = {
      snippet: {
        title: item.snippet.title,
        description: item.snippet.description,
        tags: item.snippet.tags,
        categoryId: '22',
      },
      status: {
        privacyStatus: item.snippet.privacyStatus,
        selfDeclaredMadeForKids: false,
      },
    };

    // Resumable init — uploadLimitExceeded comes back here, not from the PUT.
    const initRes = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${item.token}`,
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': contentType,
          'X-Upload-Content-Length': String(file.size),
        },
        body: JSON.stringify(uploadMeta),
      }
    );
    if (!initRes.ok) {
      const errBody = await initRes.text();
      const parsed = parseYouTubeError(errBody, initRes.status);
      console.warn('[upload] init failed:', parsed.reason || initRes.status, parsed.apiMessage);
      throw new Error(parsed.display);
    }
    const uploadUrl = initRes.headers.get('location');

    // PUT the file with progress events feeding the toast.
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      item.xhr = xhr;
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('Content-Type', contentType);
      xhr.upload.addEventListener('progress', (e) => {
        if (!e.lengthComputable) return;
        item.progress = Math.round((e.loaded / e.total) * 100);
        renderToast(item);
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const result = JSON.parse(xhr.responseText);
            item.ytUrl = 'https://youtube.com/watch?v=' + result.id;
            updateClip(item.clipId, { youtubeUrl: item.ytUrl, youtubeId: result.id });
            // Fire-and-forget thumbnail upload (same pattern as before).
            const clipsAfter = getClips();
            const clipAfter = clipsAfter.find(c => c.id === item.clipId);
            if (clipAfter && clipAfter.ytThumbnailDataUrl) {
              uploadYouTubeThumbnail(result.id, item.token, clipAfter.ytThumbnailDataUrl)
                .catch((e) => console.warn('[upload] thumbnail failed:', e.message));
            }
            resolve();
          } catch (e) {
            reject(new Error('Upload succeeded but response was unparseable.'));
          }
        } else {
          const parsed = parseYouTubeError(xhr.responseText, xhr.status);
          console.warn('[upload] PUT failed:', parsed.reason || xhr.status, parsed.apiMessage);
          reject(new Error(parsed.display));
        }
      });
      xhr.addEventListener('error', () => {
        reject(new Error('Network error during upload. Check your connection and click retry.'));
      });
      xhr.send(file);
    });

    item.state = 'success';
    item.progress = 100;
    renderToast(item);
    refreshLibrary(); // shows the YouTube badge on the library tile
    // Auto-dismiss success after 6s. Errors stay until user dismisses.
    setTimeout(() => dismissToast(item.id), 6000);
  } catch (e) {
    console.warn('[upload] item failed:', e.message);
    item.state = 'error';
    item.errorMsg = e.message || 'Upload failed.';
    item.xhr = null;
    renderToast(item);
    // Catalog stays untouched (no youtubeUrl set) so the clip remains
    // "not uploaded" in the library and is re-queueable.
  }
}

function dismissToast(id) {
  const item = uploadQueue.items.find(it => it.id === id);
  if (!item) return;
  const card = document.getElementById('toast-' + id);
  if (card) {
    card.classList.remove('is-visible');
    setTimeout(() => card.remove(), 200);
  }
  uploadQueue.items = uploadQueue.items.filter(it => it.id !== id);
  if (uploadQueue.countdownItemId === id) {
    uploadQueue.countdownItemId = null;
    if (countdownTimerId) {
      clearTimeout(countdownTimerId);
      countdownTimerId = null;
    }
  }
  refreshQueuePositions();
}

function retryUpload(id) {
  const item = uploadQueue.items.find(it => it.id === id);
  if (!item || item.state !== 'error') return;
  item.state = 'queued';
  item.progress = 0;
  item.errorMsg = null;
  item.xhr = null;
  // Refresh the access token (the previous one might be stale, especially
  // for a "auth expired"-class failure).
  fetchAccessTokenInBackground().then((tok) => {
    if (tok) item.token = tok;
    renderToast(item);
    refreshQueuePositions();
    tryStartNext();
  }).catch(() => {
    renderToast(item);
    tryStartNext();
  });
}

// 3-2-1 countdown attached to a specific toast. After 3 ticks (or immediately
// if user clicks Keep Tape Info) we wipe the editor back to live-feed-ready.
function startCountdownForItem(item) {
  uploadQueue.countdownItemId = item.id;
  let n = 3;
  renderToast(item);
  const tick = () => {
    n -= 1;
    if (n > 0) {
      const numEl = document.querySelector(`#toast-${item.id} [data-countdown-num]`);
      if (numEl) numEl.textContent = String(n);
      countdownTimerId = setTimeout(tick, 1000);
    } else {
      // Countdown elapsed → clear interface, full wipe.
      countdownTimerId = null;
      uploadQueue.countdownItemId = null;
      renderToast(item); // strips the countdown row
      clearClipForNewCapture({ keepTapeInfo: false });
    }
  };
  countdownTimerId = setTimeout(tick, 1000);
}

function endCountdownKeepingTape(item) {
  if (uploadQueue.countdownItemId !== item.id) return;
  if (countdownTimerId) {
    clearTimeout(countdownTimerId);
    countdownTimerId = null;
  }
  uploadQueue.countdownItemId = null;
  renderToast(item); // strips the countdown row
  clearClipForNewCapture({ keepTapeInfo: true });
}

// Render or update a toast card for a queue item. Idempotent — safe to call
// after every state change.
function renderToast(item) {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  let card = document.getElementById('toast-' + item.id);
  if (!card) {
    card = document.createElement('div');
    card.id = 'toast-' + item.id;
    card.className = 'toast-card';
    stack.appendChild(card);
    requestAnimationFrame(() => card.classList.add('is-visible'));
  }
  card.classList.toggle('is-success', item.state === 'success');
  card.classList.toggle('is-error', item.state === 'error');

  const stateLabel = (
    item.state === 'queued'
      ? `Queued · ${item.queuePosition} of ${item.queueLength}` :
    item.state === 'uploading'
      ? `Uploading · ${item.progress}%` :
    item.state === 'success'
      ? '✓ Uploaded' :
    item.state === 'error'
      ? '✗ Failed' :
    ''
  );

  const showProgress = item.state === 'uploading' || item.state === 'success';
  const showCountdown = uploadQueue.countdownItemId === item.id && item.state !== 'error';
  const showRetry = item.state === 'error';
  const showClose = item.state === 'success' || item.state === 'error';
  const showViewLink = item.state === 'success' && item.ytUrl;

  // Pixel-style retry icon (rotating arrow, similar feel to other UI).
  const retryIcon = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.65 6.35A7.96 7.96 0 0012 4a8 8 0 100 16c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>`;

  card.innerHTML = `
    <div class="toast-title-row">
      <span class="toast-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
      <span class="toast-state-label">${stateLabel}</span>
      ${showRetry ? `<button class="toast-retry-btn" data-action="retry" title="Retry upload">${retryIcon}</button>` : ''}
      ${showClose ? `<button class="toast-close-btn" data-action="close" title="Dismiss">×</button>` : ''}
    </div>
    ${showProgress ? `<div class="toast-progress-track"><div class="toast-progress-bar" style="width:${item.progress}%"></div></div>` : ''}
    ${showCountdown ? `
      <div class="toast-meta-row">
        <span>Starting next clip in <span data-countdown-num>3</span>…</span>
        <button class="toast-secondary-link" data-action="keep">Keep Tape Info</button>
      </div>
    ` : ''}
    ${showViewLink ? `<div class="toast-meta-row"><a class="toast-link" href="${item.ytUrl}" target="_blank" rel="noopener">View on YouTube →</a></div>` : ''}
    ${item.state === 'error' ? `<p class="toast-error-msg">${escapeHtml(item.errorMsg || '')}</p>` : ''}
  `;

  card.querySelectorAll('[data-action]').forEach((el) => {
    el.onclick = () => {
      const action = el.dataset.action;
      if (action === 'retry') retryUpload(item.id);
      else if (action === 'close') dismissToast(item.id);
      else if (action === 'keep') endCountdownKeepingTape(item);
    };
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Reset the editor back to "ready to record" state. Runs at the end of the
// 3-2-1 countdown OR immediately when the user clicks Keep Tape Info.
//   keepTapeInfo: false → full wipe (clip-specific AND tape-level fields,
//                          plus sleeves)
//   keepTapeInfo: true  → wipe only clip-specific fields (title, description,
//                          tags); keep year, distributor, format, speed,
//                          condition, cassette notes, AND sleeve photos
function clearClipForNewCapture({ keepTapeInfo = false } = {}) {
  // Drop the active clip — hides Thumbnail + Publish panels via
  // updateClipDependentPanels.
  lastClipId = null;

  // Stop and clear the playback video element.
  const playbackVideo = document.getElementById('playback');
  if (playbackVideo) {
    try { playbackVideo.pause(); } catch {}
    playbackVideo.removeAttribute('src');
    playbackVideo.load();
  }
  if (playbackBlobUrl) {
    URL.revokeObjectURL(playbackBlobUrl);
    playbackBlobUrl = null;
  }

  // Switch back to the live-feed tab so the user is camera-ready.
  showLiveTab();

  // Clip-specific fields ALWAYS reset — they're per-recording.
  ['clip-title', 'clip-description', 'clip-tags'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  if (!keepTapeInfo) {
    // Tape-level fields reset.
    ['clip-year', 'clip-tape', 'clip-distributor', 'clip-tape-length',
     'clip-speed', 'clip-condition', 'clip-notes'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    // Sleeves reset back to empty placeholders.
    const sleeveFront = document.getElementById('sleeve-front-preview');
    if (sleeveFront) {
      sleeveFront.classList.add('hidden');
      sleeveFront.innerHTML = '<span class="flex items-center justify-center w-full h-full text-white/10 text-[10px]">--</span>';
    }
    const sleeveBack = document.getElementById('sleeve-back-preview');
    if (sleeveBack) {
      sleeveBack.classList.add('hidden');
      sleeveBack.innerHTML = '<span class="flex items-center justify-center w-full h-full text-white/10 text-[10px]">--</span>';
    }
    document.getElementById('sleeve-back-skeleton')?.classList.remove('hidden');
    document.getElementById('sleeve-capture-view')?.classList.remove('hidden');
    document.getElementById('sleeve-review-view')?.classList.add('hidden');
    try { resetSleeve(); } catch {}
  }

  // Re-sync clip-dependent panels (hides Thumbnail + Publish since
  // lastClipId is now null) and refresh the library so the just-uploaded
  // clip shows the YouTube badge.
  updateClipDependentPanels();
  refreshLibrary();
}

// --- YouTube publish ---

// Map YouTube API error reasons → user-readable messages. The Data API
// returns errors as { error: { code, message, errors: [{ reason, ... }] } }.
// The first reason is usually the most specific. We surface the headline
// case (uploadLimitExceeded — Matt hit this and missed the message because
// it was buried in the small grey progress text) plus the other commonly
// hit reasons. Anything unmapped falls through to error.message verbatim.
//
// NOTE on "can we check the limit before uploading?" — no, YouTube does NOT
// expose a per-channel daily upload count anywhere in the Data API. The
// only way to learn you've hit the limit is to attempt an upload and read
// the 403/uploadLimitExceeded response. The Reporting API has channel-level
// metrics but they're delayed by ~24h and not designed for live limit
// checks. The Cloud Console quota dashboard tracks API units (default 10k/
// day), which is unrelated to the per-user video upload cap. So the right
// move is the one we're making here: parse the error well and surface it.
const YT_ERROR_MESSAGES = {
  uploadLimitExceeded:
    "YouTube's daily upload limit hit. The cap is per-channel and resets at midnight Pacific. Try again tomorrow, or in the meantime save the file and upload manually.",
  quotaExceeded:
    "YouTube API quota exceeded for the day. The quota resets at midnight Pacific.",
  dailyLimitExceeded:
    "Daily API limit reached. The quota resets at midnight Pacific.",
  rateLimitExceeded:
    "YouTube rate limit hit — too many requests in a short window. Wait a minute and click Retry.",
  userRateLimitExceeded:
    "Too many uploads in a short window. Wait a minute and click Retry.",
  youtubeSignupRequired:
    "The signed-in Google account doesn't have a YouTube channel. Create one at youtube.com/create_channel and try again.",
  forbidden:
    "Upload forbidden. The channel may be suspended or the OAuth scope may be missing — re-sign-in and try again.",
  authError:
    "YouTube authorization failed. Sign out and back in, then retry.",
  invalid_grant:
    "Sign-in expired. Sign out and sign back in to refresh your YouTube credentials.",
  invalidVideoMetadata:
    "YouTube rejected the video metadata. Check the title (max 100 chars), description (5,000 chars), and tags (max 500 chars total).",
  invalidTitle:
    "Title is invalid — YouTube allows up to 100 characters and no <, > characters.",
  invalidDescription:
    "Description is invalid — YouTube allows up to 5,000 characters.",
  invalidTags:
    "Tags are invalid — combined length can't exceed 500 characters.",
  invalidCategoryId:
    "Invalid YouTube category. This is a bug — please report.",
  mediaBodyRequired:
    "Upload was missing the video file body. This is a bug — please report.",
  videoChunkTooSmall:
    "Resumable upload chunk was too small. Try Retry; if it persists this is a bug.",
};

// Returns a friendly { headline, reason, raw } from a YouTube API error
// response body (string OR already-parsed object). `httpStatus` is used as
// a last-resort fallback if the body has no parseable structure.
function parseYouTubeError(body, httpStatus) {
  let parsed = null;
  if (body && typeof body === 'object') {
    parsed = body;
  } else if (typeof body === 'string' && body.trim()) {
    try { parsed = JSON.parse(body); } catch { /* not JSON */ }
  }
  const errObj = parsed && parsed.error ? parsed.error : null;
  const reason = errObj && Array.isArray(errObj.errors) && errObj.errors[0]
    ? errObj.errors[0].reason
    : null;
  const apiMessage = (errObj && errObj.message) || (errObj && errObj.errors && errObj.errors[0] && errObj.errors[0].message) || '';

  let headline;
  if (reason && YT_ERROR_MESSAGES[reason]) {
    headline = YT_ERROR_MESSAGES[reason];
  } else if (apiMessage) {
    headline = apiMessage;
  } else if (httpStatus === 401) {
    headline = 'Sign-in expired. Sign out and back in, then retry.';
  } else if (httpStatus === 403) {
    headline = 'YouTube refused the upload (403). This is usually a quota or permissions issue.';
  } else if (httpStatus) {
    headline = `Upload failed (HTTP ${httpStatus}).`;
  } else {
    headline = 'Upload failed.';
  }

  // Append the raw API message if it adds info beyond the friendly headline.
  // Skip it when we used apiMessage as the headline (no point repeating).
  let display = headline;
  if (reason && apiMessage && headline !== apiMessage) {
    display = headline + '\n\nYouTube said: "' + apiMessage + '"';
  }
  return { headline, reason, apiMessage, display, raw: parsed };
}

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
  // The Clip Info form fields are the canonical title/desc/tags for the
  // active clip; the publish flow now reads/writes them directly instead of
  // having shadow inputs.
  const titleInput = document.getElementById('clip-title');
  const descInput = document.getElementById('clip-description');
  const tagsInput = document.getElementById('clip-tags');
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
    // The slim done panel hard-codes "View →" as the visible label, so don't
    // wipe linkEl.textContent here — it would leave an empty <a> when we
    // re-show the done state for an already-uploaded clip.
    linkEl.title = '';
    currentSuggestion = null;
  }

  function hideAllPanels() {
    loading.classList.add('hidden');
    errorPanel.classList.add('hidden');
    form.classList.add('hidden');
    done.classList.add('hidden');
    signinPanel.classList.add('hidden');
    suggestionPanel.classList.add('hidden');
    // thumbWarn is now a sibling of `done` (not a child), so hiding `done`
    // doesn't auto-hide it. Reset alongside the panels so a stale warning
    // from a prior upload doesn't leak across clip switches / sign-outs.
    if (thumbWarn) {
      thumbWarn.classList.add('hidden');
      thumbWarn.textContent = '';
    }
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

  // Called by updateClipDependentPanels whenever lastClipId changes; re-syncs
  // the publish UI state machine (signin vs form vs done) for whichever clip
  // just became active.
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
      // Don't overwrite the visible text — the slim done panel hard-codes
      // "View →" to keep the row tight. The full URL is still available
      // via the href and the link's title attribute (set below) for hover.
      linkEl.title = clip.youtubeUrl;
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

  // Triggered by the "▶ YouTube" button after recording and library card
  // publish buttons. With the publish UI now permanently inline in column 3,
  // this just makes sure the active clip is loaded into the editor and
  // scrolls the column to bring the publish fieldset into view.
  async function startPublish(clipId = lastClipId) {
    if (!clipId) return;
    // If the requested clip isn't already the active one, load it into the
    // editor (this also fires updateClipDependentPanels under the hood).
    if (clipId !== lastClipId) {
      await loadClipIntoEditor(clipId);
    } else {
      publishStateForClip(clipId);
    }
    const pub = document.getElementById('cap-pub-fieldset');
    if (pub) pub.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

    // Suggestion fields are now real <input>/<textarea>, not <p> — write
    // to .value so they're editable in place. The user can tweak any of
    // the three before clicking Use this; applySuggestion reads back from
    // these same .value properties (not from `data`).
    suggestionTitle.value = data.title || '';
    suggestionDesc.value = data.description || '';
    suggestionTags.value = data.tags || '';
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
    // Pull from the visible suggestion fields (which the user may have
    // edited) rather than the stashed AI response. This is what makes
    // the preview meaningfully editable — the AI gives you a starting
    // point, you tweak it, "Use this" copies your version into the
    // main sidebar form. Empty fields don't overwrite (so an accidental
    // wipe doesn't blow away whatever's already in the sidebar).
    if (currentSuggestionScope === 'all' || currentSuggestionScope === 'title') {
      const t = (suggestionTitle.value || '').trim();
      if (t) titleInput.value = t;
    }
    if (currentSuggestionScope === 'all' || currentSuggestionScope === 'description') {
      const d = suggestionDesc.value || '';
      if (d.trim()) descInput.value = d;
    }
    if (currentSuggestionScope === 'all') {
      const tags = (suggestionTags.value || '').trim();
      if (tags) tagsInput.value = tags;
    }
    currentSuggestion = null;
    showForm();
  }

  // The standalone "▶ YouTube" trigger button used to live next to the
  // controls bar but has been retired. The publish flow now lives inline
  // in column 3, so the button isn't needed. Guard the listener so we
  // don't blow up if the element isn't present.
  if (btn) btn.addEventListener('click', () => startPublish());
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

    // Make sure we have a token — refresh if needed before queueing so the
    // queued item carries a valid bearer. (Subsequent items reuse this same
    // token unless the user retries; retryUpload re-fetches.)
    let token = currentToken;
    if (!token) {
      uploadBtn.disabled = true;
      uploadBtn.textContent = 'Preparing...';
      token = await fetchAccessTokenInBackground();
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Upload to YouTube';
      if (!token) return;
    }

    // Hand off to the upload queue. The button click is now non-blocking:
    // a toast spawns, the 3-2-1 countdown starts, and the rest of the
    // upload happens in the background. The user can immediately start
    // recording another clip.
    enqueueUpload(publishClipId, token);
  });
}

// Module-level handle so updateClipDependentPanels can re-init the publish
// UI whenever the active clip changes. Set by wireYouTubePublish.
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

    // Look up the clip's filename from the CATALOG (the active clip might
    // have been loaded from the library, in which case getLastFileHandle()
    // points at a stale recorded handle and `removeEntry(fh.name)` would
    // delete the wrong file — or no file at all if there's no recording in
    // this session). Use the catalog filename for the active clip every time.
    const clips = getClips();
    const activeClip = clips.find(c => c.id === lastClipId);
    const filenameToDelete = activeClip && activeClip.filename;

    // Remove from catalog
    deleteClip(lastClipId);

    // Remove the file from disk + its sidecars (json, sleeves, youtube.txt).
    if (filenameToDelete && directoryHandle) {
      const basename = filenameToDelete.replace(/\.(webm|mp4)$/, '');
      const targets = [
        filenameToDelete,
        `${basename}.json`,
        `${basename}.youtube.txt`,
        `${basename}_front.jpg`,
        `${basename}_back.jpg`,
      ];
      for (const name of targets) {
        try { await directoryHandle.removeEntry(name); } catch {} // best-effort
      }
    }

    // Clean up playback — but do NOT clear form fields
    const playbackVideo = document.getElementById('playback');
    playbackVideo.src = '';
    if (playbackBlobUrl) {
      URL.revokeObjectURL(playbackBlobUrl);
      playbackBlobUrl = null;
    }
    lastClipId = null;
    // Hide the clip-dependent fieldsets (Thumbnail / Publish) since we no
    // longer have an active clip.
    updateClipDependentPanels();

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
  // Save Data + Publish buttons used to live in the controls row alongside
  // Delete; they were retired (auto-save + inline publish in sidebar). Guard
  // the show/hide for any older HTML still floating around.
  document.getElementById('save-data-btn')?.classList.remove('hidden');
  document.getElementById('publish-yt-btn')?.classList.remove('hidden');

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
  document.getElementById('save-data-btn')?.classList.add('hidden');
  document.getElementById('publish-yt-btn')?.classList.add('hidden');

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
