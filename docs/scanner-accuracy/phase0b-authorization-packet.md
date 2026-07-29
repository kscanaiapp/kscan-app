# Phase 0B — Paid baseline authorization packet

**Status: NOT AUTHORIZABLE YET.** Two independent dependencies are unresolved.
This packet is complete in structure and cost, so that when the dependencies
clear the owner has a decision to make rather than an analysis to commission.

**No paid call was made during Phase 0B.**

---

## 0. Why this cannot be signed today

| # | Blocker | Detail |
|---|---|---|
| **B1** | **Dataset** | 8 real apparel images accessible against a 75-case target. 1 rejected on consent grounds, 3 need masked derivatives, and authorization is unverified for all 8. Zero multi-image sets and zero exact-product-knowable cases exist. |
| **B2** | **Environment** | No staging project exists; the isolated runner is not built; deployed-v140 equivalence cannot be proven offline. See `phase0b-execution-environment.md`. |

Everything below is costed against the **intended** 75-case dataset, so the
figures stay valid once B1 and B2 clear. Where a figure would change with a
smaller dataset, both are given.

---

## 1. Dataset

| Field | Value |
|---|---|
| Dataset version | `0.2.0` — **BLOCKED, NOT FROZEN** |
| Freeze gate | `tools/scanner-evaluation/freeze-dataset.js` → **FREEZE REFUSED** (5 gates failed) |
| Intended case count | 75 |
| Intended development / holdout | 60 / 15 |
| Currently admissible cases | 4 (7 after masked derivatives, 8 minus 1 rejected) |
| Intended total images | ~95 (65 single-image + ~10 sets averaging 3) |
| Multi-image set count | intended ≥10; **currently 0** |

## 2. Execution environment

| Field | Value |
|---|---|
| Planned environment | **Option B — isolated exact-bundle runner** (not built) |
| Staging available | No — one Supabase project exists and it is production |
| Repo-side bundle proof | `check-edge-function-parity.js` **PASS**; `scan-identify` bundle `9d645f5eb5bb04f2…`, 31 files |
| Source equivalence | HEAD `scan-identify` tree `1e6ec21160ec3bc9…` is identical to manifest source commit `01cc4fca` |
| Deployed-v140 equivalence | **UNPROVEN.** No repo attestation binds a deployed version to a bundle hash; the deployment doc still says v139 |
| Production endpoint | Not used, not recommended |

## 3. Model configuration

Source: `supabase/functions/_shared/llmModelRouting.ts`.

| Role | Model |
|---|---|
| Scanner primary | `gemini-3.6-flash` |
| Scanner fallback | `gemini-3.5-flash-lite` |

`SCAN_GEMINI_MODEL` / `SCAN_GEMINI_FALLBACK_MODEL` may override, but only to an
already-approved model; the generic `GEMINI_MODEL` cannot influence scanner
routing. **Secret values were not read.** If a production override is set, the
runner must match it or the baseline measures a different model than users get.

## 4. Call plan

| Quantity | Value | Basis |
|---|---|---|
| Expected primary calls | **95** | one call per image; deployed v140 accepts a single V2 evidence item, so a 3-image set is 3 calls |
| Expected fallback calls | **0** | fallback is never invoked deliberately; bounded at 10 (≈10%) if the primary errors |
| Expected retry calls | **0** | bounded at 95 — at most one retry per call |
| **Hard maximum call count** | **200** | enforced by `--max-calls`; `CallBudget.consume` throws rather than exceeding it |

For the currently-admissible 4-case subset: 4 primary calls, ceiling 10.

## 5. Token and cost basis

**Input per call**

| Component | Tokens | Measurement |
|---|---|---|
| Identification prompt | ~3,003 | 12,011 chars measured from `scan-identify/index.ts`, at 4 chars/token |
| Quality precision rules | ~268 | 1,073 chars measured |
| Selected-garment framing | ~211 | 842 chars measured |
| Request/schema overhead | ~500 | allowance |
| Image | 258–1,032 | Gemini rule: ≤384px both dims = 258 tokens; otherwise 258 per 768×768 tile. Measured mean across the 8 fixtures = **613**; planning figure uses **1,032** (4 tiles) since phone photos typically exceed one tile |
| **Planning input total** | **~5,000** | |

**Output per call:** ~800 tokens mean, 1,500 max — a full V2 identification JSON
with observations.

**Average image size:** 129.9 KB measured across the 8 fixtures.

### Official provider pricing

Source: **Google Gemini API pricing, `https://ai.google.dev/gemini-api/docs/pricing`, retrieved 2026-07-29.** Paid tier, standard.

| Model | Input / 1M | Output / 1M |
|---|---|---|
| `gemini-3.6-flash` | **$1.50** | **$7.50** |
| `gemini-3.5-flash-lite` | **$0.30** | **$2.50** |

### Cost

| Scenario | Calls | Per call | Total |
|---|---|---|---|
| Expected (95 primary, no retry, no fallback) | 95 | $0.0135 | **$1.28** |
| Worst case (200 calls, all primary, max output) | 200 | $0.02025 | **$4.05** |
| Currently-admissible 4-case subset | 4 | $0.0135 | **$0.05** |

