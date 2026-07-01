# /tik — movie-trivia TikTok slideshow maker

**Date:** 2026-07-01
**Status:** Approved (draft-to-inbox MVP; Layout A; responsive two-pane/stacked)

## Background

We want a dead-simple way to turn a local movie file into a TikTok
photo slideshow of trivia cards: scrub the video, grab a few frames,
type a trivia caption for each, and push the whole thing to TikTok as
a proper slideshow post. Today there's nothing like this — `capture.astro`
is a heavy VHS-to-YouTube pipeline (ffmpeg.wasm, live capture). `/tik`
is deliberately separate: **standalone, no new npm dependencies**, no
coupling to the capture station.

The one hard external constraint is TikTok's Content Posting API. Photo
slideshows can **only** be created via `PULL_FROM_URL` — TikTok fetches
each image from a public HTTPS URL on a domain the app owner has verified
in the developer portal. There is no direct byte upload for photos (that
exists only for video). So finished slides must be hosted publicly before
the post call. We host them in **Netlify Blobs**, served from the deployed
site's own domain.

## Goals

- A new standalone page `/tik` that lets a user:
  1. Pick a local video file.
  2. Use a chunky scrubber to pick frames and **grab** them.
  3. Type a caption (trivia) into a textarea for each grab.
  4. Post the set to TikTok as a slideshow, in one click.
- Make generating movie-trivia posts trivially easy.
- No new npm dependencies. All image work happens client-side on `<canvas>`.
- Reuse the existing OAuth-via-Netlify-function pattern (mirrors
  `youtube-auth.mjs` / `youtube-publish.mjs`).

## Non-goals (YAGNI)

- **Video slides.** Photos only.
- **Direct public posting** (`DIRECT_POST`). MVP posts a private **draft
  to the creator's TikTok inbox**; they finish and publish in the app.
  Direct-to-feed requires an audited app + approved scopes and is deferred.
- **AI-generated trivia**, scheduling, multi-account, analytics.
- **Server-side image compositing.** Would need an image library (sharp),
  violating the no-deps rule. Everything is composited in the browser.

## TikTok API facts this design is built on

Verified against `developers.tiktok.com` (2026-07-01):

- **Init endpoint:** `POST https://open.tiktokapis.com/v2/post/publish/content/init/`
  - `media_type: "PHOTO"`, `post_mode: "MEDIA_UPLOAD"` (draft to inbox).
  - `post_info`: `title` (≤90 UTF-16 runes, optional), `description`
    (≤4000, optional). In draft mode these are prefilled hints; the creator
    edits them in-app.
  - `source_info`: `source: "PULL_FROM_URL"`, `photo_images: [url, …]`
    (up to **35**), `photo_cover_index` (0-indexed).
  - Returns a `publish_id`.
- **Status endpoint:** `POST https://open.tiktokapis.com/v2/post/publish/status/fetch/`
  with `publish_id`, polled until the draft lands.
- **Scope:** `video.upload` (covers photo drafts) plus `user.info.basic`.
- **Unaudited app:** all posts are forced to **private** viewing mode
  (per the content-posting reference; error
  `unaudited_client_can_only_post_to_private_accounts`). Separately, an app
  still in **sandbox** / not yet approved for the scope can only be used by
  TikTok accounts added as **target users / testers** in the developer
  portal. Both align with the draft-to-inbox MVP.
- **PULL_FROM_URL:** image URLs must be `https`, must not redirect, must
  stay reachable for up to 1 hour, and must sit under a domain/URL-prefix
  verified under the app's **URL properties**. This is why `/tik` is a
  **deployed-Netlify tool**: TikTok's servers pull the images over the
  public internet, so the hosting URLs must be the deployed site's public
  domain. Grab / caption / compose work anywhere; the post handoff runs
  against the deploy. See **Deployment & environments** below.

## Architecture

One page + three thin functions. The browser does all image work; the
functions only do what the browser cannot (hold the OAuth secret, host
the JPEGs publicly, call TikTok).

```
src/pages/tik.astro          # standalone client-side app
netlify/functions/
  tik-auth.mjs               # OAuth: client_key + PKCE code exchange / refresh / revoke
  tik-media.mjs              # POST stores a JPEG in Netlify Blobs; GET streams it back publicly
  tik-publish.mjs            # refresh->access token, init draft, poll status
```

### Data flow

```
local file
  → <video> (object URL)
  → chunky scrubber sets currentTime
  → Grab: drawImage(video) to offscreen canvas  ── slide { id, bitmap, caption }
  → per-slide compose: 1080x1920 canvas (frame letterboxed + caption band) → JPEG blob
  → POST each JPEG to tik-media  → Netlify Blob → public GET URL
  → POST { photoUrls, refreshToken } to tik-publish
      → getAccessToken(refresh)
      → content/init (media_type PHOTO, MEDIA_UPLOAD, PULL_FROM_URL)
      → poll status/fetch until draft ready
  → "Draft is in your TikTok inbox"
```

## Components

### 1. Capture (client-side)

- `<input type="file" accept="video/*">` → `URL.createObjectURL` → `<video>`.
  Anything the browser can decode can be grabbed (VHS captures are H.264
  mp4 — fine). If a file won't play, surface a clear "browser can't decode
  this file" message.
- **Chunky scrubber:** a large custom control bound to `video.currentTime`
  (big draggable knob, tall hit area), a timecode readout (`mm:ss.mmm`),
  and frame-step buttons (± ~1/30s). Space/arrow keyboard nudge.
- **Grab** draws the current video frame to an offscreen canvas at the
  video's native resolution and creates a slide.

### 2. Slide model & captions

