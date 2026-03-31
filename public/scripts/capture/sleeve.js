import { openWebcamStream } from './devices.js';

let webcamStream = null;
let sleeveState = 'idle'; // idle | front_captured | done
let frontData = null;
let backData = null;

export function getSleeveData() {
  return { front: frontData, back: backData };
}

export function resetSleeve() {
  sleeveState = 'idle';
  frontData = null;
  backData = null;

  // Show capture view, hide review view
  const captureView = document.getElementById('sleeve-capture-view');
  const reviewView = document.getElementById('sleeve-review-view');
  if (captureView) captureView.classList.remove('hidden');
  if (reviewView) reviewView.classList.add('hidden');

  const label = document.getElementById('sleeve-capture-label');
  if (label) label.textContent = 'Capture Front';

  document.getElementById('sleeve-front-preview').innerHTML = '<span class="text-white/10 text-[10px]">--</span>';
  document.getElementById('sleeve-back-preview').innerHTML = '<span class="text-white/10 text-[10px]">--</span>';
  document.getElementById('sleeve-front-status').textContent = 'Front';
  document.getElementById('sleeve-back-status').textContent = 'Back';
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
    document.getElementById('sleeve-target').classList.remove('hidden');
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
  const label = document.getElementById('sleeve-capture-label');

  if (sleeveState === 'idle') {
    // Capture front photo
    frontData = capturePhoto();
    document.getElementById('sleeve-front-preview').innerHTML = `<img src="${frontData}" class="w-full h-full object-contain" alt="Front">`;
    document.getElementById('sleeve-front-status').textContent = 'Front \u2713';
    sleeveState = 'front_captured';
    label.textContent = 'Flip & Capture Back';
    return { captured: 'front', data: frontData };
  } else if (sleeveState === 'front_captured') {
    // Capture back photo, then switch to review view
    backData = capturePhoto();
    document.getElementById('sleeve-back-preview').innerHTML = `<img src="${backData}" class="w-full h-full object-contain" alt="Back">`;
    document.getElementById('sleeve-back-status').textContent = 'Back \u2713';
    sleeveState = 'done';

    // Switch to review view
    captureView.classList.add('hidden');
    reviewView.classList.remove('hidden');
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
