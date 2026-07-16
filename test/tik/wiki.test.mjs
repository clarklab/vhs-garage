import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFilmSections, extractActorSections } from '../../netlify/functions/lib/wiki.mjs';

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

const actorArticle = `Keith David is an American actor known for his deep voice.

== Early life ==
Born in Harlem.

== Career ==
He starred in The Thing and They Live.

=== 1980s ===
Genre work defined the decade.

== Personal life ==
Lives quietly.

== Filmography ==
A long list of films.`;

test('extractActorSections keeps lead + career/filmography, drops personal life', () => {
  const out = extractActorSections(actorArticle);
  assert.match(out, /^Keith David is an American actor/);
  assert.match(out, /Career:/);
  assert.match(out, /The Thing and They Live/);
  assert.match(out, /Filmography:/);
  assert.doesNotMatch(out, /Lives quietly/);
  assert.doesNotMatch(out, /Born in Harlem/);
});

test('extractActorSections strips sub-headings, caps length, survives junk', () => {
  const out = extractActorSections(actorArticle);
  assert.doesNotMatch(out, /=== 1980s ===/);
  assert.match(out, /Genre work defined the decade/);
  assert.ok(extractActorSections(`Lead.\n\n== Career ==\n${'x'.repeat(50000)}`, 4000).length <= 4000);
  assert.equal(extractActorSections(''), '');
  assert.equal(extractActorSections(null), '');
});
