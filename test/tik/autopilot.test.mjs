import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOPILOT_COUNT, buildAutopilotPrompt, normalizeSuggestions,
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
  assert.match(p, /SPECIFIC SCENE/);
  assert.match(p, /BEHIND-THE-SCENES/i);
});

test('buildAutopilotPrompt bakes in uniqueness rails and the editor grab hint', () => {
  const p = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440 });
  assert.match(p, /SKIP THE FAMOUS ONES/);
  assert.match(p, /VARY THE TYPE/);
  assert.match(p, /BE CONCRETE/);
  assert.match(p, /"grab"/);
  assert.match(p, /never shown to viewers/i);
});

test('buildAutopilotPrompt demands visual, Easter-egg, jaw-drop trivia with the payoff last', () => {
  const p = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440 });
  assert.match(p, /MAKE IT VISUAL/);
  assert.match(p, /HUNT EASTER EGGS/);
  assert.match(p, /did you ever notice/i);
  assert.match(p, /"NO WAY" TEST/);
  assert.match(p, /SAVE THE BEST FOR LAST/);
});

test('title slide hook teases the final fact', () => {
  const p = buildAutopilotPrompt({ title: 'Jaws', year: '1975', durationSeconds: 7440, includeTitleSlide: true });
  assert.match(p, /TEASES the final fact/);
});

test('buildAutopilotPrompt lists excluded trivia to avoid repeats', () => {
  const p = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440, exclude: ['the shark was named Bruce', ''] });
  assert.match(p, /do NOT repeat/i);
  assert.match(p, /the shark was named Bruce/);
});

test('buildAutopilotPrompt with count=1 is singular and can focus a timecode', () => {
  const p = buildAutopilotPrompt({ title: 'Jaws', durationSeconds: 7440, count: 1, focusTimecode: 3720 });
  assert.match(p, /exactly 1 trivia moment\b/);   // singular, no trailing "s"
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
