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
import sys
from pathlib import Path

try:
    from PIL import Image, ImageCms, ImageOps
except ImportError as exc:
    raise SystemExit(
        "Pillow is required. Install it with: "
        ".venv-avatars/Scripts/pip install Pillow"
    ) from exc

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RAW_DIR = ROOT / "assets" / "stylist-avatars" / "portraits" / "raw"
DEFAULT_OUT_DIR = ROOT / "assets" / "stylist-avatars" / "portraits"
TARGET_SIZE = 1024
JPEG_QUALITY = 90
SUPPORTED_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"}
EXPECTED_STEMS = tuple(f"stylist_portrait_{index:02d}" for index in range(1, 11))


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


def convert_to_srgb(img: Image.Image) -> Image.Image:
    """Normalize orientation and convert pixels to standard sRGB."""
    img = ImageOps.exif_transpose(img)
    icc_profile = img.info.get("icc_profile")
    if icc_profile:
        try:
            source_profile = ImageCms.ImageCmsProfile(icc_profile)
            srgb_profile = ImageCms.createProfile("sRGB")
            return ImageCms.profileToProfile(
                img,
                source_profile,
                srgb_profile,
                outputMode="RGB",
            )
        except (ImageCms.PyCMSError, OSError, ValueError) as exc:
            raise ValueError(f"Could not convert {img.format or 'image'} color profile to sRGB") from exc

    if img.mode in ("RGBA", "LA", "P"):
        rgba = img.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    return img.convert("RGB") if img.mode != "RGB" else img.copy()


def process_image(src_path: Path, out_dir: Path, overwrite: bool) -> Path:
    """Generate a square optimized JPEG asset from a source image."""
    base_name = src_path.stem
    out_path = out_dir / f"{base_name}.jpg"
    if out_path.exists() and not overwrite:
        raise FileExistsError(
            f"Refusing to overwrite existing asset: {out_path}. Use --overwrite explicitly."
        )

    with Image.open(src_path) as img:
        normalized = convert_to_srgb(img)
        square = center_crop_square(normalized)
        resized = square.resize(
            (TARGET_SIZE, TARGET_SIZE),
            Image.Resampling.LANCZOS,
        )

        # Saving a fresh RGB image without EXIF or ICC arguments strips source metadata.
        resized.save(out_path, "JPEG", quality=JPEG_QUALITY, optimize=True)

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
        "--overwrite",
        action="store_true",
        help="Explicitly allow replacement of existing processed assets.",
    )
    args = parser.parse_args()

    raw_dir: Path = args.raw_dir
    out_dir: Path = args.out_dir
    if not raw_dir.exists():
        print(f"Raw input directory does not exist: {raw_dir}", file=sys.stderr)
        return 1

    out_dir.mkdir(parents=True, exist_ok=True)

    sources = sorted(
        p for p in raw_dir.iterdir()
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS
    )

    if not sources:
        print(f"No supported images found in {raw_dir}")
        return 1

    stems = [source.stem for source in sources]
    duplicate_stems = sorted({stem for stem in stems if stems.count(stem) > 1})
    unexpected_stems = sorted(set(stems) - set(EXPECTED_STEMS))
    missing_stems = sorted(set(EXPECTED_STEMS) - set(stems))
    if duplicate_stems or unexpected_stems or missing_stems:
        if duplicate_stems:
            print(f"Duplicate portrait source IDs: {', '.join(duplicate_stems)}", file=sys.stderr)
        if unexpected_stems:
            print(f"Unexpected portrait source IDs: {', '.join(unexpected_stems)}", file=sys.stderr)
        if missing_stems:
            print(f"Missing portrait source IDs: {', '.join(missing_stems)}", file=sys.stderr)
        return 1

    existing_outputs = [
        out_dir / f"{stem}.jpg"
        for stem in EXPECTED_STEMS
        if (out_dir / f"{stem}.jpg").exists()
    ]
    if existing_outputs and not args.overwrite:
        print(
            "Refusing to overwrite existing assets. Use --overwrite explicitly: "
            + ", ".join(path.name for path in existing_outputs),
            file=sys.stderr,
        )
        return 1

    for src in sources:
        try:
            out_path = process_image(src, out_dir, args.overwrite)
        except (OSError, ValueError) as exc:
            print(f"Failed to process {src.name}: {exc}", file=sys.stderr)
            return 1
        size_kb = out_path.stat().st_size // 1024
        print(f"Processed {src.name} -> {out_path.name} ({size_kb}KB)")

    print(f"\nDone. Assets written to {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
