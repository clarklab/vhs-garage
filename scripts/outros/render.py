# Three VHS Garage "follow" end cards, 1080x1920 @ 30fps, 5s each.
#
# Usage: python3 scripts/outros/render.py [aisle|play|plus ...]
#   -> public/tik/outros/<name>.mp4 and <name>.png (its last frame, the still
#      a photo post uses). Needs Pillow and ffmpeg; macOS system fonts.
#
# titles.json is the spine labels for "The Aisle": films we have covered.
# FOLLOW_XY is where TikTok's follow "+" sits; nudge it if the arrow misses.
import json, math, os, random, subprocess, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(REPO, 'public', 'tik', 'outros')   # what the studio serves
W, H, FPS, SECS = 1080, 1920, 30, 5.0
N = int(FPS * SECS)

# TikTok overlays: caption block along the bottom, action rail down the right.
# Everything important stays inside this box.
SAFE = dict(left=70, right=W - 170, top=230, bottom=H - 470)
# Where the avatar + follow "+" sits on the right rail (approx; varies by phone).
FOLLOW_XY = (990, 1000)

YELLOW = (255, 214, 10)
LOGO_YELLOW = (226, 196, 40)
VCR_BLUE = (16, 24, 168)

F_DIN = '/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf'
F_BLACK = '/Library/Fonts/SF-Pro-Display-Black.otf'
F_VCR = f'{REPO}/public/fonts/VCR.ttf'
font = lambda path, size: ImageFont.truetype(path, size)

# ---------------- easing ----------------
clamp = lambda x, a=0.0, b=1.0: max(a, min(b, x))
def prog(t, start, dur): return clamp((t - start) / dur)
def ease_out(x): return 1 - (1 - x) ** 3
def ease_in_out(x): return 3 * x * x - 2 * x * x * x
def back_out(x, s=1.9):
    x -= 1
    return x * x * ((s + 1) * x + s) + 1
def elastic_out(x):
    if x in (0, 1): return x
    return 2 ** (-10 * x) * math.sin((x * 10 - 0.75) * (2 * math.pi) / 3) + 1

# ---------------- logos, keyed off their black fields ----------------
def keyed(path, tint=None, gain=1.6):
    im = Image.open(path).convert('RGB')
    lum = im.convert('L').point(lambda v: clamp((v - 18) * gain / 255) * 255)
    rgb = Image.new('RGB', im.size, tint) if tint else im
    out = rgb.convert('RGBA')
    out.putalpha(lum)
    return out.crop(lum.getbbox())

LOGO_SQ = keyed(f'{REPO}/public/images/vhs-garage-logo-square.png')           # yellow V lockup
LOGO_WORD = keyed(f'{REPO}/public/images/vhs-garage-logo-still.png', (255, 255, 255))  # striped wordmark

def scaled(im, w):
    h = round(im.height * w / im.width)
    return im.resize((max(1, round(w)), max(1, h)), Image.LANCZOS)

def paste_center(base, im, cx, cy, alpha=1.0):
    if alpha < 1:
        im = im.copy()
        im.putalpha(im.getchannel('A').point(lambda v: int(v * alpha)))
    base.alpha_composite(im, (round(cx - im.width / 2), round(cy - im.height / 2)))

