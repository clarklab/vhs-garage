// Auto-snap detector for VHS sleeve capture
// Uses OpenCV.js to find a rectangular contour, then gates the snap behind:
//   1. strict rectangle shape (4-vertex polygon + convexity + aspect ratio)
//   2. bbox stability across consecutive frames (same rectangle, not a jitter)
//   3. overlap with the on-screen target overlay
//   4. "armed" state — requires a clear frame before a detection counts, so
//      the first rectangle to ENTER the frame wins instead of whatever was
//      already there when detection started.

const INTERVAL_MS = 120;
const CONSECUTIVE_REQUIRED = 5;        // ~600ms of stable detection
const ARM_CLEAR_FRAMES = 3;            // need N empty frames before a fresh detection can progress
const STABILITY_THRESHOLD = 10;        // mean pixel diff — webcams have noise
const MIN_AREA_RATIO = 0.10;           // contour must fill 10% of frame
const MAX_AREA_RATIO = 0.85;           // avoid "the whole frame is one rect" (blank background, etc)
const BBOX_IOU_THRESHOLD = 0.85;       // same rectangle across frames
const TARGET_IOU_THRESHOLD = 0.30;     // detected must overlap the target overlay
const MIN_ASPECT = 0.3;                // width/height (or its inverse) band
const MAX_ASPECT = 3.0;
const POLY_EPSILON_FACTOR = 0.02;      // approxPolyDP epsilon = perimeter * this
const POLY_VERTICES = 4;               // must approximate to a quadrilateral
const MIN_CONVEXITY = 0.90;            // contour area / convex hull area

const SAMPLE_W = 320;
const SAMPLE_H = 240;

let running = false;
let rafId = null;
let lastTime = 0;
let consecutivePasses = 0;
let clearFrames = 0;
let armed = false;                      // true once we've seen enough empty frames
let lastBbox = null;                    // bbox from previous successful detection
let prevGray = null;
let canvas = null;
let ctx = null;
let onSnapCallback = null;
let onStateCallback = null;
let videoEl = null;
let targetSampleRect = null;            // getTargetRect() projected into SAMPLE_W x SAMPLE_H space
let cvReady = false;
let cvLoading = false;

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

// --- Geometry helpers ---

function iou(a, b) {
  if (!a || !b) return 0;
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

// --- Rectangle detection with strict shape gating ---
// Returns either { found: false } or
//                 { found: true, bbox: {x,y,w,h}, area, vertices, convexity, aspect }
function detectRectangle() {
  if (!cvReady) return { found: false };

  ctx.drawImage(videoEl, 0, 0, SAMPLE_W, SAMPLE_H);
  let src = null;
  let gray = null;
  let blurred = null;
  let thresh = null;
  let contours = null;
  let hierarchy = null;

  try {
    src = cv.imread(canvas);
    gray = new cv.Mat();
    blurred = new cv.Mat();
    thresh = new cv.Mat();
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();

    // Pipeline borrowed from jscanify, proven to isolate document edges well
    cv.Canny(src, gray, 50, 200);
    cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
    cv.threshold(blurred, thresh, 0, 255, cv.THRESH_OTSU);
    cv.findContours(thresh, contours, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE);

    const frameArea = SAMPLE_W * SAMPLE_H;
    let best = null;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);

      // Fast area gate — cheapest filter first
      const areaRatio = area / frameArea;
      if (areaRatio < MIN_AREA_RATIO || areaRatio > MAX_AREA_RATIO) continue;

      // Polygon approximation: a real rectangle reduces to 4 vertices reliably
      const perimeter = cv.arcLength(contour, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(contour, approx, POLY_EPSILON_FACTOR * perimeter, true);
      const vertices = approx.rows;
      approx.delete();

      if (vertices !== POLY_VERTICES) continue;

      // Convexity: a real rectangle is convex; hands/faces/clothing aren't
      const hull = new cv.Mat();
      cv.convexHull(contour, hull);
      const hullArea = cv.contourArea(hull);
      hull.delete();
      const convexity = hullArea > 0 ? area / hullArea : 0;
      if (convexity < MIN_CONVEXITY) continue;

      // Aspect ratio sanity
      const rect = cv.boundingRect(contour);
      const ratio = rect.w / rect.h;
      const aspect = ratio >= 1 ? ratio : 1 / ratio;
      if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) continue;

      // Must sit inside the target overlay the user is aiming at
      const bbox = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      if (targetSampleRect && iou(bbox, targetSampleRect) < TARGET_IOU_THRESHOLD) continue;

      // Keep the largest qualifying candidate
      if (!best || area > best.area) {
        best = { bbox, area, vertices, convexity, aspect };
      }
    }

    if (best) {
      console.log(`[detect] ✓ ${(best.area / frameArea * 100).toFixed(0)}% v=${best.vertices} cvx=${best.convexity.toFixed(2)} ar=${best.aspect.toFixed(2)} bbox=${best.bbox.w}x${best.bbox.h}`);
      return { found: true, ...best };
    }
    return { found: false };
  } catch (e) {
    console.warn('[detector] error:', e.message);
    return { found: false };
  } finally {
    // Defensive cleanup even if an exception is thrown mid-pipeline
    if (src) src.delete();
    if (gray) gray.delete();
    if (blurred) blurred.delete();
    if (thresh) thresh.delete();
    if (contours) contours.delete();
    if (hierarchy) hierarchy.delete();
  }
}

