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
    const id = url.searchParams.get('id');
    if (!id) return new Response('Missing id', { status: 400 });
    const buf = await store.get(id, { type: 'arrayBuffer' });
    if (!buf) return new Response('Not found', { status: 404 });
    return new Response(buf, {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' },
    });
  }

  if (req.method === 'POST') {
    const buf = await req.arrayBuffer();
    if (!buf || buf.byteLength === 0) return json({ error: 'Empty body' }, 400);
    if (buf.byteLength > MAX_BYTES) return json({ error: 'Image too large' }, 413);

    await sweepOldBlobs(store);

    const id = crypto.randomUUID();
    await store.set(id, buf, { metadata: { createdAt: Date.now() } });
    // Build an absolute, non-redirecting URL on this deployed origin.
    const publicUrl = `${url.origin}/.netlify/functions/tik-media?id=${id}`;
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
  } catch {
    // Sweeping is best-effort; never block an upload on cleanup.
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
