# Android XR Recovery Branch

This branch preserves recovered native Android XR work from orphaned commit `e4a5873`.

## Recovery Anchor

- Commit: `e4a5873` — "Ensure XR debug smoke uses offline mock analyze path when DRY_RUN is true"
- Recovery branch: `recovery/google-glasses-android-xr-e4a5873`
- Remote branch: `feature/glasses-xr-native-standalone`

## DRY_RUN Safety

`DRY_RUN=true` must always route to the offline mock analyze path (`MockAnalyzeClient`).
The fix in `MainActivity.kt` gates on `!DebugAnalyzeConfig.DEFAULT.dryRunBuildFlag` —
live backend is only used when DRY_RUN is explicitly false in a debug build.

## Branch Separation

Do **not** push native `android-xr/` into the main Expo/RN prototype branch
(`feature/glasses-xr-isolated-prototype`). That branch contains only the six-file
mobile mock prototype.

The main K Scan repo should only contain mobile-facing prototype files unless
explicitly authorized.

## Workspace Paths

- Recovered worktree: `C:\Users\jsmit\kscan-google-glasses-recovery`
- Original (degraded): `C:\Users\jsmit\kscan-google-glasses`

The original workspace remains degraded with an untracked `android-xr/` directory.
It should not be used for development until reconciled with this recovery branch.
