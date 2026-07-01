// Load a local video file into a <video> element and grab frames from it.
// Browser-only (uses URL, canvas, createImageBitmap). Verified manually.

let objectUrl = null;

// Point the <video> at a local File. Resolves once metadata (dimensions,
// duration) is known. Rejects if the browser can't decode the file.
export function loadVideoFile(file, videoEl) {
  return new Promise((resolve, reject) => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    videoEl.src = objectUrl;
    videoEl.onloadedmetadata = () => resolve({
      duration: videoEl.duration,
      width: videoEl.videoWidth,
      height: videoEl.videoHeight,
    });
    videoEl.onerror = () =>
      reject(new Error("This browser can't decode that video file."));
  });
}

// Seek `video` to `seconds` and resolve once the frame has settled ('seeked'),
// racing a timeout so a stalled decode can never hang the caller, plus a
// one-shot 'error' listener that rejects. Clamps to [0, duration].
export function seekAndSettle(video, seconds, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const target = Math.min(Math.max(0, seconds), video.duration || seconds);
    if (Math.abs(video.currentTime - target) < 0.05 && !video.seeking) return resolve();
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('Video decode error while seeking.')); };
    timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs); // give up waiting; use current frame
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    video.currentTime = target;
  });
}

// Wait for an in-flight seek to settle before grabbing, so a manual grab
// captures the displayed frame, not the pre-seek one. Resolves immediately if
// not seeking; bounded by a timeout so a stuck seek never hangs the UI.
export function awaitSeekSettled(video, timeoutMs = 1500) {
  if (!video.seeking) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const done = () => { clearTimeout(timer); video.removeEventListener('seeked', done); resolve(); };
    timer = setTimeout(done, timeoutMs);
    video.addEventListener('seeked', done);
  });
}

// Draw the current video frame to an offscreen canvas and return an ImageBitmap
// at the source's native resolution.
export async function grabFrame(videoEl) {
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;
  if (!w || !h) throw new Error('No video frame available yet.');
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(videoEl, 0, 0, w, h);
  return await createImageBitmap(canvas);
}
