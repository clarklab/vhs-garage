# Quote-a-long — IMDb quotes over matched movie frames

Date: 2026-08-20
Status: approved

## Background

Tape Trivia is a TikTok photo slideshow of deep-cut facts over frames from a
local movie file. `/tik` already has a single-maker Autopilot, a Batch
Write → Shoot factory, compose (1080×1920 caption pills), and IMDb GraphQL
for ranked trivia. Quote-a-long is the same factory pointed at **famous
lines** instead of trivia, with one new step: match each line to an English
OpenSubtitles file so thumbs are sought from **timecode math**, not Claude
vision.

About 85% of this already ships. Trivia, Guys, and Year must keep working
exactly as they do.

## Goals

- A fourth format, `quotes`, labeled **Quote-a-long**.
- Single maker: home card → same movie-file editor as Tape Trivia.
- Batch maker: a Trivia | Quotes toggle on the existing Write screen.
- Ranked IMDb quotes → LLM boils them into 8 tight captions → English SRT
  match → grab frames at the first quarter of each matched span.
- Reuse editor, compose, library, Ready, publish, Shoot file matching.

## Non-goals

- Claude vision / contact sheets for Quote-a-long, including unmatched guesses.
- Scraping `www.imdb.com/title/tt…/quotes/` (that host 202s from Netlify;
  trivia already solved this with GraphQL).
- A second video editor pane.
- Batch curate (the trivia “pick the best facts” agent). Quotes take the
  top-voted IMDb items and let Autopilot format them.
- Instagram Reels, video slides, or burned-in karaoke video.
- New npm dependencies.

## What a post is

Deck: **title + 8 quote slides + outro**.

| Slide | Caption | Frame |
|-------|---------|--------|
| Title | Movie name only (no hook sentences) | Autopilot title-card timecode, same as Trivia |
| Quotes × 8 | One or two spoken lines. Character name only when it helps. Short enough for one caption block. | First quarter of the matched subtitle span, or an LLM-guessed time if unmatched |
| Outro | Existing rotating CTA pool, with `more movie quotes` as the follow line | VHS Garage logo |

The LLM writes every caption. IMDb is the source; the model boils a long
exchange down to the punchline. Subtitle files do not have character names
or IMDb formatting — matching must ignore both.

### Title stamp

`compose.js` draws a big **QUOTE-A-LONG** overlay on the title slide’s
**frame** (not a caption pill) when `format === 'quotes'` and the slide is
the title. VHS / ticket energy, slightly rotated, contrasting fill, large
enough to read at TikTok size. Baked into the JPEG so preview and publish
match. Quote slides and the outro get no stamp.

### Caption size

Quote slides set `fontScale` from caption length so a one-liner sits bigger
than Trivia’s default 54px and a two-liner sits smaller. A pure helper
`fontScaleForQuote(text)` maps character count, then compose’s existing
fit-guard still prevents overflow. Clamp stays 0.5–1.6. The editor slider
can override. Title and outro stay at `fontScale: 1`.

Suggested mapping (locked enough to implement, tune in tests):

- ≤ 40 characters → 1.35
- ≤ 80 → 1.15
- ≤ 140 → 1.0
- else → 0.85

### TikTok meta

Title format is load-bearing, like Trivia:

`{Movie} — movie quotes`

Trivia’s `{Movie} — movie trivia & behind-the-scenes facts` must not change.
`parsePostedMovie()` in `netlify/functions/lib/queue.mjs` keeps reading
Trivia titles only. A sibling parser (or a format argument) reads the quotes
pattern. Batch “Pick 10” skips a film already posted **in the active
format**. Posting Trivia for *The Thing* does not block Quote-a-long for
*The Thing*, and the reverse is also true.

Description + five hashtags reuse `hashtags.js`. Autopilot still returns
`hook` / `filmTags` / `songs`. No new house set — Quotes must not shuffle
Trivia’s tag-report lanes. The quotes prompt asks for a quotes-flavored
film tag when it is natural (`moviequotes` or a line-specific tag).

## Architecture

One Autopilot job, `kind: 'quotes'`. Same background-function pattern as
Trivia.

```
movie identity
  → tik-imdb action=quotes   (GraphQL, ranked, cached)
  → tik-subtitles            (OpenSubtitles English SRT, cached)
  → tik-autopilot kind=quotes (captions + cue spans + guessed fallbacks + meta)
  → grab at start + 0.25*(end-start)   (no vision)
  → editor / compose / publish
```

