// Compose one slide on a 1080x1920 canvas: the frame and the caption are
// stacked and vertically CENTERED as a group (breathing room above/below).
// Captions use the TikTok-native text treatment: bold black text on white
// rounded "pills", one pill per wrapped line. composeToCanvas() draws onto a
// canvas you own (live preview thumbs); composeSlide() renders → JPEG Blob.
import { computeSlideLayout, containFrame } from './layout.js';
import { wrapLines, fitFontSize } from './caption.js';
import { filterString, zoomSourceRect } from './adjust.js';

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

// The Quote-a-long wordmark, laid over the title card.
//
// Placement and tilt are the ones the drawn-text version used, because those
// were right: a little past centre, high on the frame, kicked up 12 degrees so
// it reads as something stuck on rather than something rendered.
const STAMP_URL = '/tik/quote.png';
const STAMP_WIDTH_RATIO = 0.88;   // of the frame's width
const STAMP_TILT_DEG = -7;
// Dead centre. It sat at 0.52 back when the badge was small and being a little
// off-axis read as casual. At 88% of the frame it does not: the art itself is
// centred to within half a percent, so a 2% offset simply makes the left margin
// twice the right one, which reads as a mistake rather than as a flourish.
const STAMP_CX_RATIO = 0.5;
const STAMP_CY_RATIO = 0.38;
const STAMP_MAX_FRAME_HEIGHT = 0.92;   // of the room it has above and below, so it never touches an edge
const STAMP_MAX_FRAME_WIDTH = 0.96;    // and the same either side

// High on the frame is right for most posters, but a poster's own title sits
// wherever its designer put it, and on some of them the badge lands straight on
// top of the lettering. So the height is nudgeable per slide.
//
// A step is a share of the SLIDE, not of the frame: 3% of a scope film's frame
// is thirteen pixels, so a step measured off the frame moved almost nothing on
// exactly the slides that most need the badge moved.
//
// Nothing about the frame limits the travel. The badge is welcome to hang over
// the bottom of the picture and onto the black — a badge is a sticker, and half
// off the edge is a real placement. The only stop is the slide itself, because
// past that edge there is nothing to look at.
export const STAMP_NUDGE_STEP = 0.025;   // of the slide's height
export const STAMP_NUDGE_MIN = -24;
export const STAMP_NUDGE_MAX = 24;

export function clampStampNudge(n) {
  const v = Math.round(Number(n) || 0);
  if (!Number.isFinite(v)) return 0;
  return Math.min(STAMP_NUDGE_MAX, Math.max(STAMP_NUDGE_MIN, v));
}

// Where the badge ends up, in slide pixels, and whether it is against an edge
// OF THE SLIDE.
//
// Moving the badge must not RESIZE it — sizing off the nudged position shrank
// it by 40% when it was pushed up a 16:9 frame — so the size is settled first
// and passed in here as `half`, half the badge's tilted height.
//
// atTop / atBottom are what the arrows go by: an arrow is dead when the badge
// has reached the edge of the slide, and never a click earlier.
export function stampTravel(nudge = 0, { frameY = 0, frameH = 0, canvasH = 0, half = 0 } = {}) {
  const raw = frameY + frameH * STAMP_CY_RATIO + clampStampNudge(nudge) * STAMP_NUDGE_STEP * canvasH;
  const lo = Math.max(0, Number(half) || 0);
  const hi = canvasH - lo;
  if (!(canvasH > 0) || lo > hi) return { y: raw, atTop: false, atBottom: false };
  const E = 1e-9;
  return {
    y: Math.min(hi, Math.max(lo, raw)),
    atTop: raw <= lo + E,
    atBottom: raw >= hi - E,
  };
}

