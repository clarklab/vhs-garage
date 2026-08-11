import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linearFit, recentRate, models, etaDays, milestones, projectSeries,
  trendSeries, horizonFor, dayToISO, MIN_POINTS, MAX_HORIZON_DAYS,
} from '../../public/scripts/tik/forecast.js';

// A series growing `perDay` a day from `start`, one point per day.
const ramp = (start, perDay, days, from = '2026-07-01') => {
  const t0 = Date.parse(`${from}T00:00:00Z`) / 86_400_000;
  return Array.from({ length: days }, (_, i) => ({
    d: dayToISO(t0 + i), c: Math.round(start + perDay * i),
  }));
};

// ---- the straight-line fit ----

test('linearFit recovers a clean slope', () => {
  const fit = linearFit(ramp(1000, 25, 20));
  assert.ok(Math.abs(fit.perDay - 25) < 0.01, `got ${fit.perDay}`);
  assert.ok(fit.r2 > 0.99);
  assert.equal(fit.n, 20);
});

test('linearFit reports a low r² on a noisy series', () => {
  // Sawtooth around a flat mean: a line explains almost none of it, and the
  // UI needs to know that before it calls the fit a trend.
  const series = ramp(1000, 0, 12).map((p, i) => ({ ...p, c: 1000 + (i % 2 ? 300 : -300) }));
  const fit = linearFit(series);
  assert.ok(fit.r2 < 0.2, `r² was ${fit.r2}`);
});

test('linearFit handles a falling count without pretending otherwise', () => {
  const fit = linearFit(ramp(5000, -12, 10));
  assert.ok(fit.perDay < 0);
});

test('linearFit refuses what it cannot fit', () => {
  assert.equal(linearFit([]), null);
  assert.equal(linearFit([{ d: '2026-07-01', c: 10 }]), null);
  assert.equal(linearFit(null), null);
  // Every snapshot on the same day: no slope exists, and dividing by the
  // zero-variance denominator would produce Infinity.
  assert.equal(linearFit([
    { d: '2026-07-01', c: 10 }, { d: '2026-07-01', c: 20 }, { d: '2026-07-01', c: 30 },
  ]), null);
});

test('linearFit ignores junk points and sorts what is left', () => {
  const fit = linearFit([
    { d: '2026-07-05', c: 1100 }, null, { d: 'nonsense', c: 5 },
    { d: '2026-07-01', c: 1000 }, { d: '2026-07-03', c: 1050 }, { c: 7 },
  ]);
  assert.ok(Math.abs(fit.perDay - 25) < 0.01);
  assert.equal(fit.n, 3);
});

// ---- the recent-window rate ----

test('recentRate measures the trailing window, not the whole run', () => {
  // Flat for three weeks, then it takes off for longer than the window. The
  // window should sit entirely inside the new regime and see ~100/day, while
  // all-time is still dragged down by the dead stretch.
  const flat = ramp(1000, 0, 21, '2026-07-01');
  const fast = ramp(1000, 100, 16, '2026-07-22');
  const series = [...flat, ...fast];
  const recent = recentRate(series);
  const fit = linearFit(series);
  assert.ok(Math.abs(recent.perDay - 100) < 1, `window saw ${recent.perDay}, not the new pace`);
  assert.ok(recent.perDay > fit.perDay * 1.5, `recent ${recent.perDay} vs all-time ${fit.perDay}`);
});

test('recentRate spanning a regime change reports the blend, not the peak', () => {
  // Half the window flat, half fast: the honest answer is in between, and
  // quietly reporting the fast half would overstate the pace.
  const series = [...ramp(1000, 0, 21, '2026-07-01'), ...ramp(1000, 100, 8, '2026-07-22')];
  const recent = recentRate(series);
  assert.ok(recent.perDay > 20 && recent.perDay < 100, `got ${recent.perDay}`);
});

test('recentRate falls back to the last two points in a short series', () => {
  const r = recentRate([{ d: '2026-07-01', c: 100 }, { d: '2026-07-03', c: 160 }]);
  assert.equal(r.perDay, 30);
  assert.equal(r.days, 2);
});

test('recentRate returns null when there is no span to measure', () => {
  assert.equal(recentRate([]), null);
  assert.equal(recentRate([{ d: '2026-07-01', c: 100 }]), null);
});

// ---- the model pair ----

test('models needs a real history before projecting anything', () => {
  assert.deepEqual(models(ramp(1000, 30, MIN_POINTS - 1)), []);
  assert.ok(models(ramp(1000, 30, MIN_POINTS)).length >= 1);
});

test('models returns both paces, labelled and anchored to the latest count', () => {
  const series = ramp(1000, 30, 30);
  const ms = models(series);
  assert.deepEqual(ms.map((m) => m.key).sort(), ['alltime', 'recent']);
  const last = series[series.length - 1];
  for (const m of ms) {
    assert.equal(m.at, last.c);
    assert.equal(m.on, last.d);
    assert.ok(m.label.length > 0);
  }
});

// ---- when do we get there ----

