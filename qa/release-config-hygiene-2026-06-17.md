# K Scan AI — Release Config Hygiene Report

**Branch:** `feature/release-config-hygiene-v1`
**Base:** `feature/release-integration-v2-backend-stack-v1` (`77e14f8`)
**Date:** 2026-06-17
**Engineer:** Kimi Work Release Agent
**Task:** Validate feature flags, config, artifact hygiene, and release documentation before runtime smoke/AAB work

---

## 1. Branch / Commit

| Field | Value |
|-------|-------|
| **Current branch** | `feature/release-config-hygiene-v1` |
| **Base branch** | `feature/release-integration-v2-backend-stack-v1` |
| **Commit** | `77e14f8` docs(qa): add saved_scans trigger patch merge report |
| **Working tree** | Modified: `.gitignore` |

---

## 2. Files Changed

| File | Status | Description |
|------|--------|-------------|
| `.gitignore` | Modified | Added narrow rules for generated Android adaptive icon assets |
| `qa/release-config-hygiene-2026-06-17.md` | New | This report |

---

## 3. Feature Flag State

| Flag | Default | Safe? |
|------|---------|-------|
| `CLOUD_SAVED_SCANS_ENABLED` | `false` (env-driven) | ✅ Safe |
| `TEXTSCAN_BACKEND_ENABLED` | `false` (env-driven) | ✅ Safe |
| `TEXTSCAN_UI_ENABLED` | `false` (env-driven) | ✅ Safe |
| `TEXTSCAN_DEMO_RESULTS_ENABLED` | `false` (env-driven) | ✅ Safe |
| `TEXTSCAN_VOICE_PLACEHOLDER_ENABLED` | `false` (env-driven) | ✅ Safe |
| `SCAN_RESULTS_V2_UI_ENABLED` | `false` (env-driven) | ✅ Safe |
| `SCAN_RESULTS_DEMO_UI_ENABLED` | `false` (env-driven) | ✅ Safe |
| `SCAN_ROOM_V2_UI_ENABLED` | `false` (env-driven) | ✅ Safe |
| `HOME_NAVIGATION_V2_ENABLED` | `false` (env-driven) | ✅ Safe |
| `ONBOARDING_FRAMEWORK_V1_ENABLED` | `false` (env-driven) | ✅ Safe |

**All flags env-driven.** No hardcoded staging/prod values. No feature flags enabled by default.

---

## 4. Environment Config Findings

| Check | Result |
|-------|--------|
| `.env` exists in repo root | ✅ Yes, but `.gitignore` covers it (not tracked) |
| `.env.local` exists in repo root | ✅ Yes, but `.gitignore` covers it (not tracked) |
| `.env.example` tracked | ✅ Yes, only example file is tracked |
| `app.json` EAS project ID | `a075728d-bd77-446f-843d-0f63fd54cc2e` — public EAS project ID, not a secret |
| `app.json` adaptive icon | `foregroundImage: "./assets/adaptive-icon.png"` — source asset, tracked |
| No staging/prod env values hardcoded | ✅ Confirmed |
| No secrets in `package.json` | ✅ Confirmed |

---

## 5. Artifact Hygiene Findings

| Check | Result |
|-------|--------|
| Generated Android mipmap artifacts | 6 untracked files: `ic_launcher_foreground.webp` x 5 densities + `mipmap-anydpi-v26/` |
| Source of artifacts | Generated from `assets/adaptive-icon.png` by Expo prebuild |
| Should be committed? | No — derived from tracked source asset |
| `.gitignore` rule added | ✅ Yes, narrow rule added for `mipmap-anydpi-v26/` and `mipmap-*/ic_launcher_foreground.webp` |
| Other untracked artifacts | None — `node_modules`, `.expo/`, `.env*` already ignored |
| `.gitignore` already covered | ✅ `.env`, `.env.local`, `.env.*`, `.expo/`, `node_modules`, `*.keystore`, `*.jks`, `*.p8`, `android/local.properties`, `android/app/release-keystore/` |