// Would another step in this direction do anything?
//
// `placement` is the stampTravel result from the last draw, when there is one:
// how far the badge can go depends on the slide it was drawn on, and an arrow
// that keeps clicking without moving anything reads as broken. Without it this
// falls back to the step range, which is the safe direction — enabled.
export function canNudgeStamp(nudge, delta, placement = null) {
  if (placement && delta < 0 && placement.atTop) return false;
  if (placement && delta > 0 && placement.atBottom) return false;
  return clampStampNudge(nudge) !== clampStampNudge(clampStampNudge(nudge) + delta);
}

let stampPromise = null;
let stamp = null;

// Preloaded, because composeToCanvas is synchronous and an <img> that has not
// decoded yet draws nothing. Same shape as captionFontReady: resolve once, and
// whoever needs a correct frame awaits it first.
export function quoteStampReady() {
  if (stampPromise) return stampPromise;
  stampPromise = (async () => {
    try {
      const res = await fetch(STAMP_URL);
      if (!res.ok) throw new Error(`stamp ${res.status}`);
      stamp = await createImageBitmap(await res.blob());
      return true;
    } catch (e) {
      // A missing stamp costs the title slide its badge, never the slide.
      console.error('[tik] Quote-a-long stamp failed to load:', e);
      return false;
    }
  })();
  return stampPromise;
}

function drawQuoteStamp(ctx, frameX, frameY, frameW, frameH, nudge = 0, canvasH = 0) {
  if (!stamp) return;   // not decoded yet; the caller redraws when it is
  const aspect = stamp.height / stamp.width;
  const tilt = STAMP_TILT_DEG * Math.PI / 180;
  const sin = Math.abs(Math.sin(tilt));
  const cos = Math.abs(Math.cos(tilt));

  // Width first, then hold it inside the picture.
  //
  // A tilted rectangle is taller than the art is, and a scope film's frame is
  // short: contain-fitting 2.39:1 across the canvas leaves a band about 40% as
  // tall as it is wide. At this size the badge would hang off the top of it
  // onto the black, reading as floating rather than stuck on. So the width
  // ratio is the intent and this is the ceiling, which only binds on the wide
  // aspect ratios where it has to.
  // The badge is off-centre both ways, so the room it has on each axis is twice
  // the SHORTER of the two gaps around it, not the whole frame. Measuring
  // against the full height is what let it hang off the top of a scope frame;
  // now it is near enough the full width for the same trap to exist sideways.
  const cx = frameW * STAMP_CX_RATIO;
  // Size is measured from the DEFAULT height, so a nudge moves the badge and
  // nothing else. (Sizing off the nudged height shrank it on short frames.)
  const cy0 = frameH * STAMP_CY_RATIO;
  const roomX = 2 * Math.min(cx, frameW - cx) * STAMP_MAX_FRAME_WIDTH;
  const roomY = 2 * Math.min(cy0, frameH - cy0) * STAMP_MAX_FRAME_HEIGHT;
  // Width and height of the TILTED box, per unit of art width.
  const boxW = cos + aspect * sin;
  const boxH = sin + aspect * cos;
  const w = Math.min(frameW * STAMP_WIDTH_RATIO, roomX / boxW, roomY / boxH);
  const h = w * aspect;
  // Now place it. The badge may end up over the black below the picture; that
  // is a placement, not an accident, so only the slide's own edge stops it.
  const placement = stampTravel(nudge, { frameY, frameH, canvasH, half: (w * boxH) / 2 });
  ctx.save();
  ctx.translate(frameX + cx, placement.y);
  ctx.rotate(STAMP_TILT_DEG * Math.PI / 180);
  ctx.drawImage(stamp, -w / 2, -h / 2, w, h);
  ctx.restore();
  return placement;
}

// Left-align the caption pills instead of centring them.
//
// A Quote-a-long exchange is one line per character, and centred pills turn a
// back-and-forth into a ragged diamond where the eye cannot find where each
// speaker starts. Flush left, the names stack and it reads as dialogue.
//
// Only for that case: a one-line quote, the title slide and the sign-off are
// all single thoughts and look better centred, the way every other format is.
export function wantsLeftAlign({ format, kind, lines } = {}) {
  if (format !== 'quotes') return false;
  if (kind === 'title' || kind === 'outro') return false;
  return (Array.isArray(lines) ? lines : []).filter((l) => String(l || '').trim()).length > 1;
}

