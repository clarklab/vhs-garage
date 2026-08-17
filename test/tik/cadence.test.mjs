import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cadence, lastPostAt, runway, dayLabel, inWindow, nextWindowOpen, idealNextPost, clockLabel,
  CADENCE_STATES, WINDOW_START_HOUR, WINDOW_END_HOUR, POSTS_PER_DAY, SPACING_HOURS,
  EARLY_GRACE_HOURS, LATE_GRACE_HOURS,
} from '../../public/scripts/tik/cadence.js';

// Local-time constructors on purpose: the window is defined in the viewer's
// own clock, so these have to be built the same way to test it in any zone.
const on = (day, h, m = 0) => new Date(2026, 7, day, h, m, 0, 0).getTime();
const HOUR = 3_600_000;

// ---- the window ----

test('the window is a daytime block with room for the target rate', () => {
  assert.ok(WINDOW_START_HOUR < WINDOW_END_HOUR);
  assert.ok(POSTS_PER_DAY >= 3 && POSTS_PER_DAY <= 6, 'that is not a daily cadence');
  const width = WINDOW_END_HOUR - WINDOW_START_HOUR;
  assert.equal(SPACING_HOURS, width / (POSTS_PER_DAY - 1));
  assert.ok(SPACING_HOURS >= 2, 'posts this close split one audience test');
});

test('inWindow covers the open hours and nothing else', () => {
  assert.ok(!inWindow(on(17, WINDOW_START_HOUR - 1)));
  assert.ok(inWindow(on(17, WINDOW_START_HOUR)));          // inclusive at open
  assert.ok(inWindow(on(17, WINDOW_END_HOUR - 1)));
  assert.ok(inWindow(on(17, WINDOW_END_HOUR)));            // the last slot IS the closing hour
  assert.ok(!inWindow(on(17, WINDOW_END_HOUR, 1)));        // a minute past it is not
  assert.ok(!inWindow(on(17, 3)));                         // the middle of the night
});

test('nextWindowOpen is today before it opens and tomorrow after', () => {
  assert.equal(nextWindowOpen(on(17, 6)), on(17, WINDOW_START_HOUR));
  assert.equal(nextWindowOpen(on(17, 14)), on(18, WINDOW_START_HOUR));
  assert.equal(nextWindowOpen(on(17, 23)), on(18, WINDOW_START_HOUR));
});

test('nextWindowOpen rolls the month, not just the day', () => {
  const lastDay = new Date(2026, 7, 31, 22).getTime();
  const next = new Date(nextWindowOpen(lastDay));
  assert.equal(next.getMonth(), 8, 'did not roll into September');
  assert.equal(next.getDate(), 1);
  assert.equal(next.getHours(), WINDOW_START_HOUR);
});

// ---- when the next post is due ----

test('the ideal next post is one spacing after the last', () => {
  const last = on(17, WINDOW_START_HOUR + 1);
  assert.equal(idealNextPost(last, on(17, WINDOW_START_HOUR + 2)), last + SPACING_HOURS * HOUR);
});

test('a late post does not schedule the next one for the middle of the night', () => {
  // The whole point: 8pm + 4h is midnight, which is not a slot.
  const last = on(17, WINDOW_END_HOUR - 1);
  const ideal = idealNextPost(last, on(17, WINDOW_END_HOUR - 1) + 30 * 60_000);
  assert.equal(ideal, on(18, WINDOW_START_HOUR), 'next slot should be tomorrow morning');
});

test('after an overnight gap the next slot is when the window opens', () => {
  const last = on(16, WINDOW_END_HOUR - 1);              // yesterday evening
  assert.equal(idealNextPost(last, on(17, WINDOW_START_HOUR)), on(17, WINDOW_START_HOUR));
  // Same answer after a week away — it never points at a time already gone.
  assert.equal(idealNextPost(on(10, 12), on(17, WINDOW_START_HOUR)), on(17, WINDOW_START_HOUR));
});

// ---- the four states ----

