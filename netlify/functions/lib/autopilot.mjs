// Pure helpers for autopilot. buildAutopilotPrompt() writes the LLM prompt;
// normalizeSuggestions() validates/clamps the model's JSON. No network / DOM.
export const AUTOPILOT_COUNT = 5;
const CAPTION_MAX = 180;

export function buildAutopilotPrompt({ title, year, durationSeconds, count = AUTOPILOT_COUNT }) {
  const dur = Math.max(1, Math.round(durationSeconds || 0));
  return `You are a film historian curating a TikTok slideshow of DEEP-CUT movie trivia for the film "${title}"${year ? ` (${year})` : ''}.

Give exactly ${count} genuinely lesser-known, deep-cut trivia facts — avoid the famous/obvious ones a casual fan already knows. Only include facts you are confident are TRUE; never invent details. Each fact becomes one slide caption (${CAPTION_MAX} characters max, punchy, no hashtags).

For each fact, suggest a timecode as a whole number of SECONDS between 0 and ${dur}, pointing to roughly where in the film a relevant or representative frame would appear. Spread the timecodes across the runtime. These are only suggestions — the user fine-tunes the frame.

Return ONLY valid JSON in this exact shape, nothing else:
{
  "suggestions": [
    { "caption": "string", "timecode": 0 }
  ]
}`;
}

export function normalizeSuggestions(raw, durationSeconds, max = AUTOPILOT_COUNT) {
  const dur = Math.max(0, Math.floor(durationSeconds || 0));
  const list = Array.isArray(raw?.suggestions) ? raw.suggestions : [];
  const out = [];
  for (const item of list) {
    if (out.length >= max) break;
    const caption = typeof item?.caption === 'string' ? item.caption.trim() : '';
    if (!caption) continue;
    let tc = Number(item?.timecode);
    if (!Number.isFinite(tc)) tc = 0;
    tc = Math.min(dur, Math.max(0, Math.round(tc)));
    out.push({ caption: caption.slice(0, CAPTION_MAX), timecode: tc });
  }
  return out;
}
