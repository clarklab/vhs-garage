import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAIR_LAYOUTS, PAIR_LAYOUT_LABELS, pairLayoutOf, otherLayout, pairGeometry,
} from '../../public/scripts/tik/pair.js';

const WIDE = { width: 1920, height: 1080 };
const TALL = { width: 1080, height: 1440 };

// ---- the two layouts ----

test('there are exactly two arrangements, each with a name', () => {
  assert.deepEqual(PAIR_LAYOUTS, ['stack', 'side']);
  for (const k of PAIR_LAYOUTS) assert.ok(PAIR_LAYOUT_LABELS[k], `${k} has no label`);
  assert.equal(otherLayout('stack'), 'side');
  assert.equal(otherLayout('side'), 'stack');
});

test('an unknown layout reads as stacked rather than breaking the slide', () => {
  for (const bad of [undefined, null, '', 'diagonal', 7]) assert.equal(pairLayoutOf(bad), 'stack');
});

// ---- stacked keeps both frames whole ----

test('stacking shows both frames complete, at one common width', () => {
  const g = pairGeometry(WIDE, WIDE, 'stack');
  for (const c of g.cells) {
    // Reads the entire source: nothing cropped.
    assert.equal(c.sx, 0);
    assert.equal(c.sy, 0);
    assert.equal(c.sw, WIDE.width);
    assert.equal(c.sh, WIDE.height);
  }
  assert.equal(g.cells[0].dw, g.cells[1].dw, 'the two are not the same width');
  assert.equal(g.width, 1920);
});

test('two widescreen frames stack into roughly a square, which suits a 9:16 slide', () => {
  const g = pairGeometry(WIDE, WIDE, 'stack');
  const aspect = g.width / g.height;
  assert.ok(aspect > 0.7 && aspect < 1.1, `stacked aspect ${aspect.toFixed(2)}`);
});

test('the second frame sits below the first, past the seam', () => {
  const g = pairGeometry(WIDE, WIDE, 'stack');
  assert.equal(g.cells[0].dy, 0);
  assert.equal(g.cells[1].dy, g.cells[0].dh + g.gap);
  assert.ok(g.gap > 0, 'no seam, so two frames read as one wide shot');
});

// ---- side by side crops to the middle ----

test('side by side crops each frame horizontally to its middle', () => {
  // Two whole widescreen frames side by side would each be half-width and
  // unreadable on a phone. Each is cropped instead, and shown at full height.
  const g = pairGeometry(WIDE, WIDE, 'side');
  for (const c of g.cells) {
    assert.equal(c.sh, WIDE.height, 'lost height; the crop should be horizontal only');
    assert.ok(c.sw < WIDE.width, 'nothing was cropped');
    // Dead centre: equal margins left and right.
    assert.equal(c.sx, (WIDE.width - c.sw) / 2);
  }
});

test('a pair of widescreen frames comes back out widescreen', () => {
  // Each cell is half the width the pair would take at the frames' own shape,
  // so the block keeps the shape of one frame.
  const g = pairGeometry(WIDE, WIDE, 'side');
  const aspect = g.width / g.height;
  assert.ok(Math.abs(aspect - WIDE.width / WIDE.height) < 0.05, `side aspect ${aspect.toFixed(3)}`);
});

test('side by side neither shrinks nor blows up a widescreen frame', () => {
  // The point of cropping rather than scaling: the middle stays at full size.
  const g = pairGeometry(WIDE, WIDE, 'side');
  for (const c of g.cells) {
    assert.ok(Math.abs(c.dw / c.sw - 1) < 0.02, `scaled ${(c.dw / c.sw).toFixed(2)}x`);
  }
});

test('the two cells are equal and the second clears the seam', () => {
  const g = pairGeometry(WIDE, TALL, 'side');
  assert.equal(g.cells[0].dw, g.cells[1].dw, 'lopsided cells');
  assert.equal(g.cells[0].dh, g.cells[1].dh);
  assert.equal(g.cells[1].dx, g.cells[0].dw + g.gap);
});

test('side by side never letterboxes — every cell is filled', () => {
  for (const [a, b] of [[WIDE, WIDE], [WIDE, TALL], [TALL, TALL]]) {
    const g = pairGeometry(a, b, 'side');
    for (const c of g.cells) {
      const cellAspect = c.dw / c.dh;
      const readAspect = c.sw / c.sh;
      assert.ok(Math.abs(cellAspect - readAspect) < 0.02,
        `cell ${cellAspect.toFixed(2)} vs read ${readAspect.toFixed(2)} would letterbox`);
    }
  }
});

// ---- both layouts, all the awkward inputs ----

test('mismatched frames still produce a sane block', () => {
  for (const layout of PAIR_LAYOUTS) {
    const g = pairGeometry(WIDE, TALL, layout);
    assert.ok(g.width > 0 && g.height > 0);
    for (const c of g.cells) {
      for (const v of Object.values(c)) assert.ok(Number.isFinite(v), `${layout} produced ${JSON.stringify(c)}`);
      assert.ok(c.sw > 0 && c.sh > 0 && c.dw > 0 && c.dh > 0);
    }
  }
});

test('a crop never reads outside the frame it is reading from', () => {
  for (const layout of PAIR_LAYOUTS) {
    const g = pairGeometry(WIDE, TALL, layout);
    const src = [WIDE, TALL];
    g.cells.forEach((c, i) => {
      assert.ok(c.sx >= 0 && c.sy >= 0, `${layout} cell ${i} starts outside`);
      assert.ok(c.sx + c.sw <= src[i].width + 0.01, `${layout} cell ${i} reads past the right edge`);
      assert.ok(c.sy + c.sh <= src[i].height + 0.01, `${layout} cell ${i} reads past the bottom`);
    });
  }
});

test('junk sizes give a block rather than NaN', () => {
  for (const bad of [{}, null, { width: 0, height: 0 }, { width: -5, height: 'x' }]) {
    for (const layout of PAIR_LAYOUTS) {
      const g = pairGeometry(bad, bad, layout);
      assert.ok(Number.isFinite(g.width) && g.width > 0, `${layout} ${JSON.stringify(bad)}`);
      assert.ok(Number.isFinite(g.height) && g.height > 0);
    }
  }
});

test('the seam scales with the frames instead of vanishing on a big one', () => {
  const small = pairGeometry({ width: 320, height: 180 }, { width: 320, height: 180 }, 'stack');
  const big = pairGeometry({ width: 3840, height: 2160 }, { width: 3840, height: 2160 }, 'stack');
  assert.ok(small.gap >= 4, 'seam disappeared on a small frame');
  assert.ok(big.gap > small.gap, 'seam did not grow with the frame');
});
