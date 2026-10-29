> ACTIVE CONTINUATION CHECKPOINT: authorities independently verified c86bf3d0/f4df2a5a, nine prior repairs merged;110archives verified. New PostHog70/70 and discovery7/7 source probes; current Scanner nullP4 remains reproduced. H001 UNCONFIRMED/legal authority pending; H003 native accuracy not certified/ADB0targets. All3041 outstanding cells now have execution dispositions (300N/A,2443local,285Staging,8sandbox,4native,1artifact); classification is not coverage completion. See [high-risk privacy evidence](build35-high-risk-privacy-verification.md) and current checkpoint. Full campaign remains INCOMPLETE; no newP0-P3 finding or runtime repair.

> **CURRENT STATUS (2026-10-29, supersedes SHA/merge statements below):** the nine P0–P3 repairs are merged under owner approval. Build 35 authority `integration/build35-v1-convergence` = `c86bf3d052806c6105ce7830a03ac2b1501d34a1` (PR #648; tree identical to candidate `751e3815`). Backend authority `rebuild/backend-authority-v2` = `f4df2a5a525fb7ee1b22f16c9a4bc55c1c8831af` (PRs #649 → #653 → #647). #644/#645/#650/#651/#652/#654/#655 are superseded by #648. Final-SHA validation: Node 11,336/0 fail/98 skip, TypeScript and six gates exit 0 at `c86bf3d0`; Deno 1,515/0 at `f4df2a5a`. No deployment, migration application, flag change or build occurred; migration `20261029184000` remains unapplied. See [final source convergence](build35-final-source-convergence.md). Open items (B35-B-004, H-001, H-003, the probe matrix and device/artifact phases) are unchanged.

> FINAL STOP-STATE: Latest complete full Node validation:751e3815,11336 passed/0failed/98skipped,total11434; log candidate-node-permission-matrix-final.log and exit0 captured. Runtime source is unchanged froma376f2f7 (TypeScript and six source gates0), backend unchanged from53b93724 (1531/0failed). No combined-SHA runtime claim.

> OWNER STOP: current candidate751e3815; PR654 now36020928 with29/29 focused tests after12 added failure injections; runtime repair source unchanged. Source-prepared9,merged0,deployed0. Exact wording APPROVED, merging/deployment not approved. Latest complete Node/source gates ata376f2f7; collect pending751e3815 rerun before certifying.

# Build35 current repair ledger

Current disposition supersedes the dated discovery/planned/blocked entries preserved below. Nine confirmed P0-P3 findings: P1=4,P2=3,P3=2; P0=0 confirmed. Nine source repairs prepared, zero merged, zero deployed. One owner-gated P4 remains unimplemented. Owner authorized durable withdrawal SOURCE work; wording is owner-approved; merge remains gated. No defect is declared operationally repaired.

| Order | ID / priority | Separate repair PR / original source | Prepared candidate commit | Regression / current gate |
|---|---|---|---|---|
|1|G-001 P2|644 bd2827e7|da480d9b,84fe1c89|22/22; owner approval, review promotion648 rather than Build34 target|
|2|C-001 P1|645 8c86a9fd; decoder backport fb08e845|e2395662|39/39; explicit owner merge approval; latest CI pending after decoder|
|3|F-002 P1|647 aedfbf78; decoder backport9ab4a2da|95468f05,7624ab3f|38/38; promotion artifact/CI rerun clearance required|
|4|C-002 P1|649 ded0ee8d; decoder backport6f768494|1dd0ac17,84e5a628|41 gate tests plus3 source-neutrality controls; required CI and coordinated consent rollout|
|5|COST-003 P2|650 dae4ff07|1db2ef1c|54/54; conservatively retains ambiguous paid dispatch; old stacked CI red, candidate validation separate|
|6|G-004 P3|651 31d2f53c|29ba460c|Controlled mounted before failure,25/25 after; old stacked CI red, final candidate tests pass|
|7|C-004 P3|652 fc503112; decoder backport1c3433e2|50088fd0|Three actual provider/client/engine missing-timing failures before;85 focused after; no physical-device lip-sync PASS|
|8a|C-005 P1 backend|653 5b5c471a; decoder backport394645c2|40b0d52e|41 gate/108 SQL-governance focused;1508 backend and8533 Node source-branch passes; new migration unapplied|
|8b|C-005 P1 client|654 a5fb7f75; decoder backport26c06e73|53b93724|17/17 actor/revision/error/duplicate/platform cases; Owner wording APPROVED; merge approval required|
|9|F-006 P2|655 37a519bc,b4ba29c8|9f0eb834,a376f2f7|3/3 actual query consumer/provenance tests; clean install; dependency gate PASS, final Node11324/0fail/98skip, TypeScript0|

No shared-file parallel edits. Lowest-risk independent changes were committed before serial consent/index/manifest changes; table is the candidate preparation order, NOT a merged-PR history. Candidate648 is a376f2f7fc6694b30e5623998a56522eccf20280, clean and pushed. Authoritative integration remains65a1e7cd. Explicit644/645 approval cannot be bypassed by merging648. Older stacked650/651 CI inherits earlier base failures; passing candidate does not mark those checks green or authorize red merges.

## Latest withdrawal repair evidence

C-005 root cause is a positive immutable receipt treated as current permission. Source migration supabase/migrations/20261029184000_gemini_processing_permission.sql:1-74 adds own-read RLS, no client table writes, expected-actor/revision RPC fences, retained receipt authority for grant and cascade deletion. Server _shared/geminiConsent.ts:36-46 rechecks live state before each model transfer and fails closed on missing migration/backend/malformed/foreign state. An absent override preserves a valid current receipt; an explicit withdrawal denies403. It does not recall already-dispatched data.

Client services/geminiProcessingPermission.ts:7-32 validates actor/version/type/revision/ack with timeout; components/settings/GeminiProcessingSettingsSection.tsx:11-43 uses actor-generation fences, synchronous double-submit lock and unknown+retry after ambiguous save. Existing app/privacy.tsx:749 mounts it; no new screen/tab/modal/library. Draft copy is visible in654 for review. Tests use actual SQL migration/PGlite plus platform-injected clients/components. Withdrawal, re-consent, legacy/no receipt, A/B IDOR, direct-write denial, anonymous caller, concurrent stale grant, duplicate withdrawal, account cascade, account switch, write401/timeout/wrong response, no optimistic success and both platform paths are executable evidence. No Production migration or feature activation.

Source/runtime distinction: new migration declared KNOWN_FUTURE_UNAPPLIED in both authorities. Required path is protected migration approval -> matching backend rollout -> client version/copy rollout with existing-user re-consent -> synthetic authorized staging E2E -> platform artifacts. Deploying v2 enforcement before supported clients can acknowledge v2 is a rollout risk, not silently authorized here.

## Latest decoder repair evidence

Before command node --test __tests__/uriDecoderSecurity.test.js on vulnerable locked consumer fails bounded replacement assertion:1031 replacements on7171 bytes. After official0.5.1 algorithm compatibility patch:5 replacements,3/3 tests. Full candidate a376f2f7:11324 passed,0 failed,98 skipped; npx tsc --noEmit exit0; six source gates including dependency reachability exit0. Captured uri-decoder-before.log,uri-decoder-after.log,candidate-node-decoder-final.log and candidate-source-gates-decoder.json. No SDK upgrade, contract change or advisory exception. Algorithm source SHA is pinned and tested after reversing only module export/legacy-plus adapters; MIT retained.

## Historical discovery/reproduction entries (status statements superseded above)

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

## B35-C-004 ? P3 ? normalized absent provider timing starts fabricated lip movement

- Confirmed by real provider adapter -> real client -> real AvatarRuntime fixture. Three tests (empty/missing/malformed timing) fail before the patch; frames include closed,halfOpen,open,closed,closed even though timing evidence is absent. Evidence speech-empty-timing-before.log. No physical animation or latency incidence claim.
- Exact source: supabase/functions/stylist-speech/elevenLabsClient.ts normalizes unusable alignment to null; services/avatars/stylistSpeechClient.ts:58 previously returns null unchanged; services/avatars/engine/runtime/AvatarRuntime.ts:280 selects speaking-fallback for null. The isolated engine empty-array test was insufficient because the actual boundary loses that distinction.
- Contract: successful audio with empty timestamps must not animate unsupported lip sync. Root cause is the cross-layer representation of absent evidence, not ElevenLabs provider failure.
- Repair: normalize null timing to the engine's existing explicit empty timeline in the client; valid audio is retained, lips remain closed. Valid aligned timing and direct malformed response rejection retain their existing behavior. No backend API, wire schema, provider, copy, platform divergence, animation token or consent policy change.
- Dedicated branch repair/build35-speech-empty-timing-20261029, commit fc503112. Focused speech/engine/consent/interruption/recovery 85/85 passed, zero skips. PR pending creation at this checkpoint. Candidate serial promotion follows all prior shared-file repairs. Hardware sync remains NOT TESTED; no TestSprite deployment exists.

## B35-C-005 ? P1 ? Gemini consent has no durable withdrawal authority

- CONFIRMED code/contract contradiction: _shared/geminiConsent.ts:requireGeminiConsent reads only legal_acceptances for the exact actor/version. It does not read revocation state. services/thirdPartyAiConsent.ts:THIRD_PARTY_AI_FEATURES is a closed union containing only virtual_try_on and elise_speech, so its withdrawal implementation cannot revoke Gemini processing. services/legalAcceptance.ts:recordLegalAcceptances only inserts idempotent receipts. 20260617000001_create_legal_acceptances.sql:56-57 grants authenticated select/insert, not receipt mutation/deletion; the later restored AI type does not provide withdrawal. No durable Gemini revocation control was found in the actual privacy/onboarding routes.
- Stated contract: campaign mandatory consent withdrawal/re-consent, plus Apple's current App Review Guideline5.1.1(ii) requires accessible withdrawal. Official source checked: https://developer.apple.com/app-store/review/guidelines/#data-collection-and-storage . No invented universal24h response rule or vendor contract.
- Reproduction by source: accept current ai_processing receipt; no supported Gemini revoke call exists; every subsequent server check reads the same positive immutable receipt. Local VTO/speech withdrawal cannot affect that query. PR649's simulated receipt-disappearance test is not proof of a real withdrawal path.
- Root cause: immutable legal evidence was reused as current permission authority without a revocable state model. Material consent gap; not downgraded to an unconfirmed privacy concern. No claim a customer withdrew and was observed leaking data.
- Proposed complete repair: preserve immutable receipts; introduce actor-bound revocable consent state; recheck before all four Gemini transfers; add withdrawal/re-consent to the existing Privacy settings; verify stale/failed state and account switch; legal-reviewed copy. Requires source/data/UI changes beyond safe polishing.
- BLOCKED ON OWNER DECISION: user UX prohibitions forbid a new consent flow without owner decision. Asynchronous request asks authorization for the existing-Privacy-setting/durable-state repair and separate legal-copy/merge review. No dependent source work or Production mutation while pending. Other audit/CI work continues.

## B35-F-006 ? P2 ? shipped navigation query decoder has input-driven denial of service

- CONFIRMED exact contract/source: npm audit identifies decode-uri-component0.2.2 in the committed lock; query-string/index.js requires that decoder, and @react-navigation/core/src/getStateFromPath.tsx:750 calls queryString.parse on deep-link query input. Expo Router is imported by shipped routes. Dependency reachability correctly rejects a build/dev-only exception for that live path.
- Primary advisories GHSA-vcc3-ghjq-m6fr (recursive/exponential fallback) and GHSA-qr28-fpjm-wq7f (quadratic whole-string replacement) affect the installed version; patched upstream0.5.1 is ESM-only, while this SDK's query-string consumer requires a CommonJS callable. Blindly overriding to the registry ESM release can break navigation. Sources: https://github.com/advisories/GHSA-qr28-fpjm-wq7f and https://github.com/SamVerschueren/decode-uri-component/releases/tag/v0.5.1 .
- Scope/impact: input-driven JS CPU/availability, not credential disclosure or remote code execution. No attack sent to Production or a customer's device; physical Hermes timing remains unverified. P2 follows actual shipped parser reachability, not a CVSS label alone.
- Dedicated branch/worktree repair/build35-uri-decoder-dos-20261029 at C:/b35decode1030, based53b93724. Repair in progress: preserve Expo54/React Navigation versions; use exact upstream patched algorithm with documented CommonJS/legacy-plus compatibility and MIT license; verify deterministic replace-call bound, legitimate query decoding, source provenance, locked resolution and unchanged dependency gate. No broader security exception.
- Existing CI failures on #646/#648/#652/#653 are now additionally blocked by this newly ingested advisory; prior green checks are time-specific, not proof the new advisory was handled.

Owner update: exact PR654 Gemini control wording APPROVED; this does not authorize merging or deployment. Broader Terms/Privacy/store disclosure reconciliation remains a separate legal handoff.
