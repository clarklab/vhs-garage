-- Companion to upload_logs: every upload attempt that DIDN'T succeed
-- gets a row here. Inserted by netlify/functions/log-upload-failure.mjs,
-- called fire-and-forget by the client when runUploadItem() throws.
--
-- Why a separate table: the resumable-upload init fetch goes browser →
-- googleapis.com directly, so when it dies with a bare "Failed to fetch"
-- TypeError, the request never touches our infra and Netlify logs are
-- blind to it. This table is the visibility layer for those failures
-- (and for the rest of the error surface — HTTP error responses from
-- YouTube, PUT-stage network drops, local file-read failures, etc.).

CREATE TABLE IF NOT EXISTS upload_failures (
  id                    SERIAL PRIMARY KEY,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Verified caller (from Google tokeninfo, same flow as upload_logs).
  -- NULL when the failure happened before/without a usable token.
  uploader_email        TEXT,

  -- Local catalog cross-reference, lets us find the source clip in the
  -- user's library when debugging.
  client_clip_id        TEXT,
  clip_title            TEXT,
  clip_byte_size        BIGINT,
  clip_duration_seconds INTEGER,
  clip_mime_type        TEXT,

  -- Where in the flow we died:
  --   'init'    — POST to googleapis.com /upload/youtube/v3/videos
  --   'put'     — the resumable PUT of the file body (XHR)
  --   'parse'   — PUT returned 2xx but body was unparseable
  --   'unknown' — anything else (clip-not-found, captureStream, ...)
  stage                 TEXT,
  -- HTTP status if we got one. NULL for bare-network failures
  -- ("Failed to fetch") where the request never made it to the wire.
  http_status           INTEGER,
  -- YouTube API reason code when the response parsed (e.g.
  -- uploadLimitExceeded, quotaExceeded, invalidVideoMetadata).
  youtube_reason        TEXT,

  -- Raw error from the thrown Error. error_name is typically "TypeError"
  -- for the bare-network class of failure; error_message is the verbatim
  -- browser string ("Failed to fetch", "NetworkError when attempting to
  -- fetch resource", "Load failed", etc.).
  error_name            TEXT,
  error_message         TEXT,

  -- Client context that matters for diagnosing connectivity issues.
  navigator_online      BOOLEAN,
  user_agent            TEXT
);

-- Indexes for the queries we expect to run:
--   · "what failed today" → created_at DESC
--   · "what's Matt been hitting" → uploader_email
--   · "where are uploads dying most" → stage
CREATE INDEX IF NOT EXISTS upload_failures_created_at_idx
  ON upload_failures (created_at DESC);
CREATE INDEX IF NOT EXISTS upload_failures_uploader_email_idx
  ON upload_failures (uploader_email);
CREATE INDEX IF NOT EXISTS upload_failures_stage_idx
  ON upload_failures (stage);