Batch Write does the same, saves `format: 'quotes'` with placeholder
frames and `batch.pendingFrames: true`. Shoot matches the folder, seeks,
grabs, and clears `pendingFrames`. Shoot never calls `tik-vision` for
quotes drafts.

### Format registry

Add to `FORMATS` in `public/scripts/tik/project.js`:

- `key: 'quotes'`
- `label: 'Quote-a-long'`
- `tagline: 'Famous lines over the frames they were spoken on'`
- Distinct accent from Trivia’s amber (recommendation: rose / red)
- `OUTRO_MORE.quotes = 'more movie quotes'`
- `defaultPostFields('quotes', movie)` → `{Movie} — movie quotes`

`formatOf()` already falls back to trivia for unknown keys; old library
records are unaffected.

### IMDb quotes

Extend `netlify/functions/lib/imdb.mjs` with a quotes query mirroring
trivia: `title.quotes` connection, `text.plainText`, `interestScore`,
`isSpoiler`, pagination. `normalizeQuote` / `rankQuotes` reuse the trivia
score (up minus down, stable id/text ties).

`tik-imdb` gains `action: 'quotes'` (`imdbId` or `query`+`year`), cached
in the existing `tik-imdb` Blobs store under a `quotes:` key prefix so
trivia and quotes caches never collide.

If the GraphQL field names differ from trivia, probe once and keep the
normalized `{ id, text, up, down, score, spoiler }` shape. Do not scrape
the HTML quotes page.

Autopilot receives more than 8 ranked quotes (a pool of ~20 is enough) so
it can skip unusable blocks and still land 8 slides.

### OpenSubtitles

New Netlify function + `lib/opensubtitles.mjs`. Env var is exactly
`OpenSubtitles` (already set in Netlify). Server-only; the browser never
sees the key.

- `GET https://api.opensubtitles.com/api/v1/subtitles?imdb_id=<numeric>&languages=en`
- Header `Api-Key: process.env.OpenSubtitles`
- Required `User-Agent` identifying this app (e.g. `vhs-garage v1.0`)
- IMDb id is numeric (`103064`), not `tt0103064`
- Prefer English, not machine/AI translated, highest download count / trusted
- `POST /api/v1/download` with the chosen `file_id`, then GET the returned link
- Parse SRT (and `.srt` inside a zip if that is what comes back) into
  `{ start, end, text }` cues in seconds
- Cache parsed cues in Blobs keyed by IMDb id (24h+, same idea as trivia)
  so a batch of ten does not burn ten downloads on retry

If search, auth, quota, or parse fails: Autopilot still runs with quotes
and **no cue list**, and guesses every timecode. Status text must say the
thumbs are guesses. Do not fail the draft solely because subtitles missed.

If the download endpoint requires a user login this key does not provide,
that is the same miss: log it, proceed without SRT. Do not invent extra
env vars in this spec.

### Matching and seek

Autopilot sees the cue list and the boiled captions in one prompt. It
returns each quote slide as `{ caption, start, end, timecode, grab, fontScale }`
where `timecode` is the seek point.

Seek rule (pure, unit-tested, applied client-side even if the model also
returns a time):

```
timecode = start + 0.25 * (end - start)
```

A quote that spans several cues uses the first cue’s `start` and the last
cue’s `end`. Unmatched quotes keep the caption; `start`/`end` are omitted
and `timecode` is the model’s guess.

A small pure matcher can pre-tag obvious cue hits (strip speaker labels,
punctuation, case) and pass those hints into the prompt. The model is
still the authority. Unmatched ≠ drop the quote.

### Shoot / grab

No `tik-vision`. `grabVerifiedFrame` is not used for `format === 'quotes'`.
Seek, wait for settle, `grabFrame`. The existing local blank-frame nudge
in `frameStats` is allowed; that is not vision.

Batch Shoot’s draft filter becomes “`pendingFrames` and format is trivia
**or** quotes”, branching the grab path on format.

## Screens

**Home.** New card `#new-quotes` in the format grid. Batch card is
unchanged in role: it is the factory, not a format.

