import numpy as np
from PIL import Image
import os

SRC = r"C:\arc-swap-v9\assets\logos\_source"
DST = r"C:\arc-swap-v9\assets\logos"

jobs = [
    ("wordmark-source.png",      "wordmark-oneliq.png"),
    ("lockup-source.png",        "lockup-oneliq.png"),
    ("mark-gradient-source.png", "mark-oneliq.png"),
    ("mark-white-source.png",    "mark-oneliq-white.png"),
]

HARD_THRESH = 28   # pixels within this distance to bg -> fully transparent
SOFT_THRESH = 55   # pixels within this distance -> feathered

for src_name, dst_name in jobs:
    img = Image.open(os.path.join(SRC, src_name)).convert("RGBA")
    data = np.array(img, dtype=np.float32)

    # Sample bg from all 4 corners, median for robustness
    corners = [
        data[0, 0, :3],
        data[0, -1, :3],
        data[-1, 0, :3],
        data[-1, -1, :3],
    ]
    bg = np.median(corners, axis=0)
    print(f"{src_name}: bg RGB = {bg.astype(int).tolist()}")

    rgb = data[:, :, :3]
    dist = np.sqrt(np.sum((rgb - bg) ** 2, axis=2))

    # Soft mask: 0 near bg, 255 far from bg
    alpha = np.clip((dist - HARD_THRESH) / (SOFT_THRESH - HARD_THRESH), 0, 1) * 255
    alpha = alpha.astype(np.uint8)

    result = np.dstack([data[:, :, :3].astype(np.uint8), alpha])
    out = Image.fromarray(result, "RGBA")

    # Crop to bounding box of non-transparent pixels (removes dead space)
    bbox = out.getbbox()
    if bbox:
        out = out.crop(bbox)

    out_path = os.path.join(DST, dst_name)
    out.save(out_path, "PNG")
    print(f"  -> {dst_name}  ({out.size[0]}x{out.size[1]})")

print("Done.")
