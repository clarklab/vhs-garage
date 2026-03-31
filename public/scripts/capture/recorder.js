let mediaRecorder = null;
let writableStream = null;
let startTime = 0;
let totalBytes = 0;
let onTickCallback = null;
let onStopCallback = null;
let timerInterval = null;

export function isRecording() {
  return mediaRecorder && mediaRecorder.state === 'recording';
}

export function getElapsed() {
  if (!startTime) return 0;
  return Math.floor((Date.now() - startTime) / 1000);
}

export function getTotalBytes() {
  return totalBytes;
}

export async function startRecording(stream, directoryHandle, filename, bitrate, { onTick, onStop, onError }) {
  onTickCallback = onTick;
  onStopCallback = onStop;
  totalBytes = 0;

  const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
  writableStream = await fileHandle.createWritable();

  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';

  mediaRecorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: bitrate,
  });

  mediaRecorder.ondataavailable = async (event) => {
    if (event.data.size > 0) {
      try {
        await writableStream.write(event.data);
        totalBytes += event.data.size;
      } catch (err) {
        if (onError) onError(err);
        stopRecording();
      }
    }
  };

  mediaRecorder.onstop = async () => {
    clearInterval(timerInterval);
    try {
      await writableStream.close();
    } catch {}
    writableStream = null;
    const elapsed = getElapsed();
    startTime = 0;
    if (onStopCallback) onStopCallback({ duration: elapsed, fileSize: totalBytes });
  };

  startTime = Date.now();
  mediaRecorder.start(1000);

  timerInterval = setInterval(() => {
    if (onTickCallback) onTickCallback({ elapsed: getElapsed(), bytes: totalBytes });
  }, 500);
}

export function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

export function formatTime(seconds) {
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function formatSize(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export function generateFilename(title, nameFormat) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');

  if (nameFormat === 'timestamp' || !title.trim()) {
    return `VHS_Capture_${date}_${time}.webm`;
  }

  const sanitized = title.trim().replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '_');
  return `${sanitized}_${date}_${time}.webm`;
}