test('nothing is overdue outside the window, however long it has been', () => {
  // This is the reason the window exists. An overnight gap is the plan
  // working, not the plan slipping, and 3am is never a reason to post.
  // Derived from the constants, not hardcoded hours: widening the window is a
  // one-line change and this test has to keep testing the right side of it.
  const shut = [
    [17, 1, 0], [17, 4, 0],                       // the small hours
    [17, WINDOW_START_HOUR - 1, 0],               // just before it opens
    [17, WINDOW_END_HOUR, 1],                     // one minute past the last slot
    [18, 0, 0],                                   // over midnight
  ];
  for (const [day, hour, min] of shut) {
    const c = cadence(on(16, 12), on(day, hour, min));
    assert.equal(c.key, 'closed', `${day}@${hour}:${String(min).padStart(2, '0')} said ${c.key}`);
    assert.match(c.detail, /resting until/i);
  }
});

test('a fresh post holds, and says when the next slot is', () => {
  const last = on(17, WINDOW_START_HOUR);
  const c = cadence(last, on(17, WINDOW_START_HOUR + 1));
  assert.equal(c.key, 'fresh');
  assert.equal(c.nextAt, last + SPACING_HOURS * HOUR);
  assert.match(c.detail, /next slot around/i);
});

test('the slot opens early and closes late by the stated grace', () => {
  const last = on(17, WINDOW_START_HOUR);
  const ideal = last + SPACING_HOURS * HOUR;
  const justBefore = ideal - (EARLY_GRACE_HOURS * HOUR + 60_000);
  const justInside = ideal - (EARLY_GRACE_HOURS * HOUR - 60_000);
  assert.equal(cadence(last, justBefore).key, 'fresh');
  assert.equal(cadence(last, justInside).key, 'open');
  assert.equal(cadence(last, ideal).key, 'open');
  assert.equal(cadence(last, ideal + LATE_GRACE_HOURS * HOUR).key, 'open');
  assert.equal(cadence(last, ideal + LATE_GRACE_HOURS * HOUR + 60_000).key, 'due');
});

test('overdue inside the window says how late and against which slot', () => {
  const last = on(17, WINDOW_START_HOUR);
  const c = cadence(last, on(17, WINDOW_END_HOUR - 1));
  assert.equal(c.key, 'due');
  assert.match(c.detail, /past the/i);
  assert.match(c.detail, /post one now/i);
});

test('a full day untouched is due the moment the window opens, not before', () => {
  const last = on(16, 12);
  assert.equal(cadence(last, on(17, WINDOW_START_HOUR - 1)).key, 'closed');
  // At open the morning slot is live — worth posting, not yet an emergency.
  assert.equal(cadence(last, on(17, WINDOW_START_HOUR)).key, 'open');
  // Still nothing by mid-afternoon and it is genuinely behind.
  assert.equal(cadence(last, on(17, WINDOW_START_HOUR + 4)).key, 'due');
});

test('a day of posting on time never turns red', () => {
  // Walk the four slots and confirm each one lands green-or-amber, never due.
  let last = on(17, WINDOW_START_HOUR);
  for (let i = 1; i < POSTS_PER_DAY; i++) {
    const slot = on(17, WINDOW_START_HOUR) + i * SPACING_HOURS * HOUR;
    const c = cadence(last, slot);
    assert.equal(c.key, 'open', `slot ${i} said ${c.key}`);
    last = slot;
  }
});

test('each state carries a word and an icon, not just a color', () => {
  for (const st of Object.values(CADENCE_STATES)) {
    assert.ok(st.label && st.icon && st.tone, `${st.key} is under-described`);
  }
  const tones = Object.values(CADENCE_STATES).map((s) => s.tone);
  assert.equal(new Set(tones).size, tones.length, 'two states share a tone');
});

test('no history is a real answer, not a zero-hour-old post', () => {
  for (const bad of [null, undefined, 0, -1, NaN, '', 'nope']) {
    const c = cadence(bad, on(17, 12));
    assert.equal(c.key, 'unknown', `${bad} was not treated as unknown`);
    assert.equal(c.hours, null);
    assert.match(c.detail, /connect post history/i);
  }
});

test('a stamp in the future is clock skew, not a negative age', () => {
  const c = cadence(on(17, 18), on(17, 12));
  assert.ok(c.hours >= 0, `negative age: ${c.hours}`);
  assert.match(c.headline, /just now/i);
});

