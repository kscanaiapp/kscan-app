# CI-V2 CI-03 — Output Validation, Grounding and Deterministic Fallbacks

| Field | Value |
|---|---|
| Work package | CI-03 (Opus continuation; Addendum 01 applied) |
| Status | **DRAFT. Offline only.** No Edge Function imports these modules; runtime wiring is CI-04 and is not authorized. Product/Trust/Legal approvals are **not** implied by any test result here. |
| Branch | `ci/ci-03-validation-opus` (own worktree), based on the verified CI-02 head `0fd392ca` (CI-01 `b0aaff17` is an ancestor). #715/#717 are untouched. |
| Artifacts | `supabase/functions/_shared/corporateIntelligence/` — `outputValidation.ts`, `responseFinalizer.ts`, `frozenCopy.ts`, `harness/generationPaths.ts`, `harness/adversarialVariants.ts`, `testSupport/ci03Tasks.ts`, `outputValidation.test.ts`, `responseFinalizer.test.ts`; additive cases in the fixture corpus; one CI-02 repair in `contracts.ts` (R2) |

## 1. What CI-03 adds

| Component | Responsibility |
|---|---|
| `validateCorporateOutput` (`outputValidation.ts`) | Pure, transport-independent validator. Input: the server-assembled task (the only authority), one generation candidate, a server-side merchant-name registry, the origin and `now`. Output: accept/reject, closed failure + detail codes, the stage that failed, server-rendered labels and label-match facts. Never repairs or regenerates. |
| `finalizeCorporateResponse` (`responseFinalizer.ts`) | The single place an outcome (candidate or provider failure) becomes a customer response. Accepted text passes through untouched with server-rendered labels; everything else becomes frozen copy with a closed reason. `regenerate` is the literal type `false`. Validator faults fail **closed**. |
| `frozenCopy.ts` | Closed, versioned copy keys (`ci03-frozen-copy-v1-proposed`), one provisional locale map that reuses the CI-01 proposal strings byte-for-byte (no new wording), fail-safe resolution, and the reason → copy mapping delegated to the pinned CI-01 `selectFallback`. |
| `harness/generationPaths.ts` | Inventory of every StyleChat path that can show model text, mapped to a validator origin; a test scans `stylechat-generate/index.ts` (read-only) so a new or renamed path fails until mapped. |
| `harness/adversarialVariants.ts` | Deterministic G1 variant generator (≥ 500 reject-required variants across paraphrase, language, homoglyph, zero-width, leetspeak, spacing, hedge/negation, coordination, anaphora, label transfer, product attribute) plus accept controls. |

### Claim classes and their authority

| Class | Authority (critical decisions) | Text screening role |
|---|---|---|
| Authoritative commercial facts (price, currency, availability) | Fresh verified facts of the task; exact value comparison for structured claims; numeric amount + currency comparison for prose; server price whose symbol disagrees with its currency fact is unusable (`parsePriceValue`) | Locates amounts and stock/discount wording on discovery and scan tasks |
| Visual observations | Never verified facts; a structured observation may not carry "verified/authentic" | Flags observations presented as verified |
| Fashion recommendations | Discovery tasks: merchant references must be eligible merchant ids/names; StyleChat recommendations are not discovery claims | Recommendation cues locate merchant names |
| Ownership-verification claims | Eligible merchant = fresh label fact (approved text) + fresh attribution + fresh product, on an ownership verb with `eligible` inventory, re-checked at validation time. Labels in the result are rendered from `fact.value` | Clause-scoped, normalized detection of where prose asserts ownership; binding decides |
| Company policy claims | Structured `policy_reference` must be one of the task's `policyRefs` | Commitments/guarantees/refunds rejected |
| Statements about executed actions | A structured `action_state` claim must quote an `application_state` fact exactly (Option B assembles none); a model statement is never an execution record | Completed-action and capability-offer wording rejected (clause-scoped, ':'-aware) |

