# K Scan AI — Release Candidate Audit
**Date:** 2026-06-09  
**Auditor:** Senior Mobile Release Engineer / Backend QA / DevSecOps / Privacy Architect  
**Scope:** Internal Testing Build — versionCode 3  
**Repo:** `C:\Users\jsmit\KScan` · Website: `C:\Users\jsmit\kscan-website`

---

## 1. Executive Summary

**Overall Readiness: YELLOW — Internal testing can proceed.**

No hard blockers exist that prevent the internal testing track on Google Play. Two medium-severity findings (diagnostic header leakage in the website API, versionCode mismatch between `app.json` and `build.gradle`) require resolution before closed/production tracks. All privacy claims are accurate. The StyleChat backend is properly secured. RLS coverage is comprehensive.

### Top 5 Wins

1. **Release signing is EAS-managed.** No release keystore is tracked in git. The `.gitignore` correctly excludes all keystore patterns.
2. **StyleChat backend is fully secured.** JWT is verified before any data access. Gemini API key stays server-side. Quota is enforced atomically. Error fallbacks never expose internal details to the user.
3. **RLS is enforced on every user-data table.** StyleChat sessions, messages, style memory, inspiration uploads, dressing room items, and deletion requests all enforce `auth.uid() = user_id`.
4. **Privacy claims are accurate.** `privacyImageSanitizer.js` explicitly states `faceDetectionAvailable: false`, `faceBlurApplied: false`, mode: `passthrough`. The website and app copy match this accurately.
5. **Account deletion flow is complete.** In-app request → `deletion_requests` Supabase table → `handle-user-deletion` Edge Function. Email address `kscanai.app@gmail.com` is consistent across app, website, and Play Console copy.

### Top 5 Risks

1. **versionCode mismatch.** `app.json` has `versionCode: 2`; `android/app/build.gradle` has `versionCode 3`. `build.gradle` is authoritative for native builds. `eas.json` sets `"appVersionSource": "local"` (reads `app.json`). This creates EAS metadata confusion and may cause a rejected Play upload if EAS metadata disagrees with the binary. **Must fix before closed testing.**
2. **Website API diagnostic headers expose internal state.** `X-KScan-Service-Key-Present: yes|no` is returned to any public requester. This reveals whether the service role key is configured. **Must fix before closed testing.**
3. **No per-request rate limit on `stylechat-generate`.** Daily quota (25 messages/user/day) is enforced, but there is no per-minute or per-second burst limit. A single user or compromised token could fire 25 parallel requests. **Must fix before production.**
4. **`image_url` in public room preview may be a permanent Supabase storage URL.** The `get_public_room_preview` RPC passes `dri.image_url` directly if it matches `^https?://`. If this URL is a non-expiring Supabase public bucket URL, the storage path is permanently accessible from the shared link regardless of revocation. **Needs review before production.**
5. **EXPO_PUBLIC_SUPABASE_ANON_KEY is committed to `eas.json`.** This is the Supabase anon key (public by design, intended for client use) not a secret, but it is committed to the repository. Anyone with repo access can read it. This is architecturally acceptable for a public anon key, but should be documented as an explicit decision rather than an oversight.

---

## 2. Release Candidate Identity

| Field | Value | Source | Status |
|---|---|---|---|
| Branch | `feature/stylechat-v0.4.1-ui-keyboard-fix` | `git branch` | Note: sub-branch of v0.4.1 (not `feature/stylechat-v0.4` exactly) |
| Latest commit | `15a1bea` — `docs(qa): document StyleChat portrait UX fixes` | `git log` | PASS |
| Package ID | `com.kscanai.app` | `build.gradle:92` | PASS |
| versionCode (authoritative) | **3** | `build.gradle:95` | PASS |
| versionCode (app.json — stale) | 2 | `app.json:36` | MISMATCH — see Risk 1 |
| versionName | "1.0.0" | `build.gradle:96` | PASS |
| compileSdkVersion | 35 (Expo default) | `ExpoRootProjectPlugin.kt` | PASS |
| targetSdkVersion | 35 | `ExpoRootProjectPlugin.kt` | PASS ≥34 |
| minSdkVersion | 24 | `ExpoRootProjectPlugin.kt` | PASS |
| Remote | `https://github.com/kscanaiapp/kscan-app.git` | `git remote` | PASS |
| Signing (release) | EAS Build / remote credentials | `build.gradle:113` | PASS — no local keystore |
| Tracked keystore | `android/app/debug.keystore` only | `git ls-files` | PASS — debug only |

