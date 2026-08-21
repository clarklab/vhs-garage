// Pure project-model helpers for the studio: format registry, default post
// copy, slide-caption formatting, relative timestamps. No DOM/IDB here —
// unit-tested under node:test like the other pure modules.
import { pickHouseSet, houseSetByKey, buildHashtags, buildDescription } from './hashtags.js';

// How many films per list. The client sends this to the agent, so the number
// in the prompt, on the section cards, and in the captions can never disagree.
export const YEAR_LIST_SIZE = 10;

export const FORMATS = {
  trivia: {
    key: 'trivia',
    label: 'Tape Trivia',
    tagline: 'Deep-cut trivia over frames from the movie',
    icon: 'movie',           // Material Symbols name
    accent: 'amber',         // Tailwind hue used for chips/cards
    chip: 'bg-amber-400/15 text-amber-300',
    editorHint: 'Click a slide’s preview to re-grab its frame, or paste/drop/pick a custom image while it’s selected. Drag to reorder.',
  },
  quotes: {
    key: 'quotes',
    label: 'Quote-a-long',
    tagline: 'Famous lines over the frames they were spoken on',
    icon: 'format_quote',
    accent: 'rose',
    chip: 'bg-rose-400/15 text-rose-300',
    editorHint: 'Click a slide’s preview to re-grab its frame, or paste/drop/pick a custom image while it’s selected. Drag to reorder.',
  },
  guys: {
    key: 'guys',
    label: 'Remembering Some Guys',
    tagline: 'One actor’s most memorable cult roles',
    icon: 'theater_comedy',
    accent: 'cyan',
    chip: 'bg-cyan-400/15 text-cyan-300',
    editorHint: 'Click a slide, then paste, drop, or pick a photo of the guy. Drag to reorder.',
  },
  year: {
    key: 'year',
    label: 'Year Snapshot',
    tagline: `One year’s top ${YEAR_LIST_SIZE} rated and top ${YEAR_LIST_SIZE} grossing`,
    icon: 'calendar_month',
    accent: 'violet',
    chip: 'bg-violet-400/15 text-violet-300',
    editorHint: 'Click a slide, then paste, drop, or pick one image for it — it’s shown whole, so composed artwork lands as you made it. Drag to reorder.',
  },
};

// The ranked lists in a Year Snapshot, in slide order. `key` matches the key
// the agent returns; `heading` is the big line on the section slide's card.
export const YEAR_LISTS = [
  { key: 'rated', label: 'Top rated', heading: `Top ${YEAR_LIST_SIZE} Rated`, search: 'best movies' },
  { key: 'boxoffice', label: 'Box office', heading: `Top ${YEAR_LIST_SIZE} Box Office`, search: 'box office hits' },
];

export function formatOf(project) {
  return FORMATS[project?.format] || FORMATS.trivia;
}

// The three states a post moves through, in order.
//
// 'ready' is the one that earns its keep: a set that is finished and reviewed
// but deliberately not posted yet. Publishing five sets in one afternoon buries
// four of them, so the point of the studio is to build a queue of Ready posts
// and release them on a schedule.
export const STATUSES = [
  { key: 'draft', label: 'Draft', plural: 'Drafts' },
  { key: 'ready', label: 'Ready', plural: 'Ready' },
  { key: 'posted', label: 'Posted', plural: 'Posted' },
];
const STATUS_KEYS = new Set(STATUSES.map((s) => s.key));

// Every record in the library predates 'ready', and a few may carry junk from a
// hand-edited blob, so anything unrecognized reads as a draft rather than
// disappearing from all three filters.
export function statusOf(rec) {
  const s = rec?.status;
  return STATUS_KEYS.has(s) ? s : 'draft';
}

export function statusLabel(rec) {
  const key = statusOf(rec);
  return (STATUSES.find((s) => s.key === key) || STATUSES[0]).label;
}

// Touching the sign-off slide is the last thing that happens in a review — it
// is the bottom of the set — so it is the signal that the whole thing has been
// looked at. One-way on purpose: a draft is promoted, and anything already
// ready or posted stays put, because editing a posted set's outro must not walk
// it backwards into the queue.
export function statusAfterOutroEdit(status) {
  const cur = statusOf({ status });
  return cur === 'draft' ? 'ready' : cur;
}

// The by-hand override, for when the auto-promotion is wrong. Posted is
// terminal: it records something that happened on TikTok, not a label, so a
// click cannot undo it.
export function toggleReady(status) {
  const cur = statusOf({ status });
  if (cur === 'posted') return 'posted';
  return cur === 'ready' ? 'draft' : 'ready';
}

