# KS-REL-007C Runtime UI Branch Source Audit

**Date:** 2026-06-18
**Auditor:** Agent (read-only, no code changes)
**Current Branch:** `feature/release-integration-v2-backend-stack-v1`
**Current HEAD:** `bfa00f2`
**Working Tree:** Clean — no uncommitted changes.

---

## 1. Observed Issue

The Android runtime is showing the **current/old UI** instead of the expected new K Scan UI direction (luxury ivory/plum/gold surfaces, Home Navigation V2, Scan Room V2, Scan Results V2, TextScan UI, Onboarding Framework V1).

---

## 2. Candidate Branches Inspected

| Branch | Exists Local | Exists Remote | Last Commit | Likely UI Relevance |
|---|---|---|---|---|
| `feature/purple-gold-electric-theme` | Yes | Yes | `ef5375e` | Theme token origin; **older than release foundation** |
| `feature/textscan-ui-v1` | Yes | Yes | `9fc3e36` | TextScan shell; **older than release foundation** |
| `feature/dressing-rooms-v2-ui` | Yes | Yes | `e8766c6` | Dressing Rooms polish; **older than release foundation** |
| `feature/scan-results-v2-ui` | Yes | Yes | `59011f0` | Scan Results V2 shell; **older than release foundation** |
| `feature/release-integration-v2-backend-stack-v1` | Yes | Yes | `bfa00f2` | **Current release foundation** — contains all new UI |
| `release/android-1.0.0` | Yes | Yes | `8beaff6` | Release tag; **older than release foundation** |
| `master` | Yes | Yes | `a601adf` | Trunk; contains glasses bridge and other unrelated work |

---

## 3. Per-Branch Diff Summary vs. Release Foundation

### `feature/purple-gold-electric-theme`
- **Diff direction:** branch is **missing** 154 files that the release foundation has.
- **Net change:** `-21,625 lines` (branch deletes vs. release).
- **Key deletions:** `components/luxury/*`, `components/scan-results/*`, `components/scan-room/*`, `components/text-scan/*`, `components/onboarding/*`, `app/onboarding/index.tsx`, `app/text-scan/index.tsx`, `constants/theme.ts` (LUXURY tokens), `constants/featureFlags.ts` (rollout flags).
- **Classification:** This branch predates the luxury component system and the full V2 UI surfaces. It was the **origin** of the purple/gold color direction, but the release foundation has since **superseded** it with more complete luxury components.

### `feature/textscan-ui-v1`
- **Diff:** branch is **missing** 103 files that the release foundation has.
- **Net change:** `-13,452 lines`.
- **Key deletions:** `components/scan-room/*`, `components/scan-results/*`, `components/onboarding/*`, `app/onboarding/index.tsx`, `constants/featureFlags.ts` (many flags).
- **Classification:** Contains the TextScan input/results shell, but **does not** contain Scan Room V2, Scan Results V2, or Onboarding V1. Older than release.

### `feature/dressing-rooms-v2-ui`
- **Diff:** branch is **missing** 111 files that the release foundation has.
- **Net change:** `-13,815 lines`.
- **Key additions:** `components/dressing-rooms/DressingRoomCompactCard.tsx`, `DressingRoomHeroCard.tsx`, `RoomChatBoard.tsx`, `RoomDetailTabs.tsx`, `RoomInfoPanel.tsx`, `RoomSavedPanel.tsx`, `RoomScanCard.tsx`, `RoomScansGrid.tsx`.
- **Key deletions:** `components/scan-room/*`, `components/scan-results/*`, `components/onboarding/*`, `app/onboarding/index.tsx`.
- **Classification:** Adds Dressing Room V2 UI components, but **does not** contain Scan Room V2, Scan Results V2, Onboarding V1, or TextScan. Older than release.

### `feature/scan-results-v2-ui`
- **Diff:** branch is **missing** 92 files that the release foundation has.
- **Net change:** `-11,930 lines`.
- **Key deletions:** `components/scan-room/*`, `components/onboarding/*`, `app/onboarding/index.tsx`, `constants/featureFlags.ts`.
- **Classification:** Contains Scan Results V2 shell, but **does not** contain Scan Room V2, Onboarding V1, or TextScan. Older than release.

### `release/android-1.0.0`
- **Diff:** branch is **missing** 144 files that the release foundation has.
- **Net change:** `-19,237 lines`.
- **Classification:** This is a release tag. It merged the purple-gold StyleChat fixes but predates the full luxury component set, Scan Room V2, Scan Results V2, TextScan, Onboarding V1, and all backend V2 work.

### `master`
- **Diff:** Contains a large `kscan-google-glasses/` Android XR project, glasses bridge, phone bridge, and unrelated native work. Also missing many of the luxury UI components compared to the release foundation.
- **Classification:** Not relevant for the current Android mobile UI direction. Do not merge `master` into the release foundation.

