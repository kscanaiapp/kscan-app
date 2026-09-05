# VTO Phase 4 — Gate E: Results

**This document reflects the Phase 4.1 real-catalog baseline (2026-09-05,
second session). The original Gate E attempt's finding — PRECONDITION HOLD,
no real product evaluated — is preserved unmodified in "History" at the
bottom of this document, per task section 39: do not erase history, do not
falsely claim legal review occurred.**

## Executive summary

```
REAL PRODUCTS EVALUATED:      220

AUTOMATIC LIVE2D:             3 / 220   = 1.4%
REJECTED:                     217 / 220 = 98.6%
SYSTEM ERRORS:                0 / 220   = 0.0%

EASY+MEDIUM AUTO SUCCESS:     3 / 10 = 30.0%

TOP 5 REJECTION CAUSES:
  1. OCCLUSION_TOO_HIGH        182 (82.7% of rejections, 82.7% of cohort)
  2. EXTRACTION_UNRELIABLE      29 (13.2% of rejections, 13.2% of cohort)
  3. PRODUCT_FIDELITY_FAILED     3 (1.4%)
  4. ANCHORS_INCOMPLETE          2 (0.9%)
  5. GARMENT_NOT_PRIMARY         1 (0.5%)

HUMAN FIDELITY RESULT:        PENDING — no owner review session has occurred
CORRECTION ECONOMICS:         HUMAN CORRECTION MINUTES: NOT MEASURED
COMPUTE ECONOMICS:            NOT CALCULATED — no authoritative cloud pricing basis for this local dev environment

OVERALL SCALABILITY ASSESSMENT:
  PIPELINE ENGINEERING WORKS. The frozen pipeline processed 220 real
  products with ZERO system errors — WebP decode, batch isolation, and
  every downstream stage behaved exactly as designed across the entire
  cohort. The bottleneck is NOT an engineering defect. It is that 95% of
  the imagery this Commerce path actually returns is model-worn (HARD
  shot class), which is an INTENDED Phase 4 limitation (no HARD-capable
  extraction path exists — task section 25/§16), not a bug. Within the
  5% of the cohort clean enough to attempt (EASY+MEDIUM), auto-success was
  30% — a real, separate finding: see "Two-layer bottleneck" below.
```

## Authority

```
CURRENT INTEGRATION SHA      265fe3624bb34fd951b4efe5979fa712a4fce2be
PHASE 4 MERGE SHA            265fe3624bb34fd951b4efe5979fa712a4fce2be (PR #301)
PIPELINE SHA (frozen)        3a09006afbd56bbc3312ca67a2c79c943817180b
PIPELINE VERSION             0.1.0
```

## Access probe / rights / pipeline integrity / freeze

```
ACCESS PROBE:                PASS (mechanics) — see docs/vto-phase4-gate-e-access-probe.md
RIGHTS / LEGAL AUTHORITY:    OWNER DIRECTED TRANSIENT INTERNAL EVALUATION TO PROCEED, using
                              the existing Commerce path. FINAL LEGAL/TERMS/RIGHTS REVIEW
                              REMAINS DEFERRED TO LAUNCH READINESS — this is not a claim that
                              rights are affirmatively cleared. See
                              docs/vto-phase4-gate-e-rights.md (unmodified) for the full,
                              original record of what this lane's own review could and could
                              not establish, and the owner-direction note appended there.
PIPELINE INTEGRITY PRECHECK: PASS (GATE-E-INT-001 preserved + re-verified against the full
                              addendum §A4 matrix; GATE-E-INT-002 repaired this lane)
PIPELINE FREEZE:              PASS — docs/vto-phase4-gate-e-freeze.md
```

## Cohort

```
TOTAL:            220
UNSEEN:            220 (every product is a fresh real-commerce fetch — none were
                    used to build fixtures, tune the pipeline, or create corrections)
PREVIOUSLY SEEN:     0
EVIDENCE VOLUME:  BROAD CATALOG SAMPLE (N=220 clears the ≥100 "ELIGIBLE FOR GATE E
                    PASS/HOLD/FAIL CONSIDERATION" floor — addendum §A7; not a claim of
                    statistical sufficiency beyond that floor)
```

N was not pushed toward the 150-300 target's upper end because the
qualitative signal was already stable and consistent across two
independently-assembled 220-product samples before this final run (94% and
95% HARD shot-class share respectively — see Methodology). Section 15's own
guidance applies: once a cell's signal is clear, effort is better spent
elsewhere than inflating N further.

