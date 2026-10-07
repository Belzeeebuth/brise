#!/usr/bin/env python3
"""Génère les fonds d'écran de Brise (ui/wallpapers/*.svg) et le grain (grain.png).

Chaque scène existe en version jour et nuit. Le résultat est déterministe :
relancer le script redonne exactement les mêmes fichiers.
"""
import math
import random
from pathlib import Path

W, H = 1920, 1200
OUT = Path(__file__).resolve().parent.parent / "ui" / "wallpapers"


def smooth_path(points, close_y=H + 10):
    """Courbe lisse (Catmull-Rom → Bézier) fermée vers le bas de l'image."""
    pts = [points[0]] + points + [points[-1]]
    d = [f"M{points[0][0]:.0f} {points[0][1]:.1f}"]
    for i in range(1, len(pts) - 2):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[i + 1], pts[i + 2]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d.append(f"C{c1[0]:.0f} {c1[1]:.1f} {c2[0]:.0f} {c2[1]:.1f} {p2[0]:.0f} {p2[1]:.1f}")
    d.append(f"L{W + 10} {close_y}L-10 {close_y}Z")
    return "".join(d)


def ridge(rng, base, amp, waves=(1, 2, 3), step=48, drift=0.0, weights=(1, .45, .2)):
    """Ligne de crête : somme de sinusoïdes à phases aléatoires."""
    phases = [rng.uniform(0, math.tau) for _ in waves]
    pts = []
    for x in range(-step, W + 2 * step, step):
        t = x / W
        y = base + drift * (t - 0.5) * H
        for k, (n, ph, w) in enumerate(zip(waves, phases, weights)):
            y += amp * w * math.sin(math.tau * n * t * 1.1 + ph)
        pts.append((x, y))
    return pts


def mix(a, b, t):
    """Mélange de deux couleurs hexadécimales."""
    a, b = a.lstrip("#"), b.lstrip("#")
    ca = [int(a[i:i + 2], 16) for i in (0, 2, 4)]
    cb = [int(b[i:i + 2], 16) for i in (0, 2, 4)]
    return "#" + "".join(f"{round(x + (y - x) * t):02x}" for x, y in zip(ca, cb))


def svg(body, defs=""):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
            f'preserveAspectRatio="xMidYMid slice">{"<defs>" + defs + "</defs>" if defs else ""}{body}</svg>\n')


def sky(top, bottom, stop=1.0):
    return (f'<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{top}"/>'
            f'<stop offset="{stop}" stop-color="{bottom}"/></linearGradient>')


def glow(cx, cy, r, color, inner=0.9, outer=0.0):
    return (f'<radialGradient id="glow" cx="{cx}" cy="{cy}" r="{r}" gradientUnits="userSpaceOnUse">'
            f'<stop offset="0" stop-color="{color}" stop-opacity="{inner}"/>'
            f'<stop offset="1" stop-color="{color}" stop-opacity="{outer}"/></radialGradient>')


# ---------------------------------------------------------------- scènes

def brume(dark):
    """Collines dans la brume du matin."""
    rng = random.Random(11)
    if dark:
        top, bottom, far, near, mist = "#0a1118", "#1a2a36", "#1c3140", "#060b10", "#0e1a24"
    else:
        top, bottom, far, near, mist = "#dde7ee", "#f3f6f8", "#c4d3dc", "#5e7482", "#f3f6f8"
    body = [f'<rect width="{W}" height="{H}" fill="url(#sky)"/>']
    layers = 6
    for i in range(layers):
        t = i / (layers - 1)
        base = 540 + i * 100
        amp = 55 + i * 22
        color = mix(far, near, t ** 1.4)
        body.append(f'<path d="{smooth_path(ridge(rng, base, amp, (1, 2, 3), drift=rng.uniform(-0.08, 0.08)))}" fill="{color}"/>')
        if i < layers - 1:
            y0 = base + 40
            body.append(f'<rect x="0" y="{y0}" width="{W}" height="220" fill="url(#mist{i})"/>')
    defs = sky(top, bottom, 0.75)
    for i in range(layers - 1):
        defs += (f'<linearGradient id="mist{i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{mist}" stop-opacity="0"/>'
                 f'<stop offset=".55" stop-color="{mist}" stop-opacity=".{"28" if dark else "45"}"/><stop offset="1" stop-color="{mist}" stop-opacity="0"/></linearGradient>')
    return svg("".join(body), defs)


