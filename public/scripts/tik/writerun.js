// The "Write every draft" run, as something the screen can draw: which steps a
// film goes through, how far along the whole run is, and how long it has been.
//
// It used to be one line of text at the foot of the page. A ten-film run is
// minutes of model calls, and a status you have to scroll to find reads like
// nothing is happening.
//
// No DOM. Unit-tested.

export function writeSteps(format) {
  return format === 'quotes'
    ? [
      { key: 'pool', label: 'Quotes' },
      { key: 'subs', label: 'Subtitles' },
      { key: 'write', label: 'Writing' },
      { key: 'save', label: 'Saved' },
    ]
    : [
      { key: 'pool', label: 'Trivia' },
      { key: 'rank', label: 'AI picks' },
      { key: 'write', label: 'Writing' },
      { key: 'save', label: 'Saved' },
    ];
}

// 0..1 for the bar. Finished films count whole; the one in hand counts the
// steps it has finished, so the bar moves during a film and not only between.
export function runFraction({ total = 0, finished = 0, stepIndex = 0, stepCount = 4 } = {}) {
  if (!(total > 0)) return 0;
  const within = stepCount > 0 ? Math.min(1, Math.max(0, stepIndex / stepCount)) : 0;
  const f = (Math.min(finished, total) + (finished < total ? within : 0)) / total;
  return Math.min(1, Math.max(0, f));
}

// "0:07", "1:05", "12:40".
export function clockLabel(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// One line for the end of a run that says what didn't work as plainly as what did.
export function runSummary({ made = 0, failed = [], stopped = 0 } = {}) {
  const drafts = `${made} draft${made === 1 ? '' : 's'}`;
  const parts = [`Wrote ${drafts}`];
  if (failed.length) parts.push(`${failed.length} failed`);
  if (stopped) parts.push(`${stopped} not started (stopped)`);
  return `${parts.join(' · ')}.`;
}