Regex is never the authorizing control: a phrase match only marks a claim; accepting it requires a binding to an eligible record, and anything that cannot be bound fails closed.

### Ownership-claim enforcement (Addendum 01 §4)

1. **Server-authoritative label** — rendered by the server for each eligible merchant the response references (structured `merchant_reference`/`ownership_label`, or bound prose). The model's own label text, if any, must be byte-identical (raw text, case-sensitive; homoglyph, zero-width and width variants are alterations — `modelLabelExactMatch` is recorded).
2. **Unsupported merchant-specific assertion** — rejected when any merchant other than an eligible one appears in an asserting sentence (registry names and unknown Title-Case names), when a coordinated/plural claim has any non-eligible subject, when an elliptical continuation ("So is X", "X is as well") names no eligible merchant, when the claim is negated for a named merchant, when ownership is attached to a product, or when the claim cannot be bound at all.
3. **Neutral question / general education** — accepted when non-assertive (neutral question; "can't confirm whether…" in the same clause) or when it names no merchant, is not framed as a listing and uses no example cue. Tag questions ("…, right?") and rhetorical questions assert.

### Zero-eligible behaviour (Addendum 01 §5)

`inventory.status: "zero_eligible"` is used as-is (no competing flag). The discovery empty state is **always** rendered from frozen copy (`zero_eligible`), whatever the model said; substitutions are rejected on discovery tasks; no label can attach. Ordinary StyleChat recommendations are **not** blocked (`out-13` vs `out-14`, and the dedicated test).

### Deterministic fallback system

| Fallback reason | Raised by | Copy key |
|---|---|---|
| `ownership_integrity_failure` | `unsupported_ownership_claim`, `fabricated_merchant_recommendation` | per pinned `selectFallback` (`ownership_integrity_failure`; `zero_eligible` / `generic_integrity_failure` for fabricated merchants) |
| `missing_authoritative_information` | `verified_fact_mismatch` (unsupported or contradicted price/availability, observation presented as verified) | `generic_integrity_failure` |
| `invalid_response_contract` | Stage 1 shape violations | `generic_integrity_failure` |
| `provider_or_validation_failure` | provider failure, empty or truncated output, task rejected at Stage 0, invalid origin, validator fault | `generic_integrity_failure` |
| `neutral_empty_inventory` | discovery empty state (not a failure) | `zero_eligible` |
| `action_or_commitment_claim` | `unexecuted_action_claim`, `unauthorized_company_commitment` | `generic_integrity_failure` |
| `privacy_exposure` | `sensitive_data_exposure` (incl. internal reference ids) | `generic_integrity_failure` |

No reason ever triggers another model call. Missing/unknown copy keys and malformed maps degrade to the pinned strings (tested).

### Generation paths covered (G6)

| Path (`stylechat-generate/index.ts`) | Origin |
|---|---|
| initial via `callGeminiWithOptionalRetry` | `primary_initial` |
| provider retry inside it | `primary_provider_retry` |
| completeness retry | `completeness_retry` |
| retry text kept as best effort | `best_effort_after_retry` |
| initial text kept after retry failure | `best_effort_initial_after_retry_failure` |
| legacy `buildStyleChatFallback()` | none (deterministic; passes the validator in every context) |
| future provider fallback (F1: not wired) | `fallback_model` — same task, same validation, identical verdicts (tested) |

CI-03 adds no model call, retry or fallback routing. The validator must run on the text that will actually be displayed (after the existing sanitizer; see D-1 below).

### Reason trace (`ci03-reason-trace-v1`)

Closed key set: versions (validator, output/task contract, charter, copy set), correlation id, origin, task verb, mode, register, surface, inventory status, eligible count, eligible merchants at validation, zero-eligible flag, label refs (`labelFactId` + opaque `sourceRecordRef` only), labels rendered, whether the model emitted label text and whether it matched exactly, validator stage/result, failure and detail codes, fallback reason, copy key, `regenerate: false`. A canary test proves it never contains output text, merchant names, prices, contact data or label text.

