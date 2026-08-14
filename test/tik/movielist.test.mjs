import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTitleList, pickBestMatch, titleKey, MAX_PASTED,
} from '../../public/scripts/tik/movielist.js';

// ---- parsing a pasted list ----

test('parseTitleList reads a plain newline list', () => {
  assert.deepEqual(
    parseTitleList('The Thing\nJaws\nAlien').map((r) => r.title),
    ['The Thing', 'Jaws', 'Alien'],
  );
});

test('parseTitleList pulls the year out of every shape people write it', () => {
  const rows = parseTitleList([
    'The Thing (1982)',
    'Jaws [1975]',
    'Alien - 1979',
    'Predator, 1987',
    'Die Hard 1988',
  ].join('\n'));
  assert.deepEqual(rows.map((r) => [r.title, r.year]), [
    ['The Thing', '1982'],
    ['Jaws', '1975'],
    ['Alien', '1979'],
    ['Predator', '1987'],
    ['Die Hard', '1988'],
  ]);
});

test('parseTitleList strips numbering and bullets', () => {
  const rows = parseTitleList('1. The Thing\n2) Jaws\n- Alien\n* Predator\n• Robocop');
  assert.deepEqual(rows.map((r) => r.title), ['The Thing', 'Jaws', 'Alien', 'Predator', 'Robocop']);
});

test('parseTitleList takes the first column of a pasted table', () => {
  const rows = parseTitleList('The Thing\t1982\t8.2\nJaws|1975|8.1');
  assert.deepEqual(rows.map((r) => r.title), ['The Thing', 'Jaws']);
});

test('parseTitleList skips blanks and a heading line', () => {
  const rows = parseTitleList('Movies:\n\nThe Thing\n\n   \nJaws\n');
  assert.deepEqual(rows.map((r) => r.title), ['The Thing', 'Jaws']);
});

test('parseTitleList keeps a year that IS the title', () => {
  // "1917" is a film. Stripping it would leave an empty row.
  const rows = parseTitleList('1917\n2012');
  assert.deepEqual(rows.map((r) => r.title), ['1917', '2012']);
});

test('parseTitleList keeps a title that contains a number', () => {
  const rows = parseTitleList('Apollo 13\nSe7en\nOcean’s 11');
  assert.deepEqual(rows.map((r) => r.title), ['Apollo 13', 'Se7en', 'Ocean’s 11']);
});

test('parseTitleList dedupes the same film listed twice', () => {
  const rows = parseTitleList('The Thing (1982)\nthe thing (1982)\nThe Thing (2011)');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.year), ['1982', '2011']);
});

test('parseTitleList caps a runaway paste', () => {
  const rows = parseTitleList(Array.from({ length: 300 }, (_, i) => `Film ${i}`).join('\n'));
  assert.equal(rows.length, MAX_PASTED);
});

test('parseTitleList on junk returns an empty array', () => {
  assert.deepEqual(parseTitleList(''), []);
  assert.deepEqual(parseTitleList('   \n\n  '), []);
  assert.deepEqual(parseTitleList(null), []);
  assert.deepEqual(parseTitleList(42), []);
});

// ---- title normalizing ----

test('titleKey ignores case, punctuation, articles, and a trailing year', () => {
  assert.equal(titleKey('The Thing (1982)'), titleKey('the thing'));
  assert.equal(titleKey('E.T.'), titleKey('ET'));
  assert.equal(titleKey('Ferris Bueller’s Day Off'), titleKey('Ferris Buellers Day Off'));
  assert.equal(titleKey('Fast & Furious'), titleKey('Fast and Furious'));
});

test('titleKey keeps genuinely different films apart', () => {
  assert.notEqual(titleKey('Alien'), titleKey('Aliens'));
  assert.notEqual(titleKey('The Thing'), titleKey('The Thing Called Love'));
});

// ---- matching against search results ----

const cand = (title, year, votes = null) => ({ title, year, votes, imdbId: `tt${title.length}${year}` });

