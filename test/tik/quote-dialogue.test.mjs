import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dialogueLines, formatDialogue, groundQuoteSuggestions } from '../../netlify/functions/lib/quote-dialogue.mjs';
import { buildQuotesPrompt, normalizeSuggestions } from '../../netlify/functions/lib/autopilot.mjs';
import { applyCueTimes } from '../../netlify/functions/lib/srt.mjs';
import { sceneWindow } from '../../public/scripts/tik/clip.js';
import { karaokeState } from '../../public/scripts/tik/caption.js';

const quotes = [{ text: 'Ripley: Get away from her, you bitch!\nNewt: Mommy!' }];
const ground = (suggestion, pool = quotes) => groundQuoteSuggestions({ suggestions: [suggestion] }, pool).suggestions[0];

test('source references override swapped or invented names and rewritten words', () => {
  const out = ground({ quoteIndex: 1, lineIndices: [1, 2], caption: 'Newt: Stay away! Ripley: Mommy!' });
  assert.equal(out.caption, quotes[0].text);
});

test('choosing only one speaker from an exchange removes their name', () => {
  assert.equal(ground({ quoteIndex: 1, lineIndices: [2], caption: 'Ripley: Mommy!' }).caption, 'Mommy!');
});

test('legacy responses recover the correct names by words, never position', () => {
  const out = ground({ caption: 'Newt: Get away from her, you bitch! Ripley: Mommy!' });
  assert.equal(out.caption, quotes[0].text);
});

test('a source reference cannot stitch nonconsecutive lines together', () => {
  const out = ground({ quoteIndex: 1, lineIndices: [1, 3], caption: 'Invented: Made up.' });
  assert.equal(out.caption, 'Made up.');
});

test('unknown names are omitted even without subtitles or a quote source', () => {
  assert.equal(ground({ caption: 'Wrong: One line.\nOther: Another line.' }, []).caption, 'One line.\nAnother line.');
});

test('same person on several lines gets no names, including cached blocks', () => {
  const text = 'Ripley: Stay here.\nRipley: I will be back.';
  assert.equal(formatDialogue(dialogueLines(text)), 'Stay here.\nI will be back.');
  const prompt = buildQuotesPrompt({ title: 'Aliens', quotes: [{ text }] });
  const pool = prompt.match(/<imdb_quotes>([\s\S]*?)<\/imdb_quotes>/)[1];
  assert.doesNotMatch(pool, /Ripley:/);
  assert.match(prompt, /at least two DIFFERENT people/);
});

test('literal newline escapes and stage notes cannot mangle the editor text', () => {
  assert.equal(formatDialogue(dialogueLines('Éowyn: [shouting] Stand back!\\nA: Why?')), 'Éowyn: Stand back!\nA: Why?');
});

test('title slides bypass source grounding', () => {
  const raw = { suggestions: [{ caption: 'Aliens', timecode: 90 }] };
  assert.deepEqual(groundQuoteSuggestions(raw, quotes, { skipFirst: true }), raw);
});

test('quotes keep punctuation and complete long lines through normalization', () => {
  const caption = ('Wait—what? Don’t move. ').repeat(40).trim();
  const [out] = normalizeSuggestions({ suggestions: [{ caption }] }, 100, 1, { verbatim: true });
  assert.equal(out.caption, caption);
});

test('source selection, subtitle matching, clip cuts, and karaoke retain one exchange', () => {
  const pool = [{ text: 'Ripley: Stay here and wait for me.\nNewt: Please come back soon!' }];
  const cues = [
    { start: 9, end: 9.8, text: 'Previous dialogue.' },
    { start: 10, end: 13, text: 'Stay here and' },
    { start: 13, end: 16, text: 'wait for me.' },
    { start: 19, end: 24, text: 'Please come back soon!' },
    { start: 24.3, end: 26, text: 'Next dialogue.' },
  ];
  const grounded = ground({ quoteIndex: 1, lineIndices: [1, 2], caption: 'Newt: Wrong.\nRipley: Wrong.' }, pool);
  const [row] = applyCueTimes(normalizeSuggestions({ suggestions: [grounded] }, 100, 1, { verbatim: true }), cues);
  assert.equal(row.caption, pool[0].text);
  assert.equal(row.matched, true);
  assert.deepEqual(row.cue.segments.map(({ from, to }) => [from, to]), [[0, 3], [3, 6], [6, 10]]);
  const slide = JSON.parse(JSON.stringify(row)); // same JSON roundtrip as a saved draft
  const cut = sceneWindow(slide, { duration: 100 });
  assert.ok(cut.start > 9.8 && cut.start <= 10);
  assert.ok(cut.end >= 24 && cut.end < 24.3);
  assert.equal(karaokeState(17, slide.cue, slide.caption).active, -1, 'the pause is silent');
  assert.equal(karaokeState(19, slide.cue, slide.caption).active, 6, 'Newt starts on her own cue');
});
