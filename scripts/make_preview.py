from PIL import Image, ImageDraw
import os

LOGOS = r"C:\arc-swap-v9\assets\logos"
wm = Image.open(os.path.join(LOGOS, "wordmark-oneliq.png")).convert("RGBA")
mk = Image.open(os.path.join(LOGOS, "mark-oneliq.png")).convert("RGBA")
lk = Image.open(os.path.join(LOGOS, "lockup-oneliq.png")).convert("RGBA")

BG  = (11, 26, 48)
BG2 = (15, 35, 66)
W, H = 760, 380
canvas = Image.new("RGB", (W, H), BG)
draw = ImageDraw.Draw(canvas)

def card(x, y, w, h):
    draw.rounded_rectangle([x, y, x+w, y+h], radius=8, fill=BG2, outline=(30, 58, 95))

def paste_on(img, cx, cy, target_h):
    r = target_h / img.height
    tw, th = int(img.width * r), int(img.height * r)
    ir = img.resize((tw, th), Image.LANCZOS)
    canvas.paste(ir, (cx - tw // 2, cy - th // 2), ir)

# Wordmark row
card(28, 32, 210, 52);  paste_on(wm, 133, 58, 28)
card(252, 32, 210, 52); paste_on(wm, 357, 58, 28)

# Mark row
card(28, 112, 84, 84);  paste_on(mk, 70,  154, 60)
card(128, 112, 84, 84); paste_on(mk, 170, 154, 60)
card(228, 112, 52, 52); paste_on(mk, 254, 154, 32)

# Lockup row
card(28, 220, 170, 110);  paste_on(lk, 113, 275, 72)
card(214, 220, 170, 110); paste_on(lk, 299, 275, 72)

out = r"C:\arc-swap-v9\.preview-oneliq.png"
canvas.save(out, "PNG")
print(f"Saved: {out}  ({W}x{H})")
