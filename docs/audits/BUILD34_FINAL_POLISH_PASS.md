# Build 34 → 1.1.0 — Final Product Polish Pass

| Field | Value |
| --- | --- |
| Base branch | `release/build34-1.1.0-convergence` |
| Base SHA | `52ad2ad5466357b121929228b77ff7b14813ac77` (verified at start) |
| Polish branch | `polish/build34-final-polish-v1` |
| Method | `SOURCE-DERIVED UX REVIEW` (no simulator/emulator/device run in this pass) |
| Date | 2026-09-30 |
| Scope | One bounded sweep; K+ journey first; then surfaces in the brief's order |

**Totals.** 28 findings (POLISH-001 … 028). Defects: P0 0 · P1 0 · P2 5 · P3 16.
FIXED 13 (P2 5: 001, 002, 005, 009, 013 · P3 8: 003, 006, 007, 008, 012, 014, 015, 016).
REVIEWED-NOT-CHANGED 9 (P3: 004, 017, 018, 019, 020, 021, 026, 028; prior decision: 025).
OBSERVATION 4 (022, 023, 024, 027). OWNER_DECISION_REQUIRED 2 (010, 011 — K+ feature truth).
Open: P0 0 · P1 0 · P2 0 · P3 8 (documented below).

Evidence labels: `SOURCE_INFERRED` (read from source), `SOURCE_TESTED` (behaviour executed in a
node:test harness against the real module), `DEVICE_QA_REQUIRED` (cannot be certified from source).
No finding in this ledger is labelled `SIMULATOR_VERIFIED` or `EMULATOR_VERIFIED`: none was run.

---

## 1. Surface coverage

| Surface | Reviewed | Findings | Evidence | Status | Physical QA |
| --- | --- | --- | --- | --- | --- |
| K+ journey (gates, sheet, onboarding step, Account row) | Yes | 001–008, 010, 011 | SOURCE_TESTED / SOURCE_INFERRED | REVIEWED_WITH_FINDINGS | Yes |
| Navigation / shell / global states (`app/_layout.tsx`, Home) | Yes | 006, 020 | SOURCE_INFERRED | REVIEWED_WITH_FINDINGS | Yes |
| Scanner (`app.js`, `components/scan-room/*`) | Yes | 009, 022 | SOURCE_INFERRED | REVIEWED_WITH_FINDINGS | Yes |
| Multi-item / multi-image scanning | Yes | — (Lane A six-state truth confirmed) | SOURCE_INFERRED | REVIEWED_CLEAN | Yes |
| Text Scan | Yes | 012 | SOURCE_INFERRED | REVIEWED_WITH_FINDINGS | No |
| Voice Scan | Yes | 005, 016 | SOURCE_TESTED | REVIEWED_WITH_FINDINGS | Yes |
| Commerce / Product Shelf / retailer actions | Yes | 006, 009, 028 | SOURCE_INFERRED | REVIEWED_WITH_FINDINGS | Yes |
| Recent Scans | Yes | 009 | SOURCE_INFERRED | REVIEWED_WITH_FINDINGS | No |
| Saved (Saved Looks / saved scans) | Yes | — | SOURCE_INFERRED | REVIEWED_CLEAN | No |
| Smart Closet | Yes | 021 | SOURCE_INFERRED | REVIEWED_WITH_FINDINGS | No |
| Closet Intake / Batch Review | Yes | — | SOURCE_INFERRED | REVIEWED_CLEAN | Yes |
| Mirror Selfie | Yes | — | SOURCE_INFERRED | REVIEWED_CLEAN | Yes |
| Cloud Closet (sync / cross-device restore) | Yes | — (no customer-facing surface; background engines) | SOURCE_INFERRED | REVIEWED_CLEAN | Yes |
| Signature Style | Yes | 013 | SOURCE_TESTED | REVIEWED_WITH_FINDINGS | Yes |
| Elise | Yes | 025 | SOURCE_INFERRED | REVIEWED_CLEAN | Yes |
| Wardrobe Concierge | Yes | 023 | SOURCE_INFERRED | REVIEWED_CLEAN | Yes |
| Packing Intelligence | Yes | 010, 017 | SOURCE_INFERRED | REVIEWED_WITH_FINDINGS | Yes |
| Weather-aware styling (Today with Elise) | Yes | — | SOURCE_INFERRED | REVIEWED_CLEAN | Yes |
| Smart Watchlist | Yes | 006, 011 | SOURCE_INFERRED | REVIEWED_WITH_FINDINGS | Yes |
| Notifications | Yes | 011 (alerts depend on worker) | SOURCE_INFERRED | REVIEWED_WITH_FINDINGS | Yes |
| Virtual Try-On | Yes | — (consent inline, live switch gates advertising) | SOURCE_INFERRED | REVIEWED_CLEAN | Yes |
| Shared Dressing Rooms | Yes | 019, 020, 026 | SOURCE_INFERRED | REVIEWED_WITH_FINDINGS | Yes |
| Messaging / reactions | Yes | — | SOURCE_INFERRED | REVIEWED_CLEAN | Yes |
| Saved Looks | Yes | — | SOURCE_INFERRED | REVIEWED_CLEAN | No |
| Reporting / moderation / blocking | Yes | 015 | SOURCE_INFERRED | REVIEWED_WITH_FINDINGS | Yes |
| K+ gated surfaces (cross-feature) | Yes | 005, 006, 010, 011 | SOURCE_TESTED | REVIEWED_WITH_FINDINGS | Yes |
| Account / auth customer states | Yes | 002, 014 | SOURCE_TESTED | REVIEWED_WITH_FINDINGS | Yes |
| Empty / loading / error / retry states | Yes | 001, 002, 012, 028 | SOURCE_TESTED | REVIEWED_WITH_FINDINGS | Yes |

