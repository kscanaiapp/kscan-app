#!/usr/bin/env python3
"""
Process raw stylist portrait images into the final bundled assets.

Drop source images into:
  assets/stylist-avatars/portraits/raw/

Name them to match the registry IDs, e.g.:
  stylist_portrait_01.jpg
  stylist_portrait_02.png

Run:
  .venv-avatars/Scripts/python scripts/process-portrait-avatars.py

Output (for each source file):
  assets/stylist-avatars/portraits/stylist_portrait_01.jpg

Final assets are:
  - 1024 × 1024 pixels
  - Square (center-cropped if necessary)
  - sRGB JPEG
  - Quality-optimized
  - EXIF-stripped
"""

import argparse
import os
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError as exc:
    raise SystemExit(
        "Pillow is required. Install it with: "
        ".venv-avatars/Scripts/pip install Pillow"
    ) from exc

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RAW_DIR = ROOT / "assets" / "stylist-avatars" / "portraits" / "raw"
DEFAULT_OUT_DIR = ROOT / "assets" / "stylist-avatars" / "portraits"
TARGET_SIZE = 1024
SUPPORTED_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"}


def center_crop_square(img: Image.Image) -> Image.Image:
    """Crop the image to a square from the center."""
    width, height = img.size
    if width == height:
        return img
    size = min(width, height)
    left = (width - size) // 2
    top = (height - size) // 2
    right = left + size
    bottom = top + size
    return img.crop((left, top, right, bottom))


def process_image(src_path: Path, out_dir: Path, target_size: int) -> Path:
    """Generate a square optimized JPEG asset from a source image."""
    base_name = src_path.stem
    out_path = out_dir / f"{base_name}.jpg"

    with Image.open(src_path) as img:
        # Convert palette/transparency to RGB with white background.
        if img.mode in ("RGBA", "P"):
            background = Image.new("RGB", img.size, (255, 255, 255))
            if img.mode == "P":
                img = img.convert("RGBA")
            background.paste(img, mask=img.split()[3])
            img = background
        elif img.mode != "RGB":
            img = img.convert("RGB")

        square = center_crop_square(img)
        resized = square.resize(
            (target_size, target_size),
            Image.Resampling.LANCZOS,
        )

        # Strip EXIF by saving without exif parameter.
        resized.save(out_path, "JPEG", quality=90, optimize=True)

    return out_path


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Process stylist portrait images into bundled JPEG assets."
    )
    parser.add_argument(
        "--raw-dir",
        type=Path,
        default=DEFAULT_RAW_DIR,
        help="Directory containing source portrait images.",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_OUT_DIR,
        help="Directory for processed portrait assets.",
    )
    parser.add_argument(
        "--size",
        type=int,
        default=TARGET_SIZE,
        help="Target asset size in pixels (default 1024).",
    )
    args = parser.parse_args()

    raw_dir: Path = args.raw_dir
    out_dir: Path = args.out_dir
    target_size: int = args.size

    if not raw_dir.exists():
        print(f"Creating raw input directory: {raw_dir}")
        raw_dir.mkdir(parents=True, exist_ok=True)

    out_dir.mkdir(parents=True, exist_ok=True)

    sources = sorted(
        p for p in raw_dir.iterdir()
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS
    )

    if not sources:
        print(f"No supported images found in {raw_dir}")
        return 1

    for src in sources:
        out_path = process_image(src, out_dir, target_size)
        size_kb = out_path.stat().st_size // 1024
        print(f"Processed {src.name} -> {out_path.name} ({size_kb}KB)")

    print(f"\nDone. Assets written to {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
