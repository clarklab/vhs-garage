// log-upload-failure — companion to log-upload.mjs that records every
// upload attempt that DIDN'T succeed. Called fire-and-forget by the
// client from runUploadItem()'s catch handler.
//
// The motivation: a bare-network "Failed to fetch" TypeError on the
// resumable-upload init call goes browser → googleapis.com directly,
// so it never lands anywhere we can see. Without a beacon we have
// zero visibility into how often / why uploads die. This function is
// the beacon's server side.
//
// Auth model mirrors log-upload: caller MAY include their Google
// access token; if present we verify via Google's tokeninfo and store
// the verified email on the row. Missing or invalid token → email is
// NULL (not a refusal — we'd rather log the failure anonymously than
// drop it, since the whole point is visibility).
//
// All other fields are taken at face value from the body — this is
// telemetry from the user's own session about their own upload, so
// there's no integrity stake.
//
// Always returns 200 (with a logged-boolean payload) so the client's
// fire-and-forget call never makes the user think a second thing
// failed on top of the original upload failure.

import { getDatabase } from '@netlify/database';

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'POST required' }, 405);
  }

  let body;
  try { body = await req.json(); }
  catch { return json({ logged: false, reason: 'invalid-json' }); }

  const { accessToken } = body;

  let verifiedEmail = null;
  if (accessToken) {
    try {
      const res = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
      );
      if (res.ok) {
        const info = await res.json();
        verifiedEmail = info?.email?.toLowerCase() || null;
      }
    } catch (e) {
      console.warn('[log-upload-failure] tokeninfo verify failed:', e.message);
      // Continue — log the failure without an email rather than dropping it.
    }
  }

  return await insertFailure({ ...body, verifiedEmail });
};

async function insertFailure(payload) {
  const {
    clientClipId = null,
    clipTitle = null,
    clipByteSize = null,
    clipDurationSeconds = null,
    clipMimeType = null,
    stage = null,
    httpStatus = null,
    youtubeReason = null,
    errorName = null,
    errorMessage = null,
    navigatorOnline = null,
    userAgent = null,
    verifiedEmail = null,
  } = payload;

  // Clamp/normalize the few numeric fields. Same bounds as log-upload
  // for consistency (12h duration cap, 50GB byte cap).
  const dur = clampInt(clipDurationSeconds, 0, 12 * 60 * 60);
  const bytes = clampBigInt(clipByteSize, 0, 50n * 1024n * 1024n * 1024n);
  const status = httpStatus == null ? null : clampInt(httpStatus, 0, 599);
  // Trim long free-form fields so a runaway stack trace can't blow up
  // the row. 2KB is generous — error messages are usually one line.
  const errMsg = truncate(errorMessage, 2048);
  const ua = truncate(userAgent, 512);

  try {
    const db = getDatabase();
    await db.sql`
      INSERT INTO upload_failures (
        uploader_email, client_clip_id, clip_title,
        clip_byte_size, clip_duration_seconds, clip_mime_type,
        stage, http_status, youtube_reason,
        error_name, error_message,
        navigator_online, user_agent
      ) VALUES (
        ${verifiedEmail}, ${clientClipId}, ${clipTitle},
        ${bytes}, ${dur}, ${clipMimeType},
        ${stage}, ${status}, ${youtubeReason},
        ${errorName}, ${errMsg},
        ${navigatorOnline}, ${ua}
      )
    `;
    return json({ logged: true });
  } catch (e) {
    console.warn('[log-upload-failure] DB insert failed:', e.message);
    return json({ logged: false, reason: 'db-error', detail: e.message });
  }
}

function clampInt(v, min, max) {
  const n = Math.floor(Number(v) || 0);
  if (!isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function clampBigInt(v, min, max) {
  const n = typeof v === 'string' ? Number(v) : Number(v) || 0;
  if (!isFinite(n)) return null;
  const minN = Number(min);
  const maxN = Number(max);
  return Math.max(minN, Math.min(maxN, n));
}

function truncate(v, max) {
  if (typeof v !== 'string') return null;
  return v.length > max ? v.slice(0, max) : v;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
