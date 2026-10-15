import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import {
  OUTRO_DESIGNS, DEFAULT_OUTRO, OUTRO_VIDEO_SECONDS, OUTRO_STORAGE_KEY,
  outroDesign, outroKeyOf, outroHoldSeconds, rememberedOutro,
} from '../../public/scripts/tik/outros.js';
import { isFullCard } from '../../public/scripts/tik/compose.js';
import { planClip, STILL_SECONDS } from '../../public/scripts/tik/clip.js';

const PUBLIC = new URL('../../public', import.meta.url).pathname;

// PNG width/height live at fixed offsets in the IHDR chunk.
function pngSize(path) {
  const b = readFileSync(path);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

test('the four choices are the logo and three designed cards', () => {
  assert.deepEqual(OUTRO_DESIGNS.map((d) => d.key), ['logo', 'aisle', 'play', 'plus']);
  assert.equal(DEFAULT_OUTRO, 'logo');
  assert.equal(outroDesign('logo').video, null, 'the logo has nothing to animate');
});

test('every designed card ships a full-size still and its video', () => {
  for (const d of OUTRO_DESIGNS.filter((x) => x.video)) {
    assert.deepEqual(pngSize(PUBLIC + d.still), { width: 1080, height: 1920 }, d.still);
    assert.ok(existsSync(PUBLIC + d.video), d.video);
    assert.ok(statSync(PUBLIC + d.video).size < 8 * 1024 * 1024, `${d.video} is heavy for a page asset`);
  }
  assert.ok(existsSync(PUBLIC + outroDesign('logo').still));
});

test('an outro saved before there was a choice is the logo', () => {
  assert.equal(outroKeyOf({ kind: 'outro' }), 'logo');
  assert.equal(outroKeyOf({ kind: 'outro', outroStyle: 'nonsense' }), 'logo');
  assert.equal(outroKeyOf({ kind: 'outro', outroStyle: 'plus' }), 'plus');
  assert.equal(outroKeyOf(null), 'logo');
});

test('the last card picked is what new sets end on', () => {
  const store = (v) => ({ getItem: (k) => (k === OUTRO_STORAGE_KEY ? v : null) });
  assert.equal(rememberedOutro(store('aisle')), 'aisle');
  assert.equal(rememberedOutro(store(null)), 'logo');
  assert.equal(rememberedOutro(store('gone')), 'logo', 'a card that was removed falls back');
  assert.equal(rememberedOutro({ getItem() { throw new Error('blocked'); } }), 'logo', 'blocked storage is not fatal');
});

// ---- Drawn edge to edge, captionless ----

test('a designed card is a full card; the square logo is not', () => {
  assert.equal(isFullCard({ kind: 'outro', width: 1080, height: 1920 }), true);
  assert.equal(isFullCard({ kind: 'outro', width: 540, height: 960 }), true, 'any size at 9:16');
  assert.equal(isFullCard({ kind: 'outro', width: 1024, height: 1024 }), false, 'the logo keeps its caption');
  assert.equal(isFullCard({ kind: null, width: 1080, height: 1920 }), false, 'a portrait frame mid-set is still a frame');
  assert.equal(isFullCard({ kind: 'outro', width: 0, height: 0 }), false, 'a video that has not loaded yet');
});

// ---- In the clip ----

test('the clip holds a designed card for its whole animation, the logo as before', () => {
  const isOutro = (s) => s.kind === 'outro';
  const holdSeconds = (s) => (isOutro(s) ? outroHoldSeconds(s) : null);
  const plan = (style) => planClip([{ id: 'o', kind: 'outro', outroStyle: style }], { isOutro, holdSeconds });
  assert.equal(plan('play').parts[0].seconds, OUTRO_VIDEO_SECONDS);
  assert.equal(plan('logo').parts[0].seconds, STILL_SECONDS);
  assert.equal(plan(undefined).parts[0].seconds, STILL_SECONDS);
});