test('every state says how long it has been', () => {
  for (const [day, hour] of [[17, 3], [17, 10], [17, 13], [17, 20]]) {
    const c = cadence(on(16, 12), on(day, hour));
    assert.match(c.headline, /last post/i);
    assert.ok(c.detail.length > 10, `no guidance at ${day}@${hour}`);
  }
});

test('clockLabel names the hour, and flags a different day', () => {
  assert.match(clockLabel(on(17, 13), on(17, 10)), /1/);
  assert.doesNotMatch(clockLabel(on(17, 13), on(17, 10)), /tomorrow/);
  assert.match(clockLabel(on(18, 9), on(17, 20)), /tomorrow/);
});

// ---- which timestamp ----

test('lastPostAt reads TikTok seconds and library milliseconds together', () => {
  const at = lastPostAt({
    posts: [{ created: Math.floor(on(17, 9) / 1000) }, { created: Math.floor(on(16, 9) / 1000) }],
    projects: [{ postedAt: on(15, 9) }],
  });
  assert.equal(at, on(17, 9));
});

test('lastPostAt takes whichever source saw the more recent post', () => {
  // The library can be AHEAD of the history while TikTok is still processing
  // an upload. Under-reporting recency would turn the row red right after a
  // post went out, which is the one error that costs a post its audience.
  const at = lastPostAt({ posts: [{ created: Math.floor(on(16, 9) / 1000) }], projects: [{ postedAt: on(17, 12) }] });
  assert.equal(at, on(17, 12));
  assert.equal(cadence(at, on(17, 13)).key, 'fresh');
});

test('lastPostAt ignores rows with no usable stamp', () => {
  assert.equal(lastPostAt({ posts: [{ created: 0 }, { created: null }, {}], projects: [{ postedAt: null }] }), null);
  assert.equal(lastPostAt({}), null);
  assert.equal(lastPostAt(), null);
  assert.equal(lastPostAt({ posts: 'nope', projects: 42 }), null);
  // A draft that was never posted must not count as a post.
  assert.equal(lastPostAt({ projects: [{ status: 'ready', postedAt: null }] }), null);
});

test('lastPostAt survives a long history without blowing the stack', () => {
  const posts = Array.from({ length: 50_000 }, (_, i) => ({ created: Math.floor((on(17, 12) - (i + 1) * HOUR) / 1000) }));
  assert.equal(lastPostAt({ posts }), on(17, 11));
});

// ---- the shelf ----

test('runway divides each bucket by the daily rate', () => {
  const r = runway({ ready: POSTS_PER_DAY * 3, drafts: POSTS_PER_DAY * 2 });
  assert.equal(r.readyDays, 3);
  assert.equal(r.draftDays, 2);
  assert.equal(r.totalDays, 5);
});

test('ready and drafts stay separate — they are not the same asset', () => {
  // Ready can go out today; a draft still needs an hour of your time first.
  // One merged number would read as more runway than there is.
  const r = runway({ ready: 4, drafts: 20 });
  assert.equal(r.readyDays, 1);
  assert.notEqual(r.readyDays, r.totalDays);
});

test('runway shrugs off junk instead of reporting negative days', () => {
  for (const bad of [{}, undefined, { ready: -5, drafts: 'x' }, { ready: null }]) {
    const r = runway(bad);
    assert.ok(r.readyDays >= 0 && r.draftDays >= 0, `negative runway from ${JSON.stringify(bad)}`);
    assert.ok(Number.isFinite(r.totalDays));
  }
});

test('dayLabel says something you can act on', () => {
  assert.equal(dayLabel(0), 'none');
  assert.equal(dayLabel(0.5), 'under a day');
  assert.equal(dayLabel(1), '1 day');
  assert.equal(dayLabel(3), '3 days');
  assert.equal(dayLabel(2.5), '2.5 days');
  // Never a fake precision: this is a shelf, not a fuel gauge.
  assert.doesNotMatch(dayLabel(2.3333), /\d\.\d\d/);
  for (const bad of [null, undefined, NaN, -3, 'x']) assert.equal(dayLabel(bad), 'none');
});

test('a full shelf reads as days, not as a pile of posts', () => {
  const r = runway({ ready: 12, drafts: 9 });
  assert.equal(dayLabel(r.readyDays), '3 days');
  assert.equal(dayLabel(r.draftDays), '2.3 days');
});
