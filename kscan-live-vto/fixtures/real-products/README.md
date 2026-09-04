# Authorized real product fixtures

**Canonical delivery location for the seven images named in the owner
authorization dated 2026-09-04.** This directory (`fixtures/real-products/`)
is the *only* path for authorized real-product corpus fixtures — an earlier
`fixtures/products/` path was renamed to this one on 2026-09-05 and must not
be reintroduced or used in parallel. As of this file's last update the
directory holds the authorization record and this README only — **no image
has been delivered yet, and nothing has been ingested or processed.**

Run `node tools/validate-authorized-assets.js` from `kscan-live-vto/` to see
current status: which authorized assets are present, which are still
outstanding, which are present but in the wrong format, and whether anything
unauthorized has appeared.

## What is authorized

Exactly seven files, by exact filename. The authorization's own scope clause
is *"Authorization applies only to the exact files listed in this document"*,
and it names "adding unrelated retailer/catalog images not listed above" as
not permitted. `authorized-assets.json` is the machine-readable record and
`tools/validate-authorized-assets.js` enforces it; adding an eighth image
here fails that check rather than silently widening the corpus.

| Fixture ID | File (as authorized) | Shot class | Garment |
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

**`assets/qa_fixtures/top.jpg` is not on this list and stays excluded.**
The owner separately stated K Scan holds the rights to it, but the
authorization above is self-limiting and does not name it. That is not
inferred authorization, and the gate refuses it accordingly. Adding it would
be a one-line, deliberate change to `authorized-assets.json` if the owner
explicitly extends the authorization to include it — not something derived
from the ownership statement, its presence in the repository, or its prior
use in QA tests.

## Format decision: PNG only (2026-09-04)

For this Phase 1 corpus, authorized fixtures will be supplied **as PNG.**
This is a closed decision for this corpus, not an open question:

- **No JPEG decoder will be implemented.**
- **No image-decoding dependency will be added.** The zero-external-runtime-
  dependency boundary (`tests/privacy/dependencyBoundary.test.js`, allow-list
  empty by design) stays exactly as it is.
- **No TIFF support.**
- **No automatic conversion** from any external source.

The authorized filenames above are still exactly `.jpg` — that is what the
owner's authorization named, and **this file does not rename them.**
`tee-flatlay-001.jpg` does not authorize `tee-flatlay-001.png`; extensions
are never translated by inference, here or in the validator. **The owner
must supply the exact PNG filenames**, as an explicit update to the `assets`
array in `authorized-assets.json` (not a search-and-replace of `.jpg` to
`.png`). Until that happens, delivery of the current `.jpg`-named files
would still fail the format check — the validator reports that case
separately from "not yet delivered" — and **Gate B remains HOLD — OWNER
FIXTURE CORPUS REQUIRED** either way.

If a future production ingestion path needs JPEG support, that is a separate
architecture decision, made deliberately, not a side effect of this corpus.

## Generative-VTO benchmark: garment fixtures are only half of it

Do not describe these seven garment fixtures as sufficient to unblock the
generative-VTO benchmark documented in `docs/vto-provider-benchmark.md`.
They supply the garment side only. That benchmark also requires explicitly
consented test-**person** imagery, which is a separate, stricter requirement
(Section 31 consent, logged per-subject in `docs/fixture-consent-log.md`
before first use) — no customer imagery, and no arbitrary employee/developer
photo without that consent on record.

```
GARMENT FIXTURES:    PENDING BYTES  (authorized; 0/7 delivered)
PERSON FIXTURES:     NOT AUTHORIZED / NOT PROVIDED
GENERATIVE BENCHMARK: BLOCKED
```

## When files arrive — the procedure, in order

Do not begin processing before exact authorization and exact bytes match —
that includes format. Once files land in this directory:

1. **Verify exact filenames** against `authorized-assets.json`'s `assets[].file`
   list — exact string match, not a fuzzy or stem match.
2. **Verify no unauthorized extra files are present** — run
   `node tools/validate-authorized-assets.js`; it must report PASS with zero
   `presentButUnauthorized` entries before anything proceeds.
3. **Record hashes** of each accepted file (e.g. SHA-256), so the exact bytes
   reviewed and processed are provably the bytes delivered — written into the
   per-asset provenance record, not just trusted from the filesystem.
4. **Classify shot class** for each asset against what's actually in the
   image (flat lay / ghost mannequin / clean studio / model-worn), confirming
   or correcting the `shotClass` recorded in `authorized-assets.json` — the
   `tee-logo-001` entry is explicitly marked "to confirm on delivery."
5. **Run the authorized-asset validator** (step 2, repeated as a gate
   immediately before any processing begins, not only as a one-time check).
6. **Run the real-asset pipeline** — `.ksgarment` preparation, masking,
   control-point annotation — against accepted assets only.
7. **Preserve per-stage provenance** for every asset, per the existing
   pipeline-provenance discipline (source image / mask / control points /
   normalization / final disposition — see `docs/vto-phase1-end-report.md`'s
   provenance format). Never hide manual intervention.
8. **Generate the real-asset review package**, structured like the existing
   static-preview review packages, for human review before any conclusion is
   drawn from it.

No step here has been executed. This is the plan for when it can be.

## Handling rules

These are isolated-development fixtures. Per the authorization: no unrelated
ML training, no public redistribution, no external publication, no
customer-facing use, no unlisted retailer/catalog images. They must never be
bundled into a production build. Derived artifacts (masks, `.ksgarment`
bundles, renders) inherit the same restrictions — see
`docs/fixture-consent-log.md`.