export function composeToCanvas(cvs, bitmap, caption, { titleLine = '', scale = 1, fontScale = 1, maxFrameHeightRatio = null, format, kind, adjust = null, stampNudge = 0 } = {}) {
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
  // Correction rides on the frame only. Filtering the whole context would drag
  // the caption pills and the stamp along with it, and a brightened white pill
  // is just a blown-out white pill.
  //
  // Zoom is the SOURCE rectangle, never the destination: the middle of the
  // frame is read and drawn into the same F.w by F.h box it always occupied, so
  // the slide keeps its size and shape and only the framing moves. Scaling the
  // destination instead would resize the picture and shove the caption down.
  const correction = filterString(adjust);
  const { sx, sy, sw, sh } = zoomSourceRect(adjust, bitmap.width, bitmap.height);
  const drawFrame = () => ctx.drawImage(bitmap, sx, sy, sw, sh, frameX, frameY, F.w, F.h);
  if (correction) {
    ctx.save();
    ctx.filter = correction;
    drawFrame();
    ctx.restore();
  } else {
    drawFrame();
  }
  // Caption pills: white rounded pill per line, bold black centered text.
  // Blank lines (blank paragraph in the textarea) get no pill — just space.
  if (lines.length) {
    ctx.font = FONT(fontSize);
    ctx.textBaseline = 'middle';
    const left = wantsLeftAlign({ format, kind, lines });
    ctx.textAlign = left ? 'left' : 'center';
    const cx = CANVAS_W / 2;
    const pillW = (line) => Math.min(ctx.measureText(line).width + PILL_PAD_X * 2, CANVAS_W - 40);
    // Flush to the frame's own left edge so the block reads as one column with
    // the image, and never so far right that the widest pill runs off-canvas.
    const widest = left ? Math.max(...lines.filter(Boolean).map(pillW)) : 0;
    const leftX = Math.max(20, Math.min(frameX, CANVAS_W - 20 - widest));
    let y = frameY + F.h + GAP;
    for (const line of lines) {
      const pillH = lineBoxH(fontSize);
      if (!line) { y += pillH + PILL_GAP; continue; } // no empty white blob
      const w = pillW(line);
      const x = left ? leftX : cx - w / 2;
      ctx.fillStyle = '#ffffff';
      pillPath(ctx, x, y, w, pillH, PILL_RADIUS);
      ctx.fill();
      ctx.fillStyle = '#000000';
      ctx.fillText(line, left ? x + PILL_PAD_X : cx, y + pillH / 2 + 1);
      y += pillH + PILL_GAP;
    }
  }
  // The badge goes on LAST, over the pills. It can be nudged down past the
  // picture, and a sticker that slides behind the caption is a sticker that
  // looks broken. Its placement goes back to the caller because the nudge
  // arrows die at the edge of the slide, and only the draw knows where the
  // badge ended up.
  const stampPlacement = wantsQuoteStamp({ format, kind })
    ? drawQuoteStamp(ctx, frameX, frameY, F.w, F.h, stampNudge, CANVAS_H)
    : null;

  return { stamp: stampPlacement };
}

// Render to an offscreen canvas and return a JPEG Blob for upload.
//
// Awaits the caption font first, so the uploaded slide is always measured
// against Inter. Previews that were drawn before it arrived get redrawn by the
// caller; this end is the authoritative one and must never be the odd one out.
export async function composeSlide(bitmap, caption, opts = {}) {
  await Promise.all([captionFontReady(), quoteStampReady()]);
  const cvs = document.createElement('canvas');
  composeToCanvas(cvs, bitmap, caption, opts);
  return await new Promise((resolve) => cvs.toBlob(resolve, 'image/jpeg', 0.9));
}
