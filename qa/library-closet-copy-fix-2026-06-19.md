# Library → Closet Copy-Only Patch — QA Report

**Branch:** `fix/library-closet-copy-v1`  
**Base branch:** `feature/scan-identification-api-v1`  
**Base branch reason:** Scan API branch is the current active integration baseline and includes the latest frontend/backend state.  
**Date:** 2026-06-19  
**Commit:** `style(copy): rename Library UI copy to Closet`

---

## Scope

Frontend copy-only patch. No backend changes. No route changes. No hook/service renames. No testID changes.

---

## Files Changed (12 files, 24 insertions, 24 deletions)

| File | Changes | Surface |
|---|---|---|
| `app.js` | 2 | Camera toast + button label |
| `app/library.tsx` | 4 | Screen header, empty states, delete confirmation |
| `app/text-scan/index.tsx` | 2 | Save CTA buttons (2 locations) |
| `app/dressing-rooms/[id].tsx` | 3 | Remove alert, empty state, accessibility hint |
| `components/home/HomeLegacy.tsx` | 2 | Feature card title + accessibility label |
| `components/home/HomeV2.tsx` | 2 | Destination card title + accessibility label |
| `components/home/HomeLuxuryTechV1.tsx` | 2 | Feature chip accessibility label + hint |
| `components/scan-results/ScanResultV2.tsx` | 1 | JSDoc comment |
| `components/scan-results/ScanResultActionRow.tsx` | 1 | Default `saveLabel` prop value |
| `components/StyleObjectCards.tsx` | 1 | Source badge label |
| `components/dressing-rooms/RoomItemDetailModal.tsx` | 1 | Source badge label |
| `components/InspirationUploadModal.tsx` | 3 | Modal title, accessibility label, button text |

---

## Copy Changes Applied

### Home surfaces

| File | Before | After |
|---|---|---|
| `HomeLegacy.tsx` | `Style Library` | `Closet` |
| `HomeLegacy.tsx` | `Open Style Library` | `Open Closet` |
| `HomeV2.tsx` | `Library` | `Closet` |
| `HomeV2.tsx` | `Open Library` | `Open Closet` |
| `HomeLuxuryTechV1.tsx` | `Open Library` | `Open Closet` |
| `HomeLuxuryTechV1.tsx` | `Navigate to your saved looks and library` | `Navigate to your saved looks and closet` |

### Closet / Library screen

| File | Before | After |
|---|---|---|
| `app/library.tsx` | `Style Library` | `Closet` |
| `app/library.tsx` | `Save screenshots and outfit references to your Style Library.` | `Save screenshots and outfit references to your Closet.` |
| `app/library.tsx` | `Upload screenshots and outfit references to round out your Style Library.` | `Upload screenshots and outfit references to round out your Closet.` |
| `app/library.tsx` | `This will remove the image from your Style Library and any Dressing Rooms it was added to.` | `This will remove the image from your Closet and any Dressing Rooms it was added to.` |

### Scan Results / Save CTAs

| File | Before | After |
|---|---|---|
| `ScanResultV2.tsx` (JSDoc) | `Style Library` | `Closet` |
| `ScanResultActionRow.tsx` | `Save to Library` | `Save to Closet` |
| `app.js` (toast) | `Saved to Style Library` | `Saved to Closet` |
| `app.js` (button) | `LIBRARY` | `CLOSET` |

### TextScan / Upload flows

| File | Before | After |
|---|---|---|
| `app/text-scan/index.tsx` | `Save to Style Library` | `Save to Closet` |
| `app/text-scan/index.tsx` | `Save to Style Library` | `Save to Closet` |

### Dressing Rooms

| File | Before | After |
|---|---|---|
| `app/dressing-rooms/[id].tsx` | `The image will remain in your Style Library.` | `The image will remain in your Closet.` |
| `app/dressing-rooms/[id].tsx` | `Start adding items from your scans, uploads, or Library.` | `Start adding items from your scans, uploads, or Closet.` |
| `app/dressing-rooms/[id].tsx` | `The image will remain in your Style Library` | `The image will remain in your Closet` |
| `RoomItemDetailModal.tsx` | `Library` | `Closet` |

### Inspiration Upload Modal

| File | Before | After |
|---|---|---|
| `InspirationUploadModal.tsx` | `Add to Style Library` | `Add to Closet` |
| `InspirationUploadModal.tsx` | `Save to style library` | `Save to closet` |
| `InspirationUploadModal.tsx` | `Saving Library` | `Saving Closet` |

### Style Object Cards (source badges)

| File | Before | After |
|---|---|---|
| `StyleObjectCards.tsx` | `Library` | `Closet` |

---

## Technical Identifiers Preserved (Intentionally Not Changed)

