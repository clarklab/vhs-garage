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

// Output budget.
//
// On Claude 5 models max_tokens caps THINKING PLUS the visible answer, and
// thinking is on by default. 2048 used to fit a title slide plus five trivia
// suggestions comfortably; with thinking sharing the same budget it does not,
// and a truncated reply is unparseable JSON that surfaces to the user as "the
// AI returned nothing usable". Formats that ask for more rows (a Year Snapshot
// returns 16 entries) pass a bigger number still.
export const DEFAULT_MAX_TOKENS = 8192;

// How hard Claude works on a request: low | medium | high | xhigh | max.
// Default `high` is the documented sweet spot for intelligence-sensitive work
// like writing captions; `xhigh` is aimed at coding and agentic loops. Exposed
// as an env var so the level can be swept without a deploy.
const EFFORT = process.env.TIK_AI_EFFORT || 'high';
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
export const aiEffort = () => (EFFORT_LEVELS.has(EFFORT) ? EFFORT : 'high');

// Adaptive thinking and `output_config.effort` exist on the 4.6-and-later
// Opus/Sonnet lines and the 5 family. They are NOT accepted on Haiku 4.5, which
// the sync fallback path still uses: sending either one there is a 400, so the
// tuning has to be gated on the model rather than sent unconditionally.
const THINKING_MODELS = /^claude-(opus-(4-6|4-7|4-8|5)|sonnet-(4-6|5)|fable-5|mythos-5)$/;
export function supportsThinking(model) {
  return THINKING_MODELS.test(String(model || ''));
}

// On the Claude 5 line max_tokens caps THINKING PLUS the visible answer, so a
// caller's number has to be read as the answer budget and thinking given its
// own room on top. Without this, a call site sized before thinking existed
// (the queue asked for 1536) spends its whole budget reasoning and comes back
// with no text block at all — which reads downstream as "the AI returned
// nothing usable" rather than as a truncation.
const THINKING_HEADROOM = 6144;
export function budgetFor(model, maxTokens) {
  const cap = Math.max(256, Math.round(Number(maxTokens) || DEFAULT_MAX_TOKENS));
  return supportsThinking(model) ? cap + THINKING_HEADROOM : cap;
}

// The tuning block for a Claude request, or {} for a model that rejects it.
function tuning(model) {
  return supportsThinking(model)
    ? { thinking: { type: 'adaptive' }, output_config: { effort: aiEffort() } }
    : {};
}

// Dispatch to the right provider for `model`.
export async function callModel(prompt, model, signal, maxTokens = DEFAULT_MAX_TOKENS) {
  const provider = providerFor(model);
  // budgetFor adds thinking headroom only where thinking is actually on, so
  // Gemini and OpenAI get the caller's number unchanged.
  const cap = budgetFor(model, maxTokens);
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
    // Adaptive thinking plus an effort level is how depth is controlled on the
    // Claude 5 line; the old budget_tokens knob is rejected outright, as are
    // sampling params, so steering lives in the prompt.
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      ...tuning(model),
      messages: [{ role: 'user', content: prompt }],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return anthropicText(await res.json());
}

// Look at an image and answer in JSON. Used by the screenshot verifier, which
// grabs a frame and asks whether it actually shows what the caption describes.
// Claude only: the frame check is the one call where judgement quality decides
// whether a slide ships with the wrong shot, and the studio standardizes on
// Claude for that. Callers pass a non-Claude model at their peril, so say so
// loudly rather than silently routing to a text-only provider.
// 2048, not 512: the verdict itself is a few dozen tokens, but thinking is
// billed against the same ceiling and a truncated verdict fails the frame check.
export async function callModelWithImage(prompt, image, model, signal, maxTokens = 2048) {
  return callModelWithImages(prompt, [image], model, signal, maxTokens);
}

// Several images in one message, in order, followed by the prompt.
//
// The frame checker sends a spread of the film at once so the model chooses
// between shots it can see rather than guessing at one it cannot. Image blocks
// keep their array order, which is what lets the prompt refer to "Frame 3".
export async function callModelWithImages(prompt, images, model, signal, maxTokens = 2048) {
  if (providerFor(model) !== 'anthropic') {
    throw new Error(`Vision requires a Claude model, got "${model}"`);
  }
  if (!ANTHROPIC_API_KEY) throw new Error('Anthropic not configured');
  const blocks = (Array.isArray(images) ? images : [])
    .map((img) => ({ mediaType: img?.mediaType || 'image/jpeg', data: String(img?.base64 || '') }))
    .filter((img) => img.data)
    .map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    }));
  if (!blocks.length) throw new Error('No image data');

  const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model, max_tokens: budgetFor(model, maxTokens),
      ...tuning(model),
      messages: [{ role: 'user', content: [...blocks, { type: 'text', text: prompt }] }],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Anthropic vision ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return anthropicText(await res.json());
}

// The text block, or a loud error naming the reason there isn't one.
//
// Returning '' here is how a truncated reply used to travel all the way to the
// UI disguised as "the AI returned nothing usable": stop_reason said max_tokens
// and nobody looked.
function anthropicText(body) {
  const block = (body?.content || []).find((b) => b.type === 'text');
  if (block?.text) return block.text;
  const stop = body?.stop_reason || 'unknown';
  if (stop === 'max_tokens') {
    throw new Error('Anthropic hit max_tokens before writing an answer — raise the token budget');
  }
  console.warn('[ai] no text block in reply', { stop_reason: stop, blocks: (body?.content || []).map((b) => b.type) });
  return '';
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
