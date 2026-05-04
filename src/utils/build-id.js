// Build ID — appended as `?v=<id>` to every <script src="/scripts/..."> tag
// in the site so a fresh deploy guarantees a fresh script fetch even when a
// browser, ISP proxy, or service worker has been overly enthusiastic about
// caching the previous version. Critical for non-technical users who won't
// know to hard-refresh.
//
// Resolution order:
//   1. Netlify's automatic COMMIT_REF (full git SHA of the deployed commit)
//   2. PUBLIC_BUILD_ID env var (manual override, useful for staging)
//   3. Date.now() at module-load time (local dev — changes every restart,
//      which is what you want when iterating on JS in `netlify dev`)
//
// Truncated to 12 chars because that's plenty for cache-busting and keeps
// page source readable.

const sha = process.env.COMMIT_REF || process.env.PUBLIC_BUILD_ID || String(Date.now());
export const BUILD_ID = sha.slice(0, 12);
