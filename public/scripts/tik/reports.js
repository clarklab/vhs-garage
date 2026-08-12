// The Reports screen — fetch, assign, and nothing else.
//
// Self-contained the way batch.js is: it owns every id under #screen-reports
// and app.js knows only how to show the screen. All the arithmetic lives in
// postmetrics.js and all the markup in postreport.js, both pure and both
// unit-tested, so what is left here is genuinely just plumbing.
//
// The fetch is shared with the home screen's hashtag panel through
// loadPosts(): both used to page video/list separately, which is ten TikTok
// API calls each, twice, on a single visit to the home screen.

import { getRefreshToken, isSignedIn, clearLocalToken, connectHistory } from './auth.js';
import {
  enrichPosts, accountSummary, leaderboard, momentum, byDuration, byWeekday, byHour, tagRows,
} from './postmetrics.js';
import {
  accountHtml, leaderboardHtml, momentumHtml, durationHtml, weekdayHtml, hourHtml,
} from './postreport.js';
import { tagReport, tagReportHtml } from './tagreport.js';
// Follower/following/likes totals come from user/info, which is a different
// endpoint and a different scope from video/list — so the account panel needs
// both calls. They are independent, so they run together.
import { fetchFollowerStats } from './stats.js';

const $ = (id) => document.getElementById(id);
const FETCH_TIMEOUT_MS = 30_000;
// Paging 200 posts is not a cheap call and the numbers move on TikTok's
// schedule, not ours. Long enough that bouncing between screens is free.
const TTL_MS = 10 * 60 * 1000;

let els = null;
let exitTo = () => {};
let onScopeChange = () => {};

// The shared cache. `at` is stamped on every outcome including failures, so a
// broken state backs off instead of retrying on every render.
let cache = { at: 0, data: null };
let inflight = null;

export function resetPostsCache() {
  cache = { at: 0, data: null };
  inflight = null;
}

// One fetch, shared by this screen and the home screen's hashtag panel.
//
// GET when signed out: the stored snapshot history is our own public numbers
// and needs no token, so the report still renders something useful before the
// video.list grant ever happens.
export async function loadPosts({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight;

  const signedIn = isSignedIn();
  const init = signedIn
    ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: getRefreshToken() }),
    }
    : { method: 'GET' };

  inflight = (async () => {
    try {
      const res = await fetch('/.netlify/functions/tik-posts', {
        ...init,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data?.reauth) {
        clearLocalToken();
        throw Object.assign(new Error(data.error || 'Sign in again'), { reauth: true });
      }
      if (!res.ok) throw new Error(data?.error || `Reports unavailable (${res.status})`);
      cache = { at: Date.now(), data };
      return data;
    } catch (e) {
      // Stamp the failure too, so a signed-in user without the scope does not
      // re-run ten TikTok calls on every home render.
      cache = { at: Date.now(), data: null };
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        throw new Error('TikTok did not answer in time — try Refresh.');
      }
      throw e;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function initReports({ onExit = () => {}, onScope = () => {} } = {}) {
  exitTo = onExit;
  onScopeChange = onScope;
  els = {
    screen: $('screen-reports'), back: $('reports-back'), refresh: $('reports-refresh'),
    status: $('reports-status'), panels: $('reports-panels'),
    account: $('rep-account'),
    momentum: $('rep-momentum'), momentumNote: $('rep-momentum-note'),
    leaders: $('rep-leaders'), leadersNote: $('rep-leaders-note'),
    tags: $('rep-tags'), tagsNote: $('rep-tags-note'),
    length: $('rep-length'), lengthNote: $('rep-length-note'),
    weekday: $('rep-weekday'), weekdayNote: $('rep-weekday-note'),
    hour: $('rep-hour'), hourNote: $('rep-hour-note'),
  };
  els.back.addEventListener('click', () => exitTo());
  els.refresh.addEventListener('click', () => render({ force: true }));
}

export async function showReports() {
  els.screen.classList.remove('hidden');
  await render();
}

function say(message, { tone = 'neutral' } = {}) {
  els.status.classList.remove('hidden');
  els.status.className = `rounded-xl border px-4 py-3 text-xs leading-relaxed ${
    tone === 'warn'
      ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
      : 'border-neutral-800 bg-neutral-900 text-neutral-400'
  }`;
  els.status.textContent = message;
}

async function render({ force = false } = {}) {
  say('Reading your post history…');

  // The account totals are a nice-to-have on this screen; the post history is
  // the screen. A failed or missing profile fetch must not blank the report,
  // so it resolves to null rather than rejecting.
  const profilePromise = fetchFollowerStats()
    .then((s) => s?.profile || null)
    .catch((e) => {
      console.warn('[tik] reports could not read account totals', { message: e.message });
      return null;
    });

  let data;
  try {
    data = await loadPosts({ force });
  } catch (e) {
    console.error('[tik] reports failed:', e);
    els.panels.classList.add('hidden');
    say(e.reauth
      ? 'Your TikTok session expired. Sign in again from the top of the page, then reopen this screen.'
      : `Could not load reports. ${e.message}`, { tone: 'warn' });
    return;
  }

  const posts = enrichPosts(data.posts || []);
  const snapshotDays = Number(data.snapshotDays) || 0;
  onScopeChange(data.scope);

  // No scope AND no stored history is the only genuinely empty case. With
  // history we render it and just say it is not fresh.
  if (!posts.length) {
    els.panels.classList.add('hidden');
    say(data.scope === 'missing' || data.scope === 'stored'
      ? 'No post history yet. Use “Connect post history” on the home screen to grant TikTok’s video.list permission — until then this screen has nothing to read.'
      : 'TikTok returned no posts for this account.', { tone: 'warn' });
    return;
  }

  if (data.scope === 'missing') {
    say('Showing stored history only — TikTok has not granted video.list to this session, so these numbers are not being refreshed. Use “Connect post history” on the home screen.', { tone: 'warn' });
  } else if (data.scope === 'stored') {
    say('Showing stored history. Sign in to refresh these numbers.');
  } else if (data.persisted === false) {
    say('These numbers are live, but today’s snapshot could not be saved — velocity may skip a day.', { tone: 'warn' });
  } else {
    els.status.classList.add('hidden');
  }

  els.panels.classList.remove('hidden');

  els.account.innerHTML = accountHtml(accountSummary(posts, await profilePromise), { snapshotDays });

  const mom = momentumHtml(momentum(posts), { snapshotDays });
  els.momentumNote.textContent = mom.note;
  els.momentum.innerHTML = mom.body;

  const top = leaderboardHtml(leaderboard(posts, { limit: 12 }));
  els.leadersNote.textContent = top.note;
  els.leaders.innerHTML = top.body;

  // Age-adjusted: lifetime totals would make this partly a ranking of which
  // tags we happened to use first.
  const tags = tagReportHtml(tagReport(tagRows(posts), { basis: 'daily' }));
  els.tagsNote.textContent = tags.note;
  els.tags.innerHTML = tags.body;

  for (const [key, report] of [
    ['length', durationHtml(byDuration(posts))],
    ['weekday', weekdayHtml(byWeekday(posts))],
    ['hour', hourHtml(byHour(posts))],
  ]) {
    els[`${key}Note`].textContent = report.note;
    els[key].innerHTML = report.body;
  }
}

export { connectHistory };
