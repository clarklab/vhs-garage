// Which URLs the cover proxy is allowed to fetch.
//
// The proxy exists because a TikTok cover is on a CDN that sends no CORS
// headers, so the page cannot turn one into a Blob by itself. A server that
// fetches "whatever URL you send it" is an SSRF hole pointed at our own
// network, so this is an allowlist and not a filter: an address has to be
// https, on a host we name, and nothing else gets through.
//
// Pure. The function that does the fetching is in tik-cover.mjs.

export const COVER_HOSTS = [
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'tiktokcdn-eu.com',
  'tiktokcdn-in.com',
  'tiktokv.com',
  'ibyteimg.com',
];

export const MAX_COVER_BYTES = 5 * 1024 * 1024;

// `host === domain` or a real subdomain of it. Plain endsWith would also pass
// "nottiktokcdn.com" and "tiktokcdn.com.evil.net" is caught by parsing first.
export function allowedCoverHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  return COVER_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

export function allowedCoverUrl(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;   // credentials in a URL are a redirect trick
  return allowedCoverHost(url.hostname);
}

// Only pictures come back out of this.
export function allowedCoverType(contentType) {
  return /^image\/(jpeg|png|webp|heic|avif)\b/i.test(String(contentType || ''));
}
