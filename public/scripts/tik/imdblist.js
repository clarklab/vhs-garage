// Parse a list of films pasted out of IMDb's advanced search. IMDb has no free
// API and blocks server-side fetches, so the real rating-sorted, vote-floored
// list can only come from the user's own browser: the bookmarklet on /tik reads
// the results page they are looking at, or they copy the page text by hand.
//
// So this parser has to be forgiving. It handles three shapes:
//   bookmarklet:  "1. The Shawshank Redemption (1994) | 9.3 | 3.1M votes"
//   raw paste:    "1. The Shawshank Redemption" / "1994" / "2h 22m" / "R" / "9.3" / "(3.1M)"
//   hand-typed:   "The Shawshank Redemption 9.3"  (or just the title)
// Pure (no DOM) so it unit-tests like the other helpers here.

const MAX_ENTRIES = 100;
const TITLE_MAX = 120;

// "1. Title" / "12) Title" — a numbered line that goes on to say something.
const RANKED_LINE = /^\s*(\d{1,3})\s*[.)]\s*(\S.*)$/;
// A rating token: 0–10, optionally with one decimal. The word boundaries keep
// "1994" (four digits), "2h" and "3.1M" (letter-suffixed) from matching.
const RATING = /\b(10(?:\.0)?|\d(?:\.\d)?)\b/;
const RATING_AT_END = /\s(10(?:\.0)?|\d(?:\.\d)?)\s*$/;
// "(3.1M)", "3.1M votes", "1,234,567" — IMDb writes vote counts all three ways.
const VOTES_SUFFIXED = /([\d.,]+)\s*([KMB])\b/i;
const VOTES_PLAIN = /\b(\d{1,3}(?:,\d{3})+|\d{4,})\b/;
const YEAR_ONLY = /^\(?((?:1[89]|20)\d{2})\)?$/;
const TRAILING_YEAR = /\s*\((\d{4})\)\s*$/;

// A results row is title + a stack of metadata (year, runtime, certificate,
// rating, votes). Recognising each metadata shape precisely is what keeps
// "2h 22m" from becoming a film and "1994" from becoming a vote count. The
// certificate list is spelled out rather than matched loosely, so a numeric
// title like "300" is never mistaken for a rating card.
const RUNTIME_ONLY = /^\d+\s*h(\s*\d+\s*m)?$|^\d+\s*m$/i;
const CERT_ONLY = /^(G|PG|PG-13|R|NC-17|X|XXX|M|GP|TV-(Y7?|G|PG|14|MA)|Not Rated|Unrated|Approved|Passed)$/i;
const RATING_ONLY = /^(10(?:\.0)?|\d(?:\.\d)?)$/;
const VOTES_ONLY = /^\(?[\d.,]+\s*[KMB]\)?$/i;

function isMetadataLine(s) {
  return YEAR_ONLY.test(s) || RUNTIME_ONLY.test(s) || CERT_ONLY.test(s)
    || RATING_ONLY.test(s) || VOTES_ONLY.test(s);
}

