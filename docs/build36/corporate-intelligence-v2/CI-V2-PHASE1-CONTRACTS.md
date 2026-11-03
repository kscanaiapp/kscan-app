# CI-V2 Phase 1 — Contracts, Validation, Ownership Integrity, Gates

| Field | Value |
|---|---|
| Work package | CI-01 |
| Status | **DRAFT for the Phase 1 architecture gate.** No runtime integration exists or is authorized. |
| Machine-readable artifacts | `supabase/functions/_shared/corporateIntelligence/` — `contracts.ts`, `actionProposal.ts`, `fixtures/ci01-acceptance-fixtures.json`, `testSupport/`, `*.test.ts` |

## 1. `corporate-task-v1` (Task Brief contract)

Implemented as the TypeScript interface `CorporateTaskV1` plus the strict validator `validateCorporateTaskV1` (`contracts.ts`). Breaking changes require `corporate-task-v2`.

| Field | Rule |
|---|---|
| `contractVersion` | Exactly `corporate-task-v1`. |
| `correlationId` | Opaque `[A-Za-z0-9_-]{8,80}`; an email or free text is rejected (`tc-17`). |
| `taskVerb`, `objectiveCode` | Trusted, server-assigned. Verb ∈ closed set of seven. |
| `communicationMode`, `presentationRegister` | Must equal the server table for the verb (`tc-07`, `tc-08`, `tc-09`). |
| `surface`, `locale`, `brandPolicyVersion` | Closed surface set; BCP-47-shaped locale; charter version string. |
| `stylist.displayName` | 2–24 chars, no control characters (mirrors `stylistIdentity.ts`). |
| `verifiedFacts[]` | Each has `factId`, `kind`, `sourceSystem` (closed set), opaque `sourceRecordRef`, `observedAt`, `ttlSeconds`, display `value`, `immutable: true`; stale facts rejected (`tc-12`); `ownership_label` facts only from `black_owned_discovery` (`tc-13`). |
| `visualObservations[]` | Always tier `untrusted_text` with a confidence; never promoted to facts. |
| `policyRefs`, `forbiddenActions`, `immutableFields` | Forbidden set must include purchase, save, account edit, inventory change, tool execution, ownership verification, completed-action claims, policy commitments; immutable set must include ownership label, merchant attribution, price, currency, availability (`tc-18`, `tc-19`). |
| `tokenBudget` | `staticMax ≤ 1,200`, `dynamicMax ≤ 1,600`, sum ≤ 2,800 (design targets, not release limits — section 8) (`tc-16`). |
| `allowedReadCapabilities` | Closed read-only set; anything else rejected (`tc-20`). |
| `inventory` | `not_applicable` \| `eligible` \| `zero_eligible` with a count. `zero_eligible` forbids ownership/merchant facts (`tc-14`); `eligible` requires a valid ownership fact (`tc-15`, `tc-21`). |
| `actionContractRef` | **Must be `null`** in Option B (`tc-06`). |
| `capabilities.proposable` / `.executable` | **Type `readonly never[]` and runtime-empty.** A non-empty literal fails `deno check` (an `@ts-expect-error` test pins this) and fails validation (`tc-04`, `tc-05`). |
| unknown keys | Rejected at the top level and inside `capabilities` (`tc-03`). |

`eligible` in `inventory` means *verified-ownership discovery inventory*; other surfaces use `not_applicable`.

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

The reference oracle (`testSupport/referenceOracle.ts`) is **not** the production validator. It exists to make the fixtures executable now; CI-03 builds the real library against the same corpus and may not edit an expected result to pass.

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

| Key | Copy |
|---|---|
| `zero_eligible` | No verified Black-owned results match this item right now. Try a different style or color. |
| `ownership_integrity_failure` | I can only share ownership details that K Scan has verified. Here are the matches I can confirm. |
| `generic_integrity_failure` | I wasn't able to complete that response. Please try again in a moment. |
| `recovery_notice` | Something went wrong on our side. Please try again shortly. |

Tested to be unchanged by the legacy `stripUnsafeModelOutput` (defect D-1) and to pass the ownership oracle in both zero-eligible and eligible contexts.

## 8. Acceptance gates, measurement and billing

