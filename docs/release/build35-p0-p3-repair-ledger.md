# Build 35 P0–P3 repair ledger (partial)

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

RP-108 forbids Build 35 ancestry on pre-freeze. Branch comparison is 5 pre-freeze-only / 512 integration-only commits. Merge preview has four conflicts. Await owner target resolution; do not silently supersede governance.

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
