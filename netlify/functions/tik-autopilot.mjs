// Autopilot: given a movie title/year, ask an LLM (via the Netlify AI Gateway)
// for deep-cut trivia + suggested timecodes. Provider routing + lenient JSON
// parsing over the AI Gateway. POST { title, year, durationSeconds, model? }.
import { buildAutopilotPrompt, normalizeSuggestions, AUTOPILOT_COUNT } from './lib/autopilot.mjs';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE_URL = process.env.GOOGLE_GEMINI_BASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Root URL (no /v1) — Netlify's AI Gateway injects it this way, matching the
// Anthropic SDK convention where /v1/messages is appended. See callAnthropic.
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

// Default to Claude Sonnet for trivia quality — deep-cut recall is where the
// bigger models clearly beat the fast tier, and Sonnet stays comfortably
// inside the 9s abort. Override with TIK_AUTOPILOT_MODEL (must be in the
// allowlist and provisioned in the AI Gateway); claude-opus-4-8 is allowed
// for max quality if the latency holds up in practice.
const DEFAULT_MODEL = process.env.TIK_AUTOPILOT_MODEL || 'claude-sonnet-5';
const ALLOWED_MODELS = new Set([
  'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-sonnet-4-6',
  'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gpt-4.1-nano',
]);
function pickModel(requested) {
  return requested && ALLOWED_MODELS.has(requested) ? requested : DEFAULT_MODEL;
}
function providerFor(model) {
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) return 'openai';
  if (model.startsWith('claude')) return 'anthropic';
  return 'gemini';
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { title, year, durationSeconds, count, exclude, focusTimecode, guidance, includeTitleSlide, model: requested } = body;
  if (!title) return json({ error: 'Missing movie title' }, 400);
  const model = pickModel(requested);
  const prompt = buildAutopilotPrompt({ title, year, durationSeconds, count, exclude, focusTimecode, guidance, includeTitleSlide });

  // Abort before Netlify's 10s function ceiling so we return a graceful
  // fallback instead of a platform 502.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const provider = providerFor(model);
    let raw;
    if (provider === 'openai') raw = await callOpenAI(prompt, model, controller.signal);
    else if (provider === 'anthropic') raw = await callAnthropic(prompt, model, controller.signal);
    else raw = await callGemini(prompt, model, controller.signal);

    // A title slide arrives as an extra first item, on top of `count` trivia.
    // Coerce count so the normalize cap always matches what the prompt asked
    // for (the prompt defaults to AUTOPILOT_COUNT when count is absent).
    const base = Number(count) || AUTOPILOT_COUNT;
    const max = includeTitleSlide ? base + 1 : base;
    const suggestions = normalizeSuggestions(parseModelJson(raw), durationSeconds, max);
    if (!suggestions.length) {
      console.warn('[tik-autopilot] model returned no usable suggestions', { model, rawPreview: String(raw).slice(0, 300) });
      return json({ suggestions: [], model, aiFallback: true, error: 'The AI returned no usable trivia — try again.' });
    }
    return json({ suggestions, model, aiFallback: false });
  } catch (e) {
    console.error('[tik-autopilot] AI call failed', { model, name: e.name, message: e.message });
    const reason = e.name === 'AbortError'
      ? 'the AI took too long to respond — try again'
      : e.message;
    return json({ suggestions: [], model, aiFallback: true, error: `Autopilot failed: ${reason}` });
  } finally {
    clearTimeout(timer);
  }
};

async function callGemini(prompt, model, signal) {
  if (!GEMINI_API_KEY || !GEMINI_BASE_URL) throw new Error('Gemini not configured');
  const res = await fetch(`${GEMINI_BASE_URL}/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      // Gemini 2.5 Flash has "thinking" on by default, which adds several
      // seconds of latency and blew the abort budget. Trivia recall doesn't
      // need chain-of-thought, so disable it for speed (thinkingBudget: 0).
      generationConfig: { responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callOpenAI(prompt, model, signal) {
  if (!OPENAI_API_KEY) throw new Error('OpenAI not configured');
  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model, messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    }),
    signal,
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callAnthropic(prompt, model, signal) {
  if (!ANTHROPIC_API_KEY) throw new Error('Anthropic not configured');
  // Netlify AI Gateway + Anthropic REST: {base}/v1/messages (base has no /v1).
  const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    // 2048: a title slide + 5 suggestions with captions + grab hints can brush
    // against 1024, and truncated JSON surfaces as "AI returned nothing".
    body: JSON.stringify({ model, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] }),
    signal,
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === 'text');
  return block?.text || '';
}

// Lenient JSON parse — strips ```json fences and recovers the first {...} block.
function parseModelJson(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(s); } catch {}
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(s.slice(start, end + 1)); } catch {} }
  return null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