## 2. Targeted reconciliation (Addendum 01 §2)

**R1 — Fixture corpus integrity.** Original-74 digest `ddc5aaec…7d90dd` recomputed independently (Node `crypto`, separate from the Deno test) on the CI-02 head and on the first CI-01 commit `3eb5355e`: identical; 74 original cases unchanged. The corpus held 186 cases (74 + 112 hardening) and now holds **215** (74 + 141; CI-03 added 5 `task_contract` and 24 `output_validation` cases, all `hardening: true`, `package: "ci03"`). The only byte change to existing lines is the separator comma after the previous last case. New full-corpus pin: `84387f7ba0951004bb88389ae322b332bf4789bf73800e570935dff63ef67198` (215 cases, inputs and expectations), held alongside the unchanged original-74 pin. Category floors only rise: task_contract 107, mode_selection 8, ownership_integrity 28, action_and_commitment 7, sensitive_data 4, option_c_proposal 6, prompt_isolation 4, oracle_limits 11, fallback_policy 9, output_validation 24.

**R2 — Discovery catalog factual authority.** Source contract verified in `black-owned-discovery/engine.ts`: a discovery product's `price` is `formatOfferPrice(row.price_amount, row.currency)` and `currency` is `row.currency` from the **same catalog row** that yields `productId`, `brandId` and `inventoryVerifiedAt = row.synced_at`; the engine already refuses rows with expired verification/eligibility, non-`in_stock` availability, or `synced_at` older than 24 h. The assembler then requires an ISO-4217 currency, a safe price string, and a 6 h price window, and emits price/currency/product_ref with the same `sourceRecordRef` (`disc_<productId>`). Allowing `black_owned_discovery` as a price source is therefore sound, and `tc-46` was retargeted to `entitlement` for that reason. **Defect found:** the strict contract did not enforce the invariant its own comment states ("either owns its own product's price"). Repaired — see §3. The list of authoritative systems was **not** expanded.

