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
   soon. It replaces just those frames, records each `why` as the pick note the
   phone shows under **Picked**, clears any wrong mark (keeping `wasWrong`), and
   the browser syncs the change to the phone.

## Fixing frames marked wrong
Clark marks bad frames on the phone (quick post → **Wrong frame**, with an
optional note on what it should show). Run `find-wrong.js` in the tab to list
them, then follow the steps above for just those slides. The phone shows each
slide's **Direction** (the writer's hint) and **Picked** (the note and time), so
a mark usually says which of the two was wrong.
