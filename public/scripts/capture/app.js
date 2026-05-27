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
import { buildProcessedStream } from './audio-chain.js';
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

// YouTube OAuth access token cache. Populated by fetchAccessTokenInBackground
// (defined below) and by wireYouTubePublish on every clip switch. Module-
// scoped so the upload queue + retry handlers (which run outside
// wireYouTubePublish's closure) can read it.
let currentToken = null;

// Pre-warm / refresh the YouTube access token from the stored refresh token.
// Returns the access token string on success; clears credentials and
// returns null on 401 (refresh token expired/revoked). Module-scoped so
// every upload code path uses the same implementation.
async function fetchAccessTokenInBackground() {
  if (currentToken) return currentToken;
  const refreshToken = ytGetRefreshToken && ytGetRefreshToken();
  if (!refreshToken) return null;
  try {
    const res = await fetch('/api/youtube-publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'token', refreshToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      // Stale refresh token — wipe creds and bounce the publish UI back
      // to the sign-in panel. Helpers might not exist yet at very first
      // call so guard them.
      if (typeof ytClearCredentials === 'function') ytClearCredentials();
      if (typeof ytUpdateAccountUI === 'function') ytUpdateAccountUI();
      if (typeof clearWhoamiCache === 'function') clearWhoamiCache();
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
  wireTrim();
  wireShorts();
  wireResetButtons();
  wireYouTubePublish();
  // Sync the "Uploaded today: N" indicators to whatever's in
  // localStorage when the page first paints. Subsequent updates flow
  // through setUploadCount → updateUploadCountUI on every increment
  // and reset, but the very first paint needs a kick.
  updateUploadCountUI();
  wireMainEditorAutosave();
  wireThumbnailPicker();
  wireLibraryDrag();
  wireLibraryBatchUpload();
  wireLibraryFilter();
  wireLibraryResync();
  wireCatalogSaveFailureToast();
  wireCharCounters();
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

  // Strip image data from JSON. These all live as their own files on
  // disk (sleeves as {basename}_front/_back.jpg, the picked YouTube
  // frame as {basename}_youtube.jpg) so duplicating them as base64
  // inside the sidecar JSON just bloats the file for no benefit.
  const jsonEntry = { ...entry };
  delete jsonEntry.thumbnail;
  delete jsonEntry.sleeveFront;
  delete jsonEntry.sleeveBack;
  delete jsonEntry.ytThumbnailDataUrl;

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
    // Live audio processing — boosts loudness and cuts hum at the
    // Web Audio level before MediaRecorder sees the stream. Default
    // on; user toggle in the settings popover. See audio-chain.js.
    const audioProcessingEnabled = settings.audioProcessingEnabled !== false;
    let processedDispose = null;
    let recordStream = captureStream;
    // Idempotent teardown for the audio chain. Defined here (not
    // inside onStop) so it's reachable from all the failure paths:
    // onStop's finally, onError, and the catch around startRecording
    // itself. Without this hoist, an exception thrown before
    // mediaRecorder is created would leak the AudioContext for the
    // rest of the page session.
    const finalizeProcessedAudio = () => {
      if (processedDispose) {
        try { processedDispose(); } catch {}
        processedDispose = null;
      }
    };
    if (audioProcessingEnabled) {
      try {
        const built = buildProcessedStream(captureStream);
        recordStream = built.stream;
        processedDispose = built.dispose;
      } catch (e) {
        console.warn('[audio-chain] failed to build, recording raw:', e);
        // Fall through — record unprocessed rather than block the user.
      }
    }
    const title = titleInput.value;
    const videoFormat = settings.videoFormat || 'mp4';
    currentFilename = generateFilename(title, settings.nameFormat || 'title', videoFormat);
    // Suffix the filename if a clip with this title already exists on disk —
    // generateFilename's title+timestamp pattern can collide when the user
    // copy-pastes the same title between recordings in the same minute. The
    // collision was silently overwriting the prior clip's video AND its
    // sidecar JSON / _youtube.txt / sleeve files, which is how Matt ended
    // up with one clip's description tied to a different clip from the
    // same tape.
    currentFilename = await pickUniqueFilename(currentFilename);
    const bitrate = settings.bitrate || 5000000;

    btn.classList.add('recording');
    btn.querySelector('.rec-label').textContent = 'STOP';
    document.getElementById('preview-container').classList.add('recording-active');
    document.getElementById('rec-overlay-timer').classList.remove('hidden');
    const liveTab = document.getElementById('tab-live');
    if (liveTab) liveTab.textContent = '░ Recording ░';
    // CRITICAL: drop lastClipId for the duration of the recording.
    // The form fields (title / description / tags / etc.) are used by
    // BOTH the editor (autosaves into lastClipId) AND the recording
    // (the onStop handler reads them into the new clip's catalog
    // entry). If the user had a previous clip loaded into the editor,
    // lastClipId still points there, and any field edits during this
    // recording — including pasting the next clip's title — would
    // autosave into the OLD clip, silently overwriting its metadata
    // with the in-progress recording's. That's the "info getting
    // linked to the wrong video" Matt's been seeing across his
    // 20-commercial-breaks-from-one-tape sessions. By nulling
    // lastClipId here, scheduleAutoSave's `if (!lastClipId) return`
    // guard short-circuits during recording. The onStop handler then
    // assigns lastClipId = entry.id once the new clip exists, and
    // autosave resumes against THAT one.
    lastClipId = null;
    // (Previously called resetSleeve() here — removed because it broke
    // the multi-clip-from-one-tape flow. The actual usage pattern is:
    // photograph the tape's sleeve once, then record many clips in
    // sequence. Each recording stop calls saveSleevePhotos so every
    // clip's basename gets its own copy on disk; the sleeve module
    // retains the source data between records. The user explicitly
    // resets via × Reset Sleeve / × Reset info / the toast's "Reset
    // everything" link when they swap to a new tape.)

    try {
      await startRecording(recordStream, directoryHandle, currentFilename, bitrate, videoFormat, {
      onTick: ({ elapsed, bytes }) => {
        const timeStr = formatTime(elapsed);
        timerEl.textContent = timeStr;
        sizeEl.textContent = formatSize(bytes);
        document.getElementById('rec-overlay-timer').textContent = timeStr;
      },
      onStop: async ({ duration, fileSize }) => {
        try {
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
          // Suffix if the desired name collides with another clip's file.
          // allowSelf passes our current name so we don't suffix against
          // ourselves on the round-trip.
          const safeDesired = await pickUniqueFilename(desiredFilename, { allowSelf: currentFilename });
          if (safeDesired !== currentFilename) {
            const renamed = await renameFileOnDisk(currentFilename, safeDesired);
            if (renamed) currentFilename = renamed;
          }
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

        // Create blob URL from the recorded file for playback. Pull the
        // file by name from the directory handle — the recorder's
        // cached handle may have been invalidated by the rename.
        //
        // Defensive resolution: try the catalog filename, then the
        // alt-extension sibling (mp4↔webm — covers cases where rename
        // didn't actually take or the recorder produced a different
        // container than we asked for), then the recorder's cached
        // handle as last resort. ALWAYS call showPlaybackTab() so the
        // user sees the view switch even if the file load failed —
        // they were expecting to land on playback after a recording
        // stops, and silently staying on the live feed (the previous
        // behavior) is the worst of all worlds.
        let fh = null;
        let fhResolution = null;
        try {
          if (currentFilename && directoryHandle) {
            try {
              fh = await directoryHandle.getFileHandle(currentFilename);
              fhResolution = 'exact';
            } catch (e1) {
              // Try the alternate extension. Most likely cause if this
              // succeeds: the rename via move() reported success but
              // didn't actually take, OR the recorder fell back to a
              // different container than the filename suggests.
              const altName = currentFilename.endsWith('.mp4')
                ? currentFilename.replace(/\.mp4$/i, '.webm')
                : currentFilename.endsWith('.webm') ? currentFilename.replace(/\.webm$/i, '.mp4') : null;
              if (altName) {
                try {
                  fh = await directoryHandle.getFileHandle(altName);
                  fhResolution = 'alt-ext';
                  console.warn('[capture] post-stop fell back to alt-ext file', {
                    catalog: currentFilename, found: altName,
                  });
                  // Update the catalog entry so future opens hit the
                  // right name (the entry we just added points at the
                  // wrong name — fix it before the user notices).
                  updateClip(entry.id, { filename: altName });
                  currentFilename = altName;
                } catch { /* fall through to lastFileHandle */ }
              }
            }
          }
          if (!fh) {
            fh = getLastFileHandle();
            if (fh) fhResolution = 'recorder-cached-handle';
          }

          if (fh) {
            const file = await fh.getFile();
            console.info('[capture] playback file ready', {
              filename: currentFilename, resolution: fhResolution, bytes: file.size,
            });
            if (playbackBlobUrl) URL.revokeObjectURL(playbackBlobUrl);
            playbackBlobUrl = URL.createObjectURL(file);
            const playbackVideo = document.getElementById('playback');
            playbackVideo.src = playbackBlobUrl;
            // Reset audio defaults — the demo flow + various other code
            // paths leave the playback element in muted=true (it was
            // playing the silent /puppet/vhs-sample.mp4). If we don't
            // reset here, the user records a clip after running the
            // demo and the playback is silent for no obvious reason.
            // loadClipIntoEditor already does this; mirroring here so
            // the post-stop path is consistent.
            playbackVideo.muted = false;
            playbackVideo.playbackRate = 1;
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
            triggerThumbnailGenForActiveClip();
          } else {
            // No handle at all. Switch to playback view anyway so the
            // user sees that the recording ended (the live-feed-stays
            // behavior was confusing — looked like recording silently
            // failed). Surface a clear error.
            console.warn('[capture] post-stop could not resolve any file handle', {
              catalogFilename: currentFilename,
            });
            showPlaybackTab();
            showErrorToast(
              `Recording saved — preview unavailable`,
              `Couldn't open "${currentFilename}" for playback. The clip is in the library — open it from there. If that also fails, the file may not have written correctly to disk.`
            );
          }
        } catch (err) {
          console.warn('[capture] post-stop playback load threw', {
            catalogFilename: currentFilename, resolution: fhResolution, error: err.message,
          });
          // Still show the playback tab so the UI matches user expectation.
          showPlaybackTab();
        }

        currentFilename = null;
        } finally {
          finalizeProcessedAudio();
        }
      },
      onError: (err) => {
        finalizeProcessedAudio();
        btn.classList.remove('recording');
        document.getElementById('preview-container').classList.remove('recording-active');
        document.getElementById('rec-overlay-timer').classList.add('hidden');
        alert('Recording error: ' + err.message);
      },
    });
    } catch (e) {
      // startRecording itself threw (e.g., disk permission revoked
      // between the pre-check and createWritable). Tear down the
      // audio chain so the AudioContext doesn't leak, then surface
      // the failure the same way onError does.
      finalizeProcessedAudio();
      btn.classList.remove('recording');
      document.getElementById('preview-container').classList.remove('recording-active');
      document.getElementById('rec-overlay-timer').classList.add('hidden');
      alert('Recording error: ' + (e?.message || e));
    }
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

  const aiTrigger = document.getElementById('status-ai-trigger');
  if (aiTrigger) {
    aiTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = getAiModel();
      const items = AI_MODELS.map((m) => ({
        label: m.label,
        checked: m.id === current,
        onClick: () => setAiModel(m.id),
      }));
      items.push({ separator: true });
      items.push({
        label: 'Reset to default',
        disabled: current === DEFAULT_AI_MODEL,
        onClick: () => setAiModel(DEFAULT_AI_MODEL),
      });
      openToolbarMenu(aiTrigger, items);
    });
  }
}

// ---------------------------------------------------------------------------
// AI model selection
// ---------------------------------------------------------------------------
//
// Three Gateway models, one persistent per-browser choice. Default is
// Gemini Flash Lite — designed for high-volume structured outputs, fast,
// cheap. GPT-4.1-nano + Claude Haiku 4.5 are alternatives if quality or
// style needs differ. The selected ID is sent on every /api/youtube-publish
// rewrite request; the function dispatches to the matching provider.
const AI_MODELS = [
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (default, fastest)' },
  { id: 'gpt-4.1-nano',          label: 'GPT-4.1 nano' },
  { id: 'claude-haiku-4-5',      label: 'Claude Haiku 4.5' },
];
const DEFAULT_AI_MODEL = 'gemini-2.5-flash-lite';
const AI_MODEL_KEY = 'vhsg_ai_model';

function getAiModel() {
  try {
    const stored = localStorage.getItem(AI_MODEL_KEY);
    // Validate against the allowlist so a stale value can't survive a
    // rename and silently 4xx every request.
    if (stored && AI_MODELS.some((m) => m.id === stored)) return stored;
  } catch {}
  return DEFAULT_AI_MODEL;
}
function setAiModel(id) {
  try { localStorage.setItem(AI_MODEL_KEY, id); } catch {}
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
  // Side-effect: scan disk for orphaned sidecars and reveal/hide the
  // resync banner. Fire-and-forget so refreshLibrary stays sync-fast.
  checkLibraryResyncBanner().catch(() => {});
  const allClips = getClips();
  // Apply the user's "Show: All" / "Show: Un-uploaded" filter. Persisted
  // in localStorage by wireLibraryFilter; default is 'all'.
  const filter = getLibraryFilter();
  const clips = filter === 'unuploaded'
    ? allClips.filter(c => !c.youtubeUrl)
    : allClips;
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

  // Right-click → "Mark not uploaded". Clears youtubeUrl + youtubeId from
  // the catalog so the YouTube pill on the tile disappears and the clip
  // becomes re-queueable. Also wipes any saved YT thumbnail metadata so
  // the next upload can pick a fresh one. Does NOT touch the actual
  // YouTube video — the user can delete it from Studio separately if
  // they need to. This is a "let me redo the upload from VHS Garage's
  // side" shortcut, not a YouTube content moderation action.
  const onMarkUnuploaded = (id) => {
    const clips = getClips();
    const target = clips.find(c => c.id === id);
    updateClip(id, {
      youtubeUrl: null,
      youtubeId: null,
      ytThumbnailDataUrl: null,
      ytThumbnailTime: null,
    });
    // Clear the on-disk thumbnail backup too — without this, the disk
    // copy outlives the catalog clear and gets re-imported the next time
    // loadClipIntoEditor restores from disk, undoing the user's intent
    // to "redo this upload from scratch."
    if (target && target.filename && directoryHandle) {
      const basename = target.filename.replace(/\.(webm|mp4)$/, '');
      directoryHandle.removeEntry(`${basename}_youtube.jpg`).catch(() => {});
    }
    // If the cleared clip is the one currently in the editor, refresh
    // the publish panel so it flips back from "Uploaded" to the form.
    if (lastClipId === id) {
      const allClips = getClips();
      const refreshed = allClips.find(c => c.id === id);
      if (typeof publishStateForClip_external === 'function' && refreshed) {
        publishStateForClip_external(id, refreshed);
      }
    }
    refreshLibrary();
  };

  // Right-click → "Duplicate". Pure file copy + catalog clone — no
  // re-encode, no quality loss, fast (size-bound). Use case: "I want
  // to make 3 trailers from this one raw recording." Duplicate three
  // times, then trim each copy to a different range. The copy is a
  // fully independent clip (own ID, own filename, own sidecars, own
  // editable metadata fields) with youtube* fields cleared so it
  // uploads as a new YouTube video rather than overwriting the
  // source's. Available whenever a save folder is mounted.
  const onDuplicate = directoryHandle ? (id) => duplicateClip(id) : null;

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
        `${basename}_youtube.jpg`,
      ];
      for (const name of targets) {
        try { await directoryHandle.removeEntry(name); } catch {}
      }
    }

    refreshLibrary();
  }, onOpen, onUpload, onMarkUnuploaded, onDuplicate, {
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
    btn.title = 'Pick multiple clips to upload at once';
    return;
  }
  const n = batchSelection.ids.size;
  // When in batch mode with NOTHING selected, the button is the user's
  // exit hatch (the existing handler turns batch mode off when count is
  // 0 and they click again). The old label "Upload (0 of 6)" looked
  // like a no-op upload — we want it to read clearly as "click to bail
  // out." Once they've picked at least one, label reverts to the count.
  if (n === 0) {
    btn.textContent = 'Cancel';
    btn.classList.remove('is-active');
    btn.title = 'Exit selection mode';
  } else {
    btn.textContent = `Upload (${n} of ${BATCH_CAP})`;
    btn.classList.add('is-active');
    btn.title = `Upload ${n} clip${n === 1 ? '' : 's'}`;
  }
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

