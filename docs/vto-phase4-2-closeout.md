# VTO Phase 4.2 — Final Measurement & Closeout

Closeout lane on PR #303. No architecture work, no new model, no HARD
extraction, no hostile audit.

---

## VERDICT

```
CONTINUE PHASE 4.2 — CLOSEOUT EVIDENCE INCOMPLETE
```

Per §F: a required measurement is blocked by corpus/cache/quota. Specifically
**CLOSEOUT BLOCKED — CACHE ABSENT + QUOTA EXHAUSTED** (§D).

This is not a quality failure and not a HOLD. The closeout run itself
produced no evidence of fidelity, variant, or HARD-false-acceptance
regression, and no new P0–P3 defect reached the shipped pipeline.

**Owner action to unblock:** wait out the provider quota window, then

```bash
cd vto-phase4-pipeline
CATALOG_CORPUS_CACHE="$PWD/.corpus-cache/corpus.json" npm run catalog:characterize
CATALOG_CORPUS_CACHE="$PWD/.corpus-cache/corpus.json" npm run slice:run
```

The cache is now page-granular, so a partial window still banks progress and
a second window resumes without re-fetching. No other input is required.

---

## AUTHORITY

```
START SHA (this lane)        44242b95bf17cfeeb07c1fa1cebd8776d3a55c50
CURRENT INTEGRATION SHA      4365cebfccfd59843dd3f0a7418c07cb8e9ff843
PR #303 FINAL SHA            see FREEZE
```

## PROVIDER / CACHE

```
CACHE PRESENT AT START       NO
  PRODUCTS                   0
  IMAGE REFERENCES           0
  reason                     The 490-product characterization ran BEFORE cache
                             support existed, so it never wrote one. URLs are
                             deliberately never committed (§57), so that
                             corpus is unrecoverable.

NEW PROVIDER REQUESTS        3   (1 initial + 2 bounded backoff retries)
RATE LIMIT EVENTS            3   (HTTP 429 on all three)
PAGES OBTAINED               0
CACHE AFTER RUN              present, 0 pages — resumable, nothing to resume yet
```

The runner honoured the limit exactly as designed: 45 s then 90 s backoff,
then it stopped issuing requests, persisted what it had (nothing), and exited
non-zero with an explicit message. No key rotation, no host rotation, no
parallel account, no alternate API, no scraping.

**§C is correct and was applied:** gstatic image fetches are not provider
quota. Had a cache existed, the slice run, the four EASY dispositions, the
P42-001 effect measurement and the previously-eligible check would all have
executed with **0 provider calls** — this is now pinned by test
(`corpusCacheContract.test.ts` runs the slice runner end-to-end off a cache
with no provider credential in the environment at all). The blocker is
narrowly that no cache exists to run against.

---

## MEASUREMENTS COMPLETED THIS CLOSEOUT

Everything below is derived from **committed evidence** and pipeline source
semantics — no new provider calls, no fabrication.

### §9 ORIGINAL FOUR EASY CASES — ALL FOUR ATTRIBUTED

`requiredAnchorsPresent(candidates, minConfidence = 0.5)` and the per-stage
`result` field recorded in `real-cohort-results.jsonl` together make these
attributions **deductive**, not inferred.

#### CASE 1 — `real-0067` (sha256 `6f1fa536…`), EASY, 316×435

```
ORIGINAL REJECTION   REJECTED:EXTRACTION_UNRELIABLE
STAGE RESULTS        classification ok · extraction ok · canonicalization ok
                     anchor_generation ok · geometry_generation ok · qa ok
                     bundle_writing ok      -> NO stage gate rejected
ROOT CAUSE           Confidence gate, limiting component = segmentation.
                     Proven by elimination:
                       sourceQuality       = 1.000  (316*435 = 137,460 > 90,000)
                       shotClassification  = 0.8995
                       productFidelity     = 1.0    (qa result=ok => qa.passed)
                       geometryValidity    = 1.0    (EASY => rotation 0; ksgarment built)
                       anchorCompleteness  >= 0.5   (anchor_generation ok means all four
                                                     required anchors scored >= 0.5, so their
                                                     average cannot be < 0.5)
                     Only `segmentation` can hold overall confidence below 0.5.
REPAIR APPLIED       P42-001 — segmentation confidence now penalizes SIGNIFICANT
                     components (>= 1% of image area) instead of raw connected
                     components, which previously saturated to exactly 0 at >= 21
                     components.
FINAL RESULT         NOT MEASURED — requires re-running the pipeline on the source
                     pixels (blocked: cache absent + quota exhausted).
LIMITING COMPONENT   segmentation (proven).
```

#### CASE 2 — `real-0129` (sha256 `f06b1d05…`), EASY, 320×400

