// Sleeve AI: takes a front (and optional back) sleeve image and asks
// Claude to extract title / year / distributor / tags / etc. Used by
// the capture page after both sleeve photos are taken.
//
// HISTORICAL FIXES:
// - The MODEL constant once pointed at "gemini-3.1-pro-preview" before
//   that name existed in the AI Gateway, and every call 500'd for weeks.
// - In Oct 2026 the Gateway dropped the whole Gemini 2.5 family. The
//   default here was gemini-2.5-flash, so every scan came back
//   400 unknown_model and the sleeve fields stopped filling in. Moved to
//   Claude Haiku 5.5: current, vision-capable, fast at low effort, and
//   what the rest of the site standardizes on.
import { aiKey, aiBase } from './lib/gateway-env.mjs';

const ANTHROPIC_API_KEY = () => aiKey('ANTHROPIC_API_KEY');
// Root URL (no /v1), the way the Gateway injects it.
const ANTHROPIC_BASE_URL = () => aiBase('ANTHROPIC_BASE_URL', 'https://api.anthropic.com');
// Override via env (any Claude model) if a sleeve needs more reading
// power than Haiku has.
const MODEL = process.env.SLEEVE_AI_MODEL || 'claude-haiku-5-5';

// Every field the prompt asks for, as a strict schema, so the reply is
// always parseable JSON with nothing missing.
const FIELDS = ['tape', 'year', 'tags', 'distributor', 'tapeLength', 'recordingSpeed', 'condition', 'cassetteNotes'];
const SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(FIELDS.map((f) => [f, { type: 'string' }])),
  required: FIELDS,
  additionalProperties: false,
};

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'POST required' }, 405);
  }

  if (!ANTHROPIC_API_KEY()) {
    console.error('[sleeve-ai] missing env vars', { hasKey: false, hasBase: !!ANTHROPIC_BASE_URL() });
    return json({ error: 'AI not configured' }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    console.error('[sleeve-ai] JSON parse error:', e.message);
    return json({ error: 'Invalid request body', detail: e.message }, 400);
  }

  const image = body?.image;
  const imageBack = body?.imageBack;
  if (!image) {
    console.error('[sleeve-ai] no image in body. Keys:', Object.keys(body || {}));
    return json({ error: 'Missing image data', keys: Object.keys(body || {}) }, 400);
  }

  const base64Front = image.replace(/^data:image\/\w+;base64,/, '');
  const base64Back = imageBack ? imageBack.replace(/^data:image\/\w+;base64,/, '') : null;

  const prompt = `You are analyzing a VHS cassette tape sleeve/case.${base64Back ? ' You have been given BOTH the front and back cover images.' : ' You have been given the front cover image.'}
Extract the following information and return ONLY valid JSON with these fields:

{
  "tape": "The title of the movie, show, or content on this VHS tape",
  "year": "The release year if visible, otherwise your best estimate",
  "tags": "Comma-separated relevant tags (genre, era, format, studio, etc.)",
  "distributor": "The distributor or studio label visible on the sleeve (e.g., Warner Home Video, Paramount, Sony, etc.). Check both front and back for this.",
  "tapeLength": "Tape length if visible (e.g., T-120, T-160, T-60). Check both front and back.",
  "recordingSpeed": "Recording speed if indicated (SP, LP, EP, SLP). Check both front and back.",
  "condition": "Estimate tape condition from sleeve appearance: Excellent, Good, Fair, or Poor. Empty string if unclear.",
  "cassetteNotes": "Two parts: (1) A brief 1-2 sentence summary of what this movie/show is about. (2) Anything unique about THIS specific VHS release — special edition, director's cut, widescreen, rental copy stickers, screener markings, ex-library, clamshell case, or any other notable physical details you can spot from front and back. Separate the summary and the release details with a line break."
}

LANGUAGE: Write every field in English, even when the sleeve is in another language.
- "tape": if the release has a known official English title, use it. Otherwise translate the title into natural English. Either way, follow it with the original title in its own script in parentheses, e.g. "My Neighbor Totoro (となりのトトロ)".
- "tags": English, and include the language and country of the release (e.g. "Japanese, Japan").
- "cassetteNotes": start with a line naming the sleeve's language and giving the original title, e.g. "Original title (Japanese): となりのトトロ". Translate anything notable printed on the sleeve rather than copying it untranslated.
- If the sleeve is already in English, skip all of this.

If you cannot determine a field, use an empty string. Return ONLY the JSON object, no markdown formatting.`;

  // Images before the prompt, each labelled, so "front" and "back" in the
  // prompt point at the right picture.
  const content = [
    { type: 'text', text: 'Front cover:' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Front } },
  ];
  if (base64Back) {
    content.push(
      { type: 'text', text: 'Back cover:' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Back } },
    );
  }
  content.push({ type: 'text', text: prompt });

  let res;
  try {
    res = await fetch(`${ANTHROPIC_BASE_URL()}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        // Thinking shares this ceiling with the answer; the JSON itself
        // is a few hundred tokens.
        max_tokens: 4096,
        // Reading a sleeve is OCR plus a little recall, so low effort
        // keeps it quick. The schema guarantees parseable JSON.
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: SCHEMA },
        },
        messages: [{ role: 'user', content }],
      }),
    });
  } catch (e) {
    console.error('[sleeve-ai] fetch threw:', e.message);
    return json({ error: 'AI analysis failed (network)', detail: e.message }, 502);
  }

  // Surface upstream errors with their actual status + a snippet of
  // the body so DevTools tells us exactly what the model said. An
  // earlier version swallowed everything as a 500 and made debugging
  // impossible (e.g. the bad-model-name bug went undiagnosed for
  // weeks).
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('[sleeve-ai] AI non-OK', {
      status: res.status, model: MODEL, body: errBody.slice(0, 400),
    });
    return json({
      error: `AI analysis failed (${res.status})`,
      model: MODEL,
      detail: errBody.slice(0, 400),
    }, 502);
  }

  let data;
  try { data = await res.json(); }
  catch (e) {
    console.error('[sleeve-ai] response was not JSON:', e.message);
    return json({ error: 'AI returned non-JSON response', detail: e.message }, 502);
  }

  if (data.stop_reason === 'refusal' || data.stop_reason === 'max_tokens') {
    console.error('[sleeve-ai] no usable answer', { model: MODEL, stop_reason: data.stop_reason });
    return json({ error: `AI stopped early (${data.stop_reason})`, model: MODEL }, 502);
  }

  const text = (data.content || []).find((b) => b.type === 'text')?.text || '';
  const info = parseModelJson(text);
  if (!info) {
    console.error('[sleeve-ai] could not parse JSON from response', {
      model: MODEL, sample: text.slice(0, 200),
    });
    return json({
      error: 'AI returned unparseable output',
      model: MODEL,
      sample: text.slice(0, 200),
    }, 502);
  }
  return json(info);
};

// Lenient JSON parse — handles models that wrap output in ```json
// fences, add trailing prose, or otherwise leak around strict mode.
function parseModelJson(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(s); } catch {}
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch {}
  }
  return null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
