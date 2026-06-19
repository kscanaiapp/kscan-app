# K Scan AI - KS-REL-007A Final Android Runtime Smoke Against Safe Staging

Date: 2026-06-18
Status: FAIL

## Summary

The smoke was stopped before Android runtime launch because the local app runtime configuration is pointed at the protected Supabase project ref `yzqjvdfgefveprobvvyw` instead of the required staging project ref `wyyuqfdxucjksghsmhry`.

Per release instructions, this is a release-blocking backend-target failure and the app was not launched against Android to avoid hitting the wrong backend.

## Environment

- Branch: `feature/release-integration-v2-backend-stack-v1`
- Commit: `b04d1cb`
- Runtime environment: Local Windows PowerShell in `C:\Users\jsmit\KScan`
- Package manager: `npm` (`package-lock.json` present)
- Launch command: Not run
- Expo Go / dev client / emulator mode: Not run
- Device: Physical Android device via `adb` (`R5CY130589L`)
- Device model: `SM-S936U`
- Android version: `16`

## Repo Safety Check

- `git branch --show-current` -> `feature/release-integration-v2-backend-stack-v1`
- `git rev-parse --short HEAD` -> `b04d1cb`
- `git pull --ff-only origin feature/release-integration-v2-backend-stack-v1` -> already up to date
- `git log --oneline -5` includes:
  - `b04d1cb docs(qa): add staging rls patch merge report`
  - `a2912aa Merge remote-tracking branch 'origin/feature/staging-grants-saved-scans-rls-fix-v2' into feature/release-integration-v2-backend-stack-v1`
- Working tree was clean before report creation

## Staging Target Verification

- Expected staging project ref: `wyyuqfdxucjksghsmhry`
- Protected project ref that must not be used: `yzqjvdfgefveprobvvyw`
- Staging reachability: `401` from `https://wyyuqfdxucjksghsmhry.supabase.co/rest/v1/` which confirms host reachability

Config verification found the wrong backend target in local runtime-facing config:

- `.env` contains `EXPO_PUBLIC_SUPABASE_URL=https://yzqjvdfgefveprobvvyw.supabase.co`
- `eas.json` contains `EXPO_PUBLIC_SUPABASE_URL=https://yzqjvdfgefveprobvvyw.supabase.co` in build profile env blocks
- App code reads `process.env.EXPO_PUBLIC_SUPABASE_URL` in:
  - `services/supabaseClient.ts`
  - `services/supabasePrivacy.js`
  - `services/secondhand.js`

Result:

- Active runtime configuration does not point to staging
- Protected project ref is present in runtime-facing configuration
- Smoke stopped before launch to avoid production/Privacy-project usage

## Env File Hygiene

- Local env-related files present:
  - `.env`
  - `.env.local`
  - `.env.example`
- These were not staged and their secret contents were not copied into this report
- `.env.local` presence is documented as local-only

## Feature Flag Safety Check

`constants/featureFlags.ts` remains env-driven for the checked flags:

- `TEXTSCAN_UI_ENABLED` -> `EXPO_PUBLIC_ENABLE_TEXTSCAN === 'true'`
- `TEXTSCAN_DEMO_RESULTS_ENABLED` -> `EXPO_PUBLIC_TEXTSCAN_DEMO_RESULTS === 'true'`
- `TEXTSCAN_BACKEND_ENABLED` -> `EXPO_PUBLIC_TEXTSCAN_BACKEND_ENABLED === 'true'`
- `CLOUD_SAVED_SCANS_ENABLED` -> `EXPO_PUBLIC_CLOUD_SAVED_SCANS_ENABLED === 'true'`

Assessment:

- Backend/cloud/TextScan flags appear env-driven and default-off in code
- No feature flags were changed in this task

## Schema / Type Alignment

- Generated Supabase type file found: no
- `saved_scans` type status: unknown
- `legal_acceptances` type status: unknown
- `style_chat_messages` type status: unknown
- `style_chat_sessions` type status: unknown

## Validation

- TypeScript: Not run because the smoke failed early on wrong backend target
- Tests: Not run because the smoke failed early on wrong backend target
- Known baseline failures: Not re-verified in this run

## Runtime Smoke Areas

- App launch: Not run
- Home/Scan: Not run
- Privacy/legal: Not run
- Saved scan/library: Not run
- Dressing Rooms: Not run
- StyleChat: Not run
- TextScan: Not run
- Offline/error handling: Not run
- Crash/log scan: Not run
- Security/secret check: Partial
  - Verified protected project ref appears in runtime-facing config
  - Did not launch app, so runtime log leakage checks were not executed
- Screenshots: None

## Issues Found

[P0] [Backend Targeting] Local runtime config points to protected Supabase project instead of staging
Repro steps:
1. Inspect `.env` and `eas.json` for `EXPO_PUBLIC_SUPABASE_URL`
2. Compare configured project ref with expected staging ref `wyyuqfdxucjksghsmhry`
Expected:
Local runtime-facing config should target `wyyuqfdxucjksghsmhry.supabase.co`
Actual:
Runtime-facing config points to `yzqjvdfgefveprobvvyw.supabase.co`
Evidence:
Config search across `.env`, `eas.json`, and runtime Supabase client files
Recommendation:
Update local runtime-facing Supabase URL configuration to the safe staging project ref, re-verify no protected project ref remains active, then rerun the Android smoke from Step 4 onward

## Severity Classification

- Overall severity: `P0`
- Overall result: `FAIL`

## Recommendation

Do not proceed to the next Android runtime gate until the runtime-facing Supabase URL is corrected to the safe staging project and the smoke is rerun.

Do not build or upload an AAB from this state.
