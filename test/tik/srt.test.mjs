import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSrt, srtTimeToSeconds, normalizeQuoteText, matchQuoteToCues, quoteHints, seekTime, applyCueTimes,
  captionFromCues, speakerLabel, MAX_SPAN_CUES, MAX_CUE_GAP,
} from '../../netlify/functions/lib/srt.mjs';

const SAMPLE = `1
00:01:12,000 --> 00:01:16,000
I'll be back.

2
00:01:16,500 --> 00:01:19,000
Come with me if you want to live.

3
00:02:00,000 --> 00:02:02,000
Sarah Connor?

4
00:02:02,200 --> 00:02:05,000
No, it's just me.
`;

test('srtTimeToSeconds parses the SRT clock', () => {
  assert.equal(srtTimeToSeconds('00:01:12,000'), 72);
  assert.equal(srtTimeToSeconds('01:00:00,500'), 3600.5);
  assert.equal(srtTimeToSeconds('nope'), null);
});

test('parseSrt returns cues in seconds', () => {
  const cues = parseSrt(SAMPLE);
  assert.equal(cues.length, 4);
  assert.equal(cues[0].start, 72);
  assert.equal(cues[0].end, 76);
  assert.equal(cues[0].text, "I'll be back.");
});

test('parseSrt returns [] for empty or junk', () => {
  assert.deepEqual(parseSrt(''), []);
  assert.deepEqual(parseSrt(null), []);
  assert.deepEqual(parseSrt('not an srt'), []);
});

test('normalizeQuoteText strips speakers, quotes, and punctuation', () => {
  assert.equal(normalizeQuoteText(`[Terminator]: I'll be back.`), 'ill be back');
  assert.equal(normalizeQuoteText(`The Terminator: "I'll be back."`), 'ill be back');
  assert.equal(normalizeQuoteText("I'll be back."), 'ill be back');
  assert.equal(normalizeQuoteText('  '), '');
});

test('matchQuoteToCues finds a line ignoring IMDb formatting', () => {
  const cues = parseSrt(SAMPLE);
  const hit = matchQuoteToCues("The Terminator: I'll be back.", cues);
  assert.ok(hit);
  assert.equal(hit.start, 72);
  assert.equal(hit.end, 76);
  assert.equal(seekTime(hit.start, hit.end), 73);
});

test('matchQuoteToCues spans two adjacent cues when the quote covers both', () => {
  const cues = parseSrt(SAMPLE);
  const hit = matchQuoteToCues('Sarah Connor? No, it\'s just me.', cues);
  assert.ok(hit);
  assert.equal(hit.start, 120);
  assert.equal(hit.end, 125);
});

test('matchQuoteToCues returns null when nothing is close', () => {
  const cues = parseSrt(SAMPLE);
  assert.equal(matchQuoteToCues('Get to the chopper', cues), null);
});

test('quoteHints maps matched quotes to cue spans', () => {
  const cues = parseSrt(SAMPLE);
  const out = quoteHints([{ text: "The Terminator: I'll be back." }], cues);
  assert.deepEqual(out, [{ quoteIndex: 0, start: 72, end: 76 }]);
});

// ---- where inside a cue span the frame is grabbed ----

test('seekTime is the first quarter of the cue span', () => {
  assert.equal(seekTime(12, 16), 13);
  assert.equal(seekTime(10, 10), 10);
  assert.equal(seekTime(0, 4), 1);
  assert.ok(Math.abs(seekTime(1.2, 5.2) - 2.2) < 1e-9);
});

test('seekTime spans several cues via first start and last end', () => {
  assert.equal(seekTime(8, 20), 11);
});

test('seekTime survives junk', () => {
  assert.equal(seekTime(null, 10), 0);
  assert.equal(seekTime(5, 'nope'), 5);
  assert.equal(seekTime(-2, 2), 0);
});

// ---- the arithmetic is the authority, not the model ----

