// Parse the ranked film charts a Year Snapshot is built from: IMDb's advanced
// search (rating, vote-floored) and Box Office Mojo's yearly chart (gross).
// Neither site has a free API and both block server-side fetches, so the real
// numbers can only come from the user's own browser — the /tik bookmarklets
// read the page they are looking at, or they copy the page text by hand.
//
// So these parsers have to be forgiving. Between them they handle:
//   bookmarklet:  "1. The Shawshank Redemption (1994) | 9.3 | 3.1M votes"
//                 "1. The Lion King | $968.5M worldwide"
//   raw paste:    "1. The Shawshank Redemption" / "1994" / "2h 22m" / "R" / "9.3" / "(3.1M)"
//                 "1<tab>The Lion King<tab>$968,483,777<tab>$312,855,561<tab>32.3%"
//   hand-typed:   "The Shawshank Redemption 9.3"   "The Lion King $968,483,777"
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

// ================= Box office =================

// 968483777 → "$968M"; 1052000000 → "$1.05B". Two decimals past a billion,
// one below a hundred million, none in between — the shape these figures are
// normally quoted in.
export function formatGross(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2).replace(/0$/, '')}B`;
  if (n >= 1e8) return `$${Math.round(n / 1e6)}M`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

// "$968,483,777" → 968483777; "$968.5M" → 968500000.
const MONEY = /\$\s*([\d.,]+)\s*([KMB])?/i;
export function parseGross(text) {
  const m = String(text || '').match(MONEY);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = m[2] ? { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] : 1;
  return Math.round(n * mult);
}

// A value the bookmarklet already formatted ("$968.5M worldwide") is kept
// verbatim; anything else is a raw figure we format ourselves.
const FORMATTED_GROSS = /^\$[\d.,]+\s*[KMB]?\s+(worldwide|domestic|international|foreign)$/i;
// Row fields arrive tab-separated (a real table copy), pipe-separated (the
// bookmarklet), or run-of-spaces separated (a plain-text copy).
const FIELD_SPLIT = /\t+|\s*\|\s*|\s{2,}/;
const LEADING_RANK = /^\s*\d{1,3}\s*[.)]?\s*$/;
const TRAILING_MONEY = /\s*\$\s*[\d.,]+\s*[KMB]?\s*$/i;
const PERCENT_ONLY = /^-?[\d.]+%$/;

// Parse a pasted box office chart into [{ rank, title, value, gross }].
// `label` is the qualifier appended to figures we format ("worldwide"), so the
// slide says what the number actually measures.
export function parseGrossList(text, max = MAX_ENTRIES, label = 'worldwide') {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  const seen = new Set();

  for (const line of lines) {
    if (out.length >= max) break;
    let fields = line.split(FIELD_SPLIT).map((f) => f.trim()).filter(Boolean);
    if (fields.length && LEADING_RANK.test(fields[0])) fields = fields.slice(1);
    if (!fields.length) continue;

    // A figure the bookmarklet already wrote out wins; otherwise take the first
    // dollar amount on the row, which on Mojo's worldwide chart is the
    // worldwide total (the columns after it are domestic and foreign splits).
    const preformatted = fields.find((f) => FORMATTED_GROSS.test(f));
    const moneyField = fields.find((f) => f !== preformatted && MONEY.test(f) && !PERCENT_ONLY.test(f));

    let title = fields.find((f) => f !== preformatted && f !== moneyField && /[a-z]/i.test(f) && !MONEY.test(f)) || '';
    let gross = moneyField ? parseGross(moneyField) : null;

    // Hand-typed "The Lion King $968,483,777" arrives as one field: peel the
    // amount off the end rather than dropping the row.
    if (!title) {
      const candidate = fields.find((f) => f !== preformatted && /[a-z]/i.test(f));
      if (candidate) {
        const stripped = candidate.replace(TRAILING_MONEY, '').trim();
        if (stripped && /[a-z]/i.test(stripped)) {
          title = stripped;
          if (gross === null) gross = parseGross(candidate);
        }
      }
    }
    title = title.replace(/^\s*\d{1,3}\s*[.)]\s*/, '').replace(/\s{2,}/g, ' ').trim().slice(0, TITLE_MAX);
    if (!title) continue;

    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const value = preformatted
      ? preformatted.replace(/\s+/g, ' ')
      : (gross !== null ? `${formatGross(gross)} ${label}`.trim() : '');
    out.push({ rank: out.length + 1, title, value, gross: gross ?? (preformatted ? parseGross(preformatted) : null) });
  }
  return out;
}

// Parsed gross rows → the snapshot's list shape (notes come from the agent).
export function toGrossEntries(parsed, count) {
  return parsed.slice(0, count).map((p, i) => ({
    rank: i + 1, title: p.title, value: p.value, note: '',
  }));
}

// Box Office Mojo's worldwide chart for a year — the box office equivalent of
// the IMDb search this format leans on.
export function boxOfficeMojoUrl(year) {
  return `https://www.boxofficemojo.com/year/world/${Math.round(Number(year) || 0)}/`;
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
