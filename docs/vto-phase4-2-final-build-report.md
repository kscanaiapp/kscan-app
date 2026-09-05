# VTO Phase 4.2 — Final Build Report

Phase 4.2 §71/§72/§73. Catalog Addressability & Asset Factory Expansion.

---

## EXECUTIVE SUMMARY (§71)

```
TOTAL PRODUCTS CHARACTERIZED:            490
TOTAL AUTHORITATIVE IMAGES:              490

NATURAL HERO-IMAGE ADDRESSABLE:          49 / 490 = 10.0%

PRODUCT-LEVEL ADDRESSABLE
AFTER ALL AUTHORITATIVE IMAGES:          49 / 490 = 10.0%

ADDRESSABILITY GAIN FROM
MULTI-IMAGE RESCUE:                      +0.0 points
                                         (zero material: 490/490 products
                                          carry exactly ONE image)

HARD-ONLY PRODUCTS:                      435 / 490 = 88.8%
  HARD_TRACTABLE:                          8 / 435 =  1.8%
  HARD_INTRACTABLE:                      423 / 435 = 97.2%
  HARD_UNKNOWN:                            4 / 435 =  0.9%

EASY+MEDIUM ASSET SUCCESS
  BEFORE (Phase 4.1, 220-product draw):  30%  (3/10)
  AFTER:                                 NOT MEASURED — provider quota
                                         exhausted before the pipeline run
                                         (see BLOCKED MEASUREMENTS)

PIPELINE-DRIVEN FAILURES REPAIRED:       NOT MEASURED (same cause)

SYSTEM ERRORS:                           0 / 490 = 0.0%
DECODE:                                  490 / 490 = 100.0% (all WebP)
```

**The headline finding is not a gain — it is a definite answer.** §1 framed
Phase 4.2 around shot class being an image property while addressability is a
product property. That reframe was correct, and Phase 4.1's hero-only
measurement was a real defect. But the measurement it enables returns zero:
**every product in the authorized Commerce feed carries exactly one
authoritative image**, verified at the provider, the edge function, and K
Scan's own app contract. Product-level addressability therefore *equals*
hero addressability, exactly.

**The second finding matters more.** A flawless Easy/Medium pipeline cannot
exceed **10.0%** of this catalog, because 88.8% of products offer only HARD
imagery and Phase 4 has no HARD path by design. The binding constraint on
Live2D coverage is **source photography, not segmentation quality**.

---

## RECOMMENDATION (§73)

```
CONTINUE PHASE 4.2 — ADDRESSABILITY IMPROVEMENT BELOW TARGET
```

Chosen as the closest fit among §73's options, with the precise reason
stated rather than implied: the §43 repair target is **not measured**, not
missed. The engineering work it depends on is complete, committed, and
regression-tested; the measurement that would confirm it requires a real
pipeline run over the addressable slice, and the provider rate limit
(HTTP 429, unrecovered across the session) blocks that run.

This is **not** an ENGINEERING PASS, because §69 items 6, 10 and 11 are
unmet, and §69 is explicit that diagnostics alone are not sufficient. It is
also not a HOLD: no contract regression, variant-integrity failure, fidelity
failure, HARD false-acceptance, or cross-boundary P0-P3 defect was found.

### What remains, precisely

One provider quota window and two commands:

```bash
CATALOG_CORPUS_CACHE=<path> npm run catalog:characterize   # refills the corpus + caches URLs
CATALOG_CORPUS_CACHE=<path> npm run slice:run              # runs the pipeline, emits all blocked numbers
```

`slice:run` needs no further provider calls once the cache exists, and emits
the repair rate, the before/after, the four EASY forensic dispositions, the
`EXTRACTION_UNRELIABLE` cause breakdown, and the previously-eligible
regression check in one pass.

---

## BLOCKED MEASUREMENTS, AND WHY

| §69 item | Status | Cause |
|---|---|---|
| 6 — four original EASY failures fully attributed | **BLOCKED** | Cases are re-identified by source sha256 (URLs were deliberately never committed). Re-identification requires a fresh provider draw. |
| 10 — pipeline-driven failures materially improve | **BLOCKED** | Requires a full pipeline run over the real addressable slice. |
| 11 — ≥70% of pipeline-driven failures repaired | **BLOCKED** | Same. |
| 12 — previously passing do not regress | **PARTIAL** | Pinned by regression tests; the real-corpus check on the 3 previously-eligible assets needs the same run. |

The cause is a single external constraint: the shared RapidAPI key
rate-limits after ~28 requests and returned HTTP 429 to every subsequent
request for the remainder of the session. §7 forbids evading provider limits,
so the runner honours it — bounded exponential backoff, then abandon. No key
rotation, no host rotation, no ignoring 429s.

**This is disclosed as a shortfall, not presented as a result.** The
tooling that consumes the quota is built, typechecked, and ready.

