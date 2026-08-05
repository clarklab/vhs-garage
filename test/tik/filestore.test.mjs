import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  movieKeyFor, isVideoFilename, scoreCandidate, pickBestFile,
} from '../../public/scripts/tik/filestore.js';

// The matcher's prime directive: on any uncertainty, MISS. A miss costs one
// manual pick (then remembered); a wrong match silently shoots another
// movie's frames into the draft. Several tests below assert a MISS on
// purpose — loosening the scorer should break them.

// ---- keys ----

test('movieKeyFor normalizes case, punctuation and spacing', () => {
  assert.equal(movieKeyFor('Home Alone', 1990), 'home alone 1990');
  assert.equal(movieKeyFor("Ferris Bueller's Day Off", 1986), 'ferris bueller s day off 1986');
  assert.equal(movieKeyFor('E.T.', null), 'e t');
  assert.equal(movieKeyFor('  The  Thing  ', '1982'), 'the thing 1982');
  assert.equal(movieKeyFor('', 1990), '');
});

// ---- filenames ----

test('isVideoFilename accepts the containers people actually rip to', () => {
  for (const n of ['a.mp4', 'b.mkv', 'c.MOV', 'd.avi', 'e.webm', 'f.m4v']) {
    assert.equal(isVideoFilename(n), true, n);
  }
  for (const n of ['notes.txt', 'poster.jpg', 'movie.srt', 'movie', '']) {
    assert.equal(isVideoFilename(n), false, String(n));
  }
});

// ---- scoring ----

test('a scene-release rip of the right movie clears the threshold', () => {
  const s = scoreCandidate('Home.Alone.1990.1080p.BluRay.x264-GROUP.mkv', 'Home Alone', 1990);
  assert.ok(s >= 60, `score ${s}`);
});

test('a clean "Title (Year).mkv" rip clears the threshold', () => {
  assert.ok(scoreCandidate('Home Alone (1990).mkv', 'Home Alone', 1990) >= 60);
  assert.ok(scoreCandidate('The Goonies 1985.mp4', 'The Goonies', 1985) >= 60);
});

test('the sequel guard: Home Alone 2 must never match a Home Alone draft', () => {
  assert.ok(scoreCandidate('Home.Alone.2.Lost.in.New.York.1992.mkv', 'Home Alone', 1990) < 60);
  // ...and the reverse: a Home Alone rip must not match a Home Alone 2 draft.
  assert.ok(scoreCandidate('Home.Alone.1990.mkv', 'Home Alone 2: Lost in New York', 1992) < 60);
});

test('the remake guard: same title, different year misses', () => {
  assert.ok(scoreCandidate('The.Thing.2011.720p.mkv', 'The Thing', 1982) < 60);
  assert.ok(scoreCandidate('The.Thing.1982.REMASTERED.mkv', 'The Thing', 1982) >= 60);
});

test('a shortened rip name still matches when the digits agree', () => {
  // "E.T. (1982).mkv" parses to just "e t" — a subset of the full title.
  assert.ok(scoreCandidate('E.T.1982.BluRay.mkv', 'E.T. the Extra-Terrestrial', 1982) >= 60);
});

test('punctuation differences in the same title do not matter', () => {
  assert.ok(scoreCandidate('Terminator.2.Judgment.Day.1991.mkv', 'Terminator 2: Judgment Day', 1991) >= 60);
});

test('an unrelated movie scores nowhere near the threshold', () => {
  assert.ok(scoreCandidate('The.Goonies.1985.mkv', 'Home Alone', 1990) < 30);
});

test('non-video files score zero no matter the name', () => {
  assert.equal(scoreCandidate('Home Alone (1990).srt', 'Home Alone', 1990), 0);
  assert.equal(scoreCandidate('Home Alone (1990).jpg', 'Home Alone', 1990), 0);
});

test('a fileless year on either side neither helps nor hurts', () => {
  const withBoth = scoreCandidate('Home.Alone.1990.mkv', 'Home Alone', 1990);
  const noFileYear = scoreCandidate('Home Alone.mkv', 'Home Alone', 1990);
  const noDraftYear = scoreCandidate('Home.Alone.1990.mkv', 'Home Alone', null);
  assert.ok(withBoth > noFileYear, 'year agreement is a bonus');
  assert.ok(noFileYear >= 60 && noDraftYear >= 60, 'but not a requirement');
});

// ---- picking from a listing ----

const FOLDER = [
  'Home.Alone.1990.1080p.BluRay.x264.mkv',
  'Home.Alone.2.Lost.in.New.York.1992.mkv',
  'The.Goonies.1985.mkv',
  'The.Thing.2011.720p.mkv',
  'The.Thing.1982.mkv',
  'Gremlins.1984.mp4',
  'notes.txt',
  'poster.jpg',
];