Every surface in the brief's list is present in this tree; none was skipped.
`SURFACE_COVERAGE_COMPLETE=YES`.

A source-level accessibility scan (`TypeScript` AST over all 184 `app/` + `components/` TSX files)
listed every `Pressable` / `Touchable*` with no accessible name and no text child, and every one with
no role. Results are folded into 013, 014, 019.

---

## 2. K+ mode (established from this tree)

```text
KPLUS_MODE=COMPLIMENTARY_ACTIVATION
PAID_PURCHASE_FLOW_PRESENT=NO
COMPLIMENTARY_ACTIVATION_PRESENT=YES
KPLUS_ONBOARDING_PLACEMENT=Onboarding step 6 (after auth, terms and permissions): components/kplus/KPlusActivationStep.tsx
KPLUS_ACCOUNT_ENTRY_PRESENT=YES (Privacy/Account screen "K+" row, app/privacy.tsx)
KPLUS_ENTITLEMENT_SOURCE=server row public.user_entitlements (RLS-scoped read) + kplus-activate function, via services/kplus/kplusClient.ts; client re-derives expiry, never grants
```

Evidence: no purchase SDK in `package.json`; the only "RevenueCat" string in client source is a comment
in `PermissionsStepV1.tsx`. Every activation path calls `activateKPlus()` → server. Copy states
"complimentary", "No payment is required", "You will not be automatically charged".
The implementation is internally consistent; this is not `MIXED_OR_TRANSITIONAL`.

---

## 3. K+ journey review

**Moment 1 — first encounter.** A free user meets K+ at: the Home Voice Scan pill (`K+` badge),
Home "PACK FOR A TRIP" → Packing gate ("UNLOCK WITH K+"), Home WATCHLIST tile, Watch buttons on
commerce rows, "TRY IT ON · K+", the Text Scan Voice block, the onboarding Microphone card, and the
onboarding activation step. The free path stays visible everywhere (no core surface is hidden). Gaps:
the Voice Scan surfaces said "Upgrade to K+" in a build with nothing to buy (→ 005), and the Watch
controls gave no sign that a tap opens K+ (→ 006). The shared sheet does not name Packing or
Watchlist when opened from them because the catalog deliberately does not advertise capabilities the
server is not known to serve — that is the feature-truth question in 010/011, not a copy defect.

**Moment 2 — activation.** States reviewed: idle, loading, resolving, unavailable, error, retry,
success, already-entitled, campaign-consumed. The onboarding step already honoured
`RESOLVING != FREE`. The shared sheet and the Account row did not (→ 001, 002). Activation success is
never claimed before the server row arrives (`activateKPlus` → `setSnapshot` from the server row;
`campaign_consumed` short-circuits before any success signal). No duplicate-tap path: the Activate
button is `loading`-disabled during the request.

**Moment 3 — post-activation value.** From a gate, the sheet flips to its activated state and Done
returns the user to the gate, which re-renders unlocked in place (Packing form, Watch flow, Voice
Scan). The activated state did not say what changed (→ 003). From onboarding, success routes to
Home, where the Voice Scan pill reads INCLUDED; there is no visible confirmation screen (→ 004,
reviewed-not-changed).

**Moment 4 — cross-feature consistency.** Naming ("K+", "K+ Early Access"), lock presentation
(`· K+` suffix on VTO), `resolving` handling (every gate consumer routes through `KPlusGate`'s
`resolving`) and refresh (store + foreground refresh) are consistent. Inconsistencies fixed: 005, 006.

**Moment 5 — membership management.** Complimentary only; no subscription language exists or was
added. Expired copy says "There is no charge and nothing to cancel" (sheet, onboarding, and now the
Account row, 008). No urgency, scarcity, countdown or trial wording found (existing tests pin this).

---

## 4. Feature-truth table (A4)

Server facts are carried forward from the 2026-09-24 read-only production audit. **They were not
re-read in this pass**: a read-only production `app_config` query was denied by the session's
permission policy, and Edge Function switches are secrets that SQL cannot see.

