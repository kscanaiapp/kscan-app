# Build 35 P0–P3 repair ledger (source repairs prepared; owner-gated)

## B35-G-001 — P2 — malformed secondary response can break primary result rendering

- State: CONFIRMED, source repair committed; draft PR #644, unmerged and undeployed. Shared iOS/Android client.
- Source: services/blackOwnedDiscovery.ts, requestBlackOwnedDiscovery response validation; services/blackOwnedDiscoveryHost.ts, displayableSecondary productUrl.split; components/scan-results/ScanResultV2.tsx calls displayableSecondary in render.
- Contract: invalid secondary results must be hidden and must never interfere with primary commerce.
- Reproduction executed: `node --test __tests__/blackOwnedDiscoveryClient.test.js`; new malformed-field regression fails on `{productUrl:42}`. Evidence: evidence/discovery-before.log.
- Code argument: response validation accepts any productUrl type; host calls split on a truthy productUrl. A numeric URL therefore throws during parent render. Non-string price/image fields also reach React/native props. No runtime incidence claim.
- Root cause: TypeScript assertion was used at an untrusted network boundary without validating display fields.
- Planned repair: reject malformed optional display fields and unsafe/non-HTTPS destinations at the service boundary; preserve fail-closed secondary semantics and primary ordering.
- Regression: malformed-field fixture; focused discovery client and host tests.
- PR #644; commit bd2827e7bb524cf149ac01ae5443f2901bbb29f6. Focused 22/22 pass. CI snapshot evidence/repair-ci.json shows green checks plus explicit skips. Merge and authoritative reverification NOT DONE.

## GOV-01 — authority conflict (operational gate, no fabricated product priority)

RESOLVED by existing scoped governance: RP-108 reserves pre-freeze for Build 34; Build 35 targets integration/build35-v1-convergence. The 5/512 divergence and four conflicts were reconciled in prepared PR #648, without Build 35 ancestry on pre-freeze. #644 must not merge to its original pre-freeze target; its repair is promoted with provenance into #648. No authority override or merge performed.

## Runtime gate — organic discovery deployment

Authenticated Production function inventory contains no black-owned-discovery slug. Source merged is verified; backend deployed is CONTRADICTED for the current readback. Protected deployment is a separate owner-approved action. No new feature or merchant data will be manufactured to hide this gap.

## B35-C-001 — P1 — Gemini provider/text consent omitted and legacy acceptance remains sufficient

