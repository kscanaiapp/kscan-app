# Build 29 iOS — P2–P5 Disposition Ledger

Source of findings: `BUILD29_IOS_PHASE1_AUDIT_LEDGER.md` (Phase 1 hostile audit, 137
findings, baseline `48731a2`). That ledger lives outside the repo, in the audit
session's scratchpad; its DEF ids are used verbatim here so the two can be read together.

Reconciled against **`f6c696d`**, i.e. the shared closure `3d216e0` plus the iOS
commits. Every P2–P5 finding is dispositioned; none is silently omitted.

## Disposition rule applied

| Severity | Rule |
|---|---|
| P2–P3 | strong presumption to fix if still real and user-facing |
| P4–P5 | fix when narrow, safe and meaningful |

Overriding constraint: **an iOS branch may not fork shared behaviour.** A defect in
shared React Native code affects Android identically, so fixing it here would create
the platform divergence this whole phase exists to prevent. The shared closure was
deliberately scoped to DEF-008/DEF-009 only, so every other still-real shared defect is
`DEFERRED_TO_SHARED` — confirmed, specified, and handed to shared authority rather than
patched on one platform. That is a routing decision, not a dismissal.

## Totals

| Disposition | Count |
|---|---|
| FIXED_AND_VERIFIED | 4 |
| ALREADY_RESOLVED | 9 |
| NOT_A_DEFECT | 4 |
| DEFERRED_TO_SHARED | 32 |
| OWNER_ACTION_REQUIRED | 12 |
| NONBLOCKING_HARDENING | 4 |
| DEVICE_TEST_REQUIRED | 1 |
| DEFERRED_WITH_REASON | 1 |
| **Total P2–P5** | **67** |

Counts are machine-checked against the tables below: every id from DEF-005 to DEF-071
appears exactly once.

Verification method: each finding's file/symbol signature was checked against the
current tree. Where a signature check is a proxy for behaviour rather than proof, the
row says so.

---

## P2 (8)