| K+ Feature | Client Present | Intended Enabled State (production-certification) | Backend/Service Reachable | Journey Truthful |
| --- | --- | --- | --- | --- |
| Voice Scan | Yes | `EXPO_PUBLIC_VOICESCAN_ENABLED=true` | On-device STT + text-search backend (confirmed 2026-09-24) | YES (device QA pending) |
| Virtual Try-On | Yes | `EXPO_PUBLIC_VTO_UI_ENABLED=true` | Live `vto_generation` switch on at 2026-09-24; advertising follows the live switch; generation unproven | YES (advertising is live-gated; generation needs device QA) |
| Packing Intelligence | Yes | `EXPO_PUBLIC_PACKING_INTELLIGENCE_V1=true` | Server switch absent at 2026-09-24 → Packing requests fail | **NO → FEATURE_TRUTH_ITEM (010)** |
| Smart Watchlist | Yes | `EXPO_PUBLIC_SMART_WATCHLIST_V1=true` | Watches can be created; `watchlist_worker_enabled=false`, push credentials absent at 2026-09-24 → prices are never re-checked, no alerts | **NO → FEATURE_TRUTH_ITEM (011)** |
| Wardrobe Concierge | Yes | `EXPO_PUBLIC_ELISE_CONCIERGE_V1=true` | Server switches absent at 2026-09-24 → inert (Elise answers without closet context) | YES — not promised anywhere in the client journey (023) |
| Cloud Closet (sync / restore) | Engines only | `CLOSET_CLOUD_SYNC_V1` / `CROSS_DEVICE_RESTORE_V1=true` | Not re-verified | YES — no client K+ promise, no customer surface |

`FEATURE_TRUTH_ITEMS=2`. Neither is repairable inside polish authority without hiding the feature
(forbidden) or changing production backend configuration (out of scope): both are
`OWNER_DECISION_REQUIRED`.

---

## 5. Convergence lineage — landmark spot-check (A5)

`PR467_IS_ANCESTOR=YES` taken as given. Spot-checked in the tree:

| Landmark | Present |
| --- | --- |
| Repair 1 — `isBoundAiOutputReportCurrent` post-await checks in `AiOutputReportingContext` | Yes |
| Repair 2 — `StyleChatBubble` imports `expo-file-system/legacy` | Yes |
| Repairs 3A / 3 / 3B — `closetLibrary.js` / `closetCandidateLibrary.js` durability + relocation (suites green) | Yes |
| #467 — iOS VoiceOver custom actions + non-accessible backdrop (`RoomItemDetailModal`) | Yes |
| #467 — camera gate "Open Settings" (`LiveScanCamera`) | Yes |
| Lane A — six-state commerce truth (`services/commerceShelfState.ts`) | Yes |
| Lane A — K+ advertising truth (`KPLUS_CAPABILITY_SERVER_ENABLEMENT`) | Yes |
| Lane A — inline VTO consent (`VtoConsentStep` inside `VirtualTryOnSheet`) | Yes |
| Lane A — sibling-Modal overlay nesting (`ResultSurfaceModal` `overlay`) | Yes |
| Lane A — Elise `keyboardVerticalOffset={0}` | Yes |

`PRIOR_AUDIT_LANDMARKS_CHECKED=10`, `PRIOR_AUDIT_REGRESSIONS_FOUND=0`, `PRIOR_AUDIT_REGRESSIONS_FIXED=0`.

---

## 6. Findings — FIXED

### POLISH-001

Severity: P2
Surface: K+ — shared Early Access sheet (`KPlusEarlyAccessSheet`)

Issue: With the entitlement unresolved, the sheet rendered the free-tier offer. `loading` showed the
full pitch with a disabled Activate; `error` showed the pitch with a live Activate button and no way
to re-check.

Evidence: `SOURCE_TESTED`. The sheet branched only on `active` / `expired`; every other state fell
through to the offer. Reachable from the onboarding Microphone card's "CHECK K+" (which opens the
sheet exactly when the state is `error`) and whenever the on-open `refresh()` fails.

Root cause: the sheet predates `isKPlusEntitlementUnresolved`; the gates were repaired, the shared
surface they open was not.

Repair: a third branch for `loading` / `error` — "Checking your K+ access…" (spinner) or "We could
not check your K+ access / Check your connection and try again. Nothing on your account has
changed." — with Try Again (`refresh`) for `error` and Not Now for both. No Activate CTA while
unresolved. Entitlement semantics unchanged.

Files: `components/kplus/KPlusEarlyAccessSheet.tsx`

Before: a complimentary member whose read failed was pitched K+ Early Access with a live Activate button.
After: the sheet says the status is unknown and offers a retry; the offer appears only for `eligible`.

Validation: `__tests__/build34FinalPolishPass.test.js` renders the real component for
`loading` / `error` / `eligible` (control) and checks Try Again is wired to `refresh`.
**Negative control:** the same assertions against a mutated source (`const resolving = false;`) must
fail as assertions — they do. Existing sheet suites (`kplusEarlyAccessShell`,
`kplusCapabilityAdvertisingTruth`, `kplusEntitlementStore`, `kplusSurfaceWiring`) pass.

Regression risk: LOW. Independently revertible: YES.

Status: FIXED

