// Pure SRT parse + quote→cue matching for Quote-a-long Autopilot.
//
// Pure — no network, no DOM. Unit-tested under node:test.
//
// This module is the whole reason Quote-a-long exists: the timecode for a
// quote slide is ARITHMETIC on the subtitle file, not a guess and not a
// vision check. The model boils the wording; where the line lands in the
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
    if (start == null || end == null) continue;
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

function tokens(s) {
  return normalizeQuoteText(s).split(' ').filter((w) => w.length > 1);
}

// How many consecutive cues one quote may span.
//
// Pairs are not enough. A subtitle file breaks a line every few words and an
// IMDb quote is usually an exchange, so the words of one quote routinely land
// across three or four cues. Scored against pairs only, such a quote either
// finds nothing and falls back to a guess, or latches onto whichever half-
// window scores best and lands seconds off the line it is captioning.
//
// Four is the ceiling because the tie-break prefers fewer cues, so a wider
// window only wins when it genuinely holds more of the quote.
export const MAX_SPAN_CUES = 4;

// How much of the quote a span has to carry to count as a match. Below this we
// return nothing, which is honest: the caller keeps the model's guess rather
// than being handed a confident wrong answer.
const MIN_RATIO = 0.6;

// Best matching run of cues for one quote, or null.
//
// Score is recall over the quote's distinct words: what fraction of them the
// span contains. Ties go to the shorter span, then to the earlier one — a line
// quoted twice belongs to the first time it is said.
export function matchQuoteToCues(quote, cues) {
  const list = Array.isArray(cues) ? cues : [];
  const want = new Set(tokens(quote));
  if (want.size < 2 || !list.length) return null;

  // Tokenize each cue once. The old version re-normalized the joined text of
  // every window it scored, which is the same work over and over.
  const per = list.map((c) => tokens(c?.text));
  let best = null;

  for (let i = 0; i < list.length; i++) {
    const have = new Set();
    const last = Math.min(list.length - 1, i + MAX_SPAN_CUES - 1);
    for (let j = i; j <= last; j++) {
      for (const w of per[j]) have.add(w);
      let hits = 0;
      for (const w of want) if (have.has(w)) hits++;
      const ratio = hits / want.size;
      if (ratio < MIN_RATIO) continue;
      const cueCount = j - i + 1;
      if (
        !best
        || ratio > best.ratio
        || (ratio === best.ratio && cueCount < best.cueCount)
        || (ratio === best.ratio && cueCount === best.cueCount && i < best.from)
      ) {
        best = { from: i, to: j, ratio, cueCount };
      }
    }
  }

  if (!best) return null;
  return {
    start: list[best.from].start,
    end: list[best.to].end,
    text: list.slice(best.from, best.to + 1).map((c) => c.text).join(' '),
    index: best.from,
  };
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
// list here and the result overrides whatever it said. A caption is a boiled
// subset of the quote it came from, so it matches at least as well as the
// original did. When nothing clears the matcher's bar the model's own guess is
// left alone — that is the honest fallback, and it is also what happens for
// every film with no subtitle file at all.
//
// `skipFirst` protects the title slide: it points at the film's title card,
// which is not a spoken line and must never be dragged to one.
export function applyCueTimes(suggestions, cues, { skipFirst = false, durationSeconds = 0 } = {}) {
  const list = Array.isArray(cues) ? cues : [];
  const rows = Array.isArray(suggestions) ? suggestions : [];
  if (!list.length || !rows.length) return rows;
  const dur = Math.max(0, Math.floor(Number(durationSeconds) || 0));
  return rows.map((row, i) => {
    if (skipFirst && i === 0) return row;
    const hit = matchQuoteToCues(row?.caption, list);
    if (!hit) return row;
    let tc = Math.round(seekTime(hit.start, hit.end));
    tc = Math.min(dur || tc, Math.max(0, tc));
    return { ...row, start: hit.start, end: hit.end, timecode: tc, matched: true };
  });
}
