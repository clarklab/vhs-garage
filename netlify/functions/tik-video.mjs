// Hosts a rendered Quote-a-long clip so TikTok's PULL_FROM_URL can fetch it.
// The video twin of tik-media.mjs, with one difference that drives the whole
// file: a clip is far too big for one function request, so it arrives in
// chunks and is streamed back as one file.
//
// POST (video bytes + x-upload-id / x-chunk-index / x-chunk-count)
//     → store the chunk; the last one writes the manifest and returns { url }.
// GET ?id=<id> or /tik/video/<id>
//     → stream the clip, with HEAD and Range support (a video fetcher expects both).
import { getStore } from '@netlify/blobs';
import {
  chunkKey, manifestKey, validUploadId, sniffVideoType, clipResponsePlan, totalBytes,
  MAX_CHUNK_BYTES, MAX_TOTAL_BYTES, MAX_CHUNKS,
} from './lib/videostore.mjs';

const STORE = 'tik-clips';
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h, well past TikTok's pull window

export default async (req) => {
  const store = getStore(STORE);
  const url = new URL(req.url);

  if (req.method === 'GET' || req.method === 'HEAD') {
    // Same as tik-media: a rewritten request keeps its ORIGINAL url, so the
    // path is the real source of the id, not the ?id= the redirect writes.
    const pathId = url.pathname.match(/^\/tik\/video\/([^/]+)\/?$/)?.[1];
    const id = url.searchParams.get('id') || pathId;
    if (!validUploadId(id || '')) {
      console.warn('[tik-video] GET bad id', { path: url.pathname });
      return new Response('Missing id', { status: 400 });
    }
    const manifest = await store.get(manifestKey(id), { type: 'json' }).catch(() => null);
    const plan = clipResponsePlan({ manifest, rangeHeader: req.headers.get('range'), method: req.method });
    if (plan.status === 404) {
      console.warn('[tik-video] GET clip not found (expired or never finished)', { id });
      return new Response('Not found', { status: 404 });
    }
    if (plan.status === 416 || req.method === 'HEAD') {
      return new Response(null, { status: plan.status, headers: plan.headers });
    }
    // Streamed, not concatenated: a 60MB clip buffered inside a function is a
    // memory spike for no reason, and the fetcher reads it in order anyway.
    const queue = [...plan.slices];
    const body = new ReadableStream({
      async pull(controller) {
        const slice = queue.shift();
        if (!slice) { controller.close(); return; }
        const buf = await store.get(chunkKey(id, slice.index), { type: 'arrayBuffer' });
        if (!buf) {
          console.error('[tik-video] chunk missing mid-stream', { id, index: slice.index });
          controller.error(new Error('chunk missing'));
          return;
        }
        controller.enqueue(new Uint8Array(buf).slice(slice.from, slice.to));
      },
    });
    return new Response(body, { status: plan.status, headers: plan.headers });
  }

  if (req.method === 'POST') {
    // Same-origin gate, same as tik-media: the only legitimate caller is this
    // site's own browser fetch, so this is not an open upload host.
    const sameHost = (u) => { try { return new URL(u).host === url.host; } catch { return false; } };
    if (!sameHost(req.headers.get('origin')) && !sameHost(req.headers.get('referer'))) {
      return json({ error: 'Forbidden' }, 403);
    }

    const id = req.headers.get('x-upload-id') || '';
    const index = Number(req.headers.get('x-chunk-index'));
    const count = Number(req.headers.get('x-chunk-count'));
    if (!validUploadId(id)) return json({ error: 'Bad upload id' }, 400);
    if (!Number.isInteger(index) || index < 0 || !Number.isInteger(count) || count < 1) {
      return json({ error: 'Bad chunk numbering' }, 400);
    }
    if (count > MAX_CHUNKS) return json({ error: 'That clip is too large' }, 413);
    if (index >= count) return json({ error: 'Chunk index past the count' }, 400);

    const buf = await req.arrayBuffer();
    if (!buf || buf.byteLength === 0) return json({ error: 'Empty chunk' }, 400);
    if (buf.byteLength > MAX_CHUNK_BYTES) return json({ error: 'Chunk too large' }, 413);

    // The first chunk decides the container, by its bytes rather than by the
    // header the caller sent.
    let type = null;
    if (index === 0) {
      type = sniffVideoType(new Uint8Array(buf.slice(0, 16)));
      if (!type) return json({ error: 'Only MP4 or WebM clips are accepted' }, 415);
      await store.setJSON(`${id}/type`, { type, createdAt: Date.now() });
    }

    if (index === 0) await sweepOldClips(store);
    await store.set(chunkKey(id, index), buf, { metadata: { createdAt: Date.now() } });

    if (index < count - 1) return json({ received: index + 1, of: count });

    // Last chunk: measure every piece, and only then publish the manifest —
    // a GET that finds a manifest must find a whole file behind it.
    const sizes = [];
    for (let i = 0; i < count; i++) {
      const part = await store.get(chunkKey(id, i), { type: 'arrayBuffer' }).catch(() => null);
      if (!part) {
        console.error('[tik-video] a chunk never arrived; refusing to finish', { id, missing: i });
        return json({ error: `Upload incomplete (chunk ${i + 1} of ${count} missing)` }, 409);
      }
      sizes.push(part.byteLength);
    }
    const total = totalBytes(sizes);
    if (total > MAX_TOTAL_BYTES) {
      console.warn('[tik-video] clip over the size cap; dropping', { id, total });
      await deleteClip(store, id, count);
      return json({ error: 'That clip is too large' }, 413);
    }
    const stored = await store.get(`${id}/type`, { type: 'json' }).catch(() => null);
    await store.setJSON(manifestKey(id), {
      type: stored?.type || 'video/mp4',
      sizes,
      createdAt: Date.now(),
    });
    // Under the /tik prefix, so the ONE verified TikTok URL property that
    // already covers the slide images covers the clip too.
    return json({ url: `${url.origin}/tik/video/${id}`, id, bytes: total });
  }

  return json({ error: 'Method not allowed' }, 405);
};

async function deleteClip(store, id, count) {
  const keys = [manifestKey(id), `${id}/type`, ...Array.from({ length: count }, (_, i) => chunkKey(id, i))];
  await Promise.all(keys.map((k) => store.delete(k).catch(() => {})));
}

async function sweepOldClips(store) {
  try {
    const { blobs } = await store.list();
    const now = Date.now();
    await Promise.all(blobs.map(async (b) => {
      const meta = await store.getMetadata(b.key).catch(() => null);
      const createdAt = meta?.metadata?.createdAt ?? 0;
      // Manifests and type markers carry no metadata; fall back to reading them.
      const stamp = createdAt || (await store.get(b.key, { type: 'json' }).catch(() => null))?.createdAt || 0;
      if (stamp && now - stamp > MAX_AGE_MS) await store.delete(b.key).catch(() => {});
    }));
  } catch (e) {
    // Best-effort: never block an upload on cleanup, but say it happened.
    console.warn('[tik-video] clip sweep failed:', e.message);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
