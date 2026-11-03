# CI-V2 CI-02 — Pure Task-Context Assembly

| Field | Value |
|---|---|
| Work package | CI-02 |
| Status | **DRAFT. Offline only.** Authorized as engineering development by Management Checkpoint 1. Product/Trust review and runtime release are not waived. |
| Artifacts | `supabase/functions/_shared/corporateIntelligence/` — `modeSelector.ts`, `contextAssembler.ts`, `contextAssembler.test.ts` |
| Depends on | CI-01 (`contracts.ts`, PR #715) |

## Scope (and what is deliberately absent)

In scope: pure task-context assembly, reuse of the existing `aiSecurity` trust envelope, deterministic communication-mode selection, provenance and data minimization, verified-fact freshness handling, strict `corporate-task-v1` validation, focused offline integration tests.

Absent by design: no Gemini call, no write, no database read, no clock (the caller passes `now`), no randomness, no new authorization mechanism (consent, entitlement and actor checks stay Stage 0 in the function), no function import, no flag. A static test fails if the modules import anything beyond the contract, the selector and `aiSecurity`, or contain I/O, clock, randomness, `async`/`await`, or write-shaped calls.

## Mode selection (C2)

`selectCommunicationMode(state)` is a pure function of **server route, resolved advice intent, discovery status and a grounded server error class**. Customer tone, free text and any model-requested mode are not inputs; extra keys on a runtime object are ignored (tested across 810 state combinations and a set of hostile extra keys). Only `RATE_LIMIT`, `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`, `CATALOG_UNAVAILABLE` enter service recovery. A `ready` discovery response in which no record survives re-validation becomes the neutral empty state, not a failure.

## Provenance and minimization

* `sealTrustedAssemblerInput` is the only constructor the assembler accepts. It copies a **closed** field set and rejects anything else (`verifiedFacts`, `facts`, `ownership`, ids, `message`, `taskVerb`, …) with `client_authority_attempt`. A JSON-parsed request body is not sealed and is rejected as `unsealed_input` even if its shape is perfect. The seal is a hygiene tripwire against passing a request body by accident — it is not a security boundary against code already running on the server, and it is not an authorization mechanism.
* From each discovery product only the fields the assembler needs survive (ids, brand name, price, currency, inventory timestamp, the ownership identity). Titles, URLs, images, merchant prose, evidence and user ids never reach the task or any prompt section (canary test).
* The input type is a structural subset of the discovery engine's `DiscoveryResponse`; a compile-time assignment test fails if the engine changes a field the assembler reads.

## Freshness

| Condition | Effect |
|---|---|
| Ownership not `verified`, label not public, identity names another brand, `verifiedUntil` not after now, or the capped label window already closed | Product dropped (cannot support an ownership claim) |
| Inventory timestamp unparseable, future-dated, or older than the 24 h `product_ref` ceiling | Product dropped |
| Availability older than 6 h | `availability` fact **omitted** (product stays eligible) |
| Price older than 6 h, unparseable/unsafe, or without a provider-declared ISO-4217 currency | `price` + `currency` **omitted**; a price is never stated without a currency |
| `ready` response with zero surviving products | Neutral `discovery_empty_state`, zero-eligible inventory |
| Products alongside `empty`/`unavailable` | Ignored |

The label's TTL never exceeds its verification: `min(24 h, verifiedUntil − generatedAt)`. Dropped/omitted items are reported as **counts only** in diagnostics (no names, ids or text).

## Envelope reuse and prompt isolation

The brief is rendered through the **existing** `assembleStyleChatPrompt` input fields. The `trusted_server_context` block holds only ids, enums and server constants (≤ 1,900 characters; the assembler describes fewer products rather than letting `buildTrustedServerContext` truncate at 2,000, and a test proves every id and the end marker survive the envelope). Merchant-authored display names go to the untrusted `commerce_context`; visual observations to the untrusted `visual_context`; the stylist display name is carried in the task contract but never rendered into the trusted block. Tests prove hostile merchant/observation text cannot change the system side, forge trusted tags or close its own section.

## Evidence

`deno test` (type-checked) on `_shared/corporateIntelligence/`: see the PR. Mutation checks: removing the ownership-expiry checks, the inventory-staleness check, the unsealed-input check, or moving a merchant name into the trusted block each makes a named test fail.

## Not done / still gated

CI-03 (production output validator, record-bound), CI-04 (wiring, flag, full-assembly golden) and CI-06 remain unauthorized. The adapter that maps the live discovery response onto `TrustedDiscoveryResult` belongs to CI-04. Output-token targets per register are design proposals and do not change the existing StyleChat provider cap.
