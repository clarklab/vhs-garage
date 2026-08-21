import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triviaScore, normalizeTrivia, rankTrivia, normalizeTitle, quotePlainText, normalizeQuote, rankQuotes } from '../../netlify/functions/lib/imdb.mjs';
import { createTriviaPool, helpfulLabel, DEFAULT_PICK } from '../../public/scripts/tik/triviapool.js';

// IMDb gives us ups and TOTAL votes, so downs are the difference.
const node = (id, up, voted, extra = {}) => ({
  id, text: { plainText: `fact ${id}` },
  interestScore: { usersInterested: up, usersVoted: voted },
  isSpoiler: false, ...extra,
});

// ---- scoring ----

test('triviaScore is ups minus downs, not raw ups', () => {
  assert.equal(triviaScore(node('a', 2230, 2240)), 2220); // 2230 up, 10 down
  assert.equal(triviaScore(node('b', 300, 550)), 50);     // 300 up, 250 down
  assert.equal(triviaScore(node('c', 280, 285)), 275);    // 280 up, 5 down
});

test('a contested item ranks below a quieter one everybody agrees on', () => {
  // The whole reason we rank on net: 300 ups looks better than 280 until you
  // see the 250 downs underneath it.
  assert.ok(triviaScore(node('contested', 300, 550)) < triviaScore(node('agreed', 280, 285)));
});

test('triviaScore survives missing, partial, and junk vote data', () => {
  assert.equal(triviaScore(null), 0);
  assert.equal(triviaScore({}), 0);
  assert.equal(triviaScore({ interestScore: {} }), 0);
  assert.equal(triviaScore({ interestScore: { usersInterested: 5 } }), 5); // no total → no downs
  assert.equal(triviaScore({ interestScore: { usersInterested: 'x', usersVoted: 'y' } }), 0);
  // Fewer total votes than ups is impossible; clamp rather than invent downs.
  assert.equal(triviaScore(node('weird', 100, 40)), 100);
});

// ---- normalizing ----

test('normalizeTrivia flattens a node and splits up/down', () => {
  assert.deepEqual(normalizeTrivia(node('tr1', 2230, 2240)), {
    id: 'tr1', text: 'fact tr1', up: 2230, down: 10, score: 2220, spoiler: false,
  });
});

test('normalizeTrivia collapses whitespace and rejects empty text', () => {
  const n = { id: 'x', text: { plainText: '  a   line\n\nbroken  up ' }, interestScore: {} };
  assert.equal(normalizeTrivia(n).text, 'a line broken up');
  assert.equal(normalizeTrivia({ id: 'y', text: { plainText: '   ' } }), null);
  assert.equal(normalizeTrivia({ id: 'z' }), null);
  assert.equal(normalizeTrivia(null), null);
});

test('normalizeTrivia carries the spoiler flag through', () => {
  assert.equal(normalizeTrivia(node('s', 10, 10, { isSpoiler: true })).spoiler, true);
  assert.equal(normalizeTrivia(node('n', 10, 10)).spoiler, false);
});

// ---- ranking ----

test('rankTrivia sorts most helpful first', () => {
  const out = rankTrivia([node('a', 10, 12), node('b', 900, 910), node('c', 100, 105)]);
  assert.deepEqual(out.map((i) => i.id), ['b', 'c', 'a']);
});

test('rankTrivia drops duplicate ids and blank text', () => {
  const out = rankTrivia([node('a', 10, 10), node('a', 999, 999), { id: 'b', text: { plainText: '' } }]);
  assert.deepEqual(out.map((i) => i.id), ['a']);
  assert.equal(out[0].up, 10, 'first occurrence wins');
});

test('rankTrivia can exclude spoilers', () => {
  const items = [node('plain', 10, 10), node('spoil', 999, 999, { isSpoiler: true })];
  assert.deepEqual(rankTrivia(items).map((i) => i.id), ['spoil', 'plain']);
  assert.deepEqual(rankTrivia(items, { includeSpoilers: false }).map((i) => i.id), ['plain']);
});

test('rankTrivia is deterministic when scores tie', () => {
  // Two unvoted items must not shuffle between runs — the pool refills in
  // rank order, so a wobbly sort would hand back a different #11 each time.
  const items = [node('zz', 0, 0), node('aa', 0, 0), node('mm', 0, 0)];
  const once = rankTrivia(items).map((i) => i.id);
  const twice = rankTrivia([...items].reverse()).map((i) => i.id);
  assert.deepEqual(once, ['aa', 'mm', 'zz']);
  assert.deepEqual(once, twice);
});

