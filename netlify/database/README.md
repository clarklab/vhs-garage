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

Captures both bridge uploads (allowlisted users → VHS Garage channel)
and direct uploads (everyone else → their own channel). The
`uploaded_via_bridge` boolean disambiguates.

Columns:

- **YouTube identity**: `video_id`, `video_url`, `visibility`, `uploaded_via_bridge`, `channel_handle`
- **Verified caller**: `uploader_email` (from Google tokeninfo — never trusted from the body)
- **Cross-reference**: `client_clip_id` (the local catalog ID — useful for finding the clip in a user's library)
- **Per-clip**: `title`, `description`, `tags`, `duration_seconds`, `byte_size`, `mime_type`
- **Per-tape**: `year`, `tape_title`, `distributor`, `tape_length`, `recording_speed`, `condition`, `cassette_notes`
- **Pipeline**: `ai_model` (which AI model was selected when this was uploaded)

## Why a separate Node function?

`@netlify/database` is Node-only. Our existing `youtube-bridge` is an
Edge function (Deno runtime), so it can't import the package directly.
The `log-upload.mjs` Node function exists specifically to bridge the
gap — the client calls it independently after every successful upload.

The bridge's existing `record-upload` action (which writes aggregate
stats to Netlify Blobs for the admin dashboard) stays as-is. Both
paths can coexist; a future cleanup could collapse blob stats into
SQL queries against `upload_logs`.

## Querying ad-hoc

From the project root:

```bash
netlify db studio   # opens a web UI for browsing the DB
```

Or query from a one-off Node script using the same `getDatabase()`
helper used by `log-upload.mjs`.
