"""Draw the app icon as PNG at the sizes an install prompt wants.

There is no SVG renderer on this machine, and the mark is plain geometry, so
it is drawn from the same coordinates as web/icon.svg rather than converted.
Keep the two in step by hand: this file is the raster copy of that drawing.

    python tools/render-icons.py
"""
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "icons")

GROUND = "#0b0f14"
MARK = "#35d0a5"

# The SVG works on a 64-unit grid; everything below is in those units.
GRID = 64.0
BODY = (15, 18, 49, 46)          # battery outline
BODY_STROKE = 3.5
BODY_RADIUS = 1
TERMINAL = (49, 27, 55, 37)      # the nub, filled
WAVE = [(21, 33), (27, 33), (30.5, 26), (35.5, 40), (39, 33), (44, 33)]
WAVE_STROKE = 3.2
TILE_RADIUS = 3


def render(size, padding=0.0, ground=True):
    """padding is a fraction of the canvas kept clear, for maskable icons."""
    scale = 4  # supersample, then resample down for clean edges
    canvas = size * scale
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    if ground:
        radius = TILE_RADIUS / GRID * canvas
        draw.rounded_rectangle([0, 0, canvas - 1, canvas - 1], radius=radius, fill=GROUND)

    inner = canvas * (1 - 2 * padding)
    offset = canvas * padding
    unit = inner / GRID

    def at(x, y):
        return (offset + x * unit, offset + y * unit)

    x0, y0, x1, y1 = BODY
    draw.rounded_rectangle(
        [at(x0, y0), at(x1, y1)],
        radius=BODY_RADIUS / GRID * inner,
        outline=MARK,
        width=max(1, round(BODY_STROKE * unit)),
    )

    tx0, ty0, tx1, ty1 = TERMINAL
    draw.rounded_rectangle(
        [at(tx0, ty0), at(tx1, ty1)],
        radius=BODY_RADIUS / GRID * inner,
        fill=MARK,
    )

    draw.line(
        [at(x, y) for x, y in WAVE],
        fill=MARK,
        width=max(1, round(WAVE_STROKE * unit)),
        joint="curve",
    )
    # Round the ends the way stroke-linecap does.
    cap = max(1, round(WAVE_STROKE * unit)) / 2
    for x, y in (WAVE[0], WAVE[-1]):
        cx, cy = at(x, y)
        draw.ellipse([cx - cap, cy - cap, cx + cap, cy + cap], fill=MARK)

    return image.resize((size, size), Image.LANCZOS)


os.makedirs(OUT, exist_ok=True)

for size in (192, 512):
    path = os.path.join(OUT, "icon-%d.png" % size)
    render(size).save(path)
    print("wrote", os.path.relpath(path, ROOT).replace(os.sep, "/"))

# Maskable icons get cropped to whatever shape the platform likes, so the mark
# has to sit inside the safe area with the ground running to the edge.
path = os.path.join(OUT, "icon-maskable-512.png")
render(512, padding=0.14).save(path)
print("wrote", os.path.relpath(path, ROOT).replace(os.sep, "/"))