### Sample distribution

**By visual characteristic (query stratum):**

```
structured  40   (18.2%)
plain       44   (20.0%)
softknit    30   (13.6%)
logo        33   (15.0%)
patterned   33   (15.0%)
dark        20    (9.1%)
light       20    (9.1%)
```

All 7 stratification cells addendum §A8/task section 16 asks for are
represented — see Methodology for the round-robin sampling fix that made
this possible.

**By shot class (measured, not curated):**

```
HARD          209   (95.0%)
MEDIUM          6    (2.7%)
EASY            4    (1.8%)
UNSUPPORTED     1    (0.5%)
```

**By garment family:** 100% of records used `category: 'top'` — the only
category Live VTO's template-family map (`TEMPLATE_FAMILY_BY_CANONICAL`)
currently supports, matching `docs/vto-phase4-corpus-request.md`'s own
recommendation to concentrate real-corpus effort there.

**Multi-image / variant:** `product-search-deals` returned exactly one
photo per product for all 220 records (`multiPhotoProductsObserved: 0`).
The "multi-image product" and "variant product" stratification cells
section 16 asks for could not be populated from this Commerce path — a
corpus/access-path limitation, not a pipeline gap (the pipeline's
multi-image selection logic itself remains tested via synthetic fixtures;
see `imageSelection.ts` test coverage).

## Automatic results

```
LIVE2D ELIGIBLE:   3 / 220  =  1.4%
REJECTED:        217 / 220  = 98.6%
SYSTEM ERROR:       0 / 220  =  0.0%
```

### By shot class

```
HARD          209 total,   0 eligible,   0.0% success
MEDIUM          6 total,   3 eligible,  50.0% success
EASY            4 total,   0 eligible,   0.0% success
UNSUPPORTED     1 total,   0 eligible,   0.0% success
```

### EASY+MEDIUM (the economically addressable subset per task section 25)

```
Total:     10
Eligible:   3
Success:  30.0%
```

### HARD (separate, per task section 25 — not removed from the overall report)

```
Total:    209
Eligible:   0
Success:  0.0%  — expected: no HARD-capable extraction path exists in this pipeline
```

## Two-layer bottleneck (addendum §A19)

This baseline surfaces two genuinely separate findings, and conflating them
would misdiagnose the fix:

**Layer 1 — corpus mix (dominant, 95% of the cohort).** The Commerce path
this app already uses for shopping/deals results returns overwhelmingly
model-worn photography, not flat-lay/ghost-mannequin studio shots. Phase
4's HARD-rejection is a deliberate, documented design choice (task section
16: "HARD is rejected before any extraction attempt... no validated
model-worn extraction path"), not a defect this lane found. **This is a
corpus/source-mix finding, not a pipeline defect** — building HARD-capable
extraction is real, separate engineering work (Phase 4.2+), and is
correctly out of this lane's authorized repair scope (addendum §19 forbids
tuning Hard-image behavior mid-baseline).

**Layer 2 — extraction/QA strictness on the "clean" 5% (secondary,
worth investigating).** Even among the 10 EASY+MEDIUM items — the shots
Phase 4 is actually designed to handle — only 3 became eligible. Notably,
**0 of the 4 EASY-classified items passed**, despite all 4 measuring
`ADEQUATE` source-adequacy (occupancy ratios 53-89%, garment-region short
sides 288-522px) — resolution was not the limiter for any of them:

| productRef | rejection | shot confidence | source adequacy |
|---|---|---|---|
| real-0067 | EXTRACTION_UNRELIABLE | 0.90 | ADEQUATE, 89.2% occupancy |
| real-0120 | PRODUCT_FIDELITY_FAILED | 0.72 | ADEQUATE, 78.4% occupancy |
| real-0129 | EXTRACTION_UNRELIABLE | 0.92 | ADEQUATE, 71.6% occupancy |
| real-0171 | PRODUCT_FIDELITY_FAILED | 0.74 | ADEQUATE, 53.4% occupancy |

