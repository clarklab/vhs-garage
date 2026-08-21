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
  s = s.replace(/["“”']/g, '');
  s = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

function tokens(s) {
  return normalizeQuoteText(s).split(' ').filter((w) => w.length > 1);
}

// Score single cues and concatenated adjacent pairs; pick the best span.
// A single-cue ratio of 0.6 misses quotes split across two lines (~0.33 on
// the first cue, or a later cue stealing the match), so pairs are required.
export function matchQuoteToCues(quote, cues) {
  const list = Array.isArray(cues) ? cues : [];
  const want = tokens(quote);
  if (want.length < 2 || !list.length) return null;

  let best = null;

  function consider(from, to) {
    const span = list.slice(from, to + 1);
    const have = new Set(tokens(span.map((c) => c.text).join(' ')));
    const ratio = want.filter((w) => have.has(w)).length / want.length;
    const cueCount = to - from + 1;
    if (ratio < 0.6) return;
    if (
      !best
      || ratio > best.ratio
      || (ratio === best.ratio && cueCount < best.cueCount)
      || (ratio === best.ratio && cueCount === best.cueCount && from < best.from)
    ) {
      best = { from, to, ratio, cueCount };
    }
  }

  for (let i = 0; i < list.length; i++) {
    consider(i, i);
    if (i + 1 < list.length) consider(i, i + 1);
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
