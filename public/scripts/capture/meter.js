let audioCtx = null;
let analyser = null;
let dataArray = null;
let animId = null;
let canvas = null;
let ctx = null;
let currentSource = null;
let canvasW = 0;
let canvasH = 0;

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

  // Use captureStream() (the same trick the live initMeter uses) instead of
  // createMediaElementSource. CRITICAL DIFFERENCE:
  //
  //   createMediaElementSource HIJACKS the <video> element's audio output —
  //   audio is routed EXCLUSIVELY through the Web Audio graph from then on.
  //   If the AudioContext is suspended (default per browser autoplay
  //   policy), or the graph isn't perfectly intact, the video stops
  //   playing entirely (the play button is a no-op; scrubbing still works
  //   because it's independent of audio). Calling it twice on the same
  //   element also throws InvalidStateError. Both bugs combined to make
  //   playback unreliable across recording-stop and library-open flows.
  //
  //   captureStream() returns a separate MediaStream of the element's
  //   tracks WITHOUT diverting the element's own audio path. The video
  //   plays through speakers normally; we tee off a copy of the audio
  //   purely for level analysis. No once-per-element restriction, no
  //   suspended-context interference with playback.
  if (typeof videoEl.captureStream !== 'function') return;
  let stream;
  try { stream = videoEl.captureStream(); } catch { return; }
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) return;

  currentSource = audioCtx.createMediaStreamSource(stream);
  currentSource.connect(analyser);
  // Do NOT connect to audioCtx.destination — the video plays its own audio
  // through the normal element path; connecting here would double up.

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
