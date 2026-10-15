// The end card: the plain logo, or one of three designed follow cards.
//
// A designed card is a finished 1080x1920 picture with its own words on it,
// rendered by scripts/outros/render.py. Its still is the last slide of a photo
// post; its video is what the Quote-a-long clip plays as the sign-off.
//
// No DOM, no network. Unit-tested.

export const OUTRO_DESIGNS = [
  { key: 'logo', label: 'Logo', still: '/images/vhs-garage-logo-square.png', video: null },
  { key: 'aisle', label: 'The Aisle', still: '/tik/outros/aisle.png', video: '/tik/outros/aisle.mp4' },
  { key: 'play', label: 'Play', still: '/tik/outros/play.png', video: '/tik/outros/play.mp4' },
  { key: 'plus', label: 'Hit the +', still: '/tik/outros/plus.png', video: '/tik/outros/plus.mp4' },
];

export const DEFAULT_OUTRO = 'logo';
// The last card picked, per browser: it is what new sets end on.
export const OUTRO_STORAGE_KEY = 'tik_outro_style';

export function rememberedOutro(storage = globalThis.localStorage) {
  try { return outroDesign(storage?.getItem(OUTRO_STORAGE_KEY) || DEFAULT_OUTRO).key; } catch { return DEFAULT_OUTRO; }
}
export const OUTRO_VIDEO_SECONDS = 5;

export function outroDesign(key) {
  return OUTRO_DESIGNS.find((d) => d.key === key) || OUTRO_DESIGNS[0];
}

// Slides made before there was a choice have no style, and they are the logo.
export function outroKeyOf(slide) {
  return outroDesign(slide?.outroStyle).key;
}

// How long the clip holds the sign-off: the card's own animation when it has
// one, otherwise whatever the plan holds any still for (null = no opinion).
export function outroHoldSeconds(slide) {
  return outroDesign(slide?.outroStyle).video ? OUTRO_VIDEO_SECONDS : null;
}
