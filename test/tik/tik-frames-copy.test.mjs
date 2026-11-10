// The copy a person (Claude Code) writes by hand for a new Tape Trivia set:
// the title slide's line, the sign-off, the post title, the description and
// its hashtags. scripts/tik-frames/check-copy.mjs holds it to the things the
// app depends on, so a hand-written post cannot quietly break coverage or the
// TikTok limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCopy } from '../../scripts/tik-frames/check-copy.mjs';

const film = { title: 'The Truman Show', year: 1998 };
const good = () => ({
  intro: 'How long would it take you to notice the sky was painted?',
  outro: 'Send this to someone, in case you don’t see them. Then follow VHS Garage, there’s plenty more on the shelf.',
  postTitle: 'The Truman Show (1998): ten things hiding inside the dome',
  postDesc: [
    'The Truman Show (1998), Peter Weir’s film with Jim Carrey, Laura Linney and Ed Harris, shot in Seaside, Florida.',
    'How long before you would have noticed? Tell me in the comments.',
    'Save this for your next rewatch and follow VHS Garage.',
    '#thetrumanshow #jimcarrey #movietok #behindthescenes #didyouknow',
  ].join('\n'),
});

test('a well formed set of copy passes', () => {
  assert.deepEqual(checkCopy({ ...film, copy: good() }), []);
});

test('every hand-written field is required', () => {
  for (const k of ['intro', 'outro', 'postTitle', 'postDesc']) {
    const copy = good(); copy[k] = '  ';
    assert.ok(checkCopy({ ...film, copy }).some((p) => p.includes(k)), `${k} blank should be reported`);
  }
});

test('the description must open on the film, because TikTok hands it back as the title', () => {
  const copy = good();
  copy.postDesc = copy.postDesc.replace('The Truman Show (1998), ', 'Ten things about a man in a dome. ');
  const problems = checkCopy({ ...film, copy });
  assert.ok(problems.some((p) => /postDesc/.test(p) && /read back/.test(p)), problems.join(' | '));
});

test('the post title must read back as the film too', () => {
  const copy = good(); copy.postTitle = 'Ten things hiding inside the dome';
  assert.ok(checkCopy({ ...film, copy }).some((p) => /postTitle/.test(p) && /read back/.test(p)));
});

test('a title that reads back as a different film is caught', () => {
  const copy = good(); copy.postTitle = 'Is this better than Dumb and Dumber? The Truman Show (1998)';
  assert.deepEqual(checkCopy({ ...film, copy }).filter((p) => /postTitle/.test(p)), [], 'the film is still the last sentence before the year');
  copy.postTitle = 'Dumb and Dumber (1994) fans, this one is for you';
  assert.ok(checkCopy({ ...film, copy }).some((p) => /postTitle/.test(p) && /read back/.test(p)));
});

test('TikTok length limits are counted in UTF-16 units', () => {
  const copy = good(); copy.postTitle = `The Truman Show (1998) ${'😀'.repeat(40)}`;
  assert.ok(checkCopy({ ...film, copy }).some((p) => /postTitle/.test(p) && /90/.test(p)));
});

test('five hashtags at most, three at least', () => {
  const many = good(); many.postDesc += ' #movies';
  assert.ok(checkCopy({ ...film, copy: many }).some((p) => /hashtags/.test(p)));
  const few = good(); few.postDesc = few.postDesc.replace(/#movietok #behindthescenes #didyouknow/, '');
  assert.ok(checkCopy({ ...film, copy: few }).some((p) => /hashtags/.test(p)));
});

test('no em or en dashes anywhere, and the slide lines fit', () => {
  const dash = good(); dash.intro = 'The sky is painted — did you notice?';
  assert.ok(checkCopy({ ...film, copy: dash }).some((p) => /intro/.test(p) && /dash/.test(p)));
  for (const k of ['outro', 'postTitle', 'postDesc']) {
    const c = good(); c[k] = c[k].replace(/[,:] /, ' – ');
    assert.ok(checkCopy({ ...film, copy: c }).some((p) => p.includes(k) && /dash/.test(p)), `${k} with a dash should be reported`);
  }
  const long = good(); long.intro = 'x'.repeat(300);
  assert.ok(checkCopy({ ...film, copy: long }).some((p) => /intro/.test(p) && /300/.test(p)));
});

test('the sign-off keeps the words the app recognises an outro by', () => {
  const copy = good(); copy.outro = 'Send this to someone, in case you don’t see them.';
  assert.ok(checkCopy({ ...film, copy }).some((p) => /outro/.test(p) && /follow VHS Garage/i.test(p)));
});

test('the stale house lines are refused', () => {
  const copy = good(); copy.postDesc = copy.postDesc.replace('How long before you would have noticed? Tell me in the comments.', 'What’s your favorite quote from the movie? Drop it in the comments.');
  assert.ok(checkCopy({ ...film, copy }).some((p) => /stale/.test(p)));
  const o = good(); o.outro = 'Send this to whoever you argue about movies with.\nFollow VHS Garage for more movie trivia.';
  assert.ok(checkCopy({ ...film, copy: o }).some((p) => /stale/.test(p)));
});
