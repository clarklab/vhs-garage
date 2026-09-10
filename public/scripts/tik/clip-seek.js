// A movie-sized local file may need time to decode forward from a keyframe.
// Wait for the requested frame itself, not just one browser event. A seek
// updates currentTime before the pixels are ready, so time alone is not proof.
export const CLIP_SEEK_TIMEOUT_MS = 30_000;
const SLOW_SEEK_MS = 4000;
const POLL_MS = 100;

export function seekForClip(video, target, { signal = null, onWaiting = () => {} } = {}) {
  const cancelled = () => Object.assign(new Error('Clip cancelled.'), { cancelled: true });
  const decodeError = () => new Error(`The browser could not decode the movie at ${target.toFixed(2)}s (media error ${video.error?.code || 'unknown'}).`);
  const ready = () => !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - target) <= 0.1;
  if (signal?.aborted) return Promise.reject(cancelled());
  if (video.error) return Promise.reject(decodeError());
  if (ready()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let timeout, slow, poll;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(slow);
      clearInterval(poll);
      for (const event of ['seeked', 'loadeddata', 'canplay']) video.removeEventListener(event, check);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve();
    };
    const onAbort = () => finish(cancelled());
    const onError = () => finish(decodeError());
    const check = () => {
      if (video.error) onError();
      else if (ready()) finish();
    };
    for (const event of ['seeked', 'loadeddata', 'canplay']) video.addEventListener(event, check);
    video.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    // Some browsers finish a seek without delivering another seeked event
    // when a preview had already requested the same position.
    poll = setInterval(check, POLL_MS);
    slow = setTimeout(() => { check(); if (!settled) onWaiting(); }, SLOW_SEEK_MS);
    timeout = setTimeout(() => {
      check();
      if (settled) return;
      const error = new Error(`The movie did not finish seeking to ${target.toFixed(2)}s after 30 seconds. Try rendering again; if it stays stuck, reload the movie file.`);
      error.seek = { target, currentTime: video.currentTime, seeking: video.seeking, readyState: video.readyState };
      finish(error);
    }, CLIP_SEEK_TIMEOUT_MS);
    // Let an existing seek to this frame finish rather than restarting it.
    if (Math.abs(video.currentTime - target) > 0.05 || !video.seeking) {
      try { video.currentTime = target; } catch (error) { finish(error); }
    }
  });
}
