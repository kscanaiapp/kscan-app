# Build 29 — iOS Stale-Tree Resurrection Audit

Current iOS candidate: shared Expo/React Native Build 29 staging candidate

Audited application SHA: `68421a1`

Initial staging SHA: `d56565ae6a90fc8baf9cfd10b022a786f8ef9675`

## Provenance verdict

`STALE_TREE_FIXED`

The iOS candidate had the same class of failure as Android. This was not established by branch naming or HEAD ancestry alone: the actual current files, governing commits, SHA ancestry, stable patch IDs, and final semantic implementations were inspected.

The exact promotion boundary is `8cbb2e6` (`chore(staging): port staging security/deploy infrastructure onto production baseline`). The current staging path left common base `5c761ba7` through that baseline port and continued without the approved iOS, consent, Apple-revocation, or Elise lines. In other words, the integration selected a stale application tree; the approved work was not later deleted because it was never admitted to the promoted staging ancestry.

The Android approved line `origin/integration/android-build28-final-v1` at `42829f5` contains `07b47fd`; its merge-base with the original staging candidate was only `e394261`. This corroborates the same promotion-omission class.

## Approved fixes checked

| Approved behavior | Governing commit | Stable patch ID | Exact SHA ancestor at initial candidate | Equivalent patch at initial candidate | Semantic implementation at initial candidate | Semantic implementation after repair |
| --- | --- | --- | --- | --- | --- | --- |
| WELCOME: Android AI consent contract | `07b47fd` | inspected governing patch | NO | NO | NO | YES (`e9afbad`) |
| WELCOME: iOS/shared mirror | `38787ae` | inspected governing patch | NO | NO | NO | YES (`e9afbad`) |
| IOS28-IPA-001 / GP-006 in-app AI reporting | `04070ec` | `c3468dd4496f1f8e0e7d0127cf21396314cf5e0d` | NO | NO | NO | YES (`3360f2d`) |
| IOS28-IPA-002/003 privacy manifest and foreground-only location | `2f338bd` | `7b84316d61e74691efae229ebb68e30901ba3727` | NO | NO | NO | YES (`3360f2d`) |
| IOS29-NEW-001/002 TextScan reporting and Elise voice gate | `b363f8e` | `ad6471b9decd34ad5654fa6e5c80da561d49733d` | NO | NO | NO | YES (`3360f2d`) |
| iOS containment contracts | `1f70ce7` | `ac1419768c6ab95b6a21e30a4106556645787404` | NO | NO | NO | YES (`3360f2d`) |
| IOS29-NEW-003 Apple authorization-code/revocation | `e369fca` | `de48c17c4ad4084af9b0eb0f71676b9021f1ada1` | NO | NO | NO | YES IN SOURCE (`3360f2d`) |
| ELISE attach-first invariant | `1ace13f` | `f3dbbef2b0a04cbdf6b3e3217b3d64ecbaa2c89d` | NO | NO | NO | YES (`68421a1`) |
| ELISE active-item context | `6cb0e22` | `68743d2625243b1f5f8b9486552da87757a81140` | NO | NO | NO | YES (`68421a1`) |
| ELISE fashionContextV2/follow-up actions | `9296540` | `1dbaf8ff1451db83011dfae3824f2b5e0a73111d` | NO | NO | NO | YES (`68421a1`) |
| ELISE optional Closet save | `35b8f8f` | `d35c732235fab82bdefa9c14650b7a594f3d4c61` | NO | NO | NO | YES (`68421a1`) |
| ELISE Style This Item/Dressing Room anchor | `bc81871` | `27b80ea22f7c88abf959771dcb34b510eee1a9a6` | NO | NO | NO | YES (`68421a1`) |
| ELISE final hardening/actor isolation | `cc17a3c` | `e3d43f5727c3f0891cf125c087e685003cad5299` | NO | NO | NO | YES (`68421a1`) |

`git cherry` reported each approved patch as absent (`+`) against the initial candidate. Matching filenames and tests were not accepted as proof; the production implementations were inspected. Before rebase, the 30 restored Elise target files were byte-equal to the approved final semantic target at `cc17a3c`. The rebase onto `2cc33a8` was conflict-free and changed only the base's protected release-infrastructure history.

## Required semantic verification

| Area | Required behavior | Final source result | Activation/runtime result |
| --- | --- | --- | --- |
| WELCOME TREE | Exact AI disclosure | PRESENT | Emulator PASS |
| WELCOME TREE | Independent affirmative AI checkbox | PRESENT, unchecked by default | Emulator PASS |
| WELCOME TREE | `ai_processing:v1` ledger persistence | PRESENT | Live staging PASS |
| WELCOME TREE | Returning-user enforcement, including missing-AI row | PRESENT | Emulator/live staging PASS |
| WELCOME TREE | Terms/Privacy/18+ four-way gate | PRESENT | Emulator PASS |
| GP-006 | Scan and Elise AI response reporting | PRESENT | Protected backend migration BLOCKED |
| TextScan | AI response reporting | PRESENT | Protected backend migration BLOCKED |
| Privacy | Expanded manifest/config generation | PRESENT | Static contract PASS |
| Location | Foreground-only; no Always descriptions | PRESENT | Static contract PASS |
| Elise voice | Capability gate | PRESENT | Focused contract PASS |
| Apple auth | Entitlement/config and authorization-code capture | PRESENT | Source/contract PASS |
| Apple deletion | Credential linkage and revoke-before-delete seam | PRESENT | Staging functions/migration BLOCKED |
| Google/email auth | Existing behavior preserved | PRESENT | Android staging auth PASS; physical iOS NOT_VERIFIED |
| Session isolation | Actor/account boundaries | PRESENT | Consent actor-isolation live proof PASS |
| Elise | Attach-first invariant | PRESENT | Focused contracts PASS |
| Elise | Active-item context and `fashionContextV2` continuation | PRESENT | Focused contracts PASS |
| Elise | Follow-up chips and optional Closet save | PRESENT | Focused contracts PASS |
| Elise | Style This Item and Dressing Room anchor handoff | PRESENT | Focused contracts PASS |

