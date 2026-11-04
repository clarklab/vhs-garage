# tik-frames: picking /tik frames by looking at the whole film

The web studio's frame finder (Shoot) got about 1 in 11 frames right on a test
film. This local method got 11 of 11: extract a frame every 6 seconds, read
every contact sheet, then close-look the best candidates. It is run by Claude
Code on Clark's Mac, against the movie files on the Son of Plex drive
(`/Volumes/Son of Plex/Movies/`). There are no API calls; the looking is done
by Claude itself (or by one helper agent per film, each following `BRIEF.md`).

Needs ffmpeg and Python 3 with Pillow. Work files go to `$TIK_FRAMES_WORK`
(default `~/.cache/vhs-tik-frames`).

## Fixing frames marked wrong

Clark marks bad frames on the phone (quick post → **Wrong frame**, with an
optional note on what it should show). The mark syncs to the desk and shows as
a red "wrong frame" pill in the studio and a red count on the library card.

1. In a `vhsgarage.com/tik` tab, run `find-wrong.js` (paste it into the page as
   a script). It lists each marked slide: draft id, film, slide index, current
   time, note, caption.
2. Prep the film once: `python3 prep.py <slug> "<film path>"`.
3. For each marked slide, find the right moment (read the grids, pin around
   candidates; see `BRIEF.md`), and write `picks.json` with only those slides:
   `[{"i": 3, "t": 2510.5, "standIn": false, "why": "Scorpion's spear in the Pit fight"}]`.
4. `python3 deliver.py <slug> "<film path>" <draft id> picks.json`, then run
   the printed `apply.js` in the same tab. It replaces just those frames, clears
   their marks (keeping `wasWrong` for the record), and leaves every other slide
   alone. The browser syncs the change to the phone.

## Shooting a fresh draft

Same steps with every slide in `picks.json`: slide 0 is the title card, and a
fact that never appears on screen (casting, an outtake) gets a deliberate
stand-in with `"standIn": true` and a `why` saying what it shows.
