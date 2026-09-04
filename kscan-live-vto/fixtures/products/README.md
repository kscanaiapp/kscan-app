# Authorized real product fixtures

**Delivery location for the seven images named in the owner authorization
dated 2026-09-04.** As of this file's last update the directory holds the
authorization record and this README only — **no image has been delivered
yet.**

Run `node tools/validate-authorized-assets.js` from `kscan-live-vto/` to see
current status: which authorized assets are present, which are still
outstanding, and whether anything unauthorized has appeared.

## What is authorized

Exactly seven files, by exact filename. The authorization's own scope clause
is *"Authorization applies only to the exact files listed in this document"*,
and it names "adding unrelated retailer/catalog images not listed above" as
not permitted. `authorized-assets.json` is the machine-readable record and
`tools/validate-authorized-assets.js` enforces it; adding an eighth image
here fails that check rather than silently widening the corpus.

| Fixture ID | File | Shot class | Garment |
|---|---|---|---|
| `tee-flatlay-001` | `tee-flatlay-001.jpg` | flat lay | t-shirt |
| `tee-flatlay-002` | `tee-flatlay-002.jpg` | flat lay | t-shirt |
| `top-ghost-001` | `top-ghost-001.jpg` | ghost mannequin | top |
| `top-ghost-002` | `top-ghost-002.jpg` | ghost mannequin | top |
| `tee-studio-001` | `tee-studio-001.jpg` | clean studio | t-shirt |
| `sweater-studio-001` | `sweater-studio-001.jpg` | clean studio | sweater |
| `tee-logo-001` | `tee-logo-001.jpg` | to confirm on delivery | t-shirt, directional canary |

The set covers the three preferred shot classes (flat lay > ghost mannequin >
clean studio) and includes a directional/logo canary. Nothing in it is
model-worn.

## Two things to settle before ingestion can run

**1. The files are not here.** They were named in the authorization but the
bytes have not been delivered into the repository or this session. Nothing
can be ingested until they are.

**2. Format.** All seven are named `.jpg`. `packages/static-renderer`
implements a pure-Node PNG codec over `node:zlib` and has **no JPEG
decoder**, and `tests/privacy/dependencyBoundary.test.js` pins the external
runtime dependency allow-list to **empty** on purpose — a new decoder
dependency is a reviewed decision, not a silent addition. Three ways
forward, in the order they are worth considering:

- **Deliver lossless PNG (or TIFF) exports of the same seven images.**
  Cheapest, and better for asset work regardless: JPEG blocking artifacts
  sit exactly where garment edges are, which is where masking and
  control-point placement are most sensitive. Keep the filenames otherwise
  identical and update `authorized-assets.json`'s `file` fields in the same
  change.
- **Write a baseline JPEG decoder** inside the workspace, keeping the
  zero-dependency posture. Feasible (Huffman + IDCT + chroma upsampling)
  but a real chunk of work, and progressive JPEGs would need either separate
  handling or explicit rejection.
- **Add a reviewed JPEG dependency**, which means an entry in the
  dependency allow-list plus a per-SDK record in
  `docs/vto-risk-register.md` per the Section 32 requirement.

## Handling rules

These are isolated-development fixtures. Per the authorization: no unrelated
ML training, no public redistribution, no external publication, no
customer-facing use. They must never be bundled into a production build.
Derived artifacts (masks, `.ksgarment` bundles, renders) inherit the same
restrictions — see `docs/fixture-consent-log.md`.
