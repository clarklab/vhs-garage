// Turning a pasted list of movies into queue entries.
//
// Batch mode could only take films one at a time through the search box, which
// is fine for one and miserable for twenty. People keep their want-lists in a
// note, a spreadsheet column, or a Letterboxd export, so the list arrives as
// text — numbered, bulleted, with years in parentheses or trailing after a
// dash, and usually with a stray header line on top.
//
// This module does the two pure halves of that job: read the text into
// {title, year} rows, and decide which IMDb search result a row meant. The
// network round trips stay in batch.js.
//
// Pure — no DOM, no network. Unit-tested under node:test.

export const MAX_PASTED = 50; // a pasted novel is a mistake, not a queue

// "1." / "12)" / "-" / "*" / "•" / "→" at the head of a line.
const LIST_MARKER = /^\s*(?:\d{1,3}\s*[.)\]]|[-–—*•>→])\s*/;
// A four-digit year in parens, brackets, or trailing after a separator.
const YEAR_PAREN = /[([{]\s*((?:1[89]|20)\d{2})\s*[)\]}]/;
const YEAR_TRAILING = /(?:^|[\s,;:–—-])((?:1[89]|20)\d{2})\s*$/;
// Lines that are a heading rather than a film.
const HEADING = /^\s*(?:movies?|films?|titles?|list|queue|to\s*watch|watchlist|todo)\s*:?\s*$/i;

// Compare titles the way a person would: case, punctuation, a leading article
// and a trailing year are all noise. Mirrors movieKey() in queue.mjs — kept
// separate because that one is server-side and this one ships to the browser.
export function titleKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s*[([{]\s*(?:1[89]|20)\d{2}\s*[)\]}]\s*$/, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(?:the|a|an)\s+/, '')
    .replace(/\s+/g, '');
}

// text → [{ title, year, raw }], in the order pasted, deduped by title+year.
export function parseTitleList(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const out = [];
  const seen = new Set();

  for (const line of text.split(/\r?\n/)) {
    let s = line.trim();
    if (!s || HEADING.test(s)) continue;
    s = s.replace(LIST_MARKER, '').trim();
    // A tab or a pipe means a table was pasted; the title is the first column.
    if (/[\t|]/.test(s)) s = s.split(/[\t|]/)[0].trim();
    if (!s) continue;

    let year = null;
    const paren = s.match(YEAR_PAREN);
    if (paren) {
      year = paren[1];
      s = s.replace(YEAR_PAREN, ' ').trim();
    } else {
      const trailing = s.match(YEAR_TRAILING);
      // Only strip a trailing year when something is left over: "1982" alone is
      // a title (Nineteen Eighty-Two is not, but a bare year is not a film).
      if (trailing && s.slice(0, trailing.index).trim()) {
        year = trailing[1];
        s = s.slice(0, trailing.index).trim();
      }
    }

    const title = s.replace(/[\s,;:–—-]+$/, '').replace(/\s{2,}/g, ' ').trim();
    if (!title) continue;

    const key = `${titleKey(title)}|${year || ''}`;
    if (!key.startsWith('|') && seen.has(key)) continue;
    seen.add(key);
    out.push({ title, year, raw: line.trim() });
    if (out.length >= MAX_PASTED) break;
  }
  return out;
}

// The most-watched of several same-named films.
//
// A bare "The Thing" or "Forrest Gump" should resolve to the one people mean,
// and that is the popular one — not the oldest, and not whichever happens to
// come back first. IMDb's vote count is the direct measure of that; where it is
// missing we fall back to IMDb's own result order, which is already relevance
// ranked and is what the search box shows you first.
//
// Sorting an already-ordered list with a stable sort keeps that fallback
// meaningful: equal-vote entries stay in the order IMDb returned them.
function mostPopular(list) {
  return [...list].sort((a, b) => (Number(b.votes) || 0) - (Number(a.votes) || 0))[0];
}

// Which search result did this row mean?
//
// Returns { pick, confidence } where confidence is:
//   'exact'  title and year both match       → trustworthy
//   'title'  title matches, year absent/ignored
//   'weak'   nothing matched; the top hit by IMDb relevance
// and pick is null only when there were no candidates at all.
//
// A weak match is still returned rather than dropped: the caller shows it and
// lets the human confirm, which beats silently losing a film off the list.
export function pickBestMatch(want, candidates) {
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) => c && c.title);
  if (!list.length) return { pick: null, confidence: 'none' };

  const wantKey = titleKey(want?.title);
  const wantYear = want?.year ? String(want.year) : null;
  const sameTitle = list.filter((c) => titleKey(c.title) === wantKey);

  if (wantYear) {
    // An explicit year is the strongest thing the paste can tell us, so it
    // outranks popularity: asking for The Thing (1951) means the 1951 one.
    const exact = sameTitle.find((c) => String(c.year || '') === wantYear);
    if (exact) return { pick: exact, confidence: 'exact' };
    // A year that matches nothing is more often a typo in the paste than the
    // wrong film, so a title match still wins — the most popular one.
    if (sameTitle.length) return { pick: mostPopular(sameTitle), confidence: 'title' };
    const byYear = list.find((c) => String(c.year || '') === wantYear);
    if (byYear) return { pick: byYear, confidence: 'weak' };
  } else if (sameTitle.length) {
    return { pick: mostPopular(sameTitle), confidence: 'title' };
  }

  return { pick: list[0], confidence: 'weak' };
}

// Why an add to the batch queue did or did not land.
//
// One function because the search box and the paste list have to agree. They
// used to share a boolean, so BOTH reported a full queue as "already in the
// list" — which sends you hunting for a film that was never added, and is a
// worse lie than saying nothing.
//
// Duplicate is checked before full on purpose: when a film is already queued
// AND the queue is at its cap, "you already have it" is the more useful of the
// two true answers.
export function queueKey(title, year) {
  return `${String(title || '').trim().toLowerCase()}|${year ?? ''}`;
}

export function queueAdmission(pick, queue = [], max = Infinity) {
  const title = String(pick?.title || '').trim();
  if (!title) return { ok: false, reason: 'blank', key: null };
  const key = queueKey(title, pick?.year);
  const rows = Array.isArray(queue) ? queue : [];
  if (rows.some((q) => q?.key === key)) return { ok: false, reason: 'dupe', key };
  if (rows.length >= max) return { ok: false, reason: 'full', key };
  return { ok: true, reason: 'added', key };
}