---

## AUTHORITY (§72)

```
START INTEGRATION SHA:  4365cebfccfd59843dd3f0a7418c07cb8e9ff843
#302 MERGE SHA:         4365cebfccfd59843dd3f0a7418c07cb8e9ff843
BRANCH:                 feature/vto-phase4-2-catalog-addressability
PR:                     #303 (draft)
CODE FREEZE SHA:        6b63790bd63e6c697ba26ad9d2c785188bbb3b5e
FINAL HEAD:             PR #303 head (documentation-only commits after)
```

Precondition history, including the initial `PHASE 4.2 PRECONDITION HOLD` and
the owner direction that cleared it, is in
`docs/vto-phase4-2-source-authority.md`.

---

## LARGE-CORPUS CHARACTERIZATION (§72)

```
products                490  (target 1500; §7 asked >= 1000)
images                  490
provider requests        47   (200: 28, 429: 19)
rate-limit behaviour    honoured — bounded backoff, then abandon stratum
runtime                 45.7 s assemble + 40.3 s characterize (concurrency 8)
```

**IMAGES PER PRODUCT:** `{ "1": 490 }` — mean 1.0, median 1, p95 1, max 1.

**HERO SHOT DISTRIBUTION:** EASY 31 (6.3%) · MEDIUM 18 (3.7%) · HARD 435
(88.8%) · UNSUPPORTED 6 (1.2%).

**PRODUCT-LEVEL ADDRESSABILITY:** ≥1 EASY image 31 · ≥1 MEDIUM image 18 ·
≥1 addressable image **49 (10.0%)** · only-HARD 435 (88.8%).

**MULTI-IMAGE RESCUE:** products with >1 image **0**; hero-HARD +
addressable-alternate **0**; rescued **0**. Coverage before 10.0%, after
10.0%. Zero is a property of the source; the rescue path is implemented,
wired, and proven end-to-end on synthetic two-image products.

**NATURAL CATALOG CEILING:** 10.0%. A perfect Easy/Medium pipeline cannot
exceed it under this source.

**HARD SUBDIVISION:** TRACTABLE 8 (1.8%) · INTRACTABLE 423 (97.2%) ·
UNKNOWN 4 (0.9%). Planning diagnostic only; no HARD image is eligible, and
`hardTractability.ts` is structurally incapable of making one so.

**EXTRACTION_UNRELIABLE BREAKDOWN:** the attribution module
(`rejectionAttribution.ts`) splits the code by gate (confidence vs stage) and
by limiting component, and classifies each failure PIPELINE_DRIVEN vs
SOURCE_DRIVEN. Unit-tested; the real-corpus counts are part of the blocked
`slice:run` output.

**ORIGINAL FOUR EASY FAILURES:** identified and frozen by source sha256 in
`phase41Baseline.ts` —

| baseline ref | sha256 (prefix) | dims | Phase 4.1 outcome | Phase 4.2 disposition |
|---|---|---|---|---|
| real-0067 | `6f1fa5364480` | 316×435 | EXTRACTION_UNRELIABLE | **root cause identified** (P42-001 class: confidence-gate miss, previously unattributable); re-run BLOCKED |
| real-0129 | `f06b1d050c2b` | 320×400 | EXTRACTION_UNRELIABLE | same |
| real-0120 | `2ef39092eb96` | 659×659 | PRODUCT_FIDELITY_FAILED | stage-gate fidelity failure, not a confidence miss; re-run BLOCKED |
| real-0171 | `0039e4c83022` | 659×659 | PRODUCT_FIDELITY_FAILED | same |

All four are now *identifiable and traceable* — Phase 4.1 could not attribute
two of them at all. Individual dispositions require the blocked run; §44's
"all four fully attributed" is **not yet met** and is not claimed.

**CONFIDENCE EXPLAINABILITY: PASS.** Every manifest carries
`confidenceExplanation`; no confidence rejection can emit a bare aggregate
message; malformed components are attributed by cause.

**SEGMENTATION BENCHMARK:** PATH A (deterministic) vs PATH B (one local
model). **Winner: PATH A**, on the grounds that there is no headroom — median
IoU **1.000**, zero failures, 8/9 at ≥0.99 on the population that actually
reaches segmentation. Full method, the bimodality correction, and the honest
limits are in `docs/vto-phase4-2-segmentation-benchmark.md`.

**LOCAL MODEL:** `NOT USED — evidence did not justify integration.` No model
was downloaded, evaluated, or verified, and **no license or provenance claim
is made about any candidate family** — asserting one unverified is exactly
what §29 prohibits. A governed loader exists that refuses any model with an
incomplete §29 provenance block or a weights checksum mismatch, and contains
no network or download code.

