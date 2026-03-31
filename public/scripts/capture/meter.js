let audioCtx = null;
let analyser = null;
let dataArray = null;
let animId = null;
let canvas = null;
let ctx = null;
let currentSource = null;

function setupAnalyser() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (analyser) {
    if (currentSource) currentSource.disconnect();
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

  setupAnalyser();
  currentSource = audioCtx.createMediaStreamSource(stream);
  currentSource.connect(analyser);

  if (!animId) draw();
}

export function initMeterFromElement(videoEl) {
  canvas = document.getElementById('audio-meter');
  if (!canvas) return;
  ctx = canvas.getContext('2d');

  setupAnalyser();
  currentSource = audioCtx.createMediaElementSource(videoEl);
  currentSource.connect(analyser);
  currentSource.connect(audioCtx.destination);

  if (!animId) draw();
}

export function pauseMeter() {
  if (animId) cancelAnimationFrame(animId);
  animId = null;
  if (ctx && canvas) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
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

  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;

  analyser.getByteFrequencyData(dataArray);

  const bars = dataArray.length;
  const barWidth = canvas.width / bars;
  const h = canvas.height;

  ctx.clearRect(0, 0, canvas.width, h);

  for (let i = 0; i < bars; i++) {
    const val = dataArray[i] / 255;
    const barH = val * h;

    // Green → yellow → red gradient based on level
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
