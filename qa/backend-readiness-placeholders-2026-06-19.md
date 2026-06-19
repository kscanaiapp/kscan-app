# K Scan AI — Backend-Readiness Placeholder Patch V1 Report

## Branch / Commit

Current branch: `feature/backend-readiness-placeholders-v1`
Base branch: `feature/account-home-ux-v1`
Commit: pending
Working tree: Clean except untracked `qa/waitlist-project-consolidation-2026-06-18.md` (left untouched)

## Integration Contract Summary

### Permission Preferences Hook Contract
Hook: `usePermissionPreferences()` in `hooks/usePermissionPreferences.ts`

Return shape:
```ts
preferences: PermissionPreferences
status: 'local_only' | 'saving' | 'saved' | 'error' | 'backend_not_connected'
isSaving: boolean
error: string | null
backendConnected: false
setPreference(key, value)
togglePreference(key)
savePreferences(): Promise<SavePreferencesResult>
resetPreferences()
```

### Permission savePreferences Result Shape
```ts
{
  ok: true,
  persisted: false,
  backendConnected: false,
  reason: 'backend_not_connected'
}
```

### Style Picks Hook Contract
Hook: `useStylePicks()` in `hooks/useStylePicks.ts`

Return shape:
```ts
picks: StylePick[]
status: 'backend_not_connected' | 'loading' | 'empty' | 'error' | 'ready'
isLoading: boolean
error: string | null
backendConnected: false
refresh(): Promise<RefreshStylePicksResult>
```

### Style Picks Refresh Result Shape
```ts
{
  ok: true,
  persisted: false,
  backendConnected: false,
  reason: 'backend_not_connected'
}
```

### Legal Timestamp Handling
- Timestamps captured inside `handleAcceptAndContinue` at the exact moment of user tap
- `const acceptedAt = new Date().toISOString()`
- `acceptedTermsAt = acceptedAt`, `acceptedPrivacyAt = acceptedAt`, `acceptedAgeAt = acceptedAt`
- Kept local only; `recordLegalAcceptances` does not accept timestamps (signature unchanged)
- `recordLegalAcceptances` called with `TERMS_VERSION`, `PRIVACY_VERSION`, `AGE_VERSION` from `constants/legal.ts`

### Legal Version Source
- `constants/legal.ts` created with `TERMS_VERSION = '1.0'`, `PRIVACY_VERSION = '1.0'`, `AGE_VERSION = '1.0'`
- Backend legal versioning may supersede these frontend constants later

## Type Placement

StylePick type location: `types/stylePicks.ts` (new dedicated file)
StylePicksStatus type location: `types/stylePicks.ts` (same file)
Existing type collision avoided: Yes — no overlap with `types/scan.ts` (Product type with commerce fields) or `types/styleObjects.ts`
Reason: StylePick is intentionally non-commerce; kept in its own file to avoid coupling with product/commerce types

## Async Placeholder Behavior

savePreferences async: Yes — 300ms delay with `await new Promise(...)`
refresh async: Yes — 300ms delay with `await new Promise(...)`
Loading state exposed: Yes — `isSaving` / `isLoading` returned from hooks
Artificial delay used: Yes — 300ms to force UI loading state handling
Persisted false returned: Yes — both hooks return `persisted: false`, `backendConnected: false`, `reason: 'backend_not_connected'`

## UI State Styling

Style Picks backend_not_connected styling: Uses `stylePicksPlaceholder` with `LUXURY.colors.cream`, `LUXURY.colors.border`, `LUXURY.typography.bodyStrong` / `body`
Style Picks empty styling: Same placeholder container, body text only
Style Picks error styling: Same placeholder container, "We couldn't load your style picks. Please try again."
Style Picks ready styling: `stylePickCard` using `LUXURY.colors.pearl`, `LUXURY.colors.border`, `SHADOWS.editorialSmall`
Theme tokens used: `LUXURY.colors.cream`, `pearl`, `border`, `ink`, `graphite` + `LUXURY.typography.bodyStrong`, `body`, `caption` + `RADIUS.lg`, `SPACING.lg`, `md`, `xl`, `SHADOWS.editorialSmall`
Hardcoded colors added: No — all colors from `LUXURY` tokens

## Files Changed

### New files:
- `hooks/usePermissionPreferences.ts` — async placeholder hook for permission preferences
- `hooks/useStylePicks.ts` — async placeholder hook for style picks/recommendations
- `types/stylePicks.ts` — `StylePick` and `StylePicksStatus` types (non-commerce-safe)
- `constants/legal.ts` — `TERMS_VERSION`, `PRIVACY_VERSION`, `AGE_VERSION` constants

### Modified files:
- `app/onboarding/index.tsx` — replaced inline permission state with `usePermissionPreferences`; updated legal timestamps; uses `constants/legal` versions
- `components/account-home/PermissionsStepV1.tsx` — updated props to accept hook contract; added `isSaving` loading state; `ActivityIndicator` imported for future loading states
- `components/home/HomeLuxuryTechV1.tsx` — integrated `useStylePicks`; replaced hardcoded Style Picks placeholder with hook-driven state rendering (loading/error/empty/ready); added feature chips comment

## Validation

- `npx tsc --noEmit`: **PASS** (no errors)
- `node --test __tests__/*.js`: Known baseline failures remain. No new failures.
- `git diff --check`: Only LF→CRLF warnings (normal on Windows). No whitespace errors.

## Manual Smoke Checklist

- [ ] Permissions toggles still move visually.
- [ ] No native permission dialogs appear from onboarding toggles.
- [ ] Not Now still advances correctly.
- [ ] Continue to Home still advances correctly (with 300ms saving delay).
- [ ] Style Picks placeholder appears with no prices, retailers, match percentages, or product cards.
- [ ] Legal checkboxes still block progression when unchecked.
- [ ] Legal acceptance still calls existing persistence.
- [ ] Legal failure still blocks progression.
- [ ] Home still renders.
- [ ] Scan Home button still appears after this patch.

## Runtime / Manual Smoke

Runtime/manual smoke run: **NOT RUN** — requires device/emulator testing.

## Backend Follow-up Required

1. **Permission preferences persistence**: Wire `savePreferences` in `usePermissionPreferences` to a Supabase `user_preferences` table or user metadata.
2. **Style Picks backend**: Implement recommendation engine endpoint; wire `refresh` in `useStylePicks` to fetch real picks.
3. **Legal timestamp acceptance**: Update `recordLegalAcceptances` service signature to accept `acceptedAt` timestamps; pass them from `handleAcceptAndContinue`.
4. **Legal version discovery**: Move version constants to backend-driven config or expose via API.

## Backend / Repo Safety

Backend files changed: No.
Supabase changed: No.
Native config changed: No.
Environment files changed: No.
Package files changed: No.
Waitlist QA file touched: **No**. `qa/waitlist-project-consolidation-2026-06-18.md` remains untracked and untouched.
