# VTO Phase 4 — Gate E: Results

## Executive summary

```
REAL PRODUCTS EVALUATED:      0

AUTOMATIC LIVE2D:             0 / 0   — not measurable
REJECTED:                     0 / 0   — not measurable
SYSTEM ERRORS:                0 / 0   — not measurable
EASY+MEDIUM AUTO SUCCESS:     not measurable

TOP 5 REJECTION CAUSES:       none — no product reached the pipeline
HUMAN FIDELITY RESULT:        PENDING — no accepted real asset exists to review
CORRECTION ECONOMICS:         NOT MEASURED
COMPUTE ECONOMICS:            NOT CALCULATED — no real SKU processed

OVERALL SCALABILITY ASSESSMENT:
  UNDETERMINED. Gate E's question — can K Scan economically prepare real
  retail products for Live VTO at catalog scale? — is not answered by this
  lane and cannot be answered until two preconditions are resolved.
```

Gate E did not fail on economics. It never reached economics.

## Why there are no numbers

Two independent blockers. Either alone is disqualifying; both are live.

### Blocker 1 — Evaluation authority not established (binds first)

No retailer or commerce source could be established as CLEARED for automated
evaluation. A repository-wide sweep found no licence, terms review,
attribution policy, or recorded authority of any kind covering the fetching,
automated processing, or derivative use of third-party product imagery. The
provider-integration checklist that governs adding a commerce source contains
13 mandatory gates, none of which is legal or rights review.

Section 7 is explicit: UNKNOWN means do not assume permission, and with no
CLEARED source the lane holds. Detail: `docs/vto-phase4-gate-e-rights.md`.

### Blocker 2 — The corpus is undecodable by the frozen pipeline

Independently of rights, the imagery the authorized commerce path returns
cannot enter the pipeline at all.

```
Real products retrieved via authorized path:   99
Image format distribution:                     WEBP  99/99  (100%)
Decodable by frozen pipeline (PNG|JPEG):        0/99  (0.0%)
Short-side dimensions:  min 194px | p50 632px | p95 659px | max 659px
Pipeline MIN_DIMENSION: 40px
```

Three points make this a hard blocker rather than a tuning problem:

1. **It is format, not size.** Every image comfortably clears the 40px
   minimum. Resolution is adequate; the decoder simply does not exist. The
   pipeline declares `pngjs` and `jpeg-js` and nothing else.
2. **It is not negotiable.** `encrypted-tbn*.gstatic.com` returns
   `image/webp` regardless of the `Accept` header — tested with `image/jpeg`,
   `image/png`, an explicit q-weighted list, and `*/*`. There is no
   supported-format variant of these URLs.
3. **It is not path-specific.** The production commerce provider (Serper,
   `google.serper.dev/shopping`) sources the same Google Shopping thumbnail
   CDN and applies no host or format constraint. Switching providers does not
   change the outcome. No other commerce surface yields a corpus: Vinted
   returns zero items, the internal `product_catalog` table holds zero rows,
   footwear endpoints are outside the supported category, and commerce
   telemetry stores no image references by design.

## What this is *not*

Running the pipeline over this corpus would have produced 99 decode failures.
That number would be worthless and actively misleading:

- It is a `SYSTEM_ERROR`/source-invalid class outcome, **not** a catalog
  rejection. Section 23 requires the two to be reported separately, and
  section 49 forbids improving or explaining a rejection rate by relabelling
  crashes as unsupported products.
- It would measure the CDN's image format, not the pipeline's garment logic.
  Phase 4's classification, segmentation, anchoring, and fidelity stages would
  never execute even once.

So no baseline was run. `evidence/vto-phase4-gate-e/results.jsonl` carries
zero product records and a machine-readable statement of why.

## Sample distribution

None. No cohort was frozen (`cohort-manifest.json`, `cohortFrozen: false`).

For the record, the access probe *requested* stratification across section
16's visual characteristics — plain, logo/text, patterned, dark, light, soft
knit, structured — and received products for every stratum. The stratification
was viable; the imagery was not ingestible. That is a useful signal for
Phase 4.1: **corpus breadth is not the constraint.**

## Prior evidence is not promoted

The Phase 4 lane produced 27 records (20 SYNTHETIC, 7 AUTHORIZED_FIXTURE) with
a 33.3% automatic success rate. That evidence remains in
`evidence/vto-phase4-assets/` under its original labels and is **deliberately
not** reproduced, re-run, or reframed as a Gate E result. Synthetic fixtures
are not real products (section 49), and mixing evidence classes into one
distribution is forbidden.

That corpus was re-executed once, solely to prove the pre-freeze certification
repair changed no outcome. All 27 per-item results were identical and the
regenerated files were reverted.

## Machine-readable evidence

```
evidence/vto-phase4-gate-e/cohort-manifest.json                    (empty cohort + reason)
evidence/vto-phase4-gate-e/results.jsonl                           (RUN_NOT_EXECUTED)
evidence/vto-phase4-gate-e/summary.json                            (full Gate E state)
evidence/vto-phase4-gate-e/access-probe-image-format-census.json   (99-product format census)
```

The census contains derived metadata only — content hashes, formats,
dimensions, byte counts, host names. No source image bytes, and no product
titles or store names.

## Invariants

```
PIPELINE CHANGED AFTER FREEZE          NO
EXTERNAL PROVIDER CALLS                0
UNAUTHORIZED SOURCE IMAGES COMMITTED   0
PRODUCTION MUTATION                    NO
STAGING MUTATION                       NO
LIVE ENABLED                           NO
PHASE 5 STARTED                        NO

SOURCE IMAGES TEMPORARILY PROCESSED    99
SOURCE IMAGES RETAINED                 0
SOURCE IMAGES DELETED                  99
DERIVED METADATA RETAINED              YES
SOURCE VERSION DRIFT                   0  (no cohort; nothing to re-fetch)
```

## Carried forward, unchanged

```
P3-A HUMAN VISUAL VERDICT              PENDING
CASE 8 COLOR-FIDELITY DISPOSITION      PENDING
NATIVE LIVE RUNTIME                    NOT VALIDATED
PHYSICAL DEVICE                        NOT VALIDATED
REAL PERSON LIVE VTO                   NOT VALIDATED
```

Gate E resolves none of these. The Android emulator and physical device
remained unused: they belong to the native-runtime lane, and touching them
here would not have made Gate E's catalog-preparation evidence any stronger.