| ID | Finding | Disposition | Evidence / reason |
|---|---|---|---|
| DEF-005 | Onboarding "Continue with Apple" is a navigation no-op | **FIXED_AND_VERIFIED** | `onContinueApple` now runs `performAppleSignIn()`; success enters `continueAuthenticatedFlow`. 13 new tests. Commit `f6c696d`. |
| DEF-006 | Apple `fullName` requested but never captured | **FIXED_AND_VERIFIED** | `services/appleDisplayName.ts` writes via `buildSignupNameMetadata`; 11 tests. Commit `7c253ec`. Same root cause as DEF-005 (duplicate implementations) — closed structurally by the shared service. |
| DEF-008 | `navReady` poll gives up after 2 s → permanent boot spinner | **FIXED_AND_VERIFIED** | Shared closure `3d216e0`; deadline removed; 3 guards. |
| DEF-009 | No timeout on privacy bootstrap fetch → boot hang | **FIXED_AND_VERIFIED** | Shared closure `3d216e0`; `AbortController`, 10 s; 3 guards. |
| DEF-007 | No proactive content filtering on room images/messages (Apple 1.2 req #1) | **DEFERRED_WITH_REASON** | Confirmed absent: no client or service reference to `image_scan_verdicts`. Requires a new moderation provider + edge function/worker — an architecture decision explicitly out of this phase's scope, and out of the authorised shared closure. Apple 1.2 reqs #2 (report), #3 (block), #4 (contact) are met and verified reachable (Checkpoint E). **Owner must decide before submission whether req #1 is in scope for Build 29.** |
| DEF-010 | Scan Results V2 ignores the `priceDiscovery` freeze kill-switch | **DEFERRED_TO_SHARED** | Confirmed: no `useFeatureFreeze`/`priceDiscovery` in `ScanResultV2.tsx`, while `AnalysisCard.tsx` is gated. Shared component; one-gate fix specified. |
| DEF-011 | Reopened Recent Scan renders a degraded legacy surface | **DEFERRED_TO_SHARED** | Confirmed: `app/library.tsx` still reopens through `AnalysisCard`. Shared; full fix is a surface unification (MAJOR). |
| DEF-012 | Dressing-room canonical-item/commerce/dedupe flags off in every profile | **OWNER_ACTION_REQUIRED** | Confirmed: zero occurrences of `DRESSING_ROOM_CANONICAL_ITEM_V1` in `eas.json`. Code path exists and is tested; enabling is a governance/activation decision, not a repair. |

## P3 (14)

| ID | Finding | Disposition | Evidence / reason |
|---|---|---|---|
| DEF-013 | `signOut()` result never inspected; session survives on disk | **ALREADY_RESOLVED** | The user-facing defect is gone: `signOut` now unconditionally calls `clearPersistedAuthSession()` (KSB29-057, durable-logout shared repair), so an offline sign-out no longer restores the session on relaunch. The unread `{error}` return is cosmetic and carried at DEF-016. |
| DEF-015 | AI-output report shows "REPORT SENT" for unauthenticated no-op | **ALREADY_RESOLVED** | `AiOutputReportingContext.tsx:81` now gates on `isReportServerAccepted(attempt.value) ? 'success' : 'error'`. |
| DEF-019 | Hardcoded `platform: 'ios'` in shared scanner hook | **ALREADY_RESOLVED** | No `platform: 'ios'` literal remains in `hooks/useKScan.js`. |
| DEF-023 | Avatar tap acknowledgement is a dead visible control | **ALREADY_RESOLVED** | `getExpressionPresentation` is no longer absent from `StyleChatHeader.tsx`'s path; the dead-control signature does not reproduce. Runtime confirmation folded into the VoiceOver/device pass. |
| DEF-025 | Submitted build number will not be 29 (EAS remote autoIncrement) | **OWNER_ACTION_REQUIRED** | Confirmed: `appVersionSource: remote` + `autoIncrement`. Needs credentialed `eas build:version:get/set` pre-build. Deliberately not "fixed" in source — app.json is not the authority. |
| DEF-026 | No App Review demo account / review contact | **OWNER_ACTION_REQUIRED** | Reproduced by the project's own gate (`verify:apple-readiness` WARN). Real Guideline 2.1 bounce risk. Credentials must be entered in ASC, never committed. |
| DEF-014 | Delete Account invoke lacks session preflight | **DEFERRED_TO_SHARED** | Confirmed: no `resolveAuthenticatedFunctionSession` in `services/accountDeletion.js`. Shared service; helper exists and is used elsewhere. Cosmetic-copy impact only (expired token → generic error). |
| DEF-016 | Post-deletion signOut failure swallowed; notice destroyed | **DEFERRED_TO_SHARED** | Pairs with DEF-013; shared. Ledger itself counts it as P4. |
| DEF-017 | Confidence badge never renders (field-name mismatch) | **DEFERRED_TO_SHARED** | **Confirmed still present and 100% reproducible**: mapper writes `meta.confidenceScore` (`scanIdentificationMapper.ts:160`), consumer reads `meta.confidence` (`types.ts:250`), so the match badge never appears. One-line coalesce specified. Shared component — highest-value item on the deferred list. |
| DEF-018 | Camera-permission wall blocks gallery; dead "Grant Access" | **DEFERRED_TO_SHARED** | Confirmed: no `canAskAgain`/`openSettings` handling on the scanner permission wall. Shared. |
| DEF-020 | Commerce normalization drops offers at write time | **DEFERRED_TO_SHARED** | Confirmed: `SENSITIVE_URL_QUERY_KEYS` still nulls legitimate merchant URLs. Security-relevant policy revision, not a mechanical fix. |
| DEF-021 | Structured S7 advice metadata has no client consumer | **DEFERRED_TO_SHARED** | Confirmed: no advice-metadata consumer in `useStyleChat.ts`. Product decision (build UI vs. accept prose-only). |
| DEF-022 | Disjoint wear-event id namespaces | **NOT_A_DEFECT** *(Build 29)* | Wear is unreachable in Build 29 (`WEAR_TRACKING_ACTIVE = false`), so no user can produce the divergent ids. Must be resolved before Wear activation; recorded against Build 30. |
| DEF-024 | Offline consent check fails closed; returning user trapped | **DEFERRED_TO_SHARED** | Signature refactored since the audit; the fail-closed policy question is unchanged and shared. Needs a deliberate offline-consent policy, not a mechanical fix. |

## P4 (24)

| ID | Finding | Disposition | Evidence / reason |
|---|---|---|---|
| DEF-032 | Raw `Linking.openURL` on model-controlled commerce URL | **ALREADY_RESOLVED** | `PurchaseOptionsPanel.tsx:48` now guards with `isSafeCommerceUrl(option.productUrl)` before opening. Closed by the shared commerce-URL-safety repair. |
| DEF-039 | Dead-letter fallback reads a field the mapper never defines | **ALREADY_RESOLVED** | `recommendedProducts` is now the live `purchaseOptions` field per the mapper's own contract note; the fallback is no longer dead. |
| DEF-040 | Rich `buildScanTitle` output never persisted | **ALREADY_RESOLVED** | `buildScanTitle` is now wired through `scanIdentificationMapper.ts:20`. |
| DEF-029 | STAGING `content_reports` lacks `ai_output` target | **OWNER_ACTION_REQUIRED** | Environment drift (GP-006 inversion: prod has it, staging does not). Governed staging pipeline action. |
| DEF-033 | Production EAS profile declares no `environment` | **OWNER_ACTION_REQUIRED** | Confirmed missing. Deliberately **not** added: setting it injects EAS-dashboard variables into production builds, so it must be audited before it is switched on. Changing it blind is more release risk than the defect. |
| DEF-034 | Store metadata omits major features; "Initial iOS release" notes | **OWNER_ACTION_REQUIRED** | Marketing/legal copy decision (2.3.1 + 5.1.1 cross-check). |
| DEF-035 | Privacy manifest declares Analytics purposes while observability is OFF | **OWNER_ACTION_REQUIRED** | Requires reconciling manifest vs. actual behaviour vs. ASC answers — an owner declaration, not a code change. Note the readiness gate currently passes, so this is a truthfulness review, not a failure. |
| DEF-027 | Post-deletion signOut swallow + unconditional replace | **DEFERRED_TO_SHARED** | Same site as DEF-016. |
| DEF-028 | Deactivated user has no in-app path to `/account/restore` | **DEFERRED_TO_SHARED** | Confirmed: no `/account/restore` reference in `app/privacy.tsx`. Shared surface. |
| DEF-030 | Owner-resolution failure hides the Room Safety card | **DEFERRED_TO_SHARED** | Confirmed present. Safety-relevant: in image-only rooms a failed owner fetch removes report/block for the owner. **Highest-priority deferred safety item.** |
| DEF-031 | Signed-out universal-link viewer has no report path | **DEFERRED_TO_SHARED** | Confirmed: no sign-in-to-report CTA. Shared room surface. |
| DEF-036 | Gallery pick without media-library permission request | **DEFERRED_TO_SHARED** | Confirmed: no `photoLibraryAccess` use in `hooks/useKScan.js`. |
| DEF-037 | `shoppingMeta` dropped → zero-commerce undiagnosable | **DEFERRED_TO_SHARED** | Confirmed absent. Observability, not user-facing. |
| DEF-038 | `scanResultObject` built from mismatched field, never persisted | **DEFERRED_TO_SHARED** | Partially reconciled by the mapper's `purchaseOptions` contract; persistence half unresolved. |
| DEF-041 | Full closet inventory uploaded on every StyleChat send | **DEFERRED_TO_SHARED** | Confirmed: no capability gate in `useStyleChat.ts`. Bandwidth/privacy-adjacent; needs the DEF-057 capability echo first. |
| DEF-042 | `updateClosetItem` dead code; no edit surface | **DEFERRED_TO_SHARED** | Confirmed: no caller in app/components/hooks. Product feature (MAJOR). |
| DEF-043 | CPW split-brain: sanctioned projection has no caller | **NOT_A_DEFECT** *(Build 29)* | CPW is unreachable (zero `EXPO_PUBLIC_FREE_TIER_*` in dev/staging/production). Recorded against Build 30 with DEF-022. |
| DEF-044 | Signed-out closet renders always-failing WoreThis button | **NOT_A_DEFECT** *(Build 29)* | The control is inside a `WEAR_TRACKING_ACTIVE` gate, which is `false`, so it never renders. Re-test when Wear activates. |
| DEF-045 | iPad grids size for 3–4 columns but hard-render 2/row | **DEFERRED_TO_SHARED** | Confirmed: no `numColumns`/`flexWrap` in `app/library.tsx`. Real iPad quality issue (33–50 % dead width) and Apple reviews on iPad — but a layout restructure best done with DEF-046, and shared. |
| DEF-046 | Unvirtualized ScrollView over unbounded closet | **DEFERRED_TO_SHARED** | Confirmed: no `FlatList`/`FlashList` in `app/library.tsx`. Pairs with DEF-045. |
| DEF-047 | Reduce Motion ignored on scanner pulse/sweep | **DEFERRED_TO_SHARED** | Confirmed: no `useReducedMotion` in `ScanButton.tsx`/`useScanAnimation.js`. Accessibility; shared, and the repo already has the pattern. |
| DEF-048 | 15 files use Android-only `accessibilityLiveRegion` → silent on iOS VoiceOver | **DEFERRED_TO_SHARED** | Confirmed: 15 files. iOS-specific *manifestation* but shared code and 15 call sites — not narrow, and a per-site sweep is its own bounded task. |
| DEF-049 | Double-announce channel pair in StyleChat header | **DEFERRED_TO_SHARED** | Confirmed: `accessibilityLiveRegion` still present at `StyleChatHeader.tsx:202`. Pairs with DEF-048. |
| DEF-050 | Avatar expression pipeline never wired; shipped asset unreachable | **DEFERRED_TO_SHARED** | Confirmed: `resolveExpressionMode` has no caller. Wiring-vs-drop decision. |

## P5 (21)

| ID | Finding | Disposition | Evidence / reason |
|---|---|---|---|
| DEF-059 | Wear most/least-worn labels join against a partial page | **ALREADY_RESOLVED** | `titleSnapshot` now exists in `services/wearHistory.ts:38`, the fix the ledger specified. (Wear is also unreachable in Build 29.) |
| DEF-064 | `gaze: true` for avatar 02 with no renderer | **ALREADY_RESOLVED** | Now computed: `gaze: hasValidFacialOverlayPackage(avatarId, 'eyes')`. |
| DEF-071 | Recent Scans not reinstall/device-portable | **NOT_A_DEFECT** | Deliberate: `CLOUD_SAVED_SCANS_ENABLED` intentionally absent. Recorded as accepted state. |
| DEF-052 | Repo migrations missing production-deployed `ai_output` DDL | **OWNER_ACTION_REQUIRED** | Source-of-truth gap; file-add is mechanical but applying is governed. Sequenced before DEF-073. |
| DEF-055 | `submit.production.ios` lacks `ascAppId`/`appleId`/`appleTeamId` | **OWNER_ACTION_REQUIRED** | Same class as DEF-026; owner supplies ids. |
| DEF-056 | Silent 25-scan eviction with media unlink | **OWNER_ACTION_REQUIRED** | Confirmed: `MAX_SCANS = 25`. Product decision (notify / export / raise cap), not a bug fix. |
| DEF-060 | Flag rollback hazard strands the intake queue | **OWNER_ACTION_REQUIRED** | Flag-coupling/activation governance. |
| DEF-070 | Consent enforced client-side only | **OWNER_ACTION_REQUIRED** | Confirmed: no AI edge function checks `legal_acceptances`. Backend policy decision (shared guard or RLS); out of iOS scope. |
| DEF-051 | Auto-refresh never suspended/resumed on AppState | **DEFERRED_TO_SHARED** | Confirmed: no `AppState` use in `AuthSessionContext.tsx`. |
| DEF-053 | Message-report fallback launches `mailto:` | **DEFERRED_TO_SHARED** | Confirmed at `RoomMessagesPanel.tsx:445`. Dead-ends without a mail account. |
| DEF-054 | AI-report sheet unclosable while submitting | **DEFERRED_TO_SHARED** | Confirmed: no abort/timeout in `AiOutputReportingContext.tsx`. |
| DEF-057 | `closetIntelligenceCapabilities` echo has no consumer | **DEFERRED_TO_SHARED** | Confirmed. Blocks the clean fix for DEF-041. |
| DEF-058 | Free-tier closet tools fed Recent Scans | **DEFERRED_TO_SHARED** | Preview-only impact today (free-tier flags off in shipping profiles). |
| DEF-061 | Unconditional resize upscales small images | **DEFERRED_TO_SHARED** | Confirmed: `SCANNER_IMAGE_MAX_WIDTH = 896` applied unconditionally. One-line guard, but shared and on the scan path. |
| DEF-062 | Cue speech not stopped on navigation away | **DEFERRED_TO_SHARED** | Confirmed: no scoped `stopAvatarSpeechPlayback` cleanup. |
| DEF-063 | Identity switch from Home doesn't stop in-flight speech | **DEFERRED_TO_SHARED** | Shared service-level fix. |
| DEF-065 | No unhandled-promise-rejection tracking | **NONBLOCKING_HARDENING** | Confirmed absent. Diagnostics only; no user-visible behaviour. |
| DEF-066 | Auth-gate overlay lacks modal semantics; VoiceOver reaches behind | **NONBLOCKING_HARDENING** | Confirmed: no `accessibilityViewIsModal` in `app/_layout.tsx`. iOS-specific and narrow — but the overlay lives in the file the shared closure just changed, so it belongs to the next shared pass rather than a competing iOS edit to the same lines. |
| DEF-067 | Consent checkbox rows ~38 pt (<44 pt HIG) | **NONBLOCKING_HARDENING** | Confirmed at `app/onboarding/index.tsx:582`. On the legally load-bearing screen; shared component, one-line padding fix. |
| DEF-068 | 2/row hardcode in inspiration grid | **NONBLOCKING_HARDENING** | Same shape as DEF-045; travels with it. |
| DEF-069 | `Share.share()` without iPad popover anchor (×3) | **DEVICE_TEST_REQUIRED** → then fix | iOS-only behaviour. Confirmed present. The popover detaches on iPad, but the correct anchor cannot be validated without an iPad; fixing blind risks a worse regression on iPhone. Bundle with the iPad device pass. |

Also carried: **DEF-048/049 VoiceOver announcements** and **DEF-069 iPad share** should be
re-checked during the device pass — both are runtime-observable in ways source
inspection cannot settle.

---

## What an owner most likely wants next

Ranked by user impact among the deferred items, all specified and ready for a shared pass:

1. **DEF-017** — confidence badge never renders. 100 % reproducible, one-line fix, visible on the primary scan surface.
2. **DEF-030** — a failed owner fetch hides report/block in image-only rooms. Safety-relevant.
3. **DEF-010** — commerce freeze kill-switch not honoured on Scan Results V2.
4. **DEF-045 + DEF-046** — iPad dead width and unvirtualized closet, together.
5. **DEF-047 + DEF-048/049** — Reduce Motion and VoiceOver announcements.

And before submission, the owner-side set: DEF-026 (demo account), DEF-025 (build
number), DEF-055 (ASC ids), DEF-035 (privacy-manifest truthfulness), plus the Apple
production revocation promotion and HIBP.
