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

// Output budget. 2048 fits a title slide + 5 trivia suggestions; formats that
// ask for more rows (a Year Snapshot returns 16 entries) pass a bigger number,
// because a truncated reply is unparseable JSON and surfaces to the user as
// "the AI returned nothing usable".
export const DEFAULT_MAX_TOKENS = 2048;

// Dispatch to the right provider for `model`.
export async function callModel(prompt, model, signal, maxTokens = DEFAULT_MAX_TOKENS) {
  const provider = providerFor(model);
  const cap = Math.max(256, Math.round(Number(maxTokens) || DEFAULT_MAX_TOKENS));
  if (provider === 'openai') return callOpenAI(prompt, model, signal, cap);
  if (provider === 'anthropic') return callAnthropic(prompt, model, signal, cap);
  return callGemini(prompt, model, signal, cap);
}

async function callGemini(prompt, model, signal, maxTokens) {
  if (!GEMINI_API_KEY || !GEMINI_BASE_URL) throw new Error('Gemini not configured');
  const res = await fetch(`${GEMINI_BASE_URL}/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      // Gemini 2.5 Flash has "thinking" on by default, which adds several
      // seconds of latency. Trivia recall doesn't need chain-of-thought.
      generationConfig: {
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: maxTokens,
      },
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callOpenAI(prompt, model, signal, maxTokens) {
  if (!OPENAI_API_KEY) throw new Error('OpenAI not configured');
  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model, messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_completion_tokens: maxTokens,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callAnthropic(prompt, model, signal, maxTokens) {
  if (!ANTHROPIC_API_KEY) throw new Error('Anthropic not configured');
  // Netlify AI Gateway + Anthropic REST: {base}/v1/messages (base has no /v1).
  const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
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