const SPANS = [
  { start: 10, end: 14, text: 'They mostly come at night. Mostly.' },
  { start: 40, end: 44, text: 'Get away from her, you bitch!' },
  { start: 80, end: 84, text: 'Game over, man. Game over!' },
];

test('applyCueTimes overrides whatever the model said about a span', () => {
  // The model is handed a SAMPLE of a long cue list, so a confident answer off
  // the nearest visible line is its normal failure. The full file decides.
  const out = applyCueTimes([
    { caption: 'Game over, man. Game over!', timecode: 999, start: 900, end: 904 },
  ], SPANS);
  assert.equal(out[0].start, 80);
  assert.equal(out[0].end, 84);
  assert.equal(out[0].timecode, 81);   // first quarter of 80–84
  assert.equal(out[0].matched, true);
});

test('applyCueTimes matches a caption boiled down from the full quote', () => {
  // What lands on a slide is a trimmed version of the IMDb block, which is a
  // SUBSET of the words that were matched in the first place.
  const out = applyCueTimes([{ caption: 'Get away from her, you bitch!', timecode: 0 }], SPANS);
  assert.equal(out[0].timecode, 41);
});

test('applyCueTimes leaves the title slide on its title card', () => {
  // Slide 0 points at the main-title logo shot, which is not a spoken line.
  const rows = [
    { caption: 'Aliens (1986)', timecode: 120 },
    { caption: 'Game over, man. Game over!', timecode: 5 },
  ];
  const out = applyCueTimes(rows, SPANS, { skipFirst: true });
  assert.equal(out[0].timecode, 120, 'the title slide was dragged to a quote');
  assert.equal(out[1].timecode, 81);
});

test('applyCueTimes keeps the model guess when nothing matches', () => {
  const out = applyCueTimes([{ caption: 'A line that is not in this film at all', timecode: 640 }], SPANS);
  assert.equal(out[0].timecode, 640);
  assert.equal(out[0].matched, undefined);
  assert.equal(out[0].start, undefined);
});

test('applyCueTimes is a no-op with no subtitle file', () => {
  // Every film without an English SRT takes this path; it must not blank the
  // timecodes the model guessed.
  const rows = [{ caption: 'Game over, man.', timecode: 77 }];
  assert.deepEqual(applyCueTimes(rows, []), rows);
  assert.deepEqual(applyCueTimes(rows, null), rows);
  assert.deepEqual(applyCueTimes([], SPANS), []);
});

test('applyCueTimes clamps a match to the runtime it was given', () => {
  const out = applyCueTimes([{ caption: 'Game over, man. Game over!', timecode: 0 }], SPANS, { durationSeconds: 50 });
  assert.ok(out[0].timecode <= 50, `ran past the end of the film: ${out[0].timecode}`);
});

// ---- a quote is an exchange, and an exchange is spread over several cues ----

test('a quote spanning three or four cues is still found', () => {
  // Subtitles break a line every few words, so the words of one quote routinely
  // land across three or four cues. Scored against adjacent PAIRS only, this
  // either found nothing or latched onto whichever half-window scored best and
  // captioned a frame seconds off the line.
  const cues = [
    { start: 500, end: 503, text: 'What do you mean' },
    { start: 503, end: 506, text: "he doesn't have a name?" },
    { start: 506, end: 509, text: 'He is a cat.' },
    { start: 509, end: 512, text: 'Cats do not need names.' },
  ];
  const hit = matchQuoteToCues(
    "Clarice: What do you mean he doesn't have a name?\nHannibal: He is a cat. Cats do not need names.",
    cues,
  );
  assert.ok(hit, 'no match at all');
  assert.equal(hit.start, 500, 'started on the wrong cue');
  assert.equal(hit.end, 512);
});

