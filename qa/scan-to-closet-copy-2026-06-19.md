# K Scan AI — Scan-to-Closet Copy Report

## 1. Branch / Commit

**Branch:** `fix/scan-to-closet-copy-v1`  
**Base:** `feature/scan-identification-api-v1` (active integration baseline with backend scan-to-closet persistence merged)  
**Commit:** `42d3438` (cherry-picked from `b9273ee` which was accidentally placed on `feature/scan-identification-api-v1`, then QA doc amended)  
**Working tree:** Clean (no modified tracked files, only untracked QA/docs)

**Note on accidental commit:** The original commit `b9273ee` was accidentally committed to `feature/scan-identification-api-v1` instead of `fix/scan-to-closet-copy-v1`. The commit was cherry-picked to `fix/scan-to-closet-copy-v1` as `7de54d5`. The integration branch still contains `b9273ee` at its tip. This is a copy-only patch with zero functional changes, so it does not break the integration branch. If desired, `b9273ee` can be reverted from `feature/scan-identification-api-v1` using `git revert b9273ee` or the branch can be reset to `47358c2`.

## 2. Product Decision

| Item | Value |
|---|---|
| User-facing term | `Closet` (already renamed in prior patch) |
| Feature-language term | `Scan-to-Closet` |
| Technical route retained | `/library` (unchanged) |
| Technical hook retained | `useLibrary` (unchanged) |
| Backend untouched | ✅ Confirmed — zero backend, API, Supabase, or migration changes |

## 3. Files Changed

```
app/dressing-rooms/[id].tsx  | 2 +-
app/library.tsx             | 6 +++---
components/home/HomeLuxuryTechV1.tsx | 2 +-
3 files changed, 5 insertions(+), 5 deletions(-)
```

**Files:**
- `app/dressing-rooms/[id].tsx`
- `app/library.tsx`
- `components/home/HomeLuxuryTechV1.tsx`

## 4. Copy Changes Applied

### Home

| File | Location | Before | After |
|---|---|---|---|
| `HomeLuxuryTechV1.tsx` | SAVE & ORGANIZE feature chip body | `Save your favorites to your closet.` | `Scan-to-Closet style memory.` |

### Closet empty state

| File | Location | Before | After |
|---|---|---|---|
| `app/library.tsx` | Scans empty state (no items) | `Your saved scans and inspirations will appear here.` | `Scan-to-Closet starts here. Save scans, uploads, and outfit references into your Closet.` |
| `app/library.tsx` | Unauthenticated inspiration state | `Save screenshots and outfit references to your Closet.` | `Scan-to-Closet and save inspiration to your Closet.` |
| `app/library.tsx` | Inspiration empty state (no uploads) | `Upload screenshots and outfit references to round out your Closet.` | `Scan-to-Closet starts here. Upload screenshots to round out your Closet.` |

### Dressing Rooms

| File | Location | Before | After |
|---|---|---|---|
| `app/dressing-rooms/[id].tsx` | Empty room body | `Start adding items from your scans, uploads, or Closet.` | `Start adding items from your scans, uploads, or Closet. Use Scan-to-Closet to save looks.` |

### Scan result
- No natural placement found. The `ScanResultV2` action row already says `Save to Closet` (concise, clear). No success toast or helper text exists to enhance without adding new UI.

### Upload/TextScan
- No natural placement found. TextScan save button is `Save to Closet` — no helper text field. Do not force the phrase into an unnatural context.

### Onboarding
- No natural placement found in existing onboarding copy.

### Scan-room
- No natural placement found. `AnalyzingScan` step labels are technical progression states, not product education copy.

### Profile/Privacy
- No user-facing Closet references found that would benefit from Scan-to-Closet language.

### Accessibility
- Home chip accessibility hint: `Navigate to your saved looks and closet` — already correct, no change needed.
- Library empty states: no explicit accessibility labels added beyond what the `EmptyStateCard` component provides.

## 5. Library Remnants

### Remnants found (5 matches)

| File | Match | Classification | Action |
|---|---|---|---|
| `app.js:406` | `// Save each successful scan once to the local Style Library.` | Code comment (developer-only) | Preserved intentionally |
| `app.js:1405` | `// "Saved to Style Library" toast` | Code comment (developer-only) | Preserved intentionally |
| `hooks/useLibrary.js:12` | `* Manages local + cloud scan library state for the Style Library screen.` | JSDoc comment (developer-only) | Preserved intentionally |
| `services/library.js:2` | `* K-SCAN local Style Library — scan persistence via expo-file-system.` | JSDoc comment (developer-only) | Preserved intentionally |
| `kscan-google-glasses/demo/investor-hud/demo.js:109` | `showToast('Saved to Library');` | Separate glasses demo project, not mobile app | Preserved intentionally (out of scope) |

### Remnants changed
- Zero. All user-visible `Library`/`Style Library` copy was already renamed in the prior `fix/library-closet-copy-v1` patch.

### Remnants intentionally left
- All 5 matches are code comments, JSDoc, or a separate demo project. None are user-visible JSX text nodes.

## 6. Scan-to-Closet Usage Count

**Total visible placements: 5**

