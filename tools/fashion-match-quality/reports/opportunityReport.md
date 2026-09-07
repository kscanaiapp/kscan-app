# Fashion Match Quality Lab - Opportunity Report (V1)

BENCHMARK STATUS: INTERNAL ENGINEERING EVIDENCE ONLY. Nothing below is a
customer-facing accuracy claim; it is a prioritized list of what to
investigate next, ranked by the strength of the evidence this build could
gather without a real corpus or live spend.

## Next 5 evidence-ranked opportunities

### 1. Cross-retailer duplicates are invisible to production dedup

- **FINDING:** Production deduplication (`mergeProductCandidates` in
  `supabase/functions/_shared/catalogRetrieval.ts`) is exact-id or
  exact-normalized-URL only. A garment listed by two retailers under
  different URLs is never recognized as the same product.
- **EVIDENCE:** `authority/pipelineMap.json` DEDUPLICATION stage, quoting
  the source directly. Confirmed structurally by this lab's
  `duplicates/duplicateClassifier.js` and by the L1-driven synthetic
  report, which found `LIKELY_DUPLICATE`/`CONFIRMED_DUPLICATE` pairs
  production's own merge step left untouched.
- **CONFIDENCE:** HIGH (directly read from the shipping source file, not
  inferred).
- **CUSTOMER IMPACT:** A shopper's top-K result set can contain the same
  garment twice (different retailer, same or near-identical listing),
  wasting a slot a genuinely different product could have used.
- **AFFECTED STAGE:** DEDUPLICATION (post-retrieval, pre-response).
- **PROPOSED EXPERIMENT:** `experiments/variants/duplicateSuppression.js`
  (already implemented and run in this build) - keep only the best-scored
  member of each detected duplicate cluster.
- **CAN CURRENT LAB TEST IT:** YES (already run; `NOT_DECISION_GRADE` on
  the n=7 synthetic corpus - directionally plausible, not proven).
- **REAL CORPUS REQUIRED:** YES, to get a decision-grade sample and to
  confirm the classifier's brand+title+category heuristic holds on real
  retailer copy (title text varies far more in the wild than in synthetic
  fixtures).
- **PLATFORM-SPECIFIC:** NO.
- **PRIORITY:** P1.

### 2. Silhouette is weighted roughly a third as heavily as category

- **FINDING:** Production's ranking rubric
  (`scoreRecommendedProduct` in `scanHelpers.ts`) weights category at 0.35
  and silhouette at only 0.10. A category-correct, silhouette-wrong
  candidate can outrank a candidate with a better overall garment match.
- **EVIDENCE:** `authority/pipelineMap.json` SCORING_RANKING stage
  (weights quoted verbatim from source). Related prior finding in project
  memory (DEF-CON-002, shared layering taxonomy: substring/insertion-order
  ranking defects in an adjacent system).
