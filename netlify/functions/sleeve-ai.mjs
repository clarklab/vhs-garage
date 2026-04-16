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
  const imageBack = body?.imageBack;
  if (!image) {
    console.error('No image in body. Keys received:', Object.keys(body || {}));
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
          contents: [{ role: 'user', parts: imageParts }],
        }),
      }
    );

    const data = await res.json();

    if (data.error) {
      return json({ error: data.error.message }, data.error.code || 500);
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
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
