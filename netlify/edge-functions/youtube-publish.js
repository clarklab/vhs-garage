// YouTube publish helper (Edge Function variant)
// Runs on Netlify Edge (Deno) — gets ~50s response budget vs. 10s for regular
// Functions, so the AI rewrite has much more headroom.
//
// The caller supplies their own refresh token (per-user OAuth). This function
// exchanges it for a short-lived access token and returns it along with the
// AI-rewritten copy. Upload itself is done directly from the browser.
//
// AI MODEL ROUTING
//   The client passes a `model` field in the body (set by the AI dropdown
//   in the capture toolbar). pickModel() validates against the allowlist
//   and providerFor() routes to the matching handler. Adding a new model
//   means: append to ALLOWED_MODELS, ensure providerFor() returns the
//   right provider name, and confirm the env vars for that provider are
//   set in the Netlify dashboard.

const ALLOWED_MODELS = new Set([
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gpt-4.1-nano',
  'claude-haiku-4-5',
]);

function pickModel(requested, defaultModel) {
  if (requested && ALLOWED_MODELS.has(requested)) return requested;
  return defaultModel;
}

function providerFor(model) {
  if (model.startsWith('gemini')) return 'gemini';
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) return 'openai';
  if (model.startsWith('claude')) return 'anthropic';
  return 'gemini';
}

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'POST required' }, 405);
  }

  const env = (k) => Netlify.env.get(k);

  const YOUTUBE_CLIENT_ID = env('YOUTUBE_OAUTH_CLIENT_ID');
  const YOUTUBE_CLIENT_SECRET = env('YOUTUBE_OAUTH_CLIENT_SECRET');

  // Per-provider config. The Gemini path is always wired up (default
  // model). OpenAI / Anthropic only work if the user has populated the
  // matching env vars in the Netlify dashboard; if not, those models
  // gracefully fall through to the template-built fallback.
  const providers = {
    gemini: {
      apiKey: env('GEMINI_API_KEY'),
      baseUrl: env('GOOGLE_GEMINI_BASE_URL'),
    },
    openai: {
      apiKey: env('OPENAI_API_KEY'),
      baseUrl: env('OPENAI_BASE_URL') || 'https://api.openai.com/v1',
    },
    anthropic: {
      apiKey: env('ANTHROPIC_API_KEY'),
      baseUrl: env('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com/v1',
    },
  };

  const DEFAULT_MODEL = env('GEMINI_MODEL') || 'gemini-2.5-flash-lite';

  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET) {
    return json({ error: 'YouTube OAuth not configured' }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { metadata, action, refreshToken, model: requestedModel } = body;
  const model = pickModel(requestedModel, DEFAULT_MODEL);

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
      rewriteForYouTube(metadata, model, providers),
    ]);

    if (!token) return json({ error: 'Could not get access token — please sign in again' }, 401);

    return json({
      accessToken: token,
      title: aiCopy.title,
      description: aiCopy.description,
      tags: aiCopy.tags,
      aiFallback: aiCopy._aiFallback === true,
      model,
      elapsedMs: Date.now() - started,
    });
  }

  // AI-only rewrite — used by the on-demand sparkle buttons in the publish
  // modal. No token roundtrip; the client already has its access token from
  // a separate `action: 'token'` call.
  if (action === 'rewrite') {
    if (!metadata) return json({ error: 'Missing metadata' }, 400);

    const started = Date.now();
    const aiCopy = await rewriteForYouTube(metadata, model, providers);

    return json({
      title: aiCopy.title,
      description: aiCopy.description,
      tags: aiCopy.tags,
      aiFallback: aiCopy._aiFallback === true,
      model,
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

function buildPrompt(metadata) {
  return `You are a YouTube SEO expert optimizing for maximum discoverability on a VHS archival channel called "VHS Garage" (@oracrest). Your #1 job: make this clip findable by people searching YouTube and Google for retro/VHS content.

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
}

// Lenient JSON parse — handles models that wrap output in ```json fences,
// add trailing prose, or otherwise leak around strict mode. Returns null
// if no parseable object can be recovered.
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

// Dispatcher — picks the provider handler based on the model ID. Wraps
// each call in an abort timer so we never blow the edge function's 50s
// budget. Any failure (provider down, no API key, bad JSON, abort)
// falls back to a template-built description so the user still gets
// SOMETHING to upload with.
async function rewriteForYouTube(metadata, model, providers) {
  const fallback = {
    title: metadata.title || 'VHS Tape',
    description: buildFallbackDescription(metadata),
    tags: metadata.tags || 'VHS, retro, analog',
  };

  const prompt = buildPrompt(metadata);
  const provider = providerFor(model);
  const cfg = providers[provider];

  // Edge functions have ~50s wall time. Cap the AI call below that so
  // the token fetch (part of the Promise.all in `prepare`) has room to
  // return even if the AI provider stalls.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    let raw;
    if (provider === 'openai') raw = await callOpenAI(prompt, model, cfg, controller.signal);
    else if (provider === 'anthropic') raw = await callAnthropic(prompt, model, cfg, controller.signal);
    else raw = await callGemini(prompt, model, cfg, controller.signal);

    const parsed = parseModelJson(raw);
    if (!parsed || (!parsed.title && !parsed.description && !parsed.tags)) {
      console.warn('AI rewrite returned unparseable output, falling back', { model });
      return { ...fallback, _aiFallback: true };
    }
    return parsed;
  } catch (e) {
    const reason = e.name === 'AbortError' ? 'timeout after 30s' : e.message;
    console.warn('AI rewrite failed, using fallback:', { model, provider, reason });
    return { ...fallback, _aiFallback: true };
  } finally {
    clearTimeout(timer);
  }
}

// --- Provider handlers ---
// Each takes (prompt, model, cfg, signal) and returns the raw text response.
// JSON parsing happens once in the caller (parseModelJson) so each handler
// stays small and only worries about wire format.

async function callGemini(prompt, model, cfg, signal) {
  if (!cfg.apiKey || !cfg.baseUrl) throw new Error('Gemini not configured');
  const res = await fetch(
    `${cfg.baseUrl}/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        // generationConfig.responseMimeType: "application/json" gives us
        // strict-JSON output on Gemini 2.5+ — no fence-stripping needed
        // (parseModelJson handles it as a belt-and-suspenders fallback).
        generationConfig: { responseMimeType: 'application/json' },
      }),
      signal,
    }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callOpenAI(prompt, model, cfg, signal) {
  if (!cfg.apiKey) throw new Error('OpenAI not configured (set OPENAI_API_KEY)');
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      // response_format json_object forces valid JSON output — pairs
      // with the "Return ONLY valid JSON" instruction in the prompt.
      response_format: { type: 'json_object' },
    }),
    signal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callAnthropic(prompt, model, cfg, signal) {
  if (!cfg.apiKey) throw new Error('Anthropic not configured (set ANTHROPIC_API_KEY)');
  const res = await fetch(`${cfg.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  // Anthropic responses are a content array of blocks; we want the first
  // text block. parseModelJson handles any prefix/suffix prose.
  const block = (data.content || []).find((b) => b.type === 'text');
  return block?.text || '';
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
