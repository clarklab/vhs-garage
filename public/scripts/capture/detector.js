// Auto-snap detector for VHS sleeve capture
// Uses OpenCV.js (loaded from CDN) for rectangle detection
// Flow: load OpenCV → capture baseline → detect rectangle + stability → snap

const INTERVAL_MS = 120;
const CONSECUTIVE_REQUIRED = 5;    // ~600ms of all-pass before snap
const STABILITY_THRESHOLD = 5;     // mean pixel diff between frames
const MIN_CONTOUR_AREA_RATIO = 0.1; // contour must fill at least 10% of target zone
const SAMPLE_W = 300;
const SAMPLE_H = 520;

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
let cvReady = false;
let cvLoading = false;

let detectionState = 'idle';

function setState(state) {
  if (state !== detectionState) {
    detectionState = state;
    if (onStateCallback) onStateCallback(state);
  }
}

// --- Load OpenCV.js from CDN ---
function loadOpenCV() {
  return new Promise((resolve, reject) => {
    if (typeof cv !== 'undefined' && cv.Mat) {
      resolve();
      return;
    }
    if (cvLoading) {
      // Already loading — poll for ready
      const poll = setInterval(() => {
        if (typeof cv !== 'undefined' && cv.Mat) {
          clearInterval(poll);
          resolve();
        }
      }, 200);
      return;
    }
    cvLoading = true;
    console.log('[detector] Loading OpenCV.js from CDN...');
    const script = document.createElement('script');
    script.src = 'https://docs.opencv.org/4.9.0/opencv.js';
    script.async = true;
    script.onload = () => {
      // OpenCV.js sets up cv as a Module that needs to initialize
      if (typeof cv === 'object' && cv.then) {
        // cv is a Promise (newer builds)
        cv.then((instance) => {
          window.cv = instance;
          console.log('[detector] OpenCV.js ready (promise)');
          resolve();
        });
      } else if (typeof cv !== 'undefined' && !cv.Mat) {
        // cv exists but not ready — wait for onRuntimeInitialized
        cv.onRuntimeInitialized = () => {
          console.log('[detector] OpenCV.js ready (callback)');
          resolve();
        };
      } else if (typeof cv !== 'undefined' && cv.Mat) {
        console.log('[detector] OpenCV.js ready (immediate)');
        resolve();
      } else {
        reject(new Error('OpenCV.js failed to initialize'));
      }
    };
    script.onerror = () => reject(new Error('Failed to load OpenCV.js'));
    document.head.appendChild(script);
  });
}

// --- Rectangle detection using OpenCV ---
function detectRectangle() {
  if (!cvReady) return false;

  const { x, y, w, h } = targetRect;
  ctx.drawImage(videoEl, x, y, w, h, 0, 0, SAMPLE_W, SAMPLE_H);

  let src, gray, blurred, edges, contours, hierarchy;
  try {
    src = cv.imread(canvas);
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

    edges = new cv.Mat();
    cv.Canny(blurred, edges, 50, 150);

    // Dilate to close gaps in edges
    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, edges, kernel);
    kernel.delete();

    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const targetArea = SAMPLE_W * SAMPLE_H;
    let found = false;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);

      // Must fill a significant portion of the target zone
      if (area < targetArea * MIN_CONTOUR_AREA_RATIO) continue;

      // Approximate to polygon — is it a quadrilateral?
      const approx = new cv.Mat();
      const peri = cv.arcLength(contour, true);
      cv.approxPolyDP(contour, approx, 0.04 * peri, true);

      if (approx.rows >= 4 && approx.rows <= 6) {
        // Found a roughly rectangular shape filling the target zone
        found = true;
        approx.delete();
        break;
      }
      approx.delete();
    }

    return found;
  } catch (e) {
    console.warn('[detector] OpenCV error:', e.message);
    return false;
  } finally {
    if (src) src.delete();
    if (gray) gray.delete();
    if (blurred) blurred.delete();
    if (edges) edges.delete();
    if (contours) contours.delete();
    if (hierarchy) hierarchy.delete();
  }
}

// --- Stability check (frame diff) ---
function checkStability() {
  const { x, y, w, h } = targetRect;
  ctx.drawImage(videoEl, x, y, w, h, 0, 0, SAMPLE_W, SAMPLE_H);
  const imageData = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
  const gray = toGrayscale(imageData.data, SAMPLE_W, SAMPLE_H);

  const stability = prevGray ? computeMeanDiff(gray, prevGray) : 999;
  prevGray = gray;
  return stability;
}

function toGrayscale(rgba, w, h) {
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
  }
  return gray;
}

function computeMeanDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

// --- Main loop ---
function loop(timestamp) {
  if (!running) return;
  rafId = requestAnimationFrame(loop);

  if (timestamp - lastTime < INTERVAL_MS) return;
  lastTime = timestamp;

  if (!videoEl.videoWidth || !videoEl.videoHeight) return;

  const hasRect = detectRectangle();
  const stability = checkStability();
  const stableOk = stability < STABILITY_THRESHOLD;

  console.log(`rect:${hasRect} stable:${stability.toFixed(1)} | rect:${hasRect} stable:${stableOk}`);

  if (hasRect && stableOk) {
    consecutivePasses++;
    if (consecutivePasses >= CONSECUTIVE_REQUIRED) {
      setState('snapped');
      pauseDetection();
      if (onSnapCallback) onSnapCallback();
      return;
    }
    setState('capturing');
  } else if (hasRect) {
    consecutivePasses = 0;
    setState('detected');
  } else {
    consecutivePasses = 0;
    setState('idle');
  }
}

// --- Public API ---

export async function startDetection(video, rect, onSnap, onState) {
  videoEl = video;
  targetRect = rect;
  onSnapCallback = onSnap;
  onStateCallback = onState;

  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = SAMPLE_W;
    canvas.height = SAMPLE_H;
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }

  // Load OpenCV if not ready
  if (!cvReady) {
    setState('loading');
    try {
      await loadOpenCV();
      cvReady = true;
      console.log('[detector] OpenCV ready, starting detection');
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
  if (!videoEl || !targetRect || !onSnapCallback || !cvReady) return;
  running = true;
  consecutivePasses = 0;
  prevGray = null;
  setState('idle');
  lastTime = 0;
  loop(0);
}
