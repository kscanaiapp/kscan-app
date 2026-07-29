# Phase 0B — Paid baseline authorization packet

**Status: NOT AUTHORIZABLE YET.** Two independent dependencies are unresolved.
This packet is complete in structure and cost, so that when the dependencies
clear the owner has a decision to make rather than an analysis to commission.

**No paid call was made during Phase 0B.**

---

## 0. Why this cannot be signed today

| # | Blocker | Status after Phase 0C |
|---|---|---|
| **B1** | **Dataset** | **OPEN.** 8 real apparel images against a 75-case target. Provenance is unverified for **all 8** — zero are approved. 1 excluded pending provenance, 3 need masked derivatives. Zero multi-image sets, zero exact-product-knowable cases. |
| **B2** | **Environment** | **HALF RESOLVED.** The certified v140 source is now **located and proven** — `cert/ios-phase-2b4-cross-path-v2` `f5f4ed2`, bundle `28737e0c…`, 31/39 files, re-derived from git objects. The **adapter is still unbuilt**, blocked on an evaluation Gemini credential. |
| **B3** | **Review staffing** | **OPEN.** No reviewer assigned. Two costed options in `phase0c-review-staffing.md`. |

Phase 0C correction: Phase 0B proposed building the adapter from the research
branch. That was wrong — the research branch drifted forward past v140 by two
commits adding `identify_for_closet`, and its bundle hashes to `9d645f5e…`, not
`28737e0c…`. The adapter must be built from the certified tree.

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

**NOT MEASURED — reported as the literal `not_measured`, never as `0`:**

- **`exactProductPrecision` and `incorrectExactMatchRate` (MC-1).**
  `normalizeToV2` hardcodes `exactProduct: null` and never claims
  `exact_product` or `model_family` resolution, so the field cannot be populated
  by any model behaviour. Phase 0C reclassified this: these cases are **no longer
  scored as under-identification**, because that attributed a contract
  limitation to the model and inflated the under-identification count. They are
  **retained and tagged `futureExactProductEvaluation: true`**.
  A `0` here would read as a model failure on the first metric and as proof of
  good calibration on the second. Both are misreadings, so neither number is
  produced. Asserted by test.
- **Phase 2 retrieval and reranking may not claim exact-SKU accuracy** until a
  future authorized contract supports exact-product claims.
- **Subtype / model-family / exact-product confidence (MC-2).** All hardcoded null.
- **Cross-image conflict from production (MC-3).** `conflicts` is always `[]`;
  conflict must come from reviewer adjudication.
- **Commerce (§9).** `commerceLinkValidity`, `retailerRelevance` and
  `duplicateRetailerRate` are all `not_measured`, cost $0, and **may not enter
  any candidate pass/fail decision** until a separate authorized commerce
  evaluation exists.

A prediction that *does* carry an exact product is flagged
`unexpectedExactProductClaim` — it cannot come from certified v140, so it means
the runner is not exercising the certified bundle.

## 9. Prioritized owner decision packet

### Priority 1 — Dataset and provenance *(blocks everything else)*

| # | Decision | Evidence |
|---|---|---|
| 1.1 | Which current fixtures, if any, are authorized. **Zero are approved today** — none has a source owner, licence or use record | `provenance-ledger.v1.json` |
| 1.2 | Is **internal garment photography** authorized? *(recommended — the only route yielding clean ownership, controlled privacy, real multi-angle sets and exact-product evidence together)* | `phase0c-capture-specification.md`, ~9–10 h |
| 1.3 | Is **tester-contributed** photography authorized, and under what written authorization? | sourcing plan route 2 |
| 1.4 | Is **licensed imagery procurement** authorized? Licence must explicitly permit AI/ML evaluation — many now exclude it | sourcing plan route 3 |
| 1.5 | **Where does governed image storage live?** Bytes must stay out of Git | privacy policy §1 |
| 1.6 | Is **synthetic development imagery** permitted? Capped at 20% of development, barred from holdout, never brand or exact-product truth | sourcing plan route 4 |

### Priority 2 — Review staffing

| # | Decision | Cost |
|---|---|---|
| 2.1 | **Option 1** two-reviewer independent review | ~26 h |
| 2.2 | **Option 2** single-reviewer development set, with the holdout still independently reviewed | ~16.5 h |
| 2.3 | Approve the qualification threshold **after** calibration produces a distribution | — |
| 2.4 | Fund 15–20 **separate** calibration images so reviewers do not calibrate on the evaluation set | ~0.5 h capture |

Delta between options is ~9.5 h. Option 2 requires the report to state that
development ground truth is single-reviewer, and forbids calling intra-rater
consistency inter-reviewer agreement.

### Priority 3 — Execution mode

| # | Decision |
|---|---|
| 3.1 | Approve the **certified-v140 local adapter** *(recommended)* — source proven, `deno 2.8.2` and `supabase CLI 2.109.1` installed |
| 3.2 | Or create a staging environment *(no second Supabase project exists today)* |
| 3.3 | Or defer the baseline |
| 3.4 | Provide an **evaluation-scoped Gemini credential** — the single hard blocker on the adapter |
| 3.5 | Confirm or supply production `SCAN_GEMINI_MODEL` / `SCAN_GEMINI_FALLBACK_MODEL`; **secret values were not read** |
| 3.6 | Approve the persistence and telemetry stubs once written |

Production endpoint use remains **unauthorized**.

### Priority 4 — Production fixture escalation

| # | Decision |
|---|---|
| 4.1 | Establish provenance for `bottom_skirt.jpg`, or conclude it cannot be established |
| 4.2 | Decide replacement or removal, via a **separate production-safe task** |
| 4.3 | **Propagate or reject the `__DEV__` gate on `origin/master` and `release/ios-v18-build-prep`** — both are ungated today and a build cut from either would bundle all 8 fixtures |
| 4.4 | Verify the gate empirically with a post-fix production export — its asset-level effectiveness is unproven |

4.3 is independently justified regardless of the provenance outcome, and is the
cheapest exposure reduction available.

### Priority 5 — Paid-call ceiling

Expected **$1.28**, worst case **$4.05**, requested ceiling **$10.00**, at 95
expected / 200 maximum calls, using official Google pricing retrieved
2026-07-29. A free `countTokens` pre-flight must replace the chars/token
estimate before any paid call.

**Cost does not override the need for environment and privacy authorization.**
Priorities 1–4 must clear first; the ceiling is the last gate, not a shortcut
past the others.

### Deferred — decide after the baseline

- Final trust weights. The proposed profile has no empirical basis yet.
- Disputed ontology relationships: blazer/outerwear, skirt-as-bottoms,
  eyewear/jewelry as level-1, teal/olive families.

---

**No paid run may begin until the owner explicitly approves the cost ceiling and
the execution mode, and until Priorities 1–4 are cleared.**