// A fresh project record. Caller supplies id + now so this stays pure.
export function makeProject({ id, format, now }) {
  return {
    id,
    format: FORMATS[format] ? format : 'trivia',
    name: '',
    status: 'draft',           // see STATUSES: 'draft' | 'ready' | 'posted'
    createdAt: now,
    updatedAt: now,
    postedAt: null,
    // Tape Trivia:
    movie: null,               // { title, year, query } parsed from the filename
    titleOn: false,
    titleLine: '',
    // Remembering Some Guys:
    actor: '',
    roles: [],                 // [{ movie, year, role, hook, picked }]
    // Year Snapshot:
    year: null,                // the four-digit year being snapshotted
    minVotes: null,            // IMDb vote floor for the rated list
    imdbPaste: '',             // the user's own IMDb results, when they pasted them
    mojoPaste: '',             // the user's own Box Office Mojo rows, likewise
    snapshot: null,            // { intro, rated[], boxoffice[] } from the agent
    // Post details (editable; regenerated from defaults until postEdited):
    postTitle: '',
    postDesc: '',
    postEdited: false,
    // TikTok meta the writing agent supplies for Tape Trivia: { hook, filmTags,
    // songs }. Kept whole so re-deriving the post copy (syncPostDefaults) does
    // not lose the hook. Songs are picks for the human to search in the TikTok
    // app, since no API mode can attach a specific track — see hashtags.js.
    postMeta: null,
    // Which rotating house hashtag pair shipped, so tagreport.js can tell the
    // lanes apart even if the rotation itself is changed later.
    hashtagSet: null,
    // Persisted by the serializer:
    slides: [],
    thumb: null,
  };
}

// Suggested TikTok post title + description per format.
//
// Tape Trivia takes an optional `meta` from the writing agent ({ hook,
// filmTags }) and an id to rotate the house hashtag pair off; see hashtags.js
// for why the five tags are split the way they are. Called with neither, it
// still returns usable copy, so nothing depends on the agent having answered.
//
// The trivia TITLE FORMAT IS LOAD-BEARING: parsePostedMovie() in
// netlify/functions/lib/queue.mjs reads the film back out of "<Movie> — movie
// trivia …" to know what we have already covered. Reword it and batch mode
// silently starts proposing films we posted last week. queue.test.mjs guards
// this against the real generator.
export function defaultPostFields(format, name = '', { meta = null, projectId = '', houseSetKey = '' } = {}) {
  if (format === 'year') {
    const y = String(name || '').trim();
    const when = y || 'that year';
    return {
      title: y ? `${y} at the movies: the best and the biggest` : 'A year at the movies: the best and the biggest',
      description: [
        `The highest rated and highest grossing movies of ${when}.`,
        `What were you watching in ${when}? Drop it in the comments.`,
        'Save this for your next movie night, and follow VHS Garage for more.',
        '#movietok #boxoffice #vhs #videostore #retromovies',
      ].join(' '),
    };
  }
  if (format === 'guys') {
    const who = name || 'one great character actor';
    return {
      title: `Remembering some guys: ${who}`,
      description: [
        `A loving look back at ${who}'s most memorable roles.`,
        'Which one is your favorite? Drop it in the comments.',
        'Save this for your next movie night, and follow VHS Garage for more.',
        '#rememberingsomeguys #filmtok #cultclassic #characteractor #movietok',
      ].join(' '),
    };
  }
  if (format === 'quotes') {
    const movie = name;
    const houseSet = houseSetByKey(houseSetKey) || pickHouseSet(projectId || movie);
    const hashtags = buildHashtags({ filmTags: meta?.filmTags || [], houseSet });
    return {
      title: movie ? `${movie} — movie quotes` : 'Movie quotes',
      description: buildDescription({ hook: meta?.hook || '', movie, hashtags }),
      hashtags,
      hashtagSet: houseSet.key,
    };
  }
  const movie = name;
  // An explicit key wins (batch mode balances a run of drafts across the sets).
  // Otherwise rotate on the project id, so a draft's tags never change under
  // the user, falling back to the film name when there is no id yet — anything
  // but pinning the whole account to one house set.
  const houseSet = houseSetByKey(houseSetKey) || pickHouseSet(projectId || movie);
  const hashtags = buildHashtags({ filmTags: meta?.filmTags || [], houseSet });
  return {
    title: movie
      ? `${movie} — movie trivia & behind-the-scenes facts`
      : 'Movie trivia & behind-the-scenes facts',
    // The hook carries the searchable keywords (title, year, director, cast)
    // and is barred from spoiling a slide. Without one we keep the old line.
    description: buildDescription({ hook: meta?.hook || '', movie, hashtags }),
    hashtags,
    hashtagSet: houseSet.key,
  };
}

