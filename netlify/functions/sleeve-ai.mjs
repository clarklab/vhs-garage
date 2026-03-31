const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE_URL = process.env.GOOGLE_GEMINI_BASE_URL;
const MODEL = 'gemini-3.1-pro-preview';

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'POST required' }, 405);
  }

  if (!GEMINI_API_KEY || !GEMINI_BASE_URL) {
    console.error('Missing env vars:', { hasKey: !!GEMINI_API_KEY, hasBase: !!GEMINI_BASE_URL });
    return json({ error: 'Gemini API not configured' }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    console.error('JSON parse error:', e.message);
    return json({ error: 'Invalid request body', detail: e.message }, 400);
  }

  const image = body?.image;
  if (!image) {
    console.error('No image in body. Keys received:', Object.keys(body || {}));
    return json({ error: 'Missing image data', keys: Object.keys(body || {}) }, 400);
  }

  // Strip data URL prefix if present
  const base64 = image.replace(/^data:image\/\w+;base64,/, '');

  const prompt = `You are analyzing the front cover of a VHS cassette tape sleeve/case.
Extract the following information from the image and return ONLY valid JSON with these fields:

{
  "title": "The title of the movie, show, or content on the tape",
  "year": "The release year if visible, otherwise your best estimate based on the content",
  "description": "A brief 1-2 sentence description of the content",
  "tags": "Comma-separated relevant tags (genre, era, format, studio, etc.)",
  "tape": "The VHS tape brand/label if visible (e.g. 'Sony', 'Maxell', 'TDK'), or the distributor/studio",
  "cassetteNotes": "Any special release notes visible on the cover — director's cut, widescreen, special edition, rental copy, screener, EP/SP/SLP recording speed, or other notable details about this specific release"
}

If you cannot determine a field, use an empty string. Return ONLY the JSON object, no markdown formatting.`;

  try {
    const res = await fetch(
      `${GEMINI_BASE_URL}/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: 'image/jpeg',
                  data: base64,
                },
              },
            ],
          }],
        }),
      }
    );

    const data = await res.json();

    if (data.error) {
      return json({ error: data.error.message }, data.error.code || 500);
    }

    // Extract text from Gemini response
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Parse JSON from response (strip any markdown fences)
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const info = JSON.parse(cleaned);

    return json(info);
  } catch (e) {
    console.error('Gemini request failed:', e);
    return json({ error: 'AI analysis failed' }, 500);
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
