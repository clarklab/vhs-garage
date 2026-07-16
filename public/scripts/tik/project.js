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
  },
  guys: {
    key: 'guys',
    label: 'Remembering Some Guys',
    tagline: 'One actor’s most memorable cult roles',
    icon: 'theater_comedy',
    accent: 'cyan',
  },
};

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
