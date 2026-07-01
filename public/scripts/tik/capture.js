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