// "3.1M" → 3100000; "1,234,567" → 1234567; anything unreadable → null.
export function parseVotes(text) {
  const s = String(text || '');
  const suffixed = s.match(VOTES_SUFFIXED);
  if (suffixed) {
    const n = Number(suffixed[1].replace(/,/g, ''));
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[suffixed[2].toLowerCase()];
    if (Number.isFinite(n)) return Math.round(n * mult);
  }
  const plain = s.match(VOTES_PLAIN);
  if (plain) {
    const n = Number(plain[1].replace(/,/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// 3100000 → "3.1M votes". Used in the editor so the vote floor is verifiable
// at a glance; the slide itself only ever shows the rating.
export function formatVotes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M votes`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K votes`;
  return `${n} votes`;
}

// The slide's number line for a rated entry.
export function ratingValue(rating) {
  return Number.isFinite(rating) ? `${rating.toFixed(1).replace(/\.0$/, '')} on IMDb` : '';
}

// Pull a rating out of a block of text, preferring a decimal ("9.3") over a
// bare integer so "R" / "2h 22m" / a stray "8" never outranks the real one.
function findRating(texts) {
  for (const t of texts) {
    const m = t.match(/\b(10(?:\.0)?|\d\.\d)\b/);
    if (m) return Number(m[1]);
  }
  for (const t of texts) {
    const m = t.match(RATING);
    if (m) return Number(m[1]);
  }
  return null;
}

// Split the pasted text into per-film blocks. A run of "1." / "2." / … lines
// means IMDb numbered them for us; otherwise every line with a letter in it is
// its own entry (the hand-typed case).
function toBlocks(lines) {
  const starts = [];
  lines.forEach((line, i) => {
    const m = line.match(RANKED_LINE);
    if (m && !isMetadataLine(m[2])) starts.push({ i, head: m[2] });
  });
  if (starts.length >= 2) {
    return starts.map((s, n) => ({
      head: s.head,
      rest: lines.slice(s.i + 1, n + 1 < starts.length ? starts[n + 1].i : lines.length),
    }));
  }
  return lines.filter((l) => !isMetadataLine(l)).map((l) => ({ head: l.replace(RANKED_LINE, '$2'), rest: [] }));
}

// Parse pasted IMDb search output into [{ rank, title, year, rating, votes }].
// Entries keep the order they were pasted in — that order IS the IMDb sort, so
// re-sorting here would only be a chance to get it wrong.
export function parseImdbList(text, max = MAX_ENTRIES) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  const out = [];
  const seen = new Set();
  for (const block of toBlocks(lines)) {
    if (out.length >= max) break;

    // The bookmarklet emits "Title (Year) | 9.3 | 3.1M votes"; a raw paste has
    // one field per line. Either way, field 1 is the title and the rest is data.
    const parts = block.head.split('|').map((p) => p.trim());
    let title = parts[0] || '';
    const data = [...parts.slice(1), ...block.rest];

    // A rating hanging off the end of the title line ("Pulp Fiction 8.9") is
    // data, not part of the name.
    let rating = null;
    const tail = title.match(RATING_AT_END);
    if (tail && title.slice(0, tail.index).trim()) {
      rating = Number(tail[1]);
      title = title.slice(0, tail.index).trim();
    }

    let year = null;
    const inTitle = title.match(TRAILING_YEAR);
    if (inTitle) {
      year = Number(inTitle[1]);
      title = title.replace(TRAILING_YEAR, '').trim();
    } else {
      const yearLine = data.find((d) => YEAR_ONLY.test(d));
      if (yearLine) year = Number(yearLine.match(YEAR_ONLY)[1]);
    }

    title = title.replace(/\s{2,}/g, ' ').trim().slice(0, TITLE_MAX);
    // Titles are allowed to be pure digits ("300", "1917"); only a line that IS
    // metadata gets thrown away.
    if (!title || isMetadataLine(title)) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // Drop the fields that are neither rating nor votes before reading either.
    // Skipping this lets "1994" satisfy the plain-count pattern and "2h 22m"
    // satisfy the suffixed one (22 + "m" → 22 million), and a wrong vote field
    // then leaves the real "(3.1M)" in the rating search reading as a 3.1.
    const fields = data.filter((d) => !YEAR_ONLY.test(d) && !RUNTIME_ONLY.test(d) && !CERT_ONLY.test(d));
    const voteField = fields.find((d) => VOTES_SUFFIXED.test(d))
      || fields.find((d) => VOTES_PLAIN.test(d))
      || '';
    const votes = parseVotes(voteField);
    if (rating === null) rating = findRating(fields.filter((d) => d !== voteField));
    if (rating !== null && (rating < 0 || rating > 10)) rating = null;

    out.push({ rank: out.length + 1, title, year, rating, votes });
  }
  return out;
}

// Turn parsed rows into the snapshot's `rated` shape (notes come from the
// agent). Entries without a rating still make a slide: the title and its rank
// are the point, and a missing number is better than an invented one.
export function toRatedEntries(parsed, count) {
  return parsed.slice(0, count).map((p, i) => ({
    rank: i + 1,
    title: p.title,
    value: ratingValue(p.rating),
    note: '',
    votes: p.votes ?? null,
  }));
}

// The IMDb advanced-search URL for a year, rating-sorted with a vote floor —
// the exact query this format is built around.
export function imdbSearchUrl(year, minVotes) {
  const params = new URLSearchParams({
    title_type: 'feature',
    release_date: `${year}-01-01,${year}-12-31`,
    user_rating: '1,',
    num_votes: `${Math.max(0, Math.round(Number(minVotes) || 0))},`,
    sort: 'user_rating,desc',
  });
  return `https://www.imdb.com/search/title/?${params}`;
}
