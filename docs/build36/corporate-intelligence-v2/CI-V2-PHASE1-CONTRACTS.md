# CI-V2 Phase 1 — Contracts, Validation, Ownership Integrity, Gates

| Field | Value |
|---|---|
| Work package | CI-01 |
| Status | **DRAFT for the Phase 1 architecture gate.** No runtime integration exists or is authorized. |
| Machine-readable artifacts | `supabase/functions/_shared/corporateIntelligence/` — `contracts.ts`, `actionProposal.ts`, `fixtures/ci01-acceptance-fixtures.json` (186 cases), `testSupport/`, `acceptanceFixtures.test.ts`, `contractHardening.test.ts`, `boundaries.test.ts` |

## 1. `corporate-task-v1` (Task Brief contract)

Implemented as the TypeScript interface `CorporateTaskV1` plus the strict validator `validateCorporateTaskV1` (`contracts.ts`). Breaking changes require `corporate-task-v2`.

**Authority rule.** A `CorporateTaskV1` is produced only by the server-side assembler from trusted server records. The validator is a defence-in-depth check on that output. There is no client-supplied facts channel: the client request body is not an input to the assembler, and any client-shaped key (`clientVerifiedFacts`, `facts`, `trustedFacts` …) is an unknown field (`tc-82`, `contractHardening.test.ts`).