### POLISH-002

Severity: P2
Surface: K+ — Account screen status row (`app/privacy.tsx`)

Issue: For `loading` and `error` the row's subtitle was the eligible offer ("Complimentary for 6
months. No payment required."). An unreadable status had no retry.

Evidence: `SOURCE_TESTED`. The subtitle ternary fell through to the offer for every state other than
`active` / `expired`.

Root cause: the row's copy was derived inline from three ternaries with an offer-copy default.

Repair: the row's wording moved to a pure helper, `services/kplus/kplusAccountStatus.ts`
(`describeKPlusAccountStatus`). `loading` → "Checking your K+ access…"; `error` → "We could not check
your K+ access. Nothing on your account has changed." with a "Try Again" action wired to
`kPlusEntitlement.refresh`; `unavailable` → neutral. Resolved states render exactly as before.

Files: `services/kplus/kplusAccountStatus.ts` (new), `app/privacy.tsx`,
`__tests__/kplusCoreFreeBoundary.test.js` (touch count for `app/privacy.tsx` 12 → 6: the status text,
tone and action moved into the helper; the one new touch is `refresh`, a re-check, not a gate — the
test's own instructions ask for the count to be updated with that explanation).

Before: a K+ member saw the signup offer while their status loaded, and indefinitely after a failed read.
After: the row says the status is being checked or could not be read, and offers Try Again.

Validation: real execution of the helper for all six states. **Negative control:** a mutated helper
that restores the offer fallthrough for `loading` / `error` must fail — it does. Wiring asserted in
`privacy.tsx`. `kplusCoreFreeBoundary`, `kplusSurfaceWiring`, `accountDeletionV69Contract`,
`deviceNotificationSettingsControl`, `dressingRoomBlockingUi`, `terminalDeletionCleanup` pass.

Regression risk: LOW. Independently revertible: YES (with the count line in `kplusCoreFreeBoundary`).

Status: FIXED

### POLISH-003

Severity: P3
Surface: K+ — sheet activated state

Issue: After activation the sheet said "K+ ACTIVATED / Complimentary Early Access / Active through …"
but not what had changed.

Evidence: `SOURCE_TESTED`.

Root cause: the activated branch carried only status and terms.

Repair: one line — "K+ features are now unlocked on this account." Deliberately not a capability
list: opened from Packing or Watchlist, a list of Voice Scan / Try-On would contradict the reason the
user activated (see 010/011).

Files: `components/kplus/KPlusEarlyAccessSheet.tsx`

Before: success with no statement of effect. After: success states the effect; Done returns to the now-unlocked gate.

Validation: activated-state render test. Regression risk: LOW. Independently revertible: YES.

Status: FIXED

### POLISH-005

Severity: P2
Surface: Voice Scan K+ surfaces (Text Scan Voice block, Voice Scan button, listening sheet)

Issue: "Upgrade to K+" / "UPGRADE TO K+" / "Upgrade to K+ to use Voice Scan." in a complimentary
build with no purchase path. It disagreed with "UNLOCK WITH K+" (Packing, onboarding) and "Activate
K+" (sheet, onboarding), and was already flagged as an App Review risk (IOS-SUB-02 in
`docs/BUILD34_IOS_FINAL_PREBUILD_READINESS.md`: a reviewer can go looking for a purchase).

Evidence: `SOURCE_INFERRED`; `SOURCE_TESTED` for the guard.

Root cause: the Voice Scan pill predates the complimentary-activation copy used elsewhere.

Repair: "Unlock with K+" family: badge "Unlock with K+"; a11y "Voice Scan, unlock with K+"; button
status "UNLOCK WITH K+" (same length as before, fits the 40pt pill); listening-sheet body "Unlock K+
to use Voice Scan. You can still search by typing below." (now offers the typing fallback like every
other unavailable reason).

Files: `components/text-scan/TextScanFeatureRow.tsx`, `components/text-scan/VoiceScanButton.tsx`,
`components/text-scan/VoiceListeningSheet.tsx`; tests `__tests__/kplusSurfaceWiring.test.js`,
`__tests__/voiceScanUiWiring.test.js` (both pinned the old string; updated with rationale — explicit
new spec over a contradicting test).

Before: "Upgrade". After: "Unlock", consistently.

Validation: an AST scan of nine K+ surface files asserts no user-visible string says "upgrade"
(comments and test IDs excluded); the same scan finds two hits in the base tree, so it bites.
`voiceScan*`, `homeVoiceScanPill`, `kplus*` suites pass.

Regression risk: LOW (copy only). Independently revertible: YES (with the two test edits).

Status: FIXED

### POLISH-006

Severity: P3
Surface: Smart Watchlist entry points (commerce Watch buttons, Home WATCHLIST tile)

Issue: A free user's tap opens the K+ sheet, but the controls said only "Watch" / "Open Smart
Watchlist — Track prices…", unlike Try-On's "TRY IT ON · K+".

Evidence: `SOURCE_INFERRED`.

Root cause: the Watch affordances pre-date the `· K+` lock convention.

