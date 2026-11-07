// Measure a frame so Auto levels has something to stretch against.
//
// Sampled small and on a stride: a full 1080p read is two million pixels for a
// number that only needs to be roughly right, and this runs on a tap. Shared by
// the studio's Adjust menu and the phone's, so both measure the same way.
import { levelsFromPixels } from './adjust.js';

export function measureLevels(bitmap) {
  const W = 160;
  const H = Math.max(1, Math.round((bitmap.height / bitmap.width) * W));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, W, H);
  return levelsFromPixels(ctx.getImageData(0, 0, W, H).data);
}
