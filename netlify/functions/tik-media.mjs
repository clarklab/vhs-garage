// Hosts composited slide JPEGs so TikTok's PULL_FROM_URL can fetch them.
// POST (image/jpeg bytes) → store in Blobs, return { url }.
// GET ?id=<id>            → stream the JPEG (no redirect, https on the deployed domain).
import { getStore } from '@netlify/blobs';

const STORE = 'tik-slides';
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h — well past TikTok's 1h pull window.
const MAX_BYTES = 8 * 1024 * 1024;     // guardrail per image.

export default async (req) => {
  const store = getStore(STORE);
  const url = new URL(req.url);

  if (req.method === 'GET') {
    // Accept the id from ?id= OR from the /tik/media/<id> path. The netlify.toml
    // rewrite forwards requests here, but functions receive the ORIGINAL request
    // URL — the ?id=:id substitution in the redirect's `to` never reaches us, so
    // the path is the real source of truth for rewritten requests. (Verified in
    // production: query-only parsing 400'd every TikTok image pull.)
    const pathId = url.pathname.match(/^\/tik\/media\/([^/]+)\/?$/)?.[1];
    const id = url.searchParams.get('id') || pathId;
    if (!id) {
      console.warn('[tik-media] GET missing id', { path: url.pathname });
      return new Response('Missing id', { status: 400 });
    }
    const buf = await store.get(id, { type: 'arrayBuffer' });
    if (!buf) {
      console.warn('[tik-media] GET blob not found (expired or bad id)', { id });
      return new Response('Not found', { status: 404 });
    }
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'X-Content-Type-Options': 'nosniff', // never let a stored non-JPEG be sniffed as active content
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  if (req.method === 'POST') {
    // Same-origin gate: the only legitimate caller is the site's own browser
    // fetch, so this isn't a fully open upload host. Cross-origin/omitted → 403.
    const sameHost = (u) => { try { return new URL(u).host === url.host; } catch { return false; } };
    if (!sameHost(req.headers.get('origin')) && !sameHost(req.headers.get('referer'))) {
      return json({ error: 'Forbidden' }, 403);
    }

    const buf = await req.arrayBuffer();
    if (!buf || buf.byteLength === 0) return json({ error: 'Empty body' }, 400);
    if (buf.byteLength > MAX_BYTES) return json({ error: 'Image too large' }, 413);
    // Enforce JPEG by magic bytes (SOI = FF D8) — don't trust the client header.
    const head = new Uint8Array(buf.slice(0, 2));
    if (head[0] !== 0xff || head[1] !== 0xd8) return json({ error: 'Only JPEG images are accepted' }, 415);

    await sweepOldBlobs(store);

    const id = crypto.randomUUID();
    await store.set(id, buf, { metadata: { createdAt: Date.now() } });
    // Serve under the /tik prefix (netlify.toml rewrites /tik/media/:id → this
    // function) so a single TikTok URL-property verification of <domain>/tik
    // covers the image URLs. Absolute, non-redirecting, on this deployed origin.
    const publicUrl = `${url.origin}/tik/media/${id}`;
    return json({ url: publicUrl, id });
  }

  return json({ error: 'Method not allowed' }, 405);
};

async function sweepOldBlobs(store) {
  try {
    const { blobs } = await store.list();
    const now = Date.now();
    await Promise.all(
      blobs.map(async (b) => {
        const meta = await store.getMetadata(b.key).catch(() => null);
        const createdAt = meta?.metadata?.createdAt ?? 0;
        if (now - createdAt > MAX_AGE_MS) await store.delete(b.key).catch(() => {});
      })
    );
  } catch (e) {
    // Sweeping is best-effort; never block an upload on cleanup — but log it.
    console.warn('[tik-media] blob sweep failed:', e.message);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
