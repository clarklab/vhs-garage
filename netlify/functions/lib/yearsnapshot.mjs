// "Year Snapshot": prompts + normalizers for the single-year format — how one
// year did, in two top-eight lists (IMDb rating and box office). Pure (no
// network/DOM), mirroring someguys.mjs's contract: buildYearPrompt() writes the
// LLM prompt, normalizeYearSnapshot() validates/clamps the JSON.
//
// The rated list has two modes. By default the model recalls it under a stated
// vote floor; when the user pastes their own IMDb search results the list is
// FIXED and the model only writes the notes. IMDb has no free API and 403s
// server-side fetches, so that paste is the only route to verified numbers.
import { stripDashes } from './autopilot.mjs';

export const LIST_COUNT = 8;      // "top eight" — the whole point of the format
export const YEAR_MIN = 1930;     // before this there is no meaningful chart data
export const YEAR_MAX = 2035;
export const DEFAULT_MIN_VOTES = 100_000; // IMDb vote floor, matching the search UI

// The lists, in slide order. `key` is the JSON key the model returns and the
// key the client builds a section from.
export const YEAR_LIST_KEYS = ['rated', 'boxoffice'];

const TITLE_MAX = 120;
const VALUE_MAX = 44;   // the short number line under the title
const NOTE_MAX = 120;   // one-line "why it mattered"
const INTRO_MAX = 160;  // opener lead-in

// Coerce whatever the client sent into a usable release year, or null.
export function normalizeYearInput(raw) {
  const y = Number(raw);
  if (!Number.isInteger(y) || y < YEAR_MIN || y > YEAR_MAX) return null;
  return y;
}

// Coerce the IMDb vote floor, falling back to the default rather than to "no
// floor" — an unfloored rating list is the failure mode this whole knob exists
// to prevent.
export function normalizeMinVotes(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MIN_VOTES;
  return Math.min(n, 10_000_000);
}

// Human-readable vote floor for the prompt ("100,000").
function commas(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// `ratedGiven` is the user's own IMDb search results, pasted in. When present
// the rated list stops being a recall task: the titles, order, and ratings are
// FIXED, and the model only writes the note for each.
export function buildYearPrompt({ year, count = LIST_COUNT, minVotes = DEFAULT_MIN_VOTES, ratedGiven = [], sourceMaterial = '', sourceName = '' }) {
  const y = normalizeYearInput(year) ?? YEAR_MIN;
  const floor = commas(normalizeMinVotes(minVotes));
  const given = (Array.isArray(ratedGiven) ? ratedGiven : []).filter((r) => r?.title).slice(0, count);

  const sourceBlock = String(sourceMaterial || '').trim()
    ? `\n\nREFERENCE MATERIAL${sourceName ? ` (Wikipedia: "${sourceName}")` : ''} about this year in film is below. Prefer facts grounded in it over memory, but do not treat gaps in it as evidence that something did not happen.\n<source_material>${String(sourceMaterial).trim().slice(0, 12000)}</source_material>`
    : '';

  // Two modes for list 1, depending on whether the user brought real data.
  const ratedBlock = given.length
    ? `1. "rated": FIXED. The user pulled this list straight off IMDb, sorted by user rating with a floor of ${floor} votes, and it is authoritative. Return these EXACT titles, in this EXACT order, copying each "value" verbatim. Do not add titles, drop titles, reorder them, correct them, or adjust a rating, even if you believe one is wrong. Your only job on this list is writing each "note".
<imdb_results>
${given.map((r, i) => `${i + 1}. ${r.title} | value: ${r.value || ''}`).join('\n')}
</imdb_results>`
    : `1. "rated": the ${count} highest IMDb-rated feature films RELEASED in ${y}. Rank by IMDb user rating, counting ONLY films with at least ${floor} votes, the way IMDb's own advanced search does when you set a vote floor. That floor matters: without it, obscure titles with a handful of ratings crowd out the real entries. Each entry's "value" is the rating written as "9.3 on IMDb". Ratings drift over time, so give the rating you are most confident is close to current.`;

  return `You are researching a "Year Snapshot" TikTok photo slideshow for VHS Garage: a look back at how ONE year did at the movies, for film fans who grew up renting tapes.

The year is ${y}.

Produce TWO ranked lists about ${y}, each with exactly ${count} entries in rank order (best/biggest first):

${ratedBlock}

2. "boxoffice": the ${count} highest-grossing films of ${y} by WORLDWIDE box office for that release year. Each entry's "value" is the gross written short, like "$1.05B worldwide" or "$306M worldwide". If you are only confident about the domestic number, write it as "$306M domestic" instead.

Rules that matter more than filling the lists:
- Only include titles and numbers you are genuinely confident are real. NEVER invent a film, a rating, or a gross.
- If you are not confident about a whole list, return that list as an EMPTY array. A missing list is fine. A fabricated one is not.
- Do not pad a list with guesses to reach ${count}. Fewer real entries beats ${count} shaky ones.
- No duplicate titles inside a list. The same film may legitimately appear in both lists.

For every entry, give:
- "rank": its position, starting at 1.
- "title": the film's exact title, with no year in it.
- "value": the short number line described above (${VALUE_MAX} characters max).
- "note": one short line on why it landed there, a scene, a record it broke, an audience it found (${NOTE_MAX} characters max). A confident statement: no questions, no hype phrasing like "you won't believe", and no em or en dashes (the — or – characters).

ALSO write "intro": a warm one-line lead-in for the whole set (${INTRO_MAX} characters max) that sets up ${y} as a year at the movies and invites viewers to comment on what they were watching that year. It MAY ask a friendly question. No hype words, no em or en dashes.${sourceBlock}

Return ONLY valid JSON in this exact shape, nothing else:
{
  "intro": "string",
  "rated": [ { "rank": 1, "title": "string", "value": "string", "note": "string" } ],
  "boxoffice": [ { "rank": 1, "title": "string", "value": "string", "note": "string" } ]
}`;
}

// One list: drop entries without a title, dedupe by title, clamp the strings,
// and RENUMBER by position — the model's own ranks are advisory, the array
// order is what the slides show, so the two can never disagree on screen.
function normalizeList(raw, max) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (out.length >= max) break;
    const title = typeof item?.title === 'string' ? item.title.trim() : '';
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      rank: out.length + 1,
      title: title.slice(0, TITLE_MAX),
      value: typeof item?.value === 'string' ? stripDashes(item.value.trim()).slice(0, VALUE_MAX) : '',
      note: typeof item?.note === 'string' ? stripDashes(item.note.trim()).slice(0, NOTE_MAX) : '',
    });
  }
  return out;
}

// Validate/clamp the whole snapshot. Every list key is always present (possibly
// empty) so the client can loop the three sections without existence checks.
export function normalizeYearSnapshot(raw, max = LIST_COUNT) {
  const out = {
    intro: typeof raw?.intro === 'string' ? stripDashes(raw.intro.trim()).slice(0, INTRO_MAX) : '',
  };
  for (const key of YEAR_LIST_KEYS) out[key] = normalizeList(raw?.[key], max);
  return out;
}

// True when at least one list came back usable — the server treats an all-empty
// snapshot as a failed job rather than shipping a one-slide slideshow.
export function hasAnyEntries(snapshot) {
  return YEAR_LIST_KEYS.some((k) => (snapshot?.[k] || []).length > 0);
}