Repair: for a resolved free actor only — visible "Watch · K+" on the two commerce Watch buttons, and
the hint "Available with K+. Opens K+ Early Access." on all three entry points. Active and resolving
actors see exactly what they saw before. Labels (WL-10 product naming) unchanged.

Files: `components/ProductShelf.tsx`, `components/scan-results/PurchaseOptionsPanel.tsx`,
`components/home/HomeLuxuryTechV1.tsx` (3 files; attribute/text only). The hints are kept on one
line so the Watchlist gate stays inside the 1400-character window `build34EntitlementMatrix` reads.

Before: tap-to-upsell with no warning. After: the lock is stated visually (commerce) and to screen readers (all three).

Validation: focused assertions; `watchlistFeatureContainment` (renders ProductShelf's gate for
inactive/active actors), `watchlistDeepAuditRepairs`, `watchlistShippedSurfaceReach`,
`build34EntitlementMatrix` pass.

Regression risk: LOW. `DEVICE_QA_REQUIRED`: "Watch · K+" width on compact screens.

Status: FIXED

### POLISH-007

Severity: P3
Surface: K+ sheet Done button

Issue: visible "Done", announced "Close" (label-in-name mismatch for voice control users).

Repair: removed the override; the button's name is its title, with hint "Closes this sheet".

Files: `components/kplus/KPlusEarlyAccessSheet.tsx`. Validation: render test (active and expired).
Regression risk: LOW. Status: FIXED

### POLISH-008

Severity: P3
Surface: Account K+ row, expired state

Issue: subtitle "Complimentary access ended." directly above a pill reading "Complimentary access ended".

Repair: subtitle now answers the next question — "There is no charge and nothing to cancel." (same
fact the sheet and onboarding already state).

Files: `services/kplus/kplusAccountStatus.ts`. Validation: helper test. Regression risk: LOW. Status: FIXED

### POLISH-009

Severity: P2
Surface: Scanner result / Recent Scans / commerce empty state

Issue: every successful scan toasted "Saved to Style Closet". In Build 34 (`CLOSET_SEPARATION_V1`
on in every governed profile) scans go to Recent Scans; the Closet is owned wardrobe, and its empty
state tells users to "Open a recent scan and choose Add to Closet". The toast named a place the scan
never appears, and was not announced to screen readers. Same root cause: the Recent Scans delete
dialog said "remove the scan from your Style Closet", and the single-item commerce empty state said
"save this look to your Closet to keep it".

Evidence: `SOURCE_INFERRED` (`app.js` auto-save effect → `saveScan` → Recent Scans; `app/library.tsx`
`SECTION_CHROME`).

Root cause: pre-separation "Closet = everything saved" copy survived the Closet separation.

Repair: toast "Saved to Recent Scans" when `CLOSET_SEPARATION_V1` (legacy wording kept for a build
without it), announced once on mount (`announceForAccessibility`, `accessibilityLiveRegion`); delete
dialog "This will remove the scan from your Recent Scans." under the same flag; commerce empty
subtitle "Based on your scan."

Files: `app.js`, `app/library.tsx`, `components/scan-results/PurchaseOptionsPanel.tsx` (3 files).
`library.tsx` imports are unchanged (the four render-harness allowlists are unaffected).

Before: users were sent to the Closet to find a scan that lives in Recent Scans. After: copy names Recent Scans.

Validation: focused assertions (flagged wording, mount-only announcement, no Closet instruction);
closet/library harness suites (`closetBatchReviewSurface`, `closetCandidatePaintDefect`,
`closetPromotionSurface`, `librarySectionDomainSeparation`, `closetRecentScanNavigationSeparation`)
and scanner suites (`iosScanResultSheetNesting`, `scanCommerceStateTruth`, `commerceHydrationV127`,
`commerceShelfWiring`, `vtoShippedSurfaceReach`, `scanResultReportReachability`,
`androidScanner*`, `iosAppReviewSurface`, `productNameBranding`) pass. No negative control: copy
only, and the toast's host (`app.js`) has no render harness.

Regression risk: LOW. Independently revertible: YES.

Status: FIXED

### POLISH-012

Severity: P3
Surface: Text Scan failure state

Issue: after "Unable to analyze this style request. Please try again.", the only action was Scan
Again, which clears the query — retrying meant retyping (or re-speaking a Voice Scan query). The
header back arrow does keep the query, which is why this is P3, not P2.

Repair: an "Edit Search" secondary action, shown only on failure, returns to the input with the
query intact (one tap from Analyze Request).

Files: `app/text-scan/index.tsx`. Validation: focused assertion (no `setQuery` / `handleScanAgain`
in the new handler); `textScan*` suites pass. Regression risk: LOW. Status: FIXED

### POLISH-013

Severity: P2
Surface: Signature Style details sheet (Elise chat)

Issue: iOS VoiceOver could not reach "Reset local signals" or "Done". The sheet's backdrop
`Pressable` (tap-to-close) and inner `Pressable` (swallows the tap) are both accessible by default,
and an accessible view is one VoiceOver element that hides its subviews. The reset control is a
privacy control.