test('pickBestMatch takes the exact title and year', () => {
  const { pick, confidence } = pickBestMatch(
    { title: 'The Thing', year: '1982' },
    [cand('The Thing', '2011'), cand('The Thing', '1982'), cand('The Thing', '1951')],
  );
  assert.equal(pick.year, '1982');
  assert.equal(confidence, 'exact');
});

test('pickBestMatch takes the most-watched when no year is given', () => {
  // A bare "The Thing" means the one people mean — Carpenter's — and votes are
  // what say so. Order in the list deliberately puts the wrong one first.
  const { pick, confidence } = pickBestMatch(
    { title: 'The Thing', year: null },
    [cand('The Thing', '2011', 130_000), cand('The Thing', '1982', 460_000)],
  );
  assert.equal(pick.year, '1982');
  assert.equal(confidence, 'title');
});

test('popularity beats age — a remake that outgrew the original wins', () => {
  // The old rule picked the oldest print, which is wrong whenever the remake is
  // the famous one. Nothing here should make 1932 the answer.
  const { pick } = pickBestMatch(
    { title: 'Scarface', year: null },
    [cand('Scarface', '1932', 26_000), cand('Scarface', '1983', 890_000)],
  );
  assert.equal(pick.year, '1983');
});

test('with no vote counts it falls back to IMDb order, which is relevance', () => {
  const { pick } = pickBestMatch(
    { title: 'The Thing', year: null },
    [cand('The Thing', '1982'), cand('The Thing', '2011')],
  );
  assert.equal(pick.year, '1982', 'should keep the order IMDb returned');
});

test('an explicit year still outranks popularity', () => {
  // Asking for The Thing (1951) means the 1951 one, however small its audience.
  const { pick, confidence } = pickBestMatch(
    { title: 'The Thing', year: '1951' },
    [cand('The Thing', '1982', 460_000), cand('The Thing', '1951', 40_000)],
  );
  assert.equal(pick.year, '1951');
  assert.equal(confidence, 'exact');
});

test('a wrong year still keeps the right film, and the popular cut of it', () => {
  // Mistyped years are more common than the wrong movie entirely.
  const { pick, confidence } = pickBestMatch(
    { title: 'Jaws', year: '1976' },
    [cand('Jaws', '1975', 650_000), cand('Jaws 2', '1978', 70_000)],
  );
  assert.equal(pick.title, 'Jaws');
  assert.equal(confidence, 'title');
});

test('pickBestMatch falls back to the top hit and says it is weak', () => {
  const { pick, confidence } = pickBestMatch(
    { title: 'Teh Thnig', year: null },
    [cand('The Thing', '1982'), cand('The Thing', '2011')],
  );
  assert.equal(pick.title, 'The Thing');
  assert.equal(confidence, 'weak');
});

test('pickBestMatch never invents a result', () => {
  assert.deepEqual(pickBestMatch({ title: 'Nothing' }, []), { pick: null, confidence: 'none' });
  assert.deepEqual(pickBestMatch({ title: 'Nothing' }, null), { pick: null, confidence: 'none' });
});

test('a near-miss title with a matching year is weak, not exact', () => {
  const { pick, confidence } = pickBestMatch(
    { title: 'Blade Runnr', year: '1982' },
    [cand('Blade Runner', '1982')],
  );
  assert.equal(pick.title, 'Blade Runner');
  assert.equal(confidence, 'weak');
});

// ---- outro rotation ----

test('the outro pool always asks for a share AND a follow', async () => {
  const { pickOutro, OUTRO_COUNT } = await import('../../public/scripts/tik/project.js');
  assert.ok(OUTRO_COUNT >= 10, `only ${OUTRO_COUNT} outros`);
  const seen = new Set();
  for (let i = 0; i < OUTRO_COUNT; i++) {
    const line = pickOutro('trivia', i / OUTRO_COUNT);
    seen.add(line);
    assert.match(line, /Follow VHS Garage/, line);
    assert.match(line, /send|share|tag|pass|show/i, `no share ask: ${line}`);
    assert.doesNotMatch(line, /[—–]/, `em dash in: ${line}`);
  }
  assert.equal(seen.size, OUTRO_COUNT, 'the pool repeats itself');
});

