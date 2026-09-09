// Keep speaker attribution attached to the source line, never to its position
// in a model response or subtitle file.
export const SPEAKER_PATTERN = /^\s*([\p{Lu}][\p{L}\p{N} .’'\-]{0,60}):\s*/u;

export function dialogueLines(raw) {
  return String(raw || '')
    .replace(/\\n/g, '\n')
    .replace(/\r\n?/g, '\n')
    // Older cached IMDb blocks sometimes have their line breaks flattened.
    .replace(/([.!?]["”']?)\s+(?=[\p{Lu}][\p{L}\p{N} .’'\-]{0,40}:)/gu, '$1\n')
    .split('\n')
    .map((line) => {
      const label = line.match(SPEAKER_PATTERN);
      const text = (label ? line.slice(label[0].length) : line)
        .replace(/<[^>]+>/g, ' ').replace(/\[[^\]]*\]/g, ' ')
        .replace(/\s+/g, ' ').trim();
      return { speaker: label?.[1] || '', text };
    }).filter((line) => line.text);
}

export function formatDialogue(lines) {
  const named = lines.every((line) => line.speaker)
    && new Set(lines.map((line) => line.speaker.toLowerCase())).size > 1;
  return lines.map(({ speaker, text }) => named ? `${speaker}: ${text}` : text).join('\n');
}

export function quoteText(quote) {
  return typeof quote === 'string' ? quote : String(quote?.text || '');
}

const key = (text) => String(text).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// The model chooses source turns; we supply their words and names ourselves.
// Legacy responses without references can still recover attribution by words.
export function groundQuoteSuggestions(raw, quotes, { skipFirst = false } = {}) {
  const pool = (Array.isArray(quotes) ? quotes : []).map((q) => dialogueLines(quoteText(q)));
  return { ...raw, suggestions: (Array.isArray(raw?.suggestions) ? raw.suggestions : []).map((row, i) => {
    if (skipFirst && i === 0) return row;
    const written = dialogueLines(row?.caption);
    const source = pool[Number(row?.quoteIndex) - 1];
    const indices = row?.lineIndices;
    let selected = null;
    if (source && Array.isArray(indices) && indices.length > 0 && indices.length <= 2
        && indices.every((n, j) => Number.isInteger(n) && n >= 1 && n <= source.length
          && (!j || n === indices[j - 1] + 1))) {
      selected = indices.map((n) => source[n - 1]);
    }
    if (!selected && written.length) {
      // Require a unique source attribution. Common replies can belong to
      // several people; guessing a name would recreate the original bug.
      const matches = [];
      for (const lines of pool) {
        for (let start = 0; start < lines.length; start++) {
          const slice = lines.slice(start, start + written.length);
          if (slice.length === written.length && slice.every((line, j) => key(line.text) === key(written[j].text))) {
            matches.push(slice);
          }
        }
      }
      if (matches.length && matches.every((m) => formatDialogue(m) === formatDialogue(matches[0]))) selected = matches[0];
    }
    return { ...row, caption: formatDialogue(selected || written.map((line) => ({ ...line, speaker: '' }))) };
  }) };
}