test('etaDays does the arithmetic', () => {
  assert.equal(etaDays(1000, 5000, 100), 40);
  assert.equal(etaDays(5000, 5000, 100), 0, 'already there');
  assert.equal(etaDays(6000, 5000, 100), 0, 'past it');
});

test('etaDays refuses to promise what the rate cannot deliver', () => {
  assert.equal(etaDays(1000, 100000, 0), null, 'flat never arrives');
  assert.equal(etaDays(1000, 100000, -50), null, 'shrinking never arrives');
  // A crawl that technically reaches 1M in 400 years is not a forecast.
  assert.equal(etaDays(1000, 1e6, 1), null);
  assert.ok(etaDays(1000, 1e6, 2000) !== null);
});

test('etaDays stays inside the horizon it advertises', () => {
  const days = etaDays(0, 1000, 1000 / MAX_HORIZON_DAYS);
  assert.ok(days === null || days <= MAX_HORIZON_DAYS);
});

// ---- milestones ----

test('milestones are the next round numbers above where we are', () => {
  const ms = milestones(ramp(3000, 40, 30));
  const last = 3000 + 40 * 29;
  assert.ok(ms.every((m) => m.target > last), 'a milestone we already passed is not a milestone');
  // Strictly ascending, and it starts at the first rung above the count.
  for (let i = 1; i < ms.length; i++) assert.ok(ms[i].target > ms[i - 1].target);
});

test('every milestone carries a date per model', () => {
  const ms = milestones(ramp(1000, 50, 30));
  assert.ok(ms.length > 0);
  for (const m of ms) {
    assert.ok(m.etas.length >= 1);
    for (const e of m.etas) {
      assert.ok(['alltime', 'recent'].includes(e.key));
      if (e.days !== null) {
        assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(e.days > 0);
      } else {
        assert.equal(e.date, null, 'no days means no date, not a made-up one');
      }
    }
  }
});

test('a stalled account gets milestones with no dates rather than no milestones', () => {
  // Flat growth: the targets are still worth showing, the ETAs are honestly
  // unknown. Inventing a date here is the failure mode this guards.
  const ms = milestones(ramp(2000, 0, 20));
  assert.ok(ms.length > 0);
  assert.ok(ms[0].etas.every((e) => e.days === null && e.date === null));
});

test('milestones on an empty or tiny series never throw', () => {
  assert.deepEqual(milestones([]), []);
  assert.ok(Array.isArray(milestones([{ d: '2026-07-01', c: 10 }])));
});

// ---- plotting ----

test('projectSeries starts on the last real point so the line joins up', () => {
  const series = ramp(1000, 30, 10);
  const last = series[series.length - 1];
  const proj = projectSeries(series, 30, 20);
  assert.equal(proj[0].d, last.d);
  assert.equal(proj[0].c, last.c);
  assert.equal(proj[0].projected, false, 'the join point is real, not projected');
  assert.equal(proj.length, 21);
  assert.ok(proj.slice(1).every((p) => p.projected));
});

test('projectSeries follows the rate it is given and never goes negative', () => {
  const series = ramp(1000, 0, 5);
  assert.equal(projectSeries(series, 100, 10).at(-1).c, 1000 + 1000);
  assert.ok(projectSeries(series, -500, 10).every((p) => p.c >= 0));
});

test('trendSeries draws a straight line across the history span', () => {
  const series = ramp(1000, 25, 12);
  const trend = trendSeries(series);
  assert.equal(trend.length, series.length);
  assert.equal(trend[0].d, series[0].d);
  assert.equal(trend.at(-1).d, series.at(-1).d);
  // Straight: every step is the same size.
  const steps = trend.slice(1).map((p, i) => p.c - trend[i].c);
  assert.ok(Math.max(...steps) - Math.min(...steps) <= 1, `steps varied: ${steps}`);
});

test('trendSeries is empty when there is nothing to fit', () => {
  assert.deepEqual(trendSeries([{ d: '2026-07-01', c: 10 }]), []);
  assert.deepEqual(trendSeries([]), []);
});

test('horizonFor always plots a real runway, never a stub', () => {
  // A milestone ten days out must not produce a twelve-day chart: the point of
  // the forecast view is seeing where this goes, not confirming next week.
  const nearMilestone = horizonFor(ramp(4900, 200, 20));
  assert.ok(nearMilestone >= 75, `stub horizon of ${nearMilestone} days`);
  for (const perDay of [3, 40, 200, 2000]) {
    const h = horizonFor(ramp(4000, perDay, 20));
    assert.ok(h >= 75 && h <= 400, `perDay ${perDay} gave ${h}`);
  }
});

test('horizonFor reaches further for a slower account', () => {
  const fast = horizonFor(ramp(4000, 500, 20));
  const slow = horizonFor(ramp(4000, 20, 20));
  assert.ok(slow > fast, `slow ${slow} should out-reach fast ${fast}`);
});

test('horizonFor still returns something plottable when nothing is reachable', () => {
  const h = horizonFor(ramp(2000, 0, 20));
  assert.ok(h >= 75 && h <= 400);
});

test('dayToISO round-trips a stored date', () => {
  const d = '2026-08-11';
  assert.equal(dayToISO(Date.parse(`${d}T00:00:00Z`) / 86_400_000), d);
});
