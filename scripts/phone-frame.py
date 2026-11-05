"""Puts a phone frame around a screenshot of the plugin, styled after a real
iPhone screenshot (black body, thin highlight edge, status bar, home indicator).

The status bar is not drawn: it is lifted from a real iPhone capture given by
--status-bar-from, so no interface element in the result is invented.

Usage:
  python3 -I scripts/phone-frame.py <src> <dst> --status-bar-from <ref.png> [--crop-left PX]
"""
import sys
from PIL import Image, ImageDraw

def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default

src, dst = sys.argv[1], sys.argv[2]
ref_path = arg("--status-bar-from")
crop_left = int(arg("--crop-left", 0))

shot = Image.open(src).convert("RGBA")
if crop_left:
    shot = shot.crop((crop_left, 0, shot.width, shot.height))
W, H = shot.size
k = W / 454.0  # 454 = screen width of the reference capture

# --- real status bar, scaled to this screen width ---
if ref_path:
    ref = Image.open(ref_path).convert("RGBA")
    bar = ref.crop((20, 83, 474, 158))                 # status-bar strip of the reference
    bar = bar.resize((W, round(bar.height * W / bar.width)), Image.LANCZOS)
    shot.alpha_composite(bar, (0, 0))

# --- frame geometry, matching the reference ---
edge = max(2, round(4 * k))      # thin highlight on the outside
body = max(6, round(15 * k))     # black body between highlight and screen
screen_r = round(52 * k)
body_r = screen_r + body
CW = W + 2 * (edge + body)
CH = H + 2 * (edge + body)
canvas = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
draw = ImageDraw.Draw(canvas)

draw.rounded_rectangle((0, 0, CW - 1, CH - 1), radius=body_r + edge, fill=(122, 121, 121, 255))
draw.rounded_rectangle((edge, edge, CW - edge - 1, CH - edge - 1), radius=body_r, fill=(13, 13, 13, 255))

mask = Image.new("L", (W, H), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, W - 1, H - 1), radius=screen_r, fill=255)
canvas.paste(shot, (edge + body, edge + body), mask)

# --- home indicator, in the blank strip at the bottom of the screen ---
bar_w, bar_h = round(134 * k), round(5 * k)
bx, by = (CW - bar_w) // 2, edge + body + H - round(22 * k)
draw.rounded_rectangle((bx, by, bx + bar_w, by + bar_h), radius=bar_h // 2, fill=(20, 20, 20, 255))

canvas.save(dst, optimize=True)
print(dst, canvas.size, 'ratio', round(canvas.width / canvas.height, 3))
