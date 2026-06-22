# K Scan AI - Android Smoke Test Code-Only Fix Report

Branch: `feature/ui-v2-integration-smoke`
Files reviewed: 18+
Files modified: 9

## Smoke Test Fix Summary

| # | Failed smoke item | Fix status | Root cause | File(s) changed |
|---|---|---|---|---|
| 1 | HOME button position / safe-area placement | **Fixed** | `SafeAreaProvider` was missing from root layout; `useSafeAreaInsets()` in `ScanRoomHeader` and `StyleChatHeader` returned `0` insets on Android. | `app/_layout.tsx` |
| 2 | Correct navigation to approved Home experience | **Fixed** | `app/index.tsx` gated `HomeLuxuryTechV1` behind flags that defaulted false in release, so authenticated users fell back to `HomeLegacy`. | `app/index.tsx` |
| 3 | Home welcome/hero image appearing | **Fixed** | Same root cause as #2: `HomeLuxuryTechV1` and `home-hero-v1.png` never mounted on the authenticated default path. | `app/index.tsx` |
| 4 | StyleChat keyboard positioning | **Fixed** | Android needed native `adjustResize`; `KeyboardAvoidingView` should only apply `padding` on iOS. | `app/style-chat/[sessionId].tsx` |
| 5 | StyleChat title/letter bleed, truncation, overflow | **Fixed** | The title lacked enough width constraint and shrink behavior for Android. | `components/style-chat/StyleChatHeader.tsx` |
| 6 | Release-path Expo public env access | **Fixed** | Optional chaining and `typeof process` guards prevented or risked preventing Expo public env inlining in release-path source. | `constants/featureFlags.ts`, `data/scan-results-demo.ts`, `services/sneakers/index.ts`, `services/sneakers/providers/hoseaSneakerApi.ts`, `services/sneakers/providers/sneaksApi.ts` |
| 7 | Android app version alignment | **Fixed** | `app.json` still had Android `versionCode` `6` while Gradle already used `9`. | `app.json` |

## Fixes Applied

### Fix 1 - `app.json` version alignment
Before: `app.json` had Android `"versionCode": 6` while `android/app/build.gradle` had `versionCode 9`.

After: `app.json` now uses `"versionCode": 9` to match Gradle, and `sdkVersion` remains `"54.0.0"` to stay aligned with `package.json` (`expo ~54.0.35`, `react-native 0.81.5`).

Why: This removes Android version drift and avoids an incorrect SDK downgrade.

### Fix 2 - `app/_layout.tsx` adds `SafeAreaProvider`
Before: No `SafeAreaProvider` wrapped the app tree, so Android safe-area consumers could receive zero insets.

After: The root layout now wraps the providers and router stack in `SafeAreaProvider`.

Why: This is the smallest safe fix for header placement without changing routing or auth flow.

### Fix 3 - `app/index.tsx` makes the approved Home deterministic
Before: Authenticated Home routing still allowed `HomeLegacy` or `HomeV2` to render based on release flags.

After: `app/index.tsx` now returns `HomeLuxuryTechV1` directly for the default Home route.

Why: The approved Home hero lives in `HomeLuxuryTechV1`, and this guarantees it is the authenticated default.

### Fix 4 - `app/style-chat/[sessionId].tsx` keeps Android on native resize
Before: Android keyboard handling mixed `KeyboardAvoidingView` behavior with native resize expectations.

After: `behavior="padding"` and the top inset offset are now iOS-only, while Android relies on `adjustResize`.

Why: This avoids the composer being covered by the keyboard on Android while preserving iOS behavior.

### Fix 5 - `components/style-chat/StyleChatHeader.tsx` constrains the title
Before: The title could bleed or truncate because it lacked enough shrink behavior and centering width.

After: The title now uses `numberOfLines={1}`, `adjustsFontSizeToFit`, `minimumFontScale={0.85}`, `textAlign: 'center'`, and `width: '100%'`, with narrower side spacing.

Why: This gives Android a bounded width to shrink within and reduces edge collisions.

