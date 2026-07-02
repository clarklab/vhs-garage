// Shared AI Gateway provider callers for the tik functions. Each takes
// (prompt, model, signal) and returns the raw text response; parseModelJson
// recovers the JSON object. Used by both the sync tik-autopilot function and
// the background tik-autopilot-job function.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE_URL = process.env.GOOGLE_GEMINI_BASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Root URL (no /v1) — Netlify's AI Gateway injects it this way, matching the
// Anthropic SDK convention where /v1/messages is appended.
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

export function providerFor(model) {
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) return 'openai';
  if (model.startsWith('claude')) return 'anthropic';
  return 'gemini';
}

// Dispatch to the right provider for `model`.
export async function callModel(prompt, model, signal) {
  const provider = providerFor(model);
  if (provider === 'openai') return callOpenAI(prompt, model, signal);
  if (provider === 'anthropic') return callAnthropic(prompt, model, signal);
  return callGemini(prompt, model, signal);
}

async function callGemini(prompt, model, signal) {
  if (!GEMINI_API_KEY || !GEMINI_BASE_URL) throw new Error('Gemini not configured');
  const res = await fetch(`${GEMINI_BASE_URL}/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      // Gemini 2.5 Flash has "thinking" on by default, which adds several
      // seconds of latency. Trivia recall doesn't need chain-of-thought.
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
export function parseModelJson(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(s); } catch {}
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(s.slice(start, end + 1)); } catch {} }
  return null;
}
