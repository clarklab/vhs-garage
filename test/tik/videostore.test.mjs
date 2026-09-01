import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkCount, chunkKey, manifestKey, validUploadId, sniffVideoType, parseRange, rangeSlices, totalBytes,
  clipResponsePlan, CHUNK_BYTES, MAX_TOTAL_BYTES, MAX_CHUNKS,
} from '../../netlify/functions/lib/videostore.mjs';
import { validateVideoForInit, buildVideoInitPayload, MAX_VIDEO_BYTES } from '../../netlify/functions/lib/tiktok-video.mjs';

// ---- Chunking ----

test('a clip is cut into whole chunks, and a small one is still one chunk', () => {
  assert.equal(chunkCount(0), 1);
  assert.equal(chunkCount(10), 1);
  assert.equal(chunkCount(CHUNK_BYTES), 1);
  assert.equal(chunkCount(CHUNK_BYTES + 1), 2);
  assert.equal(chunkCount(CHUNK_BYTES * 3), 3);
});

test('the chunk budget covers the size cap', () => {
  assert.ok(MAX_CHUNKS * CHUNK_BYTES >= MAX_TOTAL_BYTES);
});

test('keys are namespaced per upload', () => {
  assert.equal(chunkKey('abc123-x', 4), 'abc123-x/4');
  assert.equal(manifestKey('abc123-x'), 'abc123-x/manifest');
});

test('an upload id that could be a path is rejected', () => {
  // The id becomes both a storage key and a public URL segment.
  assert.equal(validUploadId('7f3c9a12-4b5e-4c8d-9e2f-1a2b3c4d5e6f'), true);
  assert.equal(validUploadId('../../etc/passwd'), false);
  assert.equal(validUploadId('a/b'), false);
  assert.equal(validUploadId('has space'), false);
  assert.equal(validUploadId('short'), false);
  assert.equal(validUploadId(''), false);
  assert.equal(validUploadId(null), false);
  assert.equal(validUploadId('x'.repeat(65)), false);
});

// ---- Container sniffing ----

const mp4Head = () => {
  const b = new Uint8Array(16);
  b.set([0, 0, 0, 0x18], 0);
  b.set([...'ftypmp42'].map((c) => c.charCodeAt(0)), 4);
  return b;
};
const webmHead = () => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);

test('MP4 and WebM are recognised by their bytes, not by a header', () => {
  assert.equal(sniffVideoType(mp4Head()), 'video/mp4');
  assert.equal(sniffVideoType(webmHead()), 'video/webm');
});

test('anything else is not a clip', () => {
  assert.equal(sniffVideoType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), null, 'a JPEG is not a clip');
  assert.equal(sniffVideoType(new Uint8Array([0x3c, 0x73, 0x63, 0x72])), null, '"<scr" is not a clip');
  assert.equal(sniffVideoType(new Uint8Array([1, 2])), null, 'too short to tell');
  assert.equal(sniffVideoType(null), null);
});

// ---- Range requests ----

test('no range header means the whole file', () => {
  assert.equal(parseRange('', 1000), null);
  assert.equal(parseRange(null, 1000), null);
  assert.equal(parseRange('bytes=-', 1000), null);
  assert.equal(parseRange('items=0-10', 1000), null, 'a unit we do not speak is not a range');
});

test('a normal range is inclusive at both ends', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=500-999', 1000), { start: 500, end: 999 });
});

test('an open-ended range runs to the end of the file', () => {
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=0-99999', 1000), { start: 0, end: 999 }, 'clamped, not refused');
});

test('a suffix range is the last N bytes', () => {
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 }, 'longer than the file is the file');
});

