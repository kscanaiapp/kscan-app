# CI-V2 CI-04 — StyleChat runtime integration

| | |
|---|---|
| Status | **Engineering implementation, default OFF.** Wired into the real `stylechat-generate` handler behind a server-side master flag with a per-request kill switch. Nothing is enabled, deployed or approved by this record. |
| Branch | `ci/ci-04-stylechat-integration`, stacked on `ci/ci-03-validation-opus` (`1bd1eefe`) |
| Authority for governed-test changes | This document. `boundaries.test.ts` now asserts an EXACT importer set and the `geminiSystemText` invariant (see section 7). |

## 1. Flag and rollback

| Env | Meaning |
|---|---|
| `CORPORATE_INTELLIGENCE_V2_ENABLED` | Master switch. Only `true` enables. Default OFF. |
| `CORPORATE_INTELLIGENCE_V2_KILL_SWITCH` | `true` forces OFF regardless of the master. Read on **every request**, so the next request after it is set takes the legacy path. |

* OFF runs no CI code and makes no registry query. The Gemini request and the response are byte-identical to Elise v1,
  tested across 22 scenarios × {unset, `false`, kill switch}.
* The flag unlocks no capability or action. `capabilities.proposable` and `capabilities.executable` stay empty (CI-05).
* It is independent of every Elise flag and of the VRI-03 flags.

## 2. Composition (one path, in this order)

| Layer | Content | Where |
|---|---|---|
| L1 | Existing `aiSecurity` trust rules (`KSCAN_SYSTEM_TRUST_RULES`) + a precedence clause: security, privacy, consent, authorization, entitlement, merchant verification and price/inventory authority override everything below | system role, `kscan_system_rules` envelope |
| L2 | Corporate charter `kscan-corporate-charter-v1-draft`, byte-identical to the charter document's Employee Contract block (tested) | same envelope |
| L3 | Server-selected `CorporateTaskV1` brief from the CI-02 assembler (mode, register, verified facts, inventory) | system role, `trusted_server_context` envelope |
| L4 | Elise v1 personality and presentation: the **entire** legacy system text, verbatim | system role, after a subordination header |
| L5 | Customer conversation: the existing turns. Server-derived commerce names and visual observations are appended to the last user turn as **untrusted** `commerce_context` / `visual_context` sections | user role |

Customer- or merchant-controlled text never enters L1–L3 (handler test "prompt isolation").

Elise v1 places some customer-derived background blocks (memory, weather, Signature Style) inside its own system text.
Those stay inside L4 unchanged. Moving them would change Elise behavior, so it is listed for architecture review
(R5 item 4).

## 3. Generation-path inventory (all pass the CI-03 finalizer while ON)

| # | Path | Origin / outcome | Covered |
|---|---|---|---|
| 1 | Initial Gemini completion | `primary_initial` | ✅ handler test |
| 2 | Provider retry (`ELISE_GENERATION_RETRY_V1_ENABLED`) | `primary_provider_retry` | ✅ by construction (same assignment); not separately exercised |
| 3 | Completeness retry | `completeness_retry` | ✅ |
| 4 | Best effort after retry | `best_effort_after_retry` | ✅ |
| 5 | Best effort initial after retry failure | `best_effort_initial_after_retry_failure` | ✅ |
| 6 | Generic fallback after a truncated or empty retry | provider failure → deterministic | ✅ |
| 7 | Provider error (catch path) | provider failure → deterministic | ✅ |
| 8 | `mark_generating` failure early return | provider failure → deterministic | ✅ `ciV2FallbackText()` |
| 9 | Stale revalidation return | provider failure → deterministic | ✅ `ciV2FallbackText()` |
| 10 | Empty final text fallback | provider failure → deterministic | ✅ |
| 11 | Text actually displayed after the ownership/absence prose-safety filters | re-finalized if changed | ✅ |
| 12 | Configured fallback model | **not wired** (finding F1, tripwire kept); `fallback_model` origin exists | n/a |
| 13 | Discovery / ownership responses | `merchant_discovery_explanation`, `discovery_empty_state` | ✅ orchestration (live engine → adapter → finalizer); **StyleChat trigger BLOCKED** (section 5) |
| 14 | Idempotent duplicate replay | returns previously persisted text or a static string; **not a generation** | n/a |
| 15 | Packing mode | separate structured contract, outside the CI-v2 task taxonomy | **NOT COVERED**: needs a taxonomy decision |

## 4. Sanitizer placement (D-1 / #716)