- **CONFIDENCE:** MEDIUM (the weight imbalance is proven; whether it
  actually flips real rankings in practice needs real candidate sets - the
  synthetic corpus's "exact" candidate always dominates by construction).
- **CUSTOMER IMPACT:** A shopper could be shown a garment in the right
  category but a meaningfully different fit/shape ahead of a closer match.
- **AFFECTED STAGE:** SCORING_RANKING.
- **PROPOSED EXPERIMENT:** `experiments/variants/silhouetteBoost.js`
  (implemented and run) - raise silhouette weight to 0.18, lower category
  to 0.27.
- **CAN CURRENT LAB TEST IT:** YES for plumbing; NO for a real verdict (the
  synthetic corpus cannot manufacture a case where production's own
  ranking actually gets outscored by a worse silhouette match - that
  requires real candidate sets with realistic score competition).
- **REAL CORPUS REQUIRED:** YES.
- **PLATFORM-SPECIFIC:** NO.
- **PRIORITY:** P2.

### 3. `exact_candidate` confidence tier requires brand evidence, even for a genuinely exact item

- **FINDING:** `rankRecommendedProducts` only assigns the `exact_candidate`
  tier when `score >= 0.90 AND` (visible brand text or logo detected).
  A photo that simply doesn't show a logo/brand tag can never reach
  `exact_candidate`, even for the literal correct item.
- **EVIDENCE:** `authority/pipelineMap.json` SCORING_RANKING stage;
  reproduced directly in `l1/runL1.test.js` ("exact_candidate tier
  requires brand evidence...").
- **CONFIDENCE:** HIGH (structural fact about shipped code, reproduced
  against the real function).
- **CUSTOMER IMPACT:** Possible under-confidence signal to the user/UI for
  correct matches on unbranded or logo-hidden garments (a plain white tee,
  a garment photographed from an angle that hides a tag).
- **AFFECTED STAGE:** SCORING_RANKING (confidence-tier assignment, not the
  underlying score).
- **PROPOSED EXPERIMENT:** Compare `exact_candidate` tier assignment rate
  with vs. without the brand-evidence gate on a real corpus stratified by
  "brand visible" vs. "brand not visible" (spec section 17 stratification
  dimension already supports this split).
- **CAN CURRENT LAB TEST IT:** NO (needs real, human-labeled "is this
  actually the same product" ground truth to know whether removing the
  gate would introduce false-positive exact-candidate claims - this is
  exactly the kind of question a synthetic corpus cannot answer honestly).
- **REAL CORPUS REQUIRED:** YES.
- **PLATFORM-SPECIFIC:** NO.
- **PRIORITY:** P2.

### 4. No vector/embedding retrieval - matching is keyword/tag overlap only

- **FINDING:** No embedding model, vector database, or ANN index was found
  anywhere in the traced identification/retrieval/ranking path. Matching
  is entirely regex-normalized category/color/material/silhouette strings
  plus tag-overlap scoring.
- **EVIDENCE:** `authority/pipelineMap.json` `vectorEmbeddingStack` block -
  the only "vector"/"embeddings" language found repo-wide in this family is
  a user-facing privacy-disclosure string, not an implementation.
- **CONFIDENCE:** HIGH for "not present today"; LOW for "would help" (an
  architectural question, not a bug).
- **CUSTOMER IMPACT:** Ceiling on substitute quality for garments whose
  best textual attributes are ambiguous but whose visual similarity is
  obvious (busy patterns, unusual silhouettes, non-standard color naming).
- **AFFECTED STAGE:** IMAGE_FASHION_UNDERSTANDING through SCORING_RANKING.
- **PROPOSED EXPERIMENT:** Out of scope for this lab as currently scoped -
  would require a new retrieval architecture, which section 6 of the build
  spec explicitly prohibits touching. Recommend a separate, dedicated
  spike lane once a real corpus exists to quantify how often
  attribute-based matching plateaus.
- **CAN CURRENT LAB TEST IT:** NO.
- **REAL CORPUS REQUIRED:** YES.
- **PLATFORM-SPECIFIC:** NO.
- **PRIORITY:** P3 (architecture-level; needs a product decision before an
  engineering spike, not just a measurement).

### 5. iOS/Android capture parity is proven identical only at the JS parameter level

- **FINDING:** No `Platform.OS` branch exists in the traced capture ->
  preprocess -> upload path; iOS and Android use byte-identical
  resize/quality constants. Whether the native camera stacks (AVFoundation
  vs. Camera2/CameraX) or their JPEG encoders introduce any real quality
  delta is unproven either way by static source tracing.
- **EVIDENCE:** `authority/platformCaptureProfiles.json`.
- **CONFIDENCE:** HIGH for "JS-level parameters are identical"; UNKNOWN for
  "real-world output is identical."
- **CUSTOMER IMPACT:** Unknown until measured - could be zero.
- **AFFECTED STAGE:** CLIENT_CAPTURE, CLIENT_IMAGE_PREPROCESSING.
- **PROPOSED EXPERIMENT:** Evaluate a paired iOS/Android real-photo corpus
  (see "Recommended real corpus" below) stratified by `captureProfile`
  (already implemented: `metrics.captureProfileStratification`).
- **CAN CURRENT LAB TEST IT:** Machinery yes (pairing, stratification);
  the actual question, no - it requires real paired captures.
- **REAL CORPUS REQUIRED:** YES.
- **PLATFORM-SPECIFIC:** YES.
- **PRIORITY:** P3 (measure once a real corpus exists; not evidence of a
  problem today, just an open, previously-unasked question).

## Recommended real corpus

Sized and shaped from what this lab's rubric and metrics actually need to
produce a decision-grade result (spec section 18's `MIN_N_FOR_DECISION_GRADE
= 30`), not copied from an unrelated prior estimate:

- **Minimum size for one decision-grade comparison:** >= 30 fixtures per
  comparison arm. Given 8 garment categories
  (`dress, top, pants, footwear, bag, outerwear, accessory, blazer` - the
  categories `normalizeCategory()` actually resolves to, per
  `authority/pipelineMap.json`), a corpus that supports category-level
  breakdowns as well as an overall decision-grade number needs
  **at least 90-120 fixtures** (roughly 12-15 per category), not 30 total.
- **Platform-paired subset:** at minimum 20 garments captured on both iOS
  and an Android device (40 photographs), specifically to answer
  opportunity #5 above. These should be flagged with `pairedFixtureId` and
  `captureProfile` exactly as the synthetic pairs in this build already
  demonstrate.
- **Hard cases (deliberately over-sampled, not just "typical" garments):**
  - garments with no visible brand/logo (directly tests opportunity #3);
  - near-duplicate garments carried by 2+ retailers with different photos/
    titles (directly tests opportunity #1);
  - busy patterns or ambiguous silhouettes (directly tests opportunity #4);
  - low-light / off-angle / partially-occluded photos (tests the existing
    `scan_quality_note` confidence-downgrade path in `scanHelpers.ts`).
- **Required ground-truth fields per fixture** (mirrors
  `schema/fixtureSchema.js` + `evaluator/rubric.js` exactly, so no fixture
  needs backfilling later): `identitySku` (or explicit `null` if genuinely
  unavailable), `brandNormalized`, `category`, `titleNormalized`,
  `color_family`, `material`, `silhouette`, `texture`, `pattern`,
  `construction`, `hardware_details`, `brand`, `price_tier`,
  `availability`, `retailer_quality`, `cut_proportion`.
- **Source requirements (spec section 15 - non-negotiable):** retailer PDP
  data, manufacturer specification, known SKU/product metadata, or direct
  owner annotation. No model-generated label may be used as ground truth
  for a headline metric; a model guess may only be recorded as
  `exploratory_non_authoritative` and is automatically excluded from
  headline metrics by this lab's own aggregation code
  (`metrics/aggregate.js`).
- **Split:** 70% development / 30% holdout (`corpus/corpusLoader.js`
  default), assigned automatically and deterministically once fixtures are
  added - no manual bucketing needed.

## Blocker ledger

| Blocker | Affected milestone | Evidence | Continuation | Owner action needed later | Status |
|---|---|---|---|---|---|
| NO REAL CORPUS | M2/M4/M5 (corpus population, decision-grade comparisons) | Spec section 4: `APPROVED_REAL_CORPUS: NONE` | Built the full synthetic pipeline + `corpus/real/` schema/loader so a real corpus drops in with zero code changes | Collect/curate the corpus described above | OPEN (by design - not required for this build) |
| NO LIVE SPEND | M5 (live experiment execution) | Spec section 4: `LIVE_RUN_SCOPE: NONE`, `SPEND_ENVELOPE_USD: 0` | Implemented the governed L3 interface contract in `authority/`/README but never executed it | Owner authorizes a bounded live spend envelope if/when warranted | OPEN (expected) |
| NO REPLAY CORPUS | M3 (L2 replay) | No sanitized scan-identify request/response fixtures were found committed anywhere in the repository that were safe to replay | Implemented `replay/replaySchema.js` + `replay/replayRunner.js`; `runReplay()` returns `READY_NO_CORPUS` rather than fabricating replay data | If any sanitized production traffic sample is ever exported for engineering use, drop it under `replay/corpus/*.json` | OPEN (expected) |
| DENO AVAILABILITY IS ENVIRONMENT-DEPENDENT | M3 (L1 offline pipeline) | `l1/runL1.js#isDenoAvailable()` probes `deno --version` at runtime; this build's dev machine has Deno 2.8.2 installed and CI already depends on it (`scripts/phase2b4-mutation-battery.js`), but a future CI runner without Deno on PATH would degrade L1 to `BLOCKED` | Every fixture evaluation records `l1Status: 'BLOCKED'` with a `l1Blocker` reason rather than silently producing an empty/fake result; the report's `offlinePipelineMode` field reflects this honestly | If the lab is added to CI, ensure the `deno` setup step already used for Edge Function tests runs before it | MITIGATED (fails visibly, not silently) |
| CLIENT_PRESENTATION STAGE NOT TRACED | M0 | Discovery ceiling reached before tracing the Scanner result-screen UI layer (spec section 9) | Recorded as `NOT_FOUND` in `authority/pipelineMap.json` with the exact impact statement | A follow-up pass could trace `app/` result/shelf screens if UI-level truncation/ordering ever becomes a hypothesis | OPEN, non-blocking (L0/L1 measurement stops at FINAL_RESULT_PAYLOAD and is unaffected) |
| COMMERCE_ENRICHMENT STAGE PARTIALLY TRACED | M0 | `commerceOutcomeCapture.ts` / `commerce-watch-refresh/` were located but not read line-by-line under the discovery-ceiling time budget | Recorded as `PARTIAL` (not `MAPPED`) in `authority/pipelineMap.json`, with the specific fields left `NOT_FOUND` rather than guessed | A follow-up pass could complete this trace if commerce-refresh timing/behavior becomes relevant to a future lab question | OPEN, non-blocking (this stage runs after the scan response and is out of L0/L1's scope) |
