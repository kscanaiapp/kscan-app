# Provider Edge Function Security Hardening — Compatibility Validation

- **Validation date:** 2026-08-03
- **Repository:** kscanaiapp/kscan-app
- **Branch:** security/provider-edge-auth-hardening
- **Commit (HEAD):** 8b368e8ce8e0c3c7d71f6ed7f0017cf94c77884d
- **PR:** #43 (open, mergeable, base `ios/full-submission-readiness-v2`)
- **Staging project:** K Scan AI Staging (`yzqjvdfgefveprobvvyw`)
- **Production project:** KScan App Production (`wyyuqfdxucjksghsmhry`) — not touched at any point in this pass

## Method note (read before the rest of this document)

This pass distinguishes three evidence tiers, labeled inline throughout:

- **[Direct]** — executed by this validation session itself (local `deno test`/`node --test`, direct anonymous HTTP calls against staging, direct SQL reads via the Supabase project).
- **[CI, same HEAD]** — read from the actual GitHub Actions job logs for run `30813369676` / `30813366032` (this PR's HEAD, executed 2026-08-03), not re-run locally. Used for authenticated synthetic-account flows, because this session does not hold the `STAGING_SYNTHETIC_*` credentials (they exist only as CI secrets, matching the design in `security/scripts/synthetic-staging-tests.js`).
- **[Static]** — derived from reading source/migration SQL rather than executing it (used for TTL/backoff arithmetic and RLS policy shape).

No production data, staging secrets, or synthetic-account passwords were requested or handled in this session.

## Functions validated

stylechat-generate, product-search-deals, search-vinted-secondhand, tryon-clothes-pro, kickscrew-sneaker-description, nike-shoe-details, plus the shared module at `supabase/functions/_shared/security/`.

## Callers validated

`hooks/useKScan.js` (→ secondhand, kickscrew), `hooks/useStyleChat.ts` / `services/style-chat/providers/edgeStyleChatProvider.ts` (→ stylechat), `components/AnalysisCard.tsx`, `components/SneakerMatchCard.tsx`, `app/style-chat/[sessionId].tsx`.

---

## Pass A/C — Compatibility Matrix

| Function | Caller | Request contract | Response fields consumed | Status codes handled | Retry behavior | Error UX | Deployment state |
|---|---|---|---|---|---|---|---|
| **stylechat-generate** | `hooks/useStyleChat.ts:146` via `edgeStyleChatProvider.ts` | `{ sessionId, message }` only | `status`, `message.{content,sender,model,tokenEstimate}`, `usage.{messagesUsed,messagesLimit,resetAt}` | 2xx success; non-2xx parsed for `status` (`burst_limit`/`limit_reached`/`error`) | None client-side (single `invoke`, 20s client timeout chosen to exceed the server's own worst-case ~12s Gemini + auth/quota budget) | `burst_limit` → non-persisted banner, no retry link (screen-level `ErrorBanner`, `isLimitNotice=true`); `limit_reached` → same + `messagesUsed/messagesLimit` updated + input composer disabled once at limit; generic `error` → friendly fallback message, persisted as an assistant row | **Deployed**, live |
| **kickscrew-sneaker-description** | `useKScan.js:240` → `sneakers/index.ts` → `kickscrewRapidApi.ts:87` | `{ productUrl }` | Raw KicksCrew `product` object, normalized server-adjacent in `kickscrewRapidApi.ts` into `SneakerReference`; `AnalysisCard`/`SneakerMatchCard` only ever see the normalized shape, never `.raw` | Any non-2xx or `{error}` body → treated as empty result `[]` | None (single `invoke`, 5s client timeout) | Empty/failed lookup renders nothing (`AnalysisCard.tsx:211`, `SneakerMatchCard.tsx:27` both guard on empty array) — silent degradation, no error banner | **Deployed**, live |
| **product-search-deals** | *(none found)* | `{ q, limit?, offset?, country?, language?, sort_by?, product_condition? }` | `products\|deals\|results\|data[]`, each tolerant-normalized, raw kept in `.raw` | Function returns `null` on any error path, never throws | Server-side: 1 retry (`maxAttempts:2`) on 429/5xx | N/A — no caller to render an error | **Deployed** (Pass 4 redeploy), no live caller |
| **search-vinted-secondhand** | `useKScan.js:221` → `services/secondhand.js:100` | `{ query, category?, color?, brand?, size?, limit }` | `{ enabled, items[], error?, meta }` | Any invoke error / thrown exception → resolved (never rejected) `emptyResponse()` | None client-side | `enabled:false` or empty `items` → guarded no-op merge (`useKScan.js:223`); scan result screen already showing `status:'result'` before this call even starts | **Hardened in source, undeployed** (Apify secret absent from staging) |
| **tryon-clothes-pro** | *(none found)* | `{ person_image, top_garment?, bottom_garment?, resolution?, restore_face? }` | `{ imageUrl, taskId, status }`, raw kept in `.raw` | Function returns `null` on error, never throws | Server-side: 1 retry on 429/5xx | N/A — no caller | **Hardened in source, undeployed** |
| **nike-shoe-details** | *(none found)* | `{ product_url }` | Tolerant-normalized `{ title, subtitle, price, currency, imageUrl, styleCode, colorway, description, sizes, availability }`, raw kept in `.raw` | Function returns `null` on error, never throws | Server-side: 1 retry on 429/5xx | N/A — no caller; only a `__DEV__`-guarded, itself-unimported dev helper exists | **Hardened in source, undeployed** |

No-live-caller findings were confirmed by repo-wide grep (not inferred) for `productSearchDeals`, `nikeShoeDetails`/`nikeShoeDetailsDevHelper`, and `tryOnClothesPro` — matches exist only in the modules themselves, their edge functions, tests, and docs/security tooling that reference the function name as a string.

---

## Pass B — Functional Regression Validation

**[Direct]** Local test execution against worktree HEAD:

| Suite | Result |
|---|---|
| `deno check` (all edge functions + `_shared`) | Clean, 0 errors |
| `deno test` — `_shared/security/*` | 68/68 pass |
| `deno test` — full `supabase/functions/` (incl. `_shared`) | 213/213 pass |
| `node --test __tests__/security/*.test.js` (deployment allowlist, migration classification, changed-function detection, synthetic-auth helpers, baseline comparison) | 86/86 pass |
| **Total** | **299/299 pass** — matches the documented total exactly |

**[Direct]** Live staging, unauthenticated requests (anon key, this session, 2026-08-03):

| Function | OPTIONS | Unauth POST | GET |
|---|---|---|---|
| kickscrew-sneaker-description | 200 | 401 `{"error":"unauthorized","message":"Missing authorization","requestId":"..."}` | 405 |
| product-search-deals | 200 | 401 same shape | 405 |
| nike-shoe-details | 404 `NOT_FOUND` | 404 `NOT_FOUND` | 404 |
| tryon-clothes-pro | 404 `NOT_FOUND` | 404 `NOT_FOUND` | 404 |
| search-vinted-secondhand | 404 `NOT_FOUND` | 404 `NOT_FOUND` | 404 |

This independently confirms, at the live gateway, that the three intentionally-undeployed functions are genuinely absent (platform-level 404, not an application-level rejection), and that the two newly-hardened deployed functions correctly gate on auth before anything else, with the safe normalized error shape (`error`/`message`/`requestId`, no internal detail).

**[CI, same HEAD]** `Synthetic auth tests` job (run `30813369676`, job `91686495979`), executed against this exact commit: 18/18 assertions passed — production-target rejection, runtime auth for all three synthetic roles (active/pending/locked), anonymous rejection, 5 malformed-JWT-shape rejections, active-user request success, payload-size enforcement (512KB oversized message → validation rejection), wrong-content-type rejection (`text/plain` → 400), pending_deletion rejection (403/`account_unavailable`), locked rejection (403/`account_unavailable`), storage/RLS health probes. `Staging health checks` job: 15/15 pass (REST root, `ensure_privacy_settings`, schema/edge-function presence probes).

**[Static]** Source-hardened, undeployed functions (`search-vinted-secondhand`, `tryon-clothes-pro`, `nike-shoe-details`): each has a full `index.test.ts` exercising auth, account-state, validation, quota-denied, provider-failure, and privacy assertions (all included in the 213 passing above) and `deno check` is clean for each.

---

## Pass D — UX Strictness / False-Positive Findings

No false positives found for the deployed, live-caller functions:

- **StyleChat**: `burst_limit` and `limit_reached` never persist a message or mutate stored usage counters beyond what the server returns, and the two states are visually distinct in copy (`constants/styleChat.ts:20-23`) — this preserves the pre-hardening UX exactly, since these two statuses and their handling already existed before this pass and were not altered by it.
- **Vinted graceful degradation**: confirmed end-to-end — `services/secondhand.js` never rejects/throws (all failure paths funnel to a resolved `emptyResponse()`), and `useKScan.js` already transitions to `status:'result'` *before* the secondhand call is even issued, so an unavailable/undeployed function cannot produce a stuck spinner or an unhandled promise rejection. This holds today, live, since `search-vinted-secondhand` currently 404s at the gateway (confirmed above) and the app must already be tolerating that in production use of this branch.
- **KicksCrew**: empty/failed lookups render nothing (two independent empty-guards in `AnalysisCard.tsx:211` and `SneakerMatchCard.tsx:27`) rather than an error state — again unchanged by this pass, since normalization/guarding lives entirely in client code this PR does not touch.

No evidence of unexpected 401/403, premature 429, false duplicate detection, or repeated sign-in was found in either the direct anonymous probing or the CI synthetic run. One structural risk was found that *could* produce false-duplicate/false-concurrency behavior under specific timing — see Pass E.

---

## Pass E — Quota, Concurrency, and TTL Validation

**[Static + Direct]** Live values read from `provider_request_limits` on staging (2026-08-03):

| Function | Rolling | Daily | Concurrent | Reservation TTL | Provider timeout | Max attempts | Backoff cap |
|---|---|---|---|---|---|---|---|
| stylechat-generate | 6/60s | 120 | 2 | 30s | ~12s (Gemini, client-inferred) | n/a (no bounded-retry wrap observed in this pass) | n/a |
| product-search-deals | 10/60s | 300 | 3 | 20s | 20s (`UPSTREAM_TIMEOUT`, index.ts:41) | 2 | 200ms (attempt 1) |
| search-vinted-secondhand | 10/60s | 300 | 3 | 20s | — (undeployed) | — | — |
| tryon-clothes-pro | 3/60s | 40 | 1 | 60s | — (undeployed) | — | — |
| kickscrew-sneaker-description | 15/60s | 400 | 3 | 15s | — | — | — |
| nike-shoe-details | 15/60s | 400 | 3 | 15s | 8s (`UPSTREAM_TIMEOUT`, index.ts:44) | 2 | 200ms (attempt 1) |
| scan-identify *(seeded, out of this PR's scope)* | 8/60s | 150 | 2 | 30s | — | — | — |

Worst-case envelope arithmetic, verified directly from `computeBackoffDelayMs`/`withBoundedRetries` (`_shared/security/provider.ts:105-127`) against each function's own `UPSTREAM_TIMEOUT` and `maxAttempts:2`:

- **product-search-deals**: `20,000 + up to 200 + 20,000 = ~40,200ms` — **matches the documented ≈40.2s exactly.**
- **nike-shoe-details**: `8,000 + up to 200 + 8,000 = ~16,200ms` — **matches the documented ≈16.2s exactly.**

### TTL vs. envelope — mechanism, not just the gap

Read directly from `supabase/migrations/20260803020000_provider_request_security.sql`:

- The **concurrency check** (`reserve_provider_request`, lines 276-288) counts only rows where `status='reserved' AND expires_at > now()`.
- The **duplicate-replay check** (lines 261-274) uses the same `expires_at > now()` filter.
- The **partial unique index** enforcing no-duplicate-in-flight (`provider_request_reservations_fingerprint_inflight_idx`, lines 100-102) has **no `expires_at` filter** — it applies to any row with `status='reserved'`, expired or not.
- **Rolling/daily counts** (lines 290-295, 306-311) are *not* TTL-gated (`status in ('reserved','completed')`, no `expires_at` filter) — so TTL expiry cannot inflate rolling/daily allowances.

**Consequence for product-search-deals** (TTL 20s < envelope 40.2s): if a request's provider call is still in its second attempt (i.e., past the 20s TTL mark, up to ~40.2s total), that reservation's `expires_at` has already passed. For that ~20s window:
- It **stops counting toward `concurrent_limit`** — a second, independent request from the same user could be admitted where it should have been blocked. This *can* allow an overlapping provider call beyond the configured concurrency cap, confirming the brief's hypothesis.
- If the *same* logical request is retried by the client in that window (same fingerprint), the duplicate-replay check no longer finds it (TTL-gated), so `reserve_provider_request` falls through toward inserting a **new** row with the same `(user_id, request_fingerprint)` — which the partial unique index (not TTL-gated) then rejects as a `unique_violation` Postgres error. This surfaces to the edge function as `reservation.ok === false`.
- **Confirmed in `product-search-deals/index.ts:216-229`**: the function explicitly **fails open** on `reservation.ok === false` — it logs `reservation_unavailable` server-side (`console.warn`, never in the response body — no client-facing leak) and proceeds to call the provider with `reservationId = null`, so **no reservation row is written for that call at all**. This is a genuine, narrow cost-accounting gap: a request that hits this exact race is never charged against rolling/daily/concurrency counts. It does not produce a client-visible error or expose internals — it fails safe for the user, unsafe only for quota accounting, and only under the specific double-timeout collision.

**Consequence for nike-shoe-details** (TTL 15s < envelope 16.2s): same mechanism, ~1.2s window. Undeployed, so this is dormant risk, not live risk, today.

**Proposed tuning (not applied — pausing per Fix Policy):**

| Function | Current TTL | Proposed TTL | Measured reason | Security effect | UX effect | Rollback |
|---|---|---|---|---|---|---|
| product-search-deals | 20s | ≥45s (envelope 40.2s + margin) | Envelope math above, confirmed against live code constants | Closes the concurrency-undercount / cost-accounting-gap window entirely | None — TTL only bounds how long an abandoned reservation blocks a legitimate retry; raising it doesn't change any user-visible limit or error | Revert to 20s |
| nike-shoe-details | 15s | ≥20s (envelope 16.2s + margin) | Same math | Same | Same | Revert to 15s |

No threshold was changed. This is a proposal for the user/reviewer to accept, reject, or size differently.

---

## Pass F — Latency Validation

**[Direct]** Read from live `edge-function` service logs (`get_logs`, staging project, last 24h — real traffic, mostly generated by today's CI runs against this exact HEAD, not synthetic-only load):

| Function | Sample | Observed range (unauthenticated/rejection paths) | Note |
|---|---|---|---|
| stylechat-generate | ~90 requests | 401 (no/malformed auth): 59–703ms; 403 (account-state rejection): 193–681ms; 400 (validation rejection, post-auth): 229–914ms | 400s run longer because they pass the auth layer (a real GoTrue verify) before failing validation |
| kickscrew-sneaker-description | several | 401: 44–319ms | |
| product-search-deals | several | 401: 47–302ms | |
| privacy-correction-request / privacy-data-export / handle-user-deletion | several | 401: 37–338ms | Unrelated to this PR, included in the same log window as a baseline comparison — auth-rejection latency is in the same ballpark across old and newly-hardened functions |
| nike-shoe-details / tryon-clothes-pro / search-vinted-secondhand | many | 9–20ms | Gateway-level 404 (undeployed) — not a measurement of the hardening layer at all |

**Gap, stated plainly:** this session could not independently capture authenticated **success-path** latency (a real 200 with the full auth → quota-reservation → provider-call → completion chain), because doing so requires the `STAGING_SYNTHETIC_*` account passwords, which exist only as CI secrets and were not requested or obtained here. The CI `Synthetic auth tests` run at this HEAD did exercise an authenticated success path (`active-user request succeeds` — pass) and a provider round trip, but the job log records pass/fail per assertion, not a timing breakdown. The rejection-path numbers above (sub-second, dominated by the auth verify) are the best same-HEAD, real-traffic evidence available without those credentials; they are consistent with "no gross regression" but are not a substitute for a proper authenticated p50/p95 capture. **Recommend**: either share/rotate a short-lived synthetic credential into this session, or have CI additionally emit per-assertion timings into `synthetic-report.json`, before treating latency as fully closed.

---

## Pass G — Failure and Recovery Validation

**[Direct, from the 213-test deno run]** All of the following are exercised and passing in `tryon-clothes-pro/index.test.ts` (representative of the shared pattern used by all six functions, since they share `_shared/security/quota.ts`/`provider.ts`):

- Reservation completes on provider success (`quotaDecision:"completed"`).
- Reservation releases on provider failure — 400, 401→502, 429→429, persistent 5xx→502, malformed JSON→502, timeout→504 — every one of these paths calls `releaseProviderRequest`, confirmed via the `quotaDecision:"released"` log line in each case.
- A denied quota reservation (`rate_limited`) returns 429 **before any provider call** is made.
- Missing secret (`RAPIDAPI_KEY`) → 500 configuration error, not a silent pass-through.

**[Static]** Cross-user reservation access: blocked by construction — every RPC (`reserve_provider_request`, `complete_provider_request`, `release_provider_request`, `evaluate_provider_abuse_state`) scopes to `auth.uid()` internally and raises on a mismatched `p_user_id`; the only client-facing SELECT policy on `provider_request_reservations` is `user_id = auth.uid()`.

**[Static, from Pass E]** The one confirmed gap: under the TTL/envelope race described above, a stuck-past-TTL reservation is not "recovered" by any sweeper — it simply ages out of the concurrency/duplicate checks while remaining `status='reserved'` until its own request's `complete`/`release` call eventually resolves it (or never does, if the function crashes mid-flight, in which case it remains `reserved` indefinitely — there is no expiry sweep job in this migration). This is a latent gap independent of the TTL-tuning proposal above: a genuinely crashed request (not just a slow one) leaves a permanently `reserved` row that only stops counting toward concurrency once its TTL passes, but never flips to `released`/`expired`. Recommend a periodic sweep (`status='reserved' AND expires_at < now() → 'expired'`) as a follow-up — not implemented here, no schema change made.

Retry-After correctness: `errors.ts` clamps `retryAfterSeconds` to `Math.max(1, Math.floor(...))` and only attaches the header on `rate_limited` — confirmed by `errors.test.ts`.

---

## Pass H — Privacy and Error UX Validation

**[Direct, from `logging.test.ts`, 7/7 pass]**: `logSecurityEvent` output is confirmed (by test, against a "realistic sensitive payload" fixture) to never contain forbidden substrings; `safeUserIdFragment` truncates to 8 characters; `sanitizeLogText` clamps length and returns `undefined` for non-string input (guards against an accidental image/object payload reaching a log line); a log line built from raw request text never contains an `Authorization` value.

**[Direct, from `errors.test.ts` + live curl]**: every error category maps to a fixed status/body shape (`{error, message, requestId}`, `+retryAfterSeconds` only for `rate_limited`); a live unauthenticated call to two deployed functions returned exactly this shape with no additional fields.

**[Static]** `provider.ts`'s own file-level contract (asserted by `normalizeProviderError` tests) guarantees no response body ever contains a provider name — confirmed both by the "retailer neutrality" unit test and by the fact that `product-search-deals`'s own 400/502 paths (`index.ts:254-267`) return only `{error, detail?, requestId}`, `detail` being the upstream's *own* structured 400 body (not internal detail), matching the "existing raw provider response passthrough was preserved" statement in scope.

One doc-hygiene item (not a security defect): `_shared/security/quota.ts:6-10` still reads "They are not yet applied to staging... calling it against a live Supabase project before that migration lands will fail." **This is now stale** — this session confirmed directly via SQL (`information_schema.routines`) that all four RPCs (`reserve_provider_request`, `complete_provider_request`, `release_provider_request`, `evaluate_provider_abuse_state`, all `SECURITY DEFINER`) and all three tables exist on staging today, and `list_migrations` shows all three `20260803020000/020100/020200` migrations applied. The comment should be updated to reflect that the migration has landed; left unchanged in this pass since it is documentation only, not behavior.

---

## Pass I — Staging Data and Inventory Verification

**[Direct]** Deployed function inventory (`list_edge_functions`, cross-checked live via curl): exactly the expected 8 — `privacy-controls`, `public-sale-share-opt-out`, `kickscrew-sneaker-description`, `stylechat-generate`, `handle-user-deletion`, `product-search-deals`, `privacy-correction-request`, `privacy-data-export`, all `ACTIVE`. `search-vinted-secondhand`, `tryon-clothes-pro`, `nike-shoe-details` confirmed **absent** (platform 404, not merely inactive).

**[Direct]** Table counts (before/after this validation pass — identical, since this pass performed reads and unauthenticated/anonymous requests only, no writes):

| Table | Count |
|---|---|
| waitlist_signups | 2 |
| privacy_settings | 11 |
| deletion_requests | 2 |
| website_sale_share_opt_out_requests | 8 |
| privacy_export_requests | 0 |
| privacy_correction_requests | 0 |
| profiles | 10 |
| provider_request_limits | 7 (6 in-scope functions + `scan-identify`, seeded ahead of its own out-of-scope Edge Function landing) |
| provider_request_reservations | 0 |
| provider_security_events | 0 |

The three persistent synthetic accounts (`synthetic-active@kscan-test.invalid` / active, `synthetic-pending@kscan-test.invalid` / pending_deletion, `synthetic-locked@kscan-test.invalid` / locked, all created 2026-08-03) are present and accounted for among the 10 `profiles` rows, as expected. The remaining 7 profiles predate this pass by weeks/months (oldest from 2026-05-16) and are pre-existing QA/test fixtures unrelated to this hardening effort (e.g. `delete-qa@kscan.app`, `stylechat.audit.*`, `test@kscanai.com`) — **left untouched**, since this session created no temporary users and has no basis to judge whether another workstream still depends on them. `provider_request_reservations`/`provider_security_events` are both empty — expected, since the migration is brand-new and this pass performed no authenticated provider calls itself (only unauthenticated ones, which are rejected before a reservation is ever attempted).

**No legitimate staging data was changed. No temporary users were created or needed removal by this session.**

---

## Defects Found

1. **TTL/worst-case-envelope race** (Pass E/G) — confirmed structural gap: under a full double-timeout retry, `product-search-deals` (20s TTL vs 40.2s envelope) and, dormant, `nike-shoe-details` (15s TTL vs 16.2s envelope) can (a) undercount concurrency for the tail of the slow request, and (b) fail open (no reservation recorded) if the client retries into that exact window, due to `unique_violation` on the TTL-unaware partial index. No client-facing leak; no crash. **Proposed tuning above; not applied.**
2. **No reservation-expiry sweep** (Pass G) — a genuinely crashed (not just slow) request leaves its reservation permanently `status='reserved'`; it silently stops counting toward concurrency once TTL passes but never transitions to `expired`/`released`. Follow-up recommendation only; no schema change made.
3. **Stale code comment** (Pass H) — `_shared/security/quota.ts:6-10` says the migration "is not yet applied to staging," which is no longer true (confirmed live). Documentation only; not fixed in this pass.

No contract regressions, no UX regressions, and no false-positive throttling were found for any live-caller path.

## Repairs Made

None. This was a validation-only pass per its Fix Policy; all three items above require either a threshold change (pause required) or are documentation-only (left for explicit follow-up).

## Unresolved Risks

- Authenticated success-path latency (p50/p95 for a real 200 through the full auth→quota→provider→completion chain) was not independently measured in this session — see Pass F gap.
- The TTL/envelope and expiry-sweep items above remain open pending a threshold-change decision.

---

## Final Table

| Function | Functional | Contract | Normal traffic | Retry | Concurrency | Quota | TTL | Latency | Error UX | Privacy | Deployment state | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| stylechat-generate | PASS | PASS | PASS | PASS (CI) | PASS | PASS | PASS (30s vs no bounded-retry envelope observed) | PASS (rejection-path only; success-path not independently measured) | PASS | PASS | Deployed | PASS |
| kickscrew-sneaker-description | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS (rejection-path) | PASS | PASS | Deployed | PASS |
| product-search-deals | PASS | PASS (no live caller) | PASS | PASS | TUNING PROPOSED | TUNING PROPOSED | **TUNING PROPOSED** (20s < 40.2s) | PASS (rejection-path) | PASS | PASS | Deployed | **PASS WITH TUNING PROPOSED** |
| search-vinted-secondhand | PASS (source) | PASS (graceful degradation confirmed) | PASS | PASS | PASS | PASS | PASS | N/A (undeployed) | PASS | PASS | Held (Apify secret absent) | PASS |
| tryon-clothes-pro | PASS (source) | PASS (no live caller) | PASS | PASS | PASS | PASS | PASS | N/A (undeployed) | PASS | PASS | Held (no deploy decision) | PASS |
| nike-shoe-details | PASS (source) | PASS (no live caller) | PASS | PASS | PASS (dormant) | PASS | **TUNING PROPOSED** (15s vs 16.2s, dormant) | N/A (undeployed) | PASS | PASS | Held (no live caller / no decision) | PASS WITH TUNING PROPOSED (dormant) |

## Final Verdict

**PASS WITH TUNING PROPOSED**

Evidence labels supported by this pass: FUNCTIONAL COMPATIBILITY VERIFIED · CLIENT CONTRACTS PRESERVED · NORMAL USER TRAFFIC VERIFIED · LEGITIMATE RETRIES VERIFIED (CI) · QUOTA THRESHOLDS VALIDATED · FALSE-POSITIVE RISK VALIDATED · RESERVATION LIFECYCLE VERIFIED (with one confirmed edge-case gap and one proposed follow-up) · ERROR UX VERIFIED · PRIVACY CONTROLS VERIFIED · STAGING INVENTORY VERIFIED · STAGING DATA PRESERVED · PRODUCTION UNCHANGED · SECURITY PROMOTION GATE PASSED (confirmed via CI, this HEAD).

Not claimed: LATENCY IMPACT MEASURED (authenticated success-path only — rejection-path latency was measured directly and shows no regression).
