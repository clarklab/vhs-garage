// Auto-snap detector for VHS sleeve capture
// Uses jscanify (OpenCV.js) for paper/document detection
// Simply: does jscanify find a paper? Is it big enough? Is the scene stable? → snap

const INTERVAL_MS = 150;
const CONSECUTIVE_REQUIRED = 3;    // ~450ms of stable detection
const STABILITY_THRESHOLD = 8;     // mean pixel diff — webcams have noise
const MIN_AREA_RATIO = 0.08;       // contour must fill 8% of frame
const SAMPLE_W = 320;
const SAMPLE_H = 240;

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
let cvReady = false;
let cvLoading = false;
let scanner = null; // jscanify instance

let detectionState = 'idle';

function setState(state, progress) {
  detectionState = state;
  if (onStateCallback) onStateCallback(state, progress || 0);
}

// --- Load OpenCV.js from CDN ---
function loadOpenCV() {
  return new Promise((resolve, reject) => {
    if (typeof cv !== 'undefined' && cv.Mat) { resolve(); return; }
    if (cvLoading) {
      const poll = setInterval(() => {
        if (typeof cv !== 'undefined' && cv.Mat) { clearInterval(poll); resolve(); }
      }, 200);
      return;
    }
    cvLoading = true;
    console.log('[detector] Loading OpenCV.js...');
    const script = document.createElement('script');
    script.src = 'https://docs.opencv.org/4.9.0/opencv.js';
    script.async = true;
    script.onload = () => {
      if (typeof cv === 'object' && cv.then) {
        cv.then((instance) => { window.cv = instance; resolve(); });
      } else if (typeof cv !== 'undefined' && !cv.Mat) {
        cv.onRuntimeInitialized = () => resolve();
      } else if (typeof cv !== 'undefined' && cv.Mat) {
        resolve();
      } else {
        reject(new Error('OpenCV.js failed'));
      }
    };
    script.onerror = () => reject(new Error('Failed to load OpenCV.js'));
    document.head.appendChild(script);
  });
}

// --- Use jscanify's findPaperContour approach ---
function detectPaper() {
  if (!cvReady) return false;

  ctx.drawImage(videoEl, 0, 0, SAMPLE_W, SAMPLE_H);
  let src = null;
  try {
    src = cv.imread(canvas);

    // Use jscanify's exact pipeline: Canny → blur → Otsu → findContours
    const gray = new cv.Mat();
    cv.Canny(src, gray, 50, 200);

    const blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);

    const thresh = new cv.Mat();
    cv.threshold(blurred, thresh, 0, 255, cv.THRESH_OTSU);

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(thresh, contours, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE);

    // Find the largest contour
    let maxArea = 0;
    let maxIdx = -1;
    for (let i = 0; i < contours.size(); i++) {
      const area = cv.contourArea(contours.get(i));
      if (area > maxArea) { maxArea = area; maxIdx = i; }
    }

    const frameArea = SAMPLE_W * SAMPLE_H;
    let found = false;

    // Debug: see what's being detected
    if (maxIdx >= 0) {
      const contour = contours.get(maxIdx);
      const approx = new cv.Mat();
      const peri = cv.arcLength(contour, true);
      // Check rectangularity: contour area vs bounding rect area
      const contour = contours.get(maxIdx);
      const rect = cv.boundingRect(contour);
      const boundingArea = rect.width * rect.height;
      const rectangularity = maxArea / boundingArea;
      console.log(`[detect] area=${maxArea.toFixed(0)} (${(maxArea/frameArea*100).toFixed(1)}%) rect=${rectangularity.toFixed(2)} bbox=${rect.width}x${rect.height}`);
    }

    if (maxIdx >= 0 && maxArea > frameArea * MIN_AREA_RATIO) {
      // Rectangularity test: a real box fills 80%+ of its bounding rectangle
      // A face/organic shape fills 50-70%
      const contour = contours.get(maxIdx);
      const rect = cv.boundingRect(contour);
      const boundingArea = rect.width * rect.height;
      const rectangularity = maxArea / boundingArea;

      if (rectangularity > 0.8) {
        found = true;
      }
    }

    gray.delete();
    blurred.delete();
    thresh.delete();
    contours.delete();
    hierarchy.delete();
    src.delete();
    src = null;

    return found;
  } catch (e) {
    console.warn('[detector] error:', e.message);
    if (src) src.delete();
    return false;
  }
}

// --- Stability check ---
function checkStability() {
  ctx.drawImage(videoEl, 0, 0, SAMPLE_W, SAMPLE_H);
  const imageData = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
  const gray = new Uint8Array(SAMPLE_W * SAMPLE_H);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = (imageData.data[i * 4] * 77 + imageData.data[i * 4 + 1] * 150 + imageData.data[i * 4 + 2] * 29) >> 8;
  }
  let diff = 999;
  if (prevGray) {
    let sum = 0;
    for (let i = 0; i < gray.length; i++) sum += Math.abs(gray[i] - prevGray[i]);
    diff = sum / gray.length;
  }
  prevGray = gray;
  return diff;
}

// --- Main loop ---
function loop(timestamp) {
  if (!running) return;
  rafId = requestAnimationFrame(loop);

  if (timestamp - lastTime < INTERVAL_MS) return;
  lastTime = timestamp;

  if (!videoEl.videoWidth || !videoEl.videoHeight) return;

  const hasPaper = detectPaper();
  const stability = checkStability();
  const stableOk = stability < STABILITY_THRESHOLD;

  console.log(`paper:${hasPaper} stable:${stability.toFixed(1)} | paper:${hasPaper} stable:${stableOk}`);

  if (hasPaper && stableOk) {
    consecutivePasses++;
    const progress = consecutivePasses / CONSECUTIVE_REQUIRED;
    if (consecutivePasses >= CONSECUTIVE_REQUIRED) {
      setState('snapped', 1);
      pauseDetection();
      if (onSnapCallback) onSnapCallback();
      return;
    }
    setState('capturing', progress);
  } else if (hasPaper) {
    consecutivePasses = 0;
    setState('detected', 0);
  } else {
    consecutivePasses = 0;
    setState('idle', 0);
  }
}

// --- Public API ---

export async function startDetection(video, rect, onSnap, onState) {
  videoEl = video;
  onSnapCallback = onSnap;
  onStateCallback = onState;

  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = SAMPLE_W;
    canvas.height = SAMPLE_H;
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }

  if (!cvReady) {
    setState('loading');
    try {
      await loadOpenCV();
      cvReady = true;
      console.log('[detector] OpenCV ready');
    } catch (e) {
      console.error('[detector] Failed to load OpenCV:', e);
      setState('idle');
      return;
    }
  }

  running = true;
  consecutivePasses = 0;
  prevGray = null;
  setState('idle');
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
  if (!videoEl || !onSnapCallback || !cvReady) return;
  running = true;
  consecutivePasses = 0;
  prevGray = null;
  setState('idle');
  lastTime = 0;
  loop(0);
}