function buildPlaylistCheckboxesHtml(playlists, prefix) {
  return playlists.map((p) => `
    <label class="flex items-center gap-2 text-[11px] text-white/70 hover:text-white/90 cursor-pointer">
      <input type="checkbox" data-playlist-id="${escapeHtml(p.id)}" data-prefix="${prefix}"
             class="accent-red-600 cursor-pointer" />
      <span class="flex-1 truncate">${escapeHtml(p.title)}</span>
      <span class="text-white/30 tabular-nums">${p.itemCount || 0}</span>
    </label>
  `).join('');
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

  // Populate master playlist picker
  const masterWrapper = document.getElementById('batch-master-playlists');
  const masterList = document.getElementById('batch-master-playlists-list');
  const playlists = (cachedPlaylists && cachedPlaylists.length > 0) ? cachedPlaylists : [];

  if (masterWrapper && masterList) {
    if (playlists.length > 0) {
      masterList.innerHTML = buildPlaylistCheckboxesHtml(playlists, 'batch-master');
      masterWrapper.classList.remove('hidden');
      // Wire master → per-card sync
      masterList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
          const pid = cb.dataset.playlistId;
          const checked = cb.checked;
          list.querySelectorAll(`input[data-playlist-id="${CSS.escape(pid)}"][data-prefix="batch-card"]`).forEach(cardCb => {
            cardCb.checked = checked;
          });
        });
      });
    } else {
      masterWrapper.classList.add('hidden');
      masterList.innerHTML = '';
    }
  }

  // Kick off a playlist fetch in case they haven't been loaded yet
  if (playlists.length === 0) {
    fetchUserPlaylists().then(result => {
      if (!result || result.status !== 'ok' || !result.playlists.length) return;
      if (document.getElementById('batch-review-modal')?.classList.contains('hidden')) return;
      // Re-open to pick up newly fetched playlists
      openBatchReviewModal();
    });
  }

  list.innerHTML = '';
  selected.forEach(clip => {
    const row = document.createElement('div');
    row.className = 'flex gap-3 items-start border border-white/15 p-3';
    row.dataset.clipId = clip.id;
    const titleVal = clip.title || '';
    const descVal = clip.description || '';
    const playlistHtml = playlists.length > 0
      ? `<div class="batch-card-playlists mt-1.5 pt-1.5 border-t border-white/10">
           <p class="text-white/40 text-[10px] uppercase tracking-widest mb-1">Playlists</p>
           <div class="space-y-0.5">${buildPlaylistCheckboxesHtml(playlists, 'batch-card')}</div>
         </div>`
      : '';
    row.innerHTML = `
      <div class="shrink-0 w-20 aspect-video bg-black border border-white/10 overflow-hidden flex items-center justify-center">
        ${clip.thumbnail
          ? `<img src="${clip.thumbnail}" class="w-full h-full object-cover" alt="">`
          : '<span class="text-white/15 text-[10px]">--</span>'}
      </div>
      <div class="flex-1 min-w-0 flex flex-col gap-1.5">
        <input type="text" data-field="title" value="${escapeHtml(titleVal)}" maxlength="100"
          placeholder="(no title)"
          class="w-full bg-black border border-white/15 text-white text-[12px] px-2 py-1 focus:outline-none focus:border-white/40">
        <textarea data-field="description" rows="3" placeholder="(no description)" maxlength="5000"
          class="w-full bg-black border border-white/15 text-white text-[11px] px-2 py-1 resize-none focus:outline-none focus:border-white/40">${escapeHtml(descVal)}</textarea>
        ${playlistHtml}
      </div>
      <button type="button" data-action="remove" title="Remove from batch"
        class="shrink-0 w-5 h-5 flex items-center justify-center text-white/40 hover:text-red-400 text-sm leading-none">×</button>
    `;
    const removeBtn = row.querySelector('[data-action=remove]');
    if (removeBtn) removeBtn.addEventListener('click', () => {
      batchSelection.ids.delete(clip.id);
      updateBatchCounterButton();
      refreshLibrary();
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
  // ALSO exit batch-selection mode. Previously we preserved the
  // selection "so the user can re-open and continue editing" — but
  // that left the library stuck in checkbox-mode after Cancel /
  // backdrop / Esc, which silently broke the "click a tile to open
  // it" flow until the user discovered they had to press Esc again
  // (or hard-refresh). Always exiting on close is the less surprising
  // default; if a user really wants to keep editing a selection they
  // can just leave the modal open. Same reasoning as the post-upload
  // reset default flip.
  if (typeof setBatchMode === 'function') setBatchMode(false);
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
  // Snapshot per-card playlist selections before we close the modal.
  const perCardPlaylists = new Map();
  if (rows) {
    rows.forEach(row => {
      const clipId = row.dataset.clipId;
      const checked = Array.from(row.querySelectorAll('input[data-prefix="batch-card"][type="checkbox"]:checked'))
        .map(cb => cb.dataset.playlistId)
        .filter(Boolean);
      perCardPlaylists.set(clipId, checked);
    });
  }

  const orderedIds = rows ? Array.from(rows).map(r => r.dataset.clipId)
                          : Array.from(batchSelection.ids);

  for (const id of orderedIds) {
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
    enqueueUpload(id, token, perCardPlaylists.get(id));
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

// --- Library: filter (Show All / Un-uploaded) ---
//
// Once the library has more than a couple dozen clips and most are
// uploaded, finding the un-uploaded ones is a chore. The titlebar button
// flips between "Show: All" and "Show: Un-uploaded"; choice persists in
// localStorage. refreshLibrary respects the filter when rendering.

const LIBRARY_FILTER_KEY = 'vhsg_library_filter';
function getLibraryFilter() {
  try { return localStorage.getItem(LIBRARY_FILTER_KEY) || 'all'; }
  catch { return 'all'; }
}
function setLibraryFilter(v) {
  try { localStorage.setItem(LIBRARY_FILTER_KEY, v); } catch {}
  updateLibraryFilterButton();
  refreshLibrary();
}
function updateLibraryFilterButton() {
  const btn = document.getElementById('library-filter-btn');
  if (!btn) return;
  const f = getLibraryFilter();
  btn.textContent = f === 'unuploaded' ? 'Show: Un-uploaded' : 'Show: All';
}

// --- Upload counter (manual quota tracking) ---
//
// YouTube doesn't expose a per-channel daily upload count anywhere in
// the Data API — the only way to learn you've hit the cap is to attempt
// an upload and read the 403/uploadLimitExceeded response. Until they
// add an endpoint, the workable substitute is a manual counter the user
// resets when they hit the limit. Bridge or direct, every successful
// upload from this browser bumps it. The persistent display (in the
// publish panel) shows "Uploaded today: N" so users have a running
// guess at where they stand vs. the 50/day cap. The "Reset count"
// action only appears in the failure toast for uploadLimitExceeded —
// no auto-reset on midnight Pacific (we don't know the user's timezone
// and clock-watching is brittle), no reset on transient errors. The
// user owns the calibration moment.
const UPLOAD_COUNT_KEY = 'vhsg_upload_count_today';
function getUploadCount() {
  try { return Math.max(0, parseInt(localStorage.getItem(UPLOAD_COUNT_KEY) || '0', 10) || 0); }
  catch { return 0; }
}
function setUploadCount(n) {
  try { localStorage.setItem(UPLOAD_COUNT_KEY, String(Math.max(0, n))); } catch {}
  updateUploadCountUI();
}
function incrementUploadCount() {
  const next = getUploadCount() + 1;
  setUploadCount(next);
  return next;
}
function resetUploadCount() {
  setUploadCount(0);
}

// Refresh every "Uploaded today: N" display on the page. Hidden when
// the count is 0 (so brand-new users / freshly-reset states are blank
// rather than reading "Uploaded today: 0" which is technically true
// but visually noisy).
function updateUploadCountUI() {
  const n = getUploadCount();
  document.querySelectorAll('[data-upload-count]').forEach((el) => {
    if (n <= 0) {
      el.classList.add('hidden');
    } else {
      el.classList.remove('hidden');
      const numEl = el.querySelector('[data-upload-count-value]');
      if (numEl) numEl.textContent = String(n);
    }
  });
}
function wireLibraryFilter() {
  const btn = document.getElementById('library-filter-btn');
  if (!btn) return;
  updateLibraryFilterButton();
  btn.addEventListener('click', () => {
    setLibraryFilter(getLibraryFilter() === 'unuploaded' ? 'all' : 'unuploaded');
  });
}

// --- Library: resync from disk ---
//
// Catalog lives in localStorage which can be cleared (browser cleanup,
// quota, dev tools, switching browsers). The on-disk files are the durable
// source of truth. Two recovery paths run on every library refresh:
//
//   (A) Orphan SIDECARS — {basename}.json exists, catalog missing. Parse
//       the sidecar and re-add the entry. This is the common recovery
//       path after a localStorage wipe (cross-browser, dev-tools clear).
//
//   (B) Orphan VIDEOS  — {basename}.mp4/.webm exists with NO sidecar AND
//       no catalog entry. This is the path that was missing — when a
//       recording or trim wrote the file to disk but the catalog write
//       silently failed (quota explosion), there was no way to get the
//       clip back into the library. We synthesize a minimal entry from
//       the file's metadata and write a sidecar so it survives going
//       forward.
//
// We never delete catalog entries whose file is missing on disk (no zombie
// hunting); the per-clip toast in loadClipIntoEditor surfaces that case.

async function probeVideoDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    let done = false;
    const finish = (d) => {
      if (done) return;
      done = true;
      try { URL.revokeObjectURL(url); } catch {}
      resolve(d);
    };
    v.onloadedmetadata = () => {
      const d = isFinite(v.duration) ? Math.round(v.duration) : 0;
      finish(d);
    };
    v.onerror = () => finish(0);
    setTimeout(() => finish(0), 4000);
    v.src = url;
  });
}

// Walk the save folder once and bucket every file we find. Returns
// { sidecarOrphans, videoOrphans } where sidecarOrphans are parsed
// sidecar objects (case A) and videoOrphans are { name, file } (case B).
async function findOrphansOnDisk() {
  const empty = { sidecarOrphans: [], videoOrphans: [] };
  if (!directoryHandle) return empty;
  const catalog = getClips();
  const knownBasenames = new Set(
    catalog.map(c => c.filename || '').filter(Boolean)
      .map(f => f.replace(/\.(webm|mp4)$/, ''))
  );

  const sidecarBasenames = new Set();
  const videoFiles = [];
  const sidecarOrphans = [];

  try {
    for await (const [name, handle] of directoryHandle.entries()) {
      if (handle.kind !== 'file') continue;
      if (name === 'catalog.json') continue; // exported aggregate, skip

      if (name.endsWith('.json')) {
        const basename = name.replace(/\.json$/, '');
        sidecarBasenames.add(basename);
        if (knownBasenames.has(basename)) continue;
        try {
          const file = await handle.getFile();
          const text = await file.text();
          const parsed = JSON.parse(text);
          if (parsed && parsed.id) sidecarOrphans.push(parsed);
        } catch {
          // Corrupt sidecar — let the video-orphan pass pick it up
          // from the .mp4/.webm sibling instead.
        }
        continue;
      }

      if (name.endsWith('.mp4') || name.endsWith('.webm')) {
        videoFiles.push({ name, handle });
        continue;
      }
    }
  } catch (e) {
    console.warn('[resync] could not scan folder:', e.message);
    return empty;
  }

  // Sleeve photos and YouTube thumbnails share a basename root with their
  // parent clip (e.g. `clip_xxx_front.jpg`, `clip_xxx_youtube.jpg`). They
  // are NOT standalone videos and must not be promoted to library tiles.
  const SLEEVE_SUFFIX_RE = /_(front|back|youtube)$/;

  const videoOrphans = [];
  for (const { name, handle } of videoFiles) {
    const basename = name.replace(/\.(webm|mp4)$/, '');
    if (SLEEVE_SUFFIX_RE.test(basename)) continue;
    if (knownBasenames.has(basename)) continue;
    if (sidecarBasenames.has(basename)) continue;
    try {
      const file = await handle.getFile();
      videoOrphans.push({ name, file });
    } catch {}
  }

  return { sidecarOrphans, videoOrphans };
}

async function checkLibraryResyncBanner() {
  const banner = document.getElementById('library-resync-banner');
  const countEl = document.getElementById('library-resync-count');
  if (!banner || !countEl) return;
  if (!directoryHandle) {
    banner.classList.add('hidden');
    return;
  }
  const { sidecarOrphans, videoOrphans } = await findOrphansOnDisk();
  const total = sidecarOrphans.length + videoOrphans.length;
  if (total === 0) {
    banner.classList.add('hidden');
    return;
  }
  countEl.textContent = String(total);
  banner.classList.remove('hidden');
}

// Convert an orphan video file into a catalog entry + sidecar. Title is
// derived from the filename so the user can recognize it; duration is
// probed from the file (best-effort) so the library tile shows the right
// thing. No thumbnail — opening the clip in the editor will give the user
// a chance to re-capture one if they want.
async function recoverVideoOrphan(name, file) {
  const basename = name.replace(/\.(webm|mp4)$/, '');
  const duration = await probeVideoDuration(file);
  // Friendlier title than the raw filename — strip the timestamp-y
  // prefix that generateFilename emits and fall back to the basename
  // if nothing readable remains.
  const friendly = basename.replace(/^vhsg[_-]?/i, '').replace(/[_-]+/g, ' ').trim();
  const title = friendly || basename;
  const entry = createClipEntry(
    title || 'Recovered clip',
    name,
    duration || 0,
    file.size || 0,
    0,
  );
  // Anchor the entry's timestamp to the file's mtime when available so
  // the library ordering matches when the file was actually written,
  // not when the user happened to click Resync.
  if (file.lastModified) {
    entry.date = new Date(file.lastModified).toISOString();
  }
  const ok = addClip(entry);
  if (!ok) return false;
  // Write a sidecar so we don't have to recover this same orphan again
  // next time. Best-effort — failure here is logged inside saveSidecarFiles
  // wrapper below.
  try {
    await saveSidecarFiles(directoryHandle, basename, entry);
  } catch (e) {
    console.warn('[resync] could not write sidecar for recovered orphan:', e);
  }
  return true;
}

async function runLibraryResync(btn) {
  if (!directoryHandle) {
    showInfoToast(
      'Pick your drive folder first',
      'VHS Garage needs to know where your recordings are. Use "Choose folder…" in the library to point at your drive folder, then try again.'
    );
    return;
  }
  const wasDisabled = btn ? btn.disabled : false;
  const wasLabel = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Scanning…';
  }
  try {
    const { sidecarOrphans, videoOrphans } = await findOrphansOnDisk();
    let added = 0;
    let failed = 0;
    for (const entry of sidecarOrphans) {
      // Re-add to catalog using the sidecar as-is; sidecars store the same
      // shape as the catalog entry (minus the heavy image fields).
      if (addClip(entry)) added++; else failed++;
    }
    for (const { name, file } of videoOrphans) {
      if (await recoverVideoOrphan(name, file)) added++; else failed++;
    }
    refreshLibrary();
    await checkLibraryResyncBanner();
    if (added > 0) {
      showInfoToast(
        `Added ${added} clip${added === 1 ? '' : 's'} to your library`,
        failed > 0
          ? `${failed} couldn't be added (catalog full). Try removing some older clips and rescanning.`
          : 'Your missing recordings are back. Click any tile to open.'
      );
    } else if (failed === 0) {
      showInfoToast(
        'Nothing to recover',
        "We didn't find any clips on your drive that aren't already in the library."
      );
    }
  } finally {
    if (btn) {
      btn.disabled = wasDisabled;
      btn.textContent = wasLabel || 'Resync';
    }
  }
}

// Library.js dispatches `catalog-save-failed` when a localStorage write
// hits an unrecoverable error (almost always quota exhaustion). Surfacing
// this is what fixes the "clip vanished" class of bug — the file is on
// disk, the user thinks the save worked, but the library never got the
// tile. Now they see a toast immediately and can rescan to recover.
function wireCatalogSaveFailureToast() {
  if (typeof window === 'undefined') return;
  let lastShownAt = 0;
  window.addEventListener('catalog-save-failed', (e) => {
    // Debounce — a single user action can trigger many saves
    // (addClip → updateClip → updateClip), don't stack five toasts.
    const now = Date.now();
    if (now - lastShownAt < 2000) return;
    lastShownAt = now;
    const reason = e?.detail?.reason;
    if (reason === 'quota') {
      showErrorToast(
        'Library storage full',
        "Your browser's storage limit is hit, so the latest clip didn't save into the library. " +
        "The video file itself is safe on your drive — click Rescan in the library footer to add it back."
      );
    } else {
      showErrorToast(
        "Couldn't update library",
        (e?.detail?.error || 'Unknown error') + '. Try clicking Rescan in the library footer.'
      );
    }
  });
}

function wireLibraryResync() {
  const btn = document.getElementById('library-resync-btn');
  if (btn) {
    btn.addEventListener('click', () => runLibraryResync(btn));
  }
  // Always-on rescan link in the library footer — gives Matt (and any
  // other non-technical user) a button to poke even when no banner is
  // visible. "I don't know what to do to get it working again" → click
  // this and we re-check the folder from scratch.
  const footerBtn = document.getElementById('library-rescan-footer');
  if (footerBtn) {
    footerBtn.addEventListener('click', () => runLibraryResync(footerBtn));
  }
}

// --- Char counters with enforcement ---
//
// Every input/textarea with `data-char-counter` + `data-char-max` gets a
// live count rendered into the matching `<p id="counter-...">`. Color
// flips yellow at 90%, red at 100% (which is also the maxlength so the
// browser blocks any further typing). Re-runs on input AND on programmatic
// .value changes (renderSuggestion, demoStreamText, applySuggestion, etc.)
// via a tiny refreshAllCharCounters() that the affected paths can call.

function refreshCharCounter(input) {
  if (!input) return;
  const counterId = input.dataset.charCounter;
  const max = parseInt(input.dataset.charMax, 10);
  if (!counterId || !max) return;
  const counterEl = document.getElementById(counterId);
  if (!counterEl) return;
  const len = (input.value || '').length;
  counterEl.textContent = `${len} / ${max}`;
  counterEl.classList.toggle('is-warn', len >= max * 0.9 && len < max);
  counterEl.classList.toggle('is-max', len >= max);
}

function refreshAllCharCounters() {
  document.querySelectorAll('[data-char-counter]').forEach(refreshCharCounter);
}

function wireCharCounters() {
  document.querySelectorAll('[data-char-counter]').forEach((input) => {
    input.addEventListener('input', () => refreshCharCounter(input));
    refreshCharCounter(input); // initial paint
  });
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

// Persist the user-picked YouTube thumbnail frame to disk as
// {basename}_youtube.jpg. The catalog copy in localStorage gets evicted
// under quota pressure (see HEAVY_FIELDS in library.js) — without a disk
// backup, the pick silently disappears on revisit and the upload sends
// nothing, letting YouTube pick a random frame. Disk is the durable
// source of truth, mirroring the sleeve photo pattern.
async function saveYtThumbnailToDisk(clipId, dataUrl) {
  if (!directoryHandle || !clipId || !dataUrl) return;
  const clips = getClips();
  const clip = clips.find(c => c.id === clipId);
  if (!clip || !clip.filename) return;
  const basename = clip.filename.replace(/\.(webm|mp4)$/, '');
  const fh = await directoryHandle.getFileHandle(`${basename}_youtube.jpg`, { create: true });
  const w = await fh.createWritable();
  const res = await fetch(dataUrl);
  await w.write(await res.blob());
  await w.close();
}

async function readYtThumbnailFromDisk(dirHandle, basename) {
  if (!dirHandle || !basename) return null;
  try {
    const fh = await dirHandle.getFileHandle(`${basename}_youtube.jpg`);
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

  // If trim mode is still active from a PREVIOUS clip, tear it down
  // before swapping in the new one. The trim panel attaches a
  // 'timeupdate' clamp listener that pauses + rewinds whenever
  // currentTime crosses [trimIn, trimOut] — and those values are
  // stuck on the old clip's range. Without this, opening a library
  // clip mid-trim left the clamp wired against stale boundaries:
  // scrubbing worked (no constraint on the scrub itself) but pressing
  // Play would start, timeupdate would fire, the clamp would see
  // currentTime > stale trimOut, and immediately pause + rewind to
  // stale trimIn. Looked exactly like "Play button does nothing."
  if (typeof exitTrimMode === 'function') exitTrimMode();
  // Same defensive cleanup for Shorts mode — its crop overlay + scoped
  // playback handler would otherwise leak across clip swaps.
  if (typeof exitShortsMode === 'function') exitShortsMode();

  // 1. Load the file from disk → blob URL for the playback preview.
  let url = '';
  if (clip.filename) {
    let fh = null;
    let openError = null;
    try {
      fh = await directoryHandle.getFileHandle(clip.filename);
    } catch (e) {
      openError = e;
    }

    // Auto-recovery: if the exact filename misses, try swapping the
    // extension (mp4 ↔ webm). This is the most common drift now that
    // Trim can output a different container than the source — if a
    // catalog entry was written before that fix landed, or a manual
    // rename happened outside the app, the file is RIGHT THERE under
    // a sibling extension. Found → silently update the catalog and
    // continue. Beats throwing up an alert.
    if (!fh) {
      const altName = clip.filename.endsWith('.mp4')
        ? clip.filename.replace(/\.mp4$/i, '.webm')
        : clip.filename.endsWith('.webm') ? clip.filename.replace(/\.webm$/i, '.mp4') : null;
      if (altName) {
        try {
          fh = await directoryHandle.getFileHandle(altName);
          console.info('[loadClip] auto-relinked extension', {
            from: clip.filename, to: altName, clipId,
          });
          updateClip(clipId, { filename: altName });
          clip.filename = altName;
          openError = null;
        } catch { /* fall through to the friendly error below */ }
      }
    }

    if (!fh) {
      // Surface the ACTUAL filename + error reason so the user can
      // tell us which clip is broken and we can tell them why. Old
      // message ("save folder may need to be re-selected") was
      // misleading — if the folder permission were broken, every clip
      // would fail, not just one. The real cause is almost always a
      // missing-or-renamed file on disk.
      const detail = (openError && openError.message) || 'unknown error';
      const errName = (openError && openError.name) || '';
      console.warn('[loadClip] could not open file', {
        filename: clip.filename, errName, error: detail, clipId,
      });
      showErrorToast(
        `Couldn't open "${clip.filename}"`,
        `${errName ? errName + ': ' : ''}${detail}. ` +
        `Most likely the file was renamed, moved, or deleted outside the app. ` +
        `If you revoked folder permission, click the directory name in the toolbar to re-grant access.`
      );
      return;
    }

    try {
      const file = await fh.getFile();
      url = URL.createObjectURL(file);
    } catch (e) {
      console.warn('[loadClip] file handle opened but getFile() failed', {
        filename: clip.filename, error: e.message, clipId,
      });
      showErrorToast(`Couldn't read "${clip.filename}"`, e.message);
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
  // Programmatic .value writes don't fire 'input', so the counters
  // attached via wireCharCounters never recompute. Force a refresh.
  if (typeof refreshAllCharCounters === 'function') refreshAllCharCounters();

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

  // 4b. Restore the picked YouTube thumbnail from disk if the catalog lost
  // it to a quota eviction (HEAVY_FIELDS in library.js evicts older clips'
  // ytThumbnailDataUrl when localStorage gets tight). Without this, the
  // picker re-generates fresh random frames on revisit, the upload sends
  // no thumbnail, and YouTube auto-picks a random frame instead of what
  // the user originally selected.
  if (clip.filename && directoryHandle && !clip.ytThumbnailDataUrl) {
    const baseForThumb = clip.filename.replace(/\.(webm|mp4)$/, '');
    const savedThumb = await readYtThumbnailFromDisk(directoryHandle, baseForThumb);
    if (savedThumb) {
      // Refill the catalog so renderGrid + the upload path see it again.
      // saveClips' quota-recovery may evict another older clip's heavy
      // field to make room — that one will self-heal the same way the
      // next time it's opened. Disk is the durable source of truth.
      const updates = { ytThumbnailDataUrl: savedThumb };
      if (!clip.thumbnail) updates.thumbnail = await shrinkDataUrlForCatalog(savedThumb);
      updateClip(clipId, updates);
    }
  }

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
  // Tracks the user's saved thumbnail pick for the active clip. Sourced
  // from catalog OR disk on every clip swap; updated immediately on
  // selectThumbnail click. THIS — not catalog.ytThumbnailDataUrl — is
  // what the highlight reads from. Decoupling matters because the
  // catalog field gets evicted under quota pressure (HEAVY_FIELDS in
  // library.js), so the catalog can lose the pick mid-session even
  // though the disk copy + on-screen state are intact. Matt's "thumb
  // selection works but doesn't highlight" bug was exactly that — the
  // catalog field went null after a save, the highlight check used
  // the catalog, the cell rendered with no border. Module-scope var
  // sidesteps the whole quota dance.
  let pickedThumb = null;

  function showState(state) {
    emptyState.classList.toggle('hidden', state !== 'empty');
    loadingState.classList.toggle('hidden', state !== 'loading');
    gridWrap.classList.toggle('hidden', state !== 'grid');
  }

  function renderGrid() {
    // Always render the saved pick as the first cell when one exists, so
    // re-opening a clip (which auto-generates 6 fresh random frames that
    // never match the saved one) doesn't make the highlight disappear and
    // look like the pick was lost. Refresh keeps regenerating the trailing
    // 6 — the saved cell stays put and stays highlighted until replaced.
    const cells = [];
    if (pickedThumb) cells.push(pickedThumb);
    for (const t of currentThumbnails) {
      if (t !== pickedThumb) cells.push(t);
    }

    grid.innerHTML = '';
    cells.forEach((dataUrl, i) => {
      const isSelected = dataUrl === pickedThumb;
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

    // Flip into grid state when at least the saved pick is present, so a
    // clip with a saved pick but no auto-gen yet still shows it instead
    // of the empty placeholder grid.
    if (cells.length > 0) showState('grid');
  }

  // Sync pickedThumb to whatever the active clip's saved thumb is —
  // catalog first (cheap), disk fallback (durable). Called by
  // resetThumbnailPicker when the clip changes. Async because the disk
  // read is async; safe to call without awaiting since renderGrid will
  // run again after autoGenerateThumbnails completes.
  async function syncPickedThumbForActiveClip() {
    pickedThumb = null;
    if (!lastClipId) return;
    const clips = getClips();
    const clip = clips.find(c => c.id === lastClipId);
    if (!clip) return;
    if (clip.ytThumbnailDataUrl) {
      pickedThumb = clip.ytThumbnailDataUrl;
      return;
    }
    if (clip.filename && directoryHandle) {
      const baseForThumb = clip.filename.replace(/\.(webm|mp4)$/, '');
      try {
        const fromDisk = await readYtThumbnailFromDisk(directoryHandle, baseForThumb);
        if (fromDisk) {
          pickedThumb = fromDisk;
          // Re-render in case auto-gen already finished without us.
          renderGrid();
        }
      } catch { /* no disk thumb, no pick */ }
    }
  }

  async function selectThumbnail(dataUrl) {
    if (!lastClipId) return;
    // Update the highlight IMMEDIATELY before any awaits — even if
    // the catalog write later trims this clip's heavy field under
    // quota, the on-screen highlight stays correct because pickedThumb
    // is the source of truth, not the catalog.
    pickedThumb = dataUrl;
    renderGrid();
    // ytThumbnailDataUrl is the full-res frame uploaded to YouTube; thumbnail
    // is the library-tile preview and has to stay tiny so the catalog fits in
    // localStorage. Both come from the same source frame so they stay in sync.
    const small = await shrinkDataUrlForCatalog(dataUrl);
    updateClip(lastClipId, { ytThumbnailDataUrl: dataUrl, thumbnail: small });
    // Mirror the full-res frame to disk so the pick survives a localStorage
    // quota eviction (catalog ytThumbnailDataUrl is in HEAVY_FIELDS). Without
    // this, opening an older clip after the catalog has filled up shows no
    // saved pick and the upload silently sends none — YouTube then auto-picks
    // a random frame, which is the bug Matt hit (Kurt Cobain → Anthony Kiedis).
    saveYtThumbnailToDisk(lastClipId, dataUrl).catch((e) => {
      console.warn('[thumb] disk save failed:', e.message);
    });
    refreshLibrary();
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
    pickedThumb = null;
    grid.innerHTML = '';
    showState('empty');
    // Sync the active clip's saved pick (catalog OR disk) into
    // pickedThumb so renderGrid puts it at top-left and highlights it
    // once auto-gen completes. Fire-and-forget — generate() will
    // re-render after frames arrive, picking up pickedThumb if the
    // disk read finished by then.
    syncPickedThumbForActiveClip().catch(() => {});
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
        // Suffix if the desired name collides with another clip's file —
        // autosave fires on every keystroke, so a user typing the same
        // title as another clip in the library would otherwise silently
        // overwrite that clip's video + sidecars. If the unique-pick
        // hands us back our own current name (no work needed), skip the
        // rename branch but still let the sidecar save below run.
        const safeDesired = await pickUniqueFilename(desired, { allowSelf: clip.filename });
        if (safeDesired === clip.filename) {
          // Fall through — sidecar save still happens.
        } else {
        const oldBase = clip.filename.replace(/\.(webm|mp4)$/, '');
        const renamed = await renameFileOnDisk(clip.filename, safeDesired);
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
        }  // close: else (safeDesired !== clip.filename)
      }
      const basename = clip.filename.replace(/\.(webm|mp4)$/, '');
      saveSidecarFiles(directoryHandle, basename, clip).catch(() => {});
      // Defensive: also (re)write the sleeve JPGs against this clip's
      // basename. Recording-stop already does this once, but if the
      // user takes/edits sleeve photos AFTER recording (or we missed
      // them on the original stop for any reason), the autosave path
      // is the catch-all. saveSleevePhotos no-ops gracefully when the
      // sleeve module has no front/back data, so this is cheap.
      saveSleevePhotos(directoryHandle, basename).catch(() => {});
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
    // 'metadata' instead of 'auto' — long videos (Matt's hour-plus
    // bootlegs) blew up under 'auto' because it prefetched the entire
    // file into memory before loadedmetadata fired. metadata-only
    // pulls just the header so seeks still work.
    v.preload = 'metadata';
    v.src = blobUrl;

    // Overall failsafe — if metadata never loads (corrupt header,
    // browser stuck), bail rather than hang the picker forever.
    const metadataTimeout = setTimeout(() => {
      reject(new Error('Video metadata took too long to load'));
    }, 15000);

    v.addEventListener('loadedmetadata', async () => {
      clearTimeout(metadataTimeout);
      let duration = v.duration;
      // Some long WebM files report Infinity until you seek past the
      // end (it's a known Chrome quirk with files written by
      // MediaRecorder where the duration metadata wasn't finalized).
      // Workaround: seek way past the end, wait for currentTime to
      // settle to the actual duration, then use that.
      if (!isFinite(duration) || duration <= 0) {
        try {
          await new Promise((r, rej) => {
            const t = setTimeout(() => rej(new Error('duration probe timeout')), 5000);
            const onUpd = () => {
              if (isFinite(v.duration) && v.duration > 0) {
                clearTimeout(t);
                v.removeEventListener('durationchange', onUpd);
                r();
              }
            };
            v.addEventListener('durationchange', onUpd);
            try { v.currentTime = 1e10; } catch {}
          });
          duration = v.duration;
        } catch (e) {
          reject(new Error('Could not read video duration: ' + e.message));
          return;
        }
      }
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

      // Per-seek timeout — long videos can take seconds to demux/decode
      // up to a random offset deep in the file. If a seek hangs (or the
      // browser silently fails to fire 'seeked'), give up on THAT
      // frame and move on rather than locking the picker forever.
      // Aggregate timeout (count * SEEK_TIMEOUT) caps the total wait
      // around 30s for a 6-frame run, which is the worst case.
      const SEEK_TIMEOUT_MS = 5000;
      const out = [];
      for (const t of offsets) {
        try {
          await new Promise((r, rej) => {
            const failsafe = setTimeout(() => {
              cleanup();
              rej(new Error('seek timeout after ' + SEEK_TIMEOUT_MS + 'ms'));
            }, SEEK_TIMEOUT_MS);
            const onSeek = () => { cleanup(); r(); };
            const onErr = () => { cleanup(); rej(new Error('seek error')); };
            const cleanup = () => {
              clearTimeout(failsafe);
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
      // If we got at least one frame, return what we have rather than
      // failing the whole batch. Better to show 3 frames than 0.
      if (out.length === 0) {
        reject(new Error('No frames could be extracted from this video'));
      } else {
        resolve(out);
      }
    });

    v.addEventListener('error', () => {
      clearTimeout(metadataTimeout);
      reject(new Error('Video failed to load for thumbnail extraction'));
    });
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
  // Match BOTH the new format (with _HHMM_HEX suffix) and the legacy
  // format (just _HHMM, no hex) so renames work on clips recorded
  // before the hex suffix landed. New rename always emits the new
  // format with hex preserved if present, or freshly generated if not.
  const newFmt = oldFilename.match(/^(.+?)_(\d{4}-\d{2}-\d{2})_(\d{4})_([0-9a-f]{4})\.(webm|mp4)$/i);
  const legacy = !newFmt && oldFilename.match(/^(.+?)_(\d{4}-\d{2}-\d{2})_(\d{4})\.(webm|mp4)$/);
  const m = newFmt || legacy;
  if (!m) return null;
  const date = m[2];
  const time = m[3];
  const hex = newFmt
    ? newFmt[4].toLowerCase()
    : Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  const ext = newFmt ? newFmt[5] : legacy[4];
  const trimmed = (newTitle || '').trim();
  if (nameFormat === 'timestamp' || !trimmed) {
    return `VHS_Capture_${date}_${time}_${hex}.${ext}`;
  }
  const sanitized = trimmed.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '_');
  return `${sanitized}_${date}_${time}_${hex}.${ext}`;
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
    `${oldBasename}_youtube.jpg`,
  ];
  const targets = [
    `${newBasename}.json`,
    `${newBasename}.youtube.txt`,
    `${newBasename}_front.jpg`,
    `${newBasename}_back.jpg`,
    `${newBasename}_youtube.jpg`,
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
        // Same collision check as autosave — if another clip is already
        // using `desired`, suffix instead of clobbering. Skip the rename
        // if pickUniqueFilename hands us back our own current name (i.e.
        // no work to do); the sidecar save below STILL needs to run.
        const safeDesired = await pickUniqueFilename(desired, { allowSelf: clip.filename });
        if (safeDesired !== clip.filename) {
          const oldBase = clip.filename.replace(/\.(webm|mp4)$/, '');
          const renamed = await renameFileOnDisk(clip.filename, safeDesired);
          if (renamed) {
            updateClip(lastClipId, { filename: renamed });
            await renameSiblings(oldBase, renamed.replace(/\.(webm|mp4)$/, ''));
            // Re-read the catalog so subsequent saves use the new filename.
            clips = getClips();
            clip = clips.find(c => c.id === lastClipId);
          }
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
    refreshAllCharCounters();
  });
}

// --- YouTube OAuth (PKCE, browser-stored refresh token) ---

const YT_REFRESH_KEY = 'yt_refresh_token';
const YT_CHANNEL_KEY = 'yt_channel';
const YT_PKCE_KEY = 'yt_pkce_verifier';
const YT_PENDING_PUBLISH_KEY = 'yt_pending_publish_clip_id';
// `openid email` so the bridge edge function can verify a user's
// identity via Google's tokeninfo endpoint and check the allowlist.
//
// `youtube.force-ssl` was added later for playlist support: the
// bridge needs WRITE access to add freshly-uploaded videos into the
// VHS Garage channel's playlists (playlistItems.insert). upload +
// readonly alone can list playlists but not modify them. The bridge
// uses ITS OWN stored token for the actual playlist add, so even
// non-allowlisted users granting force-ssl don't gain any new
// powers — it's just along for the ride. One-time consent re-prompt
// for existing users on next sign-in.
const YT_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
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
  // Drop the cached whoami response too — otherwise the next user signing
  // in on this browser would briefly see the previous user's destination
  // banner (allowlisted vs not).
  clearWhoamiCache();
  currentToken = null;
  // Hide the destination banner immediately so the empty state doesn't
  // briefly show stale info.
  const destEl = document.getElementById('yt-pub-destination');
  if (destEl) destEl.classList.add('hidden');
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

// "Uploading to" destination banner.
//
// Now that bridge auth is retired (Matt has Manager access on the VHS
// Garage brand channel, so the brand shows up directly in Google's
// channel chooser), there's no special routing decision to make.
// Whatever channel the user OAuth'd as IS where the upload lands.
// We just show the channel name + handle + thumbnail.
//
// Always REVEALS the banner — never hides. The publishStateForClip
// caller already gates this function behind a refresh-token check
// (shows the sign-in panel when not signed in), so by the time we
// get here the user is signed in and the banner should always be
// visible. Even when ytGetChannel returns null (transient localStorage
// hiccup, fresh sign-in race), we show a fallback "Your channel"
// label so the wrapper stays visible — critical because the Sign
// out button lives inside this banner.
async function refreshDestinationBanner() {
  const destEl = document.getElementById('yt-pub-destination');
  if (!destEl) return;
  const nameEl = document.getElementById('yt-pub-destination-name');
  const handleEl = document.getElementById('yt-pub-destination-handle');
  const thumbEl = document.getElementById('yt-pub-destination-thumb');

  const channel = ytGetChannel();
  if (channel) {
    if (nameEl) nameEl.textContent = channel.title || 'Your channel';
    if (handleEl) handleEl.textContent = channel.handle
      ? ' ' + (channel.handle.startsWith('@') ? channel.handle : '@' + channel.handle)
      : '';
    if (thumbEl) { thumbEl.src = channel.thumbnail || ''; thumbEl.alt = channel.title || 'Your channel'; }
  } else {
    if (nameEl) nameEl.textContent = 'Your channel';
    if (handleEl) handleEl.textContent = '';
    if (thumbEl) { thumbEl.src = ''; thumbEl.alt = ''; }
  }
  destEl.classList.remove('hidden');
}

// Sign-out / token-clear paths call this so the next session starts
// without stale playlist cache from a previous user.
function clearWhoamiCache() {
  cachedPlaylists = null;
  cachedPlaylistsToken = null;
}

// ---------------------------------------------------------------------------
// Playlists (direct to YouTube)
// ---------------------------------------------------------------------------
//
// Pre-bridge-removal this went through the bridge edge function (which
// used the bridge's stored token to talk to VHS Garage's playlists).
// Now that Matt has Manager access on the brand channel, the user's
// OWN OAuth token is brand-scoped when they pick VHS Garage at the
// channel chooser — so we call YouTube directly.
//
// We request `youtube.force-ssl` in YT_SCOPES, which covers both
// reading and modifying playlists. Cached per access token so we
// don't re-hit YouTube on every panel open; cleared by
// clearWhoamiCache (sign-out / token rotate).
let cachedPlaylists = null;        // [{id, title, itemCount}, ...] or [] when none
let cachedPlaylistsToken = null;
let inflightPlaylists = null;

// Returns { status, playlists, error? }:
//   'ok'         — playlists is the array (possibly empty)
//   'error'      — YouTube returned non-OK / network / parse failure
//   'no-token'   — client doesn't have an access token yet
async function fetchUserPlaylists() {
  const token = currentToken || await fetchAccessTokenInBackground();
  if (!token) {
    console.info('[playlists] no access token yet — will retry on next panel open');
    return { status: 'no-token', playlists: [] };
  }
  if (cachedPlaylists !== null && cachedPlaylistsToken === token) {
    console.info('[playlists] cache hit (', cachedPlaylists.length, 'items, hard-refresh to bust)');
    return { status: 'ok', playlists: cachedPlaylists };
  }
  if (inflightPlaylists) return inflightPlaylists;

  console.info('[playlists] fetching from YouTube…');
  inflightPlaylists = (async () => {
    try {
      const res = await fetch(
        'https://www.googleapis.com/youtube/v3/playlists?mine=true&part=snippet,contentDetails&maxResults=50',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.warn('[playlists] YouTube returned', res.status, detail.slice(0, 200));
        cachedPlaylists = [];
        cachedPlaylistsToken = token;
        return { status: 'error', playlists: [], error: `HTTP ${res.status}` };
      }
      const data = await res.json();
      // Sort by creation date DESC and take the 3 most recent — same
      // cap the bridge used to enforce server-side. Plenty for a
      // checkbox list; if we want more later it's a one-line bump.
      const PLAYLIST_LIMIT = 3;
      const items = (data.items || [])
        .map((p) => ({
          id: p.id,
          title: p.snippet?.title || '(untitled)',
          itemCount: p.contentDetails?.itemCount || 0,
          publishedAt: p.snippet?.publishedAt || '',
        }))
        .sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''))
        .slice(0, PLAYLIST_LIMIT);
      cachedPlaylists = items;
      cachedPlaylistsToken = token;
      console.info('[playlists] got', items.length, 'playlist(s):',
        items.map((p) => `"${p.title}" (${p.itemCount} videos)`).join(', ') || '(empty list — channel has no playlists)');
      return { status: 'ok', playlists: items };
    } catch (e) {
      console.warn('[playlists] list threw:', e.message);
      return { status: 'error', playlists: [], error: e.message };
    }
  })();
  try { return await inflightPlaylists; }
  finally { inflightPlaylists = null; }
}

// Render the playlists section based on the structured result from
// fetchUserPlaylists. Three visible states:
//   · checkboxes for each playlist (status=ok with items)
//   · "No playlists yet on this channel" (status=ok with empty array —
//     surfaces the feature so users with 0 playlists know it's alive
//     and just needs them to create some on YouTube)
//   · entirely hidden (any non-ok status — non-allowlisted user, bridge
//     token expired, network/auth errors)
// Idempotent — safe to call on every publish panel open. List order
// matches the bridge response (sorted snippet.publishedAt DESC).
function populatePlaylistsUI(result) {
  const wrapper = document.getElementById('yt-pub-playlists');
  const list = document.getElementById('yt-pub-playlists-list');
  if (!wrapper || !list) return;

  if (!result || result.status !== 'ok') {
    wrapper.classList.add('hidden');
    list.innerHTML = '';
    return;
  }

  const playlists = result.playlists || [];
  if (playlists.length === 0) {
    list.innerHTML = `<p class="text-white/40 text-[11px] italic">No playlists found on this channel yet. Create some on YouTube and refresh.</p>`;
    wrapper.classList.remove('hidden');
    return;
  }

  // Render fresh each time. Preserves no per-checkbox state across panel
  // opens (intentional — the user picks playlists fresh per upload).
  list.innerHTML = playlists.map((p) => `
    <label class="flex items-center gap-2 text-[11px] text-white/70 hover:text-white/90 cursor-pointer">
      <input type="checkbox" data-playlist-id="${escapeHtml(p.id)}"
             class="accent-red-600 cursor-pointer" />
      <span class="flex-1 truncate">${escapeHtml(p.title)}</span>
      <span class="text-white/30 tabular-nums">${p.itemCount || 0}</span>
    </label>
  `).join('');
  wrapper.classList.remove('hidden');
}

// Read which playlist boxes are currently checked. Returns an array of
// playlist IDs in DOM order. Snapshot at the moment of upload click — once
// an item is in the upload queue, the user can navigate around without
// changing what playlists it'll land in.
function getCheckedPlaylistIds() {
  const list = document.getElementById('yt-pub-playlists-list');
  if (!list) return [];
  return Array.from(list.querySelectorAll('input[type="checkbox"]:checked'))
    .map((el) => el.dataset.playlistId)
    .filter(Boolean);
}

// --- Upload queue + toast notifications ---
//
// Background non-blocking upload pipeline with a stack of toast cards in the
// bottom-right. Clicking Upload in the publish panel:
//   1. Snapshots the form state (title/desc/tags/privacy) into a queue item
//   2. Spawns a toast card showing progress
//   3. The first toast in a fresh interface triggers a 3-2-1 countdown.
//      On completion the editor wipes the per-clip fields (title /
//      description / tags) and goes back to live-feed-ready — but KEEPS
//      tape-level info + sleeves, since most users capture many clips
//      from one tape per sitting. The "Reset everything" link in the
//      countdown row is the opt-in for the rarer full wipe (use when
//      starting a new tape).
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

function enqueueUpload(clipId, token, playlistIdsOverride) {
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
    playlistIds: Array.isArray(playlistIdsOverride) ? playlistIdsOverride : getCheckedPlaylistIds(),
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

    // Proxy the resumable-upload init through our edge function so
    // CORS can't mask the real YouTube error (e.g. 429 responses from
    // Google omit Access-Control-Allow-Origin, turning a rate-limit
    // into a misleading "Failed to fetch"). The edge function retries
    // transient 429s with backoff and relays the real status.
    let uploadUrl;
    let initRes;
    try {
      initRes = await fetch('/api/youtube-publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'init-upload',
          accessToken: item.token,
          uploadMeta,
          contentType,
          contentLength: file.size,
          refreshToken: (typeof ytGetRefreshToken === 'function' ? ytGetRefreshToken() : null),
        }),
      });
    } catch (e) {
      e.uploadStage = 'init';
      throw e;
    }
    const initData = await initRes.json().catch(() => ({}));
    if (!initRes.ok || !initData.uploadUrl) {
      const ytErr = initData.youtubeError || {};
      const httpStatus = initData.httpStatus || initRes.status;
      const parsed = parseYouTubeError(ytErr, httpStatus);
      console.warn('[upload] init failed:', parsed.reason || httpStatus, parsed.apiMessage);
      const err = new Error(parsed.display);
      err.uploadStage = 'init';
      err.httpStatus = httpStatus;
      err.youtubeReason = parsed.reason || null;
      if (parsed.reason === 'uploadLimitExceeded') err.uploadLimitExceeded = true;
      throw err;
    }
    uploadUrl = initData.uploadUrl;

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

      // runSuccess — invoked once we have a parsed video resource from
      // YouTube, whether that came from the normal xhr.load response or
      // from the recovery status query below. All post-upload side
      // effects live here: catalog update, counter bump, thumbnail PUT,
      // upload_logs insert, playlist-item adds.
      const runSuccess = (result) => {
        item.ytUrl = 'https://youtube.com/watch?v=' + result.id;
        updateClip(item.clipId, { youtubeUrl: item.ytUrl, youtubeId: result.id });
        // Bump the manual upload counter (see UPLOAD_COUNT_KEY).
        // Counts both bridge AND direct uploads — for the typical
        // single-channel user this is the right number; for someone
        // straddling two channels the counter slightly over-counts
        // either side, which is fine for a "rough where am I"
        // indicator. User resets explicitly when they hit the cap.
        incrementUploadCount();
        // Fire-and-forget thumbnail upload. If the video went via the
        // bridge, the thumbnail must too — otherwise it'd attempt a
        // thumbnails.set on a videoId that belongs to the bridge
        // account using the user's own token, which 403s.
        //
        // The catalog ytThumbnailDataUrl can be missing here even when
        // the user picked one earlier — HEAVY_FIELDS evicts it under
        // localStorage pressure, which is exactly what happens to older
        // clips in a multi-upload batch. Fall back to {basename}_youtube.jpg
        // on disk so the originally-picked frame still gets uploaded
        // instead of letting YouTube auto-pick a random one.
        const clipsAfter = getClips();
        const clipAfter = clipsAfter.find(c => c.id === item.clipId);
        (async () => {
          if (!clipAfter) return;
          let thumbDataUrl = clipAfter.ytThumbnailDataUrl;
          if (!thumbDataUrl && clipAfter.filename && directoryHandle) {
            const baseForThumb = clipAfter.filename.replace(/\.(webm|mp4)$/, '');
            thumbDataUrl = await readYtThumbnailFromDisk(directoryHandle, baseForThumb);
          }
          if (thumbDataUrl) {
            uploadYouTubeThumbnail(result.id, item.token, thumbDataUrl)
              .catch((e) => console.warn('[upload] thumbnail failed:', e.message));
          }
        })();
        // Centralized upload log — every successful upload gets a row
        // in the upload_logs table. Lives in a separate Node function
        // because @netlify/database is Node-only (Edge runs Deno + can't
        // import the package). Fire-and-forget — a network hiccup here
        // shouldn't make the user think their YouTube upload failed
        // (it already succeeded — we're just logging).
        if (clipAfter) {
          const ch = ytGetChannel();
          fetch('/.netlify/functions/log-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              accessToken: item.token,
              videoId: result.id,
              videoUrl: item.ytUrl,
              visibility: item.snippet?.privacyStatus || null,
              channelHandle: ch?.handle || null,
              clientClipId: clipAfter.id,
              title: clipAfter.title || null,
              description: clipAfter.description || null,
              tags: clipAfter.tags || null,
              durationSeconds: clipAfter.duration || 0,
              byteSize: clipAfter.fileSize || 0,
              mimeType: contentType,
              year: clipAfter.year || null,
              tapeTitle: clipAfter.tape || null,
              distributor: clipAfter.distributor || null,
              tapeLength: clipAfter.tapeLength || null,
              recordingSpeed: clipAfter.recordingSpeed || null,
              condition: clipAfter.condition || null,
              cassetteNotes: clipAfter.cassetteNotes || null,
              aiModel: typeof getAiModel === 'function' ? getAiModel() : null,
            }),
          }).catch(() => {});
        }
        // Add the new video to each playlist the user checked at
        // queue-time. Direct call to YouTube — the user's OAuth
        // token has youtube.force-ssl scope which covers playlist
        // writes. Fire-and-forget per playlist (parallel); the add
        // operation isn't critical to the user-facing success state.
        if (Array.isArray(item.playlistIds) && item.playlistIds.length > 0) {
          for (const playlistId of item.playlistIds) {
            fetch('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${item.token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                snippet: {
                  playlistId,
                  resourceId: { kind: 'youtube#video', videoId: result.id },
                },
              }),
            }).then((res) => {
              if (!res.ok) {
                console.warn('[upload] playlistItems.insert failed', { status: res.status, playlistId, videoId: result.id });
              }
            }).catch((e) => {
              console.warn('[upload] add-to-playlist threw:', e.message, { playlistId });
            });
          }
        }
        resolve();
      };

      // recoverOrReject — when the PUT's response was lost to the browser
      // (CORS-dropped 200, transient network glitch, unparseable body),
      // ask YouTube via the edge function whether the upload actually
      // finalized server-side. The original failure mode this protects
      // against: progress reaches 100%, YouTube ingests every byte and
      // returns 200 + the video resource, but the response carries no
      // Access-Control-Allow-Origin (because init went server-to-server),
      // so the browser blocks the body, xhr.error fires, and the user
      // sees "upload failed" while the video sits on the channel with no
      // thumbnail, no playlist membership, and no upload_logs row.
      // The status query runs server-side so the same CORS problem
      // doesn't bite us a second time.
      const recoverOrReject = async (fallbackErr) => {
        try {
          const recRes = await fetch('/api/youtube-publish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'status-upload',
              uploadUrl,
              contentLength: file.size,
              accessToken: item.token,
            }),
          });
          const recData = await recRes.json().catch(() => ({}));
          if (recRes.ok && recData.finalized && recData.video && recData.video.id) {
            console.warn('[upload] recovered lost response via status query, videoId=' + recData.video.id);
            runSuccess(recData.video);
            return;
          }
          console.warn('[upload] recovery query says not finalized:', recData);
        } catch (e) {
          console.warn('[upload] recovery query threw:', e.message);
        }
        reject(fallbackErr);
      };

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          let result = null;
          try {
            result = JSON.parse(xhr.responseText);
          } catch (e) {
            const err = new Error('Upload succeeded but response was unparseable.');
            err.uploadStage = 'parse';
            err.httpStatus = xhr.status;
            recoverOrReject(err);
            return;
          }
          if (!result || !result.id) {
            const err = new Error('Upload succeeded but response had no video ID.');
            err.uploadStage = 'parse';
            err.httpStatus = xhr.status;
            recoverOrReject(err);
            return;
          }
          runSuccess(result);
        } else {
          const parsed = parseYouTubeError(xhr.responseText, xhr.status);
          console.warn('[upload] PUT failed:', parsed.reason || xhr.status, parsed.apiMessage);
          const err = new Error(parsed.display);
          err.uploadStage = 'put';
          err.httpStatus = xhr.status;
          err.youtubeReason = parsed.reason || null;
          if (parsed.reason === 'uploadLimitExceeded') err.uploadLimitExceeded = true;
          // Don't try recovery on a real non-2xx — YouTube actively
          // refused, so there's nothing to recover.
          reject(err);
        }
      });
      xhr.addEventListener('error', () => {
        const err = new Error('Network error during upload. Check your connection and click retry.');
        err.uploadStage = 'put';
        recoverOrReject(err);
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
    // Bare-network TypeError from fetch() means the browser never got
    // a response — Chromium: "Failed to fetch"; Firefox: "NetworkError
    // when attempting to fetch resource."; Safari: "Load failed". The
    // raw browser string is useless to non-technical users, so we
    // translate it into something they can actually act on. Anything
    // with a real headline (parseYouTubeError display, "Network error
    // during upload. Check your connection…", etc.) passes through.
    const msg = e?.message || '';
    const isBareNetwork = e?.name === 'TypeError' && (
      /failed to fetch/i.test(msg) ||
      /networkerror/i.test(msg) ||
      /^load failed$/i.test(msg)
    );
    item.errorMsg = isBareNetwork
      ? "Couldn't reach YouTube. Check your internet connection (Wi-Fi, VPN, or an ad-blocker can block googleapis.com) and click Retry."
      : (msg || 'Upload failed.');
    item.xhr = null;
    // Auto-reset the manual upload counter when YouTube refuses with
    // uploadLimitExceeded. The error itself IS the calibration moment
    // — surfacing a button to ask "did you really hit the limit?" was
    // redundant, since YouTube already told us so. Counter starts
    // back at 0; the next successful upload bumps it to 1, giving
    // the user a fresh "Uploaded today" running total against the cap.
    if (e.uploadLimitExceeded) resetUploadCount();
    // Fire-and-forget failure beacon → upload_failures table. Without
    // this we have no server-side visibility into errors, because the
    // failing init fetch goes browser → googleapis.com and never
    // touches our infra. Wrap the whole thing in a try so a beacon
    // bug can't mask the original failure.
    try {
      const clipsForFailure = getClips();
      const clipForFailure = clipsForFailure.find(c => c.id === item.clipId);
      const failureMime = clipForFailure?.filename?.endsWith('.webm')
        ? 'video/webm'
        : clipForFailure?.filename?.endsWith('.mp4')
          ? 'video/mp4'
          : null;
      fetch('/.netlify/functions/log-upload-failure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: item.token || null,
          clientClipId: item.clipId || null,
          clipTitle: clipForFailure?.title || item.title || null,
          clipByteSize: clipForFailure?.fileSize || null,
          clipDurationSeconds: clipForFailure?.duration || null,
          clipMimeType: failureMime,
          stage: e.uploadStage || (isBareNetwork ? 'init' : 'unknown'),
          httpStatus: e.httpStatus ?? null,
          youtubeReason: e.youtubeReason ?? null,
          errorName: e.name || null,
          errorMessage: msg || null,
          navigatorOnline: typeof navigator !== 'undefined' ? navigator.onLine : null,
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        }),
      }).catch(() => {});
    } catch (beaconErr) {
      console.warn('[upload] failure beacon threw:', beaconErr.message);
    }
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
// if the user clicks the toast action link) we reset the editor for the next
// recording. Default reset KEEPS the tape-level info + sleeves (the user is
// usually capturing many clips from the same tape in one sitting); only
// title/description/tags wipe so the next recording starts with a clean
// per-clip slate. The action link is the opt-in for the rarer "this was
// the last clip from this tape" full wipe.
// Bumped from 3 → 5 seconds per Matt's feedback. Three seconds was
// too short to read the row + click a button before it auto-fired.
const COUNTDOWN_SECONDS = 5;

