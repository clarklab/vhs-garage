// Pure geometry for Layout A. Given a source frame's pixel dimensions, return
// the rects to draw on the 1080x1920 slide canvas: the letterboxed frame on
// top and the caption band filling the remainder. No canvas/DOM here.

export const CANVAS_W = 1080;
export const CANVAS_H = 1920;
// Cap the frame height so a tall/portrait source can't swallow the caption band.
export const MAX_FRAME_H_RATIO = 0.6;

export function computeSlideLayout(frameW, frameH, opts = {}) {
  const CW = opts.canvasW ?? CANVAS_W;
  const CH = opts.canvasH ?? CANVAS_H;
  const maxFrameH = Math.round(CH * (opts.maxFrameHRatio ?? MAX_FRAME_H_RATIO));

  const ar = frameH / frameW; // height per unit width
  let w = CW;
  let h = Math.round(CW * ar);

  if (h > maxFrameH) {
    // Constrain by height instead; frame becomes narrower than the canvas.
    h = maxFrameH;
    w = Math.round(maxFrameH / ar);
  }

  const x = Math.round((CW - w) / 2);
  const y = 0;

  return {
    canvas: { w: CW, h: CH },
    frame: { x, y, w, h },
    band: { x: 0, y: h, w: CW, h: CH - h },
  };
}
