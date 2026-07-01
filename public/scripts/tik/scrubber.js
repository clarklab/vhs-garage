// Wire the chunky scrubber (range input, timecode readout, ±1 frame buttons)
// to a <video>. Browser-only. Pure time math lives in timecode.js.
import { formatTimecode, frameStep } from './timecode.js';

const RANGE_MAX = 1000; // range input resolution (0..1000 mapped to 0..duration)

export function initScrubber({ video, range, timecode, stepBack, stepFwd, fps = 30 }) {
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

  stepBack.addEventListener('click', () => { video.currentTime = frameStep(video.currentTime, -1, fps); });
  stepFwd.addEventListener('click', () => { video.currentTime = frameStep(video.currentTime, 1, fps); });

  return { sync };
}
