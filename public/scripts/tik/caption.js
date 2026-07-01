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
