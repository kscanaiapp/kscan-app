# K Scan AI — Pre-Build Smoke Audit Report

**Branch:** `integration/free-tier-beta-into-style-dna`  
**HEAD:** `375c227` — `fix(release): add AI output reporting for Play compliance`  
**Date:** 2026-07-08  
**Auditor:** Human owner + automated verification  
**Scope:** Full codebase submission-readiness audit for Google Play Store Android AAB submission

---

## Commit History Since Prior Audit

| Commit | Description | Files Changed |
|---|---|---|
| `a6b6ff3` | `fix(release): apply final pre-build smoke fixes` | `app.json`, `android/app/src/main/AndroidManifest.xml`, `constants/weatherStyling.ts`, `app/library.tsx` |
| `e3940eb` | `chore(release): clean EAS build archive hygiene` | Archive cleanup (no source impact) |
| `375c227` | `fix(release): add AI output reporting for Play compliance` | `M components/style-chat/StyleChatBubble.tsx`, `A services/reportAiOutput.ts` |

**Ancestry:** Clean fast-forward from `e3940eb` (which was verified as a descendant of the prior audit HEAD). `375c227` is a direct child of `e3940eb`.

---

## Scope Audit of `375c227`

| Check | Result |
|---|---|
| Files changed | Exactly 2: `components/style-chat/StyleChatBubble.tsx` + `services/reportAiOutput.ts` |
| No manifest/permission/build changes | ✅ Confirmed — `app.json`, `build.gradle`, `AndroidManifest.xml` untouched |
| No keystore/AAB/APK/.env/secret files added | ✅ Confirmed via `git diff-tree` |
| AI output fix present | ✅ Import at line 13, `sender === 'assistant'` gate at line 271, `reportAiOutput()` call at line 274, "Report AI Response" control at line 284 |
| `services/reportAiOutput.ts` committed | ✅ 1108 bytes, present in tree |

---

## Core Blockers — Unchanged (Carry Forward from Prior Audit PASS)

All prior audit findings still hold because `375c227` touched only non-manifest, non-permission UI code:

| Area | Status | Evidence |
|---|---|---|
| **versionCode / versionName** | ✅ Intact | `23` / `1.0.1` in both `build.gradle` and `app.json` |
| **Android permissions (source)** | ✅ Unchanged | Main manifest: `CAMERA`, `INTERNET`, `VIBRATE`, `ACCESS_COARSE_LOCATION` only |
| **blockedPermissions** | ✅ Unchanged | `RECORD_AUDIO`, `ACCESS_FINE_LOCATION`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE` |
| **Microphone / VoiceScan** | ✅ Unchanged | `VOICESCAN_ENABLED = false`; no mic runtime path; "Coming Soon" placeholder only |
| **Location / weather** | ✅ Unchanged | `Accuracy.Low`; disclosure before OS prompt; coarse-only; no background |
| **Camera / scan / TextScan** | ✅ Unchanged | `scan-identify` Edge Function path; legacy Render fallback unreachable in production |
| **Backend / Supabase** | ✅ Unchanged | `wyy` project; service_role only in Edge Functions; JWT verification in place |
| **Account deletion** | ✅ Unchanged | In-app request → pending → manual erasure within 30 days; no instant claim |
| **UGC / Report & Hide** | ✅ Unchanged | Local hide + server report foundation; `content_reports` migration present |
| **Secrets / leakage** | ✅ Unchanged | No service_role in client; no hardcoded JWTs; debug.keystore only |
| **Data Safety docs** | ✅ Unchanged | `play-store-readiness-notes.md` current; table accurate |

---

## Notes (Non-Blocking)

1. **Corrupt commit-graph artifact** — `improper chunk offset` warnings from a stale `.git/objects/info/commit-graph` file in the session mount. Git falls back to the object store and resolves correctly. Object integrity is intact. Optional cleanup: `git commit-graph write --reachable` (or delete the file). Not required for the build.
2. **TypeScript / tests not re-run in this session** — Shell mount limitation prevented `tsc` and `node --test` execution. The committed code is type-consistent by inspection. Prior test run (146/146 pass) from `a6b6ff3` / `e3940eb` carries forward.

---

## Remaining Blockers Before Upload to Google Play

These are **post-build** gates, not source blockers. The source is ready to build.

1. **Build fresh production AAB from `375c227`** — The existing `kscan-v23-3a3dc6e-production-QA-SMOKE.apks` artifact was built from an older commit (`3a3dc6e`) and may carry stale permissions. Build from `375c227` to ensure all fixes are included.
2. **Final AAB merged-manifest audit** — Extract merged `AndroidManifest.xml` via `bundletool dump manifest` and confirm only `CAMERA`, `INTERNET`, `VIBRATE`, `ACCESS_COARSE_LOCATION` are declared; `RECORD_AUDIO` and storage permissions are absent.
3. **Release-artifact emulator smoke** — Install the actual AAB (via bundletool → APKS) on a clean emulator and run the checklist from `docs/final-pre-submission-smoke-test.md`.
4. **Play Console `versionCode 23` collision check** — Confirm `23` is not already uploaded to Play Console Internal Testing. If it is, bump to `24` and rebuild.
5. **Deploy `content_reports` migration** — If not yet applied to the live Supabase project (`wyyuqfdxucjksghsmhry`), apply `supabase/migrations/20260708090847_content_reports.sql` before public launch. This is a backend deployment, not a source change.
6. **Verify `kscan.app/support` resolves** — Confirm the live support URL loads before Play submission.
7. **Refresh live privacy page** — `https://kscan.app/legal/privacy` still references the older iOS submission build per `docs/play-store-readiness-notes.md` line 122. Update before upload.
8. **Durable user blocking (deferred)** — Server-side cross-device blocking for reported users is a future enhancement. Not a rebuild blocker; current `Report & Hide` + `content_reports` foundation covers this submission.

---

## Decision

### ✅ Rebuild readiness: **GO — Ready to build clean production AAB v23 from HEAD `375c227`.**

### ⛔ Upload readiness: **NO-GO** — Post-rebuild gates (manifest audit, artifact smoke, migration deploy, URL verification) must complete before Play Console upload.

---

## Recommended Next Step

**Run the EAS production Android build from `375c227`:**

```bash
eas build --profile production --platform android
```

Once the AAB is downloaded, bring it back for the final manifest audit + artifact smoke before uploading to Play Console.

---

*Report generated: 2026-07-08*  
*HEAD: `375c227`*  
*Branch: `integration/free-tier-beta-into-style-dna`*