```
ORIGINAL REJECTION   REJECTED:EXTRACTION_UNRELIABLE
STAGE RESULTS        all seven stages result=ok -> NO stage gate rejected
ROOT CAUSE           Identical elimination:
                       sourceQuality = 1.000 (320*400 = 128,000 > 90,000)
                       shotClassification = 0.9232
                       productFidelity = 1.0 · geometryValidity = 1.0
                       anchorCompleteness >= 0.5
                     Limiting component = segmentation.
REPAIR APPLIED       P42-001.
FINAL RESULT         NOT MEASURED (same block).
LIMITING COMPONENT   segmentation (proven).
```

**Honest bound on Cases 1 and 2.** That `segmentation < 0.5` is *proven*.
That it saturated to *exactly 0* is **consistent but not proven** for these two
specific images: the recorded evidence predates `segmentationEvidence`, so
their component counts were never captured. The corpus-wide measurement (21 of
49 addressable images at >= 21 raw components, median 114, max 4487) makes
saturation the overwhelmingly likely mechanism, and both images have high
garment occupancy (0.892 and 0.716) so a low `fillRatio` is an unlikely
alternative explanation. Stated as likelihood, not as fact.

#### CASE 3 — `real-0120` (sha256 `2ef39092…`), EASY, 659×659

```
ORIGINAL REJECTION   REJECTED:PRODUCT_FIDELITY_FAILED
STAGE RESULTS        qa result=REJECTED -> a genuine stage-gate rejection,
                     NOT a confidence-gate miss
ROOT CAUSE           Product fidelity QA rejected the extracted asset.
                     Classified SOURCE_DRIVEN, criterion SD-6, per the pinned
                     registry rule: PRODUCT_FIDELITY maps to SOURCE_DRIVEN
                     unless a distinct PD-5 criterion is registered. None is.
REPAIR APPLIED       NONE. P42-001 cannot affect it — a stage rejection is
                     independent of the confidence term. Fidelity gates were
                     deliberately not weakened (§15, §69.15).
FINAL RESULT         NOT MEASURED (same block). Expected unchanged, since
                     nothing in Phase 4.2 touched fidelity.
LIMITING COMPONENT   n/a — stage gate, not confidence gate.
```

#### CASE 4 — `real-0171` (sha256 `0039e4c8…`), EASY, 659×659

```
ORIGINAL REJECTION   REJECTED:PRODUCT_FIDELITY_FAILED
STAGE RESULTS        qa result=REJECTED
ROOT CAUSE           Identical to Case 3. SOURCE_DRIVEN, criterion SD-6.
REPAIR APPLIED       NONE, for the same reason.
FINAL RESULT         NOT MEASURED (same block).
LIMITING COMPONENT   n/a — stage gate.
```

```
UNATTRIBUTED CASES REMAINING:  0     <- §9 requirement MET
FINAL RESULTS MEASURED:        0 / 4 <- blocked, reported as blocked (§10)
```

The §9 split matters: **root cause and repair disposition are established for
all four**; only the post-repair *outcome* is blocked. Phase 4.1 could not
attribute two of these at all.

### §14 EXTRACTION_UNRELIABLE — BREAKDOWN COMPLETE

Measured over the committed Phase 4.1 cohort (N=220), where per-product
outcomes exist.

```
TOTAL                        29 / 220

BY SHOT CLASS
  HARD                       27   (93.1%)
  EASY                        2   ( 6.9%)
  MEDIUM                      0

BY SOURCE ADEQUACY
  UNKNOWN                    27   segmentation never ran
  ADEQUATE                    2   segmentation ran

BY CAUSE
  STAGE_HARD_NON_UNIFORM_
  BACKGROUND (SD-1)          27   extraction-stage refusal: HARD source with a
                                  non-uniform background and no model-worn path
  CONFIDENCE_SEGMENTATION
  (PD-1/PD-2)                 2   real-0067, real-0129

BY ATTRIBUTION
  SOURCE_DRIVEN              27
  PIPELINE_DRIVEN             2
```

**The bucket was never predominantly a pipeline problem.** 27 of 29 were HARD
sources refused *before* segmentation ran — which is exactly why their source
adequacy is `UNKNOWN`. Only 2 were confidence misses on addressable sources.
`EXTRACTION_UNRELIABLE` is no longer an unanalyzed headline category.

### §12 P42-001 EFFECT

Sourced from committed preflight evidence (§G), not from any narrative.

