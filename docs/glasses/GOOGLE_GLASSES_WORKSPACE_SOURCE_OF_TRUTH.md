# Google Glasses Workspace Source of Truth

## Main K Scan Repo — Expo/RN Mobile Prototype

- Branch: `feature/glasses-xr-isolated-prototype`
- Contains: six isolated prototype files only
- Does **not** contain native `android-xr/`
- Use for: mobile app glasses UI preview/mock flow

## Standalone Native Android XR Workspace

- Recovered worktree: `C:\Users\jsmit\kscan-google-glasses-recovery`
- Original repo path: `C:\Users\jsmit\kscan-google-glasses`
- Remote branch: `feature/glasses-xr-native-standalone`
- Contains: native Android XR project under `android-xr/`
- Important fix: `e4a5873` — ensures DRY_RUN uses offline mock analyze path
- Use for: native Android XR and future glasses hardware development

## Non-Canonical Paths

- `C:\Users\jsmit\KScan\kscan-google-glasses` does not exist and is non-canonical
- If recreated later, it must be reconciled before use
- The original `C:\Users\jsmit\kscan-google-glasses` is degraded (dirty untracked `android-xr/`)

## Cleanup / Merge Risk

- `release/android-v12-review-candidate` is clean of `android-xr/`
- `feature/ios-ipad-native-discovery-v1` remains a future merge risk if it still contains native XR files
- Future agents must not recreate `android-xr/` under the main K Scan repo
