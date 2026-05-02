let audioCtx = null;
let analyser = null;
let dataArray = null;
let animId = null;
let canvas = null;
let ctx = null;
let currentSource = null;
let canvasW = 0;
let canvasH = 0;
// createMediaElementSource can ONLY be called once per <video> element —
// subsequent calls throw InvalidStateError. Cache the source node per
// element so we can reuse it across showPlaybackTab() calls (switching
// between Live Feed and Last Recording, loading a different clip, etc.)
// without breaking the audio graph. `let` so stopMeter can drop the whole
// cache when the AudioContext is closed (the cached nodes belong to that
// context and are unusable afterwards).
let mediaElementSourceCache = new WeakMap();

function setupAnalyser() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (currentSource) {
    currentSource.disconnect();
    currentSource = null;
  }
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = 0.8;
  dataArray = new Uint8Array(analyser.frequencyBinCount);
}

export function initMeter(stream) {
  canvas = document.getElementById('audio-meter');
  if (!canvas) return;
  ctx = canvas.getContext('2d');
  canvasW = canvas.offsetWidth;
  canvasH = canvas.offsetHeight;
  canvas.width = canvasW;
  canvas.height = canvasH;

  setupAnalyser();

  // Clone the audio tracks into a separate stream so the meter
  // doesn't interfere with the <video> element's audio playback
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) return;
  const meterStream = new MediaStream(audioTracks.map(t => t.clone()));
  currentSource = audioCtx.createMediaStreamSource(meterStream);
  currentSource.connect(analyser);
  // Do NOT connect to audioCtx.destination — analysis only

  if (!animId) draw();
}

export function initMeterFromElement(videoEl) {
  canvas = document.getElementById('audio-meter');
  if (!canvas) return;
  ctx = canvas.getContext('2d');
  canvasW = canvas.offsetWidth;
  canvasH = canvas.offsetHeight;
  canvas.width = canvasW;
  canvas.height = canvasH;

  setupAnalyser();
  // Reuse the cached source for this video element. Calling
  // createMediaElementSource a second time on the same element throws
  // InvalidStateError — which used to be silently swallowed by the try/
  // catch in showPlaybackTab and left the audio graph in a broken state
  // (the symptom: scrubber works, play button does nothing).
  let source = mediaElementSourceCache.get(videoEl);
  if (!source) {
    source = audioCtx.createMediaElementSource(videoEl);
    mediaElementSourceCache.set(videoEl, source);
  }
  currentSource = source;
  currentSource.connect(analyser);
  currentSource.connect(audioCtx.destination);

  // Browser autoplay policies create AudioContexts in 'suspended' state.
  // Once a <video> element's audio is routed through createMediaElementSource,
  // it can ONLY be heard via the Web Audio graph — and a suspended context
  // means no audio. In Chrome this also blocks the video from actually
  // playing (paused stays true, scrubbing works, but play button is a
  // no-op). Resume on every init; safe to call when already running.
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }

  if (!animId) draw();
}

export function pauseMeter() {
  if (animId) cancelAnimationFrame(animId);
  animId = null;
  if (ctx && canvas) {
    ctx.clearRect(0, 0, canvasW, canvasH);
  }
}

export function stopMeter() {
  pauseMeter();
  if (currentSource) {
    currentSource.disconnect();
    currentSource = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  analyser = null;
  // The cached MediaElementSourceNodes belong to the audio context we just
  // closed; they're unusable for any future init. Drop the whole map so
  // the next initMeterFromElement creates fresh sources against the new
  // context. (WeakMap has no clear() — reassigning is the cleanest way.)
  mediaElementSourceCache = new WeakMap();
}

function draw() {
  animId = requestAnimationFrame(draw);
  if (!analyser || !ctx || !canvas) return;

  analyser.getByteFrequencyData(dataArray);

  const bars = dataArray.length;
  const barWidth = canvasW / bars;
  const h = canvasH;

  ctx.clearRect(0, 0, canvasW, h);

  for (let i = 0; i < bars; i++) {
    const val = dataArray[i] / 255;
    const barH = val * h;

    if (val < 0.5) {
      ctx.fillStyle = `rgba(76, 175, 80, ${0.4 + val * 0.8})`;
    } else if (val < 0.8) {
      ctx.fillStyle = `rgba(255, 193, 7, ${0.5 + val * 0.5})`;
    } else {
      ctx.fillStyle = `rgba(229, 57, 53, ${0.6 + val * 0.4})`;
    }

    ctx.fillRect(i * barWidth, h - barH, barWidth - 1, barH);
  }
}
