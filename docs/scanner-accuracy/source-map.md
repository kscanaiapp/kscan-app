# Scanner Accuracy Source Map — Build 4 Phase 0A

**Research worktree:** `C:\Users\jsmit\KScan-scanner-accuracy-v2-evals`  
**Research branch:** `research/scanner-accuracy-v2-evals`  
**Source SHA (research base):** `4b36878798d16b925e163aae5ed7ed1e0b896198`  
**Mapping mode:** read-only against production Scanner sources (not modified)

Legend: **measured** (runtime metadata) · **statically verified** (source) · **designed** · **not tested**

---

## Deployed baseline (measured)

| Item | Value |
|------|-------|
| Supabase project | `wyyuqfdxucjksghsmhry` (KScan App Production) |
| Function | `scan-identify` |
| Deployed version | **140** (ACTIVE) |
| `verify_jwt` | `false` |
| Deployed `ezbr_sha256` | `5c74674cbf6d9894017ed06fa242725233c16c6feaa1ce7dd00b1dc2784c23e8` |
| Observation method | `supabase functions list --project-ref wyyuqfdxucjksghsmhry` (read-only) |
| Paid test traffic | **not generated** |

Local research SHA `4b36878` is an isolation base from Build 3 iOS tip-at-time. It is **not** proven byte-identical to deployed v140. Treat deployed version 140 as the authoritative production function version; treat local tree hashes below as the research-worktree lineage under evaluation.

### Local lineage hashes (statically verified at research HEAD)

| Artifact | Git object hash |
|----------|-----------------|
| `supabase/functions/scan-identify` tree | `1e6ec21160ec3bc9c3f834ba59677acb6e3c9e2c` |
| `fashionIdentificationV2.ts` blob | `1e8acdd4ebf3b6de480352c23d06597ded6ee44d` |
| Content SHA256 `fashionIdentificationV2.ts` | `b041a899aea90bf091b337a486087fe58670fd27058d51b8a6a4b5f86b1d6699` |
| Content SHA256 `llmModelRouting.ts` | `4e39d7a549e1f6222e34ec7eddb89f8a6da8fffa4ba1509bf2495f7c1c6ef14c` |
| Manifest `scan-identify.treeHash` (informational) | `31827147874765408e7fe3ceb1dd90990c82f754581b4276cc09ba0a6bd79e86` |

**Discrepancy note:** There is no single `FUNCTION_VERSION` constant in source. Layer versions are `v120`–`v123`. Deployed Supabase function version is the integer **140**. Planning docs mentioning older integers must yield to measured version 140.

---

## Model / provider configuration (statically verified)

**Provider:** Google Generative Language API (`generativelanguage.googleapis.com/v1beta`)  
**Auth env:** `GEMINI_API_KEY` (never printed)

From `supabase/functions/_shared/llmModelRouting.ts`:

| Surface | Primary | Fallback | Max attempts |
|---------|---------|----------|--------------|
| Scanner (image) | `gemini-3.6-flash` | `gemini-3.5-flash-lite` | 2 |
| TextScan | `gemini-3.5-flash-lite` (pinned; no Flash escalation) | same-model retry | 2 |
| Allowlist | `{gemini-3.6-flash, gemini-3.5-flash-lite}` only | retired prefixes blocked | |

Optional override: `SCAN_GEMINI_MODEL` only if allowlisted. Timeout default ~14s (`SCAN_GEMINI_TIMEOUT_MS`).

**Authoritative rule:** verified source/runtime allowlist beats planning-document model names.

---

## Layer versions inside scan-identify (statically verified)

| Layer | Constant | Value |
|-------|----------|-------|
| Quality tune | `QUALITY_TUNE_VERSION` | `v120` |
| Scanner intelligence | `SCANNER_INTELLIGENCE_VERSION` | `v121` |
| Commerce relevance | `COMMERCE_RELEVANCE_VERSION` | `v122` |
| TextScan commerce parity | `TEXTSCAN_COMMERCE_PARITY_VERSION` | `v123` |
| Commerce outcome capture | `COMMERCE_OUTCOME_CAPTURE_VERSION` | `v123` |

Env rollback gates exist per layer (defaults generally ON unless explicitly disabled).

---

## Request / response contracts (statically verified)

### Request paths

- Legacy: `ScanIdentifyRequest` (`mode`, `imageBase64` | `textQuery`, multi-item selection fields)
- V2: `FashionIdentificationRequestV2` (`contractVersion: fashion-identification-v2`, `intent`, `evidence[]`, privacy flags)