// --- Scene stability (overall motion, independent of contour tracking) ---
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

  const det = detectRectangle();
  const sceneStability = checkStability();
  const sceneSteady = sceneStability < STABILITY_THRESHOLD;

  if (!det.found) {
    // No rectangle. Count clear frames; once enough, the detector is armed
    // and any NEW rectangle that enters will be eligible to progress.
    clearFrames++;
    if (clearFrames >= ARM_CLEAR_FRAMES) armed = true;
    if (consecutivePasses > 0) consecutivePasses = 0;
    lastBbox = null;
    setState('idle', 0);
    return;
  }

  // Something was detected. Until we've armed, ignore it — this prevents
  // firing on rectangles that happened to already be in frame at arm time.
  if (!armed) {
    clearFrames = 0;
    consecutivePasses = 0;
    lastBbox = det.bbox;
    setState('idle', 0);
    return;
  }

  // Require scene-level stillness AND bbox-level continuity with last frame.
  // Scene stillness rules out motion blur; bbox IoU rules out a rectangle
  // that's moving into place (or the detector hopping between shapes).
  const bboxSteady = lastBbox ? iou(det.bbox, lastBbox) >= BBOX_IOU_THRESHOLD : false;
  lastBbox = det.bbox;
  clearFrames = 0;

  if (sceneSteady && bboxSteady) {
    consecutivePasses++;
    if (consecutivePasses >= CONSECUTIVE_REQUIRED) {
      setState('snapped', 1);
      pauseDetection();
      if (onSnapCallback) onSnapCallback();
      return;
    }
    setState('capturing', consecutivePasses / CONSECUTIVE_REQUIRED);
  } else {
    // Detected but not stable (still moving into place) — show detection
    // but don't count toward the snap threshold.
    if (consecutivePasses > 0) consecutivePasses = 0;
    setState('detected', 0);
  }
}

// --- Public API ---

function resetDetectionState() {
  consecutivePasses = 0;
  clearFrames = 0;
  armed = false;
  lastBbox = null;
  prevGray = null;
}

function computeTargetSampleRect(rect) {
  if (!rect || !videoEl?.videoWidth || !videoEl?.videoHeight) return null;
  const scaleX = SAMPLE_W / videoEl.videoWidth;
  const scaleY = SAMPLE_H / videoEl.videoHeight;
  return {
    x: rect.x * scaleX,
    y: rect.y * scaleY,
    w: rect.w * scaleX,
    h: rect.h * scaleY,
  };
}

export async function startDetection(video, rect, onSnap, onState) {
  videoEl = video;
  onSnapCallback = onSnap;
  onStateCallback = onState;
  targetSampleRect = computeTargetSampleRect(rect);

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
  resetDetectionState();
  setState('idle');
  lastTime = 0;
  loop(0);
}

export function stopDetection() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  resetDetectionState();
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
  resetDetectionState();
  setState('idle');
  lastTime = 0;
  loop(0);
}
