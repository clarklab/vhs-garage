// Sleeve AI: takes a front (and optional back) sleeve image and asks
// Gemini to extract title / year / distributor / tags / etc. Used by
// the capture page after both sleeve photos are taken.
//
// HISTORICAL FIX: this endpoint was returning 500s in production for a
// while. Root cause was the MODEL constant pointing at
// "gemini-3.1-pro-preview" — a name that never existed in the AI
// Gateway (no Gemini 3.x family) and got rejected upstream. Now reads
// the model from env (SLEEVE_AI_MODEL) and defaults to
// gemini-2.5-flash, which is fully vision-capable, in the Gateway's
// allowed list, and much faster than 2.5-pro for the sleeve-OCR task.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE_URL = process.env.GOOGLE_GEMINI_BASE_URL;
// Vision-capable, fast, in the Gateway. Override via env if you need
// 2.5-pro quality for some reason.
const MODEL = process.env.SLEEVE_AI_MODEL || 'gemini-2.5-flash';

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'POST required' }, 405);
  }

  if (!GEMINI_API_KEY || !GEMINI_BASE_URL) {
    console.error('[sleeve-ai] missing env vars', {
      hasKey: !!GEMINI_API_KEY,
      hasBase: !!GEMINI_BASE_URL,
    });
    return json({ error: 'Gemini API not configured' }, 500);
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

If you cannot determine a field, use an empty string. Return ONLY the JSON object, no markdown formatting.`;

  const imageParts = [
    { text: prompt },
    { inlineData: { mimeType: 'image/jpeg', data: base64Front } },
  ];
  if (base64Back) {
    imageParts.push({ inlineData: { mimeType: 'image/jpeg', data: base64Back } });
  }

  let res;
  try {
    res = await fetch(
      `${GEMINI_BASE_URL}/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: imageParts }],
          // Strict JSON output — pairs with the "Return ONLY the JSON
          // object" instruction in the prompt. Removes the need to
          // strip ```json fences from the response (parseModelJson
          // handles it as a fallback regardless).
          generationConfig: { responseMimeType: 'application/json' },
        }),
      }
    );
  } catch (e) {
    console.error('[sleeve-ai] fetch threw:', e.message);
    return json({ error: 'AI analysis failed (network)', detail: e.message }, 502);
  }

  // Surface upstream errors with their actual status + a snippet of
  // the body so DevTools tells us exactly what Gemini said. Previous
  // version swallowed everything as a 500 and made debugging
  // impossible (e.g. the bad-model-name bug went undiagnosed for
  // weeks).
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('[sleeve-ai] Gemini non-OK', {
      status: res.status, model: MODEL, body: errBody.slice(0, 400),
    });
    return json({
      error: `AI analysis failed (Gemini ${res.status})`,
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

  if (data.error) {
    console.error('[sleeve-ai] Gemini API error', { model: MODEL, error: data.error });
    return json({ error: data.error.message || 'AI analysis failed', model: MODEL }, data.error.code || 500);
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
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
