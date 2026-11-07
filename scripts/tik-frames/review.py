# The check before delivery: every picked frame beside its caption and the picker's note.
#
#   review.py <slug> <film path> <project id> <picks.json> [facts.json]
#
# facts.json is the dump-facts.js output (default $TIK_FRAMES_WORK/inbox/facts.json).
# Each frame is extracted fresh at the exact pick time, the same way deliver.py does,
# so what is on this sheet is what will be delivered.
#   → W/review/<slug>.jpg  (3 columns of 480x270 frames + text) and W/review/<slug>/<i>.jpg
import json, os, subprocess, sys, textwrap
from PIL import Image, ImageDraw, ImageFont
W = os.environ.get('TIK_FRAMES_WORK') or os.path.expanduser('~/.cache/vhs-tik-frames')
slug, film, pid, picks_file = sys.argv[1:5]
facts_file = sys.argv[5] if len(sys.argv) > 5 else f'{W}/inbox/facts.json'
proj = next(p for p in json.load(open(facts_file)) if p['id'] == pid)
picks = sorted(json.load(open(picks_file)), key=lambda m: m['i'])
out = f'{W}/review/{slug}'; os.makedirs(out, exist_ok=True)
F = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 13)
B = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Bold.ttf', 14)
CW, FH, TH, COLS = 480, 270, 160, 3
rows = (len(picks) + COLS - 1) // COLS
im = Image.new('RGB', (COLS * CW + (COLS + 1) * 10, 40 + rows * (FH + TH + 10)), (18, 18, 20)); d = ImageDraw.Draw(im)
d.text((10, 10), f"{proj['title']} ({proj['year']}) — {os.path.basename(picks_file)}", font=B, fill=(230, 230, 230))
for k, m in enumerate(picks):
    i, t = int(m['i']), float(m['t']); s = proj['slides'][i]
    f = f'{out}/{i}.jpg'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(t), '-i', film, '-frames:v', '1', '-vf',
                    'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:black', '-q:v', '3', f], check=True)
    x = 10 + (k % COLS) * (CW + 10); y = 40 + (k // COLS) * (FH + TH + 10)
    im.paste(Image.open(f).resize((CW, FH)), (x, y))
    d.rectangle([x + 3, y + 3, x + 60, y + 22], fill=(0, 0, 0)); d.text((x + 7, y + 5), f'#{i}', font=B, fill=(255, 255, 0))
    ty = y + FH + 4
    for ln in textwrap.wrap(f"{t}s  {'STAND-IN: ' if m.get('standIn') else ''}{m.get('why', '')}", 70)[:3]:
        d.text((x, ty), ln, font=F, fill=(255, 220, 90)); ty += 16
    ty += 3
    for ln in textwrap.wrap(str(s['caption']).replace('\n', ' / '), 72)[:5]:
        d.text((x, ty), ln, font=F, fill=(235, 235, 235)); ty += 16
    hint = str(s.get('hint') or '').strip()
    if hint and ty < y + FH + TH - 14: d.text((x, ty), textwrap.shorten('hint: ' + hint, 78), font=F, fill=(120, 120, 120))
im.save(f'{W}/review/{slug}.jpg', quality=88); print(f'{W}/review/{slug}.jpg')
