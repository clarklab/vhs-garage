// Pure caption layout: word-wrap by measured width, and choose a font size that
// fits N lines into the band. `measure` is injected so this stays DOM-free.

// Greedy word wrap. `measure(str) => widthPx`. Honors explicit "\n".
export function wrapLines(text, maxWidth, measure) {
  const source = String(text ?? '');
  const paragraphs = source.split('\n');
  const out = [];

  for (const para of paragraphs) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]}`;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
      } else {
        out.push(line);
        line = words[i];
      }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

// Largest font (px) so `lineCount` lines fit `bandHeight`, clamped to [minFont, maxFont].
export function fitFontSize(lineCount, bandHeight, opts = {}) {
  const lineHeightFactor = opts.lineHeightFactor ?? 1.25;
  const maxFont = opts.maxFont ?? 72;
  const minFont = opts.minFont ?? 24;
  const n = Math.max(1, lineCount);
  const ideal = Math.floor(bandHeight / (n * lineHeightFactor));
  return Math.max(minFont, Math.min(maxFont, ideal));
}

export function fontScaleForQuote(text) {
  const n = String(text ?? '').trim().length;
  if (!n) return 1;
  if (n <= 40) return 1.35;
  if (n <= 80) return 1.15;
  if (n <= 140) return 1.0;
  return 0.85;
}

// ---- Karaoke: which word is being said right now ----
//
// No library, and no speech recognition: the subtitle cue already says when a
// line starts and stops, which is the hard half. The words inside it are spread
// across that span by LENGTH — "inconceivable" takes longer to say than "a" —
// which is the standard approximation and lands close enough that the highlight
// reads as synced.
//
// A per-word constant goes in alongside the letters, because the gap between
// two words costs time no matter how short they are.
const WORD_OVERHEAD = 2.2; // in units of characters

export function wordWeights(words) {
  return (Array.isArray(words) ? words : []).map((w) => String(w ?? '').trim().length + WORD_OVERHEAD);
}

// How far through the line each word is, as a fraction of the whole line:
// [{ word, from, to }] with from/to in 0..1. Feed it a flat list of the words
// in reading order — the caller knows how they were wrapped, this does not.
export function wordProgress(words) {
  const list = (Array.isArray(words) ? words : []).map((w) => String(w ?? ''));
  const weights = wordWeights(list);
  const total = weights.reduce((a, b) => a + b, 0);
  if (!total) return [];
  let acc = 0;
  return list.map((word, i) => {
    const from = acc / total;
    acc += weights[i];
    return { word, index: i, from, to: acc / total };
  });
}

// Which word is being spoken at `progress` (0..1 through the line).
// Returns -1 before the line starts, and the last index once it is over, so a
// caller can colour "already said" and "still to come" without special cases.
export function spokenIndex(spans, progress) {
  if (!Array.isArray(spans) || !spans.length) return -1;
  const p = Number(progress);
  if (!Number.isFinite(p)) return -1;
  if (p <= 0) return -1;
  if (p >= 1) return spans.length - 1;
  for (const s of spans) {
    if (p < s.to) return s.index;
  }
  return spans.length - 1;
}

// Where a moment sits inside a cue, as 0..1. Null when there is nothing to
// sync to — an unmatched line has no honest word timing, so it just sits there.
export function cueProgress(t, cue) {
  const start = Number(cue?.start);
  const end = Number(cue?.end);
  const at = Number(t);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(at)) return null;
  if (!(end > start)) return null;
  return Math.min(1, Math.max(0, (at - start) / (end - start)));
}
