"""Render the README banners from the shipped brand logo and product screenshots.

Requires Pillow: python -m pip install Pillow
Run from any directory: python scripts/render-readme-banners.py
"""
from __future__ import annotations

from pathlib import Path
import math

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
    im = base(620, 1210, 273)
    d = ImageDraw.Draw(im)
    logo(im, 92, 66, 395)
    text(d, (94, 203), "AI agents hire people", 55, TEXT, True)
    text(d, (94, 279), "for offline tasks.", 61, LAV, True)
    text(d, (96, 395), "Post tasks. Review work.", 26, MUTED)
    text(d, (96, 432), "Pay workers in USDC.", 26, MUTED)
    x = 96
    for label in ("WORLD ID", "SUI MAINNET", "API + MCP"):
        x += pill(d, x, 524, label) + 12
    market = screenshot("marketplace", (155, 34, 1200, 695))
    framed_shot(im, market, (845, 94, 680, 425))
    d = ImageDraw.Draw(im)
    rounded(d, (1143, 453, 1505, 546), (35, 33, 42), 16, outline=(100, 82, 115))
    d.ellipse((1164, 481, 1180, 497), fill=GREEN)
    text(d, (1195, 469), "Sui escrow", 24, TEXT, True)
    text(d, (1195, 505), "funded before work starts", 17, MUTED)
    save(im, "readme-hero.png")

def tour():
    im = base(590, 764, 158)
    d = ImageDraw.Draw(im)
    text(d, (82, 49), "How a task gets done", 49, TEXT, True)
    text(d, (84, 120), "Owner posts. Worker applies and delivers. Owner signs payment.", 23, MUTED)
    items = [
        ("hire-a-human", (165, 75, 1130, 618), "01  OWNER SETUP", "Set budget and task terms"),
        ("worker-onboarding", (160, 70, 1120, 610), "02  WORKER APPLIES", "Link wallet; complete Selfie Check"),
        ("completed-task", (103, 80, 1170, 650), "03  TASK PAID", "See payment and review"),
    ]
    for i, (name, crop, label, caption) in enumerate(items):
        x = 82 + i*488
        rounded(d, (x, 187, x+458, 548), SURFACE, 21, outline=(58, 54, 67))
        framed_shot(im, screenshot(name, crop), (x+14, 201, 430, 242), 13)
        d = ImageDraw.Draw(im)
        text(d, (x+20, 461), label, 19, LAV, True)
        text(d, (x+20, 497), caption, 19, TEXT)
        if i<2:
            rounded(d, (x+448, 331, x+486, 369), (94, 71, 112), 19)
            text(d, (x+460, 337), "›", 25, TEXT, True)
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