test('rankTrivia accepts already-normalized items as well as raw nodes', () => {
  const out = rankTrivia([{ id: 'n', text: 'flat', up: 5, down: 1, score: 4, spoiler: false }]);
  assert.deepEqual(out.map((i) => i.id), ['n']);
});

test('rankTrivia handles junk input without throwing', () => {
  assert.deepEqual(rankTrivia(null), []);
  assert.deepEqual(rankTrivia([null, undefined, 5, 'x']), []);
});

// ---- title normalizing ----

test('normalizeTitle flattens a search entity', () => {
  assert.deepEqual(normalizeTitle({
    id: 'tt0099785', titleText: { text: 'Home Alone' }, releaseYear: { year: 1990 },
    runtime: { seconds: 6180 }, ratingsSummary: { aggregateRating: 7.8, voteCount: 750627 },
  }), {
    id: 'tt0099785', title: 'Home Alone', year: 1990, runtimeSeconds: 6180,
    rating: 7.8, votes: 750627, poster: null,
  });
});

test('normalizeTitle rejects anything without a real IMDb id and title', () => {
  assert.equal(normalizeTitle({ id: 'nm0000582', titleText: { text: 'Joe Pesci' } }), null);
  assert.equal(normalizeTitle({ id: 'tt0099785', titleText: { text: '' } }), null);
  assert.equal(normalizeTitle(null), null);
});

test('normalizeTitle nulls out missing numbers rather than emitting NaN', () => {
  const out = normalizeTitle({ id: 'tt1234567', titleText: { text: 'Untitled' } });
  assert.deepEqual([out.year, out.runtimeSeconds, out.rating, out.votes], [null, null, null, null]);
});

// ---- quotes ----

test('quotePlainText prefers plainText then joins character lines', () => {
  assert.equal(quotePlainText({ text: { plainText: "I'll be back." } }), "I'll be back.");
  assert.equal(quotePlainText({
    lines: [
      { characters: [{ character: 'Terminator' }], text: "I'll be back." },
    ],
  }), "Terminator: I'll be back.");
  assert.equal(quotePlainText({ text: { plainText: '  ' } }), '');
  assert.equal(quotePlainText(null), '');
});

test('normalizeQuote and rankQuotes reuse trivia scoring', () => {
  const a = normalizeQuote({
    id: 'q1', text: { plainText: "I'll be back." },
    interestScore: { usersInterested: 900, usersVoted: 910 }, isSpoiler: false,
  });
  const b = normalizeQuote({
    id: 'q2', text: { plainText: 'Get out.' },
    interestScore: { usersInterested: 10, usersVoted: 12 }, isSpoiler: true,
  });
  assert.equal(a.text, "I'll be back.");
  assert.equal(a.score, 890);
  const ranked = rankQuotes([b, a]);
  assert.deepEqual(ranked.map((x) => x.id), ['q1', 'q2']);
  assert.deepEqual(rankQuotes([b, a], { includeSpoilers: false }).map((x) => x.id), ['q1']);
});

test('normalizeQuote joins TitleQuote lines and skips stage directions', () => {
  const q = normalizeQuote({
    id: 'qt0001',
    isSpoiler: false,
    interestScore: { usersInterested: 900, usersVoted: 910 },
    lines: [
      { text: null, stageDirection: '[drawing a gun]', characters: [] },
      { text: "I'll be back.", characters: [{ character: 'The Terminator' }] },
    ],
  });
  assert.ok(q);
  assert.equal(q.text, "The Terminator: I'll be back.");
  assert.equal(q.score, 890);
});

// ---- the pool ----

const pooled = (n) => Array.from({ length: n }, (_, i) => ({
  id: `t${i + 1}`, text: `fact ${i + 1}`, up: 1000 - i, down: 0, score: 1000 - i, spoiler: false,
}));

test('a fresh pool shows the top ten', () => {
  const pool = createTriviaPool(pooled(50));
  assert.equal(pool.visible().length, DEFAULT_PICK);
  assert.deepEqual(pool.visible().map((i) => i.id).slice(0, 3), ['t1', 't2', 't3']);
  assert.equal(pool.benchCount(), 40);
});

test('removing an item pulls the next-best one up', () => {
  const pool = createTriviaPool(pooled(50));
  assert.equal(pool.remove('t3'), true);
  const ids = pool.visible().map((i) => i.id);
  assert.equal(ids.length, DEFAULT_PICK, 'still a full ten');
  assert.ok(!ids.includes('t3'));
  assert.ok(ids.includes('t11'), 'the bench item slid into view');
  assert.equal(pool.benchCount(), 39);
});

