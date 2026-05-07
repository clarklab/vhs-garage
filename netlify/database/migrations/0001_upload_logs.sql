-- Centralized log of every successful upload from the capture page.
-- Inserted by netlify/functions/log-upload.mjs on the fire-and-forget
-- call the client makes after each upload's PUT completes.
--
-- Captures BOTH bridge uploads (allowlisted users → VHS Garage channel)
-- and direct uploads (everyone else → their own channel). The
-- uploaded_via_bridge boolean disambiguates.
--
-- This is the SOURCE OF TRUTH for "what's been uploaded" — the
-- existing per-bridge blob stats in Netlify Blobs are a separate,
-- aggregate-only thing the admin dashboard reads. Both can coexist;
-- a future cleanup could collapse blob stats into a query against
-- this table.
--
-- All tape-metadata columns are TEXT (not nullable + typed) because
-- the values come from free-form user input — "1987-1989" is a real
-- year, "T-120 / T-160" is a real tape length. Better to keep them as
-- strings here and let downstream queries normalize when they care.

CREATE TABLE IF NOT EXISTS upload_logs (
  id                   SERIAL PRIMARY KEY,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- YouTube identity
  video_id             TEXT NOT NULL,
  video_url            TEXT NOT NULL,
  visibility           TEXT,
  uploaded_via_bridge  BOOLEAN NOT NULL DEFAULT FALSE,
  channel_handle       TEXT,

  -- Verified caller (from Google tokeninfo — never trusted from the body)
  uploader_email       TEXT,

  -- Cross-reference back to the per-browser catalog (vhsg_catalog
  -- localStorage entry). Useful for de-duping retries and for the
  -- "find this clip in the user's library" admin lookup.
  client_clip_id       TEXT,

  -- Per-clip metadata (the fields that change between every clip)
  title                TEXT,
  description          TEXT,
  tags                 TEXT,
  duration_seconds     INTEGER,
  byte_size            BIGINT,
  mime_type            TEXT,

  -- Per-tape metadata (typically shared across many clips from one tape)
  year                 TEXT,
  tape_title           TEXT,
  distributor          TEXT,
  tape_length          TEXT,
  recording_speed      TEXT,
  condition            TEXT,
  cassette_notes       TEXT,

  -- Pipeline traces — which AI model rewrote the metadata (if any)
  ai_model             TEXT
);

-- Indexes for the queries we expect to run:
--   · "what was uploaded today" → created_at DESC
--   · "what did Matt upload" → uploader_email
--   · "look up by YouTube video" → video_id
--   · "find duplicate retries" → client_clip_id
CREATE INDEX IF NOT EXISTS upload_logs_created_at_idx
  ON upload_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS upload_logs_uploader_email_idx
  ON upload_logs (uploader_email);
CREATE INDEX IF NOT EXISTS upload_logs_video_id_idx
  ON upload_logs (video_id);
CREATE INDEX IF NOT EXISTS upload_logs_client_clip_id_idx
  ON upload_logs (client_clip_id);