| Metric | Gate | CI-01 evidence |
|---|---|---|
| Authorization/security fixture violations | 0 | `iso-*`, `tc-*` pass |
| Unsupported ownership claims | 0 | 16 ownership fixtures pass on the oracle; production validator is CI-03 |
| Ownership-inference attacks succeeding | 0 | `own-10`, `own-12`, `own-13` |
| Unauthorized action-execution assertions | 0 | `act-01…03`, `ap-*` |
| Cross-account / cross-merchant leaks | 0 | `priv-*`, `own-14` (runtime proof is CI-04) |
| Critical structured-claim mismatches | 0 | Stage 2 designed; runtime proof CI-03/04 |
| Incorrect zero-eligible substitutions | 0 | `own-08`, `tc-14` |
| Fallback paths lacking integrity validation | 0 | Call-site inventory test (F1) |
| Flag-OFF instruction payload differences | 0 | Constituent hashes + `appendEliseBrandVoice` identity test; full-assembly golden is CI-04 |
| Task/mode selection fixture pass rate | ≥ 95% | 10/10 on the reference selector |
| Quality vs Build 35 | No material degradation | **Not measured** — needs an approved rubric and a paid run |
| Rollback / kill switch | Pass | Contract only; runtime proof CI-06 |

Design targets awaiting approval and a measured baseline: static ≤ 1,200 tokens (draft Employee Contract is within it), dynamic ≤ 1,600, total ≤ 2,800 added tokens; p95 added latency ≤ 300 ms; average eligible-conversation cost ≤ +25%. Measurement method (CI-06): replay a fixed set of recorded-shape synthetic prompts through the pure assembler to count tokens offline (no billing); latency/cost deltas require a paid run.

**Billed evaluation budget: zero.** A later run needs an approved call count, token ceiling, spending ceiling, test actor, consent evidence and environment, enforced by the harness (not by prompt text). Context caching is deferred until the baseline shows stable-prefix reuse; actor-specific consent, entitlement, private context and volatile inventory are never cached across requests.

## 9. Work packages, dependencies, proposed files

| Package | Depends on | Proposed exact files |
|---|---|---|
| CI-01 (this PR) | — | docs above; `_shared/corporateIntelligence/{contracts,actionProposal}.ts`, fixtures, test support, three test files |
| CI-02 | Gate approval | `…/modeSelector.ts`, `…/contextAssembler.ts` (+ tests; reuses `aiSecurity` envelope) |
| CI-03 | CI-02 contracts | `…/outputValidation.ts`, `…/frozenCopy.ts`, harness under `…/harness/`; fixtures extended, never weakened |
| CI-04 | CI-03 | `stylechat-generate/eliseConfig.ts` (one default-OFF flag), `…/index.ts` (pure assembly extraction + three insertion points), manifest/parity updates |
| CI-05 | CI-01 | Option C doc + `actionProposal.ts` (offline only); no executor |
| CI-06 | CI-04 | telemetry fields, measurement scripts, flag/rollback tests |

No new database schema and no general agent framework.

## 10. C1–C6 resolution matrix

**BLOCKED on input:** the six review findings (C1–C6) are cited by the directive but their text was not supplied, and no file in the repository, memory or issue tracker contains them (searched `docs/`, project memory, open PR/issue titles). Resolutions cannot honestly be labeled with the team's numbering. Below, the six architecture areas the directive itself raises are resolved or marked as approval blockers; **mapping them to C1–C6 needs the review text.**

| Area (directive-implied; mapping unconfirmed) | Resolution | State |
|---|---|---|
| R1 Corporate v2 vs Elise v1 composition | Wrap, with precedence and retained/superseded/conditional table (charter §3) | Resolved in draft → **approval blocker** (Product) |
| R2 Ownership enforcement | Server-metadata firewall, fail-closed Stages 0–4, no repair generation (§3–4) | Resolved in draft → approval blocker (Trust) |
| R3 Primary/fallback parity | One assembly point; call-site inventory tripwire; F1 recorded | Resolved (evidence) |
| R4 Option C boundary | Empty executor type, offline-only proposal schema, threat model | Resolved in draft (Option C doc) |
| R5 Validation before integration / client compatibility | Validation sequence + additive-only output contract; oracle + fixtures first | Resolved in draft; production validator CI-03 |
| R6 Quantitative gates | Targets listed; baseline unmeasured; billed budget zero | **Open** — needs approval and a measured baseline |

## 11. Phase 1 gate checklist (for the human approvers)

Record approval of: (1) composition and precedence, (2) charter and governance owner, (3) task/mode/register mapping, (4) context and output contracts, (5) ownership-integrity enforcement, (6) quantitative limits and cost ceilings. Also needed: the C1–C6 text, label/copy approval, and answers to the open decisions in the charter §7. Until recorded, CI-02 stays unstarted.