// ---- the sign-off slide ----
//
// The last slide is the only one that asks for anything, so it asks for both
// things that actually grow the account: a share to one specific person, and a
// follow. One canned line every time reads like a footer people learn to skip,
// so there are ten and each project draws one.
//
// The share half names a PERSON rather than saying "share this" — "send it to
// the friend who quotes this constantly" is a specific instruction, and that is
// the one that gets acted on.
const OUTRO_TEMPLATES = [
  (more) => `Send this to the friend who quotes this movie constantly.\nFollow VHS Garage for ${more}.`,
  (more) => `Know someone who still owns this on tape? Send it to them.\nFollow VHS Garage for ${more}.`,
  (more) => `Share this with the one person who will actually care.\nFollow VHS Garage for ${more}.`,
  (more) => `Tag the friend you watched this with.\nFollow VHS Garage for ${more}.`,
  (more) => `Somebody in your phone needs to see this. Send it over.\nFollow VHS Garage for ${more}.`,
  (more) => `Pass this along to a fellow tape head.\nFollow VHS Garage for ${more}.`,
  (more) => `Share it with someone who grew up on this one.\nFollow VHS Garage for ${more}.`,
  (more) => `Send this to whoever you argue about movies with.\nFollow VHS Garage for ${more}.`,
  (more) => `Send this to your friend who rewatches it every year.\nFollow VHS Garage for ${more}.`,
  (more) => `Show this to someone who still misses the video store.\nFollow VHS Garage for ${more}.`,
];

// What "more" means per format, so one pool of templates serves all three.
const OUTRO_MORE = {
  trivia: 'more movie trivia',
  quotes: 'more movie quotes',
  guys: 'more forgotten legends',
  year: 'more trips back',
};

export const OUTRO_COUNT = OUTRO_TEMPLATES.length;

// `r` is a number in [0, 1) — pass one for a deterministic pick (tests), or
// leave it out and get a random line.
export function pickOutro(format, r = Math.random()) {
  const more = OUTRO_MORE[format] || OUTRO_MORE.trivia;
  const n = Number.isFinite(r) ? Math.min(0.999999, Math.max(0, r)) : Math.random();
  return OUTRO_TEMPLATES[Math.floor(n * OUTRO_TEMPLATES.length)](more);
}

// Is this slide the intro rather than a fact?
//
// Sets written from now on mark it (`kind: 'title'`). Sets already in the
// library do not, and they are the ones the user is editing today, so fall
// back to what the intro uniquely looks like: first in a trivia set, with a
// two-line caption (the film name, then the opener). A fact caption is a
// single statement and never carries a newline, which is what makes the
// fallback safe; a slide that has any `kind` at all is trusted outright.
export function isIntroSlide(slide, index, format = 'trivia') {
  if (!slide) return false;
  if (slide.kind) return slide.kind === 'title';
  return format === 'trivia' && index === 0 && /\n/.test(String(slide.caption || ''));
}

// Is this slide the branded sign-off? Same story as isIntroSlide: trust the
// marker when there is one, and otherwise recognize the follow line, which
// every template in the pool ends with and no caption ever contains.
export function isOutroSlide(slide) {
  if (!slide) return false;
  if (slide.kind) return slide.kind === 'outro';
  return /Follow VHS Garage/i.test(String(slide.caption || ''));
}

// A sign-off that is not the one already on the slide.
//
// The outro is canned copy, so "give me another one" is a pool pick, not a
// model call — there is nothing for an LLM to know here. Excluding the current
// line matters because a random pick out of ten silently returns the same line
// about a tenth of the time, and a button that appears to do nothing reads as
// broken. Falls back to a plain pick if the pool holds nothing else.
export function nextOutro(format, current, r = Math.random()) {
  const more = OUTRO_MORE[format] || OUTRO_MORE.trivia;
  const lines = OUTRO_TEMPLATES.map((t) => t(more));
  const others = lines.filter((l) => l !== String(current ?? '').trim());
  const pool = others.length ? others : lines;
  const n = Number.isFinite(r) ? Math.min(0.999999, Math.max(0, r)) : Math.random();
  return pool[Math.floor(n * pool.length)];
}

