# VRI-03 instrumentation spec (system baselines + per-stage attribution)

Status: **spec only.** No baseline was measured in this session (see PR section D). Nothing here is implemented.

## 1. What exists today

`scan_commerce_events` (written by `scan-identify/commerceOutcomeCapture.ts`, migrations
`20260720120000_scan_commerce_events.sql`, `20260823120000_scan_commerce_events_accuracy_telemetry.sql`) already
records, per request:

* `request_mode`, `status`, `category_route`, `quality_band`, `commerce_query_detail_level`, `query_strategy`
* `providers_tried[]`, `provider_outcome`, `primary_result_count`, `fallback_used`
* `products_before_filter`, `products_after_filter`, `products_before_dedupe`, `products_after_dedupe`,
  `category_mismatch_removals`, `retailer_count`
* `commerce_duration_ms`, `total_duration_ms`, `top_agreement_score`, `top_agreement_band`, `correlation_hash`

That is enough for **scan-to-results latency p95** and **provider call count** once a cohort is defined. It is not
enough for:

| Gap | Consequence |
|---|---|
| No Gemini token usage is read anywhere (`usageMetadata` is never parsed in `scan-identify/`) | **Token cost per scan cannot be measured** |
| No Gemini call duration column (only total and commerce) | Gemini latency must be inferred as total minus commerce |
| Counts only, no per-candidate trace | **First-drop stage (C) cannot be attributed** from telemetry |
| Two-pass flow writes separate events with no shared scan key on the detection event | Hard to sum one user scan |

## 2. Proposed additions (all behind the VRI-03 master flag, default OFF, no new dependency)

### 2a. Token cost (cheap, no extra call)
Parse `usageMetadata.promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `totalTokenCount` from the
Gemini response already in hand (`index.ts:3033-3035`). Add nullable integer columns to `scan_commerce_events`
(migration, staging first) plus `gemini_duration_ms` and `gemini_attempts`. Cost per scan = Σ over the scan's calls of
`prompt × input_price + (candidates + thoughts) × output_price`, priced from a dated pricing record.

### 2b. Per-stage trace (benchmark cohort only)
A bounded, PII-free trace emitted only for requests carrying an allowlisted benchmark item id (server-verified, never
client-trusted):

```
stage1  gated identification fields (category, subtype, color, material, silhouette, fit, pattern, brand grade)
stage2  issued query, fallback query, whether fallback was sent
stage3  provider pool: [{provider, rank, canonical_url_hash, title}]
stage4  per candidate: removed_by (rule name) | kept
stage5  per survivor: agreement score, band, final position
stage6  Black-owned: candidate rows considered, reject rule per row (category / subtype head noun /
        attribute agreement / strong threshold / eligibility window), final products
```

Titles are product titles from providers (public catalogue text), not user content. No image bytes, user id or
location.

### 2c. Offline replay harness
Given stage-1 output and stage-3 pools recorded once per item, H3 (query normalization) still needs live provider
calls, but **H4 (filter/rerank) and the Black-owned matching review can be replayed offline at zero cost** against the
recorded pools and the authorized-inventory snapshot. Store recordings next to the manifest, digest-pinned.

## 3. Baseline queries (to run once 2a exists, against Staging only)

* Latency p95: `percentile_cont(0.95) within group (order by total_duration_ms)` over the cohort's commerce-only
  (`request_mode` of the commerce request) and image rows, joined per scan.
* Provider calls per scan: `cardinality(providers_tried) + (fallback_used::int)` (upper bound; cache hits count 0).
* Hit rate: from the human labels, not from telemetry.

## 4. Why this could not be run in-session

* The billed Gemini budget is zero, and every scan through Staging makes billed Gemini calls.
* The labeled failure set does not exist (no items to run).
* Production telemetry is out of scope for this public repository and was not read.