---

## 6. `.gitignore` Changes

```text
# Generated Android adaptive icon assets (from Expo prebuild / adaptiveIcon foreground)
android/app/src/main/res/mipmap-anydpi-v26/
android/app/src/main/res/mipmap-*/ic_launcher_foreground.webp
```

Added after the existing Android signing material section. No broad `android/` ignore — custom native config remains tracked.

---

## 7. Secrets Scan Result

| Check | Result |
|-------|--------|
| `service_role` in app/client code | No hardcoded `service_role` found in `services/`, `app/`, `hooks/`, `components/`, `constants/`, `__tests__/` |
| Hardcoded API keys | None found |
| Hardcoded JWTs | None found |
| Hardcoded connection strings | None found |
| Hardcoded passwords | None found |
| `anon` key references | Only in `services/supabasePrivacy.js` as a comment describing configuration check |
| `.env` files staged | None — all properly ignored |

---

## 8. Tests Result

| Check | Result |
|-------|--------|
| **Full test suite** | 249/252 pass |
| **Known baseline failures** | 3 unchanged |
| &nbsp;&nbsp;`authPrivacy.test.js` — `mapAuthError: unknown error passes through` | Same assertion category (safe error mapping) |
| &nbsp;&nbsp;`useKScanDuplicateGuard.test.js` — duplicate invocation guard | Same failure reason (`false !== true`) |
| &nbsp;&nbsp;`verifyAppleReadiness.test.js` — iOS readiness on Android branch | Same failure reason (no local iOS config) |
| **New failures** | None ✅ |

---

## 9. TypeScript Result

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | ✅ Pass — no type errors |

---

## 10. Android Impact

| Check | Result |
|-------|--------|
| `app.json` Android versionCode | 5 (unchanged) |
| `app.json` Android package | `com.kscanai.app` (unchanged) |
| Adaptive icon source | `assets/adaptive-icon.png` (tracked source) |
| Generated foreground webp | Now ignored ✅ |
| Signing config | `android/app/release-keystore/` already ignored |
| Native config changes | None |
| New dependencies | None |

---

## 11. iOS Impact

| Check | Result |
|-------|--------|
| `app.json` iOS bundleIdentifier | `com.kscanai.app` (unchanged) |
| `app.json` iOS buildNumber | 2 (unchanged) |
| `app.json` iOS deploymentTarget | 16.0 (unchanged) |
| `app.json` usesAppleSignIn | true (unchanged) |
| Privacy manifest | Present (unchanged) |
| Native config changes | None |

---

## 12. Remaining Blockers

| Blocker | Status |
|---------|--------|
| **Dedicated staging Supabase project** | Still required |
| **KS-REL-005A rerun** | Still required after staging exists |
| **RLS runtime verification** | Still required |
| **Cross-user isolation** | Still required |
| **Trigger functional test** | Still required |
| **Android runtime smoke** | Ready to attempt (next prompt) |
| **EAS AAB build** | Ready to attempt (next prompt) |
| **StyleChat generation repair** | Still out of scope |

---

## 13. Final Recommendation

| Decision | Status |
|----------|--------|
| **Ready for runtime smoke** | ✅ Yes — branch is clean, no app code changes, tests pass, TypeScript passes, artifacts properly ignored |
| **Ready for AAB gate** | ✅ Yes — no native config changes, versionCode unchanged, signing config already ignored, generated assets now ignored |
| **Blocked by Supabase staging** | ❌ No — this is a local Git/config task; staging is not required for this hygiene pass |
| **Blocked by Gemini** | ❌ No — no Gemini integration in this task |
| **Blocked by StyleChat** | ❌ No — StyleChat untouched |

### Next required prompt

```text
KS-REL-007 — Android runtime smoke + EAS AAB build preparation
```

This prompt should run in an environment with:
- Android emulator or device connected
- EAS CLI configured (if AAB build is required)
- Metro bundler available

---

*Report generated by KS-REL-006A release config hygiene workflow — 2026-06-17*
