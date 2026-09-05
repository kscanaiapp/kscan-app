# VTO Phase 4 — Gate E: Pipeline Freeze Record (Phase 4.1 re-freeze)

Task section 11 / addendum §23. Supersedes the prior freeze record (which
recorded a HOLD state with no real baseline). This is the freeze the real
cohort baseline actually runs against.

## Status

```
PIPELINE FREEZE:   RECORDED
BASELINE RUN:      REAL COHORT (see docs/vto-phase4-gate-e-results.md)
PIPELINE CHANGED AFTER FREEZE: NO
```

## Source authority

```
CURRENT INTEGRATION SHA      265fe3624bb34fd951b4efe5979fa712a4fce2be
INTEGRATION BRANCH           integration/backend-kplus-complimentary-staging-v1
PHASE 4 MERGE SHA            265fe3624bb34fd951b4efe5979fa712a4fce2be (PR #301)
PHASE 4.1 REPAIR COMMIT      f6a1bc0de1aaec2394141bf13d56faf89e4f4068
PR                           #302 (continued, not a new parallel PR)
```

Re-verified at the start of this lane: PR #302's base
(`265fe3624b...`) still equals the current integration head — no drift.

## Frozen component versions

```
PIPELINE TREE SHA (vto-phase4-pipeline/)   3a09006afbd56bbc3312ca67a2c79c943817180b
PIPELINE VERSION                            0.1.0   (unchanged — see below)
GARMENT CONTRACT VERSION                    1.0     (unchanged)
DECODER                                     @jsquash/webp 1.5.0 (new this lane)
```

### Why `PIPELINE_VERSION` was NOT bumped

`manifestBuilder.ts`'s own comment: "Bump deliberately when this pipeline's
algorithms change in a way that should invalidate prior assets." This
lane's changes are additive infrastructure, not algorithm changes:

- WebP decode adds a new INPUT format; the normalized `RgbaImage` pixel
  contract is unchanged, and every downstream stage (classification,
  segmentation, canonicalization, anchors, fidelity) is unmodified and
  format-agnostic exactly as before.
- Batch isolation (`runIsolated`, the `SystemError` terminal state) is
  orchestration-level — it changes what happens when an item CANNOT be
  evaluated, never how an evaluated item is scored.
- `sourceAdequacy` is a new diagnostic field, deliberately never
  consulted by eligibility/rejection logic.

No previously-generated `.ksgarment` asset is invalidated by any change in
this lane — the version-bump trigger does not apply.

## Frozen stage versions (module path @ pipeline tree SHA above, unchanged from the original freeze except where noted)

| Stage | Module | Changed this lane? |
|---|---|---|
| IMAGE SELECTION | `src/imageSelection.ts` | No — verified deterministic/variant-safe/idempotent/fail-closed (addendum §A14), not modified |
| SHOT CLASSIFICATION | `src/shotClassifier.ts` | No |
| SEGMENTATION / EXTRACTION | `src/segmentation.ts` | No |
| CANONICALIZATION | `src/canonicalize.ts` | No |
| ANCHOR LOGIC | `src/anchors.ts` | No |
| CONFIDENCE LOGIC | `src/eligibility.ts` | No (GATE-E-INT-001 repair predates this freeze, already verified behavior-preserving) |
| FIDELITY LOGIC | `src/fidelity.ts` | No |
| REJECTION LOGIC | `src/types.ts` (reason set) | `SOURCE_INVALID` removed from `RejectionCode` (its cases are now `SystemError`s, not rejections — see below); every other rejection code unchanged |
| SOURCE ACQUISITION / DECODE | `src/sourceLoad.ts`, `src/codec.ts` | **Yes** — WebP decode + resource-safety guard + `https-fetch` origin (this lane's Primary Repair A) |
| BATCH ORCHESTRATION | `src/batch.ts` | **Yes** — fail-soft per-item isolation (this lane's Primary Repair B) |
| SOURCE-ADEQUACY DIAGNOSTIC | `src/sourceAdequacy.ts` | **New** — diagnostic only, never gates eligibility |

```
SUPPORTED SOURCE FORMATS      PNG (pngjs 7.0.0), JPEG (jpeg-js 0.4.4), WebP (@jsquash/webp 1.5.0)
IDENTIFIED-BUT-UNSUPPORTED    AVIF -> SYSTEM_ERROR:UNSUPPORTED_IMAGE_FORMAT (addendum §A3)
MIN_DIMENSION                 40px  (unchanged)
MAX_DIMENSION_PX              8192px   (new — resource-safety guard, addendum §A5)
MAX_TOTAL_PIXELS              64,000,000px (new — resource-safety guard, addendum §A5)
ELIGIBILITY_CONFIDENCE_THRESHOLD  0.5  (unchanged)
```

## Pre-baseline test gate (addendum §21) — run immediately before the real cohort

```
Phase 4 pipeline tests        87/87 PASS
Phase 4 isolated typecheck    PASS
root typecheck                PASS
VTO regression (4 suites)     PASS
scope guard                   PASS (37 changed paths, 37 within boundary)
edge parity                   PASS
edge manifest check           PASS
security baseline             PASS
migration provenance          PASS
dependency reachability       PASS
staging v2 write guard        PASS
privacy                       PASS

UNEXPECTED FAILURES: 0
```

## Freeze discipline going forward

```
CONFIDENCE THRESHOLDS CHANGED      NO
SHOT CLASSIFICATION CHANGED        NO
SEGMENTATION CHANGED               NO
CV MODEL ADDED                     NO
REJECTION REASONS ADJUSTED         NO (one code, SOURCE_INVALID, was
                                    RETIRED — its cases became SystemErrors —
                                    but this was decided and committed
                                    BEFORE any real product entered the
                                    baseline, per the freeze-then-run
                                    sequencing this document itself records)
IMAGE SELECTION CHANGED            NO
GARMENT CATEGORIES BROADENED       NO
RETAILER EXCEPTIONS ADDED          NO
FIDELITY RULES WEAKENED            NO
IMAGE DECODER ADDED                YES — this IS the authorized Primary
                                    Repair A this lane exists to make,
                                    completed and tested BEFORE the real
                                    cohort was assembled or run
```

Once `gateECohortCli.ts` began fetching the real cohort, no further change
was made to `vto-phase4-pipeline/src/**`. The real-cohort results in
`docs/vto-phase4-gate-e-results.md` measure exactly the pipeline recorded
above — nothing tuned mid-run or after seeing outcomes.
