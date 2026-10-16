// Photo mosaic for the "Remembering Some Guys" title slide: 2–4 pasted photos
// tiled into a single SQUARE frame (1080×1080, matching makeCardBitmap) so it
// flows through the normal slide pipeline as one bitmap.
//   1 photo  → returned untouched; see below
//   2 photos → two columns side by side
//   3 photos → three columns side by side
//   4 photos → 2×2 grid
// Cells are cover-cropped so they always fill (no letterboxing, no background
// ever showing through), and adjacent cells cross-dissolve over a soft
// overlapping fade at each internal seam. Browser-only (canvas → ImageBitmap).
//
// ONE photo is not a mosaic, so it does not get the square treatment. Tiling a
// single image into a 1080×1080 cell meant cover-cropping it, which quietly ate
// the top and bottom of a portrait photo or the sides of a wide one. Handed
// back at its own size, the slide composer contain-fits it like every other
// single-photo slide and the whole picture survives.

const S = 1080;              // square canvas edge
const OVERLAP = Math.round(S * 0.02); // how far each cell bleeds past a seam (~22px)
const FADE = OVERLAP * 2;    // width of the cross-fade band centered on the seam

export const MOSAIC_MAX = 4;

// cols/rows for a given photo count (the "square" arrangements Clark asked for).
function gridFor(n) {
  if (n <= 2) return { cols: 2, rows: 1 };
  if (n === 3) return { cols: 3, rows: 1 };
  return { cols: 2, rows: 2 }; // 4
}

// Cover-fit an image into a w×h offscreen, then feather the requested edges to
// transparent so it can dissolve into whatever's already painted beneath.
// feather = { left, right, top, bottom } in px (0 = hard edge).
function cellCanvas(img, w, h, feather) {
  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.round(w));
  off.height = Math.max(1, Math.round(h));
  const o = off.getContext('2d');

  // object-fit: cover — scale so the image fills the cell, center-crop the rest.
  const scale = Math.max(off.width / img.width, off.height / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  o.drawImage(img, (off.width - dw) / 2, (off.height - dh) / 2, dw, dh);

  // Feather internal edges via destination-in gradient masks (each pass
  // multiplies the existing alpha, so corners get both fades).
  const W = off.width, H = off.height;
  const fade = (edge, px) => {
    if (px <= 0) return;
    o.save();
    o.globalCompositeOperation = 'destination-in';
    let g;
    if (edge === 'left')  { g = o.createLinearGradient(0, 0, px, 0); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)'); }
    if (edge === 'right') { g = o.createLinearGradient(W - px, 0, W, 0); g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)'); }
    if (edge === 'top')   { g = o.createLinearGradient(0, 0, 0, px); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)'); }
    if (edge === 'bottom'){ g = o.createLinearGradient(0, H - px, 0, H); g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)'); }
    o.fillStyle = g;
    o.fillRect(0, 0, W, H);
    o.restore();
  };
  fade('left', feather.left);
  fade('right', feather.right);
  fade('top', feather.top);
  fade('bottom', feather.bottom);
  return off;
}

// sources: array of Blob | ImageBitmap (1–4). Returns a square ImageBitmap.
export async function composeMosaic(sources) {
  const picked = (sources || []).slice(0, MOSAIC_MAX);
  const imgs = [];
  for (const s of picked) {
    imgs.push(s instanceof ImageBitmap ? s : await createImageBitmap(s));
  }
  if (!imgs.length) throw new Error('composeMosaic needs at least one photo');

  if (imgs.length === 1) {
    // A copy when the caller passed a bitmap it still owns: the slide's frame
    // gets closed when it is replaced, and that must never destroy a source
    // photo the mosaic might be rebuilt from.
    return picked[0] instanceof ImageBitmap ? await createImageBitmap(imgs[0]) : imgs[0];
  }

  const { cols, rows } = gridFor(imgs.length);
  const cellW = S / cols;
  const cellH = S / rows;

  const cvs = document.createElement('canvas');
  cvs.width = S;
  cvs.height = S;
  const ctx = cvs.getContext('2d');
  ctx.fillStyle = '#000'; // safety base; the tiling below fully covers it
  ctx.fillRect(0, 0, S, S);

  // Where each image lives in the grid.
  const cellOf = (i) => ({ col: i % cols, row: Math.floor(i / cols) });

  // Pass 1 — opaque tiling at nominal rects. Guarantees zero background shows
  // through, even at the exact center of a cross-faded seam.
  imgs.forEach((img, i) => {
    const { col, row } = cellOf(i);
    ctx.drawImage(cellCanvas(img, cellW, cellH, { left: 0, right: 0, top: 0, bottom: 0 }),
      Math.round(col * cellW), Math.round(row * cellH));
  });

  // Pass 2 — each cell redrawn slightly larger, bleeding OVERLAP past every
  // internal edge and feathered there, so neighbors dissolve into one another.
  imgs.forEach((img, i) => {
    const { col, row } = cellOf(i);
    const hasLeft = col > 0, hasRight = col < cols - 1;
    const hasTop = row > 0, hasBottom = row < rows - 1;
    const x0 = col * cellW - (hasLeft ? OVERLAP : 0);
    const y0 = row * cellH - (hasTop ? OVERLAP : 0);
    const x1 = (col + 1) * cellW + (hasRight ? OVERLAP : 0);
    const y1 = (row + 1) * cellH + (hasBottom ? OVERLAP : 0);
    const w = x1 - x0, h = y1 - y0;
    ctx.drawImage(
      cellCanvas(img, w, h, {
        left: hasLeft ? FADE : 0,
        right: hasRight ? FADE : 0,
        top: hasTop ? FADE : 0,
        bottom: hasBottom ? FADE : 0,
      }),
      Math.round(x0), Math.round(y0),
    );
  });

  return await createImageBitmap(cvs);
}