test('the span has a ceiling, so one quote cannot swallow a scene', () => {
  const cues = Array.from({ length: 12 }, (_, i) => ({ start: i * 3, end: i * 3 + 3, text: `word${i} filler line` }));
  const hit = matchQuoteToCues('word0 filler word1 filler word2 filler', cues);
  assert.ok(hit);
  const spanned = cues.filter((c) => c.start >= hit.start && c.end <= hit.end).length;
  assert.ok(spanned <= MAX_SPAN_CUES, `spanned ${spanned} cues`);
});

test('a shorter span wins a tie, and an earlier one breaks that tie', () => {
  const cues = [
    { start: 10, end: 12, text: 'I will be back' },
    { start: 20, end: 22, text: 'unrelated chatter here' },
    { start: 90, end: 92, text: 'I will be back' },
  ];
  const hit = matchQuoteToCues('I will be back', cues);
  assert.equal(hit.start, 10, 'a line said twice belongs to the first time it is said');
  assert.equal(hit.end, 12, 'took more cues than it needed');
});

test('character names do not sink a match', () => {
  // Every speaker label is a word the subtitle file will never contain. Left in
  // the score they are pure ballast, and enough of them drop a real match under
  // the bar. The strip has to work whether the exchange arrives on separate
  // lines or collapsed onto one.
  const cues = [
    { start: 100, end: 102, text: 'Get away from her,' },
    { start: 102, end: 104, text: 'you bitch!' },
    { start: 104, end: 106, text: 'Mommy!' },
  ];
  for (const shape of [
    'Ripley: Get away from her, you bitch!\nNewt: Mommy!',
    'Ripley: Get away from her, you bitch! Newt: Mommy!',
  ]) {
    const hit = matchQuoteToCues(shape, cues);
    assert.ok(hit, `no match for: ${JSON.stringify(shape)}`);
    assert.equal(hit.start, 100);
  }
  assert.ok(!normalizeQuoteText('Ripley: Hello. Newt: Mommy!').includes('newt'));
  assert.ok(!normalizeQuoteText('Ripley: Hello.\nNewt: Mommy!').includes('ripley'));
});

test('stripping speaker labels does not eat the line itself', () => {
  const out = normalizeQuoteText('Ripley: Get away from her, you bitch!');
  assert.ok(out.includes('get away from her'), out);
  assert.ok(out.includes('bitch'), out);
});


// ---- The caption is what the film says, not what IMDb remembers ----

test('a partial subtitle cannot replace a whole quote', () => {
  // IMDb quotes are typed from memory and routinely drift; the subtitle file is
  // the only text here that was made from the audio.
  const written = 'You keep using that word. I do not think it means what you think it means.';
  const spoken = 'You keep using that word. I do not think it means what you think it means.';
  assert.equal(captionFromCues(spoken, written), spoken);
  const drifted = captionFromCues('I do not think that word means what you think it means.', written);
  assert.equal(drifted, null, 'a partial match must not delete the opening sentence');
});

test('a subtitle exchange splits back onto one line per speaker', () => {
  // A subtitle marks the second speaker with a leading dash inside one cue.
  const out = captionFromCues('- You fell victim to one of the classic blunders! - Inconceivable!', '');
  assert.equal(out, 'You fell victim to one of the classic blunders!\nInconceivable!');
});

test('the model’s speaker names go back on, in order', () => {
  // Subtitles carry no names; the written quote does, and the format needs them.
  const written = 'VIZZINI: You fell victim to one of the classic blunders!\nMAN IN BLACK: Inconceivable!';
  const out = captionFromCues('- You fell victim to one of the classic blunders! - Inconceivable!', written);
  assert.equal(out, 'VIZZINI: You fell victim to one of the classic blunders!\nMAN IN BLACK: Inconceivable!');
});

test('names are left off when they do not line up', () => {
  // Two names, one spoken line: guessing which one said it would be worse.
  const written = 'A: one\nB: two';
  assert.equal(captionFromCues('Just the one line here.', written), null);
});

