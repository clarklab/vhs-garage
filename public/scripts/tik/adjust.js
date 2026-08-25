// Per-slide image correction, for frames grabbed out of a dark film.
//
// Pure — no DOM, no network. Unit-tested under node:test.
//
// Stored as multipliers on the slide rather than baked into the pixels, so a
// nudge is reversible, repeatable and survives a save. Everything here maps
// onto the three CSS filter functions canvas actually supports, which is why
// there is no "gamma" preset: ctx.filter has no gamma, and a pixel-by-pixel
// pass would have to re-run on every preview redraw.

export const NEUTRAL = { brightness: 1, contrast: 1, saturate: 1 };

// Ceilings, because a frame pushed past these stops being the film.
const LIMITS = {
  brightness: [0.5, 4],
  contrast: [0.5, 4],
  saturate: [0, 3],
};

// The steepest levels stretch Auto will apply. Past this it is amplifying
// sensor noise and compression blocks rather than revealing a picture.
const MAX_SLOPE = 3.5;

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;

export function normalizeAdjust(adjust) {
  const a = adjust && typeof adjust === 'object' ? adjust : {};
  const out = {};
  for (const key of Object.keys(NEUTRAL)) {
    const v = Number(a[key]);
    out[key] = round2(clamp(Number.isFinite(v) && v > 0 ? v : NEUTRAL[key], LIMITS[key]));
  }
  return out;
}

export function isNeutral(adjust) {
  const a = normalizeAdjust(adjust);
  return Object.keys(NEUTRAL).every((k) => a[k] === NEUTRAL[k]);
}

// The string handed to ctx.filter. Empty when nothing is set, so the common
// case costs the compositor nothing at all.
export function filterString(adjust) {
  const a = normalizeAdjust(adjust);
  if (isNeutral(a)) return '';
  return `brightness(${a.brightness}) contrast(${a.contrast}) saturate(${a.saturate})`;
}

// The menu, in the order it is shown.
//
// Brightness here is CSS brightness, which MULTIPLIES: black stays black and
// everything else scales up. That is why these presets are pure gain with no
// contrast riding along. Pairing the two was measurably wrong — contrast pushes
// values away from the midpoint, so on a dark frame, where almost everything
// sits below it, a contrast bump drags the picture back down and can leave it
// darker than it started.
//
// Opening up the murk is the opposite move: gain UP and contrast slightly DOWN,
// which is what "Lift shadows" is for. It is the closest CSS filters get to a
// gamma curve, since ctx.filter has no gamma.
export const PRESETS = [
  { key: 'auto', label: 'Auto levels', hint: 'Measure this frame and stretch it to fill the range' },
  { key: 'brighter10', label: 'Brighter +10%', hint: 'Straight gain, blacks stay black', step: { brightness: 1.1 } },
  { key: 'brighter20', label: 'Brighter +20%', hint: 'More gain, for a properly dark scene', step: { brightness: 1.2 } },
  { key: 'lift', label: 'Lift shadows', hint: 'Open up the murk without blowing the highlights', step: { brightness: 1.25, contrast: 0.92 } },
  { key: 'contrast', label: 'More contrast', hint: 'Put the punch back after a big lift', step: { contrast: 1.12 } },
  { key: 'saturate', label: 'More colour', hint: 'Lifting drains colour; this puts it back', step: { saturate: 1.15 } },
  { key: 'desaturate', label: 'Less colour', hint: 'For a frame that has gone lurid', step: { saturate: 0.88 } },
  { key: 'reset', label: 'Reset', hint: 'Back to the frame as grabbed' },
];

export const PRESET_KEYS = PRESETS.map((p) => p.key);

// Presets COMPOUND: picking "Brighter +10%" twice is 21% up, not 10%. That is
// what makes a menu of fixed steps usable as a dial.
export function applyPreset(adjust, key, levels = null) {
  if (key === 'reset') return { ...NEUTRAL };
  if (key === 'auto') return levels ? normalizeAdjust(levels) : normalizeAdjust(adjust);
  const preset = PRESETS.find((p) => p.key === key);
  if (!preset?.step) return normalizeAdjust(adjust);
  const base = normalizeAdjust(adjust);
  const next = { ...base };
  for (const [k, mul] of Object.entries(preset.step)) next[k] = base[k] * mul;
  return normalizeAdjust(next);
}

// Turn a measured black point and white point into brightness + contrast.
//
// A levels stretch is out = (x - black) / (white - black). CSS applies
// `brightness(b) contrast(c)` as out = x*b*c - c/2 + 1/2, so matching the two
// gives an exact answer rather than an approximation:
//
//   s = 1 / (white - black)      the slope we want
//   c = 1 + 2*black*s            from the offset term
//   b = s / c
//
// `black` and `white` are luminance in 0..1, normally the 1st and 99th
// percentile rather than the true min and max, so one stray specular highlight
// cannot flatten the whole stretch.
export function autoLevels({ black = 0, white = 1 } = {}) {
  const lo = Math.min(Math.max(Number(black) || 0, 0), 1);
  const hi = Math.min(Math.max(Number(white) || 1, 0), 1);
  // Too narrow a range means a nearly flat frame; stretching it would be noise
  // amplification, so leave it alone rather than invent detail.
  if (!(hi - lo > 0.02)) return { ...NEUTRAL };
  // Clamp the SLOPE, not the two values it resolves into. Clamping brightness
  // and contrast separately breaks the pair they form, and the black point
  // stops landing on black — which is the one thing this is for.
  const s = Math.min(1 / (hi - lo), MAX_SLOPE);
  const c = 1 + 2 * lo * s;
  return normalizeAdjust({ brightness: s / c, contrast: c, saturate: 1 });
}

// A short human summary for the button, e.g. "+20% brighter".
export function describeAdjust(adjust) {
  const a = normalizeAdjust(adjust);
  if (isNeutral(a)) return '';
  const bits = [];
  const pct = (v) => `${v > 1 ? '+' : ''}${Math.round((v - 1) * 100)}%`;
  if (a.brightness !== 1) bits.push(`${pct(a.brightness)} bright`);
  if (a.contrast !== 1) bits.push(`${pct(a.contrast)} contrast`);
  if (a.saturate !== 1) bits.push(`${pct(a.saturate)} colour`);
  return bits.join(', ');
}