- expected per call = (5,000 × $1.50 + 800 × $7.50) / 1e6 = $0.0135
- worst per call = (6,000 × $1.50 + 1,500 × $7.50) / 1e6 = $0.02025

**Requested cost ceiling: $10.00 USD.** That is 2.5× the modelled worst case, and
the run aborts at the 200-call ceiling regardless of spend.

**Zero-cost pre-flight, required before the paid run:** Google's `countTokens`
endpoint is free. Run every planned request through it first to replace the
4-chars/token estimate with exact counts. If measured input exceeds the 5,000
planning figure by more than 25%, re-cost before proceeding.

## 6. Operations

| Field | Value |
|---|---|
| Expected wall-clock | 15–30 min for 95–200 calls |
| Concurrency | 4 (proposed; conservative against per-minute limits) |
| Rate-limit response | Exponential backoff, capped at 3 attempts; a rate-limited call counts against the ceiling once, not per attempt |
| Retry policy | At most one retry per call, only on transport or 5xx errors. A low-confidence *result* is never retried — that is the measurement |
| Cancellation | SIGINT/SIGTERM stop at a case boundary; every completed case is already durable |
| Resumability | `--resume` skips any case with a durable result file. Proven by test: `resume does not re-call a completed case` |
| Duplicate prevention | Writing a result twice throws `DuplicateOutput`. Proven by test |
| Output directory | `--output-dir`, one JSON per case under `cases/`, failures under `failures/` |
| Output retention | 90 days from completion, per `phase0b-privacy-retention.md` |
| Access policy | Local to the operator; not committed to Git; contains model responses, not images |

## 7. Safety proofs

| Claim | Proof |
|---|---|
| Commerce disabled | `identify_for_style` skips commerce in `fashionIdentificationV2.ts` via production's own routing, not a modification. Commerce metrics are hardcoded `not_measured` and asserted by test |
| Persistence disabled | The runner ships no persistence writer. Option B additionally requires approved stubs before it runs |
| No production traffic | The runner has no built-in executor; `--execute` without an injected adapter throws. Asserted by test |
| Zero calls in dry run | `dry run makes zero model calls and writes zero case results` asserts `budget.executed === 0` and that `cases/` is never created |
| Ceiling enforced | `hard call ceiling stops the run` asserts `CallCeilingExceeded` |
| No cross-version mixing | `loadAllResults` throws on mixed dataset versions. Asserted by test |

## 8. What the baseline will and will not measure

**Will measure:** category, clothing type, subtype, primary and secondary colour,
material, pattern, brand precision and brand false-positive rate, abstention
correctness, non-fashion false-positive rate, result-state accuracy, schema
parse failure rate, fallback invocation rate, and multi-image consistency once
sets exist.

**Will NOT measure — and no report may imply otherwise:**

- **Exact-product accuracy (MC-1).** `normalizeToV2` hardcodes `exactProduct:
  null` and never claims `exact_product` or `model_family` resolution. Every
  exact-product-knowable case scores under-identification *by contract*. The
  scorer flags these `contractCeilingAttributable` so the report can separate
  them from model failures.
- **Exact-product overconfidence.** The model's product claim, if any, is
  discarded before it reaches the result, so the trust failure that matters most
  is invisible on this path.
- **Subtype / model-family / exact-product confidence (MC-2).** All hardcoded null.
- **Cross-image conflict from production (MC-3).** `conflicts` is always `[]`.
- **Commerce.** Disabled. Link validity, retailer relevance and duplicate
  listings are all `not_measured` and cost $0.

## 9. Owner decisions required

1. **Resolve dataset authorization (INV-1)** — produce a licence, model release
   or provenance record per image, or replace the fixtures.
2. **Decide on the rejected fixture (INV-2)** — `bottom_skirt.jpg`, including
   whether it should remain in the repository at all given it is committed under
   `assets/`.
3. **Approve masked derivatives** for `top.jpg`, `dress.jpg`, `outerwear.jpg`.
4. **Authorize image sourcing** to close the 67-case shortfall — see
   `phase0b-dataset-sourcing-plan.md`.
5. **Staff the reviewers** — primary, independent secondary, adjudicator.
6. **Approve the calibration qualification threshold** after calibration runs.
7. **Authorize one production metadata read** to attest deployed v140's bundle
   hash.
8. **Provide an evaluation-scoped Gemini credential.**
9. **Approve the persistence/telemetry stubs** once written.
10. **Approve the $10.00 cost ceiling and Option B as the execution mode.**
11. **Decide the final trust weights** after the baseline — the proposed profile
    has no empirical basis yet.
12. **Rule on the disputed ontology relationships** — blazer/outerwear,
    skirt-as-bottoms, eyewear/jewelry as level-1, and the teal/olive families.

---

**No paid run may begin until the owner explicitly approves the cost ceiling and
the execution mode, and until B1 and B2 are cleared.**
