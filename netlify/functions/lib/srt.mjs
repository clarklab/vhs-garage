import { dialogueLines, formatDialogue, SPEAKER_PATTERN } from './quote-dialogue.mjs';

// Pure SRT parse + quote→cue matching for Quote-a-long Autopilot.
//
// Pure — no network, no DOM. Unit-tested under node:test.
//
// This module is the whole reason Quote-a-long exists: the timecode for a
// quote slide is ARITHMETIC on the subtitle file, not a guess and not a
// vision check. The model selects source lines; where the line lands in the
// film is decided here.

const CLOCK = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/;

export function srtTimeToSeconds(raw) {
  const m = String(raw || '').trim().match(CLOCK);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  const ms = Number(m[4].padEnd(3, '0'));
  if (![hh, mm, ss, ms].every(Number.isFinite)) return null;
  if (mm > 59 || ss > 59) return null;
  return hh * 3600 + mm * 60 + ss + ms / 1000;
}

export function parseSrt(input) {
  const text = String(input || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.trim()) return [];
  const blocks = text.split(/\n\s*\n/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter((l, i, arr) => !(i === 0 && /^\d+$/.test(l) && arr.length > 1));
    const arrow = lines.find((l) => /-->/.test(l));
    if (!arrow) continue;
    const [left, right] = arrow.split(/-->/).map((s) => s.trim());
    const start = srtTimeToSeconds(left.split(/\s+/)[0]);
    const end = srtTimeToSeconds(right.split(/\s+/)[0]);
    if (start == null || end == null || end <= start) continue;
    const body = lines.filter((l) => l !== arrow).join(' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    out.push({ start, end, text: body });
  }
  return out;
}

export function normalizeQuoteText(raw) {
  let s = String(raw || '');
  s = s.replace(/^\s*\[[^\]]+\]\s*:?\s*/gm, '');
  s = s.replace(/^\s*[A-Z][A-Za-z0-9 .'\-]{1,40}:\s*/gm, '');
  // And again mid-line, for when an exchange arrives on one line: an IMDb
  // quote is usually two or three characters talking, and every speaker label
  // left in here is a word the subtitle file will never contain. They are pure
  // ballast in the score — enough of them and a real match drops under the bar.
  s = s.replace(/(^|[.!?]["“”']?\s+)([A-Z][A-Za-z0-9 .'\-]{1,30}):\s*/g, '$1');
  s = s.replace(/["“”']/g, '');
  s = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

// Keep order and repeated words: a bag of distinct words can match just the
// first “Game over” and lose the repeated ending entirely.
function wordRecords(text) {
  return [...String(text).matchAll(/\S+/g)].map((m) => ({
    word: m[0].toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''),
    start: m.index, end: m.index + m[0].length,
  })).filter((w) => w.word);
}

function cleanCue(text) {
  return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\[[^\]]*\]/g, ' ')
    .replace(/[♪♫]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const wordsOf = (text) => wordRecords(text).map((w) => w.word);
const spokenText = (text) => dialogueLines(text).map((line) => line.text).join(' ');

// Ordered alignment, with source-word positions for caption/cue boundaries.
function alignWords(want, have) {
  const dp = Array.from({ length: want.length + 1 }, () => new Uint16Array(have.length + 1));
  for (let i = 1; i <= want.length; i++) {
    for (let j = 1; j <= have.length; j++) {
      dp[i][j] = want[i - 1] === have[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const pairs = [];
  let i = want.length, j = have.length;
  while (i && j) {
    if (want[i - 1] === have[j - 1]) { pairs.push([--i, --j]); }
    else if (dp[i - 1][j] > dp[i][j - 1]) i--;
    else j--;
  }
  return pairs.reverse();
}

export const MAX_SPAN_CUES = 12;
export const MAX_CUE_GAP = 5;
export const MAX_MATCH_SECONDS = 45;
const MIN_RATIO = 0.85;

const validCue = (c) => c?.start != null && c?.end != null
  && Number.isFinite(Number(c.start)) && Number.isFinite(Number(c.end))
  && Number(c.start) >= 0 && Number(c.end) > Number(c.start);

export function matchQuoteToCues(quote, cues) {
  const list = Array.isArray(cues) ? cues : [];
  const want = wordsOf(spokenText(quote));
  if (!want.length || (want.length === 1 && want[0].length < 5) || !list.length) return null;
  const per = list.map((c) => wordsOf(cleanCue(c?.text)));
  let best = null;
  for (let i = 0; i < list.length; i++) {
    if (!validCue(list[i])) continue;
    // Incremental LCS: each added cue extends the alignment instead of
    // recalculating every window from scratch.
    let dp = new Uint16Array(want.length + 1);
    let count = 0;
    for (let j = i; j < Math.min(list.length, i + MAX_SPAN_CUES); j++) {
      if (!validCue(list[j]) || Number(list[j].end) - Number(list[i].start) > MAX_MATCH_SECONDS) break;
      if (j > i && (Number(list[j].start) < Number(list[j - 1].start)
        || Number(list[j].start) - Number(list[j - 1].end) > MAX_CUE_GAP)) break;
      for (const word of per[j]) {
        const next = new Uint16Array(want.length + 1);
        for (let k = 1; k <= want.length; k++) {
          next[k] = word === want[k - 1] ? dp[k - 1] + 1 : Math.max(dp[k], next[k - 1]);
        }
        dp = next;
        count++;
      }
      const hits = dp[want.length];
      const ratio = hits / want.length;
      const precision = hits / (count || 1);
      if (ratio < MIN_RATIO || precision < 0.45) continue;
      const cueCount = j - i + 1;
      if (!best || ratio > best.ratio || (ratio === best.ratio && precision > best.precision)
        || (ratio === best.ratio && precision === best.precision && cueCount < best.cueCount)) {
        best = { from: i, to: j, ratio, precision, cueCount };
      }
    }
  }
  if (!best) return null;
  const segments = list.slice(best.from, best.to + 1).map((c) => ({ start: Number(c.start), end: Number(c.end), text: cleanCue(c.text) }));
  return {
    start: segments[0].start, end: segments.at(-1).end,
    text: segments.map((c) => c.text).join(' '), index: best.from, segments,
    previousEnd: validCue(list[best.from - 1]) ? Number(list[best.from - 1].end) : null,
    nextStart: validCue(list[best.to + 1]) ? Number(list[best.to + 1].start) : null,
  };
}

export function speakerLabel(line) {
  const match = String(line ?? '').match(SPEAKER_PATTERN);
  return match ? `${match[1]}:` : '';
}

// Use subtitle wording, but recover a speaker only by matching their actual
// words. Subtitle dashes and line positions are never evidence of identity.
export function captionFromCues(cueText, sourceCaption = '') {
  const cleaned = cleanCue(cueText);
  if (!cleaned) return null;
  const source = dialogueLines(sourceCaption);
  if (!source.length) return cleaned.split(/(?:^|\s)-\s+/).filter(Boolean).join('\n');
  if (cleaned.length > spokenText(sourceCaption).length * 2.2) return null;
  const records = wordRecords(cleaned);
  const have = records.map((r) => r.word);
  const selected = [];
  for (const line of source) {
    const want = wordsOf(line.text);
    const pairs = alignWords(want, have);
    if (!want.length || pairs.length / want.length < MIN_RATIO) return null;
    // A high overall score can still omit the last word of a long quote.
    // Require both ends of the source line before trusting the clip boundary.
    if (pairs[0][0] !== 0 || pairs.at(-1)[0] !== want.length - 1) return null;
    const first = pairs[0][1], last = pairs.at(-1)[1];
    if (selected.some((s) => first <= s.last && last >= s.first)) return null;
    // Keep the subtitle's punctuation with the final word, without dragging
    // the next speaker's leading dash into this line.
    const text = cleaned.slice(records[first].start, records[last].end)
      .replace(/(?:^|\s)-\s+/g, ' ').trim();
    selected.push({ ...line, text, first, last });
  }
  selected.sort((a, b) => a.first - b.first);
  return formatDialogue(selected);
}

// Word ranges use the same whitespace units as the browser's spokenWords.
// These are cue anchors, not measured word timestamps. Each cue gets its own
// clock, so a pause between cues is preserved rather than stretched over words.
export function captionCueSegments(caption, segments) {
  const want = wordsOf(spokenText(caption));
  const have = [], owners = [];
  for (let i = 0; i < segments.length; i++) {
    for (const word of wordsOf(segments[i].text)) { have.push(word); owners.push(i); }
  }
  const pairs = alignWords(want, have);
  if (!want.length || pairs.length !== want.length) return [];
  const out = [];
  for (const [word, hit] of pairs) {
    const cue = segments[owners[hit]];
    const prev = out.at(-1);
    if (prev?.owner === owners[hit]) prev.to = word + 1;
    else out.push({ owner: owners[hit], start: cue.start, end: cue.end, from: word, to: word + 1 });
  }
  return out.map(({ owner, ...segment }) => segment);
}

// Where to freeze the frame inside a matched cue span.
//
// The first quarter, not the middle: a cue's window covers the whole delivery
// of the line, and the shot is far more likely to still be on the speaker
// early than on a cutaway by the halfway point.
export function seekTime(start, end) {
  if (start == null) return 0;
  const a = Number(start);
  const b = Number(end);
  if (!Number.isFinite(a) || a < 0) return 0;
  const from = Math.max(0, a);
  const to = Number.isFinite(b) ? Math.max(from, b) : from;
  return from + 0.25 * (to - from);
}

export function quoteHints(quotes, cues) {
  return (Array.isArray(quotes) ? quotes : []).map((q, i) => {
    const text = typeof q === 'string' ? q : String(q?.text || '');
    const hit = matchQuoteToCues(text, cues);
    if (!hit) return null;
    return { quoteIndex: i, start: hit.start, end: hit.end };
  }).filter(Boolean);
}

// Put the arithmetic back in charge of the timecodes.
//
// The model is handed the cue list and asked for "start"/"end", but it is a
// bad instrument for this: the list it sees is a SAMPLE of a long file, so the
// cue holding a given line is usually absent and the nearest one looks close
// enough to answer confidently with. It also has to keep two numbered lists in
// step across a long prompt, which is exactly the sort of bookkeeping that
// silently slips by one.
//
// So after the model returns, every caption is matched against the FULL cue
// list here and the result overrides whatever it said. A caption consists of
// complete source turns. When nothing clears the matcher's bar the model's guess is
// left alone — that is the honest fallback, and it is also what happens for
// every film with no subtitle file at all.
//
// `skipFirst` protects the title slide: it points at the film's title card,
// which is not a spoken line and must never be dragged to one.
export function applyCueTimes(suggestions, cues, { skipFirst = false, durationSeconds = 0 } = {}) {
  const list = Array.isArray(cues) ? cues : [];
  const rows = Array.isArray(suggestions) ? suggestions : [];
  if (!list.length || !rows.length) return rows;
  const dur = Math.max(0, Number(durationSeconds) || 0);
  return rows.map((row, i) => {
    if (skipFirst && i === 0) return row;
    const hit = matchQuoteToCues(row?.caption, list);
    if (!hit || (dur && hit.end > dur)) return row;
    let tc = Math.round(seekTime(hit.start, hit.end) * 1000) / 1000;
    tc = Math.min(dur || tc, Math.max(0, tc));
    // The subtitle is the only text here that came from the audio, so when it
    // is usable it becomes the caption — otherwise the source quote stands.
    const spoken = captionFromCues(hit.text, row?.caption);
    if (!spoken) return row;
    const segments = captionCueSegments(spoken, hit.segments);
    return {
      ...row,
      caption: spoken,
      start: hit.start,
      end: hit.end,
      timecode: tc,
      matched: true,
      cue: { start: hit.start, end: hit.end, segments, caption: spoken,
        previousEnd: hit.previousEnd, nextStart: hit.nextStart },
    };
  });
}