// Does this project match a search box query?
//
// Every token has to hit something (AND, not OR): typing more words should
// narrow the list, which is what a search box is for. Matching is on the things
// a person would actually type — the name, the film, the actor, the year, the
// post title — plus the format label, so "guys" finds the Some Guys sets.
//
// Substring rather than fuzzy: with a library of tens of items, a fuzzy match
// that surfaces "The Thing" for "gump" is noise, not help.
export function projectSearchText(rec) {
  const fmt = FORMATS[rec?.format] || FORMATS.trivia;
  return [
    rec?.name,
    rec?.movie?.title, rec?.movie?.year, rec?.movie?.query,
    rec?.actor, rec?.year,
    rec?.postTitle,
    fmt.label, fmt.key,
    statusOf(rec),
  ].filter(Boolean).join(' ').toLowerCase();
}

export function matchesSearch(rec, query) {
  const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const hay = projectSearchText(rec);
  return tokens.every((t) => hay.includes(t));
}

// Slide caption for a picked role: "Movie (Year)" heading line + the blurb
// (falling back to the picker hook when the model dropped one).
export function captionForRole(role, blurb = '') {
  const year = role.year ? ` (${role.year})` : '';
  const body = (blurb || role.hook || role.role || '').trim();
  return `${role.movie}${year}${body ? `\n${body}` : ''}`;
}

// Year Snapshot: the lead-in slide that announces each list. Worded exactly as
// it reads on screen, so the section is unmistakable mid-scroll. The count is
// spelled out ("top ten") and derived from YEAR_LIST_SIZE, so changing the list
// length can't leave the slides saying the wrong number.
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
export function numberWord(n) {
  return NUMBER_WORDS[n] || String(n);
}
const SECTION_CAPTIONS = {
  rated: (y, w) => `These are the top ${w} rated movies of ${y}.`,
  boxoffice: (y, w) => `These are the top ${w} box office numbers of ${y}.`,
};
export function sectionCaption(listKey, year, count = YEAR_LIST_SIZE) {
  const fn = SECTION_CAPTIONS[listKey];
  return fn ? fn(year, numberWord(count)) : '';
}

// Year Snapshot slide caption: rank + title, the number line, then the note.
// Any of the three can be missing without leaving a blank line behind.
export function captionForYearEntry(entry) {
  if (!entry?.title) return '';
  const head = `#${entry.rank || 1} ${entry.title}`;
  return [head, (entry.value || '').trim(), (entry.note || '').trim()].filter(Boolean).join('\n');
}

// Re-rank a Year Snapshot's entry slides from their positions. Run after any
// insert, delete, or drag so the "#4" printed on a slide always matches where
// it actually sits — otherwise slipping a missed film into the middle leaves
// every number below it lying.
//
// Position is the authority, not the stored rank: an entry dragged under a
// different section slide is adopted by that section. Only the "#N" token at
// the head of the caption is rewritten, so hand-edited wording survives.
export function renumberYearEntries(slides) {
  let list = null;
  let n = 0;
  return (slides || []).map((s) => {
    if (s?.kind === 'section') { list = s.section || null; n = 0; return s; }
    // The opener and the outro bracket the lists; neither sits inside one.
    if (s?.kind === 'title' || s?.kind === 'outro') { list = null; n = 0; return s; }
    if (!s?.entry) return s;
    n += 1;
    const rank = n;
    const entryList = list || s.entry.list || null;
    if (s.entry.rank === rank && s.entry.list === entryList) return s;
    const caption = typeof s.caption === 'string' && /^#\d+(?=\s|$)/.test(s.caption)
      ? s.caption.replace(/^#\d+/, `#${rank}`)
      : s.caption;
    return { ...s, caption, entry: { ...s.entry, rank, list: entryList } };
  });
}

// The Google Images query for a slide, or '' when the slide has no subject
// worth searching (the outro). Both bring-your-own-image formats lean on this:
// one click out to find artwork, one paste back in.
export function photoQueryFor(project, slide) {
  if (!project || !slide) return '';
  if (project.format === 'guys') {
    if (slide.role) return [project.actor, slide.role.movie].filter(Boolean).join(' ').trim();
    return slide.kind === 'title' ? String(project.actor || '').trim() : '';
  }
  if (project.format === 'year') {
    const y = project.year ? String(project.year) : '';
    if (slide.entry?.title) return [slide.entry.title, y, 'movie poster'].filter(Boolean).join(' ');
    if (slide.kind === 'title') return [y, 'movie posters'].filter(Boolean).join(' ').trim();
    if (slide.kind === 'section') {
      const list = YEAR_LISTS.find((l) => l.key === slide.section);
      return [y, list?.search || 'movies'].filter(Boolean).join(' ').trim();
    }
  }
  return '';
}

// Compact "how long ago" for library cards. Pass `now` for testability.
export function relativeTime(ts, now) {
  const diff = Math.max(0, now - ts);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function projectDisplayName(p) {
  return (p?.name || '').trim() || 'Untitled';
}
