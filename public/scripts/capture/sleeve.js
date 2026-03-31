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
  document.getElementById('sleeve-capture-btn').textContent = 'Capture Front';
  document.getElementById('sleeve-front-preview').innerHTML = '<span class="text-white/10 text-[10px]">—</span>';
  document.getElementById('sleeve-back-preview').innerHTML = '<span class="text-white/10 text-[10px]">—</span>';
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
  const btn = document.getElementById('sleeve-capture-btn');

  if (sleeveState === 'idle') {
    frontData = capturePhoto();
    document.getElementById('sleeve-front-preview').innerHTML = `<img src="${frontData}" class="w-full h-full object-contain" alt="Front">`;
    document.getElementById('sleeve-front-status').textContent = 'Front ✓';
    sleeveState = 'front_captured';
    btn.textContent = 'Flip & Capture Back';
  } else if (sleeveState === 'front_captured') {
    backData = capturePhoto();
    document.getElementById('sleeve-back-preview').innerHTML = `<img src="${backData}" class="w-full h-full object-contain" alt="Back">`;
    document.getElementById('sleeve-back-status').textContent = 'Back ✓';
    sleeveState = 'done';
    btn.textContent = 'Retake';
  } else if (sleeveState === 'done') {
    resetSleeve();
  }
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
