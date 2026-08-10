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

// A fresh project record. Caller supplies id + now so this stays pure.
export function makeProject({ id, format, now }) {
  return {
    id,
    format: FORMATS[format] ? format : 'trivia',
    name: '',
    status: 'draft',           // 'draft' | 'posted'
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
