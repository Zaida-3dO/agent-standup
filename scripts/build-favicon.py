#!/usr/bin/env python3
"""Renders the raster favicon set from the same geometry as `src/app/icon.svg`.

Why a script and not a one-off export
-------------------------------------
The mark is three rounded rectangles on a rounded plate — geometry simple
enough that it can be drawn directly rather than rasterised from the SVG,
which means the PNGs can be REGENERATED rather than being binary artefacts
nobody can reproduce. A favicon checked in with no way to rebuild it is a
file that quietly stops matching the vector version the first time the
vector changes.

The numbers below are duplicated from `icon.svg` and that duplication is
the one real cost here. It is accepted because the alternative — parsing
the SVG, or adding a headless-browser rasteriser to the toolchain — is far
more machinery than three rectangles justify. `tests/favicon.test.ts`
guards the copy: it reads both files and fails if the geometry drifts
apart, so the duplication cannot rot silently.

Run: python scripts/build-favicon.py
"""

from PIL import Image, ImageDraw

# ── Geometry, in the SVG's 64-unit coordinate space ──────────────────────
VIEWBOX = 64
PLATE_RADIUS = 14
PLATE = "#1d1b26"

# (x, y, width, height, radius, fill) — see icon.svg for why these values.
BARS = [
    (6, 18, 12, 34, 6, "#5ee9a0"),   # executing
    (26, 32, 12, 20, 6, "#fbbf24"),  # paused
    (46, 25, 12, 27, 6, "#7dd3fc"),  # in_review
]


def render(size: int) -> Image.Image:
    """Draws the mark at `size` px.

    Supersampled 8x and downscaled with LANCZOS. Pillow's rounded_rectangle
    has no antialiasing of its own, so drawing straight at 16px would give
    hard-edged stair-stepping on every curve — at that size the aliasing is
    a larger visual feature than the shapes themselves. Supersampling is the
    standard fix and costs nothing here.
    """
    ss = 8
    px = size * ss
    scale = px / VIEWBOX

    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    draw.rounded_rectangle(
        [0, 0, px - 1, px - 1],
        radius=PLATE_RADIUS * scale,
        fill=PLATE,
    )

    for x, y, w, h, r, fill in BARS:
        draw.rounded_rectangle(
            [x * scale, y * scale, (x + w) * scale, (y + h) * scale],
            radius=r * scale,
            fill=fill,
        )

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    # `favicon.ico` carries several sizes in one file: the browser picks the
    # one matching its context (tab, bookmark bar, desktop shortcut), and an
    # .ico with only one size gets scaled by the OS instead — which on
    # Windows is a noticeably worse resampler than the one above.
    ico_sizes = [16, 32, 48]
    frames = [render(s) for s in ico_sizes]
    frames[0].save(
        "src/app/favicon.ico",
        format="ICO",
        sizes=[(s, s) for s in ico_sizes],
        append_images=frames[1:],
    )

    # 180px is what iOS asks for; it downsamples for every smaller context.
    render(180).save("src/app/apple-icon.png", format="PNG")
    # A general-purpose PNG for anything that will not take an SVG.
    render(192).save("src/app/icon.png", format="PNG")

    print("wrote src/app/favicon.ico, src/app/apple-icon.png, src/app/icon.png")


if __name__ == "__main__":
    main()