```
addressable EASY/MEDIUM images                       49
previously penalized by RAW component count (>= 21)  21   (42.9%)
  pre-repair segmentation confidence                 exactly 0.0 for all 21
  of which SIGNIFICANT component count == 1          17
  of which SIGNIFICANT component count <= 3          20
  penalized raw count      min 27 · median 114 · max 4487
  penalized significant    min  1 · median   1 · max    4

repaired segmentation confidence                     21   (all 21 leave the
                                                          saturated-to-zero state;
                                                          for the 17 with significant
                                                          count 1 the penalty term
                                                          becomes exactly 1.0, so the
                                                          score is fillRatio unmodified)

converted to LIVE2D_ELIGIBLE                         NOT MEASURED
still rejected downstream                            NOT MEASURED
```

The last two require anchors, geometry and QA to run against the pixels. §12
asks precisely for this separation, and it is respected: the confidence repair
is measured; final asset success is not claimed.

### §7/§A REPAIR RATE — DENOMINATOR PINNED, NUMERATOR BLOCKED

Denominator artifact (pinned before any run, per §A):
`evidence/vto-phase4-2/repair-denominator-registry.json`

```
CORPUS                       Phase 4.1 Gate E cohort, N=220 (the only corpus
                             with committed per-product outcomes)
ADDRESSABLE PRODUCTS         10
ADDRESSABLE ELIGIBLE          3
ADDRESSABLE FAILURES          7

PIPELINE_DRIVEN               4    real-0067 (PD-2) · real-0129 (PD-2)
                                   real-0050 (PD-4) · real-0148 (PD-4)
SOURCE_DRIVEN                 3    real-0120 · real-0171 · real-0161  (all SD-6)
CONTRACT_DRIVEN               0

REPAIRED TO ELIGIBLE          NOT MEASURED
REPAIR RATE                   NOT MEASURED
70% TARGET                    NOT MEASURED
```

**§B minimum-N: the denominator is 4, far below the floor of 20.** Even once
measured, a rate over 4 cases cannot alone support ENGINEERING PASS; the
verdict would rest on the qualitative items. This is stated now, before the
numerator is known, so it cannot become a convenient argument later.

**§7 >= 1,000 corpus requirement: NOT MET (490 characterized), quota-blocked.**
Recorded, not waived.

Anti-gaming controls now in force: 14 pre-registered criteria; every
classification cites one by id (`attributionCriterionId`, test-pinned);
ambiguous defaults to PIPELINE_DRIVEN (the harder direction); PRODUCT_FIDELITY
maps to SOURCE_DRIVEN because no PD-5 criterion is registered; 0/0 is reported
as "NO PIPELINE-DRIVEN FAILURES REMAIN", never as 100%.

### §11 PREVIOUSLY ELIGIBLE

```
PREVIOUSLY ELIGIBLE          3   real-0079 · real-0186 · real-0210
                                 (sha256-identified, committed Phase 4.1 evidence)
STILL ELIGIBLE               NOT MEASURED
REGRESSED                    NOT MEASURED (0 observed — nothing was run)
```

The comparison set **is** recoverable (§G): it is the committed Phase 4.1
eligible set, matched by sha256. Only the re-run is blocked. No ad-hoc
substitute set was constructed.

### §13 CONFIDENCE EXPLAINABILITY — PASS

Structural and test-pinned rather than sampled: `confidenceExplain.ts` is the
single coercion point, `overallConfidence` delegates to it, every manifest
carries `confidenceExplanation`, and the confidence-gate rejection message
names the limiting component(s) with measured values. A sweep test asserts no
confidence-gate rejection can emit a bare aggregate. Malformed components are
attributed by cause across nine cases.

The four EASY dispositions above are themselves the practical demonstration:
two cases Phase 4.1 could not attribute at all are now resolved to a single
named component.

---

## RETAINED STRATEGIC FINDINGS (§18)

Unchanged — no contradictory evidence appeared this closeout.

```
PRODUCT-LEVEL IMAGE ADDRESSABILITY    ~10.0%  (49 / 490)
IMAGES PER PRODUCT                    1       (490 / 490)
MULTI-IMAGE RESCUE                    0       under the current Commerce contract
HARD-ONLY PRODUCTS                    88.8%
HARD_TRACTABLE                        1.8% of HARD
SYSTEM ERRORS                         0 / 490
DECODE                                490 / 490 WebP
PRIMARY LIMIT                         source photography / Commerce image contract
```

This finding is retained regardless of Easy/Medium pipeline quality: a
flawless addressable pipeline still cannot exceed ~10% of this catalog.

## §19 SOURCE DIVERSIFICATION vs HARD R&D — RECOMMENDATION ONLY

```
PATH A — SOURCE DIVERSIFICATION      RECOMMENDED
PATH B — HARD EXTRACTION R&D         NOT RECOMMENDED on current evidence
```

`HARD_TRACTABLE = 1.8%` of HARD imagery (8 of 435 images; ~1.6% of products)
does not indicate meaningful upside for broad model-worn extraction — the
hardest open problem in the space — against a source whose photography is
addressable ~10% of the time to begin with.