---

## 3. Feature Audit Table

| Area | Status | Evidence | Confidence | Risk | Required Action |
|---|---|---|---|---|---|
| Android versioning / package ID | PASS | `build.gradle` versionCode=3, applicationId=com.kscanai.app | Verified by command output | Low | Sync `app.json` versionCode to 3 |
| Android signing | PASS | EAS-managed; no release signingConfig block; .gitignore excludes keystores | Verified by code | Low | None |
| Android permissions | PASS | Main: CAMERA, INTERNET, VIBRATE. Release overlay removes SYSTEM_ALERT_WINDOW, RECORD_AUDIO, READ/WRITE_EXTERNAL_STORAGE | Verified by command output | None | None |
| Expo / EAS / OTA config | PASS | expo-updates not installed; OTA: Not Used; production build = AAB | Verified by command output | Low | Sync app.json versionCode |
| Auth / session | PASS | Routing guard redirects non-public routes to `/auth`; session expiry checked | Verified by code | Low | None |
| Scan flow | NOT AUDITED IN DETAIL | Out of scope for this StyleChat-focused audit | Inferred from architecture | Unknown | Manual test required |
| Style Library | PASS | RLS enforces `auth.uid() = user_id`; save/load via `dressing_room_items` | Verified by code | Low | None |
| Private inspiration uploads | PASS | `inspiration_items` and `dressing_room_inspiration_items` tables with full RLS | Verified by code | Low | None |
| Dressing Rooms | PASS | RLS enforced; room ownership verified before room share creation | Verified by code | Low | None |
| Shared room links | PASS with observation | Opaque UUID token; revocation implemented; `get_public_room_preview` returns safe data | Verified by code | Medium | Verify image_url is signed/expiring |
| StyleChat UI | PASS | Entry point, auth guard, empty state, disabled send, thinking indicator, error banner, retry, back handler all present | Verified by code | Low | Manual portrait/landscape test |
| LLM backend | PASS | JWT auth → quota RPC → Gemini; fallback returns generic message; no key in mobile client | Verified by code | Low | Add per-minute burst limit before production |
| LLM rendering safety | PASS | `StyleChatBubble` uses `<Text>` only; no dangerouslySetInnerHTML; no WebView; Linking.openURL used only for hardcoded legal URLs | Verified by code | None | None |
| Supabase RLS / storage | PASS | All user tables have RLS; RPCs enforce `auth.uid()`; service role key not in mobile client | Verified by code | Low | Verify signed URL expiry on shared room images |
| Website shared rooms | PASS | `/rooms/[id]` page exists; server-side service role; signed URL generation for storage-backed images | Verified by code | Medium | Remove diagnostic headers |
| Privacy / delete account | PASS | In-app flow → `deletion_requests`; website deletion page at `/legal/delete-account`; consistent email; accurate copy | Verified by code | Low | None |
| Play Console readiness | PASS (inferred) | versionCode=3; targetSdk=35; privacy/deletion URLs exist; no RECORD_AUDIO in release | Inferred from architecture | Medium | Cannot verify Play Console state directly |
| Smart glasses bridge readiness | FOUNDATION ONLY | Deep link scheme exists; fashion parse model exists; no glasses/wearable code | Verified by code | Low | Future roadmap only |

---

## 4. Backend and Security Findings

### MEDIUM — Website API diagnostic headers expose service key status  
**File:** `C:\Users\jsmit\kscan-website\app\api\rooms\[token]\route.ts`  
**Lines:** `X-KScan-Supabase-Url-Present`, `X-KScan-Service-Key-Present`  
The response headers confirm to any public requester whether the `SUPABASE_SERVICE_ROLE_KEY` environment variable is configured. This is information disclosure that reveals infrastructure configuration state.  
**Recommendation:** Remove `X-KScan-Service-Key-Present` and `X-KScan-Supabase-Url-Present` from the response headers before closed testing. Keep `X-KScan-Rooms-Api-Diag` for internal diagnostics if needed, but strip it before production.  
**Confidence:** Verified by code.

