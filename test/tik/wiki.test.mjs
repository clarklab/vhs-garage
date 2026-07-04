import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFilmSections } from '../../netlify/functions/lib/wiki.mjs';

const article = `Jaws is a 1975 American thriller film directed by Steven Spielberg.

== Plot ==
A shark eats people.

== Production ==
Principal photography began May 2, 1974 on Martha's Vineyard.

=== Mechanical sharks ===
Three pneumatic sharks were built.

== Filming ==
The shoot ran 159 days over schedule.

== Reception ==
It was a hit.

== Music ==
John Williams wrote a two-note motif.`;

test('extractFilmSections keeps lead + production-adjacent sections, drops plot/reception', () => {
  const out = extractFilmSections(article);
  assert.match(out, /^Jaws is a 1975 American thriller/);
  assert.match(out, /Production:/);
  assert.match(out, /Martha's Vineyard/);
  assert.match(out, /Filming:/);
  assert.match(out, /Music:/);
  assert.doesNotMatch(out, /A shark eats people/);
  assert.doesNotMatch(out, /It was a hit/);
});

test('extractFilmSections strips sub-headings but keeps their prose', () => {
  const out = extractFilmSections(article);
  assert.doesNotMatch(out, /=== Mechanical sharks ===/);
  assert.match(out, /Three pneumatic sharks were built/);
});

test('extractFilmSections caps output length', () => {
  const long = `Lead.\n\n== Production ==\n${'x'.repeat(50000)}`;
  assert.ok(extractFilmSections(long, 5000).length <= 5000);
});

test('extractFilmSections returns empty string for empty/junk input', () => {
  assert.equal(extractFilmSections(''), '');
  assert.equal(extractFilmSections(null), '');
});
