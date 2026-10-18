// AI Gateway credentials, read at call time with a fallback.
//
// Netlify sets the provider-named variables (ANTHROPIC_API_KEY and friends)
// when a function instance initialises. Most instances get them; some don't,
// and keep not having them for their whole life — on 18 Oct 2026 one warm
// tik-curate-background instance failed three rankings in a row with
// "Anthropic not configured" while the next instance was fine.
//
// Netlify also "always injects" NETLIFY_AI_GATEWAY_KEY / _URL, and on this
// site every provider key equals that key and every provider base URL equals
// that URL. So when a provider variable is missing, the gateway pair stands
// in, and the log says it happened.

const warned = new Set();
function note(name) {
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(`[ai-gateway] ${name} missing on this instance; using the NETLIFY_AI_GATEWAY_* pair instead`);
}

export function aiKey(name, env = process.env) {
  if (env[name]) return env[name];
  if (env.NETLIFY_AI_GATEWAY_KEY) { note(name); return env.NETLIFY_AI_GATEWAY_KEY; }
  return undefined;
}

// `fallback` is the provider's own public endpoint, for running with a
// personal key outside Netlify (where neither gateway variable exists).
export function aiBase(name, fallback, env = process.env) {
  if (env[name]) return env[name];
  if (env.NETLIFY_AI_GATEWAY_URL) { note(name); return env.NETLIFY_AI_GATEWAY_URL; }
  return fallback;
}