### MEDIUM — versionCode mismatch between app.json (2) and build.gradle (3)  
**Files:** `app.json:36`, `android/app/build.gradle:95`, `eas.json` (`appVersionSource: "local"`)  
For a native Android project, the binary versionCode comes from `build.gradle` (3). However, EAS's `"appVersionSource": "local"` reads `app.json` for EAS build metadata (2). This creates a mismatch that could confuse Play Console version tracking and future EAS bump automation.  
**Recommendation:** Update `app.json` `android.versionCode` to 3 to match `build.gradle`.  
**Confidence:** Verified by code.

### MEDIUM — No per-minute burst rate limit on `stylechat-generate`  
**File:** `supabase/functions/stylechat-generate/index.ts`  
The function enforces a daily quota of 25 messages per user per day via an atomic RPC. However, there is no per-minute or concurrent-request limit. A compromised JWT could exhaust the 25-message daily quota in a single burst, or a bug could fire parallel invocations.  
**Recommendation:** Add a per-minute rate check (e.g., `increment_stylechat_daily_usage` tracks the timestamp; add a check that no more than 5 messages were sent in the last 60 seconds). Or gate at the Supabase project/function level.  
**Confidence:** Verified by code.

### LOW — image_url in public room preview may not be a signed/expiring URL  
**File:** `supabase/migrations/202605240001_room_shares_public_preview.sql`  
The `get_public_room_preview` RPC passes `dri.image_url` directly if it matches `^https?://`. If this is a non-expiring Supabase public storage URL (not a signed URL with expiry), the image remains accessible after the share is revoked. The website's `signStorageUrl()` helper generates 24-hour signed URLs from `imageStorageBucket` + `imageStoragePath`, but this path is only taken when `existingUrl` is null.  
**Recommendation:** Audit what type of URL is stored in `dressing_room_items.image_url`. If it is a permanent public bucket URL, ensure all buckets are set to private and exclusively use signed URLs. The website's signed URL generation layer should be the only public image access path.  
**Confidence:** Inferred from architecture — needs database-level verification.

### LOW — `EXPO_PUBLIC_SUPABASE_ANON_KEY` committed to eas.json  
**File:** `eas.json:16, 37`  
The Supabase anon key is committed to the repository. This is architecturally intentional (Supabase anon keys are public-safe client keys designed to be embedded), but the pattern increases risk if the key is ever accidentally treated as a secret, and may trigger automated secret scanners.  
**Recommendation:** Either move to a project-level environment secret in the EAS dashboard, or add an explicit comment in `eas.json` documenting that this is a public anon key. Do not treat this as a blocker.  
**Confidence:** Verified by code.

### LOW — `EXPO_PUBLIC_SUPABASE_ACCESS_TOKEN` dev override referenced in production code  
**File:** `services/supabasePrivacy.js:9`  
A `_devTokenOverride` is read from `EXPO_PUBLIC_SUPABASE_ACCESS_TOKEN` but is marked `@deprecated` and has no effect in production. The variable is prefixed `_` and the function using it is stubbed.  
**Recommendation:** Remove the dead code. The `setPrivacyAccessToken()` function and the `_devTokenOverride` constant can be deleted.  
**Confidence:** Verified by code.

### LOW — Gemini API key in URL query parameter  
**File:** `supabase/functions/stylechat-generate/index.ts:84-88`  
`buildGeminiUrl()` appends the Gemini API key as a URL query parameter (`?key=...`). This is Google's standard Gemini REST API authentication pattern, but it means the key appears in Supabase Edge Function access logs.  
**Recommendation:** Acceptable for current architecture. If Supabase log access is restricted to the team, this is low risk. Note it for the security posture documentation.  
**Confidence:** Verified by code.

### PASS — Website `.env` files with service role keys are correctly gitignored
**Files checked:** `kscan-website/.env.local`, `.env.production`, `.vercel/.env.preview.local`  
All three files contain `SUPABASE_SERVICE_ROLE_KEY` values. All three are covered by `.gitignore` (`".env*"` and `".vercel"` patterns). `git ls-files` returned no output for any of them — none are tracked.  
**Note:** Key values are not printed in this report per audit safety rules. Architecture is correct: keys are local-only and not in source control.  
**Confidence:** Verified by command output.

### OBSERVATION — `handle-user-deletion` Edge Function requires manual execution  
**File:** `supabase/functions/handle-user-deletion/index.ts`  
The function is deployed but is not wired to a cron or webhook trigger. Deletion requests land in the `deletion_requests` table with status `pending` but require a manual invocation or an external trigger to execute.  
**Note:** This is acceptable for Play Console compliance (Play requires a deletion *mechanism*, not instant deletion), provided the website and app copy accurately describe the request-based workflow. They do.

