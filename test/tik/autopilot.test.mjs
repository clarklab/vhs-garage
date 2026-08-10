import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOPILOT_COUNT, buildAutopilotPrompt, normalizeSuggestions, normalizeMeta, META_HOOK_MAX,
} from '../../netlify/functions/lib/autopilot.mjs';

test('buildAutopilotPrompt embeds title, year, duration, count, and asks for JSON', () => {
  const p = buildAutopilotPrompt({ title: 'Jaws', year: '1975', durationSeconds: 7440 });
  assert.match(p, /Jaws/);
  assert.match(p, /1975/);
  assert.match(p, /7440/);
  assert.match(p, new RegExp(String(AUTOPILOT_COUNT)));
  assert.match(p, /ONLY valid JSON/i);
});

test('buildAutopilotPrompt asks for scene-specific + behind-the-scenes trivia', () => {
  const p = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440 });
  assert.match(p, /SPECIFIC scene/);
  assert.match(p, /behind-the-scenes/i);
});

test('buildAutopilotPrompt: discovery rules + grab hint (no-paste mode)', () => {
  const p = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440 });
  assert.match(p, /lesser-known facts/);
  assert.match(p, /Vary the type/i);
  assert.match(p, /Be concrete/i);
  assert.match(p, /"grab"/);
  assert.match(p, /never shown to viewers/i);
});

test('buildAutopilotPrompt bans questions, hype, and em dashes; wants statements', () => {
  const p = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440 });
  assert.match(p, /confident factual STATEMENT/);
  assert.match(p, /Do NOT use questions, challenges, or hype/);
  assert.match(p, /Do NOT use em dashes or en dashes/);
  // No leftover challenge/hype rails:
  assert.doesNotMatch(p, /HUNT EASTER EGGS/);
  assert.doesNotMatch(p, /did you ever notice/i);
  assert.doesNotMatch(p, /"NO WAY" TEST/i);
});

test('buildAutopilotPrompt embeds source material when provided, omits when absent', () => {
  const p = buildAutopilotPrompt({
    title: 'Jaws', durationSeconds: 7440,
    sourceMaterial: 'Principal photography began May 2, 1974.', sourceName: 'Jaws (film)',
  });
  assert.match(p, /SOURCE MATERIAL/);
  assert.match(p, /<source_material>Principal photography began May 2, 1974\.<\/source_material>/);
  assert.match(p, /Jaws \(film\)/);
  const p2 = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440 });
  assert.doesNotMatch(p2, /<source_material>/);
});

test('title slide invites engagement (favorite scene/fact/quote), no challenge framing', () => {
  const p = buildAutopilotPrompt({ title: 'Jaws', year: '1975', durationSeconds: 7440, includeTitleSlide: true });
  assert.match(p, /favorite scene, fact, or quote/i);
  assert.match(p, /invite the viewer to comment/i);
  assert.match(p, /not reference any specific fact/i);
  // Still not a "how many did you know" quiz/challenge, and doesn't tease a specific fact.
  assert.doesNotMatch(p, /TEASES the final fact/);
  assert.doesNotMatch(p, /how many of these/i);
  // The title slide is exempt from the trivia "no questions" rule.
  assert.match(p, /title slide MAY ask a friendly question/i);
});

test('buildAutopilotPrompt lists excluded trivia to avoid repeats', () => {
  const p = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440, exclude: ['the shark was named Bruce', ''] });
  assert.match(p, /do NOT repeat/i);
  assert.match(p, /the shark was named Bruce/);
});

test('buildAutopilotPrompt with count=1 is singular and can focus a timecode', () => {
  const p = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440, count: 1, focusTimecode: 3720 });
  assert.match(p, /exactly 1 trivia item\b/);   // singular, no trailing "s"
  assert.match(p, /Focus this one on the SCENE around 3720 seconds/);
});

test('buildAutopilotPrompt can demand a leading TITLE slide at the title card', () => {
  const p = buildAutopilotPrompt({ title: 'Jaws', year: '1975', durationSeconds: 7440, includeTitleSlide: true });
  assert.match(p, /FIRST item .* TITLE slide/i);
  assert.match(p, /TITLE CARD/);
  assert.match(p, /Jaws \(1975\)/);
  // Off by default:
  const p2 = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440 });
  assert.doesNotMatch(p2, /TITLE slide/);
});

test('buildAutopilotPrompt passes user guidance, delimited as data', () => {
  const p = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440, guidance: 'focus on the shark rig' });
  assert.match(p, /<guidance>focus on the shark rig<\/guidance>/);
  // Empty/whitespace guidance adds nothing:
  const p2 = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440, guidance: '   ' });
  assert.doesNotMatch(p2, /<guidance>/);
});

