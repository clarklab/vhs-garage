// Building a Tape Trivia post's hashtags and description.
//
// Every trivia post used to ship the same five tags, which had two costs. We
// never appeared in the searches most likely to find us (a post about The Thing
// carried no #thething), and because nothing ever varied, our own post history
// held zero signal about which tags actually work.
//
// So a post's five tags come from three places: up to three film-specific tags
// the writing agent returns, and a two-tag "house set" rotated deterministically
// off the project id. The house set's name is stored on the project, and
// tagreport.js reads the shipped tags back out of our post history to see which
// sets earn their slot.
//
// Five is the whole budget on purpose. TikTok treats hashtags as a
// categorization and search signal rather than a distribution lever, and a
// wall of tags dilutes the two or three that could actually rank.
//
// Pure — no DOM, no network. Unit-tested under node:test.

export const TAGS_PER_POST = 5;
export const FILM_TAG_MAX = 3;   // slots reserved for the agent's film tags
const TAG_MIN_LEN = 2;
const TAG_MAX_LEN = 30;

// The rotating pair. Each set is a lane we could plausibly own; the report tells
// us which ones pay. Tags must be unique across sets, or a post could count
// toward two lanes and make both unreadable.
export const HOUSE_SETS = [
  { key: 'trivia', label: 'Trivia', tags: ['movietrivia', 'moviefacts'] },
  { key: 'filmtok', label: 'Film TikTok', tags: ['filmtok', 'movietok'] },
  { key: 'retro', label: 'Retro / VHS', tags: ['vhs', 'videostore'] },
  { key: 'bts', label: 'Behind the scenes', tags: ['behindthescenes', 'filmmaking'] },
  { key: 'cult', label: 'Cult', tags: ['cultclassic', 'movienight'] },
];

// Used only to top up to five when the agent returns few or no film tags — a
// three-tag post would otherwise quietly under-use the budget.
//
// MUST stay disjoint from every house set. A filler that reused a house tag
// would attach it to posts from other lanes and quietly corrupt the very
// measurement the rotation exists to produce. `FILLER_TAGS` is asserted
// disjoint in hashtags.test.mjs so this cannot drift.
export const FILLER_TAGS = ['moviebuff', 'filmnerd', 'cinephile', 'retromovies', 'classicmovies'];

export function houseSetByKey(key) {
  return HOUSE_SETS.find((s) => s.key === key) || null;
}

// Round-robin for callers writing a run of drafts at once (batch mode). Hashing
// random ids spreads evenly in the long run but not inside one batch of ten,
// where it can easily land four in one set and none in another — and an
// unbalanced experiment takes far longer to tell you anything.
export function houseSetAt(index) {
  const i = Number.isFinite(Number(index)) ? Math.abs(Math.trunc(Number(index))) : 0;
  return HOUSE_SETS[i % HOUSE_SETS.length];
}

// djb2. Any stable string hash works; what matters is that a given project
// always lands on the same set (so reopening a draft can't reshuffle its tags)
// while the account still spreads across all five.
function hashString(s) {
  let h = 5381;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h;
}

export function pickHouseSet(projectId) {
  return HOUSE_SETS[hashString(projectId) % HOUSE_SETS.length];
}

// A model asked for tags will eventually return "#The Thing (1982)", an emoji,
// or a null. Nothing that survives this is capable of shipping a broken tag.
export function sanitizeTags(list, { exclude = [], max = Infinity } = {}) {
  if (!Array.isArray(list)) return [];
  const blocked = new Set(
    (Array.isArray(exclude) ? exclude : [])
      .map((t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')),
  );
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const tag = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (tag.length < TAG_MIN_LEN || tag.length > TAG_MAX_LEN) continue;
    if (seen.has(tag) || blocked.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

// The five that ship: film tags first (they carry the intent), house pair last.
export function buildHashtags({ filmTags = [], houseSet = null } = {}) {
  const set = houseSet && Array.isArray(houseSet.tags) ? houseSet : HOUSE_SETS[0];
  const house = sanitizeTags(set.tags);
  const film = sanitizeTags(filmTags, { exclude: house, max: FILM_TAG_MAX });
  const tags = [...film, ...house];
  // A film with only one usable tag would otherwise ship three. Top up from the
  // filler pool rather than leaving the budget on the table.
  //
  // Start at a different point per house set: always filling from the head
  // would staple one tag to every short post, turning a measured slot into a
  // constant that tells us nothing.
  if (tags.length < TAGS_PER_POST) {
    const offset = Math.max(0, HOUSE_SETS.indexOf(set));
    for (let i = 0; i < FILLER_TAGS.length && tags.length < TAGS_PER_POST; i++) {
      const t = FILLER_TAGS[(offset + i) % FILLER_TAGS.length];
      if (!tags.includes(t)) tags.push(t);
    }
  }
  return tags.slice(0, TAGS_PER_POST);
}

export function formatHashtags(tags) {
  return (Array.isArray(tags) ? tags : []).map((t) => `#${t}`).join(' ');
}

// The post body. Line one is the agent's hook, which is where the searchable
// keywords live (title, year, director, cast) and which is explicitly forbidden
// from spoiling a fact that appears on a slide. The rest is house template.
export function buildDescription({ hook = '', movie = '', hashtags = [] } = {}) {
  const film = String(movie || '').trim();
  const lead = String(hook || '').trim()
    || (film
      ? `Behind-the-scenes facts and hidden details from ${film}.`
      : 'Behind-the-scenes movie facts and hidden details.');
  return [
    lead,
    'What’s your favorite quote from the movie? Drop it in the comments.',
    'Follow VHS Garage for more movie trivia.',
    formatHashtags(hashtags),
  ].filter(Boolean).join('\n');
}