Two failed on the overall-confidence gate (`EXTRACTION_UNRELIABLE` — some
component other than shot-classification or source-quality dragged the
`Math.min` below threshold) and two on a genuine QA fidelity check. This
lane did not capture per-component confidence breakdowns in committed
evidence (only the aggregate rejection code), so the exact dragging
component is not diagnosed here — that is the natural first Phase 4.1/4.2
diagnostic step, not a conclusion this lane reaches. Flagged as a finding,
not tuned (addendum §19 forbids adjusting thresholds mid-baseline).

**Reading the two layers together:** even a hypothetical pipeline with a
perfect HARD-extraction path would still need to close Layer 2 before
economics look good, because Layer 2's 30% ceiling would apply to whatever
fraction of the broader (currently-rejected) corpus a future HARD-path
converts into "clean enough to attempt."

## Rejection distribution (ranked)

```
OCCLUSION_TOO_HIGH        182  82.7% of cohort, 83.9% of rejections — HARD-class skin-tone detection (task section 16's intended reject-early behavior)
EXTRACTION_UNRELIABLE      29  13.2% of cohort, 13.4% of rejections — confidence-gate miss (mix of HARD non-skin-detected sources and 2 of the 4 EASY items above)
PRODUCT_FIDELITY_FAILED     3   1.4% of cohort,  1.4% of rejections — genuine QA silhouette/color/logo/pattern check failure
ANCHORS_INCOMPLETE          2   0.9% of cohort,  0.9% of rejections
GARMENT_NOT_PRIMARY         1   0.5% of cohort,  0.5% of rejections
```

No `SYSTEM_ERROR` of any kind occurred (0/220) — see Decode Reliability
below.

## Product fidelity

```
REFERENCE_AVAILABLE metrics:    0   (no ground-truth reference exists for any real product —
                                      expected: this lane has no independent source of truth
                                      for a real retailer garment's true color/logo/pattern)
NO_REFERENCE metrics:          all color/logo/pattern checks on items that reached QA
```

Per task section 27, `NO_REFERENCE` is never treated as `PASS`. The
silhouette-shape check (fill ratio, compactness — the one fidelity
component that needs no external reference) is what actually gated the 3
`PRODUCT_FIDELITY_FAILED` rejections above.

## Human fidelity

```
HUMAN PRODUCT-FIDELITY REVIEW: PENDING
```

No human reviewer session occurred in this lane. Per task section 31/41,
Gate E may recommend a HOLD on this basis alone; see the final
recommendation below for how this combines with the corpus/extraction
findings.

## Correction candidates (classification only — addendum §A15)

```
POTENTIALLY_CORRECTABLE:        31  (14.1%)  — EXTRACTION_UNRELIABLE, ANCHORS_INCOMPLETE,
                                                  GARMENT_NOT_PRIMARY-adjacent codes
NOT_ECONOMICALLY_CORRECTABLE:  186  (84.5%)  — overwhelmingly OCCLUSION_TOO_HIGH (model-worn,
                                                  no correction mechanism exists for this)
UNKNOWN:                         3   (1.4%)  — the eligible items (triage is only computed
                                                  for rejections)
```

## Human correction economics

```
HUMAN CORRECTION MINUTES: NOT MEASURED
```

No timed human correction session occurred. Per addendum §A15/§32/§36, this
lane does not estimate minutes and does not use agent time as a proxy for
human labor.

## Final usable rate

Not computable — no human-correction pass was run, so there is no
"auto-eligible + successfully-corrected" figure to report. Automatic usable
rate: 1.4% (3/220). Terminal rejection rate (excluding system errors, of
which there were none): 98.6%.

## Performance

```
TOTAL DURATION (ms):    min 120 | median ~740 | p75 ~950 | p95 ~1,600 | max ~12,800
CLASSIFICATION (ms):    min 4   | median 35   | p75 ~40  | p95 ~65   | max ~125
```

Full per-stage distributions: `evidence/vto-phase4-gate-e/real-cohort-summary.json`.

### Source acquisition (fetch + decode combined) by format

```
WebP:  count 220 | min 124ms | median 860ms | p75 1,128ms | p95 1,792ms | max 12,847ms
```

