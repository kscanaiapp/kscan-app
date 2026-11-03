# CI-V2 Phase 0 — Source Inventory and Architecture Reconciliation

| Field | Value |
|---|---|
| Work package | CI-01 (Phase 0) |
| Branch | `feat/corporate-intelligence-v2` |
| Pinned baseline | `9047ce434e16a7b52f1f45edaeebafc2f1800757` (merge of PR #714) |
| Fetched branch HEAD at start | `9047ce434e16a7b52f1f45edaeebafc2f1800757` — **no divergence from the pin** |
| Worktree | `C:\ci2`, created for this initiative only; no other worktree lists this branch |
| Source authority consulted | `rebuild/backend-authority-v2` lineage (read only; nothing written to it) |
| Billed provider calls | 0. All evidence is source reading, offline tests and read-only `gh` queries. |

## 1. Existing modules and responsibilities (all under `supabase/functions/`)

| Module | Responsibility | Build 35 ownership |
|---|---|---|
| `stylechat-generate/index.ts` (3,426 lines) | Single handler: auth → account lifecycle → Gemini consent → body parse → packing branch → session ownership → burst + daily quota → context assembly → prompt assembly → Gemini → validation → persistence → response | Build 35 backend authority; most recent edits `cb190ff5`, `27456fd5` (consent), `f9fca4d1`, `a2199b7e` (brand voice promotion) |
| `stylechat-generate/eliseBrandVoice.ts` | `elise-brand-voice-v1` block and `appendEliseBrandVoice(base, enabled)`; OFF path returns `base` unchanged | Build 35 (PR #635, promoted by `a2199b7e`) |
| `stylechat-generate/eliseConfig.ts` | Flag/config reader; every flag defaults OFF except `aiEnabled` and `explanations`; `promptVersion` gains `+elise-brand-voice-v1` only when active | Build 35 |
| `stylechat-generate/modelRouting.ts` + `_shared/llmModelRouting.ts` | Allow-listed model resolution; primary/fallback ids; failure taxonomy helpers | Build 35 |
| `stylechat-generate/stylistIdentity.ts` | Server-side stylist name resolver and `[Stylist Persona]` block (name only, bounded, control chars stripped) | Build 35 |
| `stylechat-generate/promptHardening.ts` | `escapePromptData`, `stripUnsafeModelOutput` | Build 35 |
| `stylechat-generate/eliseOutputValidation.ts` | Output text sanitize + action allow-list (`ALLOWED_ACTION_TYPES`, `FORBIDDEN_ACTION_TYPES`; ≤2 actions) | Build 35 |
| `stylechat-generate/eliseOwnershipProseSafety.ts` | Closet ownership/absence prose guard (sentence drop → neutral fallback) | Build 34/35 |
| `stylechat-generate/eliseProviderRetry.ts`, `generationSafety.ts` | Provider-error classification, optional provider retry (flag), operation idempotency/revalidation | Build 35 |
| `_shared/geminiConsent.ts` | `requireGeminiConsent(actorId)`: current `ai_processing` receipt **and** no withdrawal; fail closed (403/503) | Build 35 |
| `_shared/aiSecurity/*` | Trust types, typed prompt envelope, untrusted-text escaping, output validation, action authorization, injection fixtures, `assembleStyleChatPrompt` | Build 35; **imported only by `purchase-import-extract`** |
| `black-owned-discovery/{contracts,engine,catalog,…}.ts` | Verified-merchant eligibility, `OwnershipIdentity`, empty/ready/unavailable statuses | Independently owned (PRs #692/#693) |
| `scan-identify`, `style-outfit-generate`, `stylechat-generate/packingProvider.ts`, `purchase-import-extract` | Other Gemini call sites (out of scope for v2 eligibility) | Build 35 |

## 2. Source-to-Gemini execution flow (conversational StyleChat)

1. Auth (JWT) → `assertAccountActive` → `requireGeminiConsent(userId)` (`index.ts:1019`).
2. JSON parse; non-object body rejected (400).
3. Config read (`readEliseBackendConfig`); `aiEnabled` kill switch; missing key returns 500 before any assembly.
4. Versioned **packing** branch (flag + exact `schemaVersion`) — separate prompt, own provider call, own gates; **excluded from v2**.
5. Session ownership check → generation identity/idempotency → burst RPC (`check_and_increment_stylechat_burst`) → daily RPC (`increment_stylechat_daily_usage[_idempotent]`) — quota is reserved before the provider call.
6. Context assembly (weather, Signature Style, gender styling, stylist name, K+ gated Closet sources, attachments, visual context).
7. **Prompt assembly by string concatenation** (`index.ts:2166–2267` and attachment/advice blocks): `SYSTEM_PROMPT` [+ `EXPLANATION_INSTRUCTIONS`] → `appendEliseBrandVoice` (flag) → user-style memory → weather → Signature Style → gender context → persona → server Signature Style → advice/attachment blocks.
8. `buildGeminiBody(systemText, turns)` → `callGemini` (12 s abort; `temperature 0.7`; `maxOutputTokens 2048`).
9. Completeness heuristic (`incompleteReasonFor`) → at most one same-model completeness retry; optional provider retry when the retry flag is on.
10. Post-processing: `<actions>` extraction → `validateEliseGenerationOutput` → `stripUnsafeModelOutput` → stale-operation revalidation → persistence → ownership/absence prose safety → response. The response contract is plain text plus additive optional fields.

## 3. Primary / retry / fallback differences

| Path | Where | System text | Notes |
|---|---|---|---|
| Primary | `callGeminiWithOptionalRetry(…,'initial')` | `systemTextWithAttachments` | Single model (`config.modelName`). |
| Provider retry (flag `generationRetryV1`) | same wrapper | same body | Only for retryable provider error classes. |
| Completeness retry | `callGemini(…,'retry')` | same system text; user turn gains a rewrite instruction | Same model. |
| Deterministic fallback | `buildStyleChatFallback()` | none (no model call) | Used when retry is truncated/empty/failed. |
| Provider *model* fallback (Lite) | **not wired** | — | See finding F1. |
| Kill switch / no key | before assembly | — | Static preview copy / 500. |

## 4. Compatibility and API constraints

* The wire contract is plain text in `message.content` plus additive optional fields; existing clients ignore unknown keys. **No breaking JSON structure may be imposed** (spec section 6, Stage 1). Structured fields for v2 (e.g. server-rendered ownership badge data) must be additive and optional, behind a client capability signal.
* Clients transport through `services/style-chat/providers/edgeStyleChatProvider.ts` (and `services/packing/packingClient.ts` for the excluded packing branch). Surfaces: StyleChat text, v2 attachments, structured actions (allow-listed, tap-only), weather/advice metadata.
* Hard caps in force: message 500 chars, response 1,000 chars (sanitizer), 2,048 output tokens, 12 s provider timeout, 25 daily / 4 per-minute default quotas, ≤2 actions. A `professional`/`analytical` register that wants more than these must be negotiated explicitly in CI-02; the Task Brief cannot silently exceed them.
* Edge Function parity gates (`config/edge-function-manifest.json`, `scripts/run-backend-tests.js` governed list, deploy-closure check) track `stylechat-generate` and the imported closure. CI-01 adds **no file under any function directory and no import from one**, so these gates see no change.

## 5. Reusable components (do not rebuild)

| Need | Reuse |
|---|---|
| Trust vocabulary | `_shared/aiSecurity/trustTypes.ts` (`AIContentTrust`); corporate tiers map onto it |
| Untrusted-text isolation | `escapeUntrustedText`, `assemblePromptEnvelope`, `assembleStyleChatPrompt` (proven in `iso-*` fixtures) |
| Hostile corpus | `injectionFixtures.ts` (extend, do not fork) |
| Model-action rejection | `rejectForbiddenModelShape`, `authorizeModelAction`, `FORBIDDEN_ACTION_TYPES` |
| Consent / quota / entitlement | `requireGeminiConsent`, burst + daily RPCs, `has_active_k_plus` — unchanged and first |
| Persona | `buildStylistPersonaBlock` (name only) |
| Ownership eligibility | `black-owned-discovery` engine output (`OwnershipIdentity`, status) — never re-derived |
| Prose guard pattern | `eliseOwnershipProseSafety` (sentence-drop + neutral copy; its design notes argue for blunt, explainable checks) |
| Telemetry | `emitEliseTelemetry` / `telemetry.ts` metadata-only pattern; `securityTelemetry.ts` |
| Flags | `parseBooleanEnv`, `EliseBackendFlags` (add one default-OFF flag; no new framework) |

## 6. Proposed new components (none implemented in CI-01 except specification)

| File (proposed) | Package | State |
|---|---|---|
| `_shared/corporateIntelligence/contracts.ts` | CI-01 | **Written** — types, frozen tables, strict `corporate-task-v1` validator. Not imported by runtime. |
| `_shared/corporateIntelligence/actionProposal.ts` | CI-05 (spec in CI-01) | **Written** — Option C schema/state machine, offline only. |
| `_shared/corporateIntelligence/{fixtures,testSupport}/…`, `*.test.ts` | CI-01/CI-03 | **Written** — 74 fixtures, reference oracle, boundary tests. |
| `…/contextAssembler.ts`, `…/modeSelector.ts` | CI-02 | Not started (gate). |
| `…/outputValidation.ts`, frozen copy, harness | CI-03 | Not started (gate). |
| `stylechat-generate/` v2 wiring, pure `buildStyleChatSystemText()` extraction, flag | CI-04 | Not started (gate). |
| Operational metadata, measurement scripts | CI-06 | Not started. |

## 7. Known architectural conflicts

| ID | Conflict | Proposed resolution |
|---|---|---|
| C-01 | Elise v1 says "conversational rather than corporate" while Corporate v2 needs `professional` modes | Personality becomes mode-conditional; composition rule in the charter, section 3 |
| C-02 | Elise v1 `IDENTITY AND ACTIONS` duplicates Corporate identity | Superseded when v2 is ON (single source) |
| C-03 | `SYSTEM_PROMPT` rule 7 (≤150 words) and the 1,000-char sanitizer cap vs. longer analytical/merchant explanations | Treat as default; any widening is explicit in the Task Brief and capped; decision needed at the gate |
| C-04 | `SYSTEM_PROMPT` rule 11 steers shopping to the K Scan scan/search flow; merchant-explanation register discusses discovery results | Merchant explanation exists only on surfaces where the server supplies verified facts; StyleChat does not receive discovery data today |
| C-05 | `aiSecurity` envelope exists but StyleChat concatenates strings | Adopt the envelope for **new** v2 sections only; do not refactor legacy blocks (would break flag-OFF byte identity) |
| C-06 | Legacy `stripUnsafeModelOutput` runs after generation and can alter approved deterministic copy | Defect D-1 below; frozen copy is tested to be sanitizer-stable |

## 8. Evidence-backed findings

**F1 — Provider model fallback is configured but never invoked (observation, not a defect to fix here).** `fallbackModelName` is validated in `eliseConfig.ts`, and `isDirectFallbackFailure`/`isRepairableFailure` exist in `modelRouting.ts`, but `stylechat-generate/index.ts` references none of them. Operational failures therefore end in the deterministic fallback or a same-model retry, not a Lite model call. Impact on v2: "fallback-model parity" is satisfied by construction today (one assembly point), but if a model fallback is later wired, it must reuse the identical assembly and validation. Tripwire: `boundaries.test.ts` fails if `callGemini` call sites change or the fallback symbols appear in `index.ts`.

**F2 — The reported 332 ms completeness-detector short-circuit: UNCONFIRMED (not reproduced; no defect found).** The detector is synchronous string logic; `looksIncompleteAssistantReply` accepts complete short replies without a retry ("Navy.", "Go with brown loafers.", and unpunctuated answers ≤40 chars to short questions) and flags dangling endings ("Try a navy blazer with" → incomplete). An accepted-first-pass response means no retry call, so a total latency near one fast provider round trip is consistent with intended behavior. The raw log line behind the 332 ms report was not supplied and no billed or live call was made; if the reporter has the request id, a live-trace investigation can be scheduled. Not relevant to v2 beyond "v2 must not weaken completeness handling".

**D-1 — Customer-visible text corruption in `stripUnsafeModelOutput` (pre-existing, unrelated to v2; routed to the Build 35 StyleChat owner as issue [#716](https://github.com/kscanaiapp/kscan-app/issues/716), suggested priority P2, minimal reproduction included).** The pattern `\b(?:select|insert|update|delete|drop|alter|create)\s+(?:from|into|table|database)?` has an optional tail, so every standalone occurrence of those everyday verbs is replaced by `[removed]`. Verified by executing the function body on `"Create a layered look and select a darker wash. Drop the hem an inch."`, which returns `"[removed]a layered look and [removed]a darker wash. [removed]the hem an inch."`. It runs on every StyleChat reply (flag state irrelevant), so it affects Build 35 output quality today. **Not fixed here** (Build 35 isolation; out of Corporate v2 scope). v2 consequence: approved deterministic copy must avoid these verbs or be exempted; `boundaries.test.ts` proves the proposed copy is sanitizer-stable.

**F3 — `aiSecurity` is unwired in StyleChat.** Only `purchase-import-extract` imports it. StyleChat uses `escapePromptData`/string concatenation. Recorded as architecture input (C-05).

**F4 — StyleChat receives no Black-owned discovery data.** No reference to `ownershipIdentity`/`publicOwnershipLabelAllowed` exists in `stylechat-generate` (asserted by a test). The ownership firewall for StyleChat is therefore initially *restrictive* (reject any ownership claim lacking an eligible record), while server-rendered badges on discovery surfaces stay the authority for positive labels. Any future positive path requires an explicit server-supplied verified fact plus a client contract.

## 9. Referenced pull requests (read-only)

* #635 — merged 2026-10-29 into the Build 35 integration line (`feb451e7`): brand voice expansion; present on this baseline via `a2199b7e`.
* #692 — merged 2026-11-03 into `rebuild/backend-authority-v2` (`e44c8281`): operable Black-owned catalog; present on this baseline. #693 — promotion of the same to the Build 35 line (`44b069f4`).
* #646 — open, docs-only Build 35 hostile-audit checkpoint; protected, untouched. Issue #706 — open, Build 35 activation/parity hold; untouched.
* Contract constraints taken from #692/#693: verified label requires `ownershipVerificationStatus: 'verified'`, `publicOwnershipLabelAllowed: true`, `verifiedUntil`; engine eligibility requires `availability = in_stock`, unexpired `expires_at` and `verified_until`; statuses `ready | empty | unavailable`; `sponsored` is hard-off.

## 10. Recommendation (v1/v2 composition rule)

Adopt **"Corporate v2 wraps Elise v1"** exactly as specified in the charter, section 3: one assembly path, security first, v2 flag default OFF and independent, brand voice reduced to its expression-only subset when v2 is ON, and the legacy payload untouched when v2 is OFF. Attachment points for CI-04: (a) extract the system-text assembly (`index.ts:2166–2267` onward) into a pure function with a golden captured at this baseline; (b) one insertion between `appendEliseBrandVoice` and the user-style-memory block for the Employee Contract + Task Brief; (c) one post-generation validation call before `validateEliseGenerationOutput`; (d) one flag in `eliseConfig.ts`.
