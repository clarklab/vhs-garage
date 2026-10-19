// Timeline math for stitching library clips into one video (stitch.js).
//
// Transitions:
//   cut       — clips play back to back.
//   crossfade — each clip overlaps the next by up to CROSSFADE_SEC, picture
//               dissolving and audio crossfading (equal-power).
//   static    — a burst of TV static (picture + hiss) between clips, like
//               flipping channels.

export const CROSSFADE_SEC = 0.8;
export const STATIC_SEC = 0.6;
// Short gain ramp at hard audio edges so cuts don't click.
export const EDGE_RAMP_SEC = 0.012;

export function planStitch(durations, transition = 'cut') {
  const clips = [];
  const fades = [];   // { start, length, from, to }
  const statics = []; // { start, length }
  let t = 0;
  durations.forEach((d, i) => {
    clips.push({ index: i, start: t, duration: d, end: t + d });
    const next = durations[i + 1];
    if (next == null) { t += d; return; }
    if (transition === 'crossfade') {
      const x = Math.min(CROSSFADE_SEC, d / 3, next / 3);
      fades.push({ start: t + d - x, length: x, from: i, to: i + 1 });
      t += d - x;
    } else if (transition === 'static') {
      statics.push({ start: t + d, length: STATIC_SEC });
      t += d + STATIC_SEC;
    } else {
      t += d;
    }
  });
  return { clips, fades, statics, total: t, transition };
}

// What to draw at output time t: [{ index, sourceTime, alpha }] plus
// whether static fills the frame.
export function frameAt(plan, t) {
  const layers = [];
  for (const c of plan.clips) {
    if (t < c.start || t >= c.end) continue;
    let alpha = 1;
    const fadeIn = plan.fades.find(f => f.to === c.index);
    if (fadeIn && t < fadeIn.start + fadeIn.length) alpha = (t - fadeIn.start) / fadeIn.length;
    layers.push({ index: c.index, sourceTime: t - c.start, alpha });
  }
  const inStatic = plan.statics.some(s => t >= s.start && t < s.start + s.length);
  return { layers, static: inStatic };
}

// Audio gain for clip `index` at output time t (0 outside the clip).
export function clipGainAt(plan, index, t) {
  const c = plan.clips[index];
  if (t < c.start || t >= c.end) return 0;
  const fadeIn = plan.fades.find(f => f.to === index);
  const fadeOut = plan.fades.find(f => f.from === index);
  if (fadeIn && t < fadeIn.start + fadeIn.length) {
    return Math.sin(((t - fadeIn.start) / fadeIn.length) * Math.PI / 2);
  }
  if (fadeOut && t >= fadeOut.start) {
    return Math.cos(((t - fadeOut.start) / fadeOut.length) * Math.PI / 2);
  }
  // Hard edges (first/last clip, cut, static): tiny ramps against clicks.
  const ramp = Math.min(EDGE_RAMP_SEC, c.duration / 4);
  if (!fadeIn && t - c.start < ramp) return (t - c.start) / ramp;
  if (!fadeOut && c.end - t < ramp) return (c.end - t) / ramp;
  return 1;
}

export function staticGainAt(plan, t) {
  const s = plan.statics.find(x => t >= x.start && t < x.start + x.length);
  if (!s) return 0;
  const ramp = 0.03;
  const into = t - s.start;
  const left = s.start + s.length - t;
  return Math.min(1, into / ramp, left / ramp);
}
