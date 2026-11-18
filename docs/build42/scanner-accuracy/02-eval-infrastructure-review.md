# Build 42 Sprint 1 — Existing fixtures and evaluation infrastructure

| Asset | Where | What it can measure | Limits found |
|---|---|---|---|
| 8 repo QA fixtures | `assets/qa_fixtures/*.jpg` | smoke-level identification and commerce on 7 fashion photos + 1 non-fashion | Provenance `excluded_pending_provenance` for evaluation manifests (Build 4 ruling); `bottom_skirt.jpg` excluded from provider calls; no exact-product, logo or texture strata. |
| Scanner live-certification harness | `security/release/scanner-live-certification/` (mobile line), workflow `staging-scanner-live-certification.yml` | Live Staging runs with the governed synthetic account, hard budget, quota-ledger reconciliation, sanitized report | Corpus = the 8 fixtures; title-graded relevance; built for certification gates, not a growing benchmark. Archived reports for 2026-10-09 (P1/P2/R1) are committed under `docs/build35/scanner/evidence/`. |
| Backend synthetic fixtures | `__tests__/fixtures/scanAccuracyCases.js`, `scanIdentifyProviderFixtures.js`; `qa/backend-quality-tune-fixtures/` | deterministic ranking/filter regressions | Synthetic; README states "not production accuracy". Suites assert flag-off equivalence, not relevance. |
| VRI-03 benchmark harness | `supabase/functions/_shared/vri03/benchmark/` (backend authority) | budget guard, kit import, ledger, metrics | Built 2026-11-04, **never run** (no labelled kit; paid run not approved). |
| Scanner Accuracy v2 evals (Build 4) | branch `research/scanner-accuracy-v2-evals` (`evals/scanner-accuracy/`, `tools/scanner-evaluation/`) | Tier-A licensed Commons benchmark: 40 cases, provenance + SHA-256 per image, curated labels, holdout seal | Not merged. Image bytes lived on a local volume that no longer exists; re-fetchable from recorded Commons URLs and verifiable by SHA-256. Missing stratum: `exactProductKnowable`. Paid baseline blocked on a dedicated evaluation credential (RB-3, never provisioned). |
| Fashion Match Quality Lab | branch `research/fashion-match-quality-lab-v1` (PR #314) | offline evaluator, capture profiles, statistics | Synthetic corpus only. |
| Real Fashion Match Corpus V1/V2 | branches `research/real-fashion-match-corpus-v1` (PR #321), `research/build35-real-fashion-corpus-v2` | collection tooling, power/claim map (96–120 valid cases), holdout sealing | **0 real cases** collected (no device/garments available to the agent). |
| Commerce corpus, FashionCLIP retrieval/rerank | `claude/commerce-corpus-v1-cv2459`, `research/build35-fashionclip-retrieval-v1`, `claude/fashionclip-visual-reranker-qobzvk` | generated commerce corpora, retrieval experiments | Research only; no labelled real images. |
| Production/Staging telemetry | `scan_commerce_events`, `scan_identify_usage_daily`, function logs | latency, empty-shelf rate, provider mix, top agreement band | No per-offer evidence, no destination-kind counts; token counts only for the VRI-03 cohort. |

## Gaps that block a trustworthy accuracy baseline

1. No independently labelled image set covering exact products, logos, textures, multi-item
   scenes and difficult conditions exists on any governed branch.
2. No path from a live run to exact-match precision: the pipeline never emits an exact claim
   (`matchTier` `exact` has no producer) and does not return per-offer agreement.
3. Relevance has only ever been title-graded; no visual judgement of listings exists.
4. Paid runs need an owner-approved budget, and live image calls need the CI-only synthetic
   account (`STAGING_SYNTHETIC_*`); durable quota is 30 image calls per account per UTC day.

## What Sprint 1 adds

* `tools/scanner-benchmark/` — benchmark manifest, reproducible fetch/verify of licensed source
  images, deterministic derived "difficult condition" variants, independent scoring library
  (`lib/destination.mjs`, `lib/judge.mjs`, `lib/metrics.mjs`), and an adapter that scores the
  archived Build 35 live evidence with the same metrics.
* Scoring is independent of `supabase/functions/**` so the pipeline is never graded by its own
  rules.
* Branch `repair/b42-scanner-match-confidence-v1` makes the confidence signal observable
  (`matchConfidence` per offer + counts-only log line) so the next live run can measure
  exact/probable precision and merchant-link validity directly.
