// Fetches one TikTok cover image so the page can keep it.
//
// A cover URL from the Display API points at a CDN that sends no CORS headers,
// so the browser can display it but cannot read its bytes — and the address
// expires in a few days anyway. Importing past posts needs the BYTES, to store
// as the project's thumbnail. This is the one hop that gets them.
//
// GET ?url=<https TikTok CDN url> → the image bytes.
import { allowedCoverUrl, allowedCoverType, MAX_COVER_BYTES } from './lib/covers.mjs';

export default async (req) => {
  if (req.method !== 'GET') return json({ error: 'GET required' }, 405);
  const here = new URL(req.url);

  // Same-origin gate, as on every other upload/fetch helper here: the only
  // legitimate caller is this site's own browser fetch.
  const sameHost = (u) => { try { return new URL(u).host === here.host; } catch { return false; } };
  if (!sameHost(req.headers.get('origin')) && !sameHost(req.headers.get('referer'))) {
    return json({ error: 'Forbidden' }, 403);
  }

  const target = here.searchParams.get('url') || '';
  if (!allowedCoverUrl(target)) {
    console.warn('[tik-cover] refused a URL that is not a TikTok CDN image', { target: target.slice(0, 120) });
    return json({ error: 'Only TikTok cover images can be fetched' }, 400);
  }

  let res;
  try {
    res = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    console.error('[tik-cover] fetch threw', { message: e.message });
    return json({ error: 'Could not reach the cover image' }, 502);
  }
  // A redirect is allowed, but only to somewhere still on the allowlist.
  if (res.url && !allowedCoverUrl(res.url)) {
    console.error('[tik-cover] redirected off the allowlist; refusing', { to: String(res.url).slice(0, 120) });
    return json({ error: 'That cover redirected somewhere unexpected' }, 502);
  }
  if (!res.ok) {
    console.warn('[tik-cover] CDN said no', { status: res.status });
    return json({ error: `Cover unavailable (${res.status})` }, 502);
  }
  const type = res.headers.get('content-type') || '';
  if (!allowedCoverType(type)) {
    console.warn('[tik-cover] not an image', { type });
    return json({ error: 'That URL is not an image' }, 415);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_COVER_BYTES) {
    console.warn('[tik-cover] cover too large', { bytes: buf.byteLength });
    return json({ error: 'That cover is too large' }, 413);
  }
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': type.split(';')[0],
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=600',
    },
  });
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
