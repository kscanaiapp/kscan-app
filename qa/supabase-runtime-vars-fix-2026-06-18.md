# KS-REL-007E — Supabase Runtime Vars Fix for UI V2 Smoke

**Status:** PASS WITH NOTES
**Date:** 2026-06-18
**Branch:** feature/ui-v2-integration-smoke
**Commit:** 3d163c4

---

## Runtime Environment

| Check | Result |
|---|---|
| **Runtime env file** | `.env.local` (git-ignored, not committed) |
| **Expected env var: `EXPO_PUBLIC_SUPABASE_URL`** | Present, length=40, targets staging ref `wyyuqfdxucjksghsmhry` |
| **Expected env var: `EXPO_PUBLIC_SUPABASE_ANON_KEY`** | Present, length=208, staging anon key |
| **`EXPO_PUBLIC_HOME_NAVIGATION_V2`** | `true` |
| **`EXPO_PUBLIC_SCAN_RESULTS_V2_UI`** | `true` |
| **`EXPO_PUBLIC_SCAN_ROOM_V2_UI`** | `true` |
| **`EXPO_PUBLIC_ENABLE_TEXTSCAN`** | `true` |
| **`EXPO_PUBLIC_CLOUD_SAVED_SCANS_ENABLED`** | `false` |
| **`EXPO_PUBLIC_TEXTSCAN_BACKEND_ENABLED`** | `false` |
| **`EXPO_PUBLIC_TEXTSCAN_DEMO_RESULTS`** | `false` |

### Env var name fix

`.env.local` previously used `EXPO_PUBLIC_TEXTSCAN_DEMO_RESULTS_ENABLED` but code at `constants/featureFlags.ts:68` reads `EXPO_PUBLIC_TEXTSCAN_DEMO_RESULTS`. Corrected to match code.

---

## Source Confirmation

| Check | Result |
|---|---|
| **`services/supabaseClient.ts`** | Reads `EXPO_PUBLIC_SUPABASE_URL` (line 4) and `EXPO_PUBLIC_SUPABASE_ANON_KEY` (line 5) via `process.env` |
| **Supabase URL target** | Staging confirmed (`wyyuqfdxucjksghsmhry`) |
| **Protected ref in app source** | None — no source file in `app/`, `components/`, `services/`, `hooks/`, `lib/`, `constants/` hardcodes `yzqjvdfgefveprobvvyw` |

---

## EAS / Build Config Audit

| Check | Result |
|---|---|
| **Protected ref in `eas.json`** | YES — `yzqjvdfgefveprobvvyw` in both `preview` (line 15) and `production` (line 36) profiles |
| **Classification** | AAB build blocker; NOT a Metro blocker (`.env.local` overrides local runtime) |

### AAB BLOCKER

`eas.json` `preview` and `production` profiles both point `EXPO_PUBLIC_SUPABASE_URL` to the protected Privacy project (`yzqjvdfgefveprobvvyw`). No AAB build may proceed until this is remediated via profile separation or EAS environment variable/secrets migration.

**Default action for this task:** Document only. `eas.json` was not patched.

---

## Staging Reachability

| Check | Result |
|---|---|
| `https://wyyuqfdxucjksghsmhry.supabase.co/rest/v1/` | HTTP 401 — host reachable, auth required as expected |

---

## Secret Hygiene

| Check | Result |
|---|---|
| `service_role` in client code | None — only in server-side Edge Functions and admin scripts |
| `SUPABASE_SERVICE_ROLE_KEY` in app/components/services | Not present |
| `.env.local` committed | No — git-ignored |
| Private keys in tracked files | None found |

---

## Static Validation

| Check | Result |
|---|---|
| **TypeScript (`tsc --noEmit`)** | PASS — no errors |
| **Tests (18 files)** | 15/18 pass fully |
| **Known baseline failures** | `authPrivacy.test.js` (1 fail), `useKScanDuplicateGuard.test.js` (1 fail), `verifyAppleReadiness.test.js` (1 fail) |
| **New failures** | None |

---

## Metro Key Error Recheck

**Status:** Pending — env vars are now correctly set. Manual Metro launch required:

```
npx expo start --clear
```

Confirm that `Error: supabaseKey is required` no longer appears.

---

## Remaining Blockers

1. **AAB build blocker:** `eas.json` still points to protected Privacy project in `preview` and `production` profiles. Must remediate before any EAS/AAB build.
2. **Metro recheck:** Manual launch needed to confirm runtime key error is resolved.

---

## Recommendation

Proceed to UI V2 Android smoke through Metro (local dev).
Do not build AAB until `eas.json` / EAS build env is corrected for staging or release profile separation.
