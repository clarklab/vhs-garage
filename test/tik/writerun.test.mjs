import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeSteps, runFraction, clockLabel, runSummary } from '../../public/scripts/tik/writerun.js';

test('trivia and quotes runs show the steps each actually takes', () => {
  assert.deepEqual(writeSteps('trivia').map((s) => s.label), ['Trivia', 'AI picks', 'Writing', 'Saved']);
  assert.deepEqual(writeSteps('quotes').map((s) => s.label), ['Quotes', 'Subtitles', 'Writing', 'Saved']);
});

test('the bar moves within a film, not only between films', () => {
  assert.equal(runFraction({ total: 4, finished: 0, stepIndex: 0 }), 0);
  assert.equal(runFraction({ total: 4, finished: 0, stepIndex: 2, stepCount: 4 }), 0.125);
  assert.equal(runFraction({ total: 4, finished: 2, stepIndex: 0 }), 0.5);
  assert.equal(runFraction({ total: 4, finished: 4, stepIndex: 3 }), 1, 'a finished run is full, whatever the step');
  assert.equal(runFraction({ total: 0 }), 0);
});

test('the clock reads like a clock', () => {
  assert.equal(clockLabel(7_400), '0:07');
  assert.equal(clockLabel(65_000), '1:05');
  assert.equal(clockLabel(760_000), '12:40');
  assert.equal(clockLabel(-5), '0:00');
});

test('the summary names what failed and what never started', () => {
  assert.equal(runSummary({ made: 3 }), 'Wrote 3 drafts.');
  assert.equal(runSummary({ made: 1, failed: ['Jaws'] }), 'Wrote 1 draft · 1 failed.');
  assert.equal(runSummary({ made: 2, failed: [], stopped: 5 }), 'Wrote 2 drafts · 5 not started (stopped).');
});
