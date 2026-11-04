# Picking frames for a Tape Trivia draft — the whole-film method

You are picking the screenshot for each slide of a TikTok "Tape Trivia" photo
post. Each slide is one trivia fact laid over a frame from the film. The frames
the web tool picked were poor; this method (read the whole film, then look
closely) got 11 of 11 right on a test film. Do it properly. Do not guess times
from memory and skip the looking.

Tools: `scripts/tik-frames/prep.py` in the vhs-garage repo (call it TOOLS).
Work dir (W): `$TIK_FRAMES_WORK`, default `~/.cache/vhs-tik-frames`.
Python: /opt/homebrew/bin/python3 with Pillow (`pip install pillow --break-system-packages` if it's missing); ffmpeg on PATH.

## What is already made for your film
- `W/films/<slug>/grids/A.jpg, B.jpg, …` — contact sheets, 8 columns × 6 rows
  = 48 cells of 192×108. One frame every 6 seconds of the whole film.
- `W/films/<slug>/grids/index.json` — `[{label, first, n}]`. Cell number `c`
  (1-based, printed in each cell's corner) on sheet `label` is at
  **t = first + (c − 1) × 6 seconds**.

## Steps
0. If the film has an embedded English subtitle track, extract it
   (`ffmpeg -i <film> -map 0:s:0 W/films/<slug>/subs.srt`): a dialogue fact
   can then be placed to the second.
1. Read EVERY grid sheet of the film in order (Read tool on the .jpg). As you
   go, note candidate cells for each fact. You are building a map of the film.
2. For each fact, make a close-look sheet around your best candidate:
   ```
   cd TOOLS && /opt/homebrew/bin/python3 -c "import prep; c=<center>; prep.pin('<slug>', '<film path>', 'f<i>', [round(c-14+k*28/11,1) for k in range(12)])"
   ```
   This writes `W/films/<slug>/pins/f<i>.jpg`: 12 frames of 384×216 across
   ±14 s, each labelled with its exact time. Read it and choose the best
   frame. Tighten or move the window and re-pin if needed (any list of up to
   12 times works). A title card can fall between 6 s samples: pin the
   opening credits densely to find it.
3. Final check: pin all your chosen times in slide order on one sheet
   (`prep.pin('<slug>', '<film>', 'final', [t0, t1, …, t10])`), read it, and
   fix anything weak.

## What a good pick is
- Slide 0 is the title slide: the film's main title card (the title lettering
  itself, fully legible, not mid-fade). If the film has none on screen, the
  most iconic opening image, marked as a stand-in.
- Every other slide shows the moment the fact is about: the scene, the person
  or the object it names. The writer's "wants" line is a hint, not gospel; it
  is sometimes wrong about where the scene is or what it looks like.
- Sharp, well-composed, faces readable, mid-action rather than mid-blink or
  mid-cut. No black frames, dissolves, motion smear, or burnt-in subtitles.
- Eleven distinct moments: no two slides showing near-identical frames.
- Some facts are about something that never appears on screen (casting
  stories, a crew anecdote, an actor's later life). For those, choose a
  stand-in on purpose: the strongest frame of the person, character or scene
  the fact is about. Mark it as a stand-in and say what it shows.
- If a fact names a specific shot (a cameo, a prop, a blink-and-miss moment),
  find that exact shot. If the cut of the film you have doesn't contain it
  (e.g. removed in a later edition), say so and stand in.

## What to return (your final message, nothing else needed)
A JSON array in slide order, one entry per slide:
`[{"i":0,"t":123.4,"standIn":false,"why":"main title card, white serif lettering"}, …]`
`t` is seconds with at most one decimal, taken from a pin label. `why` is one
short line describing what the frame shows (and, for a stand-in, why it was
the best substitute). Then one line per stand-in or any slide you are unsure
of. Do not modify anything outside `W/films/<slug>/pins/`.