test('sound cues and music marks are not dialogue', () => {
  assert.equal(captionFromCues('[DOOR CREAKS] Hello there.', ''), 'Hello there.');
  assert.equal(captionFromCues('♪ Hello there. ♪', ''), 'Hello there.');
  assert.equal(captionFromCues('[THUNDER]', ''), null, 'a cue with no words is not a caption');
  assert.equal(captionFromCues('   ', 'x'), null);
  assert.equal(captionFromCues(null, 'x'), null);
});

test('a runaway span keeps the written quote instead', () => {
  // The matcher can sweep up a neighbouring line; a caption three times the
  // length of the quote is that, not a better transcription.
  const written = 'Inconceivable!';
  const sprawl = 'Inconceivable! And another thing entirely, at considerable length, about the boat.';
  assert.equal(captionFromCues(sprawl, written), null);
});

test('applyCueTimes swaps the caption in along with the times', () => {
  const cues = [
    { start: 100, end: 102, text: 'You keep using that word.' },
    { start: 102, end: 105, text: 'I do not think it means what you think it means.' },
  ];
  const rows = [{ caption: 'You keep using that word, I dont think it means what you think it means' }];
  const [out] = applyCueTimes(rows, cues);
  assert.equal(out.matched, true);
  assert.equal(out.caption, 'You keep using that word. I do not think it means what you think it means.');
  assert.equal(out.start, 100);
  assert.equal(out.end, 105);
});

test('an unmatched line keeps every word it had', () => {
  const cues = [{ start: 10, end: 12, text: 'Something else entirely.' }];
  const rows = [{ caption: 'A line that appears nowhere in this film at all.' }];
  const [out] = applyCueTimes(rows, cues);
  assert.equal(out.caption, 'A line that appears nowhere in this film at all.');
  assert.equal(out.matched, undefined);
});

test('the title slide is never rewritten by the matcher', () => {
  const cues = [{ start: 10, end: 12, text: 'The Princess Bride is a good film.' }];
  const rows = [{ caption: 'The Princess Bride (1987)' }, { caption: 'Inconceivable!' }];
  const [title] = applyCueTimes(rows, cues, { skipFirst: true });
  assert.equal(title.caption, 'The Princess Bride (1987)');
});

test('speakerLabel matches the one the client uses', () => {
  assert.equal(speakerLabel('VIZZINI: Inconceivable!'), 'VIZZINI:');
  assert.equal(speakerLabel('Miracle Max: Have fun'), 'Miracle Max:');
  assert.equal(speakerLabel('Inconceivable!'), '');
});


// ---- A span is contiguous in time, not just in the file ----

test('cues far apart are never stitched into one span', () => {
  // Four cues that happen to share words can otherwise be glued across a
  // twelve-minute gap: wrong scene, and a caption of two unrelated lines.
  const cues = [
    { start: 600, end: 602, text: 'You keep using that word.' },
    { start: 602.2, end: 605, text: 'I do not think it means what you think it means.' },
    { start: 1334, end: 1337, text: 'that word means what you think' },
  ];
  const hit = matchQuoteToCues('You keep using that word. I do not think it means what you think it means.', cues);
  assert.equal(hit.start, 600);
  assert.equal(hit.end, 605, 'stops before the far-away cue');
  assert.doesNotMatch(hit.text, /1334/);
});

test('a normal gap between lines still spans', () => {
  const cues = [
    { start: 100, end: 102, text: 'Hello. My name is Inigo Montoya.' },
    { start: 103, end: 105, text: 'You killed my father.' },
  ];
  const hit = matchQuoteToCues('Hello. My name is Inigo Montoya. You killed my father.', cues);
  assert.equal(hit.start, 100);
  assert.equal(hit.end, 105);
  assert.ok(MAX_CUE_GAP >= 1, 'a beat between lines is normal dialogue');
});

test('repeated words at the end keep their final subtitle cue', () => {
  const cues = [
    { start: 10, end: 12, text: 'Game over, man.' },
    { start: 12.1, end: 15, text: 'Game over!' },
  ];
  assert.equal(matchQuoteToCues('Game over, man. Game over!', cues).end, 15);
});