def text_img(s, f, fill, stroke=0, stroke_fill=None, pad=8):
    l, t, r, b = f.getbbox(s, stroke_width=stroke)
    im = Image.new('RGBA', (r - l + pad * 2, b - t + pad * 2), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((pad - l, pad - t), s, font=f, fill=fill, stroke_width=stroke, stroke_fill=stroke_fill)
    return im

def scanlines(alpha=38):
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for y in range(0, H, 4):
        d.line([(0, y), (W, y)], fill=(0, 0, 0, alpha), width=2)
    return im

def vignette(strength=200):
    small = Image.new('L', (108, 192), 0)
    d = ImageDraw.Draw(small)
    for i in range(60):
        v = int(strength * (1 - i / 60) ** 2)
        d.ellipse([-30 + i, -20 + i * 1.6, 138 - i, 212 - i * 1.6], outline=v)
    m = small.resize((W, H), Image.BILINEAR).filter(ImageFilter.GaussianBlur(30))
    out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    out.putalpha(m)
    return out

def rgb_split(im, dx):
    if abs(dx) < 1: return im
    r, g, b, a = im.split()
    r = ImageChops.offset(r, round(dx), 0)
    b = ImageChops.offset(b, -round(dx), 0)
    return Image.merge('RGBA', (r, g, b, a))

def pill(text, f, fg, bg, padx=46, pady=26):
    t = text_img(text, f, fg)
    im = Image.new('RGBA', (t.width + padx * 2, t.height + pady * 2), (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle([0, 0, im.width - 1, im.height - 1], radius=im.height // 2, fill=bg)
    im.alpha_composite(t, (padx, pady))
    return im

# =====================================================================
# 1. THE AISLE — a rental-store wall of the films we've covered
# =====================================================================
LABELS = [(214, 40, 40), (245, 130, 32), (255, 214, 10), (40, 170, 220), (220, 50, 140), (240, 240, 235), (60, 190, 90)]

def build_shelf(titles, seed, height=560):
    rnd = random.Random(seed)
    f = font(F_DIN, 46)
    spines = []
    for t in titles:
        w = rnd.choice([86, 92, 100, 108])
        sp = Image.new('RGBA', (w, height), (18, 18, 20, 255))
        d = ImageDraw.Draw(sp)
        label = rnd.choice(LABELS)
        d.rectangle([8, 30, w - 9, height - 30], fill=label)
        d.rectangle([8, height - 120, w - 9, height - 30], fill=(18, 18, 20))
        d.text((w / 2, height - 75), 'VHS', font=font(F_DIN, 30), fill=label, anchor='mm')
        dark = sum(label) > 450
        txt = text_img(t.upper(), f, (20, 20, 20) if dark else (255, 255, 255))
        txt = txt.rotate(90, expand=True)
        if txt.height > height - 170: txt = txt.resize((txt.width, height - 170))
        sp.alpha_composite(txt, ((w - txt.width) // 2, 40 + (height - 160 - txt.height) // 2))
        d.line([(1, 0), (1, height)], fill=(60, 60, 64), width=2)
        spines.append(sp)
    total = sum(s.width + 6 for s in spines)
    strip = Image.new('RGBA', (total * 2, height + 40), (8, 8, 10, 255))
    x = 0
    for _ in range(2):  # twice, so the scroll wraps seamlessly
        for s in spines:
            strip.alpha_composite(s, (x, 0))
            x += s.width + 6
    ImageDraw.Draw(strip).rectangle([0, height + 4, strip.width, height + 40], fill=(70, 46, 30))  # the shelf
    return strip, total

def render_aisle():
    titles = json.load(open(os.path.join(HERE, 'titles.json')))
    count = len(titles)
    rnd = random.Random(7)
    shelves = []
    for i in range(4):
        ts = titles[:]
        rnd.shuffle(ts)
        shelves.append(build_shelf(ts, i))
    vig, scan = vignette(230), scanlines(30)
    band = Image.new('RGBA', (W, H), (4, 4, 6, 0))
    ba = Image.new('L', (W, H), 0)
    bd = ImageDraw.Draw(ba)
    for y in range(H):
        e = min(y - 380, 1480 - y)
        bd.line([(0, y), (W, y)], fill=int(235 * clamp(e / 120)))
    band.putalpha(ba)
    big = font(F_BLACK, 112)
    sub = font(F_DIN, 58)
    cta = font(F_BLACK, 56)
    logo = scaled(LOGO_SQ, 760)
    plate_h = 900
    for n in range(N):
        t = n / FPS
        fr = Image.new('RGBA', (W, H), (6, 6, 8, 255))
        # Shelves drift in alternating directions, slowing as the logo lands.
        drift = 30 + 220 * (1 - ease_out(prog(t, 0, 2.2)))
        for i, (strip, period) in enumerate(shelves):
            y = -120 + i * 600
            off = (t * drift * (1 + i * 0.25) + i * 300) % period
            x = -off if i % 2 == 0 else -(period - off) + 0
            fr.alpha_composite(strip, (round(x), y))
        # Darken the wall, and more so in a band behind the lockup.
        k = ease_out(prog(t, 0.3, 0.8))
        fr.alpha_composite(Image.new('RGBA', (W, H), (0, 0, 0, round(110 * k))))
        b = band.copy()
        b.putalpha(band.getchannel('A').point(lambda v: int(v * k)))
        fr.alpha_composite(b)
        fr.alpha_composite(vig)
        # Logo: pops in with overshoot and a short tracking-error split.
        p = prog(t, 0.45, 0.55)
        if p > 0:
            s = 0.2 + 0.8 * back_out(p)
            lg = scaled(logo, logo.width * s)
            lg = rgb_split(lg, 26 * (1 - p) * math.sin(t * 60))
            paste_center(fr, lg, W / 2 - 40, 700, alpha=clamp(p * 3))
        # Headline, then the real count rolling up.
        p = ease_out(prog(t, 1.15, 0.4))
        if p > 0:
            h1 = text_img('FOLLOW FOR', big, (255, 255, 255))
            h2 = text_img('MORE TAPES', big, YELLOW)
            paste_center(fr, h1, W / 2 - 40, 1130 + 60 * (1 - p), alpha=p)
            paste_center(fr, h2, W / 2 - 40, 1250 + 60 * (1 - p), alpha=p)
        p = ease_out(prog(t, 1.6, 0.4))
        if p > 0:
            line = text_img('NEW ONES EVERY WEEK', sub, (210, 210, 210))
            paste_center(fr, line, W / 2 - 40, 1370 + 30 * (1 - p), alpha=p)
        fr.alpha_composite(scan)
        yield fr

# =====================================================================
# 2. PLAY — VCR blue screen, tracking roll, striped logo builds line by line
# =====================================================================
def noise_band(h, seed):
    rnd = random.Random(seed)
    band = Image.effect_noise((W // 3, h // 3), 90).convert('RGBA').resize((W, h), Image.NEAREST)
    a = Image.new('L', (W, h), 0)
    d = ImageDraw.Draw(a)
    for y in range(h):
        d.line([(0, y), (W, y)], fill=int(230 * math.sin(math.pi * y / h) ** 0.7 * rnd.uniform(0.6, 1)))
    band.putalpha(a)
    return band

def osd_play(d, x, y, f):
    d.text((x, y), 'PLAY', font=f, fill=(255, 255, 255))
    tx = x + d.textlength('PLAY ', font=f)
    l, t, r, b = f.getbbox('P')
    top, bot = y + t + 4, y + b - 4
    d.polygon([(tx, top), (tx, bot), (tx + (bot - top) * 0.85, (top + bot) / 2)], fill=(255, 255, 255))

def render_play():
    osd = font(F_VCR, 78)
    osd_s = font(F_VCR, 58)
    type_f = font(F_VCR, 70)
    scan = scanlines(46)
    word = scaled(LOGO_WORD, 800)
    rows = 48
    row_h = word.height / rows
    lines = ['FOLLOW', 'VHS GARAGE', 'FOR THE NEXT TAPE']
    grain = None
    for n in range(N):
        t = n / FPS
        cut = 0.9  # blue screen → logo
        if t < cut:
            fr = Image.new('RGBA', (W, H), VCR_BLUE + (255,))
            d = ImageDraw.Draw(fr)
            if int(t * 4) % 2 == 0 or t > 0.5:
                osd_play(d, SAFE['left'] + 10, SAFE['top'], osd)
            d.text((SAFE['left'] + 10, SAFE['top'] + 100), 'SP', font=osd_s, fill=(255, 255, 255))
            # Tracking band rolls down the screen.
            by = int(-300 + (t / cut) * (H + 300))
            fr.alpha_composite(noise_band(300, n), (0, by))
        else:
            fr = Image.new('RGBA', (W, H), (4, 4, 6, 255))
            d = ImageDraw.Draw(fr)
            # Logo stripes slide in from alternating sides, staggered top to bottom.
            lt = t - cut
            cx, cy = W / 2 - 45, 820
            x0, y0 = round(cx - word.width / 2), round(cy - word.height / 2)
            for r in range(rows):
                p = ease_out(prog(lt, r * 0.012, 0.42))
                if p <= 0: continue
                top, bot = round(r * row_h), round((r + 1) * row_h)
                sl = word.crop((0, top, word.width, bot))
                dx = (1 - p) * (W + 200) * (1 if r % 2 else -1)
                jitter = (random.Random(n * 97 + r).uniform(-6, 6)) * (1 - p)
                fr.alpha_composite(sl, (round(x0 + dx + jitter), y0 + top))
            # A last tracking wobble after it settles.
            if 1.55 < t < 1.75:
                fr = rgb_split(fr, 14)
                fr.alpha_composite(noise_band(140, n), (0, 640 + int((t - 1.55) * 900)))
            # OSD stays: counter ticking, REC-style dot blinks.
            d = ImageDraw.Draw(fr)
            secs = 5025 + int(t * 1)  # 1:23:45 and counting
            ctr = f'{secs // 3600}:{secs % 3600 // 60:02d}:{secs % 60:02d}'
            osd_play(d, SAFE['left'] + 10, SAFE['top'], osd)
            d.text((SAFE['left'] + 10, SAFE['top'] + 100), ctr, font=osd_s, fill=(255, 255, 255))
            # Typed follow line, one character at a time, with a block cursor.
            start = 1.8
            chars_per_s = 22
            typed = int(max(0, t - start) * chars_per_s)
            y = 1150
            remaining = typed
            for i, ln in enumerate(lines):
                show = ln[:max(0, remaining)]
                remaining -= len(ln)
                color = YELLOW if i == 1 else (255, 255, 255)
                if show:
                    d.text((W / 2 - 45, y), show, font=type_f, fill=color, anchor='mm')
                if 0 <= remaining + len(ln) <= len(ln) and int(t * 3) % 2 == 0 and t >= start:
                    bw = d.textlength(show, font=type_f)
                    d.rectangle([W / 2 - 45 + bw / 2 + 8, y - 34, W / 2 - 45 + bw / 2 + 48, y + 34], fill=color)
                y += 100
        # Tape grain + scanlines over everything.
        # Grain changes every other frame, softly: every-frame full noise was
        # most of a 12MB file and reads no better on a phone.
        grain = Image.effect_noise((W // 6, H // 6), 30).resize((W, H), Image.BILINEAR).convert('RGBA') if n % 2 == 0 else grain
        grain.putalpha(14)
        fr.alpha_composite(grain)
        fr.alpha_composite(scan)
        yield fr

# =====================================================================
# 3. HIT THE + — loud yellow, word slams, arrow at the follow button
# =====================================================================
def stripes_bg(t):
    im = Image.new('RGBA', (W, H), YELLOW + (255,))
    d = ImageDraw.Draw(im)
    gap = 34
    off = (t * 90) % (gap * 2)
    for i in range(-80, 120):
        y = i * gap + off
        d.line([(-200, y + 400), (W + 200, y - 400)], fill=(240, 190, 0), width=12)
    return im

def arrow(length=360, thick=70, head=150):
    im = Image.new('RGBA', (length + head + 20, head + 20), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cy = im.height / 2
    d.rectangle([10, cy - thick / 2, 10 + length, cy + thick / 2], fill=(0, 0, 0))
    d.polygon([(10 + length - 10, cy - head / 2), (10 + length + head, cy), (10 + length - 10, cy + head / 2)], fill=(0, 0, 0))
    return im

def render_plus():
    slam = font(F_BLACK, 158)
    small = font(F_BLACK, 64)
    words = [('DON\'T', 0.15), ('MISS', 0.45), ('THE NEXT', 0.75), ('TAPE', 1.05)]
    logo = scaled(LOGO_SQ, 250)
    logo_dark = Image.new('RGBA', logo.size, (0, 0, 0, 255))
    logo_dark.putalpha(logo.getchannel('A'))
    arw = arrow()
    fx, fy = FOLLOW_XY
    for n in range(N):
        t = n / FPS
        fr = stripes_bg(t)
        # Camera shake on each slam.
        shake = 0
        for _, st in words:
            dt = t - st
            if 0 <= dt < 0.18: shake = 14 * (1 - dt / 0.18)
        sx = round(random.Random(n).uniform(-shake, shake))
        sy = round(random.Random(n + 1).uniform(-shake, shake))
        y = 560
        for wtxt, st in words:
            p = prog(t, st, 0.22)
            if p > 0:
                s = 2.4 - 1.4 * ease_out(p)
                col = (255, 255, 255) if wtxt == 'TAPE' else (0, 0, 0)
                im = text_img(wtxt, slam, col, stroke=10 if wtxt == 'TAPE' else 0, stroke_fill=(0, 0, 0))
                im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
                paste_center(fr, im, 455 + sx, y + sy, alpha=clamp(p * 2))
            y += 172
        # Arrow flies in, then bounces toward the follow button.
        p = prog(t, 1.45, 0.45)
        if p > 0:
            # From below the words, up and right at the button; bounces along
            # its own line once it lands.
            tail, tip = (300, 1290), (fx - 115, fy + 70)
            ux, uy = tip[0] - tail[0], tip[1] - tail[1]
            dist = math.hypot(ux, uy)
            ux, uy = ux / dist, uy / dist
            bounce = 24 * abs(math.sin(max(0, t - 1.9) * 7)) if t > 1.9 else 0
            fly = (1 - back_out(p)) * 700
            cx = (tail[0] + tip[0]) / 2 - ux * (fly + bounce)
            cy = (tail[1] + tip[1]) / 2 - uy * (fly + bounce)
            arw_l = arrow(length=round(dist - 170))
            rot = arw_l.rotate(-math.degrees(math.atan2(uy, ux)), expand=True, resample=Image.BICUBIC)
            fr.alpha_composite(rot, (round(cx - rot.width / 2), round(cy - rot.height / 2)))
            lab = pill('TAP THE +', small, YELLOW, (0, 0, 0))
            paste_center(fr, lab, 360, 1375, alpha=clamp((t - 1.7) * 4))
        # Pulse rings where the follow button sits.
        if t > 1.75:
            d = ImageDraw.Draw(fr)
            for k in range(2):
                ph = ((t - 1.75) * 1.4 + k * 0.5) % 1
                r = 60 + 90 * ph
                a = int(255 * (1 - ph))
                ring = Image.new('RGBA', (W, H), (0, 0, 0, 0))
                ImageDraw.Draw(ring).ellipse([fx - r, fy - r, fx + r, fy + r], outline=(0, 0, 0, a), width=10)
                fr.alpha_composite(ring)
        # Small logo top-left, in black.
        paste_center(fr, logo_dark, 455, 330, alpha=clamp(t * 3))
        yield fr

# =====================================================================
def encode(name, frames):
    out = os.path.join(OUT, f'{name}.mp4')
    cmd = ['ffmpeg', '-y', '-loglevel', 'error',
           '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
           '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
           '-shortest', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
           '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    last = None
    for fr in frames:
        last = fr.convert('RGB')
        proc.stdin.write(last.tobytes())
    proc.stdin.close()
    proc.wait()
    last.save(os.path.join(OUT, f'{name}.png'))
    print('wrote', out)

if __name__ == '__main__':
    which = sys.argv[1:] or ['aisle', 'play', 'plus']
    for name in which:
        encode(name, {'aisle': render_aisle, 'play': render_play, 'plus': render_plus}[name]())