**R3 — Carried findings.** F1 (`fallbackModelName` configured but not invoked) — unchanged; tripwires in `boundaries.test.ts` and `responseFinalizer.test.ts`. F2 (332 ms short-circuit) — still unconfirmed, no new evidence. D-1 (`stripUnsafeModelOutput` corrupts ordinary verbs, issue #716) — unchanged; frozen copy is sanitizer-stable (existing test). No provider fallback or sanitizer change is made here.

**R4 — Numeric acceptance gates (test thresholds, not claims about model behaviour).**

| Gate | Threshold | Result on this branch |
|---|---|---|
| Ownership-integrity acceptance cases | 100% | **28/28** `own-*` agree with the established verdict under the production validator (real assembled tasks) |
| Unsupported merchant-specific ownership assertions accepted | 0 | **0**: 28 `own-*`, 11/11 `lim-*` at their *required* verdict (the oracle fails 10 of 11 by design), 637 generated variants × 3 contexts = 1,911 checks |
| Fabricated eligible merchant substitutions accepted | 0 | **0** in the corpus (`own-08/21/24/25/28`, `lim-09`, `out-14`) |
| Unauthorized action-completion claims accepted | 0 | **0** (`act-01…03`, `out-11`, `out-12`, dedicated negation-scope tests) |
| Contract-validation bypasses in required tests | 0 | **0**: all 107 `task_contract` cases and 24 `output_validation` cases exact |
| Generation/retry paths under the validation contract | all | **5/5** model paths mapped + legacy copy; call-site count pinned at 3 |
| Original-74 digest | unchanged | **unchanged** |
| Flag-OFF compatibility | unchanged | **no runtime source modified**; baseline tripwires pass |
| G8 CPU (assembly + validation) | p95 ≤ 20 ms / 1,000 runs | p95 ≈ 1.6–2.5 ms (local, varies per run) |
| G12 frozen copy | 3/3 | 3/3 (unchanged) and all pass the production validator |

**R5 — Approval register.** Implementation tests are not approvals.

| # | Item | Status | Accountable reviewer | Gate affected |
|---|---|---|---|---|
| 1 | C1 numerical thresholds (G1–G12) | PROPOSED | Product + Trust | CI-04 release; staging evaluation |
| 2 | Public verification badge / label wording ("From a verified Black-owned business") | PROPOSED (pending Product/Legal) | Product + Legal | Any customer-visible label (CI-04+) |
| 3 | Frozen fallback copy (`ci03-frozen-copy-v1-proposed`) | PROPOSED | Product + Legal + Trust | CI-04 release |
| 4 | Corporate/Elise composition and task-mode mapping | PROPOSED | Product + Architecture review | CI-04 wiring |
| 5 | Corporate charter governance and wording | PROPOSED | Product + Trust (charter owner to be named) | Any runtime attachment of the charter |
| 6 | Quality rubric and billed Gemini evaluation budget | BLOCKED (no rubric, budget = 0) | Product | G10 quality gate; any paid evaluation |
| 7 | Output-token limits by register | PROPOSED (design targets; provider cap unchanged) | Product + Engineering | CI-04 |
| 8 | Closed task-verb, mode and register taxonomies | PROPOSED (implemented as closed tables) | Product + Trust | CI-04; any taxonomy change is a versioned review |

Unresolved wording does not block offline development; it blocks release.

## 3. Repair log (CI-01/CI-02 code)

| Id | Class / severity | Files | Cause | Fix | Regression evidence |
|---|---|---|---|---|---|
| CI03-REP-01 (R2) | **B / S2** contract correctness | `contracts.ts`, `contractHardening.test.ts`, fixtures `tc-ci03-r2-01…05` | CI-02 allowed two systems to price a product but never bound a price to its own record: a discovery amount with a canonical currency, a canonical amount with a discovery currency, a discovery price on a catalog-sourced product, and a discovery price cited from a different row were all **accepted** (reproduced on `0fd392ca`) | Price/currency of one product must share a source system; a discovery-sourced pair must sit on a discovery-sourced product and cite the same record. Reuses the existing `fact_kind_source_mismatch` code (no enum change). Assembler output already satisfies it. | `R2 repair: …` test and five fixtures fail before / pass after. The CI-02 hardening test "every source system is rejected for every kind…" previously moved a lone price fact; it now moves the price/currency **pair**, so each table cell is still isolated and the lone move is pinned separately — a tightening, no expectation weakened. |

One CI-01/CI-02 defect confirmed (below the three-defect pattern threshold). Pre-existing `no-explicit-any` lint findings in CI-01/02 test/support files are S4 and left as-is.

Defects found and fixed in the **new** CI-03 code during development (not CI-01/02 repairs, listed for transparency): money regex missed bare `$120`/`€148`; leetspeak folding erased `@` in e-mail addresses and digits in `CA$148.00`; `n't` negation missed by `\b`; Title-Case runs hid an unknown merchant next to an eligible one; plural coordination bound only one subject; `:` let a "can't" exempt a completed-action claim; "African … diaspora" paraphrase and "…, right?" tag questions were not claims; a sentence-initial verb next to "Black" was read as a merchant name. Each has a test.

## 4. Mutation evidence (Addendum 01 §6)

Controlled, scripted: apply one edit → run the package suite → record failing tests → restore → re-verify green. Final run on the committed code:

| Category | Mutation | Result | First named failing test(s) |
|---|---|---|---|
| 1 Label altered/transferred | M1a structured byte-exact compare removed | killed | `out-02-structured-label-paraphrased`; structured label test |
| | M1b label for non-eligible merchant borrows an eligible record | killed | `out-03-structured-label-transferred` |
| | M1c prose byte-exact check removed | killed | `out-04-label-homoglyph-in-prose`; G1 |
| 2 Expired/stale accepted | M2a contract `stale_fact` removed | killed | `tc-12`, `tc-60`, `tc-61`; "verification that EXPIRES between assembly and validation" |
| | M2b validator-local freshness re-check disabled | survived — **equivalent** | Stage 0 re-validates every fact against the same `now`, so this check is unreachable defence in depth |
| | M2c assembler `verifiedUntil <= now` drop removed | survived — **equivalent** | the next check drops the same products: `generatedAt + labelTtl ≤ verifiedUntil ≤ now` |
| 3 Attribution bypassed | M3a structured product→merchant check removed | killed | `out-05-attribution-transfer-between-merchants` |
| | M3b non-eligible merchant in asserting sentence ignored | killed | prose label/binding tests |
| | M3c contract product-owner ambiguity removed | killed | `tc-68-price-bound-to-other-merchant` |
| 4 Zero-eligible populated | M4a empty state not forced to frozen copy | killed | `out-14`, `out-15`, finalizer empty-state test |
| | M4b substitution check removed | killed | `out-14`; zero-eligible distinction test |
| | M4c contract `zero_eligible_with_merchant_facts` removed | killed | `tc-14`, `tc-95` |
| 5 Unexecuted action as done | M5a clause-level completed-action check removed | killed | action prose test (negation-scope cases added in CI-03) |
| | M5b `action_state` accepted without record | killed | `out-11-action-state-without-record` |
| | M5c capability offers accepted | killed | `out-12-capability-offer` |
| 6 Contract/capability bypass | M6a closed candidate shape relaxed | killed | `out-08-transport-shaped-response`; Stage 1 test |
| | M6b Stage 0 task re-validation bypassed | killed | three Stage 0 tests |
| | M6c `executable_capability_present` removed | killed | `tc-04`, `tc-83`, `tc-84`; Option B boundary test |
| | M6d validator fault fails open | killed | finalizer fail-closed test |

17/19 killed by named tests; 2 equivalent mutants with the reasoning above; every category has at least one kill. Suite restored green after each mutation.

## 5. Residual limits (honest)

* **Free-text merchant names in lower case** are recognised only via the server registry. On an *eligible* discovery task, "i recommend maison obscura for this coat" (an unknown, lower-case, non-registry name) is accepted. Mitigations: the shelf itself is server-rendered from eligible records; on zero-eligible discovery the response is always frozen copy. CI-04 should supply the full server merchant-name registry and consider restricting discovery prose to eligible-merchant references.
* **Paraphrase and language coverage is lexicon-bound** (English plus the Spanish/French/German/Portuguese forms in the generator). The generator is authored by the validator's author: passing it is necessary, not sufficient. The structural controls (record binding, server labels, frozen empty state) are the real defence; the screening tells the validator where to look.
* **Conservative false rejections** exist (e.g. "The founder of this look trend wore black head to toe" → deterministic copy). They fail safe but cost quality; G10 needs a measured rubric before release.
* **StyleChat general prose** carries no commerce facts, so budget-style prices there are not validated, and policy prose is only checked for commitments.
* **Ordering with the legacy sanitizer**: CI-04 must validate the text that will be displayed (after `stripUnsafeModelOutput`), or fix D-1 first under its own owner.

## 6. CI and release blockers

* PR #717's push-triggered "Security - Code and Dependencies" run `41733882743` failed twice at Trivy installation before scanning; the PR-triggered scan passed; Security promotion gates fail on the missing push scan. This is the existing CI/Security-owned operational issue. If the CI-03 PR shows the same failure it is that issue, not a new one. Trivy is not disabled and no gate is weakened; the PR is not reported green while it persists.
* Product/Trust/Legal approvals in R5 remain open. No staging or production readiness is claimed.

## 7. Dependencies before CI-04

1. Approval of R5 items 2, 3, 4 and 7 (wording, copy, composition, token limits).
2. A server-side adapter from the live discovery response to `TrustedDiscoveryResult` and a server-sourced merchant-name registry.
3. A decision on validator placement relative to `stripUnsafeModelOutput` (D-1 / #716).
4. Resolution of the Trivy push-scan blocker for the stacked PRs.
5. An approved quality rubric and evaluation budget before any billed run (G10).