def dunes(dark):
    """Dunes au soleil couchant, ou sous la lune."""
    rng = random.Random(23)
    if dark:
        top, bottom = "#120f12", "#2b1c18"
        sand = ["#4a3328", "#3a271e", "#2b1c16", "#1c120e"]
        shade = "#120b08"
        light = "#efe3cf"
    else:
        top, bottom = "#f4e6d5", "#fbf1e4"
        sand = ["#eacfab", "#dcb888", "#c8955f", "#aa7444"]
        shade = "#8f5a33"
        light = "#f6c98a"
    body = [f'<rect width="{W}" height="{H}" fill="url(#sky)"/>']
    if dark:
        body.append('<circle cx="1460" cy="300" r="62" fill="#efe3cf"/><circle cx="1484" cy="282" r="58" fill="#1f1512"/>')
        for _ in range(60):
            x, y = rng.uniform(0, W), rng.uniform(0, 520)
            body.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{rng.uniform(.8, 1.8):.1f}" fill="#ffffff" opacity="{rng.uniform(.25, .7):.2f}"/>')
    else:
        body.append(f'<circle cx="1400" cy="430" r="520" fill="url(#glow)"/>')
        body.append('<circle cx="1400" cy="430" r="86" fill="#f8d7a6"/>')
    defs = sky(top, bottom, 0.8) + glow(1400, 430, 520, light, 0.55 if not dark else 0.2)
    for i, color in enumerate(sand):
        base = 660 + i * 125
        pts = ridge(rng, base, 38 + i * 24, (1, 2), drift=rng.choice([-0.12, 0.1]), weights=(1, .3))
        defs += (f'<linearGradient id="dune{i}" x1="0" y1="{base - 80}" x2="0" y2="{base + 260}" gradientUnits="userSpaceOnUse">'
                 f'<stop offset="0" stop-color="{color}"/><stop offset="1" stop-color="{mix(color, shade, .45)}"/></linearGradient>')
        body.append(f'<path d="{smooth_path(pts)}" fill="url(#dune{i})"/>')
    return svg("".join(body), defs)


def maree(dark):
    """Vagues à marée haute."""
    rng = random.Random(37)
    if dark:
        top, bottom = "#061419", "#0c2730"
        waves = ["#0d3a44", "#0b323b", "#092a32", "#07232a", "#051c22", "#04161b"]
        foam = "#7fd3dd"
    else:
        top, bottom = "#d6e9ee", "#eef6f8"
        waves = ["#9fd4d9", "#7ec3ca", "#5fb0b9", "#3f99a4", "#2a8590", "#1c6f7a"]
        foam = "#ffffff"
    body = [f'<rect width="{W}" height="{H}" fill="url(#sky)"/>']
    body.append(f'<rect x="0" y="560" width="{W}" height="{H}" fill="{waves[0]}"/>')
    for i, color in enumerate(waves):
        base = 600 + i * 100
        pts = ridge(rng, base, 9 + i * 4, (4, 7, 11), step=24, weights=(1, .5, .25))
        body.append(f'<path d="{smooth_path(pts)}" fill="{color}"/>')
        d = "M" + "L".join(f"{x:.0f} {y - 5:.1f}" for x, y in pts)
        body.append(f'<path d="{d}" fill="none" stroke="{foam}" stroke-width="2" stroke-linecap="round" opacity="{.22 if dark else .4}" stroke-dasharray="{rng.choice([90, 140, 200])} {rng.choice([260, 380, 520])}" stroke-dashoffset="{rng.randint(0, 400)}"/>')
    defs = sky(top, bottom, 0.5)
    return svg("".join(body), defs)


def nuit(dark):
    """Montagnes sous les étoiles ; version jour : crépuscule."""
    rng = random.Random(41)
    if dark:
        top, bottom = "#070a1a", "#1c2650"
        mountains = ["#151c40", "#0f1433", "#0a0d26", "#06081a"]
        star, moon = "#ffffff", "#f1e4bf"
    else:
        top, bottom = "#4a5a96", "#c9cfe6"
        mountains = ["#8c96c4", "#6b77ad", "#4d5a94", "#374379"]
        star, moon = "#ffffff", "#fff3cf"
    body = [f'<rect width="{W}" height="{H}" fill="url(#sky)"/>']
    for _ in range(170 if dark else 70):
        x, y = rng.uniform(0, W), rng.uniform(0, 700) ** 1.0
        r = rng.uniform(0.7, 2.3)
        body.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r:.1f}" fill="{star}" opacity="{rng.uniform(.3, .9) if dark else rng.uniform(.15, .45):.2f}"/>')
    body.append(f'<circle cx="420" cy="250" r="260" fill="url(#glow)"/>')
    body.append(f'<circle cx="420" cy="250" r="54" fill="{moon}"/><circle cx="440" cy="236" r="48" fill="url(#sky)"/>')
    for i, color in enumerate(mountains):
        base = 620 + i * 120
        body.append(f'<path d="{smooth_path(ridge(rng, base, 120 - i * 15, (2, 3, 7), step=36))}" fill="{color}"/>')
    defs = sky(top, bottom) + glow(420, 250, 260, moon, 0.22 if dark else 0.3)
    return svg("".join(body), defs)


