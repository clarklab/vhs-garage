// Compose one slide on a 1080x1920 canvas: the frame and the caption are
// stacked and vertically CENTERED as a group (breathing room above/below).
// Captions use the TikTok-native text treatment: bold black text on white
// rounded "pills", one pill per wrapped line. composeToCanvas() draws onto a
// canvas you own (live preview thumbs); composeSlide() renders → JPEG Blob.
import { computeSlideLayout, containFrame } from './layout.js';
import { wrapLines, fitFontSize } from './caption.js';

const CANVAS_W = 1080;
const CANVAS_H = 1920;
// Inter first (loaded by the page); system stack until it arrives. app.js
// redraws thumbnails on document.fonts.ready so previews upgrade in place.
const FONT = (size) => `700 ${size}px Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

// Wrapping is decided by measureText, and Inter measures about 8% wider than
// the system fallback — so a caption laid out before the webfont arrives breaks
// at different words than the same caption laid out after. That is the whole
// reason a preview could disagree with the uploaded slide, and why hand-tuned
// font sizing looked like it "didn't stick": the preview being tuned was
// measured against a different font than the final.
//
// Memoized so every caller shares one load, and resolving (never rejecting)
// because a font that fails to load is a cosmetic problem, not a reason to
// block composing entirely.
let fontPromise = null;
export function captionFontReady() {
  if (fontPromise) return fontPromise;
  fontPromise = (async () => {
    try {
      if (!document.fonts) return false;
      // Load the sizes the composer actually asks for. `document.fonts.ready`
      // alone is not enough: it settles when nothing is *pending*, which is
      // true before anything has requested Inter at all.
      await Promise.all([
        document.fonts.load(`700 ${MAX_FONT}px Inter`),
        document.fonts.load('700 100px Inter'), // the reference size wrapping measures at
      ]);
      await document.fonts.ready;
      return document.fonts.check('700 100px Inter');
    } catch (e) {
      console.warn('[tik] caption font never loaded; previews may wrap differently:', e);
      return false;
    }
  })();
  return fontPromise;
}
const TEXT_MAX_W = CANVAS_W - 220; // generous side padding for the text block
const GAP = 52;                    // gap between frame and text block
const MIN_VPAD = 100;              // minimum space above/below the centered group
const MAX_FONT = 54;               // TikTok-ish caption size — noticeably smaller than before
const MIN_FONT = 26;
const PILL_PAD_X = 26;             // pill padding around each line
const PILL_PAD_Y = 12;
const PILL_RADIUS = 18;
const PILL_GAP = 8;                // vertical gap between line pills
const FIT_VPAD = 40;               // margin above/below the group in ratio mode

// Rounded-rect path (fallback-safe: not all canvas impls have ctx.roundRect).
function pillPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Draw the composed slide onto `cvs`. Layout math stays in 1080x1920 space;
// we scale the raster with ctx.scale so text stays crisp at preview sizes.
// bitmap: ImageBitmap; caption: string; titleLine?: prefix; scale?: raster scale;
// fontScale?: per-slide caption sizing (1 = auto; the overflow guard still caps
// scale-up, and scale-down goes below the usual minimum).
// maxFrameHeightRatio: bound the image by HEIGHT only, as a fraction of the
// canvas, and let the width run to the full canvas when the aspect allows. A
// square or widescreen image goes full width; a tall one is held back so it
// can't push the caption down the slide. The whole image is always visible —
// this is a contain fit, never a crop.
export function wantsQuoteStamp({ format, kind } = {}) {
  return format === 'quotes' && kind === 'title';
}

function drawQuoteStamp(ctx, frameX, frameY, frameW, frameH) {
  const cx = frameX + frameW * 0.52;
  const cy = frameY + frameH * 0.38;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-12 * Math.PI / 180);
  ctx.font = '900 86px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 14;
  ctx.strokeStyle = '#111';
  ctx.fillStyle = '#fb7185';
  const label = 'QUOTE-A-LONG';
  ctx.strokeText(label, 0, 0);
  ctx.fillText(label, 0, 0);
  ctx.restore();
}

export function composeToCanvas(cvs, bitmap, caption, { titleLine = '', scale = 1, fontScale = 1, maxFrameHeightRatio = null, format, kind } = {}) {
  const fs = Math.min(Math.max(Number(fontScale) || 1, 0.5), 1.6);
  const heightRatio = Number.isFinite(maxFrameHeightRatio)
    ? Math.min(Math.max(maxFrameHeightRatio, 0.05), 1)
    : null;
  const maxFont = Math.round(MAX_FONT * fs);
  const minFont = Math.max(12, Math.round(MIN_FONT * fs));
  cvs.width = Math.round(CANVAS_W * scale);
  cvs.height = Math.round(CANVAS_H * scale);
  const ctx = cvs.getContext('2d');
  ctx.scale(scale, scale);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const fullText = `${titleLine ? `${titleLine}\n` : ''}${caption}`.trim();

  // Text layout: wrap at a reference size and scale (measureText is ~linear in
  // font size), fit, re-wrap at the final size, then shrink until the whole
  // group (frame + gap + pills) fits inside the canvas minus MIN_VPAD.
  const REF = 100;
  ctx.font = FONT(REF);
  const measureAtRef = (s) => ctx.measureText(s).width;
  const wrapAt = (size) => wrapLines(fullText, TEXT_MAX_W / (size / REF), measureAtRef);
  const lineBoxH = (size) => size + PILL_PAD_Y * 2;              // one pill's height
  const blockH = (n, size) => (n ? n * lineBoxH(size) + (n - 1) * PILL_GAP : 0);
  const maxGroupH = CANVAS_H - MIN_VPAD * 2;

  let fontSize = maxFont;
  let lines = [];
  let F;

  if (heightRatio !== null) {
    // Caption first at its natural size, so a long one still claws back room
    // from the image rather than running off the bottom.
    if (fullText) {
      lines = wrapAt(fontSize);
      while (fontSize > minFont && blockH(lines.length, fontSize) > CANVAS_H / 2) {
        fontSize -= 2;
        lines = wrapAt(fontSize);
      }
    }
    const capH = lines.length ? blockH(lines.length, fontSize) : 0;
    // Two ceilings: the caller's height cap (the usual binding one) and
    // whatever the caption leaves over (binding only for very long captions).
    const availH = Math.max(
      1,
      Math.min(
        Math.round(CANVAS_H * heightRatio),
        CANVAS_H - FIT_VPAD * 2 - (capH ? GAP + capH : 0),
      ),
    );
    F = containFrame(bitmap.width, bitmap.height, CANVAS_W, availH);
  } else {
    // Frame size: full width, aspect preserved, capped so text always has room.
    F = computeSlideLayout(bitmap.width, bitmap.height).frame; // w/h only; we position ourselves
    if (fullText) {
      const maxTextH = maxGroupH - F.h - GAP;
      fontSize = fitFontSize(wrapAt(fontSize).length, Math.max(maxTextH, lineBoxH(minFont)), {
        maxFont, minFont, lineHeightFactor: 1.5,
      });
      lines = wrapAt(fontSize);
      while (fontSize > minFont && F.h + GAP + blockH(lines.length, fontSize) > maxGroupH) {
        fontSize -= 2;
        lines = wrapAt(fontSize);
      }
    }
  }

  // Vertically center the group: frame + gap + text block. Clamp the top so a
  // pathological (huge pasted) caption clips only its trailing pills off the
  // bottom — the frame itself must never slide off-canvas.
  const textH = lines.length ? blockH(lines.length, fontSize) : 0;
  const groupH = F.h + (textH ? GAP + textH : 0);
  const frameX = Math.round((CANVAS_W - F.w) / 2);
  const frameY = Math.max(0, Math.round((CANVAS_H - groupH) / 2));
  ctx.drawImage(bitmap, frameX, frameY, F.w, F.h);
  if (wantsQuoteStamp({ format, kind })) drawQuoteStamp(ctx, frameX, frameY, F.w, F.h);

  // Caption pills: white rounded pill per line, bold black centered text.
  // Blank lines (blank paragraph in the textarea) get no pill — just space.
  if (lines.length) {
    ctx.font = FONT(fontSize);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = CANVAS_W / 2;
    let y = frameY + F.h + GAP;
    for (const line of lines) {
      const pillH = lineBoxH(fontSize);
      if (!line) { y += pillH + PILL_GAP; continue; } // no empty white blob
      const textW = ctx.measureText(line).width;
      const pillW = Math.min(textW + PILL_PAD_X * 2, CANVAS_W - 40);
      ctx.fillStyle = '#ffffff';
      pillPath(ctx, cx - pillW / 2, y, pillW, pillH, PILL_RADIUS);
      ctx.fill();
      ctx.fillStyle = '#000000';
      ctx.fillText(line, cx, y + pillH / 2 + 1);
      y += pillH + PILL_GAP;
    }
  }
}

// Render to an offscreen canvas and return a JPEG Blob for upload.
//
// Awaits the caption font first, so the uploaded slide is always measured
// against Inter. Previews that were drawn before it arrived get redrawn by the
// caller; this end is the authoritative one and must never be the odd one out.
export async function composeSlide(bitmap, caption, opts = {}) {
  await captionFontReady();
  const cvs = document.createElement('canvas');
  composeToCanvas(cvs, bitmap, caption, opts);
  return await new Promise((resolve) => cvs.toBlob(resolve, 'image/jpeg', 0.9));
}
