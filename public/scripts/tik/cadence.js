// When to post next, and how many days of posts are banked.
//
// Pure — no DOM, no network. Unit-tested under node:test.
//
// The model is a daily WINDOW rather than a rolling clock. Posting at 3am to
// a US audience is not a post, it is a post that gets seen at 9am with eight
// hours of the feed stacked on top of it, so the hours outside the window do
// not count against you and never turn the row red. Inside the window, four
// posts across twelve hours is one every four hours: 9am, 1pm, 5pm, 9pm.

export const WINDOW_START_HOUR = 9;   // local time — 9am
export const WINDOW_END_HOUR = 21;    // local time — 9pm
export const POSTS_PER_DAY = 4;

// Four posts with three gaps between them across a twelve-hour window.
export const SPACING_HOURS = (WINDOW_END_HOUR - WINDOW_START_HOUR) / (POSTS_PER_DAY - 1);

// How far off the ideal slot still counts as "now". Asymmetric on purpose:
// posting an hour early costs the previous post some room, while running two
// hours late only costs you the tail of the window, so the late side is where
// the slack belongs.
export const EARLY_GRACE_HOURS = 1;
export const LATE_GRACE_HOURS = 2;

const HOUR_MS = 3_600_000;

// Each state carries an icon and a word as well as a color. A row that says
// "red" only in red is unreadable to anyone who cannot separate it from the
// amber one, and this row's whole job is to be read at a glance.
export const CADENCE_STATES = {
  fresh: { key: 'fresh', tone: 'green', icon: 'check_circle', label: 'Posted recently' },
  open: { key: 'open', tone: 'amber', icon: 'schedule', label: 'Good time to post' },
  due: { key: 'due', tone: 'red', icon: 'priority_high', label: 'Post now' },
  closed: { key: 'closed', tone: 'blue', icon: 'bedtime', label: 'Outside posting hours' },
  unknown: { key: 'unknown', tone: 'grey', icon: 'help', label: 'Cadence unknown' },
};

// ---- the window ----

const at = (d, hour) => {
  const out = new Date(d);
  out.setHours(hour, 0, 0, 0);
  return out;
};

export function windowOpensOn(now) { return at(now, WINDOW_START_HOUR).getTime(); }
export function windowClosesOn(now) { return at(now, WINDOW_END_HOUR).getTime(); }

// Both ends are inclusive: with four posts across the window the last slot
// lands exactly on the closing hour, so an exclusive end would rule out one of
// the four times you are trying to hit.
export function inWindow(now) {
  const t = new Date(now).getTime();
  return t >= windowOpensOn(now) && t <= windowClosesOn(now);
}

// The next time the window opens. Before this morning's open that is today;
// any time after it, tomorrow.
export function nextWindowOpen(now) {
  const today = windowOpensOn(now);
  if (new Date(now).getTime() < today) return today;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return at(tomorrow, WINDOW_START_HOUR).getTime();
}

// When the next post ideally goes out: one spacing after the last one, but
// never inside the hours nobody is watching. A post at 8pm does not make
// midnight a slot — it makes tomorrow morning one.
export function idealNextPost(lastAt, now) {
  const openToday = windowOpensOn(now);
  const fromLast = Number(lastAt) + SPACING_HOURS * HOUR_MS;
  const ideal = Math.max(fromLast, openToday);
  return ideal > windowClosesOn(now) ? nextWindowOpen(now) : ideal;
}

// ---- the timestamp ----

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

// ---- formatting ----

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

// "1 PM", or "9 AM tomorrow" when it is not the same calendar day.
export function clockLabel(ts, now) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined })
    .replace(':00', '');
  const sameDay = d.toDateString() === new Date(now).toDateString();
  return sameDay ? time : `${time} tomorrow`;
}

// ---- the verdict ----

// Returns { key, tone, icon, label, headline, detail, hours, nextAt }.
//
// `hours` is null when there is nothing to measure, which is a real answer
// (no post history connected) and not a zero.
export function cadence(lastAt, now = Date.now()) {
  const t = Number(lastAt);
  if (!Number.isFinite(t) || t <= 0) {
    return {
      ...CADENCE_STATES.unknown,
      hours: null,
      nextAt: null,
      headline: 'No post history',
      detail: 'Connect post history to track your posting cadence.',
    };
  }
  // A stamp in the future is clock skew or a post TikTok has dated forward.
  // Treat it as this instant rather than as a negative age.
  const elapsed = Math.max(0, now - t);
  const hours = elapsed / HOUR_MS;
  const headline = elapsed < 60_000 ? 'Last post just now' : `Last post ${span(elapsed)} ago`;

  // Outside the window nothing is overdue, however long it has been. This is
  // the whole reason the window exists: an overnight gap is the plan working,
  // not the plan slipping.
  if (!inWindow(now)) {
    const opens = nextWindowOpen(now);
    return {
      ...CADENCE_STATES.closed,
      hours,
      nextAt: opens,
      headline,
      detail: `Resting until ${clockLabel(opens, now)} — ${POSTS_PER_DAY} posts a day, ${WINDOW_START_HOUR % 12 || 12}am to ${WINDOW_END_HOUR % 12 || 12}pm.`,
    };
  }

  const nextAt = idealNextPost(t, now);
  const off = (now - nextAt) / HOUR_MS;   // positive means the slot has passed

  if (off < -EARLY_GRACE_HOURS) {
    return {
      ...CADENCE_STATES.fresh,
      hours,
      nextAt,
      headline,
      detail: `Give it room — next slot around ${clockLabel(nextAt, now)}.`,
    };
  }
  if (off <= LATE_GRACE_HOURS) {
    return {
      ...CADENCE_STATES.open,
      hours,
      nextAt,
      headline,
      detail: `This is the ${clockLabel(nextAt, now)} slot — send one whenever you are ready.`,
    };
  }
  return {
    ...CADENCE_STATES.due,
    hours,
    nextAt,
    headline,
    detail: `${span(now - nextAt)} past the ${clockLabel(nextAt, now)} slot — post one now to hold the cadence.`,
  };
}

// ---- runway ----

// How long the shelf lasts at the target rate. Ready and drafts are counted
// separately because they are not the same asset: Ready is finished work that
// can go out today, and a draft is work that still needs an hour of yours
// before it can. One number merging them would read as more runway than there
// is.
export function runway({ ready = 0, drafts = 0 } = {}) {
  const r = Math.max(0, Number(ready) || 0);
  const d = Math.max(0, Number(drafts) || 0);
  return {
    ready: r,
    drafts: d,
    readyDays: r / POSTS_PER_DAY,
    draftDays: d / POSTS_PER_DAY,
    totalDays: (r + d) / POSTS_PER_DAY,
  };
}

// Days as something you can act on. Under a full day is reported as such
// rather than as "0.8 days", which reads like a measurement of nothing.
export function dayLabel(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return 'none';
  if (n < 1) return 'under a day';
  const rounded = Math.round(n * 10) / 10;
  return `${String(rounded).replace(/\.0$/, '')} ${rounded === 1 ? 'day' : 'days'}`;
}