---

## 4. UI / Theme Indicator Search Results (Current Release Foundation)

The **current release foundation** (`feature/release-integration-v2-backend-stack-v1`) already contains the expected new UI direction:

- **Luxury tokens present:** `LUXURY.colors.ivory`, `plum`, `gold`, `champagne`, `pearl`, `cream`, `silk` in `constants/theme.ts`.
- **Luxury components present:** `components/luxury/EmptyStateCard.tsx`, `InlineNotice.tsx`, `KScanHeader.tsx`, `LuxuryButton.tsx`, `LuxuryScreen.tsx`, `PrivacyFooter.tsx`, `ProductCard.tsx`, `SavedLookCard.tsx`, `SectionHeader.tsx`, `SharedScanCard.tsx`, `StatusPill.tsx`.
- **Scan Room V2 components present:** `components/scan-room/ScanLanding.tsx`, `LiveScanCamera.tsx`, `CaptureReview.tsx`, `AnalyzingScan.tsx`, `ScanRoomHeader.tsx`.
- **Scan Results V2 components present:** `components/scan-results/ScanResultV2.tsx`, `ScanResultHero.tsx`, `ScanResultActionRow.tsx`, `PurchaseOptionsPanel.tsx`, `SimilarFindsShelf.tsx`, `StyleAnalysisSection.tsx`, `StyleMatchPanel.tsx`.
- **TextScan components present:** `components/text-scan/TextScanHeader.tsx`, `TextScanInput.tsx`, `TextScanProductCard.tsx`, `AIStarBadge.tsx`, `AttributeGrid.tsx`, `ResultFilterTabs.tsx`, `TextScanFeatureRow.tsx`, `TextScanSuggestionChip.tsx`.
- **Home V2 present:** `components/home/HomeV2.tsx` (uses `DestinationCard`, `SavedLookCard`, luxury tokens).
- **Onboarding V1 present:** `app/onboarding/index.tsx` (uses `OnboardingShell`, `OnboardingStepIndicator`).
- **StyleChat V6.4 present:** `app/style-chat/index.tsx`, `components/style-chat/StyleChatBubble.tsx`, `StyleChatSessionList.tsx`, `StyleChatUiBlock.tsx`.

**Conclusion:** The expected new UI is **already in the current release foundation**. It does **not** live in a separate, unmerged branch.

---

## 5. Root Cause: Why the Runtime Shows Old UI

The new UI is **gated behind environment-driven feature flags** in `constants/featureFlags.ts`. All flags default to `false` when their environment variables are absent:

| Flag | Env Variable | Effect when `false` |
|---|---|---|
| `HOME_NAVIGATION_V2_ENABLED` | `EXPO_PUBLIC_HOME_NAVIGATION_V2` | `app/index.tsx` renders `HomeLegacy` instead of `HomeV2` |
| `SCAN_RESULTS_V2_UI_ENABLED` | `EXPO_PUBLIC_SCAN_RESULTS_V2_UI` | `app.js` renders `AnalysisCard` (old results) instead of `ScanResultV2` |
| `SCAN_ROOM_V2_UI_ENABLED` | `EXPO_PUBLIC_SCAN_ROOM_V2_UI` | `app.js` renders old camera flow instead of `ScanLanding` / `LiveScanCamera` / `CaptureReview` / `AnalyzingScan` |
| `TEXTSCAN_UI_ENABLED` | `EXPO_PUBLIC_ENABLE_TEXTSCAN` | TextScan entry point is hidden; `/text-scan` route may still exist but is not advertised |
| `ONBOARDING_FRAMEWORK_V1_ENABLED` | `EXPO_PUBLIC_ONBOARDING_FRAMEWORK_V1` | Onboarding shell is not mounted for unauthenticated users |

**Build configuration check:**
- `.env` does **not** set any of these UI flags.
- `eas.json` (preview & production) does **not** set any of these UI flags.
- Therefore, EAS builds and local builds will always fall back to the old UI paths.

---

## 6. Risk Assessment for Enabling the New UI