### OBSERVATION — `api/style-chat/message+api.ts` and `session+api.ts` are deprecated stubs  
**File:** `app/api/style-chat/message+api.ts:1-4`  
These files are clearly documented as deprecated mock stubs and are not called by the mobile app. They have no auth enforcement.  
**Recommendation:** These are safe to leave as-is. They cannot be invoked by production app traffic since the live path goes through `supabase.functions.invoke()`. No action required.

---

## 5. Manual Smoke Test Script

### Prerequisites
- Internal testing build installed from Play Store (internal testing track)
- Android device running Android 7.0+ (API 24+)
- Test account: fresh sign-up and existing account
- Good network connection and a deliberate airplane mode test

---

**A. Install / Update**  
1. Install from Play Store internal testing track. Confirm installer is `com.android.vending`.  
2. Confirm `versionCode=3` via device settings → App info → Version, or ADB: `adb shell dumpsys package com.kscanai.app | grep -E "versionCode|versionName"`.  
3. Re-install over a previous build (if applicable). Confirm app launches without migration errors.

**B. Auth Flow**  
4. Launch app cold. Confirm loading state appears, then redirects to `/auth`.  
5. Sign up with a new email. Confirm email confirmation flow if required, or immediate session.  
6. Sign in with existing account. Confirm redirect to home screen.  
7. Sign out. Confirm redirect to `/auth`. Confirm StyleChat and Library are inaccessible without signing back in.  
8. Attempt to navigate directly to `/style-chat` while signed out. Confirm redirect to `/auth`.

**C. Home Screen**  
9. Confirm home screen shows all nav options: SCAN NOW, Style Library, Dressing Rooms, StyleChat, Privacy.  
10. Confirm greeting shows correct profile name.

**D. Scan Flow**  
11. Tap SCAN NOW. Grant camera permission. Take a photo of a garment.  
12. Confirm analysis result appears: category, color, silhouette populated.  
13. Save scan to Library. Confirm it appears.  
14. Test non-fashion object. Confirm graceful fallback (no-match message, not a crash).

**E. Style Library**  
15. Open Library. Confirm saved scans appear.  
16. Open a scan card. Confirm metadata and product shelf display.  
17. Delete a scan. Confirm it disappears from list.

**F. Private Inspiration Uploads**  
18. Open Dressing Room detail → add inspiration upload.  
19. Select an image from the photo library. Confirm upload state, then confirm image appears in the room.  
20. Confirm the image does NOT appear in another test user's session (RLS isolation check — requires a second device/account).

**G. Dressing Rooms**  
21. Create a new Dressing Room. Confirm it appears in the list.  
22. Add items to the room (scan result, saved item, inspiration image).  
23. Share the room: tap Share, confirm share URL is generated.  
24. Open share URL in a browser (without signing in). Confirm room preview loads with items but no private notes or account email.  
25. Revoke the share link. Re-open the same URL. Confirm `unavailable` state.

**H. StyleChat**  
26. Navigate to StyleChat from home screen. Confirm session list appears.  
27. Create a new session. Confirm empty state prompt.  
28. Send a normal fashion question: "What should I wear to a summer brunch?" Confirm AI response within ~20 seconds.  
29. Send an empty message (just spaces). Confirm send button stays disabled.  
30. Send a very long message (500+ characters). Confirm it is accepted or gracefully rejected.  
31. Turn on airplane mode. Send a message. Confirm error banner appears. Restore network. Tap RETRY. Confirm retry works.  
32. Exhaust the daily quota (25 messages). Confirm "StyleChat beta limit" message and no further sends.  
33. Delete a conversation from the session list. Confirm it disappears.  
34. Delete a conversation from within the session. Confirm navigation back to session list.  
35. Press hardware/OS back button while delete dialog is open. Confirm dialog dismisses and navigation does not fire.

**I. Privacy and Account Deletion**  
36. Navigate to Privacy screen. Confirm privacy preferences load.  
37. Tap "Delete Account". Confirm confirmation dialog appears.  
38. Cancel deletion. Confirm no action taken.  
39. Submit deletion request. Confirm "Deletion request submitted" message and sign-out.  
40. Tap the Privacy Policy link. Confirm `https://kscan.app/legal/privacy` opens in browser.  
41. Tap the Terms link. Confirm `https://kscan.app/legal/terms` opens in browser.