**SOURCE PREFLIGHT:** 13 metrics over all 490 images; distributions in
`docs/vto-phase4-2-catalog-characterization.md`. Actions taken: exactly one —
the significant-vs-raw component distinction that fixed P42-001. No new
rejection or normalization threshold was introduced, because §26 requires
observed evidence and the evidence did not support one.

**MASK QUALITY:** no destructive repair added. Padding is excluded (not
absorbed) by bbox cropping, pinned by adversarial test. Straps, logos, hems,
sleeves and necklines are untouched (§35).

**ANCHORS:** anchor confidences were already per-anchor; they now surface
through `confidenceExplanation` so `ANCHORS_INCOMPLETE` and an
anchor-limited confidence miss are distinguishable. No anchor-generation
change was made.

**FIDELITY:** gates unchanged. Not weakened to manufacture success — a
deliberately wrong fidelity hint still produces `PRODUCT_FIDELITY_FAILED`
under negative control. `REFERENCE_AVAILABLE` / `NO_REFERENCE` honesty is
preserved; real product photos remain `NO_REFERENCE`.

**PIPELINE-DRIVEN REPAIR RATE:** BLOCKED (above).

**HARD FALSE-PASS REGRESSION: PASS.** Zero HARD sources became eligible in
any regression evidence. Structurally guaranteed for P42-001: HARD is
rejected by `classifyExtractionGate` before extraction, so the changed line
is unreachable for it.

**MULTI-IMAGE VARIANT SAFETY: PASS.** 11 dedicated tests plus an end-to-end
`runBatch` wrong-variant case. Threshold derived from a measured gap, with a
calibration test asserting the gap still separates the populations.

**SYSTEM ERRORS:** 0 / 490 (0.0%).

**PERFORMANCE:** characterization 82.2 ms/product wall-clock at concurrency 8
(~658 ms single-worker). No pipeline regression: the P42-001 change replaces
one count with another already computed in the same pass — no additional
traversal, no measurable cost.

**INGEST SCALE MODEL:** 1k ≈ 1.4 min · 10k ≈ 14 min · 100k ≈ 2.3 h
(characterization, concurrency 8). Provider quota, not compute, is the
binding constraint: 100k SKUs needs ≥5,000 provider requests against a
measured ~28-request limit. No infrastructure prices are asserted (§49).

**P0-P3 FOUND:** 4 (1×P1, 1×P2, 2×P3) — all fixed. **P0-P3 REMAINING: 0.**
**P4-P6 FIXED:** 1 (P42-005, evidence-tooling). **P7-P10:** 4 documented
only. Full ledger: `docs/vto-phase4-2-defect-ledger.md`.

**FULL REGRESSION:** see GATES below.

```
EXTERNAL CV CALLS:        0
GENERATIVE COMPLETION:    0
PRODUCTION MUTATION:      NO
STAGING MUTATION:         NO
LIVE ENABLED:             NO
HUMAN QA:                 PENDING  (not a build blocker, §39)
GATE E:                   PENDING HOSTILE AUDIT / RERUN
```

---

## CARRY-FORWARD PROGRAM LEDGER (§72)

Carried forward unresolved. Nothing here was closed by this lane.

```
P3-A visual verdict:                    PENDING
Case 8:                                 PENDING
Native runtime:                         NOT VALIDATED
Physical device:                        NOT VALIDATED
Real-person Live:                       NOT VALIDATED
Generative AI Photo provider E2E:       NOT VERIFIED BY THIS LANE — no
                                        provider call was made; status is
                                        unchanged from its last verified
                                        state and this lane asserts nothing
                                        new about it.
Pose/native gating:                     NOT VERIFIED BY THIS LANE — same.
```

Phase 4.2 additions to the ledger:

```
Real-corpus repair-rate measurement:    BLOCKED on provider quota
Four EASY forensic dispositions:        BLOCKED on provider quota
Corpus >= 1000 products (§7):           NOT REACHED (490) — provider quota
Vinted photo-array collapse (P42-D03):  OPEN — leading §61 recommendation
```

---

## REPOSITORY GATES (§67)

Run locally against the final candidate. Real exit codes, not piped ones.

| Gate | Result |
|---|---|
| Full repo suite (`scripts/run-all-tests.js`) | **exit 0** — observed failures 13, known baseline 13, **UNEXPECTED 0** |
| Phase 4.2 + Phase 4 pipeline tests | **153/153 pass** |
| Pipeline typecheck (`tsc -p vto-phase4-pipeline`) | **exit 0** |
| Root typecheck (`tsc -p tsconfig.json`) | **exit 0** |
| VTO regression (`__tests__/vto*`) | included in full suite, no unexpected failures |
| Scope guard (`vtoLiveIntegrationScope`) | **10/10 pass** after declaring the two new paths |
| Edge parity (`verify:edge-parity`) | **exit 0** |
| Edge manifest / source parity | **23/23 pass** |
| Security baseline + applicability | **71/71 pass** |
| Privacy | **5/5 pass** |
| Migration provenance | **exit 0 — PASS** |
| Migration version collisions | **exit 0 — PASS** |
| Dependency reachability | **could not run locally** — see below |

