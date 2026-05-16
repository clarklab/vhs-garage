# Netlify Database

Centralized log of every successful upload from the capture page.
Backed by Netlify's managed Neon Postgres.

## One-time setup

Provision the database from the project root:

```bash
netlify db init
```

That command:

- Creates the database on Netlify's side (auto-provisions, no env var
  needed — `getDatabase()` discovers it automatically)
- Runs the migrations under `netlify/database/migrations/`

After the first init, subsequent migration files in this folder will
be applied automatically on the next `netlify deploy` (or via
`netlify db migrate` ad-hoc).

## What's in the DB

A single `upload_logs` table — one row per successful upload from the
capture page. Inserted by `netlify/functions/log-upload.mjs`, which
is called fire-and-forget by the client right after each upload's PUT
completes.

Columns:

- **YouTube identity**: `video_id`, `video_url`, `visibility`, `channel_handle`, `uploaded_via_bridge` (always `false` now — kept for historical rows from when the bridge architecture was active)
- **Verified caller**: `uploader_email` (from Google tokeninfo — never trusted from the body)
- **Cross-reference**: `client_clip_id` (the local catalog ID — useful for finding the clip in a user's library)
- **Per-clip**: `title`, `description`, `tags`, `duration_seconds`, `byte_size`, `mime_type`
- **Per-tape**: `year`, `tape_title`, `distributor`, `tape_length`, `recording_speed`, `condition`, `cassette_notes`
- **Pipeline**: `ai_model` (which AI model was selected when this was uploaded)

## Why a separate Node function?

`@netlify/database` is Node-only and can't be imported from Edge
Functions (Deno runtime). `log-upload.mjs` is a regular Node function
the client calls independently after every successful upload.

## Querying ad-hoc

From the project root:

```bash
netlify db studio   # opens a web UI for browsing the DB
```

Or query from a one-off Node script using the same `getDatabase()`
helper used by `log-upload.mjs`.
