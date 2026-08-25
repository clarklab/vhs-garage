import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NEUTRAL, PRESETS, PRESET_KEYS, normalizeAdjust, isNeutral, filterString,
  applyPreset, autoLevels, describeAdjust, zoomOf, zoomSourceRect,
} from '../../public/scripts/tik/adjust.js';

// ---- the stored shape ----

test('an unset slide is neutral, and neutral costs nothing to render', () => {
  assert.ok(isNeutral(undefined));
  assert.ok(isNeutral(null));
  assert.ok(isNeutral(NEUTRAL));
  // No filter string at all, so the common case does not touch the compositor.
  assert.equal(filterString(null), '');
  assert.equal(filterString(NEUTRAL), '');
});

test('a set adjustment renders as the three filter functions canvas supports', () => {
  const f = filterString({ brightness: 1.2, contrast: 1.08, saturate: 1.15 });
  assert.match(f, /^brightness\(1\.2\) contrast\(1\.08\) saturate\(1\.15\)$/);
});

test('junk normalizes to neutral rather than producing a broken filter', () => {
  for (const bad of [{ brightness: 'x' }, { contrast: NaN }, { saturate: null }, { brightness: 0 }, {}, 'nope', 7]) {
    const a = normalizeAdjust(bad);
    assert.ok(Number.isFinite(a.brightness) && a.brightness > 0, JSON.stringify(bad));
    assert.ok(!filterString(a).includes('NaN'));
  }
});

test('values are held inside limits, so a frame cannot be pushed into abstraction', () => {
  const wild = normalizeAdjust({ brightness: 99, contrast: 99, saturate: 99 });
  assert.ok(wild.brightness <= 4 && wild.contrast <= 4 && wild.saturate <= 3);
  const floor = normalizeAdjust({ brightness: 0.01, contrast: 0.01, saturate: -5 });
  assert.ok(floor.brightness >= 0.5 && floor.contrast >= 0.5 && floor.saturate >= 0);
});

// ---- the menu ----

test('every preset is a real, distinct action with a label and a hint', () => {
  assert.equal(new Set(PRESET_KEYS).size, PRESET_KEYS.length, 'duplicate preset key');
  for (const p of PRESETS) {
    assert.ok(p.label, `${p.key} has no label`);
    assert.ok(p.hint, `${p.key} has no hint`);
    // auto and reset are computed; everything else must carry a step.
    if (p.key !== 'auto' && p.key !== 'reset') assert.ok(p.step, `${p.key} does nothing`);
  }
  assert.ok(PRESET_KEYS.includes('auto'));
  assert.ok(PRESET_KEYS.includes('reset'));
});

test('brightening is pure gain, because CSS brightness multiplies', () => {
  // Measured, not assumed: pairing gain with a contrast bump made a dark frame
  // DARKER. Contrast pushes values away from the midpoint, and on a night scene
  // nearly everything sits below it.
  const a = applyPreset(NEUTRAL, 'brighter20');
  assert.ok(a.brightness > 1, 'not brighter');
  assert.equal(a.contrast, 1, 'gain was paired with contrast, which cancels it in the shadows');
});

test('a dark pixel actually gets lighter under every brightening preset', () => {
  // The arithmetic CSS performs: brightness(b) then contrast(c) is
  // out = (x*b - 0.5)*c + 0.5. Run a genuinely dark pixel through it.
  const dark = 0.12;
  const out = (a) => (dark * a.brightness - 0.5) * a.contrast + 0.5;
  for (const key of ['brighter10', 'brighter20', 'lift']) {
    const a = applyPreset(NEUTRAL, key);
    assert.ok(out(a) > dark, `${key} left a dark pixel at ${out(a).toFixed(3)}, from ${dark}`);
  }
});

test('lifting shadows opens them rather than just scaling everything', () => {
  const a = applyPreset(NEUTRAL, 'lift');
  assert.ok(a.brightness > 1);
  assert.ok(a.contrast < 1, 'shadows were not opened');
});

test('presets compound, so the menu works as a dial', () => {
  const once = applyPreset(NEUTRAL, 'brighter10');
  const twice = applyPreset(once, 'brighter10');
  assert.ok(twice.brightness > once.brightness);
  assert.ok(Math.abs(twice.brightness - 1.21) < 0.02, `got ${twice.brightness}`);
});

test('reset goes back to the frame as grabbed', () => {
  const messed = applyPreset(applyPreset(NEUTRAL, 'brighter20'), 'saturate');
  assert.ok(!isNeutral(messed));
  assert.ok(isNeutral(applyPreset(messed, 'reset')));
});

test('an unknown preset changes nothing', () => {
  const a = applyPreset({ brightness: 1.2, contrast: 1, saturate: 1 }, 'nonsense');
  assert.equal(a.brightness, 1.2);
});

test('compounding cannot run past the limits', () => {
  let a = NEUTRAL;
  for (let i = 0; i < 40; i++) a = applyPreset(a, 'brighter20');
  assert.ok(a.brightness <= 4 && a.contrast <= 4);
});

// ---- auto levels ----

test('autoLevels solves the stretch exactly, not approximately', () => {
  // CSS applies brightness(b) contrast(c) as out = x*b*c - c/2 + 1/2. Auto
  // levels wants out = (x - black) / (white - black). Check the two agree at
  // both ends of a real dark frame.
  const black = 0.1, white = 0.62;
  const { brightness: b, contrast: c } = autoLevels({ black, white });
  const applied = (x) => x * b * c - c / 2 + 0.5;
  assert.ok(Math.abs(applied(black) - 0) < 0.02, `black maps to ${applied(black)}`);
  assert.ok(Math.abs(applied(white) - 1) < 0.02, `white maps to ${applied(white)}`);
});