| # | Location | File | Line | Context |
|---|---|---|---|---|
| 1 | Home chip body | `HomeLuxuryTechV1.tsx` | 296 | SAVE & ORGANIZE feature card |
| 2 | Closet scans empty | `app/library.tsx` | 218 | Empty state subtitle |
| 3 | Closet unauthenticated | `app/library.tsx` | 282 | Empty state subtitle |
| 4 | Closet inspiration empty | `app/library.tsx` | 300 | Empty state subtitle |
| 5 | Dressing Rooms empty | `app/dressing-rooms/[id].tsx` | 803 | Empty room body |

**Deferred opportunities (documented but not applied):**
- Scan result success/toast copy — no existing toast or helper text to enhance without adding new UI
- TextScan save helper — no natural helper text field; phrase would read unnaturally
- Onboarding — no existing onboarding copy referencing Closet in a way that supports Scan-to-Closet
- AnalyzingScan step labels — technical progression states, not education copy
- Profile/Privacy — no relevant user-facing Closet references

## 7. What Was Not Changed

### Routes / href / router.push
- All `/library` routes preserved unchanged
- `router.push('/library')` preserved in HomeLuxuryTechV1.tsx
- `href="/library"` preserved where present
- `name="library"` preserved where present
- `app/library.tsx` filename unchanged

### Hooks
- `useLibrary` import and usage preserved in all files
- `useLibrary` from `hooks/useLibrary.js` unchanged

### Backend
- No Supabase calls modified
- No edge functions modified
- No API contracts modified
- No database fields renamed
- No migrations added
- No storage buckets renamed

### Scan wiring
- No scan capture, analysis, or processing logic changed
- `AnalyzingScan` step labels unchanged (technical progression)
- `ScanResultV2` save action unchanged (`Save to Closet` already correct)

### Packages / native / env
- No `package.json`, `package-lock.json`, `yarn.lock` changes
- No `AndroidManifest.xml`, `app.json`, `Info.plist`, `eas.json` changes
- No `.env` or env-file changes
- No Metro or Expo tooling changes

### Waitlist docs
- `qa/waitlist-project-consolidation-2026-06-18.md` untouched
- `qa/waitlist-project-consolidation-2026-06-19.md` untouched

### Test IDs
- `library-button` (app.js) preserved
- `textscan-save-library` (app/text-scan/index.tsx) preserved
- `home-luxury-feature-library` (HomeLuxuryTechV1.tsx) preserved
- `open-library-button` (HomeLegacy.tsx) preserved
- `home-v2-library-card` (HomeV2.tsx) preserved
- `scan-card` (app/library.tsx) preserved
- `upload-inspiration-button` (app/library.tsx) preserved
- `home-luxury-style-pick-*` (HomeLuxuryTechV1.tsx) preserved

## 8. Validation

| Check | Result | Details |
|---|---|---|
| `tsc --noEmit` | ✅ PASS | Clean, zero errors |
| `node --test __tests__/*.js` | ✅ PASS (baseline) | 3 known pre-existing failures unchanged: `authPrivacy.test.js`, `useKScanDuplicateGuard.test.js`, `verifyAppleReadiness.test.js` |
| `git diff --check` | ✅ PASS | Only LF→CRLF whitespace warnings (Windows environment, expected) |
| `git diff --stat` | ✅ PASS | 3 files changed, 5 insertions(+), 5 deletions(-) |
| `git diff --name-only` | ✅ PASS | Only 3 files touched: dressing-rooms, library, HomeLuxuryTechV1 |
| No new routes added | ✅ PASS | Confirmed |
| No new hooks added | ✅ PASS | Confirmed |
| No testIDs renamed | ✅ PASS | All library-related testIDs preserved |
| No backend files touched | ✅ PASS | Zero changes to services/, supabase/, hooks/ logic |
| No package/env/native changes | ✅ PASS | None touched |
| Scan-to-Closet count ≤ 7 | ✅ PASS | Exactly 5 visible placements |

## 9. Manual Smoke

**Runtime:** DEFERRED — No Expo/Metro runtime or device emulator available in this environment.

**Recommended smoke checks:**
- Home renders with "Scan-to-Closet style memory." on the SAVE & ORGANIZE chip
- Closet empty state shows "Scan-to-Closet starts here." when no scans exist
- Closet unauthenticated state shows "Scan-to-Closet and save inspiration..."
- Closet inspiration empty state shows "Scan-to-Closet starts here." when no uploads
- Dressing Room empty state shows "Use Scan-to-Closet to save looks."
- All routes still navigate to `/library` correctly
- Save action still shows "Save to Closet" (not changed, already correct)
- No new toasts, banners, modals, or state hooks introduced

## 10. Recommendation

**Ready to merge:** ✅ Yes

**Expand Scan-to-Closet later:** Possible, but not recommended beyond the current 5 placements. The phrase is already present in:
- Home (primary entry point)
- Closet (3 empty states covering all user states)
- Dressing Rooms (cross-feature awareness)

Additional placements would require:
- Adding new helper text components to ScanResultV2 or TextScan (would violate "copy-only, no new UI" rule)
- Forcing the phrase into onboarding or technical scan states (would read unnaturally)

**Remaining risk:** Minimal. This is a pure string-literal replacement. The only risk is copy feeling slightly aspirational before the full scan-to-closet save flow is complete in all surfaces. However, the backend scan identify → save flow is already merged into the base branch (`feature/scan-identification-api-v1`), so the capability exists.

**Backend team note:** Backend error messages and toast copy in the scan API response pipeline should be audited for any remaining "Library" terminology and replaced with "Closet" in user-facing strings.