function startCountdownForItem(item) {
  uploadQueue.countdownItemId = item.id;
  let n = COUNTDOWN_SECONDS;
  renderToast(item);
  const tick = () => {
    n -= 1;
    if (n > 0) {
      const numEl = document.querySelector(`#toast-${item.id} [data-countdown-num]`);
      if (numEl) numEl.textContent = String(n);
      countdownTimerId = setTimeout(tick, 1000);
    } else {
      // Countdown elapsed → clip-only wipe (default keepTapeInfo: true).
      countdownTimerId = null;
      uploadQueue.countdownItemId = null;
      renderToast(item); // strips the countdown row
      clearClipForNewCapture();
    }
  };
  countdownTimerId = setTimeout(tick, 1000);
}

// Toast action: "Keep tape info" — explicit confirmation of the
// default reset path (clip-only wipe). User clicked it to apply the
// reset NOW instead of waiting out the countdown. Same effect as
// letting the countdown finish, just faster.
function endCountdownKeepingTape(item) {
  if (uploadQueue.countdownItemId !== item.id) return;
  if (countdownTimerId) {
    clearTimeout(countdownTimerId);
    countdownTimerId = null;
  }
  uploadQueue.countdownItemId = null;
  renderToast(item); // strips the countdown row
  clearClipForNewCapture();
}

