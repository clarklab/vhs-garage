# tik-frames: picking /tik frames by looking at the whole film

The web studio's frame finder (Shoot) got about 1 in 11 frames right on a test
film. This local method got 11 of 11: extract a frame every 6 seconds, read
every contact sheet, then close-look the best candidates. It is run by Claude
Code on Clark's Mac, against the movie files on the Son of Plex drive
(`/Volumes/Son of Plex/Movies/`). There are no API calls; the looking is done
by Claude itself, usually one helper agent per film following `BRIEF.md`, and
then checked by the main session before anything is delivered.

Needs ffmpeg and Python 3 with Pillow. Work files go to `$TIK_FRAMES_WORK`
(default `~/.cache/vhs-tik-frames`), never into the repo.

## The files
- `WRITE-BRIEF.md` — the brief a writer follows to turn a film's IMDb trivia pool into the
  ten facts of a new set, plus the research the copy is written from.
- `COPY.md` — how the title slide's line, the sign-off, the post title, the description and
  the tags are written by hand for each film, and why the generated ones are not used here.
- `check-copy.mjs` — the check on that hand-written copy (lengths, tags, stale house lines,
  and that the post reads back as the film to the queue).
- `make-draft.py` + `draft.js` — check a written set and its copy and save it as a draft in
  the studio library from the tab, in the shape batch mode writes (placeholder frames, pending).
- `serve.py` — CORS file server for `W` on port 8765, so the tab fetches payloads instead of
  having them pasted; `recv.py` is the other direction.
- `make-briefs.py` — picker fact sheets for fresh drafts (`W/ids.json` + the dump + the writes).
- `prep.py` — `prep.py <slug> <film>` makes the contact sheets (`W/films/<slug>/grids/`);
  `prep.py <slug> <film> pin <name> t…` makes a 12-frame close look at exact seconds.
- `BRIEF.md` — the instructions a picker follows, and the rules a pick must meet.
- `dump-facts.js` — run in a `vhsgarage.com/tik` tab: every set's captions, hints,
  current times, pick notes and wrong marks → `W/inbox/facts.json` (via `recv.py`).
- `recv.py` — tiny local receiver the page POSTs that dump to.
- `find-wrong.js` — run in the tab: just the slides marked wrong, one line each.
- `review.py` — the check sheet: each picked frame beside its caption and note.
- `deliver.py` — extracts the full frames, uploads them, and writes the `apply.js`
  that saves them into the draft from the tab.

## Shooting or re-shooting a set
1. `python3 recv.py &`, then run `dump-facts.js` in the tab. Write the film's fact
   sheet (caption, hint, current time, any wrong mark per slide) from the dump.
2. Prep the film once: `python3 prep.py <slug> "<film path>"`.
3. Pick, following `BRIEF.md`: read every grid, pin candidates, take every `t`
   from a pin label, and write a `why` that describes the picture. Output
   `picks.json`: `[{"i": 3, "t": 2510.5, "standIn": false, "why": "Scorpion's spear…"}]`.
   For a fix, list only the slides being replaced; the rest are left alone.
4. **Check before delivering.** `python3 review.py <slug> "<film>" <draft id> picks.json`
   and read `W/review/<slug>.jpg`: every frame against its caption. This is the
   step that was skipped on 2026-11-03, when ten films went out with picks
   that were never looked at full size and no notes; dozens were wrong.
5. `python3 deliver.py <slug> "<film path>" <draft id> picks.json`, then run the
   printed `apply.js` in the tab. Uploads expire after about two hours, so apply
   soon. With `serve.py` running the tab can fetch it instead of a paste; define
   this once per session, then `await window.__applyFromServer('<slug>')`:
   ```js
   window.__applyFromServer = async (slug) => {
     const r = await fetch(`http://127.0.0.1:8765/deliver/${slug}/apply.js?v=${Date.now()}`);
     if (!r.ok) throw new Error(`apply.js for ${slug}: ${r.status}`);
     const AF = Object.getPrototypeOf(async function () {}).constructor;   // apply.js has a top-level await
     return new AF((await r.text()).replace('await window.__applyFrames(', 'return await window.__applyFrames('))();
   };
   ``` It replaces just those frames, records each `why` as the pick note the
   phone shows under **Picked**, clears any wrong mark (keeping `wasWrong`), and
   the browser syncs the change to the phone.

## Fixing frames marked wrong
Clark marks bad frames on the phone (quick post → **Wrong frame**, with an
optional note on what it should show). Run `find-wrong.js` in the tab to list
them, then follow the steps above for just those slides. The phone shows each
slide's **Direction** (the writer's hint) and **Picked** (the note and time), so
a mark usually says which of the two was wrong.

## Writing a new set locally (the "all Fable" path)
The studio's Batch WRITE asks the server's fast models to write the captions. When the
writing itself should be done by Claude Code, do it here:
1. **Choose films from the shelf list, not from memory.** The Son of Plex Shelf artifact
   (claude.ai/artifact/2g5HukbgrUwetZWf7PNVLy) ranks every pre-2006 film on the drive by
   IMDb votes and marks what is posted. Then check the live library for EVERY title field:
   sets imported from TikTok have no `movie.title`, the film is only in `name` /
   `imported.title` / `postTitle`, and a check on movie titles alone misses them.
2. Pull the pool: `curl -s -X POST https://vhsgarage.com/.netlify/functions/tik-imdb -H 'Content-Type: application/json' -d '{"action":"trivia","query":"<title>","year":<year>,"includeSpoilers":true}' > W/pools/<slug>.json`.
3. One writer agent per film follows `WRITE-BRIEF.md` → `W/writes/<slug>.json`. Read every
   set yourself before it becomes a draft: facts, dashes, length (about 150 characters; past
   34 words a caption starts a click down the font scale on its own, past 44 two clicks, see
   `fontScaleForTrivia` in public/scripts/tik/caption.js, and the phone can nudge it from there).
4. Write each film's copy yourself, following `COPY.md` → `W/copy/<slug>.json`: the title
   slide's line, the sign-off, the post title, the description and five tags. Not a writer
   agent's job and not the studio's templates.
5. `python3 serve.py &`, then `python3 make-draft.py <slug> <n>` (it runs `check-copy.mjs`)
   and run the two lines it prints in the tab; keep the returned ids in `W/ids.json` and the
   movie paths in `W/films.json`. The result should say `postEdited: true`.
6. `recv.py` + `dump-facts.js`, `python3 make-briefs.py`, then shoot as above (one picker per
   film, review sheet, deliver). Pickers also catch caption errors (who did what to whom);
   fix the caption in the draft before applying frames.