```
UNEXPECTED FAILURES: 0
```

**One observed flake, disclosed.** On one full-suite run,
`closetPromotionCoordinator.test.js` → *"a deadline that elapses DURING the
committed write still recovers as success"* failed, then passed 37/37 on three
consecutive isolated runs and on the next full-suite run. It is a real-clock
deadline test that flakes under full-suite load — pre-existing, unrelated to
this lane (which touches no closet or promotion code), and recorded rather
than quietly re-run until green.

**Dependency reachability.** The gate fails closed with
`AUDIT_UNAVAILABLE — npm audit could not run: spawnSync npm ENOENT`. Cause:
`scripts/check-dependency-reachability.js` invokes `spawnSync('npm', ...)`
without a shell, which cannot resolve `npm.cmd` on Windows. This is
environmental and pre-existing — it is not caused by this branch, whose
entire diff is confined to `vto-phase4-pipeline/`, `docs/`,
`evidence/vto-phase4-2/` and one additive `.gitignore` line, none of which
can affect root dependency auditing. It runs normally in CI on Linux. The
gate failing closed rather than reporting a clean tree it could not verify is
correct behaviour and is recorded, not worked around.

**A note on the scope guard.** It initially **refused** this lane's new
evidence paths. That is the guard working, and the response was to declare
them explicitly with rationale — following the existing precedent of naming
an exact evidence path rather than widening `evidence/**` — not to loosen a
pattern.

---

## FREEZE (§68)

```
CODE FREEZE SHA                6b63790bd63e6c697ba26ad9d2c785188bbb3b5e
                               (last commit containing any code, test,
                               evidence or gate change)
FINAL HEAD                     see PR #303 head — commits after the code
                               freeze are documentation-only, recording
                               this SHA. No src/, __tests__/ or evidence/
                               file changes after 6b63790.
BRANCH                         feature/vto-phase4-2-catalog-addressability
BASE (integration)             4365cebfccfd59843dd3f0a7418c07cb8e9ff843

PIPELINE VERSION               0.1.0        (manifestBuilder.PIPELINE_VERSION)
ASSET CONTRACT VERSION         KSGARMENT_SCHEMA_VERSION (garmentContract.ts)
SHOT CLASSIFIER VERSION        SHOT_CLASSIFIER_THRESHOLDS — UNCHANGED by 4.2
CONFIDENCE VERSION             confidenceExplain.ts + eligibility.ts
                               ELIGIBILITY_CONFIDENCE_THRESHOLD = 0.5 (unchanged)
                               segmentation term: significant-component based (P42-001)
FIDELITY VERSION               fidelity.ts — UNCHANGED by 4.2
SEGMENTATION ROUTER VERSION    n/a — single path; classifyExtractionGate unchanged
SEGMENTATION PATH              deterministic-background-subtraction
                               phase4-segmentation@0.1.0
LOCAL MODEL                    NONE INSTALLED
MODEL CHECKSUM                 n/a
DECODER VERSION                @jsquash/webp 1.5.0 (WASM), pngjs 7.0.0,
                               jpeg-js 0.4.4 — UNCHANGED by 4.2
VARIANT SAFETY                 VARIANT_COLOR_CONSISTENCY_MAX_DISTANCE = 40
                               (calibrated; gap-bounded by test)
```

No tuning was performed after the final evidence was produced. The hostile
audit receives this exact candidate.

**One freeze caveat, stated plainly:** the blocked measurements
(`slice:run`) have not been produced against this frozen candidate. When a
provider quota window opens, running them produces *new* evidence about the
same frozen code — it does not re-tune it. If any repair proves necessary as
a result, that is a new candidate and a new freeze, and should be treated as
such.

---

## WHAT WAS ACTUALLY BUILT

Not diagnostics alone (§69 is explicit that those are insufficient), though
the diagnostics are substantial:

**Repairs.** P42-001 (segmentation confidence destroyed by compression
speckle — affected 21 of 49 addressable real images), P42-002 (confidence
rejections unattributable), P42-003 (multi-image rescue unreachable),
P42-004 (multi-image selection could substitute a different colourway — P1),
P42-005 (benchmark statistic misrepresented a bimodal population, which had
reversed the architecture conclusion).

**New capability.** Large-corpus characterization over every authoritative
image candidate; source preflight (13 metrics); HARD tractability
subdivision; rejection attribution with pipeline-vs-source classification;
variant-consistency guard; segmentation benchmark with ground-truth metrics;
governed local-model loading point; addressable-slice runner.

**Test count.** 87 → 153, all passing, with negative controls on every
repair.