## Concrete additional same-boundary evidence

The mandated high-risk files exposed one additional, bounded stale family: `SecondhandShelf`, `SneakerMatchCard`, and `SimilarFindsShelf` had lost the newer guarded commerce-destination opening seam. This is concrete patch/file evidence from the same promotion omission, so it was restored in `3360f2d` and covered by 10/10 URL-safety tests.

No unrelated historical feature recovery was performed.

## Offending integration boundary

| Field | Value |
| --- | --- |
| Common approved/staging base | `5c761ba7` |
| Stale baseline promotion | `8cbb2e6` |
| Initial current candidate | `d56565a` |
| Failure mode | New approved implementation → separate approval lines → staging baseline promotion retained older application files |
| Conventional later revert found | NO |
| Candidate-selection/promotion omission found | YES |

## Files resurrected or semantically stale

High-risk affected families included:

- `app/onboarding/index.tsx`, `constants/legal.ts`, `services/legalAcceptance.ts`, `contexts/AuthSessionContext.tsx`
- `app/auth/index.tsx`, `services/appleCredentialLink.ts`, Apple revocation processor/client/function/schema source
- `app.json`, generated privacy/location configuration, root layout reporting provider
- `app/text-scan/index.tsx`, Scan/StyleChat reporting surfaces and reporting context/services
- `components/stylist/PersonalizeStylistModal.tsx` and voice-capability contracts
- `app/style-chat/[sessionId].tsx`, Elise attachment/active-item/follow-up services and hooks
- `services/privateDressingRoomChatHandoff.ts`, Closet progression telemetry and related types
- `components/SecondhandShelf.tsx`, `components/SneakerMatchCard.tsx`, `components/scan-results/SimilarFindsShelf.tsx`

## Classification

```text
STALE-TREE REGRESSION CLUSTERS FOUND: 4
P0: 0
P1: 3
  - Welcome/AI consent and ledger enforcement
  - iOS privacy/reporting/Apple-auth compliance family
  - Elise image-styling continuation family
P2: 1
  - guarded external-commerce destination family
P3: 0

P0 APPLICATION DEFECTS REMAINING: 0
P1 APPLICATION DEFECTS REMAINING: 0
```

## Fix commits

- `e9afbad` — Welcome/AI-processing consent contract
- `3360f2d` — iOS compliance, GP-006/TextScan reporting, voice gating, Apple linkage/revocation source, guarded URLs
- `68421a1` — final approved Elise continuation loop and actor isolation

The repairs were semantic integrations, not blind cherry-picks, so current destination changes were preserved.

## Tests

- Consent/compliance focused tests: 115/115 PASS.
- Elise focused tests: 153/153 PASS before conflict-free rebase.
- Post-rebase integrated focused selection: 185/185 PASS.
- External URL safety: 10/10 PASS.
- Apple linkage/revocation/reporting/privacy/voice contracts: PASS within the focused sets.
- Backend Deno tests: 23 files, 242/242 PASS.
- TypeScript: application tree PASS before upstream rebase; current repository FAIL is confined to newly merged protected `security/release/*` scripts from PR #109.
- Full aggregate: 5,355 tests, 5,169 pass, 127 fail; fail-closed protected release inventory/baseline ownership is documented in the system report.
- Physical iOS/TestFlight execution: NOT_VERIFIED in this Windows/Android audit environment.

## Required final report

```text
IOS STALE-TREE AUDIT

Current iOS candidate: Build 29 shared Expo/React Native staging candidate
Current SHA: 68421a1

Approved fixes checked:
- IOS28-IPA-001
- IOS28-IPA-002
- IOS28-IPA-003
- IOS29-NEW-001
- IOS29-NEW-002
- IOS29-NEW-003
- Welcome Tree consent contract
- Elise attach-first/active-item/fashionContextV2/follow-up/Closet/Dressing Room loop
- Apple, Google/email auth and session isolation

Exact SHA ancestor: NO for every governing approved commit in the initial candidate
Equivalent patch: NO for every governing approved patch in the initial candidate
Semantic implementation present: NO initially; YES after the three restoration commits

Stale-tree regressions found: 4 clusters
P0: 0
P1: 3
P2: 1
P3: 0

Offending integration boundary: 8cbb2e6 from common base 5c761ba7
Files resurrected: consent, auth/Apple, privacy/location, reporting/TextScan/voice, Elise loop/handoff, and three guarded commerce exits

Fix commits: e9afbad, 3360f2d, 68421a1
Tests: focused PASS; backend PASS; physical iOS NOT_VERIFIED; protected activation blockers declared

IOS PROVENANCE VERDICT: STALE_TREE_FIXED
```
