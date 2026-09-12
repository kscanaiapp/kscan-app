"""FashionCLIP embedding subprocess (Build 35 Workstream 03).

Real inference code: loads patrickjohncyh/fashion-clip via `transformers`
and embeds either images or text, L2-normalized, writing a JSON result to
stdout. This file is invoked by fashionClipAdapter.js exactly the way
tools/fashion-match-quality/l1/runL1.js shells out to Deno for the L1
harness - a pinned external runtime running the real model, not a
reimplementation of it in JS.

Protocol: argv[1] is a path to a request JSON file:
  {"mode": "image", "inputs": ["/abs/path/one.png", ...]}
  {"mode": "text",  "inputs": ["burgundy leather bomber jacket", ...]}
Writes one JSON object to stdout:
  {"ok": true, "modelRevision": "<resolved commit sha>", "embeddings": [[...], ...]}
  {"ok": false, "blocker": "...", "detail": "..."}
on any failure (never a bare traceback - the Node wrapper needs a parseable
result either way).
"""

import json
import sys


def fail(blocker, detail):
    print(json.dumps({"ok": False, "blocker": blocker, "detail": str(detail)[:2000]}))
    sys.exit(0)


def main():
    if len(sys.argv) != 2:
        fail("BAD_ARGS", "usage: fashionClipAdapter.py <request.json>")
        return

    try:
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            request = json.load(f)
    except Exception as exc:  # noqa: BLE001 - this is a leaf process boundary
        fail("REQUEST_UNREADABLE", exc)
        return

    mode = request.get("mode")
    inputs = request.get("inputs") or []
    if mode not in ("image", "text") or not inputs:
        fail("BAD_REQUEST", f"mode must be 'image' or 'text' with a non-empty inputs list, got {request}")
        return

    try:
        import torch
        from transformers import CLIPModel, CLIPProcessor
    except Exception as exc:  # noqa: BLE001
        fail("RUNTIME_UNAVAILABLE", f"torch/transformers import failed: {exc}")
        return

    model_id = "patrickjohncyh/fashion-clip"
    try:
        model = CLIPModel.from_pretrained(model_id)
        processor = CLIPProcessor.from_pretrained(model_id)
    except Exception as exc:  # noqa: BLE001
        # Expected failure mode in any sandbox whose egress policy denies
        # huggingface.co and has no pre-seeded local cache - see
        # modelManifest.js's header comment.
        fail("MODEL_LOAD_FAILED", f"from_pretrained({model_id!r}) failed: {exc}")
        return

    revision = getattr(model.config, "_commit_hash", None) or "unknown"

    try:
        model.eval()
        with torch.no_grad():
            if mode == "image":
                from PIL import Image

                images = [Image.open(p).convert("RGB") for p in inputs]
                batch = processor(images=images, return_tensors="pt")
                features = model.get_image_features(**batch)
            else:
                batch = processor(text=inputs, return_tensors="pt", padding=True, truncation=True)
                features = model.get_text_features(**batch)

            features = features / features.norm(p=2, dim=-1, keepdim=True)
            embeddings = features.cpu().tolist()
    except Exception as exc:  # noqa: BLE001
        fail("INFERENCE_FAILED", exc)
        return

    print(json.dumps({"ok": True, "modelRevision": revision, "embeddings": embeddings}))


if __name__ == "__main__":
    main()
