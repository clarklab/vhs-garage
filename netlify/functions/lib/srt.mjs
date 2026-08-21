// Pure SRT parse + quote→cue matching for Quote-a-long Autopilot.

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

export function quoteHints(quotes, cues) {
  return (Array.isArray(quotes) ? quotes : []).map((q, i) => {
    const text = typeof q === 'string' ? q : String(q?.text || '');
    const hit = matchQuoteToCues(text, cues);
    if (!hit) return null;
    return { quoteIndex: i, start: hit.start, end: hit.end };
  }).filter(Boolean);
}
