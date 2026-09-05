# VTO Phase 4 — Gate E: Pipeline Freeze Record

Task section 11. Records the exact pipeline state Gate E would have measured.

## Status

```
PIPELINE FREEZE:  RECORDED
BASELINE RUN:     NOT STARTED
PIPELINE CHANGED AFTER FREEZE:  NO
```

The freeze is recorded for reproducibility even though no real-product
baseline ran (see `docs/vto-phase4-gate-e-rights.md` and
`docs/vto-phase4-gate-e-access-probe.md`). A future Phase 4.1 or a re-attempted
Gate E can use this record to tell **pipeline improvement** apart from
**cohort changed**.

## Source authority

```
CURRENT INTEGRATION SHA   265fe3624bb34fd951b4efe5979fa712a4fce2be
INTEGRATION BRANCH        integration/backend-kplus-complimentary-staging-v1
PHASE 4 MERGE SHA         265fe3624bb34fd951b4efe5979fa712a4fce2be   (merge of PR #301)
PHASE 4 HEAD SHA          a38e20cb0ea635ec536751b68e594df4458ae51a   (PR #301 head, as certified)
PR #301 STATE             MERGED 2026-09-05T14:20:43Z
```

PR #301 is merged and its merge commit **is** the current head of the
integration branch, so the section 4 precondition is satisfied: Phase 4 is on
current integration authority.

## Frozen component versions

```
PIPELINE TREE SHA               ab399fd7b06b5ff0c003cc74cec57bbbc3b34657
LAST COMMIT TOUCHING PIPELINE   144714f72124b30daa3b741377ab642c84658d91
PIPELINE VERSION                0.1.0        (src/manifestBuilder.ts PIPELINE_VERSION)
GARMENT CONTRACT VERSION        1.0          (src/garmentContract.ts KSGARMENT_SCHEMA_VERSION)
```

The pipeline carries one package version and one contract version rather than
per-stage version constants. Stage identity is therefore pinned by module
path plus the pipeline tree SHA above:

| Stage | Module |
|---|---|
| IMAGE SELECTION | `src/imageSelection.ts` |
| SHOT CLASSIFICATION | `src/shotClassifier.ts` |
| SEGMENTATION / EXTRACTION | `src/segmentation.ts` |
| CANONICALIZATION | `src/canonicalize.ts` |
| ANCHOR LOGIC | `src/anchors.ts` |
| CONFIDENCE LOGIC | `src/eligibility.ts` |
| FIDELITY LOGIC | `src/fidelity.ts` |
| REJECTION LOGIC | `src/types.ts` (reason set), enforced across stages |
| SOURCE ACQUISITION / DECODE | `src/sourceLoad.ts`, `src/codec.ts` |
| VARIANT RESOLUTION | `src/variantResolution.ts` |
| BATCH RUNNER | `src/batch.ts` |

Decode capability, which turned out to be the binding constraint:

```
SUPPORTED SOURCE FORMATS   PNG (pngjs 7.0.0), JPEG (jpeg-js 0.4.4)
UNSUPPORTED                WebP, AVIF, everything else
MIN_DIMENSION              40px  (src/sourceLoad.ts)
ELIGIBILITY_CONFIDENCE_THRESHOLD   0.5  (src/eligibility.ts)
```

## Pre-freeze certification repair

Section 10 requires a hostile integrity pass before freeze, and permits
repairing a P0–P3 correctness defect found there under a separate, explicitly
recorded certification-repair commit.

One defect was repaired: **GATE-E-INT-001**, the eligibility gate failing
open on malformed confidence components. See
`docs/vto-phase4-gate-e-findings.md` for the full finding.

The repair is **behaviour-preserving for all well-formed inputs**, proven two
ways:

1. The pre-existing suite passes unchanged (58/58 before, 59/59 after with the
   new regression test).
2. The full 27-record synthetic + authorized-fixture corpus was re-run and
   **every per-item outcome is identical** — same shot class, same
   eligibility, same rejection reason for all 27 records; headline rates
   unchanged at 33.3% automatic success / 66.7% rejection.

This is a correctness repair, not a tune. No threshold, classifier,
segmentation rule, rejection reason, image-selection rule, or category scope
was changed. The regenerated evidence files were reverted so the Phase 4
lane's own committed record is preserved.

A second defect (**GATE-E-INT-002**, batch error isolation) was found and
**deliberately not repaired** here — the fix requires adding a `SYSTEM_ERROR`
terminal state, which changes the result contract. Section 10 says not to
redesign the system; that work belongs to Phase 4.1.

## Freeze discipline

Because no real product ever entered a baseline, section 12's no-tuning rule
was never placed under pressure. Recorded for completeness:

```
CONFIDENCE THRESHOLDS CHANGED      NO
SHOT CLASSIFICATION CHANGED        NO
SEGMENTATION CHANGED               NO
CV MODEL ADDED                     NO
REJECTION REASONS ADJUSTED         NO
IMAGE SELECTION CHANGED            NO
GARMENT CATEGORIES BROADENED       NO
RETAILER EXCEPTIONS ADDED          NO
FIDELITY RULES WEAKENED            NO
IMAGE DECODER ADDED                NO
```

The last line is the consequential one. Adding a WebP decoder would have made
the real corpus ingestible, and this lane deliberately did **not** do it:
Phase 4's own recorded policy is to reject unsupported formats rather than add
a third decoder ad hoc, and adding decode capability mid-certification is new
engineering rather than a certification repair. It is the primary Phase 4.1
recommendation instead.
