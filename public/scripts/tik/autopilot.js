// Autopilot orchestration (browser): filename → AI trivia → seek+grab prefilled
// slides. Network + DOM; verified manually. Pure parsing lives in filename.js.
import { parseMovieName } from './filename.js';
import { grabFrame } from './capture.js';

// Seek the video to `seconds` and resolve once the new frame is ready.
function seekTo(video, seconds) {
  return new Promise((resolve) => {
    const target = Math.min(Math.max(0, seconds), video.duration || seconds);
    if (Math.abs(video.currentTime - target) < 0.05) return resolve();
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = target;
  });
}

// Run autopilot. Returns an array of prefilled slides [{ id, bitmap, caption }].
// makeId() supplies unique ids; onProgress(msg) drives the status line. Throws
// with a clear message if the AI returns nothing (caller shows "grab manually").
export async function runAutopilot(video, filename, { makeId, onProgress = () => {} }) {
  const { title, year, query } = parseMovieName(filename);
  onProgress(`Researching “${query}”…`);
  const res = await fetch('/.netlify/functions/tik-autopilot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, year, durationSeconds: video.duration || 0 }),
  });
  const data = await res.json().catch(() => ({}));
  const suggestions = data.suggestions || [];
  if (!suggestions.length) {
    throw new Error(data.error || 'Autopilot couldn’t find trivia — grab frames manually.');
  }
  const slides = [];
  for (let i = 0; i < suggestions.length; i++) {
    onProgress(`Grabbing frame ${i + 1}/${suggestions.length}…`);
    await seekTo(video, suggestions[i].timecode);
    const bitmap = await grabFrame(video);
    slides.push({ id: makeId(), bitmap, caption: suggestions[i].caption });
  }
  return slides;
}