Evidence: `SOURCE_TESTED`; identical to the defect #467 fixed in `RoomItemDetailModal`.

Repair: `accessible={Platform.OS === 'ios' ? false : undefined}` on both wrappers — the proven
pattern. Touch behaviour and Android are unchanged.

Files: `components/style-chat/StyleChatSignatureStyleCard.tsx`

Before: the details sheet read as one opaque element on iOS. After: title, stats, Reset and Done are individual VoiceOver stops.

Validation: renders the real component on iOS and Android and finds every `Pressable` that wraps
the Done control. **Negative control:** removing the attribute must fail as an assertion — it does.
`signatureStyleFeedbackSafety`, `eliseIdentity`, `eliseVisualContext`, `responsiveScreenContracts`,
`iosVoiceOverNestedActions` pass.

Regression risk: LOW. Independently revertible: YES. `DEVICE_QA_REQUIRED` (VoiceOver pass).

Status: FIXED

### POLISH-014

Severity: P3
Surface: Auth — password reset, update password, email-confirmation and callback screens

Issue: four primary `Pressable`s had no button role; reset / update-password lost their accessible
name while busy (the text is replaced by a spinner).

Repair: `accessibilityRole="button"` on all four; label and `accessibilityState={{ disabled, busy }}`
on the two submit buttons. Attribute-only.

Files: `app/auth/reset.tsx`, `app/auth/update-password.tsx`, `app/auth/callback.tsx`,
`app/auth/index.tsx` (4 files — justified: one attribute class, no behaviour change, each screen owns
its button).

Validation: focused assertions; `auth*` suites pass. Regression risk: LOW. Status: FIXED

### POLISH-015

Severity: P3
Surface: AI response report sheet

Issue: "Thank you for helping keep K Scan safe." and "Your report is sent to K Scan for review." —
bare "K Scan" where the product name is "K Scan AI" (the neighbouring room-report copy already says it).

Repair: both strings now say "K Scan AI". Copy only; Repair 1 logic untouched.

Files: `contexts/AiOutputReportingContext.tsx`. Validation: focused assertion; Repair 1 suites
(`aiOutputReportActorStateIsolation`, `aiOutputReportOutcomeTruth`) pass. Regression risk: LOW. Status: FIXED

### POLISH-016

Severity: P3
Surface: Voice Scan button (Text Scan)

Issue: 40pt tall (below the 44pt minimum used elsewhere).

Repair: `hitSlop` 4pt top/bottom → 48pt touch area, no layout change.

Files: `components/text-scan/VoiceScanButton.tsx`. Validation: focused assertion. Regression risk:
LOW. `DEVICE_QA_REQUIRED` (overlap with the query field). Status: FIXED


### POLISH-029

Severity: P2
Surface: Shared K+ Early Access sheet

Issue: the shared K+ sheet independently hardcoded "K+ Early Access is complimentary for 6 months."
while the onboarding activation screen already uses `KPLUS_ACTIVATION_OFFER_TERM`, the repository's
single copy authority for the current campaign term. Two customer-facing K+ surfaces could therefore
make different duration claims if the configured offer changes.

Evidence: `SOURCE_PROVEN`.

Repair: the sheet now renders `KPLUS_ACTIVATION_OFFER_TERM` from `constants/featureFlags.ts` and
renders no duration line when that authority is empty. No entitlement, grant-duration, pricing,
activation, or backend semantics changed.

Files: `components/kplus/KPlusEarlyAccessSheet.tsx`,
`__tests__/build34FinalPolishPass.test.js`.

Validation: focused source guard requires the sheet to consume the shared authority and forbids a
hardcoded "6 months" visible string in the sheet. Regression risk: LOW. Independently revertible: YES.

Status: FIXED

---

## 7. OWNER_DECISION_REQUIRED

### POLISH-010 — Packing Intelligence feature truth

Surface: Home "PACK FOR A TRIP" → Packing gate "UNLOCK WITH K+".
Observation: the production-certification build enables Packing and invites free users to unlock
it with K+; at the 2026-09-24 audit the Packing server switch was absent in production, so an
activated member's Packing request fails. Not re-read in this pass (production reads were denied).
Why no polish repair: hiding the chip or gate is disabling an intended Build 34 feature (forbidden);
enabling the server switch is production backend configuration (out of polish scope). The activation
catalog already declines to *advertise* Packing, but the Packing gate itself still sells it.
Owner decision: confirm the production switch is enabled and a K+ member can generate a plan before
artifact testing — or accept that testers will see Packing fail after activation.
`FEATURE_TRUTH_ITEM=YES`. Physical QA: YES.

### POLISH-011 — Smart Watchlist feature truth