**Decision:** the validator runs on the text exactly as displayed and persisted, i.e. after `stripUnsafeModelOutput`.
It runs **before persistence**, and again after prose safety whenever that changes the text.

The sanitizer fix stays with its Build 35 owner (#716). While CI-v2 is ON, any displayed candidate containing the
sanitizer marker `[removed]` **fails closed** to frozen copy, with telemetry `sanitizerCorruption=true`. Corrupted
text is therefore never displayed. The cost is that ordinary replies containing "select/create/update/drop"
currently degrade to generic copy. **#716 must be fixed before enabling v2 for customers.** Handler test "#716"
reproduces both sides.

## 5. Live discovery adapter and merchant registry

* `adaptDiscoveryResponse` maps the live `black-owned-discovery` `DiscoveryResponse` to `TrustedDiscoveryResult`. It
  keeps `productId`, `brandId` and `ownershipIdentity` exactly as the engine produced them. Malformed, oversized,
  foreign-version or **misattributed** input (an identity naming a different brand than its product) degrades the
  whole result to `unavailable`, never to a partial shelf. Ownership is never inferred.
* The **merchant registry** is built only from server records: `discovery_brands.name`, read through the existing
  service-role REST helper (read-only, names only, 5-minute isolate cache), plus brand names on the turn's
  authoritative discovery records. It is never built from model output, client claims, product titles or heuristics.
  If the registry is unavailable it never widens acceptance.
* **Security-relevant addition:** `stylechat-generate` now performs one read-only service-role query
  (`discovery_brands?select=name`) **only while CI-v2 is ON**. Flagged for review.
* Stale records are re-checked at finalization time against `now`. A record that expires between assembly and display
  is rejected (test). A "ready" result whose records are all stale becomes zero-eligible.
* Zero eligible → exact frozen `zero_eligible` copy whatever the model wrote. No merchant or substitute is generated.
* **BLOCKED:** a StyleChat turn cannot yet *trigger* discovery. Current clients send no discovery request, and
  running discovery from StyleChat is a new request contract (Product decision: request shape, quota, whether Elise
  may run discovery). The adapter, registry, assembly and finalization for the discovery route are implemented and
  tested end to end with the real engine, but `index.ts` builds only `route: 'stylechat'` tasks.

## 6. VRI-03 integration findings

* Scanner output reaches StyleChat through `fashionContextV2` (client-sent, server-parsed): colour, materials,
  patterns, silhouettes, subtype and distinctive attributes. H2's enriched fields flow into it when the client maps
  them. H3's `search_queries` are **not** carried, which is correct: a search phrase is not an observation.
* CI-04 maps up to 3 groundable items to `visualObservations` (appearance only; brand, exact product, model family and
  search phrases excluded; punctuation stripped). They are delivered only as an untrusted `visual_context` section.
* H1–H4b behavior is unchanged, and no VRI-03 defect was reproduced.

## 7. Governed-test changes (narrow, intentional)

| Test | Before | After |
|---|---|---|
| `boundaries.test.ts` Option B isolation | no importer anywhere | exact importer set: `stylechat-generate/{index,corporateIntelligenceV2}.ts` + its two tests; `index.ts` may not import CI modules directly |
| `boundaries.test.ts` call-site inventory | `buildGeminiBody(systemTextWithAttachments` ×2 | `buildGeminiBody(geminiSystemText,` ×2; `geminiSystemText` is the legacy text unless the task was prepared; `callGemini` ×3, brand voice ×1 and the F1 tripwire unchanged |

The legacy prompt digests (`legacy-baseline-golden.json`), the 74 acceptance fixtures, the corpus and the mutation
guards are unchanged.

## 8. Findings outside CI-04 ownership

| ID | Severity | Finding | Owner | Next action |
|---|---|---|---|---|
| CI04-F1 | P2 | The assistant text is **persisted before** the ownership/absence prose-safety filters run, so a reload can show a sentence the live reply removed (legacy path). CI-v2 ON finalizes before persistence. | Elise / Build 35 | Issue with repro |
| D-1 (#716) | P2 | Sanitizer corrupts ordinary verbs | Build 35 | Existing issue; blocks customer enablement of v2 |

## 9. Approvals still required (not implied by green tests)

Charter text (R5 #4 composition), frozen copy `ci03-frozen-copy-v1-proposed`, public label wording, G1–G12
thresholds, the mode taxonomy, the packing exclusion, the StyleChat discovery trigger contract, the service-role
registry read, and any runtime enablement or deployment. Verification-label bytes and output-token limits are
unchanged.
