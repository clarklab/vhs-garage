// Auto-snap detector for VHS sleeve capture
// Analyzes webcam frames for: presence (edge density), stability (frame diff), sharpness (Laplacian)
// Zero dependencies — pure Canvas pixel analysis

const INTERVAL_MS = 100;
const CONSECUTIVE_REQUIRED = 5; // ~500ms of all-pass
const SAMPLE_W = 200;
const SAMPLE_H = 350;

// Thresholds (tunable)
const EDGE_THRESHOLD = 0.12;    // fraction of max possible gradient
const STABILITY_THRESHOLD = 6;  // mean pixel diff (0-255)
const SHARPNESS_THRESHOLD = 80; // Laplacian variance

let running = false;
let rafId = null;
let lastTime = 0;
let consecutivePasses = 0;
let prevGray = null;
let canvas = null;
let ctx = null;
let onSnapCallback = null;
let onStateCallback = null;
let videoEl = null;
let targetRect = null;

// States: 'idle' | 'detected' | 'capturing' | 'snapped'
let detectionState = 'idle';

function setState(state) {
  if (state !== detectionState) {
    detectionState = state;
    if (onStateCallback) onStateCallback(state);
  }
}

export function startDetection(video, rect, onSnap, onState) {
  videoEl = video;
  targetRect = rect;
  onSnapCallback = onSnap;
  onStateCallback = onState;
  running = true;
  consecutivePasses = 0;
  prevGray = null;
  detectionState = 'idle';

  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = SAMPLE_W;
    canvas.height = SAMPLE_H;
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }

  lastTime = 0;
  loop(0);
}

export function stopDetection() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  consecutivePasses = 0;
  prevGray = null;
  setState('idle');
}

export function pauseDetection() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

export function resumeDetection() {
  if (!videoEl || !targetRect || !onSnapCallback) return;
  running = true;
  consecutivePasses = 0;
  prevGray = null;
  setState('idle');
  lastTime = 0;
  loop(0);
}

function loop(timestamp) {
  if (!running) return;
  rafId = requestAnimationFrame(loop);

  if (timestamp - lastTime < INTERVAL_MS) return;
  lastTime = timestamp;

  if (!videoEl.videoWidth || !videoEl.videoHeight) return;

  // Sample the target zone
  const { x, y, w, h } = targetRect;
  ctx.drawImage(videoEl, x, y, w, h, 0, 0, SAMPLE_W, SAMPLE_H);
  const imageData = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
  const gray = toGrayscale(imageData.data, SAMPLE_W, SAMPLE_H);

  const edgeDensity = computeEdgeDensity(gray, SAMPLE_W, SAMPLE_H);
  const stability = prevGray ? computeStability(gray, prevGray) : 999;
  const sharpness = computeSharpness(gray, SAMPLE_W, SAMPLE_H);

  prevGray = gray;

  const presenceOk = edgeDensity > EDGE_THRESHOLD;
  const stableOk = stability < STABILITY_THRESHOLD;
  const sharpOk = sharpness > SHARPNESS_THRESHOLD;

  // Debug (uncomment to tune thresholds):
  // console.log(`edge:${edgeDensity.toFixed(3)} stable:${stability.toFixed(1)} sharp:${sharpness.toFixed(0)} pass:${presenceOk&&stableOk&&sharpOk}`);

  if (presenceOk && stableOk && sharpOk) {
    consecutivePasses++;
    if (consecutivePasses >= CONSECUTIVE_REQUIRED) {
      setState('snapped');
      pauseDetection();
      if (onSnapCallback) onSnapCallback();
      return;
    }
    setState('capturing');
  } else if (presenceOk) {
    consecutivePasses = 0;
    setState('detected');
  } else {
    consecutivePasses = 0;
    setState('idle');
  }
}

// --- Pixel math ---

function toGrayscale(rgba, w, h) {
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    gray[i] = (r * 77 + g * 150 + b * 29) >> 8;
  }
  return gray;
}

function computeEdgeDensity(gray, w, h) {
  // Simplified Sobel — horizontal + vertical gradient magnitude
  let sum = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const gx = Math.abs(gray[idx + 1] - gray[idx - 1]);
      const gy = Math.abs(gray[idx + w] - gray[idx - w]);
      sum += gx + gy;
      count++;
    }
  }
  // Normalize: max possible per pixel is 510 (255*2)
  return sum / (count * 510);
}

function computeStability(current, previous) {
  // Mean absolute difference between frames
  let sum = 0;
  for (let i = 0; i < current.length; i++) {
    sum += Math.abs(current[i] - previous[i]);
  }
  return sum / current.length;
}

function computeSharpness(gray, w, h) {
  // Laplacian variance — classic focus measure
  // Laplacian kernel: center = -4, neighbors = 1
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const lap = gray[idx - 1] + gray[idx + 1] + gray[idx - w] + gray[idx + w] - 4 * gray[idx];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  const mean = sum / count;
  return (sumSq / count) - (mean * mean); // variance
}
