// Autopilot AI fetch: ask tik-autopilot for scene-specific trivia. The seek +
// frame-grab happens in app.js, so bulk-autopilot, "add scene", and per-slide
// "redo trivia" all share one code path. Pure network here.

// opts: { title, year, durationSeconds, count?, exclude?, focusTimecode? }
// Returns [{ caption, timecode }]. Throws a clear message if none come back.
export async function fetchScenes(opts = {}) {
  const res = await fetch('/.netlify/functions/tik-autopilot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: opts.title,
      year: opts.year,
      durationSeconds: opts.durationSeconds || 0,
      count: opts.count,
      exclude: opts.exclude || [],
      focusTimecode: opts.focusTimecode,
    }),
  });
  const data = await res.json().catch(() => ({}));
  const suggestions = data.suggestions || [];
  if (!suggestions.length) {
    throw new Error(data.error || 'Autopilot couldn’t generate trivia — try again.');
  }
  return suggestions;
}