test('pickOutro tails the follow line per format', () => {
  // Imported lazily above; re-import here keeps this test self-contained.
  return import('../../public/scripts/tik/project.js').then(({ pickOutro }) => {
    assert.match(pickOutro('trivia', 0), /more movie trivia/);
    assert.match(pickOutro('guys', 0), /more forgotten legends/);
    assert.match(pickOutro('year', 0), /more trips back/);
    assert.match(pickOutro('nonsense', 0), /more movie trivia/); // safe default
  });
});

test('nextOutro never hands back the line already on the slide', async () => {
  const { pickOutro, nextOutro, OUTRO_COUNT } = await import('../../public/scripts/tik/project.js');
  // Walk the whole pool: from every line, every draw is a different line.
  for (let i = 0; i < OUTRO_COUNT; i++) {
    const current = pickOutro('trivia', i / OUTRO_COUNT);
    for (let j = 0; j < OUTRO_COUNT; j++) {
      const next = nextOutro('trivia', current, j / OUTRO_COUNT);
      assert.notEqual(next, current, `repeated from #${i} at r=${j}`);
      assert.match(next, /Follow VHS Garage/);
    }
  }
});

test('nextOutro follows the format and survives junk input', async () => {
  const { nextOutro } = await import('../../public/scripts/tik/project.js');
  assert.match(nextOutro('guys', '', 0), /more forgotten legends/);
  for (const cur of [null, undefined, '', 'not from the pool']) {
    assert.equal(typeof nextOutro('trivia', cur, 0.5), 'string', `broke on ${cur}`);
  }
  for (const r of [0, 0.999999, 1, 1.5, -3, NaN]) {
    assert.equal(typeof nextOutro('trivia', '', r), 'string', `broke on r=${r}`);
  }
});

// ---- which slide is this? ----

test('a marked slide is taken at its word', async () => {
  const { isIntroSlide, isOutroSlide } = await import('../../public/scripts/tik/project.js');
  assert.ok(isIntroSlide({ kind: 'title', caption: 'Jaws (1975)\nOpener' }, 0));
  assert.ok(isOutroSlide({ kind: 'outro', caption: 'Follow VHS Garage for more' }));
  // A marked fact is neither, even sitting in position 0 with a two-line caption.
  const fact = { kind: null, caption: 'x' };
  assert.ok(!isIntroSlide({ ...fact, kind: 'outro' }, 0));
  assert.ok(!isOutroSlide({ ...fact, kind: 'title' }));
});

test('an unmarked slide from an older project is still recognized', async () => {
  const { isIntroSlide, isOutroSlide, pickOutro } = await import('../../public/scripts/tik/project.js');
  // Sets built before the markers existed: the intro is first and two lines,
  // the outro carries the follow line, a fact is one statement.
  assert.ok(isIntroSlide({ caption: 'Jaws (1975)\nYou need a bigger boat.' }, 0));
  assert.ok(isOutroSlide({ caption: pickOutro('trivia', 0) }));
  assert.ok(!isIntroSlide({ caption: 'The shark was named Bruce.' }, 0));
  assert.ok(!isOutroSlide({ caption: 'The shark was named Bruce.' }));
});

test('the intro fallback does not fire off the top of a trivia set', async () => {
  const { isIntroSlide } = await import('../../public/scripts/tik/project.js');
  const intro = { caption: 'Jaws (1975)\nYou need a bigger boat.' };
  assert.ok(!isIntroSlide(intro, 1), 'only position 0 can be the intro');
  assert.ok(!isIntroSlide(intro, 0, 'guys'), 'guys sets mark their own title slide');
  assert.ok(!isIntroSlide(null, 0));
});

test('pickOutro clamps a junk r instead of returning undefined', () => {
  return import('../../public/scripts/tik/project.js').then(({ pickOutro }) => {
    for (const r of [0, 0.999999, 1, 1.5, -3, NaN]) {
      assert.equal(typeof pickOutro('trivia', r), 'string', `broke on ${r}`);
    }
  });
});
