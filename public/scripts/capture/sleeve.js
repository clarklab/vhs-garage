import { openWebcamStream } from './devices.js';

let webcamStream = null;

export async function openSleeveModal(webcamDeviceId) {
  const modal = document.getElementById('sleeve-modal');
  const video = document.getElementById('sleeve-webcam');

  try {
    webcamStream = await openWebcamStream(webcamDeviceId);
    video.srcObject = webcamStream;
    modal.classList.remove('hidden');
  } catch (err) {
    alert('Could not open webcam. Check that it is connected.');
  }
}

export function closeSleeveModal() {
  const modal = document.getElementById('sleeve-modal');
  const video = document.getElementById('sleeve-webcam');

  if (webcamStream) {
    webcamStream.getTracks().forEach(t => t.stop());
    webcamStream = null;
  }
  video.srcObject = null;
  modal.classList.add('hidden');
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

export function showPreview(side, dataUrl) {
  const container = document.getElementById(`sleeve-${side}-preview`);
  container.innerHTML = `<img src="${dataUrl}" class="w-full h-full object-contain" alt="${side}">`;
}

export function clearPreviews() {
  document.getElementById('sleeve-front-preview').innerHTML = '<span class="text-white/10 text-xs">—</span>';
  document.getElementById('sleeve-back-preview').innerHTML = '<span class="text-white/10 text-xs">—</span>';
}

export async function saveSleevePhoto(directoryHandle, basename, side, dataUrl) {
  const filename = `${basename}_${side}.jpg`;
  const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();

  const response = await fetch(dataUrl);
  const blob = await response.blob();
  await writable.write(blob);
  await writable.close();
}