// Toast action: "Reset everything" — opt-in for the full wipe (clip
// fields + tape-level fields + sleeves). Used when the user just
// finished the LAST clip from a tape and is about to swap tapes.
function endCountdownWithFullWipe(item) {
  if (uploadQueue.countdownItemId !== item.id) return;
  if (countdownTimerId) {
    clearTimeout(countdownTimerId);
    countdownTimerId = null;
  }
  uploadQueue.countdownItemId = null;
  renderToast(item); // strips the countdown row
  clearClipForNewCapture({ keepTapeInfo: false });
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
      <div class="toast-meta-row" style="flex-direction:column;align-items:stretch;gap:6px;">
        <span style="text-align:center;">Resetting in <span data-countdown-num>${COUNTDOWN_SECONDS}</span>s…</span>
        <div style="display:flex;gap:6px;">
          <button class="toast-action-btn toast-action-btn--keep" data-action="keep-tape" title="Apply the default reset now (keeps tape info + sleeve photos)" style="flex:1;padding:6px 10px;border:1px solid rgba(255,255,255,0.3);background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.85);font-size:10px;text-transform:uppercase;letter-spacing:0.05em;cursor:pointer;font-family:'VCR',monospace;">Keep tape info</button>
          <button class="toast-action-btn toast-action-btn--reset" data-action="wipe-all" title="Also clear tape info + sleeve photos (use when starting a new tape)" style="flex:1;padding:6px 10px;border:1px solid rgba(220,38,38,0.5);background:rgba(220,38,38,0.15);color:rgba(248,113,113,0.95);font-size:10px;text-transform:uppercase;letter-spacing:0.05em;cursor:pointer;font-family:'VCR',monospace;">Reset everything</button>
        </div>
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
      else if (action === 'keep-tape') endCountdownKeepingTape(item);
      else if (action === 'wipe-all') endCountdownWithFullWipe(item);
    };
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Non-blocking error toast — same red-border styling as upload-failure
// toasts but not tied to the upload queue. Use for any "thing went
// wrong, user should know but we don't want to block the tab" case.
//
// Replaces the native alert() pattern. alert() blocks the entire tab
// until dismissed AND can land off-screen / hidden in PWA mode (Matt's
// setup) where the user might not see it — manifesting as "the app
// is frozen completely." This toast appears in the bottom-right stack
// alongside upload toasts, persists until the X is clicked, and lets
// the user keep using the app while it's there.
function showErrorToast(title, message) {
  return showSimpleToast(title, message, { kind: 'error' });
}

function showInfoToast(title, message) {
  return showSimpleToast(title, message, { kind: 'info' });
}

// Lightweight one-shot toast — distinct from the upload-pipeline toasts
// in renderToastItem, which carry state machines for retries and YouTube
// links. This one is fire-and-forget: title + body + close button.
function showSimpleToast(title, message, { kind = 'info' } = {}) {
  const stack = document.getElementById('toast-stack');
  if (!stack) {
    alert(`${title}\n\n${message}`);
    return;
  }
  const id = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const card = document.createElement('div');
  card.id = 'toast-' + id;
  card.className = 'toast-card' + (kind === 'error' ? ' is-error' : kind === 'success' ? ' is-success' : '');
  const stateLabel = kind === 'error' ? '✗ Error' : kind === 'success' ? '✓ Done' : 'Info';
  card.innerHTML = `
    <div class="toast-title-row">
      <span class="toast-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
      <span class="toast-state-label">${stateLabel}</span>
      <button class="toast-close-btn" data-action="close" title="Dismiss">×</button>
    </div>
    <p class="toast-error-msg">${escapeHtml(message)}</p>
  `;
  stack.appendChild(card);
  requestAnimationFrame(() => card.classList.add('is-visible'));
  card.querySelector('[data-action="close"]').addEventListener('click', () => {
    card.classList.remove('is-visible');
    setTimeout(() => card.remove(), 200);
  });
  // Auto-dismiss info/success after 8s so the stack doesn't pile up;
  // errors stick around until the user closes them.
  if (kind !== 'error') {
    setTimeout(() => {
      if (!card.isConnected) return;
      card.classList.remove('is-visible');
      setTimeout(() => card.remove(), 200);
    }, 8000);
  }
}

