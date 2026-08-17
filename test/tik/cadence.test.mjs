import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cadence, lastPostAt, FRESH_HOURS, DUE_HOURS, CADENCE_STATES,
} from '../../public/scripts/tik/cadence.js';

const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);
const hoursAgo = (h) => NOW - h * 3_600_000;

// ---- which state ----

test('the three states land on the thresholds they claim', () => {
  assert.equal(cadence(hoursAgo(0), NOW).key, 'fresh');
  assert.equal(cadence(hoursAgo(FRESH_HOURS - 0.1), NOW).key, 'fresh');
  assert.equal(cadence(hoursAgo(FRESH_HOURS), NOW).key, 'open');
  assert.equal(cadence(hoursAgo(DUE_HOURS - 0.1), NOW).key, 'open');
  assert.equal(cadence(hoursAgo(DUE_HOURS), NOW).key, 'due');
  assert.equal(cadence(hoursAgo(72), NOW).key, 'due');
});

test('the thresholds are in order and describe a real day', () => {
  assert.ok(FRESH_HOURS > 0 && FRESH_HOURS < DUE_HOURS);
  assert.ok(DUE_HOURS < 24, 'a full day between posts is not a cadence');
});

test('each state carries a word and an icon, not just a color', () => {
  // Color alone is unreadable to anyone who cannot separate red from amber,
  // and reading this row at a glance is its entire job.
  for (const st of Object.values(CADENCE_STATES)) {
    assert.ok(st.label, `${st.key} has no label`);
    assert.ok(st.icon, `${st.key} has no icon`);
    assert.ok(st.tone, `${st.key} has no tone`);
  }
  const tones = Object.values(CADENCE_STATES).map((s) => s.tone);
  assert.equal(new Set(tones).size, tones.length, 'two states share a tone');
});

test('no history is a real answer, not a zero-hour-old post', () => {
  for (const bad of [null, undefined, 0, -1, NaN, '', 'nope']) {
    const c = cadence(bad, NOW);
    assert.equal(c.key, 'unknown', `${bad} was not treated as unknown`);
    assert.equal(c.hours, null, `${bad} reported an age`);
    assert.match(c.detail, /connect post history/i);
  }
});

test('a stamp in the future is clock skew, not a negative age', () => {
  const c = cadence(NOW + 6 * 3_600_000, NOW);
  assert.equal(c.key, 'fresh');
  assert.ok(c.hours >= 0, `negative age: ${c.hours}`);
});

// ---- what it says ----

test('every state says how long it has been and what to do about it', () => {
  for (const h of [0.5, 2, 6, 9, 14, 40]) {
    const c = cadence(hoursAgo(h), NOW);
    assert.match(c.headline, /last post/i, `no headline at ${h}h`);
    assert.ok(c.detail.length > 10, `no guidance at ${h}h`);
  }
});

test('the elapsed time reads in units you can act on', () => {
  assert.match(cadence(hoursAgo(0.005), NOW).headline, /just now/i);
  assert.match(cadence(hoursAgo(0.5), NOW).headline, /30m ago/);
  assert.match(cadence(hoursAgo(6), NOW).headline, /6h ago/);
  assert.match(cadence(hoursAgo(72), NOW).headline, /3d ago/);
  // Never a fake decimal: this is a clock, not a stopwatch.
  assert.doesNotMatch(cadence(hoursAgo(5.4), NOW).headline, /\d\.\d/);
});

test('a fresh post says when the next one is due', () => {
  const c = cadence(hoursAgo(1), NOW);
  assert.equal(c.key, 'fresh');
  assert.match(c.detail, /3h/, `expected ${FRESH_HOURS} - 1 hours of waiting: ${c.detail}`);
});

test('an overdue post names the threshold it passed', () => {
  assert.match(cadence(hoursAgo(30), NOW).detail, new RegExp(`${DUE_HOURS}h`));
});

// ---- which timestamp ----

test('lastPostAt reads TikTok seconds and library milliseconds together', () => {
  const at = lastPostAt({
    posts: [{ created: Math.floor(hoursAgo(9) / 1000) }, { created: Math.floor(hoursAgo(30) / 1000) }],
    projects: [{ postedAt: hoursAgo(50) }],
  });
  assert.equal(Math.round((NOW - at) / 3_600_000), 9);
});

test('lastPostAt takes whichever source saw the more recent post', () => {
  // The library can be AHEAD of the history while TikTok is still processing
  // an upload. Under-reporting recency would turn the row red right after a
  // post went out, which is the one error that costs a post its audience.
  const at = lastPostAt({
    posts: [{ created: Math.floor(hoursAgo(20) / 1000) }],
    projects: [{ postedAt: hoursAgo(1) }],
  });
  assert.equal(Math.round((NOW - at) / 3_600_000), 1);
  assert.equal(cadence(at, NOW).key, 'fresh');
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
  const posts = Array.from({ length: 50_000 }, (_, i) => ({ created: Math.floor(hoursAgo(i + 1) / 1000) }));
  assert.equal(Math.round((NOW - lastPostAt({ posts })) / 3_600_000), 1);
});
