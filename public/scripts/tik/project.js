// Pure project-model helpers for the studio: format registry, default post
// copy, slide-caption formatting, relative timestamps. No DOM/IDB here —
// unit-tested under node:test like the other pure modules.

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
    tagline: 'One year’s top eight rated, grossing, and rented',
    icon: 'calendar_month',
    accent: 'violet',
    chip: 'bg-violet-400/15 text-violet-300',
    editorHint: 'Click a slide, then paste, drop, or pick the poster. Every slide has a one-click image search. Drag to reorder.',
  },
};

// The ranked lists in a Year Snapshot, in slide order. `key` matches the key
// the agent returns; `heading` is the big line on the section slide's card.
export const YEAR_LISTS = [
  { key: 'rated', label: 'Top rated', heading: 'Top 8 Rated', search: 'best movies' },
  { key: 'boxoffice', label: 'Box office', heading: 'Top 8 Box Office', search: 'box office hits' },
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
    snapshot: null,            // { intro, rated[], boxoffice[] } from the agent
    // Post details (editable; regenerated from defaults until postEdited):
    postTitle: '',
    postDesc: '',
    postEdited: false,
    // Persisted by the serializer:
    slides: [],
    thumb: null,
  };
}

// Suggested TikTok post title + description per format. TikTok effectively
// honors ~5 hashtags — keep them broad, skip niche tags.
export function defaultPostFields(format, name = '') {
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
  return {
    title: movie
      ? `${movie} — movie trivia & behind-the-scenes facts`
      : 'Movie trivia & behind-the-scenes facts',
    description: [
      movie
        ? `Behind-the-scenes facts and hidden details from ${movie}.`
        : 'Behind-the-scenes movie facts and hidden details.',
      // Main ask: viewers love dropping quotes/one-liners, so ask for them outright.
      'What’s your favorite quote from the movie? Drop it in the comments.',
      'Save this for your next movie night, and follow VHS Garage for more.',
      '#movietrivia #moviefacts #behindthescenes #movietok #moviequotes',
    ].join(' '),
  };
}

// Slide caption for a picked role: "Movie (Year)" heading line + the blurb
// (falling back to the picker hook when the model dropped one).
export function captionForRole(role, blurb = '') {
  const year = role.year ? ` (${role.year})` : '';
  const body = (blurb || role.hook || role.role || '').trim();
  return `${role.movie}${year}${body ? `\n${body}` : ''}`;
}

// Year Snapshot: the lead-in slide that announces each top-eight list. Worded
// exactly as it reads on screen, so the section is unmistakable mid-scroll.
const SECTION_CAPTIONS = {
  rated: (y) => `These are the top eight rated movies of ${y}.`,
  boxoffice: (y) => `These are the top eight box office numbers of ${y}.`,
};
export function sectionCaption(listKey, year) {
  const fn = SECTION_CAPTIONS[listKey];
  return fn ? fn(year) : '';
}

// Year Snapshot slide caption: rank + title, the number line, then the note.
// Any of the three can be missing without leaving a blank line behind.
export function captionForYearEntry(entry) {
  if (!entry?.title) return '';
  const head = `#${entry.rank || 1} ${entry.title}`;
  return [head, (entry.value || '').trim(), (entry.note || '').trim()].filter(Boolean).join('\n');
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
