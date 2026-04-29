// YouTube publish helper (Edge Function variant)
// Runs on Netlify Edge (Deno) — gets ~50s response budget vs. 10s for regular
// Functions, so the Gemini AI rewrite has much more headroom.
// The caller supplies their own refresh token (per-user OAuth). This function
// exchanges it for a short-lived access token and returns it along with the
// AI-rewritten copy. Upload itself is done directly from the browser.

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'POST required' }, 405);
  }

  const env = (k) => Netlify.env.get(k);

  const YOUTUBE_CLIENT_ID = env('YOUTUBE_OAUTH_CLIENT_ID');
  const YOUTUBE_CLIENT_SECRET = env('YOUTUBE_OAUTH_CLIENT_SECRET');
  const GEMINI_API_KEY = env('GEMINI_API_KEY');
  const GEMINI_BASE_URL = env('GOOGLE_GEMINI_BASE_URL');
  const GEMINI_MODEL = env('GEMINI_MODEL') || 'gemini-2.5-flash';

  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET) {
    return json({ error: 'YouTube OAuth not configured' }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { metadata, action, refreshToken } = body;

  if (!refreshToken) {
    return json({ error: 'Not signed in' }, 401);
  }

  if (action === 'token') {
    const token = await getAccessToken({
      clientId: YOUTUBE_CLIENT_ID,
      clientSecret: YOUTUBE_CLIENT_SECRET,
      refreshToken,
    });
    if (!token) return json({ error: 'Could not get access token — please sign in again' }, 401);
    return json({ accessToken: token });
  }

  if (action === 'prepare') {
    if (!metadata) return json({ error: 'Missing metadata' }, 400);

    const started = Date.now();
    const [token, aiCopy] = await Promise.all([
      getAccessToken({
        clientId: YOUTUBE_CLIENT_ID,
        clientSecret: YOUTUBE_CLIENT_SECRET,
        refreshToken,
      }),
      rewriteForYouTube(metadata, { apiKey: GEMINI_API_KEY, baseUrl: GEMINI_BASE_URL, model: GEMINI_MODEL }),
    ]);

    if (!token) return json({ error: 'Could not get access token — please sign in again' }, 401);

    return json({
      accessToken: token,
      title: aiCopy.title,
      description: aiCopy.description,
      tags: aiCopy.tags,
      aiFallback: aiCopy._aiFallback === true,
      model: GEMINI_MODEL,
      elapsedMs: Date.now() - started,
    });
  }

  // AI-only rewrite — used by the on-demand sparkle buttons in the publish
  // modal. No token roundtrip; the client already has its access token from
  // a separate `action: 'token'` call.
  if (action === 'rewrite') {
    if (!metadata) return json({ error: 'Missing metadata' }, 400);

    const started = Date.now();
    const aiCopy = await rewriteForYouTube(metadata, { apiKey: GEMINI_API_KEY, baseUrl: GEMINI_BASE_URL, model: GEMINI_MODEL });

    return json({
      title: aiCopy.title,
      description: aiCopy.description,
      tags: aiCopy.tags,
      aiFallback: aiCopy._aiFallback === true,
      model: GEMINI_MODEL,
      elapsedMs: Date.now() - started,
    });
  }

  return json({ error: 'Unknown action. Use "prepare", "rewrite", or "token".' }, 400);
};

export const config = { path: '/api/youtube-publish' };

async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const data = await res.json();
    return data.access_token || null;
  } catch (e) {
    console.error('Token refresh failed:', e);
    return null;
  }
}

async function rewriteForYouTube(metadata, { apiKey, baseUrl, model }) {
  const fallback = {
    title: metadata.title || 'VHS Tape',
    description: buildFallbackDescription(metadata),
    tags: metadata.tags || 'VHS, retro, analog',
  };

  if (!apiKey || !baseUrl) return fallback;

  const prompt = `You are a YouTube SEO expert optimizing for maximum discoverability on a VHS archival channel called "VHS Garage" (@oracrest). Your #1 job: make this clip findable by people searching YouTube and Google for retro/VHS content.

METADATA:
Title: ${metadata.title || 'Untitled'}
Year: ${metadata.year || 'Unknown'}
Tape: ${metadata.tape || 'Unknown'}
Distributor: ${metadata.distributor || 'Unknown'}
Description: ${metadata.description || ''}
Tags: ${metadata.tags || ''}
Cassette Notes: ${metadata.cassetteNotes || ''}
Recording Speed: ${metadata.recordingSpeed || ''}
Tape Length: ${metadata.tapeLength || ''}
Condition: ${metadata.condition || ''}

SEO PRINCIPLES:
- Front-load the most searched keywords first (what people actually type into YouTube/Google)
- Use natural search phrases, not clickbait — think "1987 McDonald's commercial VHS" not "YOU WON'T BELIEVE"
- Year + content type + "VHS" is usually the highest-intent search pattern
- Long-tail keywords (specific brands, show names, actors, products, regional networks) beat generic ones
- Every field should work even if other fields are ignored

TITLE (max 70 chars, ideal 50-60):
- Start with the most distinctive keyword (show/brand/product name, NOT generic like "Vintage" or "Retro")
- Include year if known, format as (1987) or "1987" — never omit
- End with "| VHS" or similar if space permits to catch VHS searchers
- No emojis, no ALL CAPS, no clickbait

DESCRIPTION (2-3 paragraphs):
- FIRST LINE is critical — shows in Google search snippets. Pack it with the top 3-5 keywords in a natural sentence describing exactly what this is.
- Paragraph 2: tape details (distributor, year, recording speed, condition) — this adds long-tail SEO value for collectors searching specific terms.
- Final lines: "Captured and archived by VHS Garage — https://vhsgarage.com" then channel plug.
- Include 3-5 naturally-placed keyword variations throughout.

TAGS (comma-separated, 12-20 tags):
- Mix of: specific (exact show/brand/product names), medium (genre + decade like "80s commercials"), broad ("VHS", "analog", "retro TV")
- Include distributor, year, decade ("1980s", "80s"), format ("VHS rip", "VHS capture")
- Add "found footage" only if the clip is off-air / home-recorded content
- Use actual search terms, not made-up phrases

Return ONLY valid JSON:
{
  "title": "...",
  "description": "...",
  "tags": "..."
}`;

  // Edge Functions get ~50s wall time. Cap the AI call well below that so
  // the token fetch (part of the Promise.all) has room to return even if
  // Gemini stalls.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(
      `${baseUrl}/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        }),
        signal: controller.signal,
      }
    );
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    const reason = e.name === 'AbortError' ? 'timeout after 30s' : e.message;
    console.warn('Gemini rewrite failed, using fallback:', reason);
    return { ...fallback, _aiFallback: true };
  } finally {
    clearTimeout(timer);
  }
}

function buildFallbackDescription(m) {
  const lines = [];
  if (m.description) lines.push(m.description);
  lines.push('');
  lines.push('Captured from VHS tape.');
  if (m.year) lines.push('Year: ' + m.year);
  if (m.tape) lines.push('Tape: ' + m.tape);
  if (m.distributor) lines.push('Distributor: ' + m.distributor);
  if (m.cassetteNotes) lines.push('\n' + m.cassetteNotes);
  lines.push('\nCaptured and archived by VHS Garage');
  lines.push('https://vhsgarage.com');
  return lines.join('\n');
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