**J. Website Smoke Test**  
42. Navigate to `https://kscan.app/legal/privacy`. Confirm page loads with accurate copy (mentions passthrough mode, not claiming active face blurring).  
43. Navigate to `https://kscan.app/legal/delete-account`. Confirm page loads with `kscanai.app@gmail.com` contact and 30-day processing time disclosure.  
44. Navigate to a valid shared room URL (from step 23). Confirm public preview loads without login.  
45. Navigate to a revoked room URL. Confirm `unavailable` state.

---

## 6. Smart Glasses Bridge Assessment

### Current Implementation
**None.** No code related to smart glasses, Ray-Ban Meta, wearables, external camera frames, Bluetooth accessory handoff, or voice capture exists in the codebase.

### Ready Foundation
| Capability | Foundation Status |
|---|---|
| Deep link scheme (`kscan://`) | ✅ Configured in `app.json` — can receive external intents |
| Fashion parse model (category, silhouette, color, material) | ✅ `analyze+api.js` normalizes canonical fashion attributes |
| Privacy sanitizer infrastructure | ✅ Passthrough mode; architecture is present for Phase 2 |
| Dressing Rooms (style accumulation) | ✅ Persistent style objects wired |
| Style Library (save & recall) | ✅ Operational |
| StyleChat with user context | ✅ Server-side context assembly using dressing room signals |