test('ordered matching rejects the same vocabulary spoken in the wrong order', () => {
  const cues = [
    { start: 10, end: 12, text: 'tomorrow leave never we must' },
    { start: 50, end: 54, text: 'We must never leave tomorrow.' },
  ];
  assert.equal(matchQuoteToCues('We must never leave tomorrow.', cues).start, 50);
});

test('an exchange spread across six cues keeps the whole delivery', () => {
  const lines = ['Hello there.', 'My name is Inigo Montoya.', 'You killed my father.', 'Prepare to die.', 'I want my father back,', 'you son of a bitch.'];
  const cues = lines.map((text, i) => ({ text, start: 100 + i * 3, end: 102.5 + i * 3 }));
  const hit = matchQuoteToCues(lines.join(' '), cues);
  assert.equal(hit.start, 100);
  assert.equal(hit.end, 117.5);
});

test('a distinctive one-word quote can match, but a generic reply cannot', () => {
  const cues = [{ start: 1, end: 3, text: 'Inconceivable!' }];
  assert.equal(matchQuoteToCues('Inconceivable!', cues).start, 1);
  assert.equal(matchQuoteToCues('No', [{ start: 1, end: 2, text: 'No.' }]), null);
});

test('a subtitle sentence on either side cannot leak into the caption', () => {
  const [out] = applyCueTimes([{ caption: "I'll be back." }], [{ start: 10, end: 15, text: "Wait. I'll be back. Okay?" }]);
  assert.equal(out.caption, "I'll be back.");
});

test('speaker labels follow matching words even if subtitle dashes reverse order', () => {
  const out = captionFromCues('- Goodbye now. - Hello there.', 'Alice: Hello there.\nBob: Goodbye now.');
  assert.equal(out, 'Bob: Goodbye now.\nAlice: Hello there.');
});

test('a real source turn spanning several cues retains its name without subtitle dashes', () => {
  const cues = [{ start: 1, end: 2, text: 'Hello there.' }, { start: 2, end: 3, text: 'Welcome back.' }, { start: 4, end: 5, text: 'Thank you kindly.' }];
  const [row] = applyCueTimes([{ caption: 'Alice: Hello there. Welcome back.\nBob: Thank you kindly.' }], cues);
  assert.equal(row.caption, 'Alice: Hello there. Welcome back.\nBob: Thank you kindly.');
  assert.equal(row.cue.segments.length, 3);
});

test('invalid timestamps and out-of-runtime matches never become trusted cues', () => {
  assert.equal(parseSrt('1\n00:00:05,000 --> 00:00:01,000\nHello there.').length, 0);
  assert.equal(srtTimeToSeconds('00:99:10,000'), null);
  assert.equal(matchQuoteToCues('Hello there.', [{ start: null, end: 2, text: 'Hello there.' }]), null);
  const [row] = applyCueTimes([{ caption: 'Hello there.', timecode: 2 }], [{ start: 90, end: 94, text: 'Hello there.' }], { durationSeconds: 10 });
  assert.equal(row.matched, undefined);
  assert.equal(row.timecode, 2);
});

test('a high match score cannot chop the final word off a quote', () => {
  const caption = 'We will get out of here together tonight.';
  const [row] = applyCueTimes([{ caption, timecode: 50 }], [{ start: 10, end: 14, text: 'We will get out of here together.' }]);
  assert.equal(row.caption, caption);
  assert.equal(row.matched, undefined);
});

test('subtitle fractions survive matching and runtime validation', () => {
  const [row] = applyCueTimes([{ caption: 'Hello there.', timecode: 0 }], [{ start: 10.1, end: 12.3, text: 'Hello there.' }], { durationSeconds: 12.5 });
  assert.equal(row.timecode, 10.65);
  assert.equal(row.matched, true);
});