test('a range past the end is a 416, not a silent full body', () => {
  assert.equal(parseRange('bytes=1000-1010', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=900-800', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 1000), 'unsatisfiable');
});

// ---- Stitching the chunks back together ----

const SIZES = [100, 100, 50]; // 250 bytes over three chunks

test('the whole file reads every chunk end to end', () => {
  assert.deepEqual(rangeSlices(SIZES, 0, 249), [
    { index: 0, from: 0, to: 100 },
    { index: 1, from: 0, to: 100 },
    { index: 2, from: 0, to: 50 },
  ]);
  assert.equal(totalBytes(SIZES), 250);
});

test('a range inside one chunk reads only that chunk', () => {
  assert.deepEqual(rangeSlices(SIZES, 110, 120), [{ index: 1, from: 10, to: 21 }]);
});

test('a range across a boundary reads the tail of one and the head of the next', () => {
  assert.deepEqual(rangeSlices(SIZES, 90, 109), [
    { index: 0, from: 90, to: 100 },
    { index: 1, from: 0, to: 10 },
  ]);
});

test('slices reconstruct exactly the bytes asked for', () => {
  // The real proof: rebuild the range from the slices and compare.
  const chunks = SIZES.map((n, i) => Uint8Array.from({ length: n }, (_, j) => (i * 100 + j) % 251));
  const whole = Uint8Array.from(chunks.flatMap((c) => [...c]));
  for (const [start, end] of [[0, 249], [0, 0], [249, 249], [99, 100], [45, 205], [100, 199]]) {
    const rebuilt = Uint8Array.from(
      rangeSlices(SIZES, start, end).flatMap((s) => [...chunks[s.index].slice(s.from, s.to)]),
    );
    assert.deepEqual(rebuilt, whole.slice(start, end + 1), `range ${start}-${end}`);
  }
});

test('a zero-length chunk is skipped without shifting the offsets', () => {
  assert.deepEqual(rangeSlices([100, 0, 50], 90, 119), [
    { index: 0, from: 90, to: 100 },
    { index: 2, from: 0, to: 20 },
  ]);
});

test('totalBytes survives junk', () => {
  assert.equal(totalBytes(null), 0);
  assert.equal(totalBytes([10, null, '5', undefined]), 15);
});

// ---- The TikTok video init call ----

test('the init payload is PULL_FROM_URL and nothing else', () => {
  // The inbox endpoint rejects post_info: the human titles the draft in the app.
  const payload = buildVideoInitPayload({ videoUrl: 'https://example.com/tik/video/abc' });
  assert.deepEqual(payload, { source_info: { source: 'PULL_FROM_URL', video_url: 'https://example.com/tik/video/abc' } });
  assert.equal('post_info' in payload, false);
});

test('only an https clip URL is publishable', () => {
  assert.equal(validateVideoForInit({ videoUrl: 'https://x.test/tik/video/a' }).ok, true);
  assert.equal(validateVideoForInit({ videoUrl: 'http://x.test/tik/video/a' }).ok, false);
  assert.equal(validateVideoForInit({ videoUrl: '' }).ok, false);
  assert.equal(validateVideoForInit({}).ok, false);
});

test('an empty or oversized clip is caught before TikTok sees it', () => {
  const url = 'https://x.test/tik/video/a';
  assert.equal(validateVideoForInit({ videoUrl: url, bytes: 0 }).ok, false);
  assert.equal(validateVideoForInit({ videoUrl: url, bytes: MAX_VIDEO_BYTES + 1 }).ok, false);
  assert.equal(validateVideoForInit({ videoUrl: url, bytes: 5_000_000 }).ok, true);
  assert.equal(validateVideoForInit({ videoUrl: url, bytes: null }).ok, true, 'an unknown size is not an error');
});


// ---- Serving the clip: what a video fetcher actually gets ----

const MANIFEST = { type: 'video/mp4', sizes: [100, 100, 50] };
// The stored chunks, and the file they are pieces of.
const CHUNKS = MANIFEST.sizes.map((n, i) => Uint8Array.from({ length: n }, (_, j) => (i * 100 + j) % 251));
const FILE = Uint8Array.from(CHUNKS.flatMap((c) => [...c]));
const streamed = (plan) => Uint8Array.from(plan.slices.flatMap((s) => [...CHUNKS[s.index].slice(s.from, s.to)]));

test('a plain GET streams the whole clip, with its real length and type', () => {
  const plan = clipResponsePlan({ manifest: MANIFEST });
  assert.equal(plan.status, 200);
  assert.equal(plan.headers['Content-Type'], 'video/mp4');
  assert.equal(plan.headers['Content-Length'], '250');
  assert.equal(plan.headers['Accept-Ranges'], 'bytes');
  assert.equal(plan.headers['X-Content-Type-Options'], 'nosniff');
  assert.deepEqual(streamed(plan), FILE, 'and the bytes are the file');
});

test('HEAD answers the size without a body', () => {
  // A video fetcher asks this before it asks for bytes.
  const plan = clipResponsePlan({ manifest: MANIFEST, method: 'HEAD' });
  assert.equal(plan.status, 200);
  assert.equal(plan.headers['Content-Length'], '250');
  assert.deepEqual(plan.slices, []);
});

test('a range request is a 206 with the right window and the right bytes', () => {
  const plan = clipResponsePlan({ manifest: MANIFEST, rangeHeader: 'bytes=90-119' });
  assert.equal(plan.status, 206);
  assert.equal(plan.headers['Content-Range'], 'bytes 90-119/250');
  assert.equal(plan.headers['Content-Length'], '30');
  assert.deepEqual(streamed(plan), FILE.slice(90, 120));
});

test('an open-ended range runs to the end of the clip', () => {
  const plan = clipResponsePlan({ manifest: MANIFEST, rangeHeader: 'bytes=200-' });
  assert.equal(plan.status, 206);
  assert.equal(plan.headers['Content-Range'], 'bytes 200-249/250');
  assert.deepEqual(streamed(plan), FILE.slice(200));
});

test('a range past the end is a 416 that says how long the clip is', () => {
  const plan = clipResponsePlan({ manifest: MANIFEST, rangeHeader: 'bytes=9999-' });
  assert.equal(plan.status, 416);
  assert.equal(plan.headers['Content-Range'], 'bytes */250');
  assert.deepEqual(plan.slices, []);
});

test('no manifest is a 404, not an empty 200', () => {
  // A half-finished upload writes chunks but no manifest; serving 0 bytes as a
  // success is how TikTok would end up rejecting a "valid" empty video.
  assert.equal(clipResponsePlan({ manifest: null }).status, 404);
  assert.equal(clipResponsePlan({ manifest: { type: 'video/mp4', sizes: [] } }).status, 404);
  assert.equal(clipResponsePlan({}).status, 404);
});

test('a manifest with no type still serves as video', () => {
  const plan = clipResponsePlan({ manifest: { sizes: [10] } });
  assert.equal(plan.headers['Content-Type'], 'video/mp4');
});