| Identifier | Reason |
|---|---|
| `app/library.tsx` | File name — route must remain stable |
| `/library` | Route path — navigation must remain stable |
| `router.push('/library')` | Route navigation — no route change |
| `useLibrary` | Hook name — API contract stable |
| `LibraryProvider` | Provider name — not present in changed files |
| `LIBRARY_ROOM_V2_UI_ENABLED` | Feature flag — not present in changed files |
| `testID="library-button"` | Test automation identifier |
| `testID="textscan-save-library"` | Test automation identifier |
| `testID="home-luxury-feature-library"` | Test automation identifier |
| `testID="open-library-button"` | Test automation identifier |
| `testID="home-v2-library-card"` | Test automation identifier |
| `onSaveToLibrary` | Prop name — API contract stable |
| `scanSourceType="style_library_scan"` | Source type enum — data contract stable |
| `sourceType: 'style_library_scan'` | Source type enum — data contract stable |
| `services/library.js` | Service file — API contract stable |
| `loadLibrary`, `persistLibrary` | Service functions — API contract stable |
| `LibraryScreen` | Component function name — internal identifier |
| `requestMediaLibraryPermissionsAsync` | Expo API — not K Scan product name |
| `launchImageLibraryAsync` | Expo API — not K Scan product name |
| `photo library` / `media library` | Device photo library references — not K Scan product |
| `NSPhotoLibraryUsageDescription` | iOS plist key — system permission |
| `React Testing Library` | Test framework reference — not product name |
| `STYLE_LIBRARY_IMAGES_BUCKET` | Storage bucket constant — backend contract |
| `style-library-images` | Storage bucket name — backend contract |
| `kscan_library/` | File system directory — local storage path |
| Code comments in `app.js`, `hooks/useLibrary.js`, `services/library.js` | Developer-facing comments, not user-visible UI |

---

## Remaining `Library` / `library` / `LIBRARY` Matches

All remaining matches are classified as **technical identifier** and **preserved intentionally**:

- Expo API calls (`requestMediaLibraryPermissionsAsync`, `launchImageLibraryAsync`)
- Hook imports and calls (`useLibrary`)
- Service imports and functions (`services/library`, `loadLibrary`, `persistLibrary`)
- Prop names (`onSaveToLibrary`)
- Source type enums (`style_library_scan`)
- File paths (`app/library.tsx`)
- Route strings (`/library`)
- Test IDs (`library-button`, `textscan-save-library`, etc.)
- Code comments and JSDoc
- iOS permission strings (`NSPhotoLibraryUsageDescription`)
- Test framework references (`React Testing Library`)
- Storage bucket constants (`STYLE_LIBRARY_IMAGES_BUCKET`)

**Zero user-visible JSX text nodes still contain "Library" or "Style Library" after this patch.**

---

## Validation Results

| Check | Result | Details |
|---|---|---|
| `tsc --noEmit` | ✅ PASS | Clean, zero errors |
| `node --test __tests__/*.js` | ✅ PASS (baseline) | 3 known pre-existing failures unchanged: `authPrivacy.test.js`, `useKScanDuplicateGuard.test.js`, `verifyAppleReadiness.test.js` |
| `git diff --check` | ✅ PASS | Only LF→CRLF whitespace warnings (Windows environment, expected) |
| `git diff --stat` | ✅ PASS | 12 files changed, 24 insertions(+), 24 deletions(-) |
| No testIDs renamed | ✅ PASS | All 5 `library`-related testIDs preserved unchanged |
| No routes renamed | ✅ PASS | All `/library` routes preserved |
| No hooks renamed | ✅ PASS | `useLibrary` preserved in all files |
| No backend files touched | ✅ PASS | Zero changes to `services/`, `supabase/`, `hooks/` logic |
| No package/env/native changes | ✅ PASS | None touched |

---

## What Was NOT Changed

- Backend scan API files ( untouched)
- Supabase functions / edge functions
- Database migrations
- Auth logic
- Scan capture logic / camera lifecycle
- `package.json`, `package-lock.json`, `yarn.lock`
- Native Android/iOS config (`AndroidManifest.xml`, `app.json`, `Info.plist`)
- Environment files (`.env`, `env.ts`)
- Waitlist QA docs (`qa/waitlist-project-consolidation-2026-06-18.md`)
- Feature flags (no new flags added)
- No new routes created
- No new save behavior added
- No Dressing Room behavior changed
- No test IDs renamed

---

## Manual Smoke Status

**DEFERRED** — No Expo/Metro runtime or device emulator available in this environment.

Recommended manual smoke checks:
- Home renders with "Closet" feature cards
- Closet screen (`/library`) header shows "Closet"
- Empty states show "Closet" copy
- Scan result save CTA shows "Save to Closet"
- TextScan save CTA shows "Save to Closet"
- Camera toast shows "Saved to Closet"
- Dressing Room remove alert shows "Closet"
- Inspiration upload modal shows "Add to Closet"
- All routes still navigate to `/library` correctly
- Test IDs remain stable for automation

---

## Safe to Proceed to QA

✅ **Yes.** This is a pure copy-only patch with zero functional changes. All technical identifiers, routes, hooks, test IDs, and backend contracts remain intact. The only risk is copy inconsistency if any file was missed, but the broad search confirms no user-visible "Library" copy remains in JSX text nodes.

