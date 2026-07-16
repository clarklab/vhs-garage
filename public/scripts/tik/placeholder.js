// Generated placeholder frames for bring-your-own-image slides (the Some Guys
// format ships with no video). A dark "tape label" card with the movie title
// big and the role small — presentable even if the user never pastes a photo,
// with a quiet hint that they should. Browser-only (canvas → ImageBitmap).
import { wrapLines } from './caption.js';

const W = 1080;
const H = 1080; // square: leaves the caption band plenty of room in the 9:16 slide

// heading: big line (movie title / actor name); sub: small line (year · role);
// hint: bottom nudge; accent: underline bar color.
export async function makeCardBitmap({ heading = '', sub = '', hint = 'Paste, drop, or pick a photo', accent = '#eab308' } = {}) {
  const cvs = document.createElement('canvas');
  cvs.width = W;
  cvs.height = H;
  const ctx = cvs.getContext('2d');

  // Base + faint scanlines (VHS texture without the noise).
  ctx.fillStyle = '#101013';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255,255,255,0.030)';
  for (let y = 0; y < H; y += 6) ctx.fillRect(0, y, W, 2);
  // Soft vignette so pasted-over slides and placeholders read as "cards".
  const grad = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.85);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Heading, wrapped and shrunk to fit.
  const maxW = W - 160;
  let size = 96;
  let lines = [''];
  if (heading) {
    const fontFor = (s) => `800 ${s}px Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    do {
      ctx.font = fontFor(size);
      lines = wrapLines(heading, maxW, (s) => ctx.measureText(s).width);
      if (lines.length <= 3) break;
      size -= 8;
    } while (size > 44);
    ctx.font = fontFor(size);
  }
  const lineH = size * 1.15;
  const blockH = heading ? lines.length * lineH : 0;
  let y = H / 2 - blockH / 2 + lineH / 2 - (sub ? 30 : 0);
  ctx.fillStyle = '#f5f5f4';
  for (const line of lines) {
    if (heading) ctx.fillText(line, W / 2, y);
    y += lineH;
  }

  // Accent bar under the heading.
  if (heading) {
    ctx.fillStyle = accent;
    ctx.fillRect(W / 2 - 60, y - lineH / 2 + 18, 120, 8);
    y += 44;
  }

  // Sub line (year · role).
  if (sub) {
    ctx.font = '600 40px Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = '#a1a1aa';
    ctx.fillText(sub, W / 2, y);
  }

  // Bottom hint.
  if (hint) {
    ctx.font = '500 30px Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText(hint, W / 2, H - 70);
  }

  return await createImageBitmap(cvs);
}