test('delete three, get three back', () => {
  const pool = createTriviaPool(pooled(50));
  ['t1', 't5', 't9'].forEach((id) => pool.remove(id));
  const ids = pool.visible().map((i) => i.id);
  assert.equal(ids.length, DEFAULT_PICK);
  assert.deepEqual(ids.filter((id) => ['t1', 't5', 't9'].includes(id)), []);
  assert.deepEqual(ids.slice(-3), ['t11', 't12', 't13']);
});

test('a refill never hands back something already rejected', () => {
  const pool = createTriviaPool(pooled(12));
  for (let i = 0; i < 5; i++) pool.remove(pool.visible()[0].id);
  const seen = pool.visible().map((i) => i.id);
  assert.deepEqual(seen.filter((id) => pool.removed().some((r) => r.id === id)), []);
});

test('removing is idempotent and ignores unknown ids', () => {
  const pool = createTriviaPool(pooled(20));
  assert.equal(pool.remove('t2'), true);
  assert.equal(pool.remove('t2'), false, 'already gone');
  assert.equal(pool.remove('nope'), false);
  assert.equal(pool.visible().length, DEFAULT_PICK);
});

test('restore puts an item back at its ranked position', () => {
  const pool = createTriviaPool(pooled(50));
  pool.remove('t2');
  assert.equal(pool.visible()[1].id, 't3');
  assert.equal(pool.restore('t2'), true);
  assert.equal(pool.visible()[1].id, 't2', 'back in rank order, not appended');
  assert.equal(pool.benchCount(), 40);
});

test('the pool reports exhaustion instead of quietly showing a short list', () => {
  const pool = createTriviaPool(pooled(12));
  assert.equal(pool.exhausted(), false);
  ['t1', 't2', 't3'].forEach((id) => pool.remove(id));
  assert.equal(pool.visible().length, 9);
  assert.equal(pool.exhausted(), true);
  assert.equal(pool.benchCount(), 0);
});

test('replaceAll swaps the whole visible set for the next ten', () => {
  const pool = createTriviaPool(pooled(50));
  const first = pool.visible().map((i) => i.id);
  const next = pool.replaceAll().map((i) => i.id);
  assert.deepEqual(next, ['t11', 't12', 't13', 't14', 't15', 't16', 't17', 't18', 't19', 't20']);
  assert.deepEqual(next.filter((id) => first.includes(id)), []);
});

test('reset brings every rejected item back', () => {
  const pool = createTriviaPool(pooled(50));
  ['t1', 't2', 't3'].forEach((id) => pool.remove(id));
  assert.deepEqual(pool.reset().map((i) => i.id)[0], 't1');
  assert.equal(pool.removed().length, 0);
});

test('setSize grows and shrinks the visible set, clamped to sane bounds', () => {
  const pool = createTriviaPool(pooled(50));
  assert.equal(pool.setSize(5).length, 5);
  assert.equal(pool.setSize(20).length, 20);
  assert.equal(pool.setSize(0).length, 1, 'floored at one');
  assert.equal(pool.setSize(999).length, 25, 'capped at MAX_PICK');
  assert.equal(pool.setSize(NaN).length, DEFAULT_PICK, 'junk falls back to the default');
});

test('a pool smaller than the pick size is not padded', () => {
  const pool = createTriviaPool(pooled(4));
  assert.equal(pool.visible().length, 4);
  assert.equal(pool.exhausted(), true);
  assert.equal(pool.benchCount(), 0);
});

test('an empty pool degrades quietly', () => {
  const pool = createTriviaPool([]);
  assert.deepEqual(pool.visible(), []);
  assert.equal(pool.total(), 0);
  assert.equal(pool.remove('anything'), false);
});

test('the pool drops blank items and survives junk input', () => {
  const pool = createTriviaPool([{ id: 'a', text: 'ok' }, { id: 'b', text: '  ' }, null, 7]);
  assert.deepEqual(pool.visible().map((i) => i.id), ['a']);
  assert.deepEqual(createTriviaPool(null).visible(), []);
});

test('helpfulLabel matches the signal IMDb shows on the card', () => {
  assert.equal(helpfulLabel({ up: 2230 }), '2.2K helpful');
  assert.equal(helpfulLabel({ up: 1_100_000 }), '1.1M helpful');
  assert.equal(helpfulLabel({ up: 2000 }), '2K helpful');
  assert.equal(helpfulLabel({ up: 642 }), '642 helpful');
  assert.equal(helpfulLabel({ up: 0 }), 'no votes yet');
  assert.equal(helpfulLabel({}), 'no votes yet');
});
