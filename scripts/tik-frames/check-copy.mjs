// The check on hand-written copy for a new Tape Trivia set (see COPY.md).
//
// When Claude Code writes the title slide's line, the sign-off, the post title,
// the description and the hashtags itself, nothing in the app has shaped them.
// This holds them to what the app and TikTok depend on:
//   - the post must read back as the film, or the queue will suggest it again
//     (TikTok's history hands the DESCRIPTION back as the post's title, so both
//     the title and the opening of the description have to parse);
//   - TikTok's length limits, counted the way TikTok counts them;
//   - the tag count the account posts with;
//   - the words the app knows a sign-off slide by;
//   - and none of the house lines the hand-writing is there to replace.
//
// Pure: checkCopy() returns a list of problems, empty when the copy is good.
//   node check-copy.mjs   reads {title, year, copy} as JSON on stdin, prints the
//   problems one per line and exits 1 if there are any.
import { parsePostedMovie, movieKey, parseHashtags } from '../../netlify/functions/lib/queue.mjs';
import { TITLE_MAX, DESC_MAX } from '../../netlify/functions/lib/tiktok-payload.mjs';
import { TAGS_PER_POST } from '../../public/scripts/tik/hashtags.js';
import { pickOutro, OUTRO_COUNT } from '../../public/scripts/tik/project.js';

export const SLIDE_MAX = 300;      // a caption the slide can still set at a readable size
export const OUTRO_MAX = 220;
export const TAGS_MIN = 3;
const HISTORY_TITLE_CHARS = 200;   // how much of the description TikTok returns as the title

const DASH = /[—–]/;
const plain = (v) => String(v ?? '').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

// The share half of every canned sign-off, read out of the app so a new
// template there is stale here too.
const CANNED_SHARES = Array.from({ length: OUTRO_COUNT }, (_, i) => plain(pickOutro('trivia', (i + 0.5) / OUTRO_COUNT).split('\n')[0]));
const STALE = {
  intro: [/\bline\b[^.?!]*\byou\b[^.?!]*\b(?:still|quote)/i],
  outro: [/for more movie trivia/i, (s) => CANNED_SHARES.some((c) => plain(s).includes(c))],
  postDesc: [/favorite quote from the movie/i, /for more movie trivia/i, /hidden details from/i],
  postTitle: [/movie trivia & behind-the-scenes facts/i],
};
const isStale = (field, text) => (STALE[field] || []).some((t) => (typeof t === 'function' ? t(text) : t.test(plain(text))));

export function checkCopy({ title, year, copy } = {}) {
  const problems = [];
  const film = `${String(title || '').trim()} (${year})`;
  const key = movieKey(title);
  const c = copy || {};
  const text = (k) => String(c[k] ?? '').trim();

  for (const k of ['intro', 'outro', 'postTitle', 'postDesc']) {
    if (!text(k)) { problems.push(`${k} is empty`); continue; }
    if (DASH.test(text(k))) problems.push(`${k} has an em or en dash (the account's copy never uses them)`);
    if (isStale(k, text(k))) problems.push(`${k} reuses a stale house line; write a fresh one for this film`);
  }

  if (text('intro') && `${film}\n${text('intro')}`.length > SLIDE_MAX) problems.push(`intro: the title slide runs past ${SLIDE_MAX} characters`);
  if (text('outro')) {
    if (text('outro').length > OUTRO_MAX) problems.push(`outro runs past ${OUTRO_MAX} characters`);
    if (!/follow vhs garage/i.test(text('outro'))) problems.push('outro must say "follow VHS Garage"; the app knows a sign-off slide by those words');
  }

  // String.length is UTF-16 code units, which is what TikTok counts.
  if (text('postTitle').length > TITLE_MAX) problems.push(`postTitle is ${text('postTitle').length} units, TikTok cuts it at ${TITLE_MAX}`);
  if (text('postDesc').length > DESC_MAX) problems.push(`postDesc is ${text('postDesc').length} units, TikTok cuts it at ${DESC_MAX}`);

  const readsBack = (asTitle) => movieKey(parsePostedMovie(asTitle, text('postDesc')) || '') === key;
  if (text('postTitle') && !readsBack(text('postTitle'))) {
    problems.push(`postTitle does not read back as the film (got ${JSON.stringify(parsePostedMovie(text('postTitle'), text('postDesc')))}); open it on "${film}"`);
  }
  if (text('postDesc') && !readsBack(text('postDesc').slice(0, HISTORY_TITLE_CHARS))) {
    problems.push(`postDesc does not read back as the film (got ${JSON.stringify(parsePostedMovie(text('postDesc').slice(0, HISTORY_TITLE_CHARS), text('postDesc')))}); open it on "${film}", because TikTok returns the description as the post's title`);
  }

  if (text('postDesc')) {
    const tags = parseHashtags(text('postDesc'));
    if (tags.length < TAGS_MIN || tags.length > TAGS_PER_POST) problems.push(`hashtags: ${tags.length} in postDesc, the account posts with ${TAGS_MIN} to ${TAGS_PER_POST}`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let problems;
    try { problems = checkCopy(JSON.parse(raw)); } catch (e) { console.error('[tik-frames] check-copy could not read its input', e); process.exit(2); }
    for (const p of problems) console.log(p);
    process.exit(problems.length ? 1 : 0);
  });
}
