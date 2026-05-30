// stream-stats — read-only helpers for inspecting a MediaStream's
// video track. Used by the Stream Info popup to surface what the
// capture card is actually delivering (resolution, aspect, fps).
//
// Two entry points:
//   readStreamStats(mediaStream)   — one-shot snapshot of declared
//                                    settings + capabilities + a
//                                    friendly aspect-ratio label
//   startFpsMeter(videoEl, onTick) — live measurement loop using
//                                    requestVideoFrameCallback;
//                                    calls onTick(fps) ~1×/sec;
//                                    returns a stop() function
//
// Zero DOM coupling in readStreamStats. startFpsMeter takes an
// optional <video> element only because requestVideoFrameCallback
// lives on the HTMLVideoElement, not the track itself.

const ASPECT_LABELS = [
  { ratio: 1.00,  label: '1.00 — square' },
  { ratio: 1.333, label: '1.33 — 4:3 NTSC' },
  { ratio: 1.500, label: '1.50 — 3:2 (anamorphic SD)' },
  { ratio: 1.778, label: '1.78 — 16:9 HD' },
  { ratio: 2.000, label: '2.00 — 2:1' },
];

const ASPECT_TOLERANCE = 0.02;

function aspectLabelFor(ratio) {
  if (!isFinite(ratio) || ratio <= 0) return 'unknown';
  for (const entry of ASPECT_LABELS) {
    if (Math.abs(ratio - entry.ratio) <= ASPECT_TOLERANCE) {
      return entry.label;
    }
  }
  return `${ratio.toFixed(2)} — non-standard`;
}

/**
 * Read a one-shot snapshot of a MediaStream's video track.
 *
 * @param {MediaStream | null} mediaStream
 * @returns {object | null} stats object, or null if the stream has
 *   no video track. Shape:
 *     deviceLabel    string
 *     width, height  numbers (may be 0 if the device hasn't reported)
 *     aspectRatio    number (width/height) or null
 *     aspectLabel    pretty string, e.g. '1.33 — 4:3 NTSC'
 *     declaredFps    number from track.getSettings().frameRate, or null
 *     capabilities   { maxWidth, maxHeight, maxFrameRate } or null
 */
export function readStreamStats(mediaStream) {
  if (!mediaStream) return null;
  const tracks = mediaStream.getVideoTracks();
  if (tracks.length === 0) return null;
  const track = tracks[0];

  const settings = (typeof track.getSettings === 'function')
    ? (track.getSettings() || {}) : {};
  const caps = (typeof track.getCapabilities === 'function')
    ? (track.getCapabilities() || {}) : {};

  const width = Number(settings.width) || 0;
  const height = Number(settings.height) || 0;
  const aspectRatio = (width > 0 && height > 0) ? width / height : null;

  // getCapabilities() returns ranges like { width: { min, max }, ... }.
  // Surface only the max values — that's what the user cares about
  // when asking "is the card capable of more than what I'm getting?"
  let capabilities = null;
  if (caps.width || caps.height || caps.frameRate) {
    capabilities = {
      maxWidth: (caps.width && Number(caps.width.max)) || null,
      maxHeight: (caps.height && Number(caps.height.max)) || null,
      maxFrameRate: (caps.frameRate && Number(caps.frameRate.max)) || null,
    };
    // If every field came back null/zero, treat as "no useful caps".
    if (!capabilities.maxWidth && !capabilities.maxHeight && !capabilities.maxFrameRate) {
      capabilities = null;
    }
  }

  return {
    deviceLabel: track.label || 'unknown device',
    width,
    height,
    aspectRatio,
    aspectLabel: aspectRatio == null ? 'unknown' : aspectLabelFor(aspectRatio),
    declaredFps: (typeof settings.frameRate === 'number') ? settings.frameRate : null,
    capabilities,
  };
}

/**
 * Start a live FPS meter on a <video> element.
 *
 * Uses requestVideoFrameCallback (rVFC) to count actual delivered
 * frames. Falls back to a no-op stop() function if rVFC isn't
 * supported (older Safari).
 *
 * @param {HTMLVideoElement} videoEl
 * @param {(fps: number) => void} onTick - called ~once per second
 *   with the measured frames-per-second over the previous interval
 * @returns {() => void} stop function. Idempotent — second call is
 *   a no-op.
 */
export function startFpsMeter(videoEl, onTick) {
  if (!videoEl || typeof videoEl.requestVideoFrameCallback !== 'function') {
    return () => {};
  }

  let stopped = false;
  let frames = 0;
  let windowStartMs = performance.now();

  const tick = (now) => {
    if (stopped) return;
    frames += 1;
    const elapsed = now - windowStartMs;
    if (elapsed >= 1000) {
      const fps = (frames * 1000) / elapsed;
      try { onTick(fps); } catch {}
      frames = 0;
      windowStartMs = now;
    }
    try { videoEl.requestVideoFrameCallback(tick); } catch {}
  };

  try { videoEl.requestVideoFrameCallback(tick); } catch { return () => {}; }

  return () => { stopped = true; };
}
