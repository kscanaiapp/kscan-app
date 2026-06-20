# Home Action Card Routing Fix — QA Report

**Branch:** `fix/home-action-card-routing-v1`  
**Base:** `feature/backend-readiness-placeholders-v1`  
**Date:** 2026-06-19  
**Commit:** `fix(ui): route home action cards to core surfaces`

---

## What Changed

**File:** `components/home/HomeLuxuryTechV1.tsx`

### 1. FeatureChip now accepts navigation props

- Added `onPress?: () => void`, `testID?: string`, `accessibilityLabel?: string`, `accessibilityHint?: string` to `FeatureChipProps`.
- Changed `FeatureChip` return from `View` to `Pressable` with conditional `accessibilityRole="button"` when `onPress` is provided.
- **No style changes** — `chip` style is already compatible with `Pressable` (View-style properties only).

### 2. Replaced 4th grid card

| Before | After |
|---|---|
| **Private by Design**<br>Your data stays yours. | **DRESSING ROOMS**<br>Compare, save, and decide. |

### 3. Wired all 4 feature cards as navigation actions

| Card Title | Route | Accessibility Label | Accessibility Hint |
|---|---|---|---|
| AI STYLIST | `/style-chat` | Open AI Stylist | Navigate to StyleChat |
| VISUAL SEARCH | `/scan` | Open Visual Search | Navigate to the scan camera |
| SAVE & ORGANIZE | `/library` | Open Library | Navigate to your saved looks and library |
| DRESSING ROOMS | `/dressing-rooms` | Open Dressing Rooms | Navigate to dressing rooms to compare outfits |

### 4. Unchanged features preserved

- **Hero Start Scan button** → still routes to `/scan` (pre-existing).
- **TextScan CTA** (full-width secondary button) → still routes to `/text-scan` when `TEXTSCAN_UI_ENABLED`.
- **Privacy footer** with Privacy Policy link → unchanged, still routes to `/privacy`.
- **Style Picks placeholder** → unchanged: "Style inspiration coming soon" remains until backend is wired.
- **Recent Scans section** → unchanged, horizontal `SavedLookCard` scroll still routes to `/library`.
- **All backend-readiness placeholders** (`useStylePicks`, `useLibrary`, `useAuthSession`) — untouched.

---

## Validation Results

| Check | Result | Details |
|---|---|---|
| `tsc --noEmit` | ✅ PASS | Clean, zero errors |
| `node --test __tests__/*.js` | ✅ PASS (baseline) | 3 known pre-existing failures unrelated to this change: `authPrivacy.test.js`, `useKScanDuplicateGuard.test.js`, `verifyAppleReadiness.test.js` |
| `git diff --check` | ✅ PASS | Only LF→CRLF whitespace warning (Windows environment, expected) |
| `git diff --stat` | ✅ PASS | Only `components/home/HomeLuxuryTechV1.tsx` changed: 32 insertions, 5 deletions |
| `git diff --name-only` | ✅ PASS | Only `components/home/HomeLuxuryTechV1.tsx` |

---

## Route Mapping Verification

| Route | Target File | Confirmed |
|---|---|---|
| `/style-chat` | `app/style-chat/index.tsx` | ✅ |
| `/scan` | `app/scan/index.tsx` | ✅ |
| `/library` | `app/library.tsx` | ✅ |
| `/dressing-rooms` | `app/dressing-rooms/index.tsx` | ✅ |
| `/text-scan` | `app/text-scan/index.tsx` | ✅ |
| `/privacy` | `app/privacy.tsx` | ✅ |

---

## What Was NOT Changed

- **Backend** — no Supabase calls, edge functions, or API routes added/modified.
- **Auth** — no auth state, validation, or OAuth logic changed.
- **Scan capture logic** — camera, upload, analysis pipeline untouched.
- **Package files** — no `package.json`, `package-lock.json`, `expo` config changes.
- **Environment files** — no `.env` or `env.ts` modifications.
- **Native config** — `AndroidManifest.xml`, `app.json`, `Info.plist` untouched.
- **Waitlist QA docs** — `qa/waitlist-project-consolidation-2026-06-18.md` untouched.
- **No fake commerce** — no prices, retailers, inventory, or match percentages added.
- **No new backend/network calls** — only `router.push(...)` navigation actions.

---

## Manual Smoke Checklist (Pending Device Testing)

- [ ] Home renders without crash.
- [ ] AI Stylist card opens StyleChat (`/style-chat`).
- [ ] Visual Search card opens Scan (`/scan`).
- [ ] Save & Organize card opens Library (`/library`).
- [ ] Dressing Rooms card opens Dressing Rooms (`/dressing-rooms`).
- [ ] TextScan CTA opens TextScan (`/text-scan`).
- [ ] Privacy Policy link still works (`/privacy`).
- [ ] Android Back behavior returns to Home from each destination.
- [ ] No new backend/network calls are triggered by tapping cards.
- [ ] iOS and Android both render cards correctly.

**Runtime smoke status: NOT RUN — requires human/device confirmation.**

---

## Acceptance Criteria

| Criterion | Status | Evidence |
|---|---|---|
| 4th card replaced from "Private by Design" to "Dressing Rooms" | ✅ PASS | `FeatureChip` at lines 279–286 in `HomeLuxuryTechV1.tsx` |
| All 4 cards wired as navigation actions | ✅ PASS | `onPress` props added to all 4 `FeatureChip`s with `router.push(...)` |
| TextScan CTA preserved below grid | ✅ PASS | `SecondaryButton` at lines 287–296 unchanged |
| Privacy statement and Privacy Policy link preserved | ✅ PASS | `PrivacyFooter` at lines 298–303 unchanged |
| Backend-readiness placeholder preserved | ✅ PASS | Style Picks placeholder text "Style inspiration coming soon" remains |
| No backend changes | ✅ PASS | No Supabase, edge function, or API modifications |
| No auth changes | ✅ PASS | No auth state, validation, or OAuth changes |
| No scan capture logic changes | ✅ PASS | Camera/upload/analysis untouched |
| No package/env/native changes | ✅ PASS | `git diff --name-only` confirms only one file changed |
| TypeScript compiles clean | ✅ PASS | `tsc --noEmit` clean |
| Baseline tests unchanged | ✅ PASS | Same 3 pre-existing failures as before patch |

