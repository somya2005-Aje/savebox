#!/usr/bin/env python3
"""Render the SaveBox shield logo (from final-deploy/js/app.js LOGO_SVG) into
launcher icons: 1024 master, per-density legacy + round + adaptive foreground,
and web PWA icons. Pure PIL — no SVG renderer available on this box."""
import os
from PIL import Image, ImageDraw

OUT = os.path.expanduser("~/workspace/savebox/assets")
RES = os.path.expanduser("~/workspace/savebox/android-app/android/app/src/main/res")
WEB = os.path.expanduser("~/workspace/savebox/final-deploy")
NAVY = (16, 42, 67, 255)
BLUE_D = (23, 105, 170, 255)
BLUE_L = (47, 143, 229, 255)
GOLD = (245, 179, 1, 255)
WHITE = (255, 255, 255, 255)
DENS = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
FG = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}


def cubic(p0, p1, p2, p3, n=24):
    pts = []
    for i in range(n + 1):
        t = i / n
        mt = 1 - t
        x = mt**3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t**3 * p3[0]
        y = mt**3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t**3 * p3[1]
        pts.append((x, y))
    return pts


def shield_points():
    """Shield outline in viewBox (48x48) coords."""
    pts = [(24, 4), (42, 12), (42, 26)]
    pts += cubic((42, 26), (42, 35), (34.5, 41), (24, 44))
    pts += cubic((24, 44), (13.5, 41), (6, 35), (6, 26))
    pts += [(6, 12)]
    return pts


def right_half_points():
    pts = [(24, 4), (42, 12), (42, 26)]
    pts += cubic((42, 26), (42, 35), (34.5, 41), (24, 44))
    return pts


def draw_shield(size):
    """Shield (blue halves + white cloud + check + gold dot) on transparency.
    size = canvas px; viewBox 48 maps to the full canvas."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = size / 48.0

    def xy(p):
        return (p[0] * s, p[1] * s)

    d.polygon([xy(p) for p in shield_points()], fill=BLUE_D)
    # right half, lighter blue at 85% opacity
    half = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(half).polygon([xy(p) for p in right_half_points()],
                                 fill=BLUE_L[:3] + (int(255 * 0.85),))
    img = Image.alpha_composite(img, half)
    d = ImageDraw.Draw(img)
    # white cloud: rounded base + two humps
    d.rounded_rectangle([14 * s, 24 * s, 31 * s, 33 * s], radius=5 * s, fill=WHITE)
    d.ellipse([14 * s, 18.5 * s, 26 * s, 30.5 * s], fill=WHITE)
    d.ellipse([21 * s, 17.5 * s, 31.5 * s, 28 * s], fill=WHITE)
    # check mark in dark blue
    w = 2.4 * s
    pts = [(20.5, 26.5), (23, 29), (27.5, 24)]
    for a, b in zip(pts, pts[1:]):
        d.line([xy(a), xy(b)], fill=BLUE_D, width=int(round(w)))
    for p in pts:
        r = w / 2
        d.ellipse([p[0] * s - r, p[1] * s - r, p[0] * s + r, p[1] * s + r], fill=BLUE_D)
    # gold dot
    r = 3.2 * s
    d.ellipse([36 * s - r, 12 * s - r, 36 * s + r, 12 * s + r], fill=GOLD)
    return img


def paste_center(bg, fg, target_w):
    """Paste fg (square, transparent) scaled so its shield width == target_w.
    Shield spans x 6..42 of 48 in the fg canvas."""
    scale = target_w / (fg.width * 36 / 48)
    nw = int(round(fg.width * scale))
    fg2 = fg.resize((nw, nw), Image.LANCZOS)
    x = (bg.width - nw) // 2
    y = (bg.height - nw) // 2
    bg.alpha_composite(fg2, (x, y))
    return bg


os.makedirs(OUT, exist_ok=True)
shield = draw_shield(1024)
shield.save(os.path.join(OUT, "shield-1024.png"))

# --- master 1024: full-bleed navy, shield ~69% width ---
master = Image.new("RGBA", (1024, 1024), NAVY)
paste_center(master, shield, 705)
master.save(os.path.join(OUT, "icon-1024.png"))

# --- legacy + round + foreground per density ---
for name, size in DENS.items():
    # legacy: downscale master
    master.resize((size, size), Image.LANCZOS).save(
        os.path.join(RES, f"mipmap-{name}", "ic_launcher.png"))
    # round: navy circle, shield ~66% of diameter
    rnd = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(rnd).ellipse([0, 0, size - 1, size - 1], fill=NAVY)
    paste_center(rnd, shield, int(round(size * 0.66)))
    rnd.save(os.path.join(RES, f"mipmap-{name}", "ic_launcher_round.png"))
    # adaptive foreground: transparent, shield 66/108 of canvas
    fg = Image.new("RGBA", (FG[name], FG[name]), (0, 0, 0, 0))
    paste_center(fg, shield, int(round(FG[name] * 66 / 108)))
    fg.save(os.path.join(RES, f"mipmap-{name}", "ic_launcher_foreground.png"))

# --- web PWA icons ---
master.resize((512, 512), Image.LANCZOS).save(os.path.join(WEB, "icon-512.png"))
master.resize((192, 192), Image.LANCZOS).save(os.path.join(WEB, "icon-192.png"))
master.resize((512, 512), Image.LANCZOS).save(os.path.join(WEB, "icon-512-maskable.png"))

# --- stats ---
import statistics
px = list(master.convert("RGB").getdata())
mean = tuple(round(statistics.mean(c[i] for c in px), 1) for i in range(3))
print("master 1024 mean RGB:", mean, "size:", master.size)
for name, size in DENS.items():
    p = os.path.join(RES, f"mipmap-{name}", "ic_launcher.png")
    print(name, size, os.path.getsize(p), "bytes")
print("done")
