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

export const LIST_COUNT = 10;     // "top ten" — the client sends its own count too
export const YEAR_MIN = 1930;     // before this there is no meaningful chart data
export const YEAR_MAX = 2035;
export const DEFAULT_MIN_VOTES = 100_000; // IMDb vote floor, matching the search UI
// Two lists of eight, each row carrying a title, a figure and a note, runs
// ~1000 output tokens and can go higher with long notes. The shared 2048
// default was sized for a 6-row trivia reply, so this format asks for more:
// a reply cut off mid-array is unparseable and reads as a total failure.
export const YEAR_MAX_TOKENS = 4096;

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

// A list the user pasted in from the source site is authoritative: the titles,
// order, and figures are FIXED and the model only writes the notes.
function fixedListBlock(n, key, given, provenance) {
  return `${n}. "${key}": FIXED. ${provenance} It is authoritative. Return these EXACT titles, in this EXACT order, copying each "value" verbatim. Do not add titles, drop titles, reorder them, correct them, or adjust a figure, even if you believe one is wrong. Your only job on this list is writing each "note".
<given_${key}>
${given.map((r, i) => `${i + 1}. ${r.title} | value: ${r.value || ''}`).join('\n')}
</given_${key}>`;
}

// `ratedGiven` / `boxofficeGiven` are the user's own chart results, pasted from
// IMDb and Box Office Mojo. Either list present switches that list from recall
// to FIXED; the other still comes from the model.
export function buildYearPrompt({
  year, count = LIST_COUNT, minVotes = DEFAULT_MIN_VOTES,
  ratedGiven = [], boxofficeGiven = [],
  sourceMaterial = '', sourceName = '',
}) {
  const y = normalizeYearInput(year) ?? YEAR_MIN;
  const floor = commas(normalizeMinVotes(minVotes));
  const clean = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r?.title).slice(0, count);
  const rated = clean(ratedGiven);
  const box = clean(boxofficeGiven);

  const sourceBlock = String(sourceMaterial || '').trim()
    ? `\n\nREFERENCE MATERIAL${sourceName ? ` (Wikipedia: "${sourceName}")` : ''} about this year in film is below. Prefer facts grounded in it over memory, but do not treat gaps in it as evidence that something did not happen.\n<source_material>${String(sourceMaterial).trim().slice(0, 12000)}</source_material>`
    : '';

  const ratedBlock = rated.length
    ? fixedListBlock(1, 'rated', rated, `The user pulled this list straight off IMDb, sorted by user rating with a floor of ${floor} votes.`)
    : `1. "rated": the ${count} highest IMDb-rated feature films RELEASED in ${y}. Rank by IMDb user rating, counting ONLY films with at least ${floor} votes, the way IMDb's own advanced search does when you set a vote floor. That floor matters: without it, obscure titles with a handful of ratings crowd out the real entries. Each entry's "value" is the rating written as "9.3 on IMDb". Ratings drift over time, so give the rating you are most confident is close to current.`;

  const boxBlock = box.length
    ? fixedListBlock(2, 'boxoffice', box, 'The user pulled this list straight off Box Office Mojo\'s yearly worldwide chart.')
    : `2. "boxoffice": the ${count} highest-grossing films of ${y} by WORLDWIDE box office for that release year. Each entry's "value" is the gross written short, like "$1.05B worldwide" or "$306M worldwide". If you are only confident about the domestic number, write it as "$306M domestic" instead.`;

  return `You are researching a "Year Snapshot" TikTok photo slideshow for VHS Garage: a look back at how ONE year did at the movies, for film fans who grew up renting tapes.

The year is ${y}.

Produce TWO ranked lists about ${y}, each with exactly ${count} entries in rank order (best/biggest first):

${ratedBlock}

${boxBlock}

These are among the best documented films ever made, so both lists are normally answerable. Fill them.

About the numbers: a rating or a gross is a well-known approximate figure here, not a citation. Ratings drift and gross totals get restated, so the reader expects "about right", and giving your best current figure is the correct behaviour, not a guess. Do NOT withhold an entry, and do NOT leave a list empty, because you cannot pin a number to the decimal.

What honesty means on this task:
- Never invent a FILM. Every title must be a real film from the right year.
- Get the ORDER right. A ranking that puts the wrong film at number one is the failure that shows.
- Leave a list empty ONLY if you genuinely do not know the films for this year, which for a modern year should not happen. Uncertainty about an exact number is not a reason.
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

// Why a year job produced nothing, in words the user can act on. "No usable
// lists" covers three very different failures (the model said nothing, its
// reply was not JSON, or it returned empty arrays) and they need different
// responses, so name which one happened instead of collapsing them.
// `raw` is the model's text, `parsed` the result of parseModelJson on it.
export function yearFailureReason(raw, parsed) {
  if (!String(raw || '').trim()) {
    return 'The AI returned an empty response for that year — try again.';
  }
  if (!parsed || typeof parsed !== 'object') {
    return 'The AI’s reply for that year wasn’t valid JSON, usually a reply that got cut off — try again.';
  }
  const missing = YEAR_LIST_KEYS.filter((k) => !Array.isArray(parsed[k]));
  if (missing.length === YEAR_LIST_KEYS.length) {
    return 'The AI replied in the wrong shape for that year — try again.';
  }
  return 'The AI returned empty lists for that year. Try again, or paste an IMDb list to give it the rated titles.';
}
