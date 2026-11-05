"""Wraps a phone-sized screenshot in a generic, hand-drawn phone frame for the README.

Usage:
  python3 -I scripts/phone-frame.py <src> <dst> [--crop-left PX]

--crop-left trims a left-hand pane (e.g. Obsidian's sidebar) before framing.

The camera pill and the home indicator are drawn in the bezel, never over the
screenshot, so no part of the captured UI is obscured.
"""
import sys
from PIL import Image, ImageDraw

args = [a for a in sys.argv[1:] if not a.startswith("--")]
crop_left = 0
if "--crop-left" in sys.argv:
    crop_left = int(sys.argv[sys.argv.index("--crop-left") + 1])

src, dst = args[0], args[1]
shot = Image.open(src).convert("RGBA")
if crop_left:
    shot = shot.crop((crop_left, 0, shot.width, shot.height))
w, h = shot.size
scale = w / 390  # the screenshot is 390 CSS px wide (before any crop)

side = round(4 * scale)
screen_r, body_r = round(46 * scale), round(58 * scale)
# Bezel must be tall enough at the top/bottom to hold the pill / home indicator.
pill_h = round(30 * scale)
bar_h = round(5 * scale)
bezel_top = pill_h + round(16 * scale)
bezel_bottom = bar_h + round(16 * scale)
bezel_x = round(14 * scale)

W = w + 2 * bezel_x + 2 * side
H = h + bezel_top + bezel_bottom
canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
draw = ImageDraw.Draw(canvas)

# Side buttons, drawn first so the body overlaps them.
button = (58, 58, 62, 255)
for top, length in ((150, 30), (200, 56), (266, 56)):
    draw.rounded_rectangle(
        (0, bezel_top + round(top * scale), side * 2, bezel_top + round((top + length) * scale)),
        radius=side, fill=button)
draw.rounded_rectangle(
    (W - side * 2, bezel_top + round(220 * scale), W, bezel_top + round(310 * scale)),
    radius=side, fill=button)

draw.rounded_rectangle((side, 0, W - side, H), radius=body_r, fill=(28, 28, 30, 255))
draw.rounded_rectangle((side + 3, 3, W - side - 3, H - 3), radius=body_r - 3,
                       outline=(72, 72, 76, 255), width=max(2, round(scale)))

mask = Image.new("L", (w, h), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, w, h), radius=screen_r, fill=255)
canvas.paste(shot, (side + bezel_x, bezel_top), mask)

# Camera pill in the top bezel, home indicator in the bottom bezel.
cx = W // 2
pill_w = round(110 * scale)
pill_top = (bezel_top - pill_h) // 2
draw.rounded_rectangle((cx - pill_w // 2, pill_top, cx + pill_w // 2, pill_top + pill_h),
                       radius=pill_h // 2, fill=(0, 0, 0, 255))
bar_w = round(134 * scale)
bar_top = bezel_top + h + (bezel_bottom - bar_h) // 2
draw.rounded_rectangle((cx - bar_w // 2, bar_top, cx + bar_w // 2, bar_top + bar_h),
                       radius=bar_h // 2, fill=(200, 200, 205, 255))

canvas.save(dst, optimize=True)
print(dst, canvas.size)
