import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOPILOT_COUNT, buildAutopilotPrompt, buildTitleSlidePrompt, normalizeSuggestions, normalizeMeta, META_HOOK_MAX,
  clampText, CAPTION_TARGET, CAPTION_MAX, META_HOOK_TARGET,
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

test('title slide asks for a reply, but not a generic or challenge one', () => {
  const p = buildAutopilotPrompt({ title: 'Jaws', year: '1975', durationSeconds: 7440, includeTitleSlide: true });
  assert.match(p, /THE ASK/);
  assert.match(p, /invitation to reply/i);
  assert.match(p, /do not give away or reference any of the trivia facts/i);
  // The generic ask is what made this beat feel like filler: name the thing
  // being asked about, or don't ask.
  assert.match(p, /the line they quote most/i);
  assert.match(p, /Never a bare "what's your favorite scene"/i);
  assert.match(p, /never the words "let's connect"/i);
  // Still not a "how many did you know" quiz/challenge, and doesn't tease a specific fact.
  assert.doesNotMatch(p, /TEASES the final fact/);
  assert.doesNotMatch(p, /how many of these/i);
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

test('normalizeSuggestions passes the grab hint through, trimmed and bounded', () => {
  const out = normalizeSuggestions({ suggestions: [
    { caption: 'A', timecode: 1, grab: '  the burning building shot  ' },
    { caption: 'B', timecode: 2, grab: 'y'.repeat(300) },
    { caption: 'C', timecode: 3, grab: 42 }, // non-string → empty
  ] }, 100);
  assert.equal(out[0].grab, 'the burning building shot');
  assert.ok(out[1].grab.length <= 200 && out[1].grab.length > 0);
  assert.equal(out[2].grab, '');
});

test('normalizeSuggestions coerces a non-numeric timecode to 0', () => {
  const out = normalizeSuggestions({ suggestions: [{ caption: 'A caption.', timecode: 'nope' }] }, 100);
  assert.equal(out[0].timecode, 0);
});

test('a caption over target is kept whole, not chopped at the target', () => {
  // The reported bug: the editor's own textarea takes CAPTION_MAX characters and
  // renders them fine, so slicing the model at CAPTION_TARGET severed a word for
  // no reason. Anything up to CAPTION_MAX now passes through untouched.
  const words = 'The mechanical shark sank on its first day of shooting in the Atlantic. ';
  const long = words.repeat(4).trim(); // comfortably over CAPTION_TARGET
  assert.ok(long.length > CAPTION_TARGET && long.length <= CAPTION_MAX, `fixture is ${long.length}`);
  const out = normalizeSuggestions({ suggestions: [{ caption: long, timecode: 1 }] }, 100);
  assert.equal(out[0].caption, long);
});

test('a runaway caption is cut at the ceiling, on a word boundary', () => {
  const runaway = 'word '.repeat(200).trim();
  const out = normalizeSuggestions({ suggestions: [{ caption: runaway, timecode: 1 }] }, 100);
  assert.ok(out[0].caption.length <= CAPTION_MAX);
  assert.ok(runaway.startsWith(out[0].caption));
  assert.doesNotMatch(out[0].caption, /\s$/);
  // The tell-tale of the old behaviour: a severed word at the end.
  assert.ok(out[0].caption.endsWith('word'), `ended mid-word: ...${out[0].caption.slice(-12)}`);
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
  // The prompt states the TARGET, never the accept ceiling.
  assert.match(p, new RegExp(String(META_HOOK_TARGET)));
  assert.ok(META_HOOK_MAX > META_HOOK_TARGET, 'ceiling must leave slack above target');
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

// ---- clampText: bound the model without chopping mid-word ----

test('clampText leaves anything within the cap completely alone', () => {
  assert.equal(clampText('A short caption.', 180), 'A short caption.');
  assert.equal(clampText('x'.repeat(180), 180), 'x'.repeat(180));
});

test('clampText cuts at a word boundary, never mid-word', () => {
  const s = 'The mechanical shark sank on its very first day of shooting';
  const out = clampText(s, 30);
  assert.ok(out.length <= 30);
  assert.ok(s.startsWith(out), 'clamped text must be a prefix of the original');
  // The give-away for the old behaviour was a severed word at the end.
  assert.ok(!/\S$/.test(s.slice(out.length, out.length + 1)) || s[out.length] === ' ',
    `cut mid-word: "${out}"`);
  assert.doesNotMatch(out, /\s$/);
});

test('clampText never leaves a dangling comma or dash at the cut', () => {
  assert.doesNotMatch(clampText('One thing, another thing, a third thing', 15), /[,;:-]$/);
  assert.doesNotMatch(clampText('Alpha beta - gamma delta', 13), /[-\s]$/);
});

test('clampText handles multi-line text (the title slide is two lines)', () => {
  const s = 'Jaws (1975)\nSome fun facts are coming up in a moment';
  const out = clampText(s, 25);
  assert.ok(out.length <= 25);
  assert.ok(s.startsWith(out));
});

test('clampText falls back to a hard cut only for one unbroken word', () => {
  // Nothing else is possible here, but it must still respect the cap.
  const out = clampText('a'.repeat(50), 10);
  assert.equal(out.length, 10);
});

test('clampText trims and tolerates junk', () => {
  assert.equal(clampText('  padded  ', 100), 'padded');
  assert.equal(clampText(null, 100), '');
  assert.equal(clampText(undefined, 100), '');
  assert.equal(clampText('text', 0), 'text');   // no cap → unchanged
});

test('the prompt states the target and never the accept ceiling', () => {
  // A ceiling in the prompt would invite the model to write to it.
  const p = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440 });
  assert.match(p, new RegExp(`about ${CAPTION_TARGET} characters`));
  assert.doesNotMatch(p, new RegExp(`${CAPTION_MAX} characters`));
});

test('the title slide opens on something concrete from the film', () => {
  const p = buildAutopilotPrompt({ title: 'Jaws', year: '1975', durationSeconds: 7440, includeTitleSlide: true });
  assert.match(p, /ONE CONCRETE THING FROM THE FILM/);
  assert.match(p, /THE ASK/);
  assert.match(p, /famous line of dialogue in quotation marks/i);
  assert.match(p, /State it flat, with no wind-up/i);
  // Two sentences, not three beats: the middle "knowing aside" was where the
  // verbosity and the try-hard voice lived.
  assert.match(p, /TWO short sentences and nothing else/);
  assert.match(p, /under about 140 characters/i);
  // Still not a plot summary, and still not a review.
  assert.match(p, /Plot summary, or explaining the film to somebody who has not seen it/i);
  assert.match(p, /Praising the film/i);
});

test('the title slide bans the "everyone remembers X but nobody remembers Y" hinge', () => {
  // This construction showed up on nearly every set and says nothing. It is
  // banned by name, along with the variants the model reaches for next.
  const p = buildAutopilotPrompt({ title: 'Jaws', year: '1975', durationSeconds: 7440, includeTitleSlide: true });
  assert.match(p, /everyone remembers X but nobody remembers Y/i);
  for (const variant of ['we all remember', 'you forgot about', 'nobody talks about']) {
    assert.ok(p.includes(variant), `banned-list is missing "${variant}"`);
  }
  assert.match(p, /you probably never noticed/i);
});

test('the intro prompt and the first-draft intro are written to the same rules', () => {
  // Two copies of these rules would drift, and a rewrite that follows
  // different rules than the draft is exactly what the user notices.
  const draft = buildAutopilotPrompt({ title: 'Jaws', year: '1975', durationSeconds: 7440, includeTitleSlide: true });
  const rewrite = buildTitleSlidePrompt({ title: 'Jaws', year: '1975', durationSeconds: 7440 });
  const rules = rewrite.slice(rewrite.indexOf('Its caption is'), rewrite.indexOf('Its "timecode"'));
  assert.ok(rules.length > 500, 'did not find the shared rules block');
  assert.ok(draft.includes(rules.trim()), 'the two prompts carry different intro rules');
});

test('buildTitleSlidePrompt asks for the intro alone, not another fact', () => {
  const p = buildTitleSlidePrompt({ title: 'Jaws', year: '1975', durationSeconds: 7440 });
  assert.match(p, /OPENING slide/);
  assert.match(p, /<film>Jaws \(1975\)<\/film>/);
  assert.match(p, /TITLE CARD/);
  // No trivia instructions leak in: this call must not produce a fact.
  assert.doesNotMatch(p, /trivia item/i);
  assert.doesNotMatch(p, /behind-the-scenes production facts/i);
  assert.match(p, /Return ONLY valid JSON/);
});

test('buildTitleSlidePrompt feeds back the wording already on the post', () => {
  const p = buildTitleSlidePrompt({
    title: 'Jaws', durationSeconds: 7440,
    exclude: ['Jaws (1975)\nYou need a bigger boat.', '', 'The shark was named Bruce'],
  });
  assert.match(p, /Already used on this post/i);
  assert.match(p, /You need a bigger boat/);
  assert.match(p, /The shark was named Bruce/);   // also blocks spoiling a slide
  assert.doesNotMatch(p, /- \n/);                 // the empty entry is dropped
});

test('buildTitleSlidePrompt without exclusions has no dangling block', () => {
  const p = buildTitleSlidePrompt({ title: 'Jaws', durationSeconds: 7440 });
  assert.doesNotMatch(p, /Already used on this post/i);
});