### Missing Infrastructure
- No external camera source abstraction (camera must come from the device's native camera or photo library)
- No Bluetooth LE / BLE peripheral handling
- No WebSocket or BLE real-time frame handoff
- No PII pre-processing / local face/plate filtering
- No voice-to-text capture path
- No "checkout intent" or add-to-cart deep link

### A. Device Agnostic
**Status: Not ready.** The app assumes camera input from `expo-camera` only. An abstraction layer to swap in an external camera source (Ray-Ban frame, BLE stream, uploaded still) does not exist.

### B. Fashion-Specific
**Status: Foundation present.** The `analyze+api.js` canonicalizes category, silhouette, color, and style attributes. StyleChat is fashion-scoped. The style memory model accumulates brand/category/color signals. Core attribute capture is suitable for a glasses-to-phone bridge.

### C. Transactional
**Status: Partial.** Product match shelves and sneaker match cards exist. The path from scan to product page tap exists. However, there is no add-to-cart, checkout intent, or affiliate transaction path.

### D. Privacy-Compatible
**Status: Architecture-ready but passthrough.** The `privacyImageSanitizer.js` exists and documents the Phase 2 target (local detection/masking), but v1 is intentionally passthrough. A glasses-to-phone bridge would need Phase 2 to avoid sending bystander faces or license plates to cloud services.

### Month 9 POC Sequence (Recommendation — Future)
1. **Month 7:** Abstract the camera source. Replace `expo-camera` direct capture with a `CaptureSourceAdapter` interface. Implement `DeviceCameraAdapter` (current). Design the `ExternalFrameAdapter` contract.
2. **Month 8:** Implement BLE/Wi-Fi frame receiver. Accept a JPEG blob from a companion device over a local transport. Pass through `CaptureSourceAdapter`.
3. **Month 8:** Implement Phase 2 of `privacyImageSanitizer.js`. Use an on-device ML model (e.g., TFLite) to detect and blur face bounding boxes before sending to the cloud backend.
4. **Month 9:** Wire the external capture path to the existing `analyze+api.js` pipeline. Test with a Ray-Ban Meta still frame forwarded via the Ray-Ban companion app → `kscan://` deep link.
5. **Month 9:** Add voice query path to StyleChat (Whisper or platform STT → `sendMessage()`).

---

## 7. Do-Not-Ship Blockers

**None found.** Internal testing can proceed.

The following are **not** blockers but should be resolved before closed testing:
- versionCode mismatch (`app.json` = 2, `build.gradle` = 3)
- Website API diagnostic headers (`X-KScan-Service-Key-Present`)

---

## 8. Recommended Next Actions

### Must Fix Before Internal Testing
*None. Internal testing can proceed as-is.*

### Must Fix Before Closed Testing
1. **Sync `app.json` `android.versionCode` from 2 to 3.** Prevents EAS metadata confusion and ensures `appVersionSource: "local"` reads the correct version for future Play submissions.  
   `app.json:36` → `"versionCode": 3`

2. **Remove diagnostic headers from website rooms API response.**  
   `kscan-website/app/api/rooms/[token]/route.ts` → remove `X-KScan-Supabase-Url-Present` and `X-KScan-Service-Key-Present` headers from all response branches.

### Must Fix Before Production
3. **Add per-minute burst limit to `stylechat-generate`.** Add a check in the quota RPC or at the function level that caps invocations per user per minute (recommended: 5/min). Prevents quota exhaustion from parallel requests or replay attacks.

4. **Verify `dressing_room_items.image_url` is always a signed/expiring URL, not a permanent public bucket URL.** Audit what values are stored. If any are permanent public URLs, migrate to signed URL generation at write time and ensure all storage buckets are private.

5. **Remove dead `setPrivacyAccessToken()` function and `_devTokenOverride` variable.**  
   `services/supabasePrivacy.js:9` — clean up deprecated dev override.

6. **Wire `handle-user-deletion` to an automated trigger.** A cron Edge Function, database webhook, or n8n automation should process `deletion_requests` with `status = 'pending'` within 30 days. The current implementation requires manual invocation.

### Future Roadmap
- Phase 2 of `privacyImageSanitizer.js` (on-device face/plate detection)
- Per-session StyleChat context beyond brand/category signals (saved scan metadata, dressing room contents as explicit context)
- `CaptureSourceAdapter` abstraction for smart-glasses bridge readiness
- Affiliate/checkout intent wiring from product match cards
- Migrate `eas.json` API keys to EAS environment secrets (do not delete — just move)

---

## 9. Files Inspected

**App Repo (`C:\Users\jsmit\KScan`)**
- `android/app/build.gradle`
- `android/build.gradle`
- `android/settings.gradle`
- `android/app/src/main/AndroidManifest.xml`
- `android/app/src/release/AndroidManifest.xml`
- `app.json`
- `eas.json`
- `package.json`
- `app/_layout.tsx`
- `app/index.tsx`
- `app/privacy.tsx`
- `app/style-chat/index.tsx`
- `app/style-chat/[sessionId].tsx`
- `app/api/style-chat/message+api.ts`
- `app/api/style-chat/session+api.ts`
- `app/(public)/rooms/[token].tsx`
- `app/auth/index.tsx`
- `components/style-chat/StyleChatBubble.tsx`
- `services/routingGuard.js`
- `services/privacyImageSanitizer.js`
- `services/style-chat/providers/edgeStyleChatProvider.ts`
- `services/style-chat/styleChatRepository.ts` (partially, via grep)
- `services/accountDeletion.ts`
- `services/supabaseClient.ts` (via grep)
- `services/supabasePrivacy.js` (via grep)
- `hooks/useStyleChat.ts`
- `supabase/functions/stylechat-generate/index.ts`
- `supabase/functions/handle-user-deletion/index.ts` (head)
- `supabase/migrations/202605240001_room_shares_public_preview.sql`
- `supabase/migrations/202606070001_style_chat.sql` (via grep)
- `supabase/migrations/202606070002_style_chat_usage_rpc.sql` (via grep)
- `supabase/migrations/202606070005_stylechat_daily_usage.sql` (via grep)
- `supabase/migrations/20260607222310_inspiration_uploads.sql` (via grep)
- `AGENTS.md`
- `node_modules/expo-modules-autolinking/.../ExpoRootProjectPlugin.kt`
- `node_modules/@react-native/gradle-plugin/.../ReactRootProjectPlugin.kt`

**Website Repo (`C:\Users\jsmit\kscan-website`)**
- `app/api/rooms/[token]/route.ts`
- `app/legal/delete-account/page.tsx`
- `app/legal/privacy/page.tsx` (via grep)
- `app/legal/terms/page.tsx` (via grep)
- `app/legal/terms-summary/page.tsx` (via grep)
- `app/privacy/page.tsx` (via grep)
- `lib/publicRoomPreview.ts`
- `lib/supabaseAdmin.ts`
- `lib/serverSupabaseEnv.ts` (via grep)

---

## 10. Commands Run

| Command | Result |
|---|---|
| `git status --short` | PASS — 116 untracked files (QA artifacts), 0 modified tracked files |
| `git branch --show-current` | PASS — `feature/stylechat-v0.4.1-ui-keyboard-fix` |
| `git log --oneline -10` | PASS — StyleChat, delete flow, keyboard fix, portrait layout commits present |
| `git remote -v` | PASS — `origin https://github.com/kscanaiapp/kscan-app.git` |
| `Select-String ... build.gradle` (applicationId, versionCode, signing) | PASS — versionCode=3, applicationId=com.kscanai.app, EAS signing |
| `Select-String ... build.gradle` (SDK versions) | PASS — references rootProject.ext (Expo plugin defaults to compileSdk=35, targetSdk=35, minSdk=24) |
| `Select-String ... app.json` (versionCode) | NOTE — versionCode=2 (stale, does not match build.gradle) |
| `git ls-files \| Select-String ... keystore` | PASS — only `android/app/debug.keystore` tracked |
| `Select-String .gitignore ... keystore` | PASS — *.keystore, *.jks, android/app/release-keystore/ excluded |
| `Select-String ... AndroidManifest.xml` | PASS — 3 permissions, allowBackup=false |
| `Select-String ... release/AndroidManifest.xml` | PASS — removes 4 dev-only permissions |
| `rg ... expo-updates, runtimeVersion, EXPO_PUBLIC ...` | PASS — expo-updates not installed; OTA not used |
| `rg ... face, blur, biometric, zero-knowledge, pii ...` | PASS — all claims accurate (passthrough mode) |
| `rg ... stylechat, gemini, llm ...` (app + supabase) | PASS — no hardcoded keys; API key server-side only |
| `rg ... dangerouslySetInnerHTML, WebView, Linking.openURL ...` | PASS — no unsafe HTML rendering; Linking only for hardcoded legal URLs |
| `rg ... service_role ...` (app code) | PASS — not present in mobile client |
| `adb devices` | INFO — no device connected |
| `git status --short` (website) | PASS — clean |
| `npm run lint` (website) | PASS — 0 errors, 2 warnings (unused vars, non-blocking) |
| `npm run build` (website) | PASS — successful Next.js build, all routes compiled |

---

## 11. Confidence Labels by Finding

| Finding | Confidence |
|---|---|
| versionCode=3 in build.gradle | Verified by command output |
| versionCode=2 in app.json | Verified by command output |
| SDK versions = compileSdk/targetSdk=35, minSdk=24 | Verified by code (ExpoRootProjectPlugin.kt defaults) |
| Release signing is EAS-managed, no tracked keystore | Verified by command output |
| CAMERA, INTERNET, VIBRATE only in release | Verified by command output (main + release overlay manifests) |
| allowBackup=false | Verified by command output |
| expo-updates not installed | Verified by command output (grep found no results) |
| StyleChat auth guard enforced | Verified by code (routingGuard.js; only /rooms/:token and /auth/* are public) |
| Gemini API key server-side only | Verified by code (Deno.env.get; never in EXPO_PUBLIC) |
| Daily quota enforced atomically | Verified by code (increment_stylechat_daily_usage RPC) |
| LLM output rendered via Text (not HTML) | Verified by code (StyleChatBubble) |
| RLS on all StyleChat tables | Verified by code (migration SQL) |
| RLS on inspiration_items | Verified by code (migration SQL) |
| Share URL uses opaque UUID token | Verified by code (create_or_get_room_share returns gen_random_uuid()) |
| Share revocation implemented | Verified by code (revoke_room_share sets is_active=false) |
| Website service role key is server-side only | Verified by code (import "server-only") |
| Diagnostic header information disclosure | Verified by code (route.ts response headers) |
| image_url type (signed vs public) | Inferred from architecture — database state not verified |
| Per-minute rate limit absent | Verified by code (only daily quota in Edge Function) |
| Account deletion email = kscanai.app@gmail.com | Verified by code (consistent across app, website) |
| Smart glasses: no implementation | Verified by code (grep found no wearable/glasses/BLE code) |
| Privacy claims accurate (passthrough sanitizer) | Verified by code (privacyImageSanitizer.js) |
| Website build passes | Verified by command output (npm run build PASS) |

---

*Audit generated 2026-06-09 by Senior Mobile Release Engineer / DevSecOps audit session.*  
*Hard safety rules followed: no git add, no commit, no push, no destructive SQL, no secrets printed, no keystores created/rotated, no Play Console upload, no website deployment.*
