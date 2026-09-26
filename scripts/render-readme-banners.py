"""Render the README banners using the shipped brand logo.

Requires Pillow: python -m pip install Pillow
Run from any directory: python scripts/render-readme-banners.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "assets"
OUT.mkdir(parents=True, exist_ok=True)

W = 1600
BG = (16, 17, 20)
SURFACE = (27, 27, 33)
SURFACE2 = (35, 34, 42)
TEXT = (245, 243, 248)
MUTED = (173, 170, 182)
LAV = (212, 184, 236)
PURPLE = (164, 114, 219)
GREEN = (168, 215, 188)
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

def ft(size: int, bold: bool = False):
    return ImageFont.truetype(BOLD if bold else FONT, size)

def rounded(d, box, fill, radius=22, outline=None, width=2):
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)

def text(d, xy, value, size, color=TEXT, bold=False):
    d.text(xy, value, font=ft(size, bold), fill=color)

def base(height: int, glow_x: int, glow_y: int):
    im = Image.new("RGB", (W, height), BG)
    glow = Image.new("RGBA", (W, height), (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    for rad, opacity in ((620, 28), (440, 35), (290, 36), (150, 27)):
        g.ellipse((glow_x-rad, glow_y-rad, glow_x+rad, glow_y+rad), fill=(158, 81, 214, opacity))
    glow = glow.filter(ImageFilter.GaussianBlur(95))
    im = Image.alpha_composite(im.convert("RGBA"), glow)
    d = ImageDraw.Draw(im)
    d.line((0, 0, W, 0), fill=(75, 55, 86), width=3)
    d.line((0, height-2, W, height-2), fill=(67, 54, 73), width=2)
    return im

def logo(im, x, y, width):
    path = ROOT / "app/img/ask2human_logo2.png"  # exact logo used by the landing page
    src = Image.open(path).convert("RGBA")
    src = src.crop(src.getchannel("A").getbbox())
    src = src.resize((width, round(src.height * width / src.width)), Image.Resampling.LANCZOS)
    im.alpha_composite(src, (x, y))
    return src.size

def screenshot(name, crop):
    src = Image.open(ROOT / f"screenshot/{name}.png").convert("RGB")
    return src.crop(crop)

def framed_shot(im, src, box, radius=21):
    x, y, width, height = box
    shadow = Image.new("RGBA", im.size)
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle((x-13, y-7, x+width+13, y+height+22), radius=radius+9,
                         fill=(0, 0, 0, 145))
    im.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(23)))
    d = ImageDraw.Draw(im)
    rounded(d, (x-2, y-2, x+width+2, y+height+2), (73, 68, 81), radius+2)
    fitted = ImageOps.fit(src, (width, height), Image.Resampling.LANCZOS)
    mask = Image.new("L", (width, height)); ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, width-1, height-1), radius=radius, fill=255)
    im.paste(fitted, (x, y), mask)

def pill(d, x, y, label, color=LAV):
    font = ft(19, True)
    width = round(d.textlength(label, font=font)) + 34
    rounded(d, (x, y, x+width, y+42), (46, 40, 53), 13, outline=(84, 68, 97))
    d.text((x+17, y+10), label, font=font, fill=color)
    return width

def save(im, name):
    dest = OUT / name
    im.convert("RGB").save(dest, optimize=True)
    print(dest.relative_to(ROOT), dest.stat().st_size)

def hero():
    im = base(400, 1390, 130)
    logo(im, 88, 83, 570)
    d = ImageDraw.Draw(im)
    text(d, (92, 260), "World ID · USDC on Sui", 28, MUTED)
    text(d, (800, 92), "AI agents hire humans.", 48, TEXT, True)
    text(d, (800, 162), "For real-world tasks.", 48, TEXT, True)
    text(d, (804, 266), "ask2human.me", 28, LAV)
    save(im, "readme-hero.png")

def tour():
    im = base(340, 1450, 100)
    d = ImageDraw.Draw(im)
    items = [
        ("01", "Post a task", ["Agent sets the brief", "and reward."]),
        ("02", "Choose a worker", ["People apply.", "The agent selects one."]),
        ("03", "Fund escrow", ["Owner approves", "and signs funding."]),
        ("04", "Deliver + pay", ["Worker sends proof.", "Owner signs payment."]),
    ]
    for i, (number, label, lines) in enumerate(items):
        x = 64 + i * 376
        rounded(d, (x, 40, x + 344, 296), SURFACE, 20, outline=(67, 56, 78))
        text(d, (x + 24, 63), number, 30, LAV, True)
        text(d, (x + 24, 123), label, 30, TEXT, True)
        for j, line in enumerate(lines):
            text(d, (x + 24, 191 + j * 34), line, 23, MUTED)
        if i < 3:
            text(d, (x + 348, 145), "›", 30, LAV, True)
    save(im, "readme-flow.png")

def owner():
    im = base(540, 1137, 290)
    d = ImageDraw.Draw(im)
    text(d, (88, 76), "One owner across", 53, TEXT, True)
    text(d, (88, 145), "multiple agents.", 53, LAV, True)
    text(d, (90, 256), "Agent profiles share one owner ID and payment record.", 23, MUTED)
    text(d, (90, 291), "Public tasks show a handle, not a legal name.", 23, MUTED)
    text(d, (90, 377), "Fresh approval checks task, worker and amount.", 21, TEXT, True)
    text(d, (90, 416), "A wallet signature moves the USDC.", 21, TEXT)
    # The diagram makes the data relationship legible even at README width.
    rounded(d, (855, 68, 1502, 470), SURFACE, 26, outline=(89, 72, 101))
    rounded(d, (982, 104, 1370, 194), (61, 46, 74), 18, outline=(143, 102, 173))
    d.ellipse((1009, 128, 1052, 171), fill=LAV)
    text(d, (1074, 118), "World owner ID", 26, TEXT, True)
    text(d, (1074, 158), "private", 18, MUTED)
    d.line((1176, 195, 1176, 247), fill=(178, 139, 207), width=4)
    d.line((1010, 247, 1345, 247), fill=(178, 139, 207), width=4)
    for x in (1010, 1345):
        d.line((x, 247, x, 275), fill=(178, 139, 207), width=4)
    for x, label in ((893, "Agent profile A"), (1220, "Agent profile B")):
        rounded(d, (x, 273, x+245, 360), (39, 39, 48), 16, outline=(105, 83, 118))
        text(d, (x+17, 297), label, 20, TEXT, True)
    rounded(d, (900, 390, 1457, 441), (38, 54, 45), 13, outline=(82, 120, 96))
    text(d, (926, 402), "Shared payment record", 21, GREEN, True)
    save(im, "readme-owner.png")

if __name__ == "__main__":
    hero(); tour(); owner()
