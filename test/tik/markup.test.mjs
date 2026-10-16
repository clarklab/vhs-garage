import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Every element the studio scripts reach for must exist in the page.
//
// There is no bundler and no type checking across the markup boundary, so an
// id that stops existing is found at runtime, by a null, in whatever unrelated
// thing happens to touch it first — an editing slip in tik.astro took out the
// slide list and surfaced as "new project failed: Cannot read properties of
// null" from the adjust menu. This is the cheap version of that lesson.

const html = readFileSync(new URL('../../src/pages/tik.astro', import.meta.url), 'utf8');
const ids = (src) => [...new Set([
  ...[...src.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
  ...[...src.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
])];

for (const file of ['app.js', 'shoot.js']) {
  test(`every element ${file} looks up exists in tik.astro`, () => {
    const src = readFileSync(new URL(`../../public/scripts/tik/${file}`, import.meta.url), 'utf8');
    const wanted = ids(src);
    assert.ok(wanted.length > 10, `expected to find id lookups in ${file}, found ${wanted.length}`);
    const missing = wanted.filter((id) => !html.includes(`id="${id}"`));
    assert.deepEqual(missing, [], `${file} reaches for ${missing.length} element(s) the page does not have`);
  });
}

test('the ids the clip and fix-up flows depend on are all present', () => {
  // Named explicitly because these are the newest, and the ones an editing
  // slip in the middle of a long file is most likely to take with it.
  for (const id of [
    'slide-list', 'adjust-menu', 'adjust-home', 'subs-note',
    'clip-bar', 'clip-note', 'clip-fix', 'clip-render', 'out-video', 'out-slides',
    'file-fix', 'batch-drafts',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `#${id} is missing from tik.astro`);
  }
});