| Field | Rule (error code → negative tests) |
|---|---|
| `contractVersion` | Exactly `corporate-task-v1` (`bad_version` → `tc-02`). |
| `correlationId` | Opaque `[A-Za-z0-9_-]{8,80}`; an email or free text is rejected (`bad_correlation_id` → `tc-17`). |
| `taskVerb` | Closed set of seven, server-assigned; model/user text never selects a verb (`bad_task_verb` → `tc-22`). |
| `objectiveCode` | **Required.** A server template id that must belong to *that verb* in `TASK_VERB_POLICY` (`bad_objective_code` → `tc-23…26`: missing, non-string, another verb's code, free text). |
| `communicationMode`, `presentationRegister`, `surface` | Must equal the server table for the verb: one mode, a closed register set, a closed surface set (`mode_mismatch` → `tc-07`, `tc-09`, `tc-43`; `register_not_allowed` → `tc-08`, `tc-41`; `surface_not_allowed` → `tc-39`, `tc-42`, `tc-44`; `bad_surface` → `tc-40`). An exhaustive sweep (7 verbs × 5 modes × 5 registers × 4 surfaces × 7 objectives) asserts a combination is accepted **iff** the table allows it. |
| `brandPolicyVersion` | **Required** and must be on `SUPPORTED_BRAND_POLICY_VERSIONS` (`unsupported_brand_policy_version` → `tc-27…29`: missing, non-string, unknown/future version). |
| `locale`, `stylist.displayName` | BCP-47-shaped locale; 2–24 chars, no control characters (`bad_locale`, `bad_stylist_name` → `contractHardening.test.ts`). |
| `policyRefs` | Closed allowlist of policy *pointers* (never policy text), unique, ≤ 6 (`bad_policy_ref` → `tc-30…32`). Ownership facts require `policy:ownership-label-v1` (`missing_required_policy_ref` → `tc-33`). |
| `visualObservations[]` | Strict shape `{label, confidence ∈ low/medium/high, tier: 'untrusted_text'}`; ≤ 8; blank or control-character labels rejected; an observation can never carry a trusted tier (`bad_visual_observation` → `tc-34…38`). |
| `verifiedFacts[]` | Each: `factId` (unique), `kind`, `sourceSystem`, opaque `sourceRecordRef`, `merchantRef`/`productRef` per kind, `observedAt`, finite positive `ttlSeconds`, display `value`, `immutable: true`; ≤ 40; extra keys rejected (`unknown_nested_field` → `tc-76`). Details in the next two rows. |
| fact **source ↔ kind** | `FACT_KIND_SOURCES`: ownership label and merchant attribution only from `black_owned_discovery`; price/currency from `commerce_canonical` (scan offers) or `black_owned_discovery` (the discovery catalog row that produced that product); availability from `catalog`/`black_owned_discovery`; product ref from `black_owned_discovery`/`catalog`; action state only from `application_state`. Unknown systems (e.g. `model_output`) rejected (`untrusted_fact_source` → `tc-13`, `tc-50`; `fact_kind_source_mismatch` → `tc-46…49`, e.g. a price from `entitlement`). A test crosses every kind with every source. |
| fact **freshness** | `observedAt` must parse; not later than the assembly clock + 60 s (`future_dated_fact` → `tc-52`); `observedAt + ttl` must be strictly after now — a fact expiring *at* the instant is stale (`stale_fact` → `tc-12`, `tc-60`, `tc-61`; boundary-fresh accepted `tc-63`); TTL must be finite, positive, numeric (`bad_ttl`+`bad_fact` → `tc-53…57`, including `NaN`/`Infinity`) and ≤ a per-kind ceiling: label/attribution/product 24 h, price/currency/availability 6 h, action state 15 min (`excessive_ttl` → `tc-58`, `tc-59`). |
| fact **merchant binding** | Merchant-scoped kinds (label, attribution) carry `merchantRef` and **no** `productRef`; product-scoped kinds (product, price, currency, availability) carry both (`bad_merchant_reference` → `tc-64…67`). Every labelled merchant needs exactly one attribution and ≥ 1 product; a product belongs to one merchant; no duplicate label/attribution per merchant; a price needs a currency (`unbound_merchant_reference` → `tc-69`, `tc-71`, `tc-72`, `tc-74`; `ambiguous_merchant_reference` → `tc-68`, `tc-70`; `price_without_currency` → `tc-73`). |
| ownership label text | Must equal an approved server-rendered label (`unapproved_ownership_label` → `tc-92`); label facts are not allowed on StyleChat/privacy verbs (`ownership_fact_not_allowed_for_task` → `tc-93`). |
| `forbiddenActions`, `immutableFields` | Forbidden set must include purchase, save, account edit, inventory change, tool execution, ownership verification, completed-action claims, policy commitments; immutable set must include ownership label, merchant attribution, price, currency, availability (`tc-18`, `tc-19`). |
| `tokenBudget` | Integers; `staticMax ≤ 1,200`, `dynamicMax ≤ 1,600`, sum ≤ 2,800 (design targets — §8); `outputMax > 0`; extra keys rejected (`tc-16`, `tc-78`). |
| `allowedReadCapabilities` | Closed read-only set, must be an array (`tc-20`, `tc-88`, `tc-89`). |
| `inventory` | `not_applicable` \| `eligible` \| `zero_eligible` with a non-negative integer count. `zero_eligible` ⇒ count 0 and no ownership/merchant facts (`zero_eligible_with_merchant_facts` → `tc-14`, `tc-95`); `not_applicable` ⇒ count 0 and no ownership facts (`ownership_fact_on_non_discovery_inventory` → `tc-91`; `bad_inventory` → `tc-94`, `tc-96`, `tc-97`); `eligible` ⇒ ≥ 1 valid label fact **and** count equals the number of distinct eligible products (`eligible_without_ownership_fact` → `tc-15`, `tc-21`; `eligible_count_mismatch` → `tc-72`, `tc-74`, `tc-90`). |
| `audit` | `{assembledAt, assemblerVersion, factCount}`: timestamp within 5 min of the validation clock, version token, `factCount` equals the fact list (`bad_audit` → `tc-100…102`; `audit_fact_count_mismatch` → `tc-99`). Contains no personal data. |
| `actionContractRef` | **Must be `null`** in Option B; an omitted key is not `null` (`tc-06`, `tc-87`). |
| `capabilities.proposable` / `.executable` | **Type `readonly never[]` and runtime-empty.** Non-empty literal fails `deno check` (an `@ts-expect-error` test pins this) and validation; objects, `null`, strings, a missing block and extra capability classes are all rejected (`tc-04`, `tc-05`, `tc-80`, `tc-83…86`). |
| unknown keys | Rejected at the top level (`unknown_field` → `tc-03`, `tc-82`) and inside every security-sensitive object — fact, stylist, tokenBudget, inventory, capabilities, audit, observation (`unknown_nested_field` → `tc-36`, `tc-76…81`). JSON-parsed `__proto__` keys are treated as unknown fields, never as capabilities (`contractHardening.test.ts`). |

`eligible` in `inventory` means *verified-ownership discovery inventory*; other surfaces use `not_applicable`. The validator never mutates its input and works on a deeply frozen object (tested). Every error code the validator can emit is asserted to have at least one negative test (a source-scanning test fails when a new code is added without one).

## 2. Output contract (Stage 1)

* **No breaking change to existing clients.** StyleChat keeps returning plain text in `message.content` and the existing additive fields. The model is not asked to emit a new JSON envelope.
* Where authoritative structure is needed (ownership badge, price, availability, merchant name), the **server renders it** into the existing or an additive optional response field; the model's text may reference it but is not the carrier.
* The existing `<content>/<why_this_works>/<actions>` handling, 8,000-char validation ceiling and ≤2 allow-listed, tap-only actions are unchanged.
* Any additive v2 response field is optional, versioned, and ignored by older clients; its absence must never be rendered as a failure.

## 3. Enforcement sequence (fail closed)

| Stage | What | Failure behavior |
|---|---|---|
| 0 Server authority & eligibility | JWT/actor, account lifecycle, Gemini consent receipt + withdrawal, entitlement, allowed capabilities, source integrity, merchant/product eligibility (re-use of the discovery engine result), freshness of facts — **before** any context is assembled | Existing gate responses; v2 ineligible → legacy path |
| 1 Output contract | Plain-text shape and existing parser | Existing behavior |
| 2 Verified-fact integrity | Any critical price/currency/availability/label/merchant/action-state in output is compared to the Task Brief facts; preferably replaced by server-rendered fields | Deterministic copy |
| 3 Claims & register | Unsupported ownership, fabricated completed action, unauthorized company commitment, sensitive-data exposure, critical contract violations; narrow style checks only | Deterministic copy |
| 4 Safe fallback | Frozen approved copy; **no repair generation** for ownership-integrity or authorization failures | Never another model call |

Operational provider errors keep their current handling (same-model completeness retry, optional provider retry, deterministic fallback). Any future model fallback output passes Stages 1–4 identically (inventory F1 tripwire).

**Deterministic failure → fallback mapping** (`selectFallback` in `contracts.ts`, fixtures `fb-01…09`, `boundaries.test.ts`). The mapping is a pure function of the failure code and the server inventory status; it never selects another generation (`regenerate` is pinned to `false` for every code × status):

| Failure code (stage) | Inventory status | Approved copy key |
|---|---|---|
| `unsupported_ownership_claim` (3) | any | `ownership_integrity_failure` |
| `fabricated_merchant_recommendation` (3) | `zero_eligible` | `zero_eligible` |
| `fabricated_merchant_recommendation` (3) | other | `generic_integrity_failure` |
| `verified_fact_mismatch` (2), `unexecuted_action_claim`, `unauthorized_company_commitment`, `sensitive_data_exposure` (3), `output_contract_violation` (1) | any | `generic_integrity_failure` |

The reference oracle (`testSupport/referenceOracle.ts`) is **not** the production validator. It exists to make the fixtures executable now; CI-03 builds the real library against the same corpus and may not edit an expected result to pass. Its limits are documented, pinned and adversarially tested in §13: **text matching alone can never be the ownership control** — the production validator must use authoritative merchant IDs, eligibility records and server-rendered labels.

## 4. Ownership-integrity contract (Black-owned)

Rule: **merchant identity + verified ownership record + fresh purchasable product = eligible discovery result.** Reuse the discovery service; do not rebuild it, create merchants/evidence/inventory, or add migrations.

| Control | Enforcement point |
|---|---|
| Only active, unexpired verification authorizes a label | Discovery engine (`verified_until > now`, `expires_at > now`, `in_stock`) — pinned by `boundaries.test.ts` |
| Revoked/expired/unverified merchants never enter the eligible set | Server; the model sees only the surviving set |
| Label text is server metadata, immutable | `ownership_label` fact with `immutable: true`; the validator requires it for `eligible` |
| Model cannot invent/infer/alter a claim | Stage 3 ownership check; fixtures `own-03…own-16` |
| Zero eligible ⇒ no speculative substitutes | `inventory.zero_eligible` forbids merchant facts (`tc-14`); Stage 3 `zero_eligible_substitution` (`own-08`) |
| Raw evidence/private owner info never in a prompt | Minimization rules (charter §5); sensitive-data fixtures `priv-*` |
| Label bound to the merchant, not the product | `ownership_as_product_attribute` (`own-15`); misattribution (`own-14`) |
| Unsupported positive claim in generated text ⇒ reject and use approved deterministic copy; never re-generate | Stage 3/4 |

Required scenario coverage (all present, ids in `acceptanceFixtures.test.ts`): verified+eligible, unverified, expired, revoked, stale product, zero eligible, prompt injection via merchant copy, customer-demanded false assertion, wrong merchant→product attribution, fallback-model unsupported claim. **Release gate: zero unsupported ownership claims in the acceptance corpus.**

The phrase *"From a verified Black-owned business"* is **pending Product/Legal approval**. Prefer server-rendered badges to model-written label text.

## 5. Provenance and minimization

See charter §5. The tier-to-`AIContentTrust` mapping is encoded and tested (`boundaries.test.ts`); untrusted-text isolation is proven against the **existing** `aiSecurity` envelope (`iso-01…iso-05`: forged closing tags, forged trusted sections, instruction override, forged metadata, role spoofing).

## 6. Diagnostics, retention and access

Record content-minimized metadata only: charter and prompt versions, task verb, mode, register, surface, provider/model route, validation stage and result code, fallback reason, hashed/opaque correlation ids and safe authoritative record-reference ids, aggregate tokens/latency/cost, and the kill-switch state. Never record raw prompts, user messages, conversations, hidden reasoning, private documents, account identifiers or ownership evidence. Reuse `emitEliseTelemetry`'s metadata-only pattern and its actor hashing; no new table.

| Item | Proposed policy (needs Trust approval) |
|---|---|
| Retention | Operational logs: platform default log retention, no export to a separate store; aggregates only for dashboards, retained ≤ 90 days |
| Access | Backend operators with existing project access; no customer-support or merchant access; no copying into tickets, PRs or public docs |
| Public-repo rule | The repository is public: documents and PR bodies carry ids, locations and test evidence only — never Production state |

## 7. Frozen deterministic copy (PROPOSED — pending Product/Legal)

Wording specified by Management Checkpoint 1. **Badge/label wording stays pending Product/Legal.**

| Key | Copy |
|---|---|
| `zero_eligible` | No matches from verified Black-owned businesses are available for this item right now. |
| `ownership_integrity_failure` | I can't confirm that business's ownership from its name or product images. K Scan only labels businesses that meet its verification requirements. |
| `generic_integrity_failure` | I wasn't able to complete that response. Please try again. |

Design rules, each enforced by a test (`boundaries.test.ts`): no implication that verified results exist when none are eligible (the zero-eligible copy is a negative statement); no unsupported buttons, filters or next steps (no tap/click/filter/browse/adjust/explore/"see more"/"similar"/"alternatives"/"below"/"here are"; the only instruction anywhere is the generic retry); the ownership-integrity copy neither asserts nor denies ownership of any business; exact strings are pinned so a wording change needs a reviewed diff. The earlier draft's `recovery_notice` and its "Try a different style or color" / "Here are the matches I can confirm" copy were removed because they promised controls and results the app cannot guarantee. The copy is unchanged by the legacy `stripUnsafeModelOutput` (defect D-1, issue [#716](https://github.com/kscanaiapp/kscan-app/issues/716)) and passes the ownership oracle in both zero-eligible and eligible contexts.

## 8. Acceptance gates, measurement and billing

**C1 — measurable exit gates.** Thresholds below are *proposals for Product/Trust approval*, not results. "Measured now" means a number produced offline in this branch; everything else says exactly what is still needed. No gate is waived by this document.

| # | Gate | Numeric threshold | Measurement method | Status at this commit |
|---|---|---|---|---|
| G1 | Unsupported ownership claims accepted by the **production** validator | **0** false accepts over every `reject`-required case in the corpus (28 `own-*` + 11 `lim-*`) **and** over ≥ 500 generated adversarial variants (paraphrase, language, homoglyph, zero-width, hedge/negation) | Run the CI-03 validator over the corpus and the generated set; count cases whose required verdict is reject and whose result is accept | Reference oracle: 28/28 `own-*` as expected. It is *not* the production validator and by design fails 10 of 11 `lim-*` cases (§13). **Not met until CI-03.** |
| G2 | Task-contract strictness | **100%** of `task_contract` fixtures return exactly the expected error set; every emitted error code has ≥ 1 negative test | `acceptanceFixtures.test.ts`, `contractHardening.test.ts` (source-scan coverage test) | **Measured now: 102/102** fixtures; coverage test passes |
| G3 | Deterministic mode/task selection | **100%** of selection fixtures; **0** selections changed by customer tone or a model-requested mode | `ms-*` fixtures; CI-02 property tests over a generated grid of trusted states | Reference selector 10/10; CI-02 selector is in review on its own branch (not a gate result until merged) |
| G4 | Authorization / prompt-isolation violations | **0** | `iso-01…05` against the real `aiSecurity` envelope; no client-facts channel (`tc-82`) | **Measured now: 5/5**, 0 violations |
| G5 | Flag-OFF instruction payload differences | **0 bytes** across a golden corpus of ≥ 20 recorded-shape synthetic inputs (attachment / no attachment, Elise on / off, memory on / off) | SHA-256 of the assembled system text vs a golden captured at baseline `9047ce43` | Partially measured: 5 constituent hashes + `appendEliseBrandVoice(base,false)` identity pinned. Full-assembly golden is CI-04 |
| G6 | Generation paths lacking integrity validation | **0** of the `callGemini` call sites | Call-site inventory test (3 sites, 2 `buildGeminiBody` sites, no fallback symbols in `index.ts`) | **Measured now: 0**; tripwire active |
| G7 | Token budget | static ≤ **1,200**, dynamic ≤ **1,600**, total ≤ **2,800** added tokens | Offline `ceil(chars/4)` estimate (an upper-bound heuristic) on the draft contract and assembler fixtures; the provider tokenizer is not called under the zero-billing budget | Draft Employee Contract: **693** estimated tokens (limit 1,200). Dynamic/total need CI-02 assembler fixtures |
| G8 | Added latency | assembly + validation CPU p95 ≤ **20 ms** over ≥ 1,000 offline runs; end-to-end added p95 ≤ **300 ms** | CPU: offline benchmark of the pure functions. End-to-end: paired live runs | CPU: not yet measured. End-to-end: **not measurable without a paid run** |
| G9 | Cost | average eligible-conversation cost ≤ **+25%** vs Build 35 | Offline token delta × published rate card | Not yet computed; needs G7 numbers and an approved rate card |
| G10 | Quality non-inferiority vs Build 35 | mean paired rubric delta ≥ **−0.10** on a 5-point rubric, n ≥ **100** prompts | Approved rubric + paired replay | **Not measured** — needs an approved rubric and a paid run |
| G11 | Rollback / kill switch | flag OFF ⇒ G5 passes; kill-switch flip takes effect on the next request | CI-06 flag/rollback tests | Contract only |
| G12 | Deterministic fallback copy compliance | **3/3** copy keys: sanitizer-stable, oracle-accepted, no control/next-step wording, exact strings pinned | `boundaries.test.ts` | **Measured now: 3/3** |

Measurement owner for G1–G6 and G12 is CI automation (the existing governed `_shared` runner). G7–G9 are produced by CI-06 scripts. G10 needs a human-approved rubric.

**Billed evaluation budget: zero.** A later run needs an approved call count, token ceiling, spending ceiling, test actor, consent evidence and environment, enforced by the harness (not by prompt text). Context caching is deferred until the baseline shows stable-prefix reuse; actor-specific consent, entitlement, private context and volatile inventory are never cached across requests.

## 9. Work packages, dependencies, proposed files

| Package | Depends on | Proposed exact files |
|---|---|---|
| CI-01 (this PR) | — | docs above; `_shared/corporateIntelligence/{contracts,actionProposal}.ts`, fixtures, test support, three test files |
| CI-02 | Checkpoint 1 engineering authorization (offline, transport-independent; runtime release still gated) | `…/modeSelector.ts`, `…/contextAssembler.ts` (+ tests; reuses `aiSecurity` envelope) |
| CI-03 | CI-02 contracts | `…/outputValidation.ts`, `…/frozenCopy.ts`, harness under `…/harness/`; fixtures extended, never weakened |
| CI-04 | CI-03 | `stylechat-generate/eliseConfig.ts` (one default-OFF flag), `…/index.ts` (pure assembly extraction + three insertion points), manifest/parity updates |
| CI-05 | CI-01 | Option C doc + `actionProposal.ts` (offline only); no executor |
| CI-06 | CI-04 | telemetry fields, measurement scripts, flag/rollback tests |

No new database schema and no general agent framework.

## 10. C1–C6 resolution matrix

The C1–C6 text was supplied by Management Checkpoint 1; the earlier "inferred R1–R6" mapping is retired. "Engineering status" is what this branch can show; "Remaining approval" is what only a human can grant. Engineering development is authorized; **Product/Trust review of the final charter, public verification wording and runtime release is not waived.**

| # | Requirement | Engineering status | Exact evidence | Remaining approval / open work |
|---|---|---|---|---|
| **C1** | Measurable numerical exit gates and measurement methods | **Resolved in draft** — 12 gates (G1–G12) with thresholds, methods and honest status (§8). Measured now: G2, G4, G6, G12, part of G5 and G7. Not measured: G8–G10 (paid run needed) | §8 table; `acceptanceFixtures.test.ts` (corpus gates, original-74 digest), `contractHardening.test.ts`, `boundaries.test.ts` | Product/Trust must approve the thresholds (they are proposals); an approved quality rubric and a paid-run budget for G10; billed budget remains **zero** |
| **C2** | Communication mode from trusted server state, not model output or customer tone | **Specified + reference-tested.** Mode is a pure function of server route, resolved advice intent, discovery status and a *grounded* error class; tone and model-requested mode are inputs the selector never reads. Production selector `modeSelector.ts` + assembler `contextAssembler.ts` land in CI-02 (draft PR, offline; see `CI-V2-CI02-CONTEXT-ASSEMBLER.md`) | `TASK_VERB_POLICY` (`contracts.ts`); `ms-01…10` incl. `ms-03` (hostile tone ignored), `ms-05` (ungrounded error rejected), `ms-10` (model-requested mode ignored); `tc-09` (empty catalog is not service recovery), `tc-41…44`, exhaustive sweep in `contractHardening.test.ts` | Product sign-off on the verb→mode table; selector is not wired to any function |
| **C3** | Enforceable output-validation stages and deterministic fallbacks | **Resolved in draft** — Stages 0–4 (§3), failure→copy mapping is a pure function with no repair generation, approved copy pinned and sanitizer-tested (§7). Production validator is CI-03 (not authorized) | `selectFallback`, `INTEGRITY_FAILURE_CODES`, `PROPOSED_FALLBACK_COPY` (`contracts.ts`); `fb-01…09`; copy tests in `boundaries.test.ts`; call-site tripwire (F1) | Trust approval of stages and copy; copy/badge wording pending Product/Legal; CI-03 must build the record-bound validator (oracle limits §13) |
| **C4** | One authoritative Corporate v2 / Elise v1 assembly path, explicit precedence, flag-OFF identity | **Resolved in draft** — v2 wraps Elise v1; precedence security/consent → Employee Contract → Task Brief → stylist expression → user content; flag default OFF (charter §3). Identity is pinned for the five legacy constituents and `appendEliseBrandVoice(base,false)` | Charter §3; golden hashes (`fixtures/legacy-baseline-golden.json`); `boundaries.test.ts` baseline tests; single assembly point (3 `callGemini`, 1 `appendEliseBrandVoice`) | Product approval of the composition rule; full-assembly flag-OFF golden is CI-04 |
| **C5** | Verified Black-owned merchant ownership as a first-class integrity invariant | **Resolved in draft** — eligible = merchant identity + verified record + fresh purchasable product; the model never classifies ownership; label is an immutable server fact bound to a merchant ID; labels are per-merchant, never per-product; zero eligible ⇒ no merchant facts or substitutes | §4; `contracts.ts` merchant/product binding, source↔kind table, freshness, count agreement (`tc-46…75`, `tc-90…98`); `own-01…28` (+ educational / question / fabricated cases); `lim-*` showing text matching is insufficient (§13); `boundaries.test.ts` discovery binding | Trust approval; label wording pending Product/Legal; production validator (CI-03) must be record-bound |
| **C6** | Complete versioned task contract: typed task verbs, forbidden actions, record freshness, immutable fields, audit/correlation, token limits | **Resolved in draft** — `corporate-task-v1` with all six elements, strict at every nested level (§1); 102 task-contract fixtures + 13 hardening tests | §1; `contracts.ts` (`TASK_VERBS`, `REQUIRED_FORBIDDEN_ACTIONS`, `FACT_MAX_TTL_SECONDS`, `REQUIRED_IMMUTABLE_FIELDS`, `audit`, `TOKEN_BUDGET_TARGETS`) | Product/Trust sign-off on the closed lists; any change is a `corporate-task-v2` |

**Option C compatibility.** No conflict found. `capabilities.proposable/executable` remain `readonly never[]`, `actionContractRef` must be `null`, `actionProposal.ts` is imported only by tests, and the hardening added a stricter reject path for every injection shape (objects, `null`, strings, missing block, extra capability classes, `__proto__`). Option C needs its own reviewed contract version.

## 11. Phase 1 gate checklist (for the human approvers)

Record approval of: (1) composition and precedence (C4), (2) charter and governance owner, (3) task/mode/register mapping (C2), (4) context and output contracts (C6, C3), (5) ownership-integrity enforcement (C5), (6) quantitative limits and cost ceilings (C1). Also needed: label/badge and fallback copy approval (Product/Legal), an independent review of the final charter and of public verification wording, and answers to the open decisions in the charter §7. Engineering work on CI-02 (pure, offline, no Gemini call, no write, no new authorization mechanism, no function import) proceeds under the Checkpoint 1 authorization; CI-03 and CI-04 remain gated.

## 12. Contract-hardening findings (Checkpoint 1, Task 2)

Review of the CI-01 strict validator found these gaps, all now closed with focused negative tests; the original 74 expectations are unchanged (digest pinned in `acceptanceFixtures.test.ts`) and the corpus-size requirement was deliberately raised from 50–75 to 120–220 (now 186):

1. `objectiveCode` and `brandPolicyVersion` were not validated (any value passed) → required, table-bound / allowlisted.
2. `policyRefs` and `visualObservations` were unchecked → closed allowlist, strict observation shape, always untrusted.
3. Surface was only checked for membership, not for the verb → per-verb surface set.
4. Fact source was only checked for ownership labels → full kind↔source table (price, availability, product, attribution, action state).
5. Freshness was a single `observedAt + ttl` check → future-dated, non-finite/negative/zero/string TTL, per-kind TTL ceilings and an exclusive expiry boundary.
6. Merchant references did not exist → merchant/product binding, ambiguity and orphan checks, price-needs-currency, eligible-count agreement.
7. Nested objects (fact, stylist, tokenBudget, inventory, audit, observation) accepted extra keys → strict at every level; JSON `__proto__` keys rejected.
8. Capability injection was only checked for non-empty arrays → objects, `null`, strings and missing blocks also fail closed.
9. Inventory/label combinations were partly checked → `not_applicable` ⇒ no ownership facts and count 0; `zero_eligible` ⇒ count 0; `eligible` ⇒ count equals eligible products.
10. No audit/correlation block → `audit` (assembly time, assembler version, fact count) added.

A fix to the validator's own hardening during review: an unknown task verb no longer produces a derived `ownership_fact_not_allowed_for_task` error on top of `bad_task_verb` (it would have changed the expectation of original case `tc-22`).

## 13. Ownership reference oracle: what it can and cannot do (Checkpoint 1, Task 3)

The oracle now distinguishes: a verified claim about an eligible named merchant (`own-01`, `own-02`, `own-26`) · an unsupported claim about a named merchant (`own-03…06`, `own-10`, `own-12…14`) · a neutral question about ownership (`own-17`, `own-18`) · general educational discussion of Black-owned businesses, accepted when it names no merchant and is not framed as a K Scan listing or recommendation (`own-19`; rejected when framed as a listing `own-20`, `own-22`, or when it names a merchant `own-21`) · an empty discovery result (`own-07`, `own-23`) · a fabricated merchant recommendation (`own-24`, `own-25`, `own-28`). The oracle cannot judge whether educational text is *factually correct*; that is a content-review matter.

Fixtures `lim-01…11` document regex-only failure modes (hedge words, "not only", paraphrase, leetspeak, zero-width characters, other languages, homoglyphs, negation scope, lowercase names, anaphora, plus one false positive). Each pins today's oracle verdict (so a change is a reviewed diff), the verdict a correct control must return, and the production control that replaces text matching: ownership appears only as the **server-rendered label attached to an eligible merchant ID**; recommendations reference merchant IDs the server returned; Unicode/confusable normalization precedes any residual text screening. Of the 11 limit cases, 10 are false accepts and 1 is a false reject for the oracle. The oracle therefore is, and must remain, test support only.

## 14. Routed findings

* **D-1** (pre-existing `stripUnsafeModelOutput` text corruption) → issue [#716](https://github.com/kscanaiapp/kscan-app/issues/716) for the Build 35 StyleChat owner, with minimal reproduction, source path and suggested priority P2. Not fixed from this branch. The v2 tests keep a sanitizer-stability tripwire on the pinned copy.
* **F1** — the configured fallback model is not invoked by `stylechat-generate` (verified: no `fallbackModelName`/`isDirectFallbackFailure` use in `index.ts`). Recorded as an observation; the call-site tripwire fails if call sites or fallback symbols change.
* **F2** — the 332 ms short-circuit is **unconfirmed**: not reproduced offline (the detector accepts complete short replies without a retry, which is consistent with the figure), and no raw log or request id was supplied. No claim of a defect is made.