test('a multi-item paste is promoted to user-chosen facts to rewrite (not curate)', () => {
  const paste = 'The mechanical shark sank on its first day.\n\nThe barrels were real.\n\nSpielberg cameos as a clarinet player.';
  const p = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440, guidance: paste });
  assert.match(p, /USER-CHOSEN FACTS/);
  assert.match(p, /Turn EACH into one slide caption/);
  assert.match(p, /<user_facts>/);
  assert.match(p, /1\. The mechanical shark sank/); // numbered, in order
  assert.doesNotMatch(p, /<guidance>/);
  // Enumerated paste: keep the user's order, don't tell it to reshuffle for a strong finish.
  assert.match(p, /Keep the user's fact order/);
  assert.doesNotMatch(p, /lands last/);
});

test('no-paste mode still orders for a strong finish', () => {
  const p = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440 });
  assert.match(p, /a strong one lands last/);
  assert.doesNotMatch(p, /Keep the user's fact order/);
});

test('a single long blob is source notes (draw the best N), not one-per-fact', () => {
  const paste = 'x'.repeat(900); // no blank-line separators → 1 item
  const p = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440, guidance: paste, count: 5 });
  assert.match(p, /USER-SUPPLIED SOURCE MATERIAL/);
  assert.match(p, /draw the strongest 5 facts/);
  assert.doesNotMatch(p, /USER-CHOSEN FACTS/);
});

test('enumerated facts are numbered and capped to count (strongest-last survives)', () => {
  const paste = Array.from({ length: 15 }, (_, i) => `Fact number ${i + 1} about the film.`).join('\n\n');
  const p = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440, guidance: paste, count: 12 });
  assert.match(p, /12\. Fact number 12/);   // 12th fact included + numbered
  assert.doesNotMatch(p, /13\. Fact number 13/); // sliced to count=12
});

test('a short single-line direction stays steering, not source', () => {
  const p = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440, guidance: 'lean into the score' });
  assert.match(p, /<guidance>lean into the score<\/guidance>/);
  assert.doesNotMatch(p, /USER-CHOSEN FACTS/);
});

test('Wikipedia material defers to a user source paste (cross-check role)', () => {
  const paste = 'x'.repeat(900);
  const p = buildAutopilotPrompt({
    title: 'Jaws', durationSeconds: 7440, guidance: paste,
    sourceMaterial: 'Principal photography…', sourceName: 'Jaws (film)',
  });
  assert.match(p, /ADDITIONAL reference material/);
  assert.doesNotMatch(p, /STRONGLY PREFER facts grounded/);
});

test('normalizeSuggestions keeps valid entries and clamps timecodes to [0, duration]', () => {
  const raw = { suggestions: [
    { caption: 'A', timecode: -5 },
    { caption: 'B', timecode: 999999 },
    { caption: 'C', timecode: 100 },
  ] };
  assert.deepEqual(normalizeSuggestions(raw, 200), [
    { caption: 'A', timecode: 0, grab: '' },
    { caption: 'B', timecode: 200, grab: '' },
    { caption: 'C', timecode: 100, grab: '' },
  ]);
});

test('normalizeSuggestions drops captionless entries and caps at max', () => {
  const raw = { suggestions: [
    { caption: '', timecode: 1 },
    { timecode: 2 },
    { caption: 'ok', timecode: 3 },
  ] };
  assert.deepEqual(normalizeSuggestions(raw, 100, 5), [{ caption: 'ok', timecode: 3, grab: '' }]);
});

test('normalizeSuggestions strips em/en dashes from captions', () => {
  const out = normalizeSuggestions({ suggestions: [
    { caption: 'The shark broke down — constantly', timecode: 1 },
    { caption: 'A cameo–blink and miss it', timecode: 2 },
  ] }, 100);
  assert.doesNotMatch(out[0].caption, /[—–]/);
  assert.doesNotMatch(out[1].caption, /[—–]/);
  assert.equal(out[0].caption, 'The shark broke down, constantly');
});

test('stripDashes cleans up the artifacts a dash→comma swap can create', () => {
  const out = normalizeSuggestions({ suggestions: [
    { caption: 'The shark broke down —', timecode: 1 },  // trailing dash
    { caption: '— the start', timecode: 2 },             // leading dash
    { caption: 'wow, — amazing', timecode: 3 },          // comma already before dash
    { caption: 'he said —. done', timecode: 4 },         // dash before a period
  ] }, 100);
  assert.equal(out[0].caption, 'The shark broke down');  // no dangling ", "
  assert.equal(out[1].caption, 'the start');             // no leading ", "
  assert.equal(out[2].caption, 'wow, amazing');          // no doubled comma
  assert.equal(out[3].caption, 'he said. done');         // no ", ." run
});

test('normalizeSuggestions passes the grab hint through, trimmed and capped at 120', () => {
  const out = normalizeSuggestions({ suggestions: [
    { caption: 'A', timecode: 1, grab: '  the burning building shot  ' },
    { caption: 'B', timecode: 2, grab: 'y'.repeat(300) },
    { caption: 'C', timecode: 3, grab: 42 }, // non-string → empty
  ] }, 100);
  assert.equal(out[0].grab, 'the burning building shot');
  assert.equal(out[1].grab.length, 120);
  assert.equal(out[2].grab, '');
});

