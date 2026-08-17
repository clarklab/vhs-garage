// How long since the last post, and whether that means hold, go, or go now.
//
// Pure — no DOM, no network. Unit-tested under node:test.
//
// The thresholds come from how a post opens: TikTok tests each one against a
// small audience before widening it, so two posts close together are handed the
// same slice and split it instead of each getting their own. Three a day spaced
// evenly is eight hours apart, and these numbers put a window around that
// rather than a single instant, because nobody posts on a metronome.

export const FRESH_HOURS = 4;   // under this, a second post competes with the first
export const DUE_HOURS = 10;    // over this, the day's cadence has slipped

const HOUR_MS = 3_600_000;

// Each state carries an icon and a word as well as a color. A row that says
// "red" only in red is unreadable to anyone who cannot separate it from the
// amber one, and this row's whole job is to be read at a glance.
export const CADENCE_STATES = {
  fresh: { key: 'fresh', tone: 'green', icon: 'check_circle', label: 'Posted recently' },
  open: { key: 'open', tone: 'amber', icon: 'schedule', label: 'Good time to post' },
  due: { key: 'due', tone: 'red', icon: 'priority_high', label: 'Post now' },
  unknown: { key: 'unknown', tone: 'grey', icon: 'help', label: 'Cadence unknown' },
};

// The most recent post, from whichever source saw it.
//
// TikTok's own history is the record that counts: most sets are finished by
// hand in the app, and the studio never hears about those. The library's
// postedAt only covers sets posted through the API from here, but it can be
// AHEAD of the history while TikTok is still processing the upload, so take
// whichever is later.
//
// The asymmetry is deliberate. Reporting a post a few minutes late is
// harmless; reporting one late enough to turn the row red tells you to post
// when you just did, which is the one error that costs a post its audience.
//
// `posts` are TikTok rows (`created` in SECONDS, as the Display API sends it);
// `projects` are library records (`postedAt` in milliseconds).
export function lastPostAt({ posts = [], projects = [] } = {}) {
  // Tracked in a loop rather than Math.max(...stamps): a long history spread
  // into arguments is how that call blows the stack.
  let latest = null;
  const keep = (ms) => { if (Number.isFinite(ms) && ms > 0 && (latest === null || ms > latest)) latest = ms; };
  for (const p of Array.isArray(posts) ? posts : []) keep(Number(p?.created) * 1000);
  for (const p of Array.isArray(projects) ? projects : []) keep(Number(p?.postedAt));
  return latest;
}

// Round to a whole hour, or to minutes under one hour. "5h" and "40m" are both
// answers you can act on; "5.4h" is a number pretending to be a measurement.
function span(ms) {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

// Returns { key, tone, icon, label, headline, detail, hours }.
//
// `hours` is null when there is nothing to measure, which is a real answer
// (no post history connected) and not a zero.
export function cadence(lastAt, now = Date.now()) {
  const t = Number(lastAt);
  if (!Number.isFinite(t) || t <= 0) {
    return {
      ...CADENCE_STATES.unknown,
      hours: null,
      headline: 'No post history',
      detail: 'Connect post history to track your posting cadence.',
    };
  }
  // A stamp in the future is clock skew or a post TikTok has dated forward.
  // Treat it as this instant rather than as a negative age.
  const elapsed = Math.max(0, now - t);
  const hours = elapsed / HOUR_MS;
  const since = span(elapsed);
  const headline = elapsed < 60_000 ? 'Last post just now' : `Last post ${since} ago`;

  if (hours < FRESH_HOURS) {
    return {
      ...CADENCE_STATES.fresh,
      hours,
      headline,
      detail: `Give it room — next one in about ${span((FRESH_HOURS - hours) * HOUR_MS)}.`,
    };
  }
  if (hours < DUE_HOURS) {
    return {
      ...CADENCE_STATES.open,
      hours,
      headline,
      detail: 'A new post is clear to go whenever you are.',
    };
  }
  return {
    ...CADENCE_STATES.due,
    hours,
    headline,
    detail: `Past the ${DUE_HOURS}h mark — post one now to hold the cadence.`,
  };
}
