// Client-side publish orchestration: compose → upload each JPEG to tik-media →
// send URL list + refresh token to tik-publish. onProgress(msg) drives the UI.
import { composeSlide } from './compose.js';
import { getRefreshToken } from './auth.js';

async function uploadJpeg(blob) {
  const res = await fetch('/.netlify/functions/tik-media', {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: blob,
  });
  const data = await res.json();
  if (!res.ok || !data.url) throw new Error(data.error || 'Upload failed');
  return data.url;
}

// slides: [{ bitmap, caption }]; opts: { title, description, coverIndex, titleLine, maxFrameHeightRatio, onProgress }
export async function publishSlideshow(slides, opts = {}) {
  const { title = '', description = '', coverIndex = 0, titleLine = '', maxFrameHeightRatio = null, onProgress = () => {} } = opts;
  const refreshToken = getRefreshToken();
  if (!refreshToken) throw new Error('Sign in to TikTok first.');
  if (slides.length === 0) throw new Error('Grab at least one frame first.');

  const photoUrls = [];
  for (let i = 0; i < slides.length; i++) {
    onProgress(`Rendering slide ${i + 1}/${slides.length}…`);
    const blob = await composeSlide(slides[i].bitmap, slides[i].caption, { titleLine, fontScale: slides[i].fontScale || 1, maxFrameHeightRatio });
    onProgress(`Uploading slide ${i + 1}/${slides.length}…`);
    photoUrls.push(await uploadJpeg(blob));
  }

  onProgress('Sending to TikTok…');
  const res = await fetch('/.netlify/functions/tik-publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken, photoUrls, coverIndex, title, description }),
  });
  const data = await res.json().catch(() => ({}));
  // 401 → token dead; signal the caller to clear it and re-auth.
  if (res.status === 401) {
    throw Object.assign(new Error('Your TikTok session expired — please sign in again.'), { reauth: true });
  }
  if (!res.ok || data.error) {
    // Append the server's developer-portal hint when present (verbatim + hint).
    throw new Error(data.hint ? `${data.error} — ${data.hint}` : (data.error || 'Post failed'));
  }
  return data; // { publishId, status }
}