- A slide is `{ id, sourceBitmap, caption }`. State is an ordered array;
  reducers (add, remove, reorder, editCaption) are pure and unit-tested.
- **One caption `<textarea>` per slide**, exactly as requested.
- Optional single global **"movie title"** line (toggle, default off) that
  prefixes every slide's band — trivia posts usually repeat the title.
- Hard cap **35 slides**; the Grab button disables at the limit with a note.

### 3. Slide compositing (Layout A) — client-side canvas

For each slide, render a **1080×1920** canvas:
- Black background.
- The frame drawn **letterboxed** across the top — full width, preserving
  aspect, never cropped.
- A **solid caption band** below holding the wrapped caption text (plus the
  optional title line). Text wrapping / line-breaking / auto-fit font size
  is a pure function, unit-tested.
- Exported via `canvas.toBlob(..., 'image/jpeg', q)`. A live preview of the
  composed slide shows in the slide list.

### 4. Layout (responsive)

- **Desktop (default):** two panes — capture (player + scrubber) on the
  left, slide list (thumbnail + caption textarea, drag-to-reorder) on the
  right. Post bar with the single **Post to TikTok** button.
- **Mobile:** the same parts collapse to one vertical column.

### 5. Auth — `tik-auth.mjs`

Mirrors `youtube-auth.mjs`:
Uses TikTok's **Login Kit for Web** flow (no PKCE — `/tik` is a server-backed
confidential client that holds the secret):
- `GET` → returns public `TIKTOK_CLIENT_KEY` so the browser builds the
  authorize URL (`https://www.tiktok.com/v2/auth/authorize/`, params
  `client_key`/`scope`/`response_type=code`/`redirect_uri`/`state`,
  scopes `user.info.basic,video.upload`).
- `POST action=exchange` → swaps the returned `code` at
  `https://open.tiktokapis.com/v2/oauth/token/` for access + refresh tokens
  using `TIKTOK_CLIENT_KEY` + `TIKTOK_CLIENT_SECRET`.
- `POST action=refresh` / `action=revoke` → refresh an access token / revoke.
- Refresh token persisted in `localStorage` (same trust model as YouTube).

> Not PKCE: TikTok documents `code_challenge` only for its Desktop/Mobile
> flow, and requires a *hex*-encoded challenge there (not base64url). A
> server-backed web app uses the Web flow and authenticates the exchange
> with the client secret.

### 6. Media hosting — `tik-media.mjs`

- `POST` (image bytes) → write to Netlify Blobs under a random id →
  return `{ url }` where `url` is this function's own
  `GET ?id=<id>` on the deployed domain.
- `GET ?id=<id>` → stream the JPEG bytes with `Content-Type: image/jpeg`,
  no redirect (TikTok forbids redirects). 
- Blobs are short-lived: tagged with a timestamp and cleaned up (TTL sweep
  on write, and/or deleted after a successful post).

### 7. Publish — `tik-publish.mjs`

- Body `{ refreshToken, photoUrls, coverIndex, title?, description? }`.
- `getAccessToken(refreshToken)` (refresh grant).
- `POST /v2/post/publish/content/init/` with the PHOTO / MEDIA_UPLOAD /
  PULL_FROM_URL payload.
- Poll `POST /v2/post/publish/status/fetch/` with the returned `publish_id`
  a bounded number of times; return terminal status to the browser.
- Surfaces clear errors (unverified domain, unregistered tester, expired
  token → re-auth).

## Error handling

- **Undecodable file** → explicit message, no crash.
- **Not signed in / expired token** → prompt re-auth; `tik-publish` returns
  401 the UI maps to "sign in again."
- **Domain not verified / tester not registered** → TikTok's error surfaced
  verbatim with a one-line hint pointing at the developer-portal setup.
- **> 35 slides** → prevented in the UI.
- **Post attempted from a non-public origin** (e.g. `localhost`) → the UI
  notes TikTok can't reach non-public image URLs and points the user to
  the deployed site; capture/caption/compose are unaffected.

## Configuration / setup (documented, not code)

- Env vars: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`.
- TikTok developer app: add the deployed domain under **URL properties**;
  register test TikTok accounts; request `video.upload` scope.

## Testing

- **Unit (pure functions):** caption wrapping/line-break/auto-fit,
  timecode formatting, slide-array reducers (add/remove/reorder/edit),
  the TikTok init payload builder, cover-index/35-slide validation.
- **Manual (against a deployed preview):** the actual grab-from-`<video>`,
  canvas compositing pixels, OAuth round-trip, blob hosting, and the live
  TikTok init + status poll landing a real draft in a test account's inbox.

## Deployment & environments

`/tik` is designed to run on the **deployed Netlify site** — that's the
normal, fully-functional mode, not a fallback:

- **Deployed (production / branch deploy):** everything works, including
  the TikTok post. The three functions run on Netlify, `tik-media` serves
  the JPEGs from the site's public HTTPS domain, and TikTok pulls them.
  This is the intended way the tool is used.
- **Local dev (`astro dev` / `netlify dev`):** capture, caption, and
  compositing work fully; the *post* step is the one thing that needs a
  public origin, so it's validated on a deploy. For local end-to-end
  testing of the post, use a Netlify **branch/deploy preview** whose URL
  prefix is verified in the TikTok app, or a public tunnel.

**One-time TikTok setup** (documented for the operator): create the
developer app, set `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` in Netlify
env, add the deployed domain under **URL properties**, register test
TikTok accounts, and request the `video.upload` scope.

## Rollout

Ship the page + functions. Capture/caption/compose are usable immediately
for producing the JPEGs; the TikTok post goes live once the one-time app
setup above is done. Keep `/tik` unlinked from main nav until then.
