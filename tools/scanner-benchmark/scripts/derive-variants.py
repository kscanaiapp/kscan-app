#!/usr/bin/env python3
"""Deterministic "difficult condition" variants for the Build 42 Scanner benchmark.

    python -I tools/scanner-benchmark/scripts/derive-variants.py <asset-root> <manifest.json>

Each derived case names its source case and one transform. Labels are inherited
unchanged from the source, so label independence is preserved: the transform is
applied to an already-labelled image, never labelled by looking at the output.

Determinism: identical bytes for identical Pillow + libjpeg versions. The manifest
records the Pillow version used to produce derivedSha256; a mismatch on another
toolchain is reported as `toolchain_differs`, not as a data error.
"""
import hashlib
import io
import json
import os
import sys

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter
import PIL

TRANSFORMS = {
    # name: (description, function)
    "low_light": ("brightness x0.35, contrast x0.8", lambda im: ImageEnhance.Contrast(ImageEnhance.Brightness(im).enhance(0.35)).enhance(0.8)),
    "motion_blur": ("Gaussian blur radius 4 (defocus/motion proxy)", lambda im: im.filter(ImageFilter.GaussianBlur(radius=4))),
    "occlusion": ("opaque grey bar over the central 30% height band, 60% width", None),
    "rotation": ("rotate 23 degrees, expand, mid-grey fill", lambda im: im.rotate(23, resample=Image.BICUBIC, expand=True, fillcolor=(128, 128, 128))),
    "heavy_compression": ("JPEG quality 12 re-encode", None),
    "overexposed": ("brightness x1.8", lambda im: ImageEnhance.Brightness(im).enhance(1.8)),
}


def occlude(im):
    im = im.copy()
    w, h = im.size
    d = ImageDraw.Draw(im)
    d.rectangle([int(w * 0.2), int(h * 0.35), int(w * 0.8), int(h * 0.65)], fill=(96, 96, 96))
    return im


def encode(im, quality=85):
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=quality, optimize=False, subsampling=2)
    return buf.getvalue()


def main():
    root, manifest_path = sys.argv[1], sys.argv[2]
    manifest = json.load(open(manifest_path, encoding="utf-8"))
    results = []
    for c in manifest["cases"]:
        src = c.get("source", {})
        if src.get("kind") != "derived":
            continue
        name = src["transform"]
        if name not in TRANSFORMS:
            results.append({"caseId": c["caseId"], "status": "unknown_transform"})
            continue
        with Image.open(os.path.join(root, src["derivedFrom"] + ".jpg")) as im:
            im = im.convert("RGB")
            if name == "occlusion":
                out = encode(occlude(im))
            elif name == "heavy_compression":
                out = encode(im, quality=12)
            else:
                out = encode(TRANSFORMS[name][1](im))
        digest = hashlib.sha256(out).hexdigest()
        with open(os.path.join(root, c["caseId"] + ".jpg"), "wb") as f:
            f.write(out)
        expected = src.get("derivedSha256")
        status = "ok" if expected in (None, digest) else ("toolchain_differs" if src.get("pillowVersion") != PIL.__version__ else "mismatch")
        results.append({"caseId": c["caseId"], "sha256": digest, "status": status})
    print(json.dumps({"pillowVersion": PIL.__version__, "results": results}, indent=1))
    sys.exit(1 if any(r["status"] == "mismatch" for r in results) else 0)


if __name__ == "__main__":
    main()
