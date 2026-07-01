// Compose one slide: frame (letterboxed, top) + solid caption band (below) on a
// 1080x1920 canvas. composeToCanvas() draws onto a canvas you own (used by the
// live preview thumbnails); composeSlide() renders offscreen → JPEG Blob (upload).
import { computeSlideLayout } from './layout.js';
import { wrapLines, fitFontSize } from './caption.js';

const BAND_BG = '#111111';
const TEXT_COLOR = '#ffffff';
const FONT = (size) => `600 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
const PAD = 56;         // padding inside the band
const LINE_HEIGHT = 1.25;
const MIN_FONT = 28;
const MAX_FONT = 84;

// Draw the composed slide onto `cvs`. Only touches the canvas you pass in.
// Reused for the preview thumbnails (scale < 1, cheap raster) and the upload
// path (scale 1 → full 1080x1920). Layout math stays in 1080x1920 space; we
// scale the raster with ctx.scale so text stays crisp.
// bitmap: ImageBitmap; caption: string; titleLine?: prefix; scale?: raster scale.
export function composeToCanvas(cvs, bitmap, caption, { titleLine = '', scale = 1 } = {}) {
  const L = computeSlideLayout(bitmap.width, bitmap.height);
  cvs.width = Math.round(L.canvas.w * scale);
  cvs.height = Math.round(L.canvas.h * scale);
  const ctx = cvs.getContext('2d');
  ctx.scale(scale, scale); // draw in 1080x1920 coords regardless of raster size

  // Background + frame.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, L.canvas.w, L.canvas.h);
  ctx.drawImage(bitmap, L.frame.x, L.frame.y, L.frame.w, L.frame.h);

  // Caption band.
  ctx.fillStyle = BAND_BG;
  ctx.fillRect(L.band.x, L.band.y, L.band.w, L.band.h);

  const fullText = titleLine ? `${titleLine}\n${caption}` : caption;
  const maxTextW = L.band.w - PAD * 2;
  const maxTextH = L.band.h - PAD * 2;

  // measureText width scales ~linearly with font-size for a fixed string, so we
  // measure once at a reference size and scale. Converge the font size over 2
  // passes, then RE-WRAP at the final size so the drawn lines ARE the measured
  // lines (fixing stale-lines overflow), with a vertical-overflow guard.
  const REF = 100;
  ctx.font = FONT(REF);
  const measureAtRef = (s) => ctx.measureText(s).width;
  const wrapAt = (size) => wrapLines(fullText, maxTextW / (size / REF), measureAtRef);

  let fontSize = 64;
  for (let pass = 0; pass < 2; pass++) {
    fontSize = fitFontSize(wrapAt(fontSize).length, maxTextH, { maxFont: MAX_FONT, minFont: MIN_FONT });
  }
  let lines = wrapAt(fontSize);
  while (fontSize > MIN_FONT && lines.length * fontSize * LINE_HEIGHT > maxTextH) {
    fontSize -= 2;
    lines = wrapAt(fontSize);
  }

  ctx.font = FONT(fontSize);
  ctx.fillStyle = TEXT_COLOR;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const lh = fontSize * LINE_HEIGHT;
  let y = L.band.y + (L.band.h - lines.length * lh) / 2;
  const cx = L.canvas.w / 2;
  for (const line of lines) { ctx.fillText(line, cx, y); y += lh; }
}

// Render to an offscreen canvas and return a JPEG Blob for upload.
export async function composeSlide(bitmap, caption, opts = {}) {
  const cvs = document.createElement('canvas');
  composeToCanvas(cvs, bitmap, caption, opts);
  return await new Promise((resolve) => cvs.toBlob(resolve, 'image/jpeg', 0.9));
}
