// YouTube publish helper: exchanges refresh token for access token + AI-rewrites metadata
// Does NOT upload the video — returns the token and copy for the client to upload directly

const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_OAUTH_CLIENT_ID;
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
const YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_OAUTH_REFRESH_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE_URL = process.env.GOOGLE_GEMINI_BASE_URL;
const GEMINI_MODEL = 'gemini-3.1-pro-preview';

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'POST required' }, 405);
  }

  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) {
    return json({ error: 'YouTube OAuth not configured' }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { metadata, action } = body;

  // Action: just get a fresh access token (for upload)
  if (action === 'token') {
    const token = await getAccessToken();
    if (!token) return json({ error: 'Could not get access token' }, 500);
    return json({ accessToken: token });
  }

  // Action: AI rewrite + token
  if (action === 'prepare') {
    if (!metadata) return json({ error: 'Missing metadata' }, 400);

    const [token, aiCopy] = await Promise.all([
      getAccessToken(),
      rewriteForYouTube(metadata),
    ]);

    if (!token) return json({ error: 'Could not get access token' }, 500);

    return json({
      accessToken: token,
      title: aiCopy.title,
      description: aiCopy.description,
      tags: aiCopy.tags,
    });
  }

  return json({ error: 'Unknown action. Use "prepare" or "token".' }, 400);
};

async function getAccessToken() {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: YOUTUBE_CLIENT_ID,
        client_secret: YOUTUBE_CLIENT_SECRET,
        refresh_token: YOUTUBE_REFRESH_TOKEN,
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

async function rewriteForYouTube(metadata) {
  const fallback = {
    title: metadata.title || 'VHS Tape',
    description: buildFallbackDescription(metadata),
    tags: metadata.tags || 'VHS, retro, analog',
  };

  if (!GEMINI_API_KEY || !GEMINI_BASE_URL) return fallback;

  const prompt = `You are a YouTube SEO expert for a VHS archival channel called "VHS Garage" (@oracrest).
Given this clip metadata, write a compelling YouTube title, description, and tags.

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

REQUIREMENTS:
- Title: Catchy, keyword-rich, under 70 chars. Include year if known. Make it interesting for VHS collectors and nostalgia seekers.
- Description: 2-3 paragraphs. First paragraph hooks the viewer. Include tape details, year, distributor. End with "Captured and archived by VHS Garage — https://vhsgarage.com" and channel info.
- Tags: Comma-separated, 10-15 relevant tags for YouTube search. Include "VHS", the title, year, genre, distributor, "retro", "analog", "found footage" if applicable.

Return ONLY valid JSON:
{
  "title": "...",
  "description": "...",
  "tags": "..."
}`;

  try {
    const res = await fetch(
      `${GEMINI_BASE_URL}/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        }),
      }
    );
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.warn('Gemini rewrite failed, using fallback:', e.message);
    return fallback;
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