### Response paths

- Legacy wire: `status` ∈ `{completed, non_fashion, failed}` + attributes / products / similarity
- V2: `FashionIdentificationResultV2` with `status`, `resolutionLevel`, `item`, `confidence`, `exactProduct`, `candidates`, `unknownReason`

Shared SoT: `contracts/fashion-identification-v2.schema.json` mirrored by `supabase/functions/_shared/fashionIdentificationV2.ts` and client `types/fashionIdentificationV2.ts`.

---

## Behavioral map (statically verified)

| Concern | Current behavior |
|---------|------------------|
| Exact-product claims | V2 vocabulary exists; `normalizeToV2` currently forces `exactProduct: null` (does not invent precision) |
| Similar-product claims | Live `recommendedProducts` + catalog `similarityMatches` via metadata score (≥60), not vectors |
| Category-only / partial | V2 `partial` when category without subtype; legacy may project as `completed` |
| Insufficient evidence | `insufficient_visual_evidence`; commerce skipped |
| Multi-item | Detection mode returns candidates; commerce skipped until `selected_item` |
| Multi-image | V2 allows `evidence[]` but backend rejects >1 today (`MULTIPLE_EVIDENCE_NOT_SUPPORTED`) |
| Brand / material | Prompt + quality tune suppress speculative values; quality gate may broaden commerce queries |
| Confidence | Global score bands High ≥0.80 / Med 0.60–0.79 / Low &lt;0.60; per-field V2 confidence mostly deferred |
| Abstention | Prefer unknown / non_fashion / insufficient_visual_evidence over wrong certainty |
| Duplicate products | Commerce URL/SKU dedupe; capture duplicate-in-flight blocks; no vector garment dedupe |
| Commerce links | Cascade KicksCrew → Farfetch → Serper → Brave; relevance rerank v122 |
| Persistence | `scan_intelligence_events`, `scan_commerce_events` (shop intent gated) |
| Telemetry / privacy | Scrubbed metrics; block images/base64/prompts/emails/tokens from logs |
| Face/plate masking | Client privacy flags exist; production masking **not claimed complete** (`localFaceMaskApplied: false` literal in paths) |

---

## Key source cards

| Path | Responsibility | Model calls | Persistence | Consumers |
|------|----------------|-------------|-------------|-----------|
| `supabase/functions/scan-identify/index.ts` | Main identify + commerce orchestration | Gemini | intelligence + commerce outcome (gated) | Scanner, TextScan, Closet, Elise adapters |
| `supabase/functions/_shared/fashionIdentificationV2.ts` | Contract normalize/validate/project | none | none | Edge + parity tests |
| `supabase/functions/_shared/llmModelRouting.ts` | Allowlist + route plan | none | none | scan-identify, stylechat |
| `supabase/functions/scan-identify/similarityMatcher.ts` | Catalog metadata similarity | none | none | scan-identify |
| `supabase/functions/scan-identify/scanCommerceRouter.ts` | Live commerce cascade | retailer/search APIs | via outcome capture | scan-identify |
| `services/scannerScanRequest.ts` | Mobile network entry | via edge | none | Scanner UI |
| `services/scanIdentification.ts` | Invoke + normalize response | via edge | none | Scanner / mappers |
| `services/closetIdentificationV2.ts` | Closet intent (`identify_for_closet`) | via edge | Closet local | Closet intake |
| `services/scanResultObject.ts` | Recent-scan honesty labels | none | recent/library | Recent Scans UI |

---

## Downstream consumers

Scanner → Recent Scans → Commerce shelves → Closet intake → Dressing Rooms → Elise.

Scanner identity errors propagate across all of these surfaces. Build 4 evaluation remains offline and must not alter those production paths in this phase.

---

## Fixtures relevant to evaluation

| Asset | Authorization |
|-------|---------------|
| `assets/qa_fixtures/*.jpg` + `constants/qaFixtures.js` | Approved QA fixtures (DEV-gated); Build 4 references by hash/governed path |
| `__tests__/fixtures/scanAccuracyCases.js` | Synthetic text proxies — not visual GT |
| `qa/backend-quality-tune-fixtures/*` | Synthetic text — not statistical accuracy |

Ordinary production user images: **not authorized**.

---

## Future Build 4 production handoff dependencies (do not edit now)

If production accuracy improvements later require Build 3-owned or production Scanner changes, document them in `production-handoff.md` rather than editing those files during Phase 0A.
