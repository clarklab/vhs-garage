// Pure time helpers for the /tik scrubber. No DOM access — unit-tested with node:test.

// Format seconds as mm:ss.mmm (e.g. 75.019 → "01:15.019"). Negatives clamp to 0.
export function formatTimecode(seconds) {
  const t = Math.max(0, Number(seconds) || 0);
  const mm = Math.floor(t / 60);
  const ss = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(mm)}:${pad(ss)}.${pad(ms, 3)}`;
}

// Step currentTime by `dir` frames (dir is +1 or -1) at `fps`. Clamps to >= 0.
export function frameStep(currentTime, dir, fps = 30) {
  const next = (Number(currentTime) || 0) + dir / (fps || 30);
  return Math.max(0, next);
}
