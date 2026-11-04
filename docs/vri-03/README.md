# VRI-03 — Visual Retrieval Intelligence (Phase A report)

**Verdict: `BENCHMARK PENDING`.** Phase A gate condition (a), at least 15 labeled items, fails: no qualifying failure set
exists, and building one needs consented real scans, human Google-lookup labeling and billed Staging scans, none of
which are available in this session (Gemini budget is zero). Condition (b), a per-stage baseline, fails as a
consequence. Per the brief, Phase A is committed and Phase B was **not started**. No scan behavior changes in this PR.

Companion documents:

* [field-annotation.md](field-annotation.md) — §5 instruction annotation and per-field used/discarded table (E)
* [failure-set-spec.md](failure-set-spec.md) — failure-set construction spec, taxonomy, strata, manifest shape (B)
* [instrumentation-spec.md](instrumentation-spec.md) — system baselines and per-stage attribution spec (D, H)

## A. Branch, SHAs, stacking

* Branch `ci/vri-03-instruction-retrieval`, created from `ci/ci-03-validation-opus` @ `dd82d40d` (CI-03, draft PR #721),
  which stacks on CI-02 (#717, `0fd392ca`) and CI-01 (#715, `b0aaff17`).
* No file under `supabase/functions/_shared/corporateIntelligence/` is touched.
* Files added: this folder, plus `supabase/functions/_shared/vri03/scanImprovementsFlag.ts` and its test. The flag
  module is **not imported** by any scan-path or Black-owned discovery file (a test asserts this), so it is in no
  deployed bundle and `config/edge-function-manifest.json` is unchanged. It sits in `_shared/` rather than in
  `scan-identify/` because the parity gate tracks every file inside a function tree but only bundle-reachable
  `_shared` files. Wiring it into `scan-identify` later will make it bundle-reachable and require a manifest
  regeneration in that same change.

## B. Failure set

**0 items.** Candidates were searched and rejected; reasons are in [failure-set-spec.md §1](failure-set-spec.md).
The closest asset, Scanner Accuracy Tier-A v0.3.1, is a licensed museum/Wikimedia identification benchmark with its
`exactProductKnowable` stratum missing and no record of what Google surfaced. Consent confirmation: not applicable,
since no images were collected, stored or committed.

## C. Per-stage baseline

**Not measured (0 items).** The table below lists the points in the code where an item *can* drop out, found by reading
the source. Each row is a hypothesis to test on the failure set. None of them is a measured cause, so every row
carries `INSUFFICIENT EVIDENCE`.

| Stage | Static drop point on the default path | Source | Evidence |
|---|---|---|---|
| 1 Attribute extraction | Selected-item schema cannot carry `distinctive_features`, `style_tags`, `length`, `closure`, `neckline_or_lapel`, `secondary_colors`, `search_queries` (unless v124 is ON) | `index.ts:789-839` | INSUFFICIENT EVIDENCE |
| 1 Attribute extraction | Brand guesses nulled unless visible evidence exists (intended safety behavior) | `scannerQualityGate.ts:576-601,691-718` | INSUFFICIENT EVIDENCE |
| 2 Query construction | Gemini `search_queries` overwritten with a single quality label | `scannerQualityGate.ts:722-727` | INSUFFICIENT EVIDENCE |
| 2 Query construction | One query, ≤5 key terms / ≤8 words; no synonyms or alternate garment names | `commerceRelevanceQueries.ts:122-158,346-554`; `commerceRelevanceConfig.ts:40-41` | INSUFFICIENT EVIDENCE |
| 2/3 Retrieval | Fast path (funnel ON) computes a fallback query but never sends it (`fallbackUsed: false`); the funnel-OFF path does send it when fewer than 3 products are valid | `scanCommerceRouter.ts:1019-1021,1191` vs `scanCommerceRouter.ts:1553-1566` | INSUFFICIENT EVIDENCE |
| 3 Provider retrieval | Serper + Poshmark in parallel, one query, 3 s deadline | `scanCommerceRouter.ts:1088-1112`; `commerceFunnelConfig.ts:57` | INSUFFICIENT EVIDENCE |
| 4 Filtering | Pool truncated to 10 **before** scoring (Serper first, so Poshmark candidates are cut first) | `scanCommerceRouter.ts:1178-1180` | INSUFFICIENT EVIDENCE |
| 4 Filtering | Weak-band (<50) candidates dropped beyond the 3-result coverage floor | `commerceRelevanceDiversity.ts:176-197` | INSUFFICIENT EVIDENCE |
| 5 Ranking | Agreement scored on title text; verified brand worth 5/100 without v124 | `commerceRelevanceAgreement.ts:23-29,130-148` | INSUFFICIENT EVIDENCE |
| 6 Black-owned | Search-quality gates: exact category equality, subtype head-noun match (a catalog subtype more specific than the scan never matches), ≥2 normalized attribute agreements, agreement ≥75 | `black-owned-discovery/engine.ts:36,45-57,72`; `validation.ts:49-56` | INSUFFICIENT EVIDENCE |
| 7 Coverage | Not assessable without items | — | INSUFFICIENT EVIDENCE |

## D. System baselines

**Unavailable in-session.** Hit rate needs the labeled set. Latency p95 and provider calls per scan are recordable
from `scan_commerce_events` but were not read: Staging has no benchmark cohort, and Production state is out of scope
for this public repository. **Token cost per scan is not measurable anywhere today**, because `scan-identify` never
reads Gemini `usageMetadata`. The instrumentation spec covers all four.

## E. §5 per-field annotation

See [field-annotation.md](field-annotation.md). Summary:

* No fashion-expert system instruction by default. It exists behind `SCAN_IMAGE_PRODUCT_MISSION_V1_ENABLED` (OFF).
* Few-shot: 4 text-described examples on the legacy single-item prompt; none on the selected-item prompt that feeds
  commerce on the two-pass flow.
* Searchable-attribute guidance is present but brief. Era/style guidance, synonym generation, exact-vs-similar intent
  and per-attribute confidence are absent on the default path.
* **Discarded on the default commerce path:** `search_queries`, `secondary_colors`, `sleeve_length`,
  `neckline_or_lapel`, `closure`, `style_tags`, `occasion_tags`, `styling_suggestions`, `scan_quality_note`, and
  `distinctive_features` beyond footwear toe/heel heuristics. `confidence_score` is display/telemetry only.
* Dead reads: query builders read `attributes.color`, `attributes.material` and `attributes.brand`, which
  `sanitizeAttributes` never emits.

## F. Per-change rows

**No change was built.** The brief forbids landing an unmeasured change, and Phase B is gated on A. The flag contract
is in place so each change gets its own attributable, revertible sub-flag when it is measured:

| Change | Sub-flag (env) | Status | Planned design (from E/C) | Benchmark row |
|---|---|---|---|---|
| H1 instruction | `VRI03_H1_INSTRUCTION_ENABLED` | NOT BUILT | Fashion-expert system instruction with exact-then-similar intent, searchable-attribute guidance (silhouette, fabric *appearance*, construction, pattern, era) and synonyms. Existing prompts kept verbatim as fallback constants. Needs billed calls to measure. | — |
| H2 schema/parser | `VRI03_H2_SCHEMA_PARSER_ENABLED` | NOT BUILT | Optional selected-item fields: `distinctive_features`, `style_tags`, `length`, `closure`, `alt_garment_terms[]`, per-attribute confidence for colour/material. Additive to the v123 schema. Watch output-token growth (latency/cost). Needs billed calls to measure. | — |
| H3 query normalization | `VRI03_H3_QUERY_NORMALIZATION_ENABLED` | NOT BUILT | Deterministic: garment-synonym expansion from a fixed vocabulary; send the already-computed fallback on the fast path when <3 valid products, within the existing deadline. Needs live provider calls (no Gemini) to measure. | — |
| H4 filter/rerank | `VRI03_H4_FILTER_RERANK_ENABLED` | NOT BUILT | Score the whole pool before the 10-cap; interleave providers before the cap; review the weak-band coverage cut. Replayable offline at zero cost against recorded pools. | — |
| H4b Black-owned matching | `VRI03_H4B_BLACK_OWNED_MATCH_ENABLED` | NOT BUILT | Only if the set shows verified in-inventory products lost to the subtype/attribute *match* rules. Verification windows, eligibility and ownership labels are out of bounds. Replayable offline. | — |

## G. Aggregate before/after

Not applicable. No change was measured.

## H. Instrumentation spec and cost to unblock

See [instrumentation-spec.md](instrumentation-spec.md). Escalation: measuring H1/H2 **requires billed Gemini calls**.
That is a stop condition, so no call was made. Estimate for owner approval, using the pricing record
`evals/scanner-accuracy/pricing/gemini-pricing.2026-07-29.json` on `research/scanner-accuracy-v2-evals` (Scanner
primary `gemini-3.6-flash`, $1.50 / M input, $7.50 / M output incl. thinking; image ≈1,032 tokens; text ≤1,500):

| Item | Assumption | Estimate |
|---|---|---|
| Per Gemini call, typical | ~2,532 input + ~600 output tokens (output **unmeasured**) | ≈ $0.008 |
| Per Gemini call, worst case | output at the 2,048 cap; ×2 if the fallback attempt fires | ≈ $0.019 – $0.038 |
| Benchmark | 24 items × 2 calls (two-pass) × 3 Gemini arms (baseline, H1, H2) × 3 repeats = 432 calls | ≈ $3.6 typical, ≈ $8.3 worst, ≈ $16.6 worst with retries |
| Suggested ceiling | | **$20 Gemini** |
| Provider calls | ≤ 2 queries × 4 query-changing arms × 24 items ≈ 192 Serper + 192 Poshmark | price not recorded in repo; owner to supply |

H4/H4b can then be measured offline at $0 from the recorded pools.

## I. Out-of-scope findings

* **H5 coverage ceiling:** not assessable without items. Route to the business owner once stage 7 has a count.
* **Tier 3 (document only):** image-embedding retrieval or vector search over the authorized inventory; a visual search
  provider (a new provider, so excluded); a multi-pass "verify the top result against the image" Gemini call (an extra
  sequential call, so excluded).
* **Routed defects:** none filed. Every defect found sits inside VRI-03's own scope (query construction, retrieval,
  filter/rank) and is listed in C for measurement. The taxonomy gap for skirts, jumpsuits, vests and others is already
  recorded in source as SCAN-007 (`scanCommerceRouter.ts:521-534`) for owner decision, so it was not re-filed.
* **CI:** the push-triggered "Trivy filesystem" job fails while installing Trivy v0.70.0 (install.sh exit 6 after
  "found version"). That is the existing CI/Security-owned issue (runs 41733882743, 41743020648) and is not caused by
  this PR.

## J. Verdict

`BENCHMARK PENDING`

Advisory only: merge nothing, flip no flags. To unblock: (1) owner approves the failure-set collection and a Gemini
ceiling (section H); (2) build ≥15 labeled items per [failure-set-spec.md](failure-set-spec.md); (3) add the
token/trace instrumentation behind the VRI-03 master flag on Staging; (4) resume Phase B in order H1 → H4, one
sub-flag and one benchmark row per change.
