// Client-side publish orchestration.
//
// Slideshow: compose → upload each JPEG to tik-media → send the URL list plus
// the refresh token to tik-publish.
// Video (the Quote-a-long clip): upload the clip to tik-video in chunks → send
// the one URL to tik-publish-video. Separate endpoints the whole way down, so
// the format that posts every day cannot be broken by the new one.
//
// onProgress(msg) drives the UI in both.
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
  const { title = '', description = '', coverIndex = 0, titleLine = '', maxFrameHeightRatio = null, format, onProgress = () => {} } = opts;
  const refreshToken = getRefreshToken();
  if (!refreshToken) throw new Error('Sign in to TikTok first.');
  if (slides.length === 0) throw new Error('Grab at least one frame first.');

  const photoUrls = [];
  for (let i = 0; i < slides.length; i++) {
    onProgress(`Rendering slide ${i + 1}/${slides.length}…`);
    const blob = await composeSlide(slides[i].bitmap, slides[i].caption, { titleLine, fontScale: slides[i].fontScale || 1, maxFrameHeightRatio, format, kind: slides[i].kind, adjust: slides[i].adjust, stampNudge: slides[i].stampNudge || 0 });
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


// MUST MATCH CHUNK_BYTES in netlify/functions/lib/videostore.mjs.
// A function request body tops out around 6MB; a minute of 1080x1920 is tens of
// megabytes, so the clip goes up in pieces and is streamed back as one file.
const CHUNK_BYTES = 4 * 1024 * 1024;

// Upload one rendered clip and return its public URL.
async function uploadClip(blob, onProgress = () => {}) {
  const uploadId = (crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)),
    (b) => b.toString(16).padStart(2, '0')).join('')).replace(/[^a-zA-Z0-9-]/g, '');
  const count = Math.max(1, Math.ceil(blob.size / CHUNK_BYTES));
  let last = null;
  for (let i = 0; i < count; i++) {
    const part = blob.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    onProgress(`Uploading clip ${Math.round(((i + 1) / count) * 100)}%…`);
    const res = await fetch('/.netlify/functions/tik-video', {
      method: 'POST',
      headers: {
        'Content-Type': blob.type || 'video/mp4',
        'x-upload-id': uploadId,
        'x-chunk-index': String(i),
        'x-chunk-count': String(count),
      },
      body: part,
    });
    last = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(last.error || `Clip upload failed on piece ${i + 1} of ${count}`);
  }
  if (!last?.url) throw new Error('Clip upload finished without a URL — try again.');
  return { url: last.url, bytes: last.bytes };
}

// blob: the rendered clip. opts: { onProgress }
//
// TikTok's inbox endpoint takes no title or description — the human types those
// in the app when they finish the draft — so the post copy this project holds
// stays in the editor for copy-pasting rather than being sent and ignored.
export async function publishClip(blob, opts = {}) {
  const { onProgress = () => {} } = opts;
  const refreshToken = getRefreshToken();
  if (!refreshToken) throw new Error('Sign in to TikTok first.');
  if (!blob?.size) throw new Error('Render the clip first.');

  const { url, bytes } = await uploadClip(blob, onProgress);

  onProgress('Sending the clip to TikTok…');
  const res = await fetch('/.netlify/functions/tik-publish-video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken, videoUrl: url, bytes }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw Object.assign(new Error('Your TikTok session expired — please sign in again.'), { reauth: true });
  }
  if (!res.ok || data.error) {
    throw new Error(data.hint ? `${data.error} — ${data.hint}` : (data.error || 'Post failed'));
  }
  return data; // { publishId, status }
}