- CONFIRMED on integration baseline 65a1e7cd. Reproduction: `node --test __tests__/build35GeminiConsentDisclosure.test.js` fails both assertions. Evidence: evidence/gemini-consent-before.log.
- Exact source: app/onboarding/index.tsx:680 says only “I consent to AI image processing”; constants/legal.ts:4 retains AI_PROCESSING_VERSION=v1; services/onboardingCompletion.ts:68 accepts a matching local version marker without rechecking the ledger; services/style-chat/providers/edgeStyleChatProvider.ts:364 sends chat text to stylechat-generate, whose provider is Gemini.
- Contract violated: provider-specific disclosure and explicit consent covering Elise text, including existing-user upgrade flows, before transfer.
- Root cause: image-only disclosure and unchanged acceptance version do not cover Gemini text processing. Existing v1 marker is accepted as current.
- Repair scope: explicit Gemini/photos/text/Elise disclosure adjacent to the short Gemini-consent checkbox; version-bound upgrade forces existing v1 users through current acknowledgment. No binding Terms/Privacy rewrite or invented provider retention claim.
- Regression: real legal constants plus legacy local marker fixture; source disclosure assertion; existing legal/onboarding suites.
- PR #645; commit 8c86a9fd (full SHA in convergence record). Focused 39/39 pass; CI pending. Merge and authoritative reverification NOT DONE. Cross-platform device enforcement and direct backend consent authority remain NOT TESTED.
- Merge order: 1 B35-G-001 (#644); 2 B35-C-001 (separate disjoint files, integration branch). Lead is sole editor; no shared-file parallel repairs.

## B35-F-002 — P1 — outfit generation lifecycle check fails open

- Confirmed by source contract: backend authority `supabase/functions/style-outfit-generate/index.ts`, lifecycle block after verified `userId`, reads `.from('profiles').select('account_status').eq('id', userId).maybeSingle()` but discards the error and rejects only pending_deletion/locked. Missing/RLS-hidden rows, lookup errors and other non-active states proceed to Gemini and saved-look work.
- Contradicts the existing server-authoritative account-active contract used by Scanner and StyleChat in `_shared/deletion/common.ts:assertAccountActive`, which fails closed and resolves missing profiles through Auth plus effective deletion state.
- Repair queued: replace local two-status check with shared account-active guard through a testable response adapter; no schema/policy or Production mutation.
- Regression planned: missing/error/deactivated guard failures produce 403 and zero downstream work; active account proceeds; index wiring guard precedes parsing/provider/reservation.
- Owner/merge: lead only, dedicated backend-authority repair branch/PR, separate from consent work. Status OPEN.

## B35-C-002 — P1 — Gemini transfer endpoints do not enforce the consent receipt

- Source contract evidence on backend authority 3efcb6cb: scan-identify/index.ts authenticates paid inference then calls Gemini without reading legal_acceptances; stylechat-generate/index.ts has auth/account gates then Gemini/Packing dispatch without a receipt check; style-outfit-generate/index.ts and purchase-import-extract/handler.ts likewise omit it. These are the complete discovered Gemini transmitters (Packing is dispatched through stylechat).
- This contradicts the campaign's before-transfer consent contract: PR #645 only changes onboarding, and direct authenticated clients can bypass route/onboarding state.
- Repair queued: shared fail-closed receipt check requiring the exact v2_google_gemini version for the verified actor before quota/provider work on all four entries. Preserve MODE B commerce-only behavior. No raw content, credentials or legal rows logged.
- Backend authorization behavior explicitly flagged; no Production deployment authorized by this source patch. No schema or wire-body change planned.
- Revocation remains a distinct authority gap: legal_acceptances is an immutable receipt ledger, not a withdrawal ledger. Do not claim a version check implements revocation.

## B35-COST-003 — P2 — VTO certification can misclassify an accepted paid submission as not dispatched

- Reproduced on source-converged candidate 4c09c44d: full Node suite fails `vtoE2eUserGarmentProbe.test.js:598`, which proves authorization_failed can now be returned after generation began (durable settlement/receipt failure in canonical VTO-001–005 repairs).
- Exact source: scripts/vto-e2e/lib/userGarmentProbe.mjs NOT_DISPATCHED_FAILURE_CODES includes authorization_failed; dispatch classification later uses that list to set zero dispatch. Contract requires ambiguous post-submit outcomes to remain accounted, never authorize a second paid test call.
- Planned repair: remove only authorization_failed from the zero-dispatch list and explicitly pin the conservative classification. All other zero-submit codes retain the source/adapter negative control.
- Scope: test/certification cost accounting; no provider, billing, entitlement or quota configuration changed. Dedicated repair follows source promotion, not a weakened assertion.

## B35-G-004 — P3 — ownership badges can remain visible beyond their known expiry

- Exact source: components/luxury/ProductCard.tsx renders hasVerifiedOwnership only on React renders; components/scan-results/PurchaseOptionsPanel.tsx does the same for primary rows. Neither schedules a refresh at verifiedUntil. An idle mounted result can therefore retain a verified badge after its supplied timestamp expires.
- Reproduction executed on convergence source: `node --test __tests__/ownershipBadgeExpiry.test.js` with controlled clock and real ProductCard. A valid displayed badge schedules zero expiry updates (expected one); ordinary unrelated card control passes. Evidence badge-expiry-before.log.
- Contract: expired ownership records must not continue producing verified badges. No claim of observed Production incidence (organic discovery is currently disabled/undeployed there).
- Repair queued: one shared expiry-refresh hook used at both rendering patterns, no new tokens/layout/copy, no extra network/provider call, stable hook order. Test the expiry-triggered update and unrelated card.
- Shared-file serialization: lead only; ProductCard and PurchaseOptionsPanel source promotion already committed before this repair starts. Separate stacked repair PR targets the convergence branch.

## Verified repair disposition (supersedes earlier queued/planned status)

No repair has merged. All six have source-level regression evidence; all remain unavailable in the authoritative release head until governed promotion and explicit owner approval where required.

| ID | Priority | Repair PR / source commit | Candidate promotion | Regression evidence | Current gate |
|---|---|---|---|---|---|
| B35-G-001 | P2 | #644 bd2827e7 | da480d9b / 84fe1c89 | discovery-before.log -> discovery-after.log, 22/22 | Owner approval; original pre-freeze target forbidden for Build 35; review #648 promotion |
| B35-C-001 | P1 | #645 8c86a9fd | e2395662 | disclosure/version before failure -> 39/39 | Owner explicitly requires merge approval; green CI snapshot pr645-ci-latest.json |
| B35-F-002 | P1 | #647 aedfbf78 | 95468f05 plus canonical manifest/privilege reconciliation 7624ab3f | outfit-gate-before.log -> outfit-gate-after.log 38/38 | Backend-authority PR CI/review; no production deployment |
| B35-C-002 | P1 | #649 ded0ee8d | 1dd0ac17 / 84e5a628 | four transfer wiring failures -> 41 passing receipt/import tests; 3/3 neutrality proof | Green backend CI; owner/governed backend promotion; no durable withdrawal claim |
| B35-COST-003 | P2 | #650 dae4ff07 | 1db2ef1c | test at vtoE2eUserGarmentProbe.test.js:598, 54/54 after conservative classification | Stacked PR inherits older convergence failures; replacement source in #648; no paid probe |
| B35-G-004 | P3 | #651 31d2f53c | 29ba460c | badge-expiry-before.log FAIL -> badge-expiry-after.log 25/25 | Ownership subsystem owner gate; stacked review source is #648 |

C-002 root cause/repair: verified actor must have an exact legal_acceptances ai_processing:v2_google_gemini receipt before any Gemini reservation or transfer. _shared/geminiConsent.ts rejects absent/old/foreign/wrong-schema receipts (403), backend lookup failures (503), and rechecks without a cache. Scanner commerce-only MODE B stays before this gate. Purchase import, outfit, chat (including Packing), and image inference are covered. This changes backend authorization behavior, explicitly flagged; no database policy/schema, subscription price or provider selection changed. Receipt disappearance/re-consent tests are not proof of an approved durable withdrawal workflow. Immutable legal receipts and the absence of a Gemini withdrawal authority require owner/legal resolution before universal consent certification.

F-002 root cause/repair: use the existing shared assertAccountActive authority, not the two-status local comparison that ignored lookup errors. The response adapter fails before request/provider work. Its shared import legitimately carries a larger static privilege footprint; the source inventory was reconciled rather than hiding those dependencies.

G-004 root cause/repair: mounted cards did not rerender at their supplied verification deadline. useOwnershipExpiryRefresh schedules a bounded expiry refresh, cleans up on unmount/supersession and is called unconditionally in ProductCard and PurchaseOptionsPanel. No ranking/layout/copy, provider request or visual primitive changed.

### Serialized candidate preparation / merge order

Preparation order (not merges): canonical mobile discovery source -> G-001 parsing -> canonical backend closures/migrations -> C-001 disclosure -> F-002 lifecycle -> C-002 transfer receipt -> COST-003 accounting -> G-004 expiry -> exact VTO scope provenance. Shared files are edited by the lead only. Backend F-002 precedes C-002 where both touch outfit index.ts. Candidate contains equivalent cherry-picked commits; individual PR commits are not misrepresented as merged. Proposed governed merge order is backend #647 then #649, owner-approved mobile #645 and reviewed #648 convergence; #644/#650/#651 must be explicitly dispositioned as provenance/superseded or retargeted under Build 35 governance, never merged into an unrelated authority to manufacture convergence.

## B35-B-004 ? P4 ? JSON null Scanner body escapes controlled input handling

- CONFIRMED: qa/security/edge-entrypoint-hostile.test.ts calls the real scan-identify handler with body null; one TypeError, zero provider dispatch and zero privileged writes. Evidence hostile-entrypoints-enabled.log / hostile-entrypoints-results.json. No service compromise, customer incidence or paid amplification demonstrated.
- Exact code argument: scan-identify/index.ts:1907 assigns req.json() without an object guard; v2Activation.ts:258 treats missing version as legacy; index.ts:1945 then dereferences body.mode. JSON null is valid JSON but not an object, so the parse catch does not contain it.
- Expected: controlled invalid-body response; actual: uncaught TypeError. Proposed smallest fix is an object/non-array guard immediately after parsing plus real-handler negative fixtures. Complexity low, shared backend scope, both platforms receive the same response.
- Safe P4 repair condition 4 fails: scan-identify is explicitly an owner-confirmation subsystem. Source repair is gated; priority is not inflated to escape the gate. Standalone hostile test remains red and report retains FAIL. No patch or schema/wire change has been made.

## CI/governance repairs (no invented product severity)

- #646 source-inventory terminology: exact historical evidence file classified, count reconciled with all original detector negative controls retained (7/7). Current evidence expansion must pass the same gate before ready-for-review.
- #648 migration fixtures: current authoritative ledgers verify four later migrations applied in both projects; fixed explicit source rosters and retained original frozen-snapshot controls (159/159 SQL/governance subset).
- #648 VTO scope: four exact files were already copied byte-equivalent from backend 3efcb6cb (original attempt settlement 34de6e0d, media validation 58ff6dc0). Added their individual manifest reasons/source, an exact canonical-byte parity test, and adjusted the static-test count 8 -> 9 solely for the added parity assertion. Live enforced scope now passes; all original refusal controls retained. Commit 72eee2fb.
