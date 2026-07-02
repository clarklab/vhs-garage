// Wire the chunky scrubber (range input, timecode readout, and step buttons)
// to a <video>. Browser-only. Pure time math lives in timecode.js.
// Each step button carries a data-frames="N" or data-seconds="N" (signed).
import { formatTimecode, frameStep } from './timecode.js';

const RANGE_MAX = 1000; // range input resolution (0..1000 mapped to 0..duration)

export function initScrubber({ video, range, timecode, steps = [], fps = 30 }) {
  const sync = () => {
    const d = video.duration || 0;
    if (d > 0) range.value = String(Math.round((video.currentTime / d) * RANGE_MAX));
    timecode.textContent = formatTimecode(video.currentTime);
  };

  const seekToRange = () => {
    const d = video.duration || 0;
    video.currentTime = (Number(range.value) / RANGE_MAX) * d;
  };

  range.addEventListener('input', seekToRange);
  video.addEventListener('timeupdate', sync);
  video.addEventListener('loadedmetadata', sync);
  video.addEventListener('seeked', sync);

  const clamp = (t) => Math.min(Math.max(0, t), video.duration || t);
  const stepFrames = (n) => { video.currentTime = clamp(frameStep(video.currentTime, n, fps)); };
  const stepSeconds = (n) => { video.currentTime = clamp(video.currentTime + n); };

  for (const btn of steps) {
    if (btn.dataset.frames !== undefined) {
      btn.addEventListener('click', () => stepFrames(Number(btn.dataset.frames)));
    } else if (btn.dataset.seconds !== undefined) {
      btn.addEventListener('click', () => stepSeconds(Number(btn.dataset.seconds)));
    }
  }

  // Keyboard nudge: ←/→ step one frame, Space nudges forward. Ignored while a
  // text field is focused so caption typing isn't hijacked.
  window.addEventListener('keydown', (e) => {
    const el = document.activeElement;
    const tag = (el?.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input' || el?.isContentEditable) return;
    if (!video.duration) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepFrames(-1); }
    else if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); stepFrames(1); }
  });

  return { sync };
}