Within Path A, ranked by expected gain per unit of effort:

1. **Stop discarding photo arrays that already arrive.**
   `search-vinted-secondhand`'s `imageFrom()` iterates upstream
   `images`/`photos` arrays and returns the first, discarding the rest. For
   that already-integrated source the one-image ceiling is imposed by K Scan's
   own contract, not the provider. A contract change, not research.
2. **Change the image source.** The present feed is Google's thumbnail cache
   (`encrypted-tbn*.gstatic.com`) — one image, 659px cap, predominantly
   model-worn. A source with flat-lay or ghost-mannequin photography moves the
   ceiling; nothing inside the pipeline can.
3. **Owner-authored corpus (§41).** Supported as a separate evidence class,
   and the slice runner now accepts local refs, so such a corpus is directly
   runnable. Not supplied; not fabricated.

Neither path is implemented here.

---

## P0–P3 THIS CLOSEOUT

Two defects were found by the new tests — both in **closeout tooling**, both
fixed before any evidence was produced from it. Neither reached the shipped
pipeline.

| ID | Sev | Defect | Fix |
|---|---|---|---|
| P42-007 | P3 | The slice runner accepted an empty or wrong-schema cache and emitted a zero-filled summary indistinguishable from a real measurement of a catalog with no addressable products. | Fails closed with a distinct exit code and an explicit message. |
| P42-008 | P3 | The cache contract test wrote SYNTHETIC results into the committed evidence directory, where they could be mistaken for a genuine closeout measurement. | Evidence root is overridable; the test is isolated to a temp directory. Verified: no synthetic evidence in the tree. |

```
P0–P3 FOUND THIS CLOSEOUT     2  (P42-007, P42-008)  — both FIXED
P0–P3 REMAINING               0
```

Per §15, no quality or threshold change was made to hit a target. The frozen
build's segmentation, fidelity, confidence and classification thresholds are
untouched by this lane.

---

## FULL REGRESSION AND CI

```
FULL REPO SUITE        exit 0 — observed failures 13, known baseline 13,
                       UNEXPECTED 0
PHASE 4.2 + PHASE 4    161/161 pass
PIPELINE TYPECHECK     exit 0
ROOT TYPECHECK         exit 0
SCOPE GUARD            pass (evidence path already declared)
EDGE PARITY            exit 0
EDGE MANIFEST          pass
VTO REGRESSION         pass (within full suite)
SECURITY BASELINE      pass
PRIVACY                pass
MIGRATION PROVENANCE   exit 0
DEPENDENCY REACHABILITY  NOT RUN — ENVIRONMENT.
                       scripts/check-dependency-reachability.js calls
                       spawnSync('npm') without a shell, which cannot resolve
                       npm.cmd on Windows, so it fails closed with
                       AUDIT_UNAVAILABLE locally. It runs normally in CI, where
                       it passes on this branch. Reported, never silently
                       skipped.

CI ON FINAL HEAD       SUCCESS 31 · SKIPPED 13 · FAILED 0 · PENDING 0
```

The P42-006 Windows contamination trap recurred during this closeout's
full-suite run (10 stray harness temp files appeared in the repo root) and was
**correctly ignored** by the .gitignore fix — `git status --porcelain -uall`
showed only the intended new document. The fix is now validated in practice,
not just by construction.

## FREEZE

```
CODE FREEZE SHA              69237a26 (last commit touching code, tests or
                             evidence; later commits are documentation-only)
PHASE 4.2 FINAL HEAD         PR #303 head
PIPELINE VERSION             0.1.0                (manifestBuilder.PIPELINE_VERSION)
DECODER VERSION              @jsquash/webp 1.5.0 · pngjs 7.0.0 · jpeg-js 0.4.4
ASSET CONTRACT VERSION       KSGARMENT_SCHEMA_VERSION (garmentContract.ts)
SEGMENTATION VERSION         deterministic-background-subtraction
                             phase4-segmentation@0.1.0 (no local model installed)
CONFIDENCE VERSION           confidenceExplain.ts + eligibility.ts
                             ELIGIBILITY_CONFIDENCE_THRESHOLD = 0.5
                             segmentation term: significant-component based (P42-001)
VARIANT SAFETY               VARIANT_COLOR_CONSISTENCY_MAX_DISTANCE = 40
DENOMINATOR REGISTRY         evidence/vto-phase4-2/repair-denominator-registry.json
```

The closeout changed **tooling and evidence only**. No threshold, no gate, and
no classification rule in the shipped pipeline moved, so the frozen candidate's
behaviour on real imagery is byte-identical to the pre-closeout freeze.

```
PRODUCTION MUTATION   NO
STAGING MUTATION      NO
LIVE ENABLED          NO
GATE E                PENDING
HUMAN QA              PENDING (not a build blocker, §39)
```
