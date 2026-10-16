// Two grabbed frames on one Quote-a-long slide, for showing both halves of an
// exchange: the setup and the payoff, or two characters mid-line.
//
// The geometry is pure and unit-tested; only composePair touches a canvas.
//
// The two layouts are not the same operation, and that difference is the reason
// to pick one:
//
//   stack  whole frames, one over the other. Two 16:9 stills stack into roughly
//          a square, which sits comfortably on a 9:16 slide, so nothing is cut.
//   side   centre crops, left and right. Two whole widescreen frames side by
//          side would each be half-width and unreadable on a phone, so each is
//          cropped horizontally to its middle and shown at full height. Two 16:9
//          frames come back out as one 16:9 block with both middles at their
//          original scale.

export const PAIR_LAYOUTS = ['stack', 'side'];
export const PAIR_LAYOUT_LABELS = { stack: 'Stacked', side: 'Side by side' };

// A dark seam, so two frames from the same scene do not read as one wide shot.
const GAP_RATIO = 0.012;
const GAP_MIN = 4;

export function pairLayoutOf(v) {
  return PAIR_LAYOUTS.includes(v) ? v : 'stack';
}

export function otherLayout(v) {
  return pairLayoutOf(v) === 'stack' ? 'side' : 'stack';
}

const size = (img) => ({
  w: Math.max(1, Math.round(Number(img?.width) || 0)),
  h: Math.max(1, Math.round(Number(img?.height) || 0)),
});

// Where each frame is read from and where it lands, for one layout.
//
// Returns { width, height, gap, cells: [{ sx, sy, sw, sh, dx, dy, dw, dh }] } —
// the exact argument lists for a 9-argument drawImage, so the drawing code has
// no geometry left in it.
export function pairGeometry(a, b, layout = 'stack', { gap = null } = {}) {
  const A = size(a);
  const B = size(b);
  const mode = pairLayoutOf(layout);

  if (mode === 'stack') {
    // One common width, each frame WHOLE at its own aspect.
    const W = Math.max(A.w, B.w);
    const hA = Math.round(A.h * (W / A.w));
    const hB = Math.round(B.h * (W / B.w));
    const g = gap ?? Math.max(GAP_MIN, Math.round(W * GAP_RATIO));
    return {
      width: W,
      height: hA + g + hB,
      gap: g,
      cells: [
        { sx: 0, sy: 0, sw: A.w, sh: A.h, dx: 0, dy: 0, dw: W, dh: hA },
        { sx: 0, sy: 0, sw: B.w, sh: B.h, dx: 0, dy: hA + g, dw: W, dh: hB },
      ],
    };
  }

  // Side by side. Each cell is half the width the pair would occupy if it kept
  // the frames' own shape, so two 16:9 stills give back a 16:9 block — and each
  // cell is a CENTRE crop, which is what keeps the middle of the frame (where
  // the face and the subtitle are) at full size instead of shrinking it.
  const H = Math.max(A.h, B.h);
  const avgAspect = ((A.w / A.h) + (B.w / B.h)) / 2;
  const cellW = Math.max(1, Math.round((H * avgAspect) / 2));
  const g = gap ?? Math.max(GAP_MIN, Math.round(H * GAP_RATIO));
  const crop = ({ w, h }) => {
    // Cover: fill the cell, keep the centre, never letterbox.
    const scale = Math.max(cellW / w, H / h);
    const sw = Math.min(w, cellW / scale);
    const sh = Math.min(h, H / scale);
    return { sx: (w - sw) / 2, sy: (h - sh) / 2, sw, sh };
  };
  return {
    width: cellW * 2 + g,
    height: H,
    gap: g,
    cells: [
      { ...crop(A), dx: 0, dy: 0, dw: cellW, dh: H },
      { ...crop(B), dx: cellW + g, dy: 0, dw: cellW, dh: H },
    ],
  };
}

// sources: two Blobs or ImageBitmaps. Returns one ImageBitmap, so the rest of
// the slide pipeline never learns that a slide can hold two frames.
export async function composePair(sources, layout = 'stack') {
  const picked = (sources || []).slice(0, 2);
  if (picked.length < 2) throw new Error('composePair needs two frames');
  const imgs = [];
  for (const s of picked) imgs.push(s instanceof ImageBitmap ? s : await createImageBitmap(s));

  const geo = pairGeometry(imgs[0], imgs[1], layout);
  const cvs = document.createElement('canvas');
  cvs.width = geo.width;
  cvs.height = geo.height;
  const ctx = cvs.getContext('2d');
  // The seam, and a base under any letterboxing a mismatched pair would leave.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, geo.width, geo.height);
  geo.cells.forEach((c, i) => {
    ctx.drawImage(imgs[i], c.sx, c.sy, c.sw, c.sh, c.dx, c.dy, c.dw, c.dh);
  });
  return await createImageBitmap(cvs);
}