This combines network fetch to the gstatic CDN and WASM WebP decode — they
cannot be separated from data already collected without re-instrumenting
and re-running the frozen pipeline mid-baseline (freeze discipline
forbids this — see `gateECohortCli.ts`'s own note on this derivation).
Given the median (860ms) vastly exceeds typical in-process WASM decode
times for images this size (tens of milliseconds, confirmed during decoder
evaluation on synthetic fixtures), network fetch — not WASM decode — is
almost certainly the dominant component. The max (12.8s) is a single
outlier likely reflecting a slow individual CDN response, not a systemic
decode-performance problem; no retries were triggered by it
(`retryCountTotal: 1` across the whole 220-item run).

## Compute economics

```
EXECUTION HOST:      local Windows 11 developer workstation
CPU/GPU:              not GPU-accelerated; WASM decode runs on CPU
WORKER CONCURRENCY:  6 (bounded async pool)
COMPUTE COST / SKU:  NOT CALCULATED — NO AUTHORITATIVE PRICING BASIS
```

## Decode reliability (addendum §A12)

```
PNG:    NOT OBSERVED this cohort (0 real products returned PNG)
JPEG:   NOT OBSERVED this cohort (0 real products returned JPEG)
WEBP:   attempted 220 | passed 220 | failed 0 | pass rate 100.0%
AVIF:   NOT APPLICABLE (0 observed)
```

100% WebP, 100% decode success, across 220 real fetches in this run — and
across a second, independently-assembled 220-product run performed earlier
the same session before the stratification-fairness fix (also 0 decode
failures; see Methodology). 440 total real-product WebP decodes attempted
across this lane, 0 failures. Primary Repair A is validated, not merely
unit-tested.

## Source resolution (addendum §A8 — diagnostic, not a gate)

```
Short-side px distribution (source file, N=220):
  min 181 | median 614 | p75 659 | p95 659 | max 659

Short-side buckets:
  <256:      10   (4.5%)
  256-383:   22  (10.0%)
  384-511:   27  (12.3%)
  512-767:  161  (73.2%)
  768+:       0   (0.0%)
```

The source files themselves are not small — 73% clear 512px on their short
side. This corroborates the two-layer finding above: raw source resolution
is not the bottleneck for this corpus; the shot-class mix is.

```
Source-adequacy classification (of the 10 items that reached a measurable
garment bounding box — i.e. every EASY+MEDIUM item; the other 210 were
rejected before segmentation, hence UNKNOWN by definition):
  ADEQUATE:      10  (100% of measurable items)
  QUESTIONABLE:   0
  INADEQUATE:     0
  UNKNOWN:      210  (rejected pre-segmentation — see docs/vto-phase4-gate-e-findings.md
                       for why UNKNOWN must never be read as "inadequate")
```

Every item that made it far enough to be measured had an adequate garment
texture resolution. This is further evidence that Layer 1 (shot-class mix)
dominates over any resolution concern.

## System errors

```
SYSTEM ERRORS: 0 / 220 (0.0%)
```

Exact causes: none occurred. `real-cohort-summary.json`'s `systemErrorByCode` is `{}`.

## P0-P3 found this lane

None found DURING the real baseline itself (the two P2s — GATE-E-INT-001,
GATE-E-INT-002 — were found by the section-10 pre-freeze hostile pass and
repaired before this baseline began; see `docs/vto-phase4-gate-e-freeze.md`
and the Phase 4.1 repair commit). No baseline-invalidating defect appeared
once the real cohort was running.

One evidence-TOOLING defect was found and fixed mid-lane, disclosed in full
under Methodology: the cohort-assembly query loop stopped querying further
strata once a numeric target was reached, silently starving
later-queried visual characteristics. This is a defect in the Gate E
evaluation harness, not the frozen pipeline, and both the buggy first pass
and the corrected final pass are disclosed rather than only reporting the
corrected number.

## P4-P10 (documented only)

See `docs/vto-phase4-gate-e-findings.md`.

## Pipeline changed after freeze

```
NO
```

`vto-phase4-pipeline/src/**` was not touched between the freeze commit and
either real-cohort run. The evaluation-harness fix (round-robin
stratification) touched only `gateECohortCli.ts`, which is Gate E
evaluation tooling, not the frozen pipeline (task section 20's authorized
scope lists these as separate categories).

## External provider calls

```
0
```

## Unauthorized source images committed

```
0
```

All 220 fetched images were held only in memory during decode/processing
and were never written to disk (`persist: false`) or committed anywhere.
Only hashes, dimensions, formats, classifications, and timings are in
`evidence/vto-phase4-gate-e/real-cohort-*`.

## Production / staging mutation

```
PRODUCTION MUTATION:  NO
STAGING MUTATION:     NO
LIVE ENABLED:          NO
```

`product-search-deals` was exercised read-only (verified zero database
access in the prior Gate E session's access probe); nothing was written to
any Supabase project.

## Carry-forward program ledger (addendum §A17)

```
GATE E ECONOMICS:                RECOMMENDED HOLD (see below)
P3-A HUMAN VISUAL VERDICT:       PENDING
CASE 8:                          PENDING
NATIVE RUNTIME:                  NOT VALIDATED
PHYSICAL DEVICE:                 NOT VALIDATED
REAL-PERSON LIVE:                NOT VALIDATED
GENERATIVE AI PHOTO PROVIDER E2E: NOT VERIFIED (out of this lane's scope — see docs/vto-provider-benchmark.md for its own status)
```

None of these were touched by this lane. The Android emulator and physical
device the owner made available remain unused here — see §A18/next steps.

## Phase 5 started

```
NO
```

## Gate E recommendation

```
GATE E RECOMMENDED HOLD — HUMAN FIDELITY REVIEW REQUIRED
```

subject to owner ratification, plus one additional, non-blocking
observation: even setting the human-fidelity gap aside, the current
Commerce image source's shot-class mix (95% HARD) means this pipeline as
built addresses only a small slice of what this particular feed returns.
That second point does not by itself justify a FAIL — task section 60 is
explicit that a FAIL means "current pipeline is not yet economically
scalable," not "the code is invalid," and this lane's own finding is that
the pipeline correctly and reliably does exactly what it was built to do
(0 system errors, 100% WebP decode reliability, clean and specific
rejections throughout). The economics question — is a corpus-strategy
change (a different image source with more flat-lay photography) or a
Phase 4.2 HARD-extraction investment the better next move — is a business
decision the evidence here informs but does not resolve, per task section
43/addendum §16.

## Top 3 bottlenecks (task section 66)

1. **Shot-class mix of this Commerce source (95% HARD/model-worn)** —
   observed evidence: `shotClassDistribution` above. Affected: 209/220
   (95.0%). Expected economic impact: this is the largest single lever —
   even a modest reduction in HARD-share (e.g. sourcing from a
   flat-lay-heavy retailer feed) would directly grow the addressable pool
   Phase 4 can even attempt. Recommended next lane: **CORPUS EXPANSION**
   (a different/additional Commerce source with more studio/flat-lay
   photography) — not a pipeline repair.
2. **EASY-classified sources still failing downstream (0/4 this baseline)**
   — observed evidence: the four-item table above. Affected: a small
   absolute N this run, but structurally important since EASY is Phase 4's
   best-case input. Expected economic impact: unknown until root-caused;
   could be a real fidelity/confidence-tuning opportunity or could reflect
   genuinely difficult real-world product photography (asymmetric prints,
   subtle color variation) the synthetic fixture suite doesn't cover.
   Recommended next lane: **PHASE 4.1 PIPELINE REPAIR** (diagnose via
   per-component confidence logging first — not yet available in committed
   evidence).
3. **Human fidelity review has never occurred** — observed evidence: `PENDING`
   throughout every Gate E document to date. Affected: 100% of accepted
   assets (3 this run) have zero independent quality verification.
   Expected economic impact: unknown — could reveal the 3 "eligible" assets
   are visually excellent, mediocre, or wrong. Recommended next lane:
   **HUMAN QA**.

---

## History (original Gate E attempt, 2026-09-05, first session — preserved unmodified)

The original Gate E lane found:

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

Two blockers were found: (1) no retailer/commerce source could be
established as CLEARED for automated evaluation from this lane's own
review of repository records, and (2) 100% of the imagery the authorized
commerce path returned was WebP, which the then-frozen pipeline could not
decode.

**What changed:** blocker (2) was repaired this lane (Primary Repair A).
Blocker (1) was not resolved by new legal authority being established —
the project owner instead explicitly directed that legal/terms
documentation is deferred until build completion and is NOT an engineering
Gate E blocker for this transient internal-evaluation lane, while
reaffirming the lane must remain transient (fetch → process → metrics →
delete). See `docs/vto-phase4-gate-e-rights.md` for the unmodified original
finding and the owner-direction note appended to it, and §A1 of the Phase
4.1 addendum for the exact wording of that direction. This document does
not claim rights were affirmatively cleared — it records that the owner
authorized this lane to proceed regardless.
