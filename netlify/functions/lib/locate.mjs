// Prompts and answer-checking for the whole-film frame search.
//
// Two jobs, both "which numbered cell":
//   scan     several coarse grids covering part of the film; EVERY fact for the
//            film at once. Answer: per fact, the best cell in these grids, or
//            none.
//   pinpoint one fine grid of consecutive frames around a scan hit; ONE fact.
//            Answer: the single best frame.
//
// Pure: no network. The function that calls the model is tik-locate-background.

export const MAX_FACTS = 20;
const CAPTION_MAX = 320;
const GRAB_MAX = 220;
const WHY_MAX = 200;
export const ISSUES = ['ok', 'unclear', 'no-subject', 'wrong-scene', 'transition', 'credits', 'black'];

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function factLines(facts) {
  return facts.map((f, i) => {
    const n = i + 1;
    if (f.kind === 'title') {
      return `${n}. [TITLE CARD] The film's main title or title logo, on screen.${f.caption ? ` (Slide text: "${clip(f.caption, 120)}")` : ''}`;
    }
    const grab = clip(f.grab, GRAB_MAX);
    return `${n}. Fact: "${clip(f.caption, CAPTION_MAX)}"${grab ? `\n   Shot to find: ${grab}` : ''}`;
  }).join('\n');
}

// The rules both passes share. The face rule matters more than it looks: the
// writer's hints used to name actors, and a model that cannot recognise a face
// was being asked to find one.
const SEEING_RULES = `How to judge a cell:
- You cannot identify real people from their faces, and must not try. Match on what is VISIBLE: the setting, the action, wardrobe, props, creatures, vehicles, lighting, how many people are in shot, and any on-screen text.
- The right cell shows the described moment clearly, with its subject visible and readable at a glance.
- Never choose a black frame, a fade or dissolve, end credits, or a frame where the subject is out of shot.`;

export function buildScanPrompt({ facts = [], grids = [], durationSeconds = 0 } = {}) {
  const list = facts.slice(0, MAX_FACTS);
  const minutes = Math.round(Number(durationSeconds) / 60) || null;
  const labels = grids.map((g) => g.label).join(', ');
  const span = grids.length
    ? ` This set covers ${fmt(grids[0].times[0])} to ${fmt(grids.at(-1).times.at(-1))} of the film${minutes ? ` (it runs about ${minutes} minutes)` : ''}.`
    : '';
  return `You are finding the right still frame for each slide of a movie-trivia slideshow.

The images above are contact-sheet grids of frames from the film, in order. Each grid is labelled (${labels}). Each cell has its number in its top-left corner; cells are numbered from 1, left to right, then top to bottom, and run forward in time.${span}

FACTS:
${factLines(list)}

For EACH fact, find the single cell, across all of these grids, that best shows the moment the fact is about. This is only part of the film: if none of these cells shows that moment, say so with "cell": null rather than settling for something nearby.

${SEEING_RULES}
- If a fact is about something off screen (a budget, a casting story), pick the most telling shot of the scene it mentions; if it names no scene at all, use "cell": null.
- Two facts may share a cell.

"score" is 0-100: how sure you are that the cell shows THAT moment — not just the same film or the same location. 90+ means unmistakable. Below 50 means a guess.

Return ONLY JSON, one entry per fact, in this exact shape:
{"matches":[{"fact":1,"grid":"A","cell":12,"score":85,"why":"under 20 words"}]}`;
}

export function buildPinpointPrompt({ fact = {}, cellCount = 12, firstSeconds = 0, stepSeconds = 2.5 } = {}) {
  const what = fact.kind === 'title'
    ? `the film's main title or title logo${fact.caption ? ` (slide text: "${clip(fact.caption, 120)}")` : ''}`
    : `this fact: "${clip(fact.caption, CAPTION_MAX)}"${fact.grab ? `\nShot to find: ${clip(fact.grab, GRAB_MAX)}` : ''}`;
  return `The image above is ${cellCount} consecutive frames from a film, about ${stepSeconds} seconds apart, starting at ${fmt(firstSeconds)}. Cells are numbered in their top-left corner, left to right then top to bottom, forward in time.

Pick the single best frame to illustrate ${what}

${SEEING_RULES}
- Of several frames showing the moment, prefer the sharpest, with no motion blur and nobody mid-blink.

Return ONLY JSON in this exact shape:
{"cell":7,"score":85,"issue":"ok","why":"under 20 words"}
"cell" is null if none of these frames shows the moment. "score" is 0-100. "issue" is one of: ${ISSUES.join(', ')}.`;
}

function fmt(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

const score = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0;
};

// Keep only what can be acted on: a fact that exists, a grid that was sent,
// and a cell that is a whole number inside that grid.
export function normalizeScan(parsed, { factCount = 0, grids = [] } = {}) {
  const sizes = new Map(grids.map((g) => [String(g.label).toUpperCase(), g.times?.length || 0]));
  const rows = Array.isArray(parsed?.matches) ? parsed.matches : Array.isArray(parsed) ? parsed : [];
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const fact = Number(r?.fact);
    if (!Number.isInteger(fact) || fact < 1 || fact > factCount || seen.has(fact)) continue;
    seen.add(fact);
    const grid = String(r?.grid ?? '').trim().toUpperCase();
    const cell = r?.cell === null || r?.cell === undefined ? null : Number(r.cell);
    const valid = cell !== null && Number.isInteger(cell) && sizes.has(grid) && cell >= 1 && cell <= sizes.get(grid);
    out.push({
      fact,
      grid: valid ? grid : null,
      cell: valid ? cell : null,
      score: valid ? score(r?.score) : 0,
      why: clip(r?.why, WHY_MAX),
    });
  }
  return out;
}

export function normalizePinpoint(parsed, cellCount) {
  const cell = parsed?.cell === null || parsed?.cell === undefined ? null : Number(parsed.cell);
  const valid = cell !== null && Number.isInteger(cell) && cell >= 1 && cell <= cellCount;
  const issue = ISSUES.includes(parsed?.issue) ? parsed.issue : (valid ? 'ok' : 'wrong-scene');
  return {
    cell: valid ? cell : null,
    score: valid ? score(parsed?.score) : 0,
    issue,
    why: clip(parsed?.why, WHY_MAX),
  };
}