### Fix 6 - release-path Expo public env cleanup
Before: Some release-path source still used `process.env?.EXPO_PUBLIC_*` or `typeof process` guards around `EXPO_PUBLIC_*` checks.

After: Those paths now use direct static Expo public env access:

```ts
process.env.EXPO_PUBLIC_...
```

Why: Expo only inlines public env values reliably with static property access. The remaining broader-search match is the intentionally private `process.env.SNEAKER_DATABASE_API_KEY`, which is not `EXPO_PUBLIC_*` and was left unchanged.

## Source-Only Validation Checks

| Check | Status | Evidence |
|---|---|---|
| No `process.env?.EXPO_PUBLIC_*` in runtime-critical source | PASS | Focused and broader searches found no remaining runtime-critical optional chaining on Expo public env vars. |
| No runtime-critical `typeof process` guards around Expo public env access | PASS | Fixed in `constants/featureFlags.ts`, `data/scan-results-demo.ts`, and sneaker runtime files that read `EXPO_PUBLIC_*` values. |
| Active Home path points to approved hero-image Home | PASS | `app/index.tsx` unconditionally returns `<HomeLuxuryTechV1 />`. |
| `home-hero-v1.png` rendered in active Home | PASS | `HomeLuxuryTechV1` uses `assets/images/home-hero-v1.png`. |
| Old Home text is not the authenticated default | PASS | `HomeLegacy` no longer renders for the default authenticated `/` route. |
| `KeyboardAvoidingView` does not fight Android resize | PASS | Android uses native `adjustResize`; iOS keeps `padding`. |
| Android resize keyboard behavior configured | PASS | `app.json` uses `"softwareKeyboardLayoutMode": "resize"` and `AndroidManifest.xml` uses `android:windowSoftInputMode="adjustResize"`. |
| StyleChat header title is constrained to one line | PASS | `numberOfLines={1}`, shrink settings, centered width, and reduced side spacing are in place. |
| `app.json` and Gradle Android versions match | PASS | Both now use `versionCode 9`; Gradle keeps `versionName "1.0.0"`. |
| No route, folder, database, or API key renames | PASS | The fixes stay within UI/layout/config behavior only. |

## Remaining Gaps / Notes

1. StyleChat title spacing may still merit a device-specific polish pass on very narrow screens with large accessibility fonts.
2. The Home hero card could still benefit from a narrow-screen visual review because the image remains 140px wide.
3. The remaining broader-search `typeof process` match is the intentionally private `SNEAKER_DATABASE_API_KEY` access in `services/sneakers/providers/sneakerDatabase.ts`; it was left unchanged to avoid altering non-public env behavior.

## Recommended Operator Commands

```powershell
# 1. Diff review
git diff --stat

# 2. Static TypeScript check
npx tsc --noEmit

# 3. Verify no runtime-critical Expo public env patterns remain
Get-ChildItem -Path . -Recurse -Include *.ts,*.tsx,*.js,*.jsx |
  Where-Object { $_.FullName -notmatch '\\node_modules\\|\\android\\app\\build\\|\\.git\\|\\.expo\\' } |
  Select-String -Pattern "process\.env\?\.EXPO_PUBLIC","typeof\s+process"

# 4. Verify Home route is correct
Select-String -Path "app/index.tsx" -Pattern "HomeLuxuryTechV1"

# 5. Verify SafeAreaProvider is in root layout
Select-String -Path "app/_layout.tsx" -Pattern "SafeAreaProvider"

# 6. Verify Android keyboard config
Select-String -Path "app.json" -Pattern "softwareKeyboardLayoutMode"
Select-String -Path "android/app/src/main/AndroidManifest.xml" -Pattern "windowSoftInputMode"
```

## Verdict

**Code ready for device smoke test:** YES.

All five reported smoke failures are addressed with minimal source/config changes. No backend, Supabase, API, package-version, secret, or signing changes were made. The next step is to build a new debug-signed smoke APK for physical-device testing and verify the Home hero, safe-area spacing, keyboard behavior, and StyleChat header on-device.
