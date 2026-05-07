// log-upload — centralized upload logger backed by Netlify Database.
//
// Called by the client (fire-and-forget) after every successful upload's
// PUT completes — both bridge uploads (allowlisted users → VHS Garage)
// and direct uploads (personal channels). The bridge edge function
// can't reach Netlify Database directly because @netlify/database is
// Node-only (Edge runs Deno + can't import it), so this lives as a
// regular Node function and is called separately from the bridge.
//
// Auth model: caller sends their Google access token. We verify via
// Google's tokeninfo endpoint to recover the email. The `uploader_email`
// stored in the row is THAT verified email, not anything the body
// claimed — clients can't lie about who they are.
//
// All other fields are taken at face value from the body. They're
// metadata about an upload that ALREADY succeeded on YouTube; there's
// no integrity stake in cross-checking, e.g., the title against the
// actual YouTube video.
//
// Failures are silent (return 200 with `{ logged: false, reason }`)
// because this is a fire-and-forget call — a 500 here shouldn't make
// the user think their upload didn't work. The reason is always
// console.warn'd so we can debug from logs.

import { getDatabase } from '@netlify/database';

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'POST required' }, 405);
  }

  let body;
  try { body = await req.json(); }
  catch { return json({ logged: false, reason: 'invalid-json' }); }

  const { accessToken, videoId, videoUrl } = body;

  // Required fields. Anything else is best-effort.
  if (!videoId || !videoUrl) {
    return json({ logged: false, reason: 'missing-video-id-or-url' });
  }
  if (!accessToken) {
    // No token → can't verify uploader. Log anonymously rather than
    // refuse — better partial data than no data.
    return await insertLog({ ...body, verifiedEmail: null });
  }

  // Verify the caller's identity via Google's public tokeninfo
  // endpoint. Same approach the bridge uses for its allowlist check.
  let verifiedEmail = null;
  try {
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
    );
    if (res.ok) {
      const info = await res.json();
      verifiedEmail = info?.email?.toLowerCase() || null;
    }
  } catch (e) {
    console.warn('[log-upload] tokeninfo verify failed:', e.message);
    // Continue — we'll log without an email rather than dropping the row.
  }

  return await insertLog({ ...body, verifiedEmail });
};

async function insertLog(payload) {
  const {
    videoId,
    videoUrl,
    visibility = null,
    uploadedViaBridge = false,
    channelHandle = null,
    verifiedEmail = null,
    clientClipId = null,
    title = null,
    description = null,
    tags = null,
    durationSeconds = null,
    byteSize = null,
    mimeType = null,
    year = null,
    tapeTitle = null,
    distributor = null,
    tapeLength = null,
    recordingSpeed = null,
    condition = null,
    cassetteNotes = null,
    aiModel = null,
  } = payload;

  // Light sanitization — clamp ranges so a malicious or buggy client
  // can't poison the table with absurd values. duration capped at 12h
  // (matches the bridge's record-upload cap), bytes at 50GB.
  const dur = clampInt(durationSeconds, 0, 12 * 60 * 60);
  const bytes = clampBigInt(byteSize, 0, 50n * 1024n * 1024n * 1024n);

  try {
    const db = getDatabase();
    await db.sql`
      INSERT INTO upload_logs (
        video_id, video_url, visibility, uploaded_via_bridge,
        channel_handle, uploader_email, client_clip_id,
        title, description, tags,
        duration_seconds, byte_size, mime_type,
        year, tape_title, distributor, tape_length,
        recording_speed, condition, cassette_notes,
        ai_model
      ) VALUES (
        ${videoId}, ${videoUrl}, ${visibility}, ${!!uploadedViaBridge},
        ${channelHandle}, ${verifiedEmail}, ${clientClipId},
        ${title}, ${description}, ${tags},
        ${dur}, ${bytes}, ${mimeType},
        ${year}, ${tapeTitle}, ${distributor}, ${tapeLength},
        ${recordingSpeed}, ${condition}, ${cassetteNotes},
        ${aiModel}
      )
    `;
    return json({ logged: true, videoId });
  } catch (e) {
    console.warn('[log-upload] DB insert failed:', e.message);
    // Return 200 with logged: false so the client's fire-and-forget
    // doesn't surface a network error. The error is in our logs.
    return json({ logged: false, reason: 'db-error', detail: e.message });
  }
}

function clampInt(v, min, max) {
  const n = Math.floor(Number(v) || 0);
  if (!isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function clampBigInt(v, min, max) {
  // Allow numbers OR strings (BIGINT-safe transit). Returns a Number for
  // sql tagged-template (db.sql handles the cast); large values up to
  // Number.MAX_SAFE_INTEGER are fine for a 50GB cap.
  const n = typeof v === 'string' ? Number(v) : Number(v) || 0;
  if (!isFinite(n)) return null;
  const minN = Number(min);
  const maxN = Number(max);
  return Math.max(minN, Math.min(maxN, n));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
