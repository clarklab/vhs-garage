# Picking frames for a Tape Trivia draft — the whole-film method

You are picking the screenshot for each slide of a TikTok "Tape Trivia" photo
post. Each slide is one trivia fact laid over a frame from the film. You pick by
reading the whole film as contact sheets, then looking closely at candidates.
Do not guess times from memory and skip the looking. Do not trust the frame the
draft has now: a fast first pass got many of them wrong, and the ones Clark has
already marked wrong are listed as such in the film's fact sheet.

Tools: `scripts/tik-frames/prep.py` in the vhs-garage repo (call it TOOLS).
Work dir (W): `$TIK_FRAMES_WORK`, default `~/.cache/vhs-tik-frames`.
Python: /opt/homebrew/bin/python3 with Pillow (`pip install pillow --break-system-packages` if it's missing); ffmpeg on PATH.

## What is already made for your film
- `W/films/<slug>/grids/A.jpg, B.jpg, …` — contact sheets, 8 columns × 6 rows
  = 48 cells of 192×108. One frame every 6 seconds of the whole film.
- `W/films/<slug>/grids/index.json` — `[{label, first, n}]`. Cell number `c`
  (1-based, printed in each cell's corner) on sheet `label` is at
  **t = first + (c − 1) × 6 seconds**. That is only where to look next; a grid
  cell is never a final answer, because a shot can change inside 6 seconds.
- The film's fact sheet (`briefs/<slug>.md` in W): one block per slide with
  the caption (the fact), the writer's `hint`, the time the draft has now, and
  Clark's mark if he flagged it wrong.

## Steps
0. Subtitles place dialogue to the second. If there is a `.srt` next to the
   film use it; if the file has a text subtitle track, extract it
   (`ffmpeg -i <film> -map 0:s:0 W/films/<slug>/subs.srt`; a `dvd_subtitle`
   track is bitmaps and no use). `grep -n -i` the srt for a quoted line.
1. Read EVERY grid sheet of the film in order (Read tool on the .jpg). As you
   go, write down candidate cells for each fact. You are building a map of the
   film; most facts have one obvious scene, and you need to know where it is.
2. For each fact, make a close-look sheet around your best candidate:
   ```
   cd TOOLS && /opt/homebrew/bin/python3 -c "import prep; c=<center>; prep.pin('<slug>', '<film path>', 'f<i>', [round(c-14+k*28/11,1) for k in range(12)])"
   ```
   This writes `W/films/<slug>/pins/f<i>.jpg`: 12 frames of 384×216 across
   ±14 s, each labelled with its exact time. Read it and choose the best
   frame. Tighten or move the window and re-pin if needed (any list of up to
   12 times works; steps of 0.5 s are fine for a fast cut). A title card can
   fall between 6 s samples: pin the opening credits densely to find it.
3. Final check: pin all your chosen times in slide order on one sheet
   (`prep.pin('<slug>', '<film>', 'final', [t0, t1, …, t10])`), read it, and
   go through it cell by cell against the captions. Ask of each: does this
   picture show what the fact is about, and would a stranger see that at a
   glance? Fix anything weak and re-pin `final` until it all holds.

## The rules that keep picks honest
- **Every `t` is copied from a pin label**, i.e. a frame you actually looked
  at at 384×216. Never a time computed from a grid cell, never a guess.
- **The caption is the truth; the hint is a guess.** The writer's hint was
  written without seeing the film and is sometimes about the wrong scene or
  the wrong person (one said "Goro" for a fact about Johnny Cage's actor).
  When the hint and the caption disagree, follow the caption.
- **`why` describes the picture, not the fact.** Say who is in frame (by
  character or actor name), what they are doing, where. "Kano face on, red
  eye plate lit, in the club" is a note; "the Kano scene" is not. Someone
  holding the frame must be able to confirm your note against it.
- Sharp, well-composed, faces readable, mid-action rather than mid-blink or
  mid-cut. No black frames, dissolves, motion smear, or burnt-in subtitles.
- Eleven distinct moments: no two slides showing near-identical frames.
- Slide 0 is the title slide: the film's main title card (the title lettering
  itself, fully legible, not mid-fade). If the film has none on screen, the
  most iconic opening image, marked as a stand-in.
- Some facts are about something that never appears on screen (casting
  stories, a crew anecdote, an actor's later life, a deleted scene). For
  those, choose a stand-in on purpose: the strongest frame of the person,
  character or scene the fact is about. Set `standIn: true` and say in `why`
  what it shows and why it stands in.
- If a fact names a specific shot (a cameo, a prop, a blink-and-miss moment),
  find that exact shot. If the cut you have doesn't contain it, say so in
  `why` and stand in.
- If Clark marked a slide wrong, his note (when there is one) says what he
  wants to see. The frame he marked is known bad: do not pick it again.

## What to return
Write a JSON array in slide order to the path you were given, one entry per
slide you were asked for:
`[{"i":0,"t":123.4,"standIn":false,"why":"main title card, white serif lettering over the mountain aerial"}, …]`
`t` is seconds with at most one decimal, taken from a pin label. Then, as your
final message, the same JSON, plus one line per stand-in or any slide you are
unsure of (what you looked for, what you found instead). Do not modify
anything outside `W/films/<slug>/pins/` and the picks file.