test('normalizeSuggestions coerces a non-numeric timecode to 0 and truncates long captions', () => {
  const out = normalizeSuggestions({ suggestions: [{ caption: 'x'.repeat(300), timecode: 'nope' }] }, 100);
  assert.equal(out[0].timecode, 0);
  assert.equal(out[0].caption.length, 180);
});

test('normalizeSuggestions on junk input returns an empty array', () => {
  assert.deepEqual(normalizeSuggestions(null, 100), []);
  assert.deepEqual(normalizeSuggestions({}, 100), []);
});

// ---- post meta (hook, film hashtags, songs) ----

test('includeMeta off leaves the prompt byte-identical to the one we ship today', () => {
  // The single-slide "write one more" path must not be touched by this feature.
  const args = { title: 'Jaws', year: '1975', durationSeconds: 7440, focusTimecode: 900 };
  assert.equal(buildAutopilotPrompt(args), buildAutopilotPrompt({ ...args, includeMeta: false }));
  assert.doesNotMatch(buildAutopilotPrompt(args), /"meta"/);
  assert.doesNotMatch(buildAutopilotPrompt(args), /filmTags/);
});

test('includeMeta asks for the hook, film tags, and soundtrack songs', () => {
  const p = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440, includeMeta: true });
  assert.match(p, /"meta"/);
  assert.match(p, /"hook"/);
  assert.match(p, /"filmTags"/);
  assert.match(p, /"songs"/);
  assert.match(p, new RegExp(String(META_HOOK_MAX)));
});

test('includeMeta forbids spoiling a slide and forbids the score', () => {
  const p = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440, includeMeta: true });
  assert.match(p, /MUST NOT state or hint at any fact you used in a slide caption/);
  assert.match(p, /never the orchestral score/i);
  assert.match(p, /Never invent a song/i);
  assert.match(p, /return an empty array/i);
});

test('normalizeMeta keeps a good answer', () => {
  const meta = normalizeMeta({
    meta: {
      hook: 'John Carpenter’s 1982 arctic paranoia classic with Kurt Russell.',
      filmTags: ['thething', 'johncarpenter', '80shorror'],
      songs: [{ title: 'Superstition', artist: 'Stevie Wonder', why: 'Opening scene' }],
    },
  });
  assert.equal(meta.filmTags.length, 3);
  assert.equal(meta.songs[0].artist, 'Stevie Wonder');
  assert.match(meta.hook, /^John Carpenter/);
});

test('normalizeMeta strips em dashes from the hook like it does captions', () => {
  const meta = normalizeMeta({ meta: { hook: 'The Thing — a 1982 classic.', filmTags: [] } });
  assert.doesNotMatch(meta.hook, /[—–]/);
});

test('normalizeMeta truncates an over-long hook', () => {
  const meta = normalizeMeta({ meta: { hook: 'x'.repeat(400), filmTags: ['a'] } });
  assert.equal(meta.hook.length, META_HOOK_MAX);
});

test('normalizeMeta caps the tag and song lists', () => {
  const meta = normalizeMeta({
    meta: {
      hook: 'A hook.',
      filmTags: ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'],
      songs: Array.from({ length: 8 }, (_, i) => ({ title: `Song ${i}`, artist: 'A' })),
    },
  });
  assert.ok(meta.filmTags.length <= 4);
  assert.equal(meta.songs.length, 3);
});

test('normalizeMeta drops songs with no title and non-string tags', () => {
  const meta = normalizeMeta({
    meta: {
      hook: 'A hook.',
      filmTags: ['good', 42, null, '  ', 'alsogood'],
      songs: [{ artist: 'Nobody' }, null, 'a string', { title: 'Real', artist: 'X' }],
    },
  });
  assert.deepEqual(meta.filmTags, ['good', 'alsogood']);
  assert.equal(meta.songs.length, 1);
  assert.equal(meta.songs[0].title, 'Real');
});

test('normalizeMeta returns null when there is nothing usable', () => {
  // Null is the caller's cue to fall back to the template copy.
  assert.equal(normalizeMeta(null), null);
  assert.equal(normalizeMeta({}), null);
  assert.equal(normalizeMeta({ meta: null }), null);
  assert.equal(normalizeMeta({ meta: 'a string' }), null);
  assert.equal(normalizeMeta({ meta: [] }), null);
  assert.equal(normalizeMeta({ meta: { hook: '', filmTags: [], songs: [] } }), null);
  assert.equal(normalizeMeta({ meta: { hook: 42, filmTags: 'nope', songs: 'nope' } }), null);
});

test('normalizeMeta survives a partial answer', () => {
  // Tags but no hook, or a hook but no tags, are both still worth having.
  assert.deepEqual(normalizeMeta({ meta: { filmTags: ['jaws'] } }), { hook: '', filmTags: ['jaws'], songs: [] });
  const hookOnly = normalizeMeta({ meta: { hook: 'Just a hook.' } });
  assert.equal(hookOnly.hook, 'Just a hook.');
  assert.deepEqual(hookOnly.filmTags, []);
});
