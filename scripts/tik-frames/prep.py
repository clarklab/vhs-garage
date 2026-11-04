# Frame picking for /tik drafts, done locally: read the whole film, then look close.
# See README.md in this folder for the full workflow.
#
#   prep.py <slug> <film path>              a frame every 6 s, packed into 8x6 contact sheets
#   prep.py <slug> <film> pin <name> t ...  up to 12 frames at exact seconds, 384x216, labelled
#   prep.py <slug> <film> full <i> <t>      one full-size frame (capped at 1920 wide)
#
# Everything is written under $TIK_FRAMES_WORK (default ~/.cache/vhs-tik-frames),
# never into the repo: a feature film is ~1,500 frames.
import glob, json, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

SP = os.environ.get('TIK_FRAMES_WORK') or os.path.expanduser('~/.cache/vhs-tik-frames')
os.makedirs(SP, exist_ok=True)
STEP, COLS, ROWS, CW, CH = 6, 8, 6, 192, 108
PCW, PCH = 384, 216
BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'

def label(n):
    s = ''
    while True:
        s = chr(65 + n % 26) + s
        n = n // 26 - 1
        if n < 0: return s

def extract(slug, film):
    d = f'{SP}/films/{slug}/frames'; os.makedirs(d, exist_ok=True)
    if not glob.glob(f'{d}/f*.png'):
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', '1', '-i', film, '-vf',
            f'fps=1/{STEP},scale={CW}:{CH}:force_original_aspect_ratio=decrease,pad={CW}:{CH}:(ow-iw)/2:(oh-ih)/2:black',
            '-start_number', '0', f'{d}/f%05d.png'], check=True)
    return sorted(glob.glob(f'{d}/f*.png'))

def grids(slug, frames):
    out = f'{SP}/films/{slug}/grids'; os.makedirs(out, exist_ok=True)
    font = ImageFont.truetype(BOLD, 16); per = COLS * ROWS; index = []
    for g in range(0, len(frames), per):
        chunk = frames[g:g + per]; lab = label(g // per)
        im = Image.new('RGB', (COLS * CW, ROWS * CH), (0, 0, 0)); d = ImageDraw.Draw(im)
        for i, f in enumerate(chunk):
            x, y = (i % COLS) * CW, (i // COLS) * CH
            im.paste(Image.open(f).convert('RGB'), (x, y))
            t = str(i + 1); w = d.textlength(t, font=font) + 8
            d.rectangle([x + 2, y + 2, x + 2 + w, y + 24], fill=(0, 0, 0)); d.text((x + 6, y + 5), t, font=font, fill=(255, 255, 255))
        for c in range(1, COLS): d.line([(c * CW, 0), (c * CW, ROWS * CH)], fill=(90, 90, 90))
        for r in range(1, ROWS): d.line([(0, r * CH), (COLS * CW, r * CH)], fill=(90, 90, 90))
        im.save(f'{out}/{lab}.jpg', quality=74)
        index.append({'label': lab, 'first': 1 + g * STEP, 'n': len(chunk)})
    json.dump(index, open(f'{out}/index.json', 'w'))
    return index

def pin(slug, film, name, times):
    out = f'{SP}/films/{slug}/pins'; os.makedirs(out, exist_ok=True)
    font = ImageFont.truetype(BOLD, 22)
    im = Image.new('RGB', (4 * PCW, 3 * PCH), (0, 0, 0)); d = ImageDraw.Draw(im)
    for i, t in enumerate(times[:12]):
        f = f'{out}/{name}_{i}.jpg'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(t), '-i', film, '-frames:v', '1', '-vf',
            f'scale={PCW}:{PCH}:force_original_aspect_ratio=decrease,pad={PCW}:{PCH}:(ow-iw)/2:(oh-ih)/2:black', f], check=True)
        x, y = (i % 4) * PCW, (i // 4) * PCH
        im.paste(Image.open(f), (x, y)); lab = f'{i + 1}  {t}s'
        d.rectangle([x + 3, y + 3, x + 12 + d.textlength(lab, font=font), y + 32], fill=(0, 0, 0)); d.text((x + 8, y + 6), lab, font=font, fill=(255, 255, 0))
    for c in range(1, 4): d.line([(c * PCW, 0), (c * PCW, 3 * PCH)], fill=(120, 120, 120), width=2)
    for r in range(1, 3): d.line([(0, r * PCH), (4 * PCW, r * PCH)], fill=(120, 120, 120), width=2)
    im.save(f'{out}/{name}.jpg', quality=85)

def full(slug, film, i, t):
    out = f'{SP}/deliver/{slug}'; os.makedirs(out, exist_ok=True)
    # Cap at 1920 wide: a 4K source would be 10MB a frame for no gain on a phone.
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(t), '-i', film, '-frames:v', '1', '-vf', "scale='min(1920,iw)':-2", '-q:v', '2', f'{out}/{i}.jpg'], check=True)

if __name__ == '__main__':
    slug, film = sys.argv[1], sys.argv[2]
    if len(sys.argv) > 3 and sys.argv[3] == 'pin':
        pin(slug, film, sys.argv[4], [float(t) for t in sys.argv[5:]])
    elif len(sys.argv) > 3 and sys.argv[3] == 'full':
        full(slug, film, sys.argv[4], sys.argv[5])
    else:
        frames = extract(slug, film)
        idx = grids(slug, frames)
        print(slug, len(frames), 'frames', len(idx), 'grids', ' '.join(f"{g['label']}:{g['first']}" for g in idx))
