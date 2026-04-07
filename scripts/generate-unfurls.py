#!/usr/bin/env python3
"""Generate unique unfurl/OG images for each garage.

Composites the garage dark image with the VHS Garage logo placed
in the transparent TV screen cutout. Output: 1200x630 PNG.

Usage: python3 scripts/generate-unfurls.py
"""

import json, sys
from pathlib import Path
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / 'public'
LOGO_PATH = PUBLIC / 'images' / 'vhs-garage-logo-still.png'
OUT_DIR = PUBLIC / 'images' / 'unfurls'
OG_W, OG_H = 1200, 630

# Read garages via deno (handles JS natively)
import subprocess
result = subprocess.run(
    ['deno', 'eval', 'import { GARAGES } from "./src/data/garages.js"; console.log(JSON.stringify(GARAGES.map(g => ({id: g.id, images: g.images, screen: g.screen}))));'],
    capture_output=True, text=True, cwd=str(ROOT)
)
if result.returncode != 0:
    print('Could not parse garages.js via deno:', result.stderr)
    sys.exit(1)
garages = json.loads(result.stdout.strip())

logo = Image.open(LOGO_PATH).convert('RGBA')
OUT_DIR.mkdir(parents=True, exist_ok=True)

for g in garages:
    gid = g['id']
    dark_path = PUBLIC / g['images']['dark'].lstrip('/')

    if not dark_path.exists():
        print(f'  SKIP {gid}: {dark_path} not found')
        continue

    print(f'  Generating unfurl for {gid}...')

    bg = Image.open(dark_path).convert('RGBA')
    bg_w, bg_h = bg.size

    # Compute cover crop to 1200x630
    bg_ratio = bg_w / bg_h
    og_ratio = OG_W / OG_H

    if bg_ratio > og_ratio:
        # Image is wider — fit to height, crop sides
        scale = OG_H / bg_h
        scaled_w = round(bg_w * scale)
        bg_resized = bg.resize((scaled_w, OG_H), Image.LANCZOS)
        left = (scaled_w - OG_W) // 2
        canvas = bg_resized.crop((left, 0, left + OG_W, OG_H))
    else:
        # Image is taller — fit to width, crop top/bottom
        scale = OG_W / bg_w
        scaled_h = round(bg_h * scale)
        bg_resized = bg.resize((OG_W, scaled_h), Image.LANCZOS)
        top = (scaled_h - OG_H) // 2
        canvas = bg_resized.crop((0, top, OG_W, top + OG_H))

    # Find the TV screen position (transparent area) in the cropped canvas
    # We need to map the original image percentages through the cover crop
    screen = g['screen']

    # The cover math: which portion of the original image is visible?
    if bg_ratio > og_ratio:
        # Cropped sides
        vis_x = (bg_w - OG_W / scale) / 2
        vis_y = 0
        vis_w = OG_W / scale
        vis_h = bg_h
    else:
        # Cropped top/bottom
        vis_x = 0
        vis_y = (bg_h - OG_H / scale) / 2
        vis_w = bg_w
        vis_h = OG_H / scale

    # TV position in original image pixels
    tv_x_orig = (screen['left'] / 100) * bg_w
    tv_y_orig = (screen['top'] / 100) * bg_h
    tv_w_orig = (screen['width'] / 100) * bg_w
    tv_h_orig = tv_w_orig * 3 / 4  # 4:3 aspect

    # TV position in the cropped/scaled canvas
    tv_x = (tv_x_orig - vis_x) * scale
    tv_y = (tv_y_orig - vis_y) * scale
    tv_w = tv_w_orig * scale
    tv_h = tv_h_orig * scale

    # Resize logo to fit the TV screen area
    logo_resized = logo.resize((round(tv_w), round(tv_h)), Image.LANCZOS)

    # Flatten: create black background, paste logo in TV area, then paste garage image on top
    # The garage image has transparency where the TV is, so the logo shows through
    result = Image.new('RGBA', (OG_W, OG_H), (0, 0, 0, 255))
    result.paste(logo_resized, (round(tv_x), round(tv_y)), logo_resized)
    result.paste(canvas, (0, 0), canvas)

    # Convert to RGB for PNG/social sharing
    final = Image.new('RGB', (OG_W, OG_H), (0, 0, 0))
    final.paste(result, mask=result.split()[3])

    out_path = OUT_DIR / f'unfurl-{gid}.png'
    final.save(out_path, 'PNG', optimize=True)
    print(f'    → {out_path.relative_to(ROOT)}')

print(f'\nDone! Generated {len(garages)} unfurl images.')
