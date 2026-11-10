# Writing a set's copy by hand: title slide, sign-off, post title, description, tags

Everything a viewer reads that is not one of the ten facts is written by Claude Code
itself, per film, after reading the writer's set in full. No API call and no template.
Clark asked for this on 2026-11-09, because the generated lines had gone stale:

- the title slide was always `"<a quote>" Tell me the line you still quote…`;
- the sign-off was one of ten canned lines (`pickOutro` in public/scripts/tik/project.js),
  each ending "Follow VHS Garage for more movie trivia.";
- the post title was always "X (Year) — movie trivia & behind-the-scenes facts", and the
  description always asked "What's your favorite quote from the movie?".

After 150 posts a follower had read each of those many times. The studio still generates
them for sets written in the app; this path replaces them for sets written here.

## Who writes it
The main session, not the writer agents. The writer (WRITE-BRIEF.md) returns the ten
facts plus an `intro` research block: quoted lines, instantly placed images, what fans
argue about, the people, the songs, tag ideas and `given_away`, one phrase per slide
naming what it reveals. Read the ten facts first. The copy must not repeat a fact, spoil
a reveal in `given_away`, or claim anything the set does not support. Never invent a
personal memory for Clark ("I rented this every weekend").

## The file
`W/copy/<slug>.json`:

```
{ "intro":     "the line under the title on slide 1",
  "outro":     "the sign-off slide, two short lines",
  "postTitle": "Film (Year): …",
  "postDesc":  "Film (Year), directed by … \n\n … \n\n#five #tags #at #the #end",
  "filmTags":  ["upto", "three"] }
```

`make-draft.py` runs it through `check-copy.mjs`, puts `intro` under "Film (Year)" on the
title slide, makes `outro` the sign-off slide, and saves the post title and description
as the draft's own (`postEdited`), so the studio never regenerates them.

## The four pieces
**intro** (title slide, under "Film (Year)"). One question a fan answers in a few words
without thinking: a this-or-that, a confession, a ranking, an age, a yes or no. Comments
are what carry these posts, so make answering easy and disagreeing tempting. Take it from
`debates` first. Vary the shape across a batch: no two films in a run should open the
same way, and none should use the old "line you still quote" ask.

**outro** (last slide). Line one: a share ask only this film could have ("Send this to
your Chuckie. Everybody's got one."). Line two: must contain "follow VHS Garage" (the
app knows a sign-off slide by those words) and should close on something from the film
or the video store, never "for more movie trivia". 220 characters at most.

**postTitle**. Opens on the exact `Film (Year)` the set is filed under, then a colon and
a phrase with search words people type ("10 things you missed", "behind the scenes",
a place or prop from the film). 90 UTF-16 units at most; TikTok cuts the rest.

**postDesc**. Five short blocks, blank line between:
1. `Film (Year), directed by X, with A, B and C.` It must open on the film: TikTok's
   history hands the description back as the post's title, and the queue reads the film
   out of it to know the tape is done. Names here are what TikTok search matches.
2. A tease of two facts that gives neither away.
3. The comment question (the intro's, or its twin).
4. "Save this…, send it to…, and follow VHS Garage…", worded for the film.
5. Exactly five hashtags.

No em or en dashes anywhere. A plain hyphen inside an official title is fine.

## Tags
Five per post, in this order: the film's own tag, one or two fandom tags (a star, a
director, a franchise, a studio, a decade, a genre), `#movietok`, then `#behindthescenes`
or `#didyouknow` (alternate across a batch), and `#movies` when a slot is left.

What the account's own 155 posts said on 2026-11-09 (median views of posts carrying the
tag, against the median of all posts in the same window):

| tag | last 14 days | 45 to 200 days old |
|---|---|---|
| #movietok | 1.86x | 1.27x |
| #behindthescenes | 0.94x | 1.29x |
| #didyouknow | | 1.29x |
| #movies | | 1.30x |
| #trivia | | 1.41x |
| #movietrivia | 0.70x | 1.30x |
| #moviefacts | | 0.95x |
| #vhs | | 0.96x |
| #movieclips | | 0.71x |
| #filmtok | 0.92x | 0.48x |

Posts that asked for a save had a median of 28,693 views against 13,945 without. These
are small samples and the film itself matters far more than any tag (Pulp Fiction and
Bloodsport lead by a wide margin), so treat the table as a tiebreak, not a law. Posts
with three film-only tags did worst, which is why at least two slots go to wide tags.
TikTok's own tag sizes could not be read (its tag search needs a signed-in, signed
request), so there is no outside measure here. Re-run the comparison from the library
dump before trusting it for a new batch.

Editorial: do not tag or build copy around a person the account would not want to
promote; name the rest of the cast instead.

## The check
`node check-copy.mjs < {title, year, copy}` (run for you by `make-draft.py`) refuses:
empty pieces, dashes, any stale house line, a title slide over 300 characters, an outro
over 220 or without "follow VHS Garage", a title over 90 units or a description over
4000, a title or description that does not read back as the film through the queue's
own parser, and fewer than three or more than five hashtags. Its tests are
test/tik/tik-frames-copy.test.mjs.