| Risk Area | Assessment |
|---|---|
| **UI-only changes** | Yes — the new UI files are already in the branch. No new files need to be merged. |
| **Backend migrations** | None required for UI rendering itself. However, `ScanResultV2` and `TextScan` may call backend APIs that are not fully verified. |
| **Native build changes** | None required. All changes are React Native / TypeScript. |
| **Feature flags** | Enabling flags is a configuration change (env vars), not a code change. Flags are already safely implemented with `typeof process !== 'undefined'` guards. |
| **Secrets** | No secrets are introduced by enabling UI flags. |
| **Generated artifacts** | None. |
| **Navigation changes** | `HomeV2` changes the home layout. `ScanRoomV2` changes the scan flow state machine. Both are gated and tested locally in the codebase. |
| **Backend/provider dependencies** | `TEXTSCAN_BACKEND_ENABLED` is a separate flag. The UI flag (`TEXTSCAN_UI_ENABLED`) can be enabled without enabling the backend flag, showing the shell with demo/preview states if desired. |
| **Known QA reports** | `qa/merge-readiness-audit-purple-gold-to-android-release-2026-06-14.md` exists but is on an older branch. No QA report specifically covers the full V2 UI flag enablement. |
| **Runtime risks** | If flags are enabled without backend readiness, users may see empty states or error toasts in TextScan / Scan Results V2. The old fallback paths are well-tested. |

---

## 7. Recommendation

**Option B — Create a new UI integration branch from the current release foundation.**

Recommended path:

1. **Branch:** `feature/ui-v2-integration-smoke` from `feature/release-integration-v2-backend-stack-v1`.
2. **Configuration:** Add the following environment variables to `.env` (for local dev) and `eas.json` preview build config (for EAS smoke):
   - `EXPO_PUBLIC_HOME_NAVIGATION_V2=true`
   - `EXPO_PUBLIC_SCAN_RESULTS_V2_UI=true`
   - `EXPO_PUBLIC_SCAN_ROOM_V2_UI=true`
   - `EXPO_PUBLIC_ENABLE_TEXTSCAN=true`
   - `EXPO_PUBLIC_ONBOARDING_FRAMEWORK_V1=true` (optional, if onboarding smoke is needed)
3. **Smoke test:** Run Android runtime smoke on the integration branch.
4. **Decision:**
   - If smoke passes → merge the integration branch into `feature/release-integration-v2-backend-stack-v1`.
   - If smoke fails → fix issues on the integration branch without destabilizing the release foundation.

**Why not merge UI branches directly?**
- The candidate UI branches (`purple-gold-electric-theme`, `textscan-ui-v1`, `dressing-rooms-v2-ui`, `scan-results-v2-ui`) are **all older** than the release foundation and contain **less** UI work. Merging them would be a no-op or would revert the release foundation to an older state.
- The UI work is **already merged**; it just needs to be **enabled** via flags.

**Why not Option A (merge a specific UI branch now)?**
- There is no unmerged UI branch that contains newer work. The release foundation is already the superset.

**Why not Option D (abandon current branch)?**
- The current branch is healthy and contains the desired UI. No need to rebuild.

---

## 8. Should Android Runtime Smoke Continue Now?

**Yes, on the backend foundation.**

The current runtime smoke should focus on:
- Supabase RLS / staging grants fix verification (the stated blocker from the prior smoke report).
- Saved scan cloud sync backend wiring.
- Auth, library, and core scan flow stability.

The UI flag enablement should be **smoked separately** on the proposed integration branch to avoid conflating backend RLS issues with UI layout issues.

---

## 9. Should Supabase Target Fix Continue Now?

**Yes.**

The Supabase target fix (RLS, staging grants, saved scans soft delete) is **independent** of the UI flag issue. The current branch already has the latest backend fixes (`bfa00f2`). Continue the Supabase verification on this branch while the UI flags are tested in parallel on the integration branch.

---

## 10. Next Prompt Recommendation

Prompt the user to confirm whether to create the integration branch and enable the UI flags, or to defer UI flag enablement until after the Supabase RLS smoke is fully green.

Suggested prompt:

> "KS-REL-007C audit complete. The new UI is already in `feature/release-integration-v2-backend-stack-v1` but is gated by environment flags. Create a UI integration branch (`feature/ui-v2-integration-smoke`) and enable the V2 flags for Android smoke, or defer UI enablement until Supabase RLS smoke passes?"

---

## 11. Summary

- **Status:** PASS WITH NOTES
- **Current branch:** `feature/release-integration-v2-backend-stack-v1`
- **Current HEAD:** `bfa00f2`
- **Branch containing expected new UI:** `feature/release-integration-v2-backend-stack-v1` (the UI is already present, just disabled by flags)
- **Diff summary:** No external UI branch needed; candidate branches are older and contain less UI work.
- **Risk level:** LOW for enabling UI flags (no code changes, no migrations, no native changes). MEDIUM if backend APIs are not ready for the new UI flows.
- **Supabase target fix still needed:** Yes, continue independently.
- **Android runtime smoke status:** Continue on backend foundation; create separate UI integration branch for V2 UI smoke.
- **Recommended next branch:** `feature/ui-v2-integration-smoke` (new, from current release foundation)
- **Recommended next prompt:** Ask user whether to create the integration branch and enable V2 flags now, or defer until Supabase smoke is green.
- **Remaining blockers:** None from this audit. Backend RLS verification remains the outstanding blocker from prior smoke reports.