test('pickBestFile finds the right rip in a realistic folder', () => {
  assert.equal(pickBestFile(FOLDER, 'Home Alone', 1990), 'Home.Alone.1990.1080p.BluRay.x264.mkv');
  assert.equal(pickBestFile(FOLDER, 'Home Alone 2: Lost in New York', 1992), 'Home.Alone.2.Lost.in.New.York.1992.mkv');
  assert.equal(pickBestFile(FOLDER, 'The Thing', 1982), 'The.Thing.1982.mkv');
  assert.equal(pickBestFile(FOLDER, 'The Thing', 2011), 'The.Thing.2011.720p.mkv');
});

test('pickBestFile returns null rather than guessing', () => {
  assert.equal(pickBestFile(FOLDER, 'Jaws', 1975), null);
  assert.equal(pickBestFile([], 'Home Alone', 1990), null);
  assert.equal(pickBestFile(null, 'Home Alone', 1990), null);
});

test('with two acceptable cuts, the year decides', () => {
  const cuts = ['Blade.Runner.1982.Final.Cut.mkv', 'Blade.Runner.2049.2017.mkv'];
  assert.equal(pickBestFile(cuts, 'Blade Runner', 1982), 'Blade.Runner.1982.Final.Cut.mkv');
  assert.equal(pickBestFile(cuts, 'Blade Runner 2049', 2017), 'Blade.Runner.2049.2017.mkv');
});

// Titles that CONTAIN a year-like number are the ones parseMovieName mangles
// (it reads the first number as the release year and cuts the title there).
// The two-reading variant logic exists for exactly these.
test('a year inside the title does not break the match', () => {
  assert.ok(scoreCandidate('Blade.Runner.2049.2017.1080p.mkv', 'Blade Runner 2049', 2017) >= 60);
  assert.ok(scoreCandidate('2001.A.Space.Odyssey.1968.mkv', '2001: A Space Odyssey', 1968) >= 60);
  assert.ok(scoreCandidate('1917.2019.1080p.BluRay.mkv', '1917', 2019) >= 60);
  assert.ok(scoreCandidate('Blade Runner 2049.mkv', 'Blade Runner 2049', 2017) >= 60, 'no release year in the name at all');
});

test('the year-in-title reading cannot cross-match the two Blade Runners', () => {
  assert.ok(scoreCandidate('Blade.Runner.2049.2017.mkv', 'Blade Runner', 1982) < 60);
  assert.ok(scoreCandidate('Blade.Runner.1982.Final.Cut.mkv', 'Blade Runner 2049', 2017) < 60);
});

// Scene names with no year in them: hyphens wall off the quality junk and the
// release group pollutes the tokens ("Names.Like.This-1080p.NiGHT.mkv").
// These all MISSED before the hyphen reading + the extras-tolerant subset rule.
test('no-year scene names with release-group tags still match', () => {
  assert.ok(scoreCandidate('Names.Like.This-1080p.NiGHT.mkv', 'Names Like This', null) >= 60);
  assert.ok(scoreCandidate('The.Goonies-1080p.CiNEFiLE.mkv', 'The Goonies', 1985) >= 60);
  assert.ok(scoreCandidate('Gremlins.REMASTERED.x265.10bit-TIGOLE.mkv', 'Gremlins', 1984) >= 60);
});

test('the extras-tolerant rule still refuses sequels and numbered follow-ups', () => {
  // Extra tokens are fine unless one marks a different film in the franchise.
  assert.ok(scoreCandidate('Rocky.II-GROUP.mkv', 'Rocky', 1976) < 60, 'roman numeral vetoes');
  assert.ok(scoreCandidate('Home.Alone.2-GROUP.mkv', 'Home Alone', 1990) < 60, 'digit vetoes');
  assert.ok(scoreCandidate('Halloween.Part.2.mkv', 'Halloween', 1978) < 60, '"part" vetoes');
});

test('marker words shared by BOTH titles do not veto', () => {
  // v/x/part only veto as EXTRA tokens — "Malcolm X" has x on both sides.
  assert.ok(scoreCandidate('Malcolm.X-1080p.GROUP.mkv', 'Malcolm X', 1992) >= 60);
});

// Near-misses exist to EXPLAIN a rejection, so their floor sits well under the
// match threshold. A rejected sequel scoring ~20 is the single most useful
// thing to show, and a `> 20` filter hid exactly that (found in testing).
test('nearMisses floor is low enough to surface a rejected sequel', async () => {
  const { scoreCandidate: sc } = await import('../../public/scripts/tik/filestore.js');
  const s = sc('Gremlins.2.The.New.Batch-1080p.GRP.mkv', 'Gremlins', 1984);
  assert.ok(s < 60, 'still correctly refused as a match');
  assert.ok(s >= 15, `but above the explain-it floor (got ${s})`);
});