test('a dark frame gets lifted; a full-range frame is left alone', () => {
  const dark = autoLevels({ black: 0.02, white: 0.35 });
  assert.ok(dark.brightness * dark.contrast > 1.5, 'a dark frame was barely touched');
  const full = autoLevels({ black: 0, white: 1 });
  assert.ok(isNeutral(full), 'a frame already using the full range was changed');
});

test('a nearly flat frame is left alone rather than having noise amplified', () => {
  assert.ok(isNeutral(autoLevels({ black: 0.5, white: 0.51 })));
  assert.ok(isNeutral(autoLevels({ black: 0.4, white: 0.4 })));
});

test('autoLevels survives junk and impossible ranges', () => {
  for (const bad of [undefined, {}, { black: 'x', white: 'y' }, { black: 0.9, white: 0.1 }, { black: -5, white: 50 }]) {
    const a = autoLevels(bad);
    assert.ok(Number.isFinite(a.brightness) && a.brightness > 0, JSON.stringify(bad));
    assert.ok(Number.isFinite(a.contrast) && a.contrast > 0);
  }
});

// ---- what the button says ----

test('describeAdjust says what was done, and nothing when nothing was', () => {
  assert.equal(describeAdjust(NEUTRAL), '');
  assert.match(describeAdjust({ brightness: 1.2, contrast: 1, saturate: 1 }), /\+20% bright/);
  assert.match(describeAdjust({ brightness: 1, contrast: 1, saturate: 0.88 }), /-12% color/);
});

// ---- zoom ----

test('zoom is a crop of the source, so the slide keeps its size and shape', () => {
  // The whole requirement: punch in without the composed frame changing at all.
  // Both axes divide by the same factor, so the aspect ratio is untouched and
  // the destination rectangle in compose.js never moves.
  const a = applyPreset(NEUTRAL, 'zoom20');
  const r = zoomSourceRect(a, 1920, 1080);
  assert.ok(Math.abs(r.sw / r.sh - 1920 / 1080) < 1e-9, 'the crop changed the aspect ratio');
  assert.ok(Math.abs(r.sw - 1920 / 1.2) < 1e-9);
  assert.ok(Math.abs(r.sh - 1080 / 1.2) < 1e-9);
});

test('the crop is centred — equal margins on every side', () => {
  const r = zoomSourceRect(applyPreset(NEUTRAL, 'zoom35'), 1920, 1080);
  assert.ok(Math.abs(r.sx - (1920 - r.sw) / 2) < 1e-9, 'not centred horizontally');
  assert.ok(Math.abs(r.sy - (1080 - r.sh) / 2) < 1e-9, 'not centred vertically');
  // Same margin left and right, top and bottom.
  assert.ok(Math.abs(r.sx - (1920 - r.sw - r.sx)) < 1e-9);
  assert.ok(Math.abs(r.sy - (1080 - r.sh - r.sy)) < 1e-9);
});

test('no zoom reads the whole frame, with no needless crop maths', () => {
  const r = zoomSourceRect(NEUTRAL, 1920, 1080);
  assert.deepEqual(r, { sx: 0, sy: 0, sw: 1920, sh: 1080 });
  assert.equal(zoomOf(null), 1);
});

test('zoom alone costs the compositor nothing', () => {
  // A slide that is only punched in has no colour change, so no filter string.
  assert.equal(filterString(applyPreset(NEUTRAL, 'zoom20')), '');
  // But it is not "neutral" — Reset still has something to undo.
  assert.ok(!isNeutral(applyPreset(NEUTRAL, 'zoom20')));
});

test('zoom compounds like the rest of the menu, and stops at the ceiling', () => {
  const twice = applyPreset(applyPreset(NEUTRAL, 'zoom20'), 'zoom20');
  assert.ok(Math.abs(twice.zoom - 1.44) < 0.02, `got ${twice.zoom}`);
  let a = NEUTRAL;
  for (let i = 0; i < 20; i++) a = applyPreset(a, 'zoom35');
  assert.ok(a.zoom <= 3, `ran to ${a.zoom}`);
});

test('zoom never goes below 1 — there is no picture outside the frame', () => {
  assert.equal(normalizeAdjust({ zoom: 0.5 }).zoom, 1);
  assert.equal(normalizeAdjust({ zoom: -2 }).zoom, 1);
  assert.equal(normalizeAdjust({ zoom: 'x' }).zoom, 1);
});

test('zoom survives a junk frame size instead of producing NaN', () => {
  for (const [w, h] of [[0, 0], [NaN, 100], [-5, -5], [undefined, undefined]]) {
    const r = zoomSourceRect(applyPreset(NEUTRAL, 'zoom20'), w, h);
    for (const v of Object.values(r)) assert.ok(Number.isFinite(v), `${w}x${h} gave ${JSON.stringify(r)}`);
  }
});

test('reset clears the zoom along with everything else', () => {
  const messed = applyPreset(applyPreset(NEUTRAL, 'zoom35'), 'brighter20');
  assert.ok(messed.zoom > 1 && messed.brightness > 1);
  assert.ok(isNeutral(applyPreset(messed, 'reset')));
});

test('the button says how far it is punched in', () => {
  assert.match(describeAdjust(applyPreset(NEUTRAL, 'zoom20')), /\+20% zoom/);
});

test('both zoom presets are on the menu, worded as asked for', () => {
  assert.ok(PRESET_KEYS.includes('zoom20'));
  assert.ok(PRESET_KEYS.includes('zoom35'));
  const labels = PRESETS.map((p) => p.label);
  assert.ok(labels.includes('Zoom center 20%'), labels.join(' | '));
  assert.ok(labels.includes('Zoom center 35%'), labels.join(' | '));
});
