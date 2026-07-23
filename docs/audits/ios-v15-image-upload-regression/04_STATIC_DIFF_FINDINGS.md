# 04 — Static Diff Findings

## High-priority investigation results

### 1. Asset URI normalization — NOT the root cause
Picker / URI handling between v13 and v15 is compatible. Failure occurs after a usable compressed image exists.

### 2. Temporary-file lifecycle — NOT the root cause
No evidence of premature deletion of Scanner prep files in the v13→v15 upload break. Elise prep never created files because preparation threw immediately.

### 3. Authentication timing — NOT the root cause
Session attach via `supabase.functions.invoke` is unchanged. Requests never leave the device on the broken path.

### 4. Async ownership — NOT the root cause
AbortController / duplicate-guard logic remains sound and is covered by unit tests.

### 5. Metadata (HEIC/JPEG/PNG) — NOT the root cause
Format-specific handling is not what blocks every upload. Gallery UI is disabled before format matters; sanitizer throws for all inputs.

### 6. Native dependency drift — NOT the root cause
Expo SDK 54 / image-picker / manipulator remain on the same major surface for v13–v15 production builds. The break is application-level privacy gating.

## Confirmed broken diffs

1. `services/privacyImageSanitizer.js` — `passthrough` → `blocked` + throw
2. `services/privacyImageUpload.ts` — working re-encode → `isPrivateImageUploadAvailable() => false` + throw
3. `services/scanIdentification.ts` — added `hasCompleteLocalPrivacyProof` that no caller satisfies
4. `ScanLanding.tsx` / `LiveScanCamera.tsx` — wired disabled state to (2)

## Package / app config

`package.json` / lockfile / Expo SDK drift is not required to explain the failure class.