// Reset the editor back to "ready to record" state. Runs at the end of the
// 3-2-1 countdown OR immediately when the user clicks the toast action.
//   keepTapeInfo: true (DEFAULT)
//                       → wipe ONLY clip-specific fields (title, description,
//                         tags); keep year, distributor, format, speed,
//                         condition, cassette notes, AND sleeve photos.
//                         This matches the actual usage pattern: a user
//                         captures many clips from the SAME tape in one
//                         sitting, so the sleeve + tape-level info should
//                         persist between recordings. The reset-info-btn
//                         in the sidebar (× Reset info) is the explicit
//                         "starting a new tape" wipe.
//   keepTapeInfo: false → full wipe (also clears tape-level fields + sleeves).
//                         Available via the "Reset everything" link in the
//                         post-upload toast countdown.
function clearClipForNewCapture({ keepTapeInfo = true } = {}) {
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

  // Always reset the thumbnail picker too — the picked thumb belongs
  // to the just-uploaded clip, NOT to whatever the user records next.
  // Without this, the next recording inherits the previous clip's
  // pick visually until the user clicks somewhere else. The auto-gen
  // step on the next recording will fill the grid with that clip's
  // own random frames; resetThumbnailPicker just wipes the now-stale
  // highlight and currentThumbnails so the transition is clean.
  if (typeof resetThumbnailPicker === 'function') {
    try { resetThumbnailPicker(); } catch {}
  }

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
  // SYNTHETIC reason. YouTube returns rateLimitExceeded for BOTH true
  // short-window throttles AND project-level daily upload caps; the
  // message text is the only way to tell. parseYouTubeError promotes
  // matching messages to this reason so users get accurate guidance.
  projectQuotaExceeded:
    "Project-level YouTube API quota exhausted for the day (the OAuth project's \"Video Uploads per day\" cap — separate from the per-channel 50/day limit). Resets at midnight Pacific. Permanent fix: request a quota increase at console.cloud.google.com → APIs & Services → YouTube Data API v3 → Quotas.",
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
  let reason = errObj && Array.isArray(errObj.errors) && errObj.errors[0]
    ? errObj.errors[0].reason
    : null;
  const apiMessage = (errObj && errObj.message) || (errObj && errObj.errors && errObj.errors[0] && errObj.errors[0].message) || '';

  // Disambiguate rateLimitExceeded — YouTube uses the same reason code
  // for short-window throttles AND project-level daily quota hits. The
  // message text is the only tell. Promote to projectQuotaExceeded
  // when it matches so the user gets accurate guidance ("request
  // higher quota at Cloud Console") instead of "wait a minute".
  if (reason === 'rateLimitExceeded' && apiMessage) {
    const m = apiMessage.toLowerCase();
    if (
      m.includes('video uploads per day') ||
      m.includes("'video uploads'") ||
      (m.includes('quota exceeded') && m.includes('project_number'))
    ) {
      reason = 'projectQuotaExceeded';
    }
  }

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

  // currentToken now lives at module scope (declared near the top of the
  // file alongside lastClipId etc.) so retryUpload, confirmBatchUpload,
  // and the rest of the upload-queue code can read it without going
  // through wireYouTubePublish's closure.
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
    // Pre-warm the access token, then refresh the destination banner once
    // it's ready. resetUploadUI just nulled currentToken, so this is the
    // only path that can populate the banner — the whoami fetch needs a
    // token. Result is cached at module scope, so subsequent clip
    // switches typically resolve from cache without a network round-trip.
    fetchAccessTokenInBackground().then(() => {
      refreshDestinationBanner();
      // Also fetch + render playlists. Cached per token, so this is
      // a no-op on subsequent clips. populatePlaylistsUI hides the
      // section gracefully when the list is empty (non-allowlisted
      // user, scope mismatch, no playlists on the channel).
      fetchUserPlaylists().then(populatePlaylistsUI);
    });
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
    // No stored clip yet (e.g. recording is rolling but the catalog
    // entry hasn't been added on stop yet) — fall back to whatever's
    // in the form so the AI can work on the in-progress metadata. The
    // user shouldn't have to wait for the recording to finish before
    // they can ask the AI to clean up the title or description they
    // already typed.
    const base = storedClip
      ? (publishClipId === lastClipId ? { ...storedClip, ...readFormFields() } : storedClip)
      : readFormFields();
    return {
      ...base,
      title: titleInput.value || base.title,
      description: descInput.value || base.description,
      tags: tagsInput.value || base.tags,
    };
  }

  // (fetchAccessTokenInBackground was hoisted to module scope so the
  // upload queue + retry handlers — which run outside this closure — can
  // call it. The version up top also calls showSignInPanel via a guarded
  // helper lookup; this closure no longer owns it.)

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
    refreshAllCharCounters();
  }

  // Toggle the in-button "twinkle" loader on whichever AI button was
  // clicked. Disabled bit prevents double-fire while a request is in
  // flight. CSS animation lives in capture.astro under .ai-busy.
  function setAiBusy(btn, busy) {
    if (!btn) return;
    btn.classList.toggle('ai-busy', busy);
    btn.disabled = !!busy;
  }

  // Force the publish fieldset visible while an AI session is in flight.
  // The loading spinner + suggestion preview live INSIDE #cap-pub-fieldset,
  // and that fieldset is hidden whenever there's no active clip — so when
  // the user clicks AI mid-recording (we now allow that) the spinner +
  // result would be invisible, hidden by their own parent. This pops the
  // parent open for the duration of the AI session; revertPublishFieldset
  // restores it to whatever updateClipDependentPanels says when we're done.
  function forcePublishFieldsetForAi() {
    const pub = document.getElementById('cap-pub-fieldset');
    if (pub) pub.classList.remove('hidden');
  }
  function revertPublishFieldsetVisibility() {
    if (typeof updateClipDependentPanels === 'function') updateClipDependentPanels();
  }

  async function fetchSuggestion(scope, btnEl) {
    const metadata = buildMetadata();
    if (!metadata) {
      showError('Clip not found.');
      return;
    }

    setAiBusy(btnEl, true);
    forcePublishFieldsetForAi();
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
          model: getAiModel(),
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
    } finally {
      // Always clear — covers success, every error path, and the early
      // return cases above (which all hit this finally too).
      setAiBusy(btnEl, false);
    }
  }

  function applySuggestion() {
    // Pull from the visible suggestion fields (which the user may have
    // edited) rather than the stashed AI response. This is what makes
    // the preview meaningfully editable — the AI gives you a starting
    // point, you tweak it, "Use this" copies your version into the
    // main sidebar form. Empty fields don't overwrite (so an accidental
    // wipe doesn't blow away whatever's already in the sidebar).
    //
    // Track which fields actually changed so we can persist them to
    // the catalog directly. Programmatic .value assignments DO NOT
    // fire 'input' events, which means wireMainEditorAutosave never
    // runs and the catalog stays stale. That was invisible for single
    // uploads (snapshotPublishForm reads the form directly) but bit
    // hard on bulk uploads, which round-trip through the catalog
    // (Matt reported AI descriptions vanishing when he batch-uploaded).
    const updates = {};
    if (currentSuggestionScope === 'all' || currentSuggestionScope === 'title') {
      const t = (suggestionTitle.value || '').trim();
      if (t) { titleInput.value = t; updates.title = t; }
    }
    if (currentSuggestionScope === 'all' || currentSuggestionScope === 'description') {
      const d = suggestionDesc.value || '';
      if (d.trim()) { descInput.value = d; updates.description = d; }
    }
    if (currentSuggestionScope === 'all') {
      const tags = (suggestionTags.value || '').trim();
      if (tags) { tagsInput.value = tags; updates.tags = tags; }
    }
    // Persist directly to the catalog (bypasses the autosave debounce
    // entirely). Also dispatch input events so anything else listening
    // — char counters, future hooks — gets a chance to react.
    if (lastClipId && Object.keys(updates).length > 0) {
      updateClip(lastClipId, updates);
      // Also re-write the JSON sidecar to disk so the on-disk copy
      // stays in sync with the catalog (otherwise re-import would
      // clobber the AI text with whatever was in the sidecar).
      const clips = getClips();
      const clip = clips.find(c => c.id === lastClipId);
      if (clip && clip.filename && directoryHandle) {
        const basename = clip.filename.replace(/\.(webm|mp4)$/, '');
        saveSidecarFiles(directoryHandle, basename, clip).catch(() => {});
      }
    }
    [titleInput, descInput, tagsInput].forEach((el) => {
      if (el) el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    currentSuggestion = null;
    refreshAllCharCounters();
    showForm();
    // Revert the publish fieldset to whatever updateClipDependentPanels
    // would say — when AI was invoked mid-recording (no clip yet), this
    // hides the fieldset so the user goes back to the live recording UI.
    // When there IS a clip, the fieldset stays visible.
    revertPublishFieldsetVisibility();
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
  errorCloseBtn.addEventListener('click', () => {
    showForm();
    revertPublishFieldsetVisibility();
  });
  publishClip = startPublish;

  // Sparkle buttons — main button rewrites everything; per-field sparkles
  // scope the suggestion panel to just that one field.
  if (aiAllBtn) aiAllBtn.addEventListener('click', () => fetchSuggestion('all', aiAllBtn));
  if (aiTitleBtn) aiTitleBtn.addEventListener('click', () => fetchSuggestion('title', aiTitleBtn));
  if (aiDescBtn) aiDescBtn.addEventListener('click', () => fetchSuggestion('description', aiDescBtn));

  // Suggestion panel: Use this writes the visible fields back into the form,
  // Try again re-fetches with the same scope, Cancel just discards.
  if (suggestionUseBtn) suggestionUseBtn.addEventListener('click', applySuggestion);
  if (suggestionRetryBtn) suggestionRetryBtn.addEventListener('click', () => {
    // Retry from inside the suggestion panel — twinkle the AI button
    // that matches the original scope so the user gets the same
    // in-button feedback as the initial click.
    const btnForScope = currentSuggestionScope === 'title' ? aiTitleBtn
                      : currentSuggestionScope === 'description' ? aiDescBtn
                      : aiAllBtn;
    fetchSuggestion(currentSuggestionScope, btnForScope);
  });
  if (suggestionCancelBtn) suggestionCancelBtn.addEventListener('click', () => {
    currentSuggestion = null;
    showForm();
    revertPublishFieldsetVisibility();
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
        `${basename}_youtube.jpg`,
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
    // showLiveTab already hides + exits Trim, but be explicit here
    // since showLiveTab might short-circuit if previewMode was already
    // 'live'.
    document.getElementById('trim-recording-btn')?.classList.add('hidden');
  });
}

// ---------------------------------------------------------------------------
// TRIM MODE
// ---------------------------------------------------------------------------
//
// Lets the user trim the start and/or end off a recorded clip. Triggered by
// the Trim button in the controls row (under the playback preview). Opens an
// in-page panel with:
//   · A custom timeline + two draggable handles (IN, OUT)
//   · Two text inputs (h:mm:ss.s) bidirectionally synced with the handles
//   · A scoped Play button (only plays the [in, out] range)
//   · Save/Cancel; ESC also cancels
//
// Save opens a confirm modal where the user picks:
//   "Create new clip"           — encode trim to a NEW file, leave original
//   "Trim original permanently" — overwrite the source file on disk
//
// Encoding pipeline = real-time MediaRecorder (clip duration ≈ encode wall-
// clock time). A toast in the bottom-right shows progress so the wait isn't
// silent. WebCodecs would be faster (~5–10× realtime) but adds complexity
// and codec-config failure modes; if real users find this too slow we'll
// revisit.

// Module-scope so showLiveTab() can call exitTrimMode() during clip swaps.
let trimMode = false;
let trimIn = 0;          // seconds
let trimOut = 0;         // seconds
let trimDuration = 0;    // seconds (full clip)
let trimEscHandlerRef = null;
let trimTimeUpdateRef = null;
let activeTrimRecorder = null;  // current MediaRecorder (so Cancel can stop it)

function exitTrimMode() {
  if (!trimMode) return;
  trimMode = false;

  const playback = document.getElementById('playback');
  const panel = document.getElementById('trim-panel');
  if (playback) {
    playback.pause();
    playback.setAttribute('controls', '');
    if (trimTimeUpdateRef) playback.removeEventListener('timeupdate', trimTimeUpdateRef);
    trimTimeUpdateRef = null;
  }
  if (panel) panel.classList.add('hidden');

  if (trimEscHandlerRef) {
    document.removeEventListener('keydown', trimEscHandlerRef);
    trimEscHandlerRef = null;
  }
  // Reset Play label/icon to the "Play" state for the next entry.
  document.getElementById('trim-play-icon')?.classList.remove('hidden');
  document.getElementById('trim-pause-icon')?.classList.add('hidden');
  const playLabel = document.getElementById('trim-play-label');
  if (playLabel) playLabel.textContent = 'Play';
}

// Format seconds as h:mm:ss.s — chosen as the sweet spot between consumer-
// friendly (everyone knows mm:ss) and editor-friendly (tenths give frame-
// adjacent precision when dragging). Always includes the hours position
// even for short clips so layout doesn't jump on long ones.
function formatTrimTime(seconds) {
  const t = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  // Use round() not floor() on the tenths so dragging "exactly to 1.0s"
  // doesn't display "0.9" because of float underflow.
  const tenths = Math.round((t - Math.floor(t)) * 10) % 10;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${tenths}`;
}

// Lenient parser: accepts "90", "1:30", "0:01:30", "0:01:30.5", "1:30.5".
// Returns seconds (float) or null on parse failure.
function parseTrimTime(str) {
  const trimmed = String(str || '').trim();
  if (!trimmed) return null;
  if (!/^[\d:.]+$/.test(trimmed)) return null;
  const parts = trimmed.split(':');
  let seconds;
  if (parts.length === 1) {
    seconds = parseFloat(parts[0]);
  } else if (parts.length === 2) {
    seconds = (parseInt(parts[0], 10) || 0) * 60 + parseFloat(parts[1]);
  } else if (parts.length === 3) {
    seconds = (parseInt(parts[0], 10) || 0) * 3600
            + (parseInt(parts[1], 10) || 0) * 60
            + parseFloat(parts[2]);
  } else {
    return null;
  }
  return isFinite(seconds) ? seconds : null;
}

function wireTrim() {
  const trimBtn = document.getElementById('trim-recording-btn');
  if (!trimBtn) return;

  trimBtn.addEventListener('click', () => {
    if (trimMode) { exitTrimMode(); return; }
    enterTrimMode();
  });

  // Wire all the panel internals once at startup (the panel itself is just
  // hidden/shown — we don't recreate listeners on each open).
  wireTrimPanel();
  wireTrimSaveModal();
}

function enterTrimMode() {
  if (!hasPlayback) return;
  const playback = document.getElementById('playback');
  if (!playback) return;

  const startWith = (dur) => {
    if (!isFinite(dur) || dur <= 0) return;
    trimMode = true;
    trimDuration = dur;
    trimIn = 0;
    trimOut = dur;

    playback.removeAttribute('controls');
    playback.pause();
    playback.currentTime = 0;

    document.getElementById('trim-panel').classList.remove('hidden');
    updateTrimUI();
    updateTrimPlayhead();

    trimEscHandlerRef = (e) => {
      if (e.key === 'Escape') {
        // Don't bail if the user is mid-edit in one of the inputs.
        if (e.target?.id === 'trim-in-input' || e.target?.id === 'trim-out-input') {
          e.target.blur();
          return;
        }
        exitTrimMode();
      }
    };
    document.addEventListener('keydown', trimEscHandlerRef);

    trimTimeUpdateRef = () => {
      // Clamp playhead inside [in, out]; loop on reaching out.
      if (playback.currentTime >= trimOut) {
        playback.pause();
        playback.currentTime = trimIn;
        // Sync the Play button back to "Play"
        document.getElementById('trim-play-icon')?.classList.remove('hidden');
        document.getElementById('trim-pause-icon')?.classList.add('hidden');
        const lbl = document.getElementById('trim-play-label');
        if (lbl) lbl.textContent = 'Play';
      } else if (playback.currentTime < trimIn) {
        playback.currentTime = trimIn;
      }
      updateTrimPlayhead();
    };
    playback.addEventListener('timeupdate', trimTimeUpdateRef);
  };

  // Duration may not be loaded yet (especially right after the clip is
  // first opened). Wait for loadedmetadata if needed.
  if (isFinite(playback.duration) && playback.duration > 0) {
    startWith(playback.duration);
  } else {
    const onMeta = () => { startWith(playback.duration); };
    playback.addEventListener('loadedmetadata', onMeta, { once: true });
  }
}

function updateTrimUI() {
  if (!trimDuration) return;
  const inPct = clampPct((trimIn / trimDuration) * 100);
  const outPct = clampPct((trimOut / trimDuration) * 100);

  const handleIn = document.getElementById('trim-handle-in');
  const handleOut = document.getElementById('trim-handle-out');
  const bandLeft = document.getElementById('trim-band-left');
  const bandRight = document.getElementById('trim-band-right');
  const bandKept = document.getElementById('trim-band-kept');
  const inputIn = document.getElementById('trim-in-input');
  const inputOut = document.getElementById('trim-out-input');

  if (handleIn) handleIn.style.left = inPct + '%';
  if (handleOut) handleOut.style.left = outPct + '%';
  if (bandLeft) bandLeft.style.width = inPct + '%';
  if (bandRight) bandRight.style.width = (100 - outPct) + '%';
  if (bandKept) {
    bandKept.style.left = inPct + '%';
    bandKept.style.right = (100 - outPct) + '%';
  }
  // Don't clobber the input the user is currently typing into.
  if (inputIn && document.activeElement !== inputIn) inputIn.value = formatTrimTime(trimIn);
  if (inputOut && document.activeElement !== inputOut) inputOut.value = formatTrimTime(trimOut);
}

function updateTrimPlayhead() {
  if (!trimDuration) return;
  const playback = document.getElementById('playback');
  const playhead = document.getElementById('trim-playhead');
  const pos = document.getElementById('trim-position');
  const t = playback?.currentTime || 0;
  const pct = clampPct((t / trimDuration) * 100);
  if (playhead) playhead.style.left = pct + '%';
  if (pos) pos.textContent = `${formatTrimTime(t)} / ${formatTrimTime(trimDuration)}`;
}

function clampPct(p) { return Math.max(0, Math.min(100, p)); }

function wireTrimPanel() {
  const timeline = document.getElementById('trim-timeline');
  const handleIn = document.getElementById('trim-handle-in');
  const handleOut = document.getElementById('trim-handle-out');
  const inputIn = document.getElementById('trim-in-input');
  const inputOut = document.getElementById('trim-out-input');
  const playBtn = document.getElementById('trim-play-btn');
  const cancelBtn = document.getElementById('trim-cancel-btn');
  const saveBtn = document.getElementById('trim-save-btn');
  if (!timeline || !handleIn || !handleOut) return;

  // Minimum gap between IN and OUT — 0.2s. Any tighter and the
  // MediaRecorder pipeline can produce a zero-frame output on slow
  // machines. Easy to relax later if needed.
  const MIN_GAP_S = 0.2;

  // Click-to-scrub on the timeline track. Ignored when the click lands
  // on a handle (the handle gets its own pointerdown listener that
  // stopPropagation's so this never fires for those clicks).
  timeline.addEventListener('pointerdown', (e) => {
    if (e.target === handleIn || e.target === handleOut) return;
    if (!trimMode || !trimDuration) return;
    const rect = timeline.getBoundingClientRect();
    const pct = clampPct(((e.clientX - rect.left) / rect.width) * 100);
    const t = (pct / 100) * trimDuration;
    const clamped = Math.max(trimIn, Math.min(trimOut, t));
    const playback = document.getElementById('playback');
    if (playback) playback.currentTime = clamped;
    updateTrimPlayhead();
  });

  // Generic handle drag — works for both IN and OUT. Uses pointer
  // capture so a drag that exits the window-bounds still tracks until
  // pointerup.
  function attachHandleDrag(handle, isIn) {
    handle.addEventListener('pointerdown', (e) => {
      if (!trimMode || !trimDuration) return;
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const rect = timeline.getBoundingClientRect();

      const onMove = (ev) => {
        const pct = clampPct(((ev.clientX - rect.left) / rect.width) * 100);
        let t = (pct / 100) * trimDuration;
        if (isIn) {
          // Don't let IN cross OUT (with the min gap).
          t = Math.max(0, Math.min(trimOut - MIN_GAP_S, t));
          trimIn = t;
        } else {
          t = Math.max(trimIn + MIN_GAP_S, Math.min(trimDuration, t));
          trimOut = t;
        }
        updateTrimUI();
        // Live-preview: jump the playhead to the handle being dragged
        // so the user sees a frame at that timestamp.
        const playback = document.getElementById('playback');
        if (playback) {
          playback.pause();
          playback.currentTime = isIn ? trimIn : trimOut;
        }
      };

      const onUp = (ev) => {
        try { handle.releasePointerCapture(ev.pointerId); } catch {}
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  }
  attachHandleDrag(handleIn, true);
  attachHandleDrag(handleOut, false);

  // Text-input bidirectional binding. Commits on Enter or blur; live
  // typing doesn't move the handle (would feel jumpy).
  function commitInput(inputEl, isIn) {
    if (!trimMode || !trimDuration) return;
    const parsed = parseTrimTime(inputEl.value);
    if (parsed === null) {
      // Restore the previous value on bad input.
      inputEl.value = formatTrimTime(isIn ? trimIn : trimOut);
      return;
    }
    let t = parsed;
    if (isIn) {
      t = Math.max(0, Math.min(trimOut - MIN_GAP_S, t));
      trimIn = t;
    } else {
      t = Math.max(trimIn + MIN_GAP_S, Math.min(trimDuration, t));
      trimOut = t;
    }
    updateTrimUI();
    const playback = document.getElementById('playback');
    if (playback) playback.currentTime = isIn ? trimIn : trimOut;
  }
  inputIn?.addEventListener('blur', () => commitInput(inputIn, true));
  inputIn?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); inputIn.blur(); }
  });
  inputOut?.addEventListener('blur', () => commitInput(inputOut, false));
  inputOut?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); inputOut.blur(); }
  });

  // Play/pause toggle. Also toggles the icon + label.
  playBtn?.addEventListener('click', () => {
    const playback = document.getElementById('playback');
    if (!playback) return;
    if (playback.paused) {
      // If the playhead's outside [in, out] (e.g. user just dragged
      // a handle), snap to IN before playing.
      if (playback.currentTime < trimIn || playback.currentTime >= trimOut) {
        playback.currentTime = trimIn;
      }
      playback.play();
      document.getElementById('trim-play-icon')?.classList.add('hidden');
      document.getElementById('trim-pause-icon')?.classList.remove('hidden');
      const lbl = document.getElementById('trim-play-label');
      if (lbl) lbl.textContent = 'Pause';
    } else {
      playback.pause();
      document.getElementById('trim-play-icon')?.classList.remove('hidden');
      document.getElementById('trim-pause-icon')?.classList.add('hidden');
      const lbl = document.getElementById('trim-play-label');
      if (lbl) lbl.textContent = 'Play';
    }
  });

  cancelBtn?.addEventListener('click', exitTrimMode);
  saveBtn?.addEventListener('click', openTrimSaveModal);
}

// ---------------------------------------------------------------------------
// Trim save modal — picks new-clip vs. permanent
// ---------------------------------------------------------------------------

function openTrimSaveModal() {
  if (!trimMode || !trimDuration) return;
  const modal = document.getElementById('trim-save-modal');
  if (!modal) return;

  // Update the from/to/kept summary line.
  document.getElementById('trim-modal-in').textContent = formatTrimTime(trimIn);
  document.getElementById('trim-modal-out').textContent = formatTrimTime(trimOut);
  document.getElementById('trim-modal-kept').textContent = formatTrimTime(trimOut - trimIn);

  // Show the "already on YouTube" warning only if applicable. The note
  // doesn't BLOCK the action — user can still pick "Trim original
  // permanently" — it just tells them what won't happen.
  const clips = getClips();
  const clip = clips.find(c => c.id === lastClipId);
  const note = document.getElementById('trim-modal-uploaded-note');
  if (note) {
    if (clip && clip.youtubeUrl) note.classList.remove('hidden');
    else note.classList.add('hidden');
  }

  // Default selection is always "Create new clip"
  const newRadio = modal.querySelector('input[name="trim-mode"][value="new"]');
  if (newRadio) newRadio.checked = true;

  modal.classList.remove('hidden');
}

function closeTrimSaveModal() {
  document.getElementById('trim-save-modal')?.classList.add('hidden');
}

function wireTrimSaveModal() {
  const modal = document.getElementById('trim-save-modal');
  if (!modal) return;
  document.getElementById('trim-modal-cancel')?.addEventListener('click', closeTrimSaveModal);
  document.getElementById('trim-modal-confirm')?.addEventListener('click', async () => {
    const choice = modal.querySelector('input[name="trim-mode"]:checked')?.value || 'new';
    closeTrimSaveModal();
    await runTrimEncode(choice);
  });
  // Click-outside dismiss
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeTrimSaveModal();
  });
}

// ---------------------------------------------------------------------------
// Trim encode pipeline — MediaRecorder, real-time
// ---------------------------------------------------------------------------
//
// Strategy: load the source file into a hidden <video>, captureStream()
// from it, pipe into a MediaRecorder, then play() from `trimIn` to
// `trimOut`. Stop recording on the natural end-of-range (timeupdate
// >= trimOut) or a setTimeout fallback.
//
// Quirks worth knowing:
//   · captureStream() requires the source to be playing for video frames
//     to flow into the recorder. We mute the source and play it muted.
//   · Some Chromiums need a fresh AudioContext to route the source's
//     audio into the recorder's audio track. We use the source's own
//     audio track via the captureStream — works on current Chrome.
//   · MIME type must be supported by MediaRecorder for the codecs the
//     source uses; we try a couple and fall back to whatever's
//     available.

async function runTrimEncode(choice) {
  // Snapshot trim params + clip context BEFORE exiting trim mode, since
  // exit clears the playback element's state.
  const inSec = trimIn;
  const outSec = trimOut;
  const clipId = lastClipId;
  const clips = getClips();
  const clip = clips.find(c => c.id === clipId);
  if (!clip || !clip.filename) {
    alert('Trim failed: clip is missing from the catalog.');
    return;
  }
  if (!directoryHandle) {
    alert('Trim failed: no save folder selected.');
    return;
  }

  // Read the source file from disk fresh — don't rely on the existing
  // playbackBlobUrl, which may have been revoked.
  let srcFile;
  try {
    const fh = await directoryHandle.getFileHandle(clip.filename);
    srcFile = await fh.getFile();
  } catch (e) {
    alert(`Trim failed: could not read source file (${clip.filename}).`);
    return;
  }

  // Exit the trim panel UI before starting the encode (the encode binds
  // its own audio, and the user's done futzing with handles).
  exitTrimMode();

  // Show progress toast.
  const toast = document.getElementById('trim-progress-toast');
  const posEl = document.getElementById('trim-progress-position');
  const barEl = document.getElementById('trim-progress-bar');
  const detailEl = document.getElementById('trim-progress-detail');
  toast?.classList.remove('hidden');
  if (barEl) barEl.style.width = '0%';
  const wantSeconds = Math.max(0.1, outSec - inSec);

  const onProgress = (doneSec, totalSec) => {
    const pct = Math.min(100, (doneSec / totalSec) * 100);
    if (barEl) barEl.style.width = pct + '%';
    if (posEl) posEl.textContent = `${formatTrimTime(doneSec)} of ${formatTrimTime(totalSec)}`;
  };

  // encodeTrim returns { blob, mime, ext } so we can write a filename
  // matching the actual recorder output (mp4 source → mp4 output where
  // browser supports it). Fallback to webm extension if the shape is
  // somehow wrong (defensive against future encoder rewrites).
  let result = null;
  try {
    result = await encodeTrim(srcFile, inSec, outSec, onProgress, detailEl);
  } catch (e) {
    console.error('[trim] encode failed:', e);
    toast?.classList.add('hidden');
    alert('Trim failed: ' + (e.message || 'encoder error'));
    return;
  }

  const outBlob = result?.blob || result; // back-compat
  const outExt = result?.ext || '.webm';
  if (!outBlob || outBlob.size === 0) {
    toast?.classList.add('hidden');
    alert('Trim failed: encoder produced an empty file. Try a longer range.');
    return;
  }

  // Persist + update catalog.
  try {
    if (choice === 'replace') {
      await persistTrimReplace(clip, outBlob, outSec - inSec, outBlob.size, outExt);
    } else {
      await persistTrimNew(clip, outBlob, outSec - inSec, outBlob.size, outExt);
    }
  } catch (e) {
    console.error('[trim] persist failed:', e);
    alert('Trim encoded OK but saving failed: ' + e.message);
  } finally {
    toast?.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Encode dispatcher — WebCodecs primary, MediaRecorder fallback
// ---------------------------------------------------------------------------
//
// WebCodecs is the modern path: hardware-accelerated where available,
// gives us explicit timestamp control + better error reporting. Most
// importantly it can decode + encode in parallel, often beating
// MediaRecorder's strictly-realtime pipeline by 1.5–3× on Mac/Chrome.
//
// MediaRecorder is the fallback: works in every browser that supports
// File System Access (already a requirement for /capture), strictly
// realtime (5-min clip = 5-min encode), but rock-solid reliable.
//
// We try WebCodecs first; if it throws OR if a feature probe fails,
// we fall through to MediaRecorder. The user sees the SAME progress
// toast either way; the only visible difference is the small detail
// line ("WebCodecs encode" vs "Real-time encode — leave this tab open").
async function encodeTrim(srcFile, inSec, outSec, onProgress, detailEl) {
  // WebCodecs path is currently DISABLED — the previous implementation
  // had a muxer-creation race condition (muxer was built lazily on the
  // first audio chunk, but video chunks emitted before that were
  // dropped — including the keyframe, hence the all-black output Matt
  // saw) AND positioned the source <video> at left:-9999px, which let
  // some browsers optimize the rendering pipeline away and produce
  // empty/stale captures. Both fixable, but a proper rewrite needs
  // MediaStreamTrackProcessor for the video track (parallel to audio)
  // plus upfront-built muxer using getSettings() to know audio shape
  // before chunks flow. Until that lands, MediaRecorder is the only
  // path. Slow but reliable.
  if (detailEl) detailEl.textContent = 'Real-time encode — leave this tab open.';
  return await encodeWithMediaRecorder(srcFile, inSec, outSec, onProgress);
}

// ---------------------------------------------------------------------------
// MediaRecorder encode — strictly realtime, very reliable
// ---------------------------------------------------------------------------
//
// Returns { blob, mime, ext } so the caller can pick a filename
// extension matching the actual recorder output (mp4 source ought to
// produce mp4 output where possible).
async function encodeWithMediaRecorder(srcFile, inSec, outSec, onProgress) {
  const sourceUrl = URL.createObjectURL(srcFile);
  const wantSeconds = Math.max(0.1, outSec - inSec);

  // Hidden source <video>. We position it OFF-screen but inside the
  // viewport rectangle (1×1 px in the bottom-right with opacity 0)
  // rather than left:-9999px. The reason: browsers may aggressively
  // skip rendering / frame production for elements that are entirely
  // outside the viewport, which starves captureStream() of frames and
  // produces empty trims. A 1×1 in-viewport element is invisible to
  // the user but the rendering pipeline still pumps frames.
  //
  // muted=true (in addition to volume=0) so play() always satisfies
  // autoplay policy even if the user-gesture chain has been broken
  // by an awaited microtask. captureStream still gets the audio track
  // because muted-element capture is well-supported in Chrome — the
  // mute affects local output, not the captured stream.
  const srcVideo = document.createElement('video');
  srcVideo.src = sourceUrl;
  srcVideo.volume = 0;
  srcVideo.muted = true;
  srcVideo.playsInline = true;
  srcVideo.style.cssText = 'position:fixed;bottom:0;right:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;';
  document.body.appendChild(srcVideo);

  const cleanup = () => {
    try { srcVideo.pause(); } catch {}
    URL.revokeObjectURL(sourceUrl);
    srcVideo.remove();
    activeTrimRecorder = null;
  };

  try {
    await new Promise((resolve) => {
      if (isFinite(srcVideo.duration) && srcVideo.duration > 0) resolve();
      else srcVideo.addEventListener('loadedmetadata', resolve, { once: true });
    });

    let stream;
    try { stream = srcVideo.captureStream(); }
    catch (e) { throw new Error('captureStream() unavailable: ' + e.message); }

    // MIME negotiation — match the source format where possible so a
    // .mp4 input produces a .mp4 trim. Falls through to WebM if the
    // browser can't record MP4 (older Chrome / Firefox). Order matters:
    // first supported wins.
    const sourceIsMp4 = (srcFile.type || '').startsWith('video/mp4')
      || /\.mp4$/i.test(srcFile.name || '');
    const mp4Candidates = [
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1',
      'video/mp4',
    ];
    const webmCandidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    const candidates = sourceIsMp4
      ? [...mp4Candidates, ...webmCandidates]
      : webmCandidates;
    const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error('No supported MediaRecorder MIME type.');
    const ext = mime.startsWith('video/mp4') ? '.mp4' : '.webm';
    console.info('[trim] encoding via MediaRecorder', {
      sourceType: srcFile.type, sourceName: srcFile.name,
      sourceIsMp4, mime, ext,
    });

    const recorder = new MediaRecorder(stream, { mimeType: mime });
    activeTrimRecorder = recorder;
    const chunks = [];
    recorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    });
    recorder.addEventListener('error', (e) => {
      console.warn('[trim] MediaRecorder error event:', e.error || e);
    });

    // Seek to IN, await 'seeked' so we know currentTime took effect
    // before we start capture.
    await new Promise((resolve, reject) => {
      const onSeeked = () => { srcVideo.removeEventListener('seeked', onSeeked); resolve(); };
      srcVideo.addEventListener('seeked', onSeeked);
      try { srcVideo.currentTime = inSec; } catch (e) { reject(e); }
    });

    // Start playback FIRST, then briefly wait for the first frame to
    // actually present, THEN start the recorder. Without the grace
    // period, recorder.start() races with the source's first frame
    // and can lose the keyframe — producing exactly the "black video,
    // has duration" output Matt observed.
    try { await srcVideo.play(); } catch (e) {
      throw new Error('Could not play source video: ' + e.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 80));

    recorder.start(250);

    let stopped = false;
    const finalize = () => new Promise((resolve) => {
      if (stopped) return resolve();
      stopped = true;
      recorder.addEventListener('stop', resolve, { once: true });
      try { recorder.stop(); } catch {}
      try { srcVideo.pause(); } catch {}
    });

    const onTime = async () => {
      const done = Math.max(0, srcVideo.currentTime - inSec);
      onProgress(done, wantSeconds);
      if (srcVideo.currentTime >= outSec) {
        srcVideo.removeEventListener('timeupdate', onTime);
        await finalize();
      }
    };
    srcVideo.addEventListener('timeupdate', onTime);

    // Failsafe — if timeupdate stops firing for some reason, bail
    // after wantSeconds * 1.5 + 5s wall-clock.
    const failsafe = setTimeout(async () => {
      if (!stopped) {
        console.warn('[trim] MediaRecorder failsafe timer fired');
        srcVideo.removeEventListener('timeupdate', onTime);
        await finalize();
      }
    }, Math.ceil(wantSeconds * 1.5 * 1000) + 5000);

    await new Promise((resolve) => {
      const check = () => { if (stopped) resolve(); else setTimeout(check, 100); };
      check();
    });
    clearTimeout(failsafe);

    cleanup();

    const totalBytes = chunks.reduce((s, c) => s + c.size, 0);
    console.info('[trim] MediaRecorder finished', {
      chunkCount: chunks.length, totalBytes, mime,
    });
    if (totalBytes === 0) throw new Error('Recorder produced no data.');

    return { blob: new Blob(chunks, { type: mime }), mime, ext };
  } catch (e) {
    cleanup();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// WebCodecs encode (primary)
// ---------------------------------------------------------------------------
//
// Pipeline:
//   Source <video> ──┬─▶ requestVideoFrameCallback ──▶ VideoFrame ──┐
//                    │                                              ▶ VideoEncoder ──▶ Muxer
//                    │                                              │
//                    └─▶ captureStream() ──▶ MediaStreamTrackProcessor ──▶ AudioData ──▶ AudioEncoder ──▶ Muxer
//                          (audio track)
//
// Source plays at 1× wall-clock; both encoder paths drain decoded
// frames as they arrive. Hardware acceleration where the platform
// supports it (M-series Mac → both decode + encode HW for VP9; Intel
// Mac → typically SW for VP9 but still faster than MediaRecorder
// because the decode/encode loops are tighter).
//
// Throws on any error so the caller's try/catch can fall back to
// MediaRecorder. The fallback boundary is the only place that
// silently catches; everything inside this function surfaces.
async function encodeWithWebCodecs(srcFile, inSec, outSec, onProgress) {
  // Dynamic import the muxer ONLY when WebCodecs is being used. Saves
  // ~65KB of JS for users who never trim.
  const { Muxer, ArrayBufferTarget } = await import('/vendor/webm-muxer/webm-muxer.mjs');

  const sourceUrl = URL.createObjectURL(srcFile);
  const wantSeconds = Math.max(0.1, outSec - inSec);

  const srcVideo = document.createElement('video');
  srcVideo.src = sourceUrl;
  srcVideo.volume = 0;
  srcVideo.playsInline = true;
  srcVideo.style.cssText = 'position:fixed;left:-9999px;top:0;width:320px;height:180px;';
  document.body.appendChild(srcVideo);

  // Cleanup helper — call on every exit path.
  const cleanup = () => {
    try { srcVideo.pause(); } catch {}
    URL.revokeObjectURL(sourceUrl);
    srcVideo.remove();
  };

  try {
    await new Promise((resolve) => {
      if (isFinite(srcVideo.duration) && srcVideo.duration > 0) resolve();
      else srcVideo.addEventListener('loadedmetadata', resolve, { once: true });
    });

    const width = srcVideo.videoWidth;
    const height = srcVideo.videoHeight;
    if (!width || !height) throw new Error('Source video has no dimensions.');

    // Probe encoder support before we commit any work. VP9 is the
    // modern WebM codec; vp09.00.10.08 = profile 0, level 3.1, 8-bit
    // 4:2:0 — universally supported. Bitrate scales with resolution.
    const px = width * height;
    const targetBitrate = Math.max(800_000, Math.min(8_000_000, Math.round(px * 0.1)));
    const videoConfig = {
      codec: 'vp09.00.10.08',
      width,
      height,
      bitrate: targetBitrate,
      framerate: 30,
    };
    const videoSupport = await VideoEncoder.isConfigSupported(videoConfig);
    if (!videoSupport.supported) throw new Error('VP9 encoder not supported in this browser.');

    // Set up muxer. We mark audio as "maybe" — actual audio config
    // gets written when the first audio chunk arrives (sample rate
    // and channel count come from the source's audio track, which we
    // don't know until captureStream gives us a track).
    const target = new ArrayBufferTarget();
    let muxer;
    let audioConfigured = false;

    // Encoders. Both push directly into the muxer.
    const encErrors = [];
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer?.addVideoChunk(chunk, meta),
      error: (e) => { encErrors.push(e); },
    });
    videoEncoder.configure(videoConfig);

    // Audio encoder is created lazily once we know the source's audio
    // params (sample rate, channels). null until then.
    let audioEncoder = null;
    let audioStartTimestampUs = -1;

    // Set up audio extraction via captureStream + TrackProcessor.
    let audioReader = null;
    let audioPromise = Promise.resolve();
    let stream;
    try { stream = srcVideo.captureStream(); }
    catch (e) { throw new Error('captureStream() unavailable: ' + e.message); }
    const audioTracks = stream.getAudioTracks();

    if (audioTracks.length > 0) {
      const processor = new MediaStreamTrackProcessor({ track: audioTracks[0] });
      audioReader = processor.readable.getReader();

      audioPromise = (async () => {
        while (true) {
          const { done, value } = await audioReader.read();
          if (done) return;
          const audioData = value;

          // First audio chunk: configure muxer + encoder with the
          // discovered audio shape.
          if (!audioConfigured) {
            const audioConfig = {
              codec: 'opus',
              sampleRate: audioData.sampleRate,
              numberOfChannels: audioData.numberOfChannels,
              bitrate: 128_000,
            };
            const audioSupport = await AudioEncoder.isConfigSupported(audioConfig).catch(() => ({ supported: false }));
            if (!audioSupport.supported) {
              // No audio support — keep video going, drop audio. Better
              // than aborting the whole encode.
              audioData.close();
              audioReader.cancel();
              return;
            }
            audioEncoder = new AudioEncoder({
              output: (chunk, meta) => muxer?.addAudioChunk(chunk, meta),
              error: (e) => { encErrors.push(e); },
            });
            audioEncoder.configure(audioConfig);
            audioConfigured = true;

            // NOW we can build the muxer with both tracks declared
            // (webm-muxer needs the full track shape at construction).
            muxer = new Muxer({
              target,
              video: { codec: 'V_VP9', width, height },
              audio: {
                codec: 'A_OPUS',
                sampleRate: audioData.sampleRate,
                numberOfChannels: audioData.numberOfChannels,
              },
            });
          }

          // Re-stamp audio timestamps relative to the first chunk so
          // output starts at 0 (matching video's 0-based timestamps).
          if (audioStartTimestampUs < 0) audioStartTimestampUs = audioData.timestamp;
          const relTs = audioData.timestamp - audioStartTimestampUs;

          // Stop when audio reaches the end of the trim window.
          if (relTs / 1_000_000 >= wantSeconds) {
            audioData.close();
            audioReader.cancel();
            return;
          }

          // Clone with new timestamp by copying samples.
          const samplesPerChannel = audioData.numberOfFrames;
          const channels = audioData.numberOfChannels;
          const totalSamples = samplesPerChannel * channels;
          const buf = new Float32Array(totalSamples);
          // 'f32' format = interleaved float; 'f32-planar' = planar.
          // copyTo with planeIndex: 0 + format='f32' gives interleaved.
          try {
            audioData.copyTo(buf, { planeIndex: 0, format: 'f32' });
          } catch {
            // Some browsers only expose the data in its native format;
            // pass through with original ts as a last resort.
            audioEncoder?.encode(audioData);
            audioData.close();
            continue;
          }
          const restamped = new AudioData({
            format: 'f32',
            sampleRate: audioData.sampleRate,
            numberOfFrames: samplesPerChannel,
            numberOfChannels: channels,
            timestamp: relTs,
            data: buf,
          });
          audioEncoder?.encode(restamped);
          restamped.close();
          audioData.close();
        }
      })();
    } else {
      // No audio track — initialize muxer for video-only.
      audioConfigured = true;
      muxer = new Muxer({
        target,
        video: { codec: 'V_VP9', width, height },
      });
    }

    // Seek to IN and start playing — frames begin flowing through
    // requestVideoFrameCallback once playback resumes.
    await new Promise((resolve, reject) => {
      const onSeeked = () => { srcVideo.removeEventListener('seeked', onSeeked); resolve(); };
      srcVideo.addEventListener('seeked', onSeeked);
      try { srcVideo.currentTime = inSec; } catch (e) { reject(e); }
    });

    // Video encoding loop. requestVideoFrameCallback fires once per
    // newly-presented frame. metadata.mediaTime is the source-video
    // timestamp, which we use as the canonical clock.
    let videoFrameCount = 0;
    let lastKeyframeUs = -3_000_000;
    let videoStarted = false;

    const videoPromise = new Promise((resolve, reject) => {
      const onFrame = (now, metadata) => {
        try {
          if (!videoStarted) {
            // The first frame after seek may have been decoded just
            // before the new currentTime took effect — gate on
            // mediaTime being inside our window.
            if (metadata.mediaTime < inSec - 0.05) {
              srcVideo.requestVideoFrameCallback(onFrame);
              return;
            }
            videoStarted = true;
          }

          if (metadata.mediaTime >= outSec) {
            resolve();
            return;
          }

          const timestampUs = Math.max(0, Math.round((metadata.mediaTime - inSec) * 1_000_000));
          const isKeyframe = timestampUs === 0 || (timestampUs - lastKeyframeUs >= 2_000_000);
          if (isKeyframe) lastKeyframeUs = timestampUs;

          const frame = new VideoFrame(srcVideo, { timestamp: timestampUs });
          videoEncoder.encode(frame, { keyFrame: isKeyframe });
          frame.close();
          videoFrameCount++;

          onProgress(metadata.mediaTime - inSec, wantSeconds);

          srcVideo.requestVideoFrameCallback(onFrame);
        } catch (e) {
          reject(e);
        }
      };
      srcVideo.requestVideoFrameCallback(onFrame);
    });

    try { await srcVideo.play(); }
    catch (e) { throw new Error('Could not play source for capture: ' + e.message); }

    // Wait for both video + audio loops to finish naturally.
    await Promise.all([videoPromise, audioPromise]);

    // Drain encoders + finalize muxer.
    await videoEncoder.flush();
    if (audioEncoder) await audioEncoder.flush();

    if (encErrors.length) {
      throw new Error('Encoder error: ' + encErrors[0].message);
    }

    if (!muxer) throw new Error('Muxer was never initialized (audio probe failed?).');
    muxer.finalize();

    videoEncoder.close();
    audioEncoder?.close();

    if (videoFrameCount === 0) {
      throw new Error('No video frames captured — check trim range.');
    }

    cleanup();
    return new Blob([target.buffer], { type: 'video/webm' });
  } catch (e) {
    cleanup();
    throw e;
  }
}

// Pick a unique filename for the new-clip case. Tries `_trim`, then
// `_trim2`, `_trim3`, etc.
async function pickTrimFilename(srcFilename, ext = '.webm') {
  return pickAvailableFilename(srcFilename, 'trim', ext);
}

// Find an unused filename for a derived clip (trim, duplicate, etc).
// Tries `{base}_{suffix}{ext}`, then `{base}_{suffix}2{ext}`,
// `{base}_{suffix}3{ext}`, etc. Returns the first one that doesn't
// already exist on disk. Bounded so a corrupted folder can't loop
// forever.
async function pickAvailableFilename(srcFilename, suffix, targetExt) {
  const base = srcFilename.replace(/\.(webm|mp4)$/, '');
  let candidate = `${base}_${suffix}${targetExt}`;
  let i = 2;
  while (i < 1000) {
    try {
      await directoryHandle.getFileHandle(candidate);
      candidate = `${base}_${suffix}${i}${targetExt}`;
      i++;
    } catch {
      return candidate;
    }
  }
  return candidate;
}

// Return `desiredFilename` unchanged if no file with that name exists on
// disk; otherwise append _2, _3, etc. until a free slot is found. Used
// at every point where we MIGHT write a video file (initial recording,
// post-stop title-rename, autosave title-rename) to prevent two clips
// with the same title from silently overwriting each other on disk —
// which previously also clobbered each other's sidecar JSON +
// _youtube.txt + sleeve files, leaving Matt with descriptions tied to
// the wrong videos.
//
// The `allowSelf` option lets a clip's CURRENT filename be considered
// "available" — needed for the rename paths, where we don't want to
// suffix when the user's title change happens to round-trip back to
// what it already is.
async function pickUniqueFilename(desiredFilename, { allowSelf = null } = {}) {
  if (!directoryHandle || !desiredFilename) return desiredFilename;
  const ext = (desiredFilename.match(/\.(webm|mp4)$/i) || ['.mp4'])[0];
  const base = desiredFilename.replace(/\.(webm|mp4)$/i, '');
  let candidate = desiredFilename;
  let i = 2;
  while (i < 1000) {
    try {
      await directoryHandle.getFileHandle(candidate);
      // Exists. Allowed if it's our own clip's current name.
      if (allowSelf && candidate === allowSelf) return candidate;
      candidate = `${base}_${i}${ext}`;
      i++;
    } catch {
      return candidate;
    }
  }
  return candidate;
}

// Copy the sleeve JPGs (front + back) for a derived clip so the new
// entry has the same printed sleeve photos as the source. Sleeves
// live on disk as `{basename}_front.jpg` / `{basename}_back.jpg`
// (NOT in the catalog — they were too big and exploded localStorage
// quota when stored inline). Both paths that derive a new clip
// (duplicate, trim → create new) call this so the new entry feels
// truly identical, not a stripped-down skeleton.
async function copySleeveFiles(srcBasename, dstBasename) {
  if (!directoryHandle) return;
  for (const side of ['front', 'back']) {
    const srcName = `${srcBasename}_${side}.jpg`;
    const dstName = `${dstBasename}_${side}.jpg`;
    try {
      const srcHandle = await directoryHandle.getFileHandle(srcName);
      const srcFile = await srcHandle.getFile();
      const dstHandle = await directoryHandle.getFileHandle(dstName, { create: true });
      const w = await dstHandle.createWritable();
      await w.write(srcFile);
      await w.close();
    } catch {
      // Source sleeve doesn't exist — that's fine, just skip.
    }
  }
}

// Duplicate a clip: copy its file on disk under a new name, clone its
// catalog entry with fresh ID + cleared youtube fields, and write a
// new sidecar JSON. No re-encode, no quality loss, fast (size-bound
// file copy). Powers the right-click → Duplicate menu item AND is
// the underlying "make a separate workspace from this raw recording"
// primitive that supports the trim-into-multiple-trailers workflow.
async function duplicateClip(clipId) {
  if (!directoryHandle) {
    alert('Pick a save folder before duplicating.');
    return;
  }
  const clips = getClips();
  const src = clips.find(c => c.id === clipId);
  if (!src || !src.filename) {
    alert('Could not duplicate: source clip not found.');
    return;
  }

  // Determine the target extension by sniffing the source name (so a
  // .mp4 source produces a .mp4 copy; a .webm produces .webm).
  const srcExt = src.filename.endsWith('.mp4') ? '.mp4' : '.webm';
  const newFilename = await pickAvailableFilename(src.filename, 'copy', srcExt);

  // Read source bytes and write the copy.
  let bytes = 0;
  try {
    const srcHandle = await directoryHandle.getFileHandle(src.filename);
    const srcFile = await srcHandle.getFile();
    bytes = srcFile.size;
    const dstHandle = await directoryHandle.getFileHandle(newFilename, { create: true });
    const w = await dstHandle.createWritable();
    await w.write(srcFile);
    await w.close();
  } catch (e) {
    console.error('[duplicate] file copy failed:', e);
    alert('Duplicate failed: could not read or write the file.');
    return;
  }

  // Build the new catalog entry. createClipEntry assigns a fresh ID
  // and the standard initial shape; we then overlay the source's
  // user-entered metadata so the duplicate starts feeling identical
  // (same title with " (copy)" suffix, same description, tags, sleeve
  // refs, etc.). youtubeUrl/youtubeId/ytThumbnailDataUrl are NOT
  // copied — the duplicate is a fresh artifact and should upload as
  // its own YouTube video.
  const dupTitle = src.title ? `${src.title} (copy)` : 'Untitled (copy)';
  const entry = createClipEntry(dupTitle, newFilename, src.duration || 0, bytes, src.bitrate || 0);
  for (const k of ['description', 'tags', 'year', 'tape', 'distributor',
                   'tapeLength', 'recordingSpeed', 'condition', 'cassetteNotes',
                   'thumbnail', 'sleeveFront', 'sleeveBack']) {
    if (src[k] != null) entry[k] = src[k];
  }
  addClip(entry);

  // Sidecar JSON + youtube.txt to disk so the new clip survives
  // catalog rebuilds (resync from disk reads sidecars).
  const basename = newFilename.replace(/\.(webm|mp4)$/, '');
  await saveSidecarFiles(directoryHandle, basename, entry);

  // Copy sleeve JPGs so the duplicate has the same printed sleeve.
  const srcBasename = src.filename.replace(/\.(webm|mp4)$/, '');
  await copySleeveFiles(srcBasename, basename);

  // Re-sync the library grid to show the new tile. We do NOT load it
  // into the editor — leaving the user where they were makes the
  // "duplicate three times in a row" workflow smoother (they can
  // right-click → Duplicate, right-click → Duplicate, etc., without
  // the editor flipping between clips).
  refreshLibrary();
}

async function persistTrimNew(srcClip, blob, durationSec, bytes, ext = '.webm') {
  // Use the encoder's actual output extension so a .mp4 source whose
  // trim produced an .mp4 blob lands on disk as .mp4 — not .webm. The
  // ext parameter comes from encodeWithMediaRecorder's MIME selection.
  const filename = await pickTrimFilename(srcClip.filename, ext);
  // Write the file.
  const fh = await directoryHandle.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();

  // Build the catalog entry by cloning the source's metadata so the
  // new clip starts with the same title/tags/sleeve refs and the user
  // doesn't have to re-enter everything. The trimmed clip is a NEW
  // clip from YouTube's perspective, so wipe youtube fields.
  const entry = createClipEntry(
    `${srcClip.title || 'Untitled'} (trim)`,
    filename,
    Math.round(durationSec),
    bytes,
    srcClip.bitrate || 0,
  );
  // Clone the user-entered metadata over.
  for (const k of ['description', 'tags', 'year', 'tape', 'distributor',
                   'tapeLength', 'recordingSpeed', 'condition', 'cassetteNotes',
                   'thumbnail', 'sleeveFront', 'sleeveBack']) {
    if (srcClip[k] != null) entry[k] = srcClip[k];
  }
  // Explicitly NOT copied: youtubeUrl, youtubeId, ytThumbnailDataUrl —
  // the trimmed clip is a fresh artifact. saveSidecarFiles writes JSON
  // + youtube.txt to the new basename so disk + library stay in sync.
  addClip(entry);
  const basename = filename.replace(/\.(webm|mp4)$/, '');
  await saveSidecarFiles(directoryHandle, basename, entry);

  // Copy sleeve JPGs so the trimmed clip carries the same sleeve
  // photos as its parent. Without this, the new clip's sleeve column
  // would be empty even though the source had artwork.
  const srcBasename = srcClip.filename.replace(/\.(webm|mp4)$/, '');
  await copySleeveFiles(srcBasename, basename);

  refreshLibrary();
  // Hop the editor to the new clip — feels more right than leaving
  // the user staring at the old un-trimmed source.
  await loadClipIntoEditor(entry.id);
}

async function persistTrimReplace(srcClip, blob, durationSec, bytes, ext = '.webm') {
  // Most common path: source ext matches new ext (mp4→mp4, webm→webm).
  // Overwrite in place, keep the filename, sidecars and any youtubeUrl
  // reference all stay correctly pointed.
  const srcExt = srcClip.filename.endsWith('.mp4') ? '.mp4' : '.webm';
  const filename = (srcExt === ext)
    ? srcClip.filename
    : srcClip.filename.replace(/\.(webm|mp4)$/, ext);

  const fh = await directoryHandle.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();

  // If the extension changed (rare — only happens when MediaRecorder
  // can't honor the source format and falls through to webm) we now
  // have BOTH the new file and the old file on disk. Delete the
  // stale one so the user doesn't see two copies in the library on
  // resync, and update the catalog filename to match what's now on
  // disk.
  const updates = {
    duration: Math.round(durationSec),
    fileSize: bytes,
  };
  if (filename !== srcClip.filename) {
    try { await directoryHandle.removeEntry(srcClip.filename); }
    catch (e) { console.warn('[trim] could not delete stale source file:', e); }
    updates.filename = filename;
    console.info('[trim] replace produced different ext — moved', {
      from: srcClip.filename, to: filename,
    });
  }
  updateClip(srcClip.id, updates);

  // Re-write the JSON sidecar so the on-disk copy stays in sync with
  // the catalog (otherwise re-import / re-sync would clobber the new
  // duration with the stale one).
  const basename = filename.replace(/\.(webm|mp4)$/, '');
  const updated = (getClips()).find(c => c.id === srcClip.id);
  if (updated) {
    await saveSidecarFiles(directoryHandle, basename, updated);
  }

  refreshLibrary();
  // Reload the editor so the playback element picks up the new file
  // bytes (otherwise the old blob URL still serves the un-trimmed video).
  await loadClipIntoEditor(srcClip.id);
}

// ---------------------------------------------------------------------------
// SHORTS MODE
// ---------------------------------------------------------------------------
//
// Trim's cousin — picks a horizontal CROP (9:16 vertical slice of the
// source) plus a TIME WINDOW (30s default, draggable up to 60s) and
// encodes a 1080×1920 vertical video that uploads as a YouTube Short.
// Always creates a NEW catalog entry with isShort: true; never offers
// to overwrite the source (aspect change makes that semantically wrong).
//
// Encoder is canvas-based:
//   source <video> ──drawImage──▶ <canvas 1080×1920> ──captureStream──▶ ┐
//                                                                       ├──▶ MediaRecorder
//   source <video>.captureStream().getAudioTracks() ─────────────────────┘
// rAF loop pumps each video frame into the canvas at the chosen crop
// offset; canvas captureStream picks up changes; audio track is taken
// straight from the source's captureStream and merged. Real-time wall-
// clock (same as Trim's MediaRecorder path).

let shortsMode = false;
let shortsDuration = 0;       // full source clip duration (seconds)
let shortsIn = 0;             // window start (seconds)
let shortsLengthSec = 30;     // window width (seconds), default 30, max 60
const SHORTS_MIN_LENGTH = 5;
const SHORTS_MAX_LENGTH = 60;
const SHORTS_DEFAULT_LENGTH = 30;
let shortsCropX = 0;          // crop's left X in source-pixel coords
let shortsCropW = 0;          // crop width in source-pixel coords (= 9/16 * srcH)
// When true: skip the 9:16 horizontal crop entirely. The whole source
// frame gets centered in the 1080×1920 output, scaled to fill width,
// with black letterbox bars top + bottom. Useful when composition
// matters more than filling the screen (group shot, full sleeve, etc.).
let shortsLetterbox = false;
let shortsEscHandlerRef = null;
let shortsTimeUpdateRef = null;
let shortsResizeObserver = null;

function exitShortsMode() {
  if (!shortsMode) return;
  shortsMode = false;

  const playback = document.getElementById('playback');
  const panel = document.getElementById('shorts-panel');
  const overlay = document.getElementById('shorts-overlay');
  if (playback) {
    playback.pause();
    playback.setAttribute('controls', '');
    if (shortsTimeUpdateRef) playback.removeEventListener('timeupdate', shortsTimeUpdateRef);
    shortsTimeUpdateRef = null;
  }
  if (panel) panel.classList.add('hidden');
  if (overlay) overlay.classList.add('hidden');

  if (shortsEscHandlerRef) {
    document.removeEventListener('keydown', shortsEscHandlerRef);
    shortsEscHandlerRef = null;
  }
  if (shortsResizeObserver) {
    try { shortsResizeObserver.disconnect(); } catch {}
    shortsResizeObserver = null;
  }

  document.getElementById('shorts-play-icon')?.classList.remove('hidden');
  document.getElementById('shorts-pause-icon')?.classList.add('hidden');
  const playLabel = document.getElementById('shorts-play-label');
  if (playLabel) playLabel.textContent = 'Play';
}

function wireShorts() {
  const shortsBtn = document.getElementById('shorts-recording-btn');
  if (!shortsBtn) return;

  shortsBtn.addEventListener('click', () => {
    if (shortsMode) { exitShortsMode(); return; }
    enterShortsMode();
  });

  wireShortsPanel();
  wireShortsSaveModal();
}

function enterShortsMode() {
  if (!hasPlayback) return;
  const playback = document.getElementById('playback');
  if (!playback) return;

  const startWith = (dur) => {
    if (!isFinite(dur) || dur <= 0) return;
    shortsMode = true;
    shortsDuration = dur;
    shortsIn = 0;
    shortsLengthSec = Math.min(SHORTS_DEFAULT_LENGTH, Math.max(SHORTS_MIN_LENGTH, dur));
    // Reset letterbox to off on each entry. Most uploads will be
    // crop-style; letterbox is the opt-in for "full-frame" cases.
    shortsLetterbox = false;
    const cb = document.getElementById('shorts-letterbox-cb');
    if (cb) cb.checked = false;

    // Default crop: centered horizontally on the source. Computed from
    // the source video's intrinsic dimensions. Updated by drag.
    const srcW = playback.videoWidth || 1280;
    const srcH = playback.videoHeight || 720;
    shortsCropW = Math.floor((9 / 16) * srcH);
    shortsCropX = Math.max(0, Math.floor((srcW - shortsCropW) / 2));

    playback.removeAttribute('controls');
    playback.pause();
    playback.currentTime = 0;

    document.getElementById('shorts-panel').classList.remove('hidden');
    document.getElementById('shorts-overlay').classList.remove('hidden');
    updateShortsUI();
    updateShortsOverlay();
    updateShortsPlayhead();

    shortsEscHandlerRef = (e) => {
      if (e.key === 'Escape') {
        if (e.target?.id === 'shorts-in-input') { e.target.blur(); return; }
        exitShortsMode();
      }
    };
    document.addEventListener('keydown', shortsEscHandlerRef);

    // Scoped playback — clamp inside [shortsIn, shortsIn + shortsLengthSec]
    // and loop on hitting the out edge. Same pattern as Trim.
    shortsTimeUpdateRef = () => {
      const out = shortsIn + shortsLengthSec;
      if (playback.currentTime >= out) {
        playback.pause();
        playback.currentTime = shortsIn;
        document.getElementById('shorts-play-icon')?.classList.remove('hidden');
        document.getElementById('shorts-pause-icon')?.classList.add('hidden');
        const lbl = document.getElementById('shorts-play-label');
        if (lbl) lbl.textContent = 'Play';
      } else if (playback.currentTime < shortsIn) {
        playback.currentTime = shortsIn;
      }
      updateShortsPlayhead();
    };
    playback.addEventListener('timeupdate', shortsTimeUpdateRef);

    // Reposition the crop overlay if the container resizes (window
    // resize, dev-tools open, etc).
    if ('ResizeObserver' in window) {
      shortsResizeObserver = new ResizeObserver(() => updateShortsOverlay());
      const container = document.getElementById('preview-container');
      if (container) shortsResizeObserver.observe(container);
    }
  };

  if (isFinite(playback.duration) && playback.duration > 0) {
    startWith(playback.duration);
  } else {
    const onMeta = () => { startWith(playback.duration); };
    playback.addEventListener('loadedmetadata', onMeta, { once: true });
  }
}

// Compute where the playback video is actually rendered inside its
// container. The element uses object-contain, so the rendered image is
// letterboxed inside the element bounds. Returns the displayed rect in
// container-pixel coordinates.
function getPlaybackDisplayRect() {
  const playback = document.getElementById('playback');
  const container = document.getElementById('preview-container');
  if (!playback || !container) return null;
  const cR = container.getBoundingClientRect();
  const vw = playback.videoWidth || 16;
  const vh = playback.videoHeight || 9;
  const containerW = cR.width;
  const containerH = cR.height;
  const containerAspect = containerW / containerH;
  const videoAspect = vw / vh;
  let dispW, dispH, dispLeft, dispTop;
  if (videoAspect > containerAspect) {
    // Video is wider — letterboxed top + bottom
    dispW = containerW;
    dispH = containerW / videoAspect;
    dispLeft = 0;
    dispTop = (containerH - dispH) / 2;
  } else {
    // Video is taller — pillarboxed left + right
    dispH = containerH;
    dispW = containerH * videoAspect;
    dispTop = 0;
    dispLeft = (containerW - dispW) / 2;
  }
  return { left: dispLeft, top: dispTop, width: dispW, height: dispH, srcW: vw, srcH: vh };
}

// Position the crop overlay frame + dim sides so they align with the
// actual displayed video rect (NOT the full container). Reads the
// current crop X (in source-pixel coords) and converts to display-px.
function updateShortsOverlay() {
  const r = getPlaybackDisplayRect();
  if (!r) return;
  const overlay = document.getElementById('shorts-overlay');
  const left = document.getElementById('shorts-overlay-left');
  const right = document.getElementById('shorts-overlay-right');
  const frame = document.getElementById('shorts-overlay-frame');
  if (!overlay || !left || !right || !frame) return;

  // Letterbox mode: nothing's being cropped, so the red 9:16 frame +
  // dimmed sides are meaningless. Hide them; the "Full frame" checkbox
  // (which lives in the same overlay) communicates the state on its own.
  if (shortsLetterbox) {
    frame.style.display = 'none';
    left.style.display = 'none';
    right.style.display = 'none';
    return;
  }
  frame.style.display = '';
  left.style.display = '';
  right.style.display = '';

  // Clamp crop to source bounds (defensive — drag can push it).
  shortsCropX = Math.max(0, Math.min(r.srcW - shortsCropW, shortsCropX));

  const scale = r.width / r.srcW;
  const cropPxLeft = r.left + shortsCropX * scale;
  const cropPxWidth = shortsCropW * scale;

  frame.style.left = cropPxLeft + 'px';
  frame.style.top = r.top + 'px';
  frame.style.width = cropPxWidth + 'px';
  frame.style.height = r.height + 'px';

  left.style.left = r.left + 'px';
  left.style.top = r.top + 'px';
  left.style.width = (cropPxLeft - r.left) + 'px';
  left.style.height = r.height + 'px';

  right.style.left = (cropPxLeft + cropPxWidth) + 'px';
  right.style.top = r.top + 'px';
  right.style.width = (r.left + r.width - (cropPxLeft + cropPxWidth)) + 'px';
  right.style.height = r.height + 'px';
}

function updateShortsUI() {
  if (!shortsDuration) return;
  const inPct = clampPct((shortsIn / shortsDuration) * 100);
  const outSec = shortsIn + shortsLengthSec;
  const outPct = clampPct((outSec / shortsDuration) * 100);
  const widthPct = outPct - inPct;

  const window = document.getElementById('shorts-band-window');
  const handleR = document.getElementById('shorts-handle-right');
  const bandL = document.getElementById('shorts-band-left');
  const bandR = document.getElementById('shorts-band-right');
  const inputIn = document.getElementById('shorts-in-input');
  const lengthDisp = document.getElementById('shorts-length-display');

  if (window) { window.style.left = inPct + '%'; window.style.width = widthPct + '%'; }
  if (handleR) handleR.style.left = outPct + '%';
  if (bandL) bandL.style.width = inPct + '%';
  if (bandR) bandR.style.width = (100 - outPct) + '%';
  if (inputIn && document.activeElement !== inputIn) inputIn.value = formatTrimTime(shortsIn);
  if (lengthDisp) lengthDisp.textContent = shortsLengthSec.toFixed(1) + 's';
}

function updateShortsPlayhead() {
  if (!shortsDuration) return;
  const playback = document.getElementById('playback');
  const playhead = document.getElementById('shorts-playhead');
  const pos = document.getElementById('shorts-position');
  const t = playback?.currentTime || 0;
  const pct = clampPct((t / shortsDuration) * 100);
  if (playhead) playhead.style.left = pct + '%';
  if (pos) {
    const rel = Math.max(0, t - shortsIn);
    pos.textContent = `${formatTrimTime(rel)} / ${formatTrimTime(shortsLengthSec)}`;
  }
}

function wireShortsPanel() {
  const timeline = document.getElementById('shorts-timeline');
  const window = document.getElementById('shorts-band-window');
  const handleR = document.getElementById('shorts-handle-right');
  const inputIn = document.getElementById('shorts-in-input');
  const playBtn = document.getElementById('shorts-play-btn');
  const cancelBtn = document.getElementById('shorts-cancel-btn');
  const saveBtn = document.getElementById('shorts-save-btn');
  const cropFrame = document.getElementById('shorts-overlay-frame');
  if (!timeline || !window || !handleR) return;

  // Click on track (outside window) → move window so its center lands
  // on click point (clamped to bounds).
  timeline.addEventListener('pointerdown', (e) => {
    if (e.target === window || e.target === handleR) return;
    if (!shortsMode || !shortsDuration) return;
    const rect = timeline.getBoundingClientRect();
    const pct = clampPct(((e.clientX - rect.left) / rect.width) * 100);
    const t = (pct / 100) * shortsDuration;
    // Center the window on click.
    shortsIn = Math.max(0, Math.min(shortsDuration - shortsLengthSec, t - shortsLengthSec / 2));
    updateShortsUI();
    const playback = document.getElementById('playback');
    if (playback) { playback.pause(); playback.currentTime = shortsIn; }
    updateShortsPlayhead();
  });

  // Drag the WINDOW itself → slide it (preserve width).
  window.addEventListener('pointerdown', (e) => {
    if (!shortsMode || !shortsDuration) return;
    e.stopPropagation();
    window.setPointerCapture(e.pointerId);
    const rect = timeline.getBoundingClientRect();
    const startMouseX = e.clientX;
    const startIn = shortsIn;

    const onMove = (ev) => {
      const dx = ev.clientX - startMouseX;
      const dPct = (dx / rect.width) * 100;
      const dSec = (dPct / 100) * shortsDuration;
      shortsIn = Math.max(0, Math.min(shortsDuration - shortsLengthSec, startIn + dSec));
      updateShortsUI();
      const playback = document.getElementById('playback');
      if (playback) { playback.pause(); playback.currentTime = shortsIn; }
      updateShortsPlayhead();
    };
    const onUp = (ev) => {
      try { window.releasePointerCapture(ev.pointerId); } catch {}
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });

  // Drag the right edge → resize window length (5s–60s).
  handleR.addEventListener('pointerdown', (e) => {
    if (!shortsMode || !shortsDuration) return;
    e.stopPropagation();
    handleR.setPointerCapture(e.pointerId);
    const rect = timeline.getBoundingClientRect();
    const onMove = (ev) => {
      const pct = clampPct(((ev.clientX - rect.left) / rect.width) * 100);
      const t = (pct / 100) * shortsDuration;
      const newLen = Math.max(SHORTS_MIN_LENGTH, Math.min(SHORTS_MAX_LENGTH, t - shortsIn));
      // Don't let window extend past source duration.
      shortsLengthSec = Math.min(newLen, shortsDuration - shortsIn);
      updateShortsUI();
      // Preview the new out-edge by jumping playhead there briefly.
      const playback = document.getElementById('playback');
      if (playback) { playback.pause(); playback.currentTime = shortsIn + shortsLengthSec; }
      updateShortsPlayhead();
    };
    const onUp = (ev) => {
      try { handleR.releasePointerCapture(ev.pointerId); } catch {}
      handleR.removeEventListener('pointermove', onMove);
      handleR.removeEventListener('pointerup', onUp);
      handleR.removeEventListener('pointercancel', onUp);
    };
    handleR.addEventListener('pointermove', onMove);
    handleR.addEventListener('pointerup', onUp);
    handleR.addEventListener('pointercancel', onUp);
  });

  // Drag the crop frame on the video → horizontal pan in source-px.
  if (cropFrame) {
    cropFrame.addEventListener('pointerdown', (e) => {
      if (!shortsMode) return;
      e.stopPropagation();
      cropFrame.setPointerCapture(e.pointerId);
      const r = getPlaybackDisplayRect();
      if (!r) return;
      const startMouseX = e.clientX;
      const startCropX = shortsCropX;
      const scale = r.width / r.srcW;
      const onMove = (ev) => {
        const dxPx = ev.clientX - startMouseX;
        const dxSrc = dxPx / scale;
        shortsCropX = Math.max(0, Math.min(r.srcW - shortsCropW, startCropX + dxSrc));
        updateShortsOverlay();
      };
      const onUp = (ev) => {
        try { cropFrame.releasePointerCapture(ev.pointerId); } catch {}
        cropFrame.removeEventListener('pointermove', onMove);
        cropFrame.removeEventListener('pointerup', onUp);
        cropFrame.removeEventListener('pointercancel', onUp);
      };
      cropFrame.addEventListener('pointermove', onMove);
      cropFrame.addEventListener('pointerup', onUp);
      cropFrame.addEventListener('pointercancel', onUp);
    });
  }

  // Start time text input — accepts the same lenient h:mm:ss.s format
  // as Trim's inputs.
  function commitInputIn() {
    if (!shortsMode || !shortsDuration) return;
    const parsed = parseTrimTime(inputIn.value);
    if (parsed === null) {
      inputIn.value = formatTrimTime(shortsIn);
      return;
    }
    shortsIn = Math.max(0, Math.min(shortsDuration - shortsLengthSec, parsed));
    updateShortsUI();
    const playback = document.getElementById('playback');
    if (playback) { playback.pause(); playback.currentTime = shortsIn; }
  }
  inputIn?.addEventListener('blur', commitInputIn);
  inputIn?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); inputIn.blur(); }
  });

  playBtn?.addEventListener('click', () => {
    const playback = document.getElementById('playback');
    if (!playback) return;
    if (playback.paused) {
      const out = shortsIn + shortsLengthSec;
      if (playback.currentTime < shortsIn || playback.currentTime >= out) {
        playback.currentTime = shortsIn;
      }
      playback.play();
      document.getElementById('shorts-play-icon')?.classList.add('hidden');
      document.getElementById('shorts-pause-icon')?.classList.remove('hidden');
      const lbl = document.getElementById('shorts-play-label');
      if (lbl) lbl.textContent = 'Pause';
    } else {
      playback.pause();
      document.getElementById('shorts-play-icon')?.classList.remove('hidden');
      document.getElementById('shorts-pause-icon')?.classList.add('hidden');
      const lbl = document.getElementById('shorts-play-label');
      if (lbl) lbl.textContent = 'Play';
    }
  });

  // Letterbox toggle ("Full frame" checkbox in the bottom-right of the
  // player overlay). When on, the crop UI hides and the encoder uses
  // the full-source-fit-to-width path with vertical black bars.
  const letterboxCb = document.getElementById('shorts-letterbox-cb');
  letterboxCb?.addEventListener('change', () => {
    shortsLetterbox = !!letterboxCb.checked;
    updateShortsOverlay();
  });

  cancelBtn?.addEventListener('click', exitShortsMode);
  saveBtn?.addEventListener('click', openShortsSaveModal);
}

function openShortsSaveModal() {
  if (!shortsMode || !shortsDuration) return;
  const modal = document.getElementById('shorts-save-modal');
  if (!modal) return;
  document.getElementById('shorts-modal-in').textContent = formatTrimTime(shortsIn);
  document.getElementById('shorts-modal-out').textContent = formatTrimTime(shortsIn + shortsLengthSec);
  document.getElementById('shorts-modal-length').textContent = shortsLengthSec.toFixed(1) + 's';
  // Branch the framing-mode line in the modal so the user sees what
  // they're about to commit to.
  const modeEl = document.getElementById('shorts-modal-mode');
  if (modeEl) {
    modeEl.textContent = shortsLetterbox
      ? 'full source frame, letterboxed top + bottom'
      : 'cropped from the highlighted region';
  }
  modal.classList.remove('hidden');
}

function closeShortsSaveModal() {
  document.getElementById('shorts-save-modal')?.classList.add('hidden');
}

function wireShortsSaveModal() {
  const modal = document.getElementById('shorts-save-modal');
  if (!modal) return;
  document.getElementById('shorts-modal-cancel')?.addEventListener('click', closeShortsSaveModal);
  document.getElementById('shorts-modal-confirm')?.addEventListener('click', async () => {
    closeShortsSaveModal();
    await runShortsEncode();
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeShortsSaveModal();
  });
}

// ---------------------------------------------------------------------------
// Shorts encode pipeline — canvas-based, real-time
// ---------------------------------------------------------------------------
async function runShortsEncode() {
  // Snapshot params + clip context BEFORE exiting Shorts mode.
  const inSec = shortsIn;
  const outSec = shortsIn + shortsLengthSec;
  const cropX = shortsCropX;
  const cropW = shortsCropW;
  const letterbox = shortsLetterbox;
  const clipId = lastClipId;
  const clips = getClips();
  const clip = clips.find(c => c.id === clipId);
  if (!clip || !clip.filename) { showErrorToast('Shorts encode failed', 'Clip is missing from the catalog.'); return; }
  if (!directoryHandle) { showErrorToast('Shorts encode failed', 'No save folder selected.'); return; }

  let srcFile;
  try {
    const fh = await directoryHandle.getFileHandle(clip.filename);
    srcFile = await fh.getFile();
  } catch (e) {
    showErrorToast('Shorts encode failed', `Could not read source file (${clip.filename}).`);
    return;
  }

  exitShortsMode();

  // Progress toast.
  const toast = document.getElementById('shorts-progress-toast');
  const posEl = document.getElementById('shorts-progress-position');
  const barEl = document.getElementById('shorts-progress-bar');
  toast?.classList.remove('hidden');
  if (barEl) barEl.style.width = '0%';
  const wantSeconds = Math.max(0.1, outSec - inSec);
  const onProgress = (doneSec, totalSec) => {
    const pct = Math.min(100, (doneSec / totalSec) * 100);
    if (barEl) barEl.style.width = pct + '%';
    if (posEl) posEl.textContent = `${formatTrimTime(doneSec)} of ${formatTrimTime(totalSec)}`;
  };

  let result;
  try {
    result = await encodeShort(srcFile, inSec, outSec, cropX, cropW, letterbox, onProgress);
  } catch (e) {
    console.error('[shorts] encode failed:', e);
    toast?.classList.add('hidden');
    showErrorToast('Shorts encode failed', e.message || 'encoder error');
    return;
  }

  if (!result || !result.blob || result.blob.size === 0) {
    toast?.classList.add('hidden');
    showErrorToast('Shorts encode failed', 'Encoder produced an empty file.');
    return;
  }

  try {
    await persistShortsClip(clip, result.blob, wantSeconds, result.blob.size, result.ext || '.webm');
  } catch (e) {
    console.error('[shorts] persist failed:', e);
    showErrorToast('Shorts saved encode but write failed', e.message);
  } finally {
    toast?.classList.add('hidden');
  }
}

// Canvas-based encoder. Renders either the cropped 9:16 slice of the
// source OR (when letterbox=true) the full source frame fit-to-width
// with vertical black bars onto a 1080×1920 canvas each frame.
// Captures from canvas + audio from source's captureStream and feeds
// both into MediaRecorder.
async function encodeShort(srcFile, inSec, outSec, cropX, cropW, letterbox, onProgress) {
  const sourceUrl = URL.createObjectURL(srcFile);
  const wantSeconds = Math.max(0.1, outSec - inSec);

  // Hidden source <video>. 1×1 in viewport (NOT off-screen) so the
  // browser keeps the rendering pipeline alive — same lesson as the
  // Trim encoder. muted+volume=0 for autoplay + no audible playback.
  const srcVideo = document.createElement('video');
  srcVideo.src = sourceUrl;
  srcVideo.volume = 0;
  srcVideo.muted = true;
  srcVideo.playsInline = true;
  srcVideo.style.cssText = 'position:fixed;bottom:0;right:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;';
  document.body.appendChild(srcVideo);

  // Output canvas — fixed at 1080×1920 regardless of source resolution.
  // YouTube's preferred Shorts dimensions; even a 4:3 480p source
  // upscales here, intentionally — vertical Shorts are universally
  // delivered at this size on mobile.
  const OUT_W = 1080, OUT_H = 1920;
  const canvas = document.createElement('canvas');
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  canvas.style.cssText = 'position:fixed;bottom:0;right:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let recorder = null;
  let rafHandle = 0;
  const cleanup = () => {
    try { srcVideo.pause(); } catch {}
    if (rafHandle) cancelAnimationFrame(rafHandle);
    URL.revokeObjectURL(sourceUrl);
    srcVideo.remove();
    canvas.remove();
    activeTrimRecorder = null;
  };

  try {
    await new Promise((resolve) => {
      if (isFinite(srcVideo.duration) && srcVideo.duration > 0) resolve();
      else srcVideo.addEventListener('loadedmetadata', resolve, { once: true });
    });

    const srcW = srcVideo.videoWidth || 1280;
    const srcH = srcVideo.videoHeight || 720;
    // Clamp crop to source bounds defensively (only used in crop mode).
    const safeCropX = Math.max(0, Math.min(srcW - cropW, cropX));

    // Letterbox layout precomputed once. We fit source horizontally
    // (full 1080 width), scale height proportionally, center vertically.
    // Black bars top + bottom. drawImage uses these in the rAF loop.
    const lbScale = OUT_W / srcW;
    const lbScaledH = srcH * lbScale;
    const lbOffsetY = Math.round((OUT_H - lbScaledH) / 2);

    // MIME negotiation. Output is always WebM for Shorts (Chrome's
    // canvas captureStream pairs cleanly with vp9/vp8). MP4 from
    // canvas captureStream is unreliable across versions.
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error('No supported MediaRecorder MIME type for Shorts.');

    // Pull audio from the source via its own captureStream. Combine
    // canvas video + source audio into one MediaStream for the
    // recorder. captureStream() requires the source to be playing for
    // tracks to flow — we play() below.
    let srcStream;
    try { srcStream = srcVideo.captureStream(); }
    catch (e) { throw new Error('Source captureStream() unavailable: ' + e.message); }
    const audioTracks = srcStream.getAudioTracks();

    const canvasStream = canvas.captureStream(30); // 30fps draw
    const combined = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...audioTracks,
    ]);

    recorder = new MediaRecorder(combined, { mimeType: mime });
    activeTrimRecorder = recorder;
    const chunks = [];
    recorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    });
    recorder.addEventListener('error', (e) => {
      console.warn('[shorts] MediaRecorder error:', e.error || e);
    });

    // Seek to in.
    await new Promise((resolve, reject) => {
      const onSeeked = () => { srcVideo.removeEventListener('seeked', onSeeked); resolve(); };
      srcVideo.addEventListener('seeked', onSeeked);
      try { srcVideo.currentTime = inSec; } catch (e) { reject(e); }
    });

    try { await srcVideo.play(); }
    catch (e) { throw new Error('Could not play source: ' + e.message); }
    // Tiny grace for first frame to be ready.
    await new Promise((r) => setTimeout(r, 80));

    // rAF draw loop — paints the cropped slice onto the canvas every
    // frame. Started before recorder.start() so the canvas already has
    // pixels by the time recording begins (avoids a few empty frames
    // at the head of the output).
    let stopped = false;
    const draw = () => {
      if (stopped) return;
      try {
        if (letterbox) {
          // Full source frame, fit-to-width, vertically centered. Paint
          // the black bars first so partial draws don't show source
          // bleed at the edges.
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, OUT_W, OUT_H);
          ctx.drawImage(srcVideo,
            0, 0, srcW, srcH,
            0, lbOffsetY, OUT_W, lbScaledH);
        } else {
          // Crop mode: 9:16 slice from (cropX, 0) → fills full canvas.
          ctx.drawImage(srcVideo,
            safeCropX, 0, cropW, srcH,
            0, 0, OUT_W, OUT_H);
        }
      } catch {
        // drawImage can throw if the source isn't ready yet — ignore.
      }
      rafHandle = requestAnimationFrame(draw);
    };
    draw();
    // One more grace period so the canvas has a stable image before
    // recording starts. Without this, the first ~150ms of the Short
    // can be a blank frame.
    await new Promise((r) => setTimeout(r, 100));

    recorder.start(250);

    const finalize = () => new Promise((resolve) => {
      if (stopped) return resolve();
      stopped = true;
      recorder.addEventListener('stop', resolve, { once: true });
      try { recorder.stop(); } catch {}
      try { srcVideo.pause(); } catch {}
    });

    const onTime = async () => {
      const done = Math.max(0, srcVideo.currentTime - inSec);
      onProgress(done, wantSeconds);
      if (srcVideo.currentTime >= outSec) {
        srcVideo.removeEventListener('timeupdate', onTime);
        await finalize();
      }
    };
    srcVideo.addEventListener('timeupdate', onTime);

    const failsafe = setTimeout(async () => {
      if (!stopped) {
        console.warn('[shorts] failsafe timer fired');
        srcVideo.removeEventListener('timeupdate', onTime);
        await finalize();
      }
    }, Math.ceil(wantSeconds * 1.5 * 1000) + 5000);

    await new Promise((resolve) => {
      const check = () => { if (stopped) resolve(); else setTimeout(check, 100); };
      check();
    });
    clearTimeout(failsafe);

    const totalBytes = chunks.reduce((s, c) => s + c.size, 0);
    console.info('[shorts] encode finished', { chunkCount: chunks.length, totalBytes, mime });
    cleanup();
    if (totalBytes === 0) throw new Error('Encoder produced no data.');

    return { blob: new Blob(chunks, { type: mime }), mime, ext: '.webm' };
  } catch (e) {
    cleanup();
    throw e;
  }
}

async function persistShortsClip(srcClip, blob, durationSec, bytes, ext) {
  // Filename: original basename + "_short" suffix, with collision
  // protection via the existing helper.
  const filename = await pickAvailableFilename(srcClip.filename, 'short', ext);
  const fh = await directoryHandle.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();

  // New catalog entry. createClipEntry generates a fresh ID + sets
  // isShort: false by default; we override to true here. Inherits
  // the source's tape-level metadata (year, distributor, etc.) so the
  // user doesn't re-type — same pattern as Trim's "Create new clip".
  // youtubeUrl/youtubeId/ytThumbnailDataUrl explicitly NOT cloned —
  // the Short is its own upload artifact.
  const entry = createClipEntry(
    `${srcClip.title || 'Untitled'} (Short)`,
    filename,
    Math.round(durationSec),
    bytes,
    srcClip.bitrate || 0,
  );
  entry.isShort = true;
  for (const k of ['description', 'tags', 'year', 'tape', 'distributor',
                   'tapeLength', 'recordingSpeed', 'condition', 'cassetteNotes',
                   'thumbnail', 'sleeveFront', 'sleeveBack']) {
    if (srcClip[k] != null) entry[k] = srcClip[k];
  }
  addClip(entry);
  const basename = filename.replace(/\.(webm|mp4)$/, '');
  await saveSidecarFiles(directoryHandle, basename, entry);

  // Sleeve copy — Shorts inherit the parent tape's sleeve photos.
  const srcBasename = srcClip.filename.replace(/\.(webm|mp4)$/, '');
  await copySleeveFiles(srcBasename, basename);

  refreshLibrary();
  // Hop the editor to the new Short so the user can review/upload it.
  await loadClipIntoEditor(entry.id);
}

function showPlaybackTab() {
  const preview = document.getElementById('preview');
  const playback = document.getElementById('playback');
  const deleteBtn = document.getElementById('delete-recording-btn');
  const trimBtn = document.getElementById('trim-recording-btn');
  const shortsBtn = document.getElementById('shorts-recording-btn');

  previewMode = 'playback';
  hasPlayback = true;

  preview.classList.add('hidden');
  preview.muted = true;
  playback.classList.remove('hidden');
  deleteBtn.classList.remove('hidden');
  // Trim + Shorts buttons mirror Delete's visibility — only meaningful
  // when there's a playback loaded. Both flip off in showLiveTab().
  trimBtn?.classList.remove('hidden');
  shortsBtn?.classList.remove('hidden');
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
  const trimBtn = document.getElementById('trim-recording-btn');
  const shortsBtn = document.getElementById('shorts-recording-btn');

  previewMode = 'live';

  // If we're switching to Live while inside Trim or Shorts mode, bail
  // out of those cleanly first so the playback element gets its
  // native controls back and the panels hide.
  if (typeof exitTrimMode === 'function') exitTrimMode();
  if (typeof exitShortsMode === 'function') exitShortsMode();

  playback.classList.add('hidden');
  preview.classList.remove('hidden');
  deleteBtn.classList.add('hidden');
  trimBtn?.classList.add('hidden');
  shortsBtn?.classList.add('hidden');
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