def aurore(dark):
    """Bandes de l'aube au-dessus d'une plaine."""
    rng = random.Random(53)
    if dark:
        bands = ["#1a1f3c", "#3a2a4a", "#5a3650", "#7c4a52"]
        sun = "#ffb48a"
        hills = ["#20172a", "#130f1c"]
    else:
        bands = ["#c7d0ea", "#e2c8da", "#f5d3c6", "#fbe0c4"]
        sun = "#ffd8a3"
        hills = ["#7d7498", "#5d5578"]
    defs = '<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">'
    for i, c in enumerate(bands):
        defs += f'<stop offset="{i / (len(bands) - 1) * 0.7:.2f}" stop-color="{c}"/>'
    defs += "</linearGradient>" + glow(960, 790, 420, sun, 0.8 if not dark else 0.45)
    body = [f'<rect width="{W}" height="{H}" fill="url(#sky)"/>', '<circle cx="960" cy="790" r="420" fill="url(#glow)"/>',
            f'<circle cx="960" cy="790" r="70" fill="{sun}"/>']
    for i, color in enumerate(hills):
        base = 800 + i * 150
        body.append(f'<path d="{smooth_path(ridge(rng, base, 28 + i * 18, (1, 2, 3), drift=0.03))}" fill="{color}"/>')
    return svg("".join(body), defs)


def prairie(dark):
    """Collines de prairie sous un soleil pâle."""
    rng = random.Random(67)
    if dark:
        top, bottom = "#0a1611", "#15291f"
        greens = ["#1f3b2b", "#193224", "#13281c", "#0d1e14", "#081610"]
        sun = "#d8e6c8"
    else:
        top, bottom = "#d9e9ef", "#f1f6f7"
        greens = ["#b6cf98", "#9dbf7f", "#7ea862", "#5f8f4b", "#466f38"]
        sun = "#fff6cf"
    body = [f'<rect width="{W}" height="{H}" fill="url(#sky)"/>']
    if not dark:
        body.append('<circle cx="520" cy="360" r="340" fill="url(#glow)"/>')
        body.append(f'<circle cx="520" cy="360" r="74" fill="{sun}"/>')
    for i, color in enumerate(greens):
        base = 600 + i * 115
        body.append(f'<path d="{smooth_path(ridge(rng, base, 42 + i * 20, (1, 2, 3), drift=rng.uniform(-0.12, 0.12), weights=(1, .35, .12)))}" fill="{color}"/>')
    defs = sky(top, bottom, 0.7) + glow(520, 360, 340, sun, 0.5 if not dark else 0.12)
    return svg("".join(body), defs)


def papier(dark):
    """Papier uni avec quelques fibres."""
    rng = random.Random(79)
    base = "#1d1d1f" if dark else "#efebe3"
    fibre = "#ffffff" if dark else "#5b5247"
    body = [f'<rect width="{W}" height="{H}" fill="{base}"/>']
    for _ in range(140):
        x, y = rng.uniform(0, W), rng.uniform(0, H)
        length, angle = rng.uniform(40, 220), rng.uniform(-0.35, 0.35)
        x2, y2 = x + length * math.cos(angle), y + length * math.sin(angle)
        body.append(f'<line x1="{x:.0f}" y1="{y:.0f}" x2="{x2:.0f}" y2="{y2:.0f}" stroke="{fibre}" stroke-width="{rng.uniform(.6, 1.4):.1f}" opacity="{rng.uniform(.03, .09):.3f}" stroke-linecap="round"/>')
    return svg("".join(body))


def carreaux(dark):
    """Papier millimétré de bureau d'études."""
    base = "#10161b" if dark else "#e8edf0"
    line = "#ffffff" if dark else "#2a3a46"
    body = [f'<rect width="{W}" height="{H}" fill="{base}"/>']
    body.append(f'<path d="{"".join(f"M{x} 0V{H}" for x in range(0, W + 1, 48))}{"".join(f"M0 {y}H{W}" for y in range(0, H + 1, 48))}" stroke="{line}" stroke-width="1" opacity="{.07 if dark else .10}"/>')
    body.append(f'<path d="{"".join(f"M{x} 0V{H}" for x in range(0, W + 1, 240))}{"".join(f"M0 {y}H{W}" for y in range(0, H + 1, 240))}" stroke="{line}" stroke-width="1.2" opacity="{.14 if dark else .18}"/>')
    return svg("".join(body))


SCENES = {"brume": brume, "dunes": dunes, "maree": maree, "nuit": nuit, "aurore": aurore, "prairie": prairie, "papier": papier, "carreaux": carreaux}


def grain():
    """Tuile de grain translucide, répétée par-dessus les scènes."""
    from PIL import Image
    rng = random.Random(97)
    size = 160
    image = Image.new("RGBA", (size, size))
    pixels = image.load()
    for y in range(size):
        for x in range(size):
            value = 255 if rng.random() < 0.5 else 0
            pixels[x, y] = (value, value, value, rng.randint(0, 22))
    image.save(OUT / "grain.png", optimize=True)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, scene in SCENES.items():
        for variant, dark in (("light", False), ("dark", True)):
            (OUT / f"{name}-{variant}.svg").write_text(scene(dark))
    grain()
    print(f"{len(SCENES) * 2} fonds écrits dans {OUT}")
