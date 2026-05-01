import { openWebcamStream } from './devices.js';

let webcamStream = null;
let sleeveState = 'idle'; // idle | front_captured | done
let frontData = null;
let backData = null;

export function getSleeveData() {
  return { front: frontData, back: backData };
}

export function getSleeveState() {
  return sleeveState;
}

export function getVideoElement() {
  return document.getElementById('sleeve-webcam');
}

// Shutter click via Web Audio API — no external files needed
export function playShutter() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const buf = ac.createBuffer(1, ac.sampleRate * 0.08, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const t = i / ac.sampleRate;
      data[i] = (Math.random() * 2 - 1) * Math.exp(-t * 80) * 0.3;
    }
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(ac.destination);
    src.start();
    src.onended = () => ac.close();
  } catch (e) {}
}

// Compute target zone pixel coordinates from video dimensions
export function getTargetRect() {
  const video = document.getElementById('sleeve-webcam');
  if (!video || !video.videoWidth || !video.videoHeight) return null;
  const vh = video.videoHeight;
  const vw = video.videoWidth;
  const h = vh * 0.7;
  const w = h * (17 / 30);
  const x = (vw - w) / 2;
  const y = (vh - h) / 2;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

export function resetSleeve() {
  sleeveState = 'idle';
  frontData = null;
  backData = null;

  // Reset UI — show webcam for front capture, back skeleton as placeholder
  const captureView = document.getElementById('sleeve-capture-view');
  const reviewView = document.getElementById('sleeve-review-view');
  const frontSection = document.getElementById('sleeve-front-section');
  const backSection = document.getElementById('sleeve-back-section');
  const backSkeleton = document.getElementById('sleeve-back-skeleton');

  if (captureView) captureView.classList.remove('hidden');
  if (reviewView) reviewView.classList.add('hidden');

  // Reset front preview
  const frontPreview = document.getElementById('sleeve-front-preview');
  frontPreview.innerHTML = '<span class="flex items-center justify-center w-full h-full text-white/10 text-[10px]">--</span>';
  frontPreview.classList.add('hidden');

  // Show back skeleton, hide back preview
  const backPreview = document.getElementById('sleeve-back-preview');
  backPreview.innerHTML = '<span class="flex items-center justify-center w-full h-full text-white/10 text-[10px]">--</span>';
  backPreview.classList.add('hidden');
  if (backSkeleton) backSkeleton.classList.remove('hidden');

  const label = document.getElementById('sleeve-capture-label');
  if (label) label.textContent = 'Capture Front';

  // Put webcam between front and back sections — front is where capture is aimed
  if (frontSection && captureView && backSection) {
    frontSection.parentNode.insertBefore(captureView, backSection);
  }
}

// Re-hydrate the sleeve panel from stored data URLs (e.g. when re-opening a
// clip from the library). Mirrors the UI state the user would land on if they
// had captured both/one image fresh, and updates the module-level state so
// Retake / Capture Back behave correctly afterward.
export function restoreSleeve(front, back) {
  // Start from a clean slate (also resets DOM positions).
  resetSleeve();
  if (!front && !back) return;

  frontData = front || null;
  backData = back || null;

  const captureView = document.getElementById('sleeve-capture-view');
  const reviewView = document.getElementById('sleeve-review-view');
  const backSection = document.getElementById('sleeve-back-section');
  const backSkeleton = document.getElementById('sleeve-back-skeleton');
  const frontPreview = document.getElementById('sleeve-front-preview');
  const backPreview = document.getElementById('sleeve-back-preview');
  const label = document.getElementById('sleeve-capture-label');

  if (front && frontPreview) {
    frontPreview.innerHTML = `<img src="${front}" class="w-full h-full object-contain" alt="Front">`;
    frontPreview.classList.remove('hidden');
  }

  if (back) {
    // Both captured — collapse to the "done" state: hide the live webcam,
    // show the back preview, and reveal the Retake button.
    sleeveState = 'done';
    if (backPreview) {
      backPreview.innerHTML = `<img src="${back}" class="w-full h-full object-contain" alt="Back">`;
      backPreview.classList.remove('hidden');
    }
    if (backSkeleton) backSkeleton.classList.add('hidden');
    if (captureView) captureView.classList.add('hidden');
    if (reviewView) reviewView.classList.remove('hidden');
  } else if (front) {
    // Front-only — sit at the "front_captured" mid-state with the webcam
    // moved into the back slot, ready for the user to capture the back.
    sleeveState = 'front_captured';
    if (label) label.textContent = 'Capture Back';
    if (backSkeleton) backSkeleton.classList.add('hidden');
    if (backSection && captureView) {
      backSection.appendChild(captureView);
    }
  }
}

export async function initWebcam(deviceId) {
  if (webcamStream) {
    webcamStream.getTracks().forEach(t => t.stop());
  }
  try {
    webcamStream = await openWebcamStream(deviceId);
    const video = document.getElementById('sleeve-webcam');
    video.srcObject = webcamStream;
    document.getElementById('no-webcam').classList.add('hidden');
    // Reveal the rectangle-detector overlay group: target reticle, top HUD,
    // and the snap-progress bar. All three are hidden by default in markup
    // so they don't overlap the "No webcam" empty-state placeholder before
    // a webcam is connected.
    document.getElementById('sleeve-target').classList.remove('hidden');
    document.getElementById('detect-hud')?.classList.remove('hidden');
    document.getElementById('detect-snap-bar')?.classList.remove('hidden');
  } catch (err) {
    console.warn('Could not open webcam:', err);
  }
}

export function stopWebcam() {
  if (webcamStream) {
    webcamStream.getTracks().forEach(t => t.stop());
    webcamStream = null;
  }
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

export function handleSleeveCapture() {
  const captureView = document.getElementById('sleeve-capture-view');
  const reviewView = document.getElementById('sleeve-review-view');
  const backSection = document.getElementById('sleeve-back-section');
  const backSkeleton = document.getElementById('sleeve-back-skeleton');
  const label = document.getElementById('sleeve-capture-label');

  if (sleeveState === 'idle') {
    // Capture front photo
    frontData = capturePhoto();

    // Show front preview (it replaces the webcam visually in the front slot)
    const frontPreview = document.getElementById('sleeve-front-preview');
    frontPreview.innerHTML = `<img src="${frontData}" class="w-full h-full object-contain" alt="Front">`;
    frontPreview.classList.remove('hidden');

    sleeveState = 'front_captured';
    label.textContent = 'Capture Back';

    // Move the live webcam INTO the back section (takes over the skeleton's
    // slot) so the webcam visibly fills the "Back" position it's now capturing.
    if (backSection && backSkeleton) {
      backSkeleton.classList.add('hidden');
      backSection.appendChild(captureView);
    }

    return { captured: 'front', data: frontData };
  } else if (sleeveState === 'front_captured') {
    // Capture back photo
    backData = capturePhoto();

    // Show back preview, hide webcam, show retake
    const backPreview = document.getElementById('sleeve-back-preview');
    backPreview.innerHTML = `<img src="${backData}" class="w-full h-full object-contain" alt="Back">`;
    backPreview.classList.remove('hidden');

    captureView.classList.add('hidden');
    reviewView.classList.remove('hidden');
    sleeveState = 'done';

    return { captured: 'back', data: backData };
  }
  return null;
}

export function handleSleeveRetake() {
  resetSleeve();
}

export async function saveSleevePhotos(directoryHandle, basename) {
  if (frontData) {
    try {
      const fh = await directoryHandle.getFileHandle(`${basename}_front.jpg`, { create: true });
      const w = await fh.createWritable();
      const res = await fetch(frontData);
      await w.write(await res.blob());
      await w.close();
    } catch {}
  }
  if (backData) {
    try {
      const fh = await directoryHandle.getFileHandle(`${basename}_back.jpg`, { create: true });
      const w = await fh.createWritable();
      const res = await fetch(backData);
      await w.write(await res.blob());
      await w.close();
    } catch {}
  }
}