Surface: Watch buttons, Home WATCHLIST tile, Watchlist screens, price-alert notifications.
Observation: watches can be created, but at the 2026-09-24 audit the watch worker was disabled and
the push credentials absent in production, so prices are never re-checked and no alert is sent. The
UI is honest about it (rows read "Not checked yet"), but the promise ("Track prices…", "we'll keep an
eye on the price", "Get notified when a watched item hits your target price") is not delivered.
Not re-read in this pass.
Why no polish repair: same as 010.
Owner decision: enable the worker and push credentials in production before artifact testing, or
accept that testers cannot exercise price tracking.
`FEATURE_TRUTH_ITEM=YES`. Physical QA: YES.

---

## 8. REVIEWED-NOT-CHANGED

| ID | Surface | Observation | Why no change | Severity | Physical QA |
| --- | --- | --- | --- | --- | --- |
| POLISH-004 | Onboarding K+ step | Activation success routes straight to Home; no visible confirmation screen (screen readers hear "K+ activated."). | Home immediately reflects K+ (Voice Scan pill INCLUDED; Account row active); nothing false is shown. A confirmation state would have to re-sequence the step's auto-skip effect (fires on `isActive`) against the activation handler inside the onboarding-completion path, whose failure strands users at the step-7 spinner — disproportionate for a P3 at freeze. | P3 | YES |
| POLISH-017 | Packing | Packing network-error message says "I could not reach K Scan…" (bare name). | The Packing client (`services/packing/packingClient.ts`) was not opened in this pass: a permission denial during discovery covered it, and this pass did not route around it. One-string follow-up. | P3 | NO |
| POLISH-018 | Upgrade transition (A11) | A returning Build 33 user with current legal acceptances skips onboarding, so never sees the K+ step; new surfaces (K+, Voice Scan, Try-On, Watchlist, Packing, Dressing Room chat) get no orientation. They are discoverable in place (Home chips/pills, commerce rows, Account K+ row). | Building orientation is a new onboarding flow (not authorized). `BUILD35_RECOMMENDATION=` one-time "What's new in 1.1.0" card keyed to the app version, dismissible, linking to the K+ sheet. | P3 | YES |
| POLISH-019 | Dressing Room item tile (Android) | The Android `ItemTile` `Pressable` has no button role (TalkBack reads its text). | `iosVoiceOverNestedActions` deliberately pins "Android ItemTile is unchanged"; not worth reopening a #467 contract for a role. | P3 | YES (TalkBack) |
| POLISH-020 | Brand wordmark | "K-SCAN" wordmark on the boot overlay, legacy auth headers, `app.js` header; also used as the fallback "brand" label for an unbranded Dressing Room item. | A brand/wordmark decision, not a copy defect; the fallback is reached only when an item has neither brand nor category. | P3 | NO |
| POLISH-021 | Closet / Inspiration naming | "Style Closet" remains in Inspiration copy (`app/library.tsx` Inspiration section, `InspirationUploadModal`, Dressing Room inspiration removal). | Inspiration uploads do live in the Closet area, so the destination is not wrong — only the legacy name. Renaming across five strings is a naming sweep, not a defect fix. | P3 | NO |
| POLISH-025 | Elise composer | `keyboardVerticalOffset={0}` on the chat `KeyboardAvoidingView`. | Deliberate Lane A decision (correct full-screen; iPad multitasking unsolved). | — | YES |
| POLISH-026 | Dressing Rooms | New-room subtitle suggests "a trip, event, sale watchlist, or styling project" — "watchlist" overlaps the K+ Smart Watchlist name. | Describes a use of a free board; no user would be blocked or misled into K+. | P3 | NO |
| POLISH-028 | Single-item commerce empty state | `ScanResultV2` routes both "not started" and "completed empty" to the same hedged card ("Matching products will appear here for shoppable looks."), while the multi-item path uses the six-state copy. | The hedged title is not false for either state; unifying requires re-wiring the live single-item commerce state (`resolvePurchaseShelfMode` → `commerceShelfState`), beyond polish blast radius at freeze. Subtitle fixed under 009. | P3 | YES |

## 9. OBSERVATION

| ID | Observation |
| --- | --- |
| POLISH-022 | Scan landing says "Retail + Resale / FIND IT EVERYWHERE". Resale depends on what web shopping results return; the Vinted secondhand path is not Build-34-reachable. Not provably false from source. |
| POLISH-023 | Wardrobe Concierge is inert in production (2026-09-24, not re-read) but no client surface promises it; the catalog excludes it. Truthful by silence. |
| POLISH-024 | On onboarding activation success, `goToHome` runs twice (the auto-skip effect sees `isActive`, and the handler calls `onContinue`). The completion write is idempotent and AuthGate dedupes the redirect; no customer-visible effect. |
| POLISH-027 | Onboarding Microphone card "CHECK K+" (entitlement `error`) opens the shared sheet. Before 001 that showed the offer; it now shows the check/retry state, so the label is truthful. |

---

## 10. PHYSICAL_QA_BACKLOG

1. K+ sheet on a device: `loading` → offer / active transitions; `error` → Try Again (airplane mode).
2. Account K+ row: loading, error + Try Again, active, expired, on a small iPhone.
3. Activation from each gate (Voice Scan pill, Packing, Watch, Try-On) → Done → gate unlocked in place.
4. Onboarding step 6 on a real account: eligible, already-active (skips), expired, error.
5. "Watch · K+" and "UNLOCK WITH K+" width on iPhone SE and a compact Android.
6. Voice Scan: permission sheets, listening haptics, the 48pt hit area next to the query field.
7. VoiceOver: Signature Style details sheet (Reset, Done reachable), K+ sheet header order, auth buttons.
8. TalkBack: Watch hints, K+ sheet, Dressing Room tiles.
9. Scan-save toast announcement (VoiceOver and TalkBack) and legibility above the result sheet.
10. Keyboard: Text Scan edit-after-error, Elise composer, Dressing Room create, report sheet, auth forms.
11. Real camera and photo-picker flows: single scan, multi-image, Mirror Selfie, Closet intake.
12. VTO consent and one real generation (provider credential unproven at the last audit).
13. Build 33 → 1.1.0 upgrade on a device with existing scans and Closet (container relocation paths).
14. Universal/App Links for `/rooms/*`; OAuth return after process death.
15. Notification tap routing for a watch alert (only once 011 is resolved).
16. Packing plan generation for a K+ member (only once 010 is resolved).

`PHYSICAL_QA_BACKLOG_COUNT=16`

---

## 11. Validation

| Gate | Result |
| --- | --- |
| New suite `__tests__/build34FinalPolishPass.test.js` | 21/21 (3 negative controls, each required to fail as an assertion) |
| Focused domain suites (76 files: K+, Voice, Text Scan, Watchlist, auth, reports, scanner, library harnesses, Elise/Signature Style, privacy, branding) | 1650 tests; the only failure is the pre-existing base identity "no repo migration other than the blocking one assumes the internal schema" |
| Repair 1 (`aiOutputReportActorStateIsolation`, `aiOutputReportOutcomeTruth`) | 46/46 |
| Repair 2 (`conciergeClosetImageFileSystem`) | 39/39 |
| Repair 3A (`closetManifestDurability`, `closetTypedLoad`) | 42/42 |
| Repair 3 (`closetMediaContainerRelocation`, `closetCandidateStore`) | 79/79 |
| Repair 3B (`closetCandidateStore`) | 64/64 |
| `npx tsc --noEmit -p tsconfig.json` | PASS |
| `check-edge-function-parity.js` | PASS |
| `generate-edge-function-manifest.js --check` | PASS |
| `check-native-config-parity.js` | PASS |
| `check-dependency-reachability.js` | PASS |
| `test:privacy`, `test:auth-privacy`, `test:security` | 5/5, 37/37, 71/71 |
| `__tests__/security/*` | 358/359 — the 1 failure is a base identity |
| `verify:security` | 11/12 — identical to base (the ZAP localhost-reject step) |
| Full suite (Windows), `node scripts/run-all-tests.js` | Base `52ad2ad5`: 9560 tests, 31 failures (13 known + 18 Windows-only). Head: 9581 tests (+21 new), 31 failures. Failing-test identity sets are identical (`comm` of the sorted identity lists is empty both ways). `NEW_WINDOWS_FAILURES=0` |

## 12. Change inventory

Every changed file maps to a POLISH ID:

| File | POLISH |
| --- | --- |
| `components/kplus/KPlusEarlyAccessSheet.tsx` | 001, 003, 007, 029 |
| `services/kplus/kplusAccountStatus.ts` (new) | 002, 008 |
| `app/privacy.tsx` | 002 |
| `components/text-scan/TextScanFeatureRow.tsx` | 005 |
| `components/text-scan/VoiceScanButton.tsx` | 005, 016 |
| `components/text-scan/VoiceListeningSheet.tsx` | 005 |
| `components/ProductShelf.tsx` | 006 |
| `components/scan-results/PurchaseOptionsPanel.tsx` | 006, 009 |
| `components/home/HomeLuxuryTechV1.tsx` | 006 |
| `app.js` | 009 |
| `app/library.tsx` | 009 |
| `app/text-scan/index.tsx` | 012 |
| `components/style-chat/StyleChatSignatureStyleCard.tsx` | 013 |
| `app/auth/reset.tsx`, `app/auth/update-password.tsx`, `app/auth/callback.tsx`, `app/auth/index.tsx` | 014 |
| `contexts/AiOutputReportingContext.tsx` | 015 |
| `__tests__/build34FinalPolishPass.test.js` (new) | all |
| `__tests__/kplusSurfaceWiring.test.js`, `__tests__/voiceScanUiWiring.test.js` | 005 |
| `__tests__/kplusCoreFreeBoundary.test.js` | 002 |
| `docs/audits/BUILD34_FINAL_POLISH_PASS.md` (this ledger) | — |

Not changed: `package.json`, `package-lock.json`, `app.json`, `eas.json`, native projects, Supabase
functions, migrations, feature flags. No Build 35 source was merged, cherry-picked or recreated.

Source files changed: 18 (17 modified + 1 new). Source lines: +226 / −44 (tests and this ledger excluded).
