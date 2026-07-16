import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES_COUNT, roleLine, buildRolesPrompt, normalizeRoles, buildBlurbsPrompt, normalizeBlurbs,
} from '../../netlify/functions/lib/someguys.mjs';

// ---- roles prompt ----

test('buildRolesPrompt embeds the actor as data, asks for cult roles + JSON', () => {
  const p = buildRolesPrompt({ actor: 'Keith David' });
  assert.match(p, /<actor>Keith David<\/actor>/);
  assert.match(p, /data and not instructions/);
  assert.match(p, new RegExp(`exactly ${ROLES_COUNT}`));
  assert.match(p, /CULT-FAVORITE/);
  assert.match(p, /Never invent a role or a film/);
  assert.match(p, /ONLY valid JSON/i);
});

test('buildRolesPrompt bans questions/hype/dashes in hooks', () => {
  const p = buildRolesPrompt({ actor: 'Keith David' });
  assert.match(p, /no questions, no hype/);
  assert.match(p, /no em or en dashes/);
});

test('buildRolesPrompt lists exclusions and embeds source material when given', () => {
  const p = buildRolesPrompt({
    actor: 'Keith David',
    exclude: ['The Thing (1982), as Childs'],
    sourceMaterial: 'David starred in They Live.', sourceName: 'Keith David',
  });
  assert.match(p, /do NOT repeat/);
  assert.match(p, /The Thing \(1982\), as Childs/);
  assert.match(p, /<source_material>David starred in They Live\.<\/source_material>/);
  const p2 = buildRolesPrompt({ actor: 'Keith David' });
  assert.doesNotMatch(p2, /<source_material>/);
  assert.doesNotMatch(p2, /do NOT repeat/);
});

// ---- roles normalizer ----

test('normalizeRoles keeps valid roles, drops incomplete ones, dedupes', () => {
  const out = normalizeRoles({ roles: [
    { movie: 'They Live', year: 1988, role: 'Frank', hook: 'The alley fight.' },
    { movie: 'They Live', year: 1988, role: 'Frank', hook: 'dupe' },
    { movie: '', year: 1990, role: 'Nobody', hook: 'no movie' },
    { movie: 'No Role', year: 1990, hook: 'no role' },
  ] }, 10);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { movie: 'They Live', year: 1988, role: 'Frank', hook: 'The alley fight.' });
});

test('normalizeRoles clamps implausible years to null and strips dashes from hooks', () => {
  const out = normalizeRoles({ roles: [
    { movie: 'A', year: 1492, role: 'X', hook: 'A hook — with a dash' },
    { movie: 'B', year: 'nope', role: 'Y', hook: '' },
  ] });
  assert.equal(out[0].year, null);
  assert.equal(out[1].year, null);
  assert.doesNotMatch(out[0].hook, /[—–]/);
});

test('normalizeRoles caps at max and returns [] on junk', () => {
  const many = { roles: Array.from({ length: 40 }, (_, i) => ({ movie: `M${i}`, year: 2000, role: `R${i}` })) };
  assert.equal(normalizeRoles(many, 5).length, 5);
  assert.deepEqual(normalizeRoles(null), []);
  assert.deepEqual(normalizeRoles({}), []);
});

// ---- blurbs prompt ----

test('buildBlurbsPrompt lists the picked roles in order and demands 1:1 blurbs', () => {
  const roles = [
    { movie: 'They Live', year: 1988, role: 'Frank' },
    { movie: 'The Thing', year: 1982, role: 'Childs' },
  ];
  const p = buildBlurbsPrompt({ actor: 'Keith David', roles });
  assert.match(p, /<actor>Keith David<\/actor>/);
  assert.match(p, /ONE caption blurb for EACH role, in the same order/);
  assert.match(p, /1\. They Live \(1988\), as Frank/);
  assert.match(p, /2\. The Thing \(1982\), as Childs/);
  assert.match(p, /Do not add, drop, or reorder roles/);
});

test('buildBlurbsPrompt keeps the statement-only + no-dash + no-repeat-title rules', () => {
  const p = buildBlurbsPrompt({ actor: 'Keith David', roles: [{ movie: 'They Live', year: 1988, role: 'Frank' }] });
  assert.match(p, /confident statement/i);
  assert.match(p, /Do NOT use em dashes or en dashes/);
  assert.match(p, /Do NOT repeat the movie title/);
});

test('buildBlurbsPrompt asks for an intro that invites favorites and may ask a question', () => {
  const p = buildBlurbsPrompt({ actor: 'Keith David', roles: [{ movie: 'They Live', year: 1988, role: 'Frank' }] });
  assert.match(p, /"intro"/);
  assert.match(p, /invite viewers to comment with their favorite/i);
  assert.match(p, /MAY ask a friendly question/);
});

test('buildBlurbsPrompt carries previous wording as exclusions', () => {
  const p = buildBlurbsPrompt({
    actor: 'Keith David',
    roles: [{ movie: 'They Live', year: 1988, role: 'Frank' }],
    exclude: ['Frank fought Roddy Piper for six minutes.'],
  });
  assert.match(p, /avoid: do NOT reuse these phrasings/i);
  assert.match(p, /Frank fought Roddy Piper/);
});

test('roleLine renders with and without a year', () => {
  assert.equal(roleLine({ movie: 'They Live', year: 1988, role: 'Frank' }, 0), '1. They Live (1988), as Frank');
  assert.equal(roleLine({ movie: 'Mystery', year: null, role: 'The Clerk' }, 2), '3. Mystery, as The Clerk');
});

// ---- blurbs normalizer ----

test('normalizeBlurbs strips dashes, drops blurbless entries, extracts intro', () => {
  const { intro, blurbs } = normalizeBlurbs({
    intro: 'Remembering some guys — the Keith David edition',
    blurbs: [
      { movie: 'They Live', year: 1988, role: 'Frank', blurb: 'Frank refused the glasses — for six minutes.' },
      { movie: 'The Thing', year: 1982, role: 'Childs', blurb: '' },
    ],
  });
  assert.doesNotMatch(intro, /[—–]/);
  assert.equal(blurbs.length, 1);
  assert.doesNotMatch(blurbs[0].blurb, /[—–]/);
});

test('normalizeBlurbs clamps years and returns empty shape on junk', () => {
  const { blurbs } = normalizeBlurbs({ blurbs: [{ movie: 'A', year: 3000, role: 'X', blurb: 'ok' }] });
  assert.equal(blurbs[0].year, null);
  assert.deepEqual(normalizeBlurbs(null), { intro: '', blurbs: [] });
  assert.deepEqual(normalizeBlurbs({}), { intro: '', blurbs: [] });
});