**Editor.** Reuse `#pane-trivia` (file input, scrubber, Grab, Autopilot,
paste box). `applyFormatUI()` maps `quotes` to that pane. Copy, Autopilot
`kind`, and title-stamp drawing switch on `project.format`. The paste box
accepts a hand-picked quote list as Autopilot guidance, same as trivia
paste.

**Batch Write.** Segmented **Trivia | Quotes** control at the top of the
Write chrome, before the movie queue. Quotes still uses the existing pool
list UI; the rows are quote texts instead of trivia facts. The toggle
switches:

- source (IMDb trivia pool vs IMDb quotes; quotes skip `tik-curate`)
- Autopilot `kind`
- saved `project.format`
- post-title pattern
- “already posted” skip list (trivia titles vs quotes titles)
- queue prompt: Quotes “Pick 10” asks for films people actually quote,
  and is given the quotes skip list, not the trivia one

**Batch Shoot.** Existing screen. Quotes rows seek-and-grab only; no
vision badge / contact-sheet path.

## Failure modes

Quotes failures stay on the Quotes path. Trivia / Guys / Year are
untouched.

| Miss | Behavior |
|------|----------|
| No IMDb quotes | Autopilot errors clearly. No empty draft. Batch marks that movie failed and continues. |
| OpenSubtitles miss / quota / bad key | Write continues; all times are guesses; status says so. |
| Quote unmatched to a cue | Keep the quote; guessed timecode; no vision. |
| Batch Write, no file yet | Placeholders + `pendingFrames`, same as Trivia. |
| Shoot, no file match | Leave the placeholder. |
| Blank / letterbox grab | Local `frameStats` nudge only. |
| Stamp or fontScale miss | Publish anyway; fontScale 1. |

## Testing

`node --test 'test/tik/**/*.test.mjs'`. Pure helpers, no live IMDb or
OpenSubtitles in CI.

- Quotes normalize/rank: same score as trivia, stable ties, spoiler flag
  carried not auto-dropped.
- SRT parse + seek: fixture file; `start + 0.25*(end-start)`; multi-cue
  span; empty/malformed → `[]`.
- Text normalize for matching: `"I'll be back."` equals a cue `I'll be back`;
  speaker labels stripped.
- `fontScaleForQuote`: short > 1; long < 1; clamp 0.5–1.6.
- `FORMATS.quotes`, default title `{Movie} — movie quotes`, outro more-line,
  queue parser: quotes title is not Trivia coverage and vice versa.
- Stamp helper: only quotes title slides request the overlay.
- Batch: Quotes Write saves `format: 'quotes'` and Shoot skips vision;
  existing Trivia tests stay green.
- Autopilot prompt fixture next to the trivia one (`kind: 'quotes'`).

## Files (expected)

Create:

- `netlify/functions/tik-subtitles.mjs`
- `netlify/functions/lib/opensubtitles.mjs`
- `netlify/functions/lib/srt.mjs` (parse + seek)
- `test/tik/opensubtitles.test.mjs`, `test/tik/srt.test.mjs`,
  `test/tik/quotes.test.mjs`

Modify:

- `public/scripts/tik/project.js` — `FORMATS`, outro, default titles
- `public/scripts/tik/compose.js` — title stamp
- `public/scripts/tik/caption.js` — `fontScaleForQuote`
- `public/scripts/tik/app.js`, `src/pages/tik.astro` — home card, pane map
- `public/scripts/tik/autopilot.js` + `netlify/functions/lib/autopilot.mjs`
  + `tik-autopilot-job-background.mjs` — `kind: 'quotes'`
- `netlify/functions/lib/imdb.mjs` + `tik-imdb.mjs` — quotes action
- `public/scripts/tik/batch.js`, `shoot.js` — toggle + no-vision grab
- `netlify/functions/lib/queue.mjs` — quotes title parse, format-scoped skip
- `public/scripts/tik/hashtags.js` — house sets stay put; quotes uses the
  same five-tag builder as trivia (`hook` + `filmTags` + rotated house set)
- Existing tests listed above

## Success

A Quote-a-long draft for a movie with IMDb quotes and an English subtitle
file produces 10 slides (title + 8 + outro), captions that read as spoken
lines, thumbs grabbed from subtitle math, a stamped title card, and a
TikTok title `{Movie} — movie quotes` — from both the single maker and
Batch, without regressing Tape Trivia.
