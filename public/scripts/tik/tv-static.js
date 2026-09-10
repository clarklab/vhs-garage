// A short old-TV channel change, generated locally for the video render.
export const CHANNEL_CHANGE_SECONDS = 0.25;
export const CHANNEL_CHANGE_VOLUME = 0.15;

export function createStaticPainter(canvas) {
  // Coarse snow reads like an analog TV and is cheap to animate at portrait size.
  const snow = canvas.ownerDocument.createElement('canvas');
  snow.width = 180;
  snow.height = 320;
  const snowCtx = snow.getContext('2d');
  const pixels = snowCtx.createImageData(snow.width, snow.height);
  const ctx = canvas.getContext('2d');
  return () => {
    for (let i = 0; i < pixels.data.length; i += 4) {
      // Keep the flash gray rather than full white.
      const gray = 24 + Math.floor(Math.random() * 160);
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = gray;
      pixels.data[i + 3] = 255;
    }
    snowCtx.putImageData(pixels, 0, 0);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(snow, 0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    for (let y = 0; y < canvas.height; y += 12) ctx.fillRect(0, y, canvas.width, 3);
    // A faint wandering tracking band completes the channel-change look.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
    ctx.fillRect(0, Math.random() * canvas.height, canvas.width, canvas.height * 0.04);
    ctx.restore();
  };
}

export function playStaticNoise(audio, seconds = CHANNEL_CHANGE_SECONDS) {
  if (!audio) return () => {};
  const { ctx, dest } = audio;
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 5500;
  filter.Q.value = 0.5;
  const gain = ctx.createGain();
  const start = ctx.currentTime;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(CHANNEL_CHANGE_VOLUME, start + 0.008);
  gain.gain.setValueAtTime(CHANNEL_CHANGE_VOLUME, start + seconds - 0.03);
  gain.gain.linearRampToValueAtTime(0, start + seconds);
  source.connect(filter);
  filter.connect(gain);
  // Effects go only to the recording, never the speakers or movie-audio meter.
  gain.connect(dest);
  const disconnect = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
  source.onended = disconnect;
  source.start(start);
  source.stop(start + seconds);
  return () => {
    // Also clean up immediately if rendering is cancelled during the burst.
    source.onended = null;
    try { source.stop(); } finally { disconnect(); }
  };
}
