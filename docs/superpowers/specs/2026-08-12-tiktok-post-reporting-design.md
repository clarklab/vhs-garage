# Post-level reporting from the TikTok Display API

2026-08-12

## The problem

The studio reported one number: the follower count. Everything else the
Display API will tell us about the account went unread, and the one panel that
did try to read it — the hashtag report — had never once rendered.

Two separate causes, both fixed here.

**The scope was never requested.** `HISTORY_SCOPE` (`…,video.list`) was defined
in `auth.js` and had zero call sites. Every sign-in authorized without it, so
`tik-history` 403'd every time and the panel latched itself hidden. No amount
of developer-portal approval would have changed that.

**Post stats were fetched and thrown away.** TikTok reports only a post's
CURRENT totals — there is no per-post history endpoint, the same limitation
`lib/stats.mjs` already works around for the follower count. Lifetime totals
alone cannot answer whether a post is still earning views, and any ranking
built on them is partly just a ranking of post age.

## What is and is not possible, verified 2026-08-12

Confirmed against the current Display API docs, not from memory.

**Available and now used.** `/v2/user/info/`: `display_name`, `avatar_url`,
`follower_count`, `following_count`, `likes_count`, `video_count` — all under
scopes we already hold. `/v2/video/list/` (Video Object): `id`, `title`,
`video_description`, `create_time`, `duration`, `cover_image_url`, `share_url`,
`view_count`, `like_count`, `comment_count`, `share_count`.

**Available, deliberately not used.** `username`, `is_verified`,
`bio_description`, `profile_deep_link` need `user.info.profile`, a scope this
app does not hold. TikTok rejects the ENTIRE authorize request when an app asks
for a scope it lacks, so adding it to sign-in would take publishing down with
it. Not worth it for a username. `height`/`width` are 1080×1920 on every post;
`embed_html`/`embed_link` have no use here.

**Not available at all.** Watch time, completion rate, reach, traffic source,
audience demographics, profile views, hashtag volume. None of these are in the
Display API. They exist in the Business Account API, which needs a separate app
registration and a Business account — out of scope, and noted on-screen so the
report does not imply it is hiding them.

## Design

### 1. The video.list opt-in

`startAuth({ scope })` now takes a scope, and `connectHistory()` is the only
caller that passes `HISTORY_SCOPE`. It stays a separate, opt-in authorize trip
for exactly the reason above: a scope the app does not hold breaks the whole
sign-in, not just the feature that wanted it.

The home screen shows "Connect post history" only when signed in AND the scope
is absent — the button is meaningless to a signed-out user, who needs to sign
in first.

### 2. Snapshots turn totals into velocity

`tik-posts.mjs` pages `video/list` and merges the result into one Blob keyed by
post id, appending at most one snapshot per post per day. That converts a
lifetime total into a series, which is the whole point: `recentGain` (views
since the last snapshot), `viewsPerDay` (age-adjusted lifetime rate), and
`momentum` (the ratio of the two — above 1× means a post is outrunning its own
history).

Retention, in `thinSnaps`: every snapshot inside 30 days, one per week beyond
it, and the earliest snapshot always kept as the anchor. 400 posts × 80
snapshots stays well under a megabyte, and `video/list` only reaches back 200
posts anyway.

**One blob, not one per post.** The report needs every post at once, so N reads
to render one screen would be the wrong trade.

**Gaps are measured, never assumed.** The snapshot happens when the studio is
opened, so a three-day gap is normal. Every rate divides by the real elapsed
days; treating a gap as one day would report triple the true velocity.

**A refresh token lives only in localStorage**, so a scheduled daily cron has
no way to authenticate. Snapshot density therefore depends on how often the
studio is opened. Storing the token server-side would enable a real cron; that
is a security trade to make deliberately, not a side effect of this work.

### 3. Comparisons run on views per day

Lifetime totals structurally favour older posts — a mediocre post from March
out-totals a strong one from last week forever. Every lift column in the new
report compares median views-per-day against the account's own median.
Lifetime views are still shown, because that is the number TikTok shows; only
the comparison changes.

`tagReport(rows, { basis })` gained a `'daily'` mode for the same reason,
defaulting to `'lifetime'` so the existing home-screen panel is unchanged. It
falls back to lifetime when the rows carry no ages, rather than silently
blanking every lift cell.

### 4. One fetch, not two

The home screen's hashtag panel and the Reports screen both need the same 10
pages of `video/list`. They now share `loadPosts()` in `reports.js`, which owns
the TTL and de-duplicates in-flight calls. Previously each would have paged
independently — twenty TikTok API calls to answer one question twice.

`tik-history.mjs` is untouched and still serves batch mode's "which films have
we covered" question.

### 5. Absent is not zero

`Number(null)` is `0`, so the obvious `Number.isFinite(Number(v))` guard reports
a MISSING value as a real zero. In a report that is the worst possible failure:
"we have no view count for this post" renders identically to "this post got
zero views", and the fake zero then drags every median it lands in. `finite()`
in `fmt.js` and `intOrNull()` in `lib/posts.mjs` both reject non-numeric input
before coercing. This bug was live in three modules before the tests caught it.

## Module boundaries

| Module | Pure? | Owns |
| --- | --- | --- |
| `netlify/functions/lib/posts.mjs` | yes | Snapshot merge, retention, store shape. Exports the store NAME; never calls `getStore`. |
| `netlify/functions/tik-posts.mjs` | no | Token refresh, `video/list` paging, Blobs I/O. GET serves stored history unauthenticated. |
| `public/scripts/tik/postmetrics.js` | yes | Velocity, rankings, buckets. All arithmetic. |
| `public/scripts/tik/postreport.js` | yes | Panel markup and sparklines. All HTML. |
| `public/scripts/tik/fmt.js` | yes | Shared formatters, extracted from `tagreport.js`. |
| `public/scripts/tik/reports.js` | no | Fetch, cache, assign. The shared `loadPosts()`. |
| `public/scripts/tik/auth.js` | partly | `startAuth({ scope })`, `connectHistory()`. |

The split follows the rule set in the 2026-08-07 meta design: markup lives in a
pure module so it can be unit-tested and eyeballed without a signed-in TikTok
session. `app.js` and `reports.js` only fetch and assign.

## Testing

`test/tik/posts.test.mjs`, `postmetrics.test.mjs`, `postreport.test.mjs`, plus
additions to `auth.test.mjs`. 498 tests pass.

Beyond the arithmetic, the suites assert the things that would be silently
wrong: that a missing count never becomes a zero, that a stored record survives
a round trip without losing its date, that the default sign-in scope never
contains `video.list`, that under-sampled rows are never coloured green, that
hostile film titles and share URLs are escaped, and that every panel emits
balanced markup.

Rendering was verified in the dev server against fixtures, since the Netlify
functions do not run under `astro dev`.

## Unknowable until the scope is granted

Two things cannot be checked from here, and both are stated rather than
assumed: whether `view_count` populates reliably on `video/list` for an
unaudited app, and how far back the 200-post window actually reaches on this
account.

## Out of scope

The Business Account API. Anything claiming to know TikTok-wide hashtag volume.
Server-side token storage and the daily cron it would enable.
