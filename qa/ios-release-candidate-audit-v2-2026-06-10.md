# K Scan AI — iOS App Store Readiness Audit v2
## Date: 2026-06-10 | Branch: feature/beta-account-lifecycle | Prior audit reconciliation: 2026-06-09

---

## 1. Audit Scope Disclaimer

> **This was a static/configuration/documentation-only iOS audit. No iOS simulator, physical iPhone, TestFlight runtime, Android emulator, or App Store submission was performed.**
>
> All findings are evidence-backed from source code, configuration files, and documentation. No runtime behavior was validated. Confidence labels appear inline.

---

## 2. Current App Branch and HEAD

| Field | Value |
|---|---|
| **Branch** | `feature/beta-account-lifecycle` |
| **HEAD commit** | `61c8a09 merge(account): request-intake edge function routing` |
| **Merge commit 61c8a09 present** | YES — HEAD is the merge commit |
| **Commits on branch (last 8)** | `61c8a09`, `37229a3`, `1cd5cf9`, `6b3086e`, `7384746`, `b76b49d`, `f9e1539`, `56691ec` |

---

## 3. Working Tree Status

No tracked files are modified or staged. Working tree is clean with respect to tracked files.

Untracked files present (extensive): QA logs, screenshots, XML dumps, build artifacts, `kscan-presubmission-audit.md`, `deletion-fix.patch`, `store.config.json`, `AGENTS.md`, `docs/persistent-style-objects.md`, `supabase/functions/search-vinted-secondhand/`. These are all QA/development artifacts and are left untouched per audit rules.

**Note:** `supabase/functions/search-vinted-secondhand/` is an untracked (uncommitted) new Edge Function. It is not part of the current committed codebase and must not be included in any privacy label, App Review notes, or submission documentation until it is reviewed and committed.

---

## 4. Previous 2026-06-09 Audit Blocker Status

| Prior Finding | Status |
|---|---|
| `ios.deploymentTarget` missing | **STILL MISSING** — `ios.deploymentTarget` absent from `app.json`. iOS 16 default still inferred from Expo SDK 54. |
| `ios.buildNumber` App Store Connect verification | **STILL BLOCKED** — `ios.buildNumber` is now ABSENT entirely from `app.json` (was `"2"` in prior audit). Cannot verify against App Store Connect from repo. |
| EAS iOS signing credentials | **STILL UNVERIFIED** — `eas credentials -p ios` not run per safety rules. Cannot verify without credential access. |
| `eas.json` preview profile iOS config | **STILL MISSING** — `preview` profile has no iOS section. Additionally, the `production` build profile is now ABSENT entirely (see Section 17, B1). |
| EAS production profile iOS config | **REGRESSION — BLOCKER** — The `build.production` profile that was present in the prior audit is now absent from `eas.json`. No App Store build can be triggered without it. |
| `expo.owner` absent | **STILL ABSENT** — `expo.owner` not set in `app.json`. |
| `ios/` native directory | **ABSENT AS EXPECTED** — Managed Expo workflow confirmed. `prebuild` required before any iOS build. |
| Apple Sign-In config | **CHANGED — SEE SECTION 9** — `expo-apple-authentication` removed from package.json, plugins, and auth screen. No third-party login offered → Apple Sign-In not required. Neutral change per App Store guidelines. |
| Privacy manifest categories | **REGRESSION — WARNING** — `ios.privacyManifests` was declared in prior audit (UserDefaults CA92.1, FileTimestamp C617.1). It is now ABSENT from `app.json`. Privacy manifest will not be emitted during prebuild without this config. |
| `microphonePermission: false` | **REGRESSION — WARNING** — `microphonePermission: false` was present in the `expo-camera` plugin config in the prior audit. It has been REMOVED. expo-camera may now emit a default `NSMicrophoneUsageDescription` during prebuild. |
| No tracking SDK drift | **PASS** — No analytics, tracking, advertising, or crash reporting SDK has been introduced. |

---

## 5. Changes Since 2026-06-09 Audit

| Item | Status |
|---|---|
| Account deletion routes through Edge Function | **YES** — `submitAccountDeletionRequest()` calls `supabase.functions.invoke('handle-user-deletion')`. No direct `.from('deletion_requests').insert()` in UI path. Confirmed by `services/accountDeletion.js` and `app/privacy.tsx`. |
| Website deletion copy updated (StyleChat/Style Memory) | **YES** — Commit `654d6c7` confirmed present in website repo. `app/legal/delete-account/page.tsx` includes StyleChat conversations, Style Memory, and personalization context. Data export CTA present. |
| New dependencies added | **NONE** — No new dependencies added to `package.json` since prior audit. `expo-image-picker` and `expo-apple-authentication` have been REMOVED. |
| New iOS permissions declared | **NONE** — Only `NSCameraUsageDescription` remains. |
| Regressions introduced | `ios.privacyManifests` removed, `microphonePermission: false` removed, `ios.buildNumber` removed, `ios.supportsTablet: false` removed, `ios.infoPlist.ITSAppUsesNonExemptEncryption` removed, EAS `build.production` profile removed. |
| Config fixes applied | None from the prior audit's recommended list. Account deletion routing fixed (Edge Function). |
| Remaining unresolved prior audit items | EAS iOS credentials, `ios.deploymentTarget`, `expo.owner`, preview profile iOS config, build number verification, App Privacy label, App Store screenshots, reviewer demo account. |

---

## 6. iOS Variables Inventory

| Variable | Value | Source | Notes |
|---|---|---|---|
| App name | `"K Scan"` | `app.json expo.name` | Verified |
| Slug | `"kscan"` | `app.json expo.slug` | Verified |
| `expo.owner` | **ABSENT** | `app.json` | Not set |
| Bundle identifier | `com.kscanai.app` | `app.json ios.bundleIdentifier` | Verified |
| URL scheme | `kscan` | `app.json expo.scheme` | Verified |
| Auth callback URL | `kscan://auth/callback` | `services/authConfig.js` | Verified |
| Associated domains / universal links | **ABSENT** | Not configured | Shared rooms use `kscan.app/rooms/[token]` in browser |
| App version | `"1.0.0"` | `app.json expo.version` | Verified |
| iOS build number | **ABSENT** | `app.json` (no `ios.buildNumber`) | Was `"2"` in prior audit — REGRESSION |
| Expo SDK | `"54.0.0"` | `app.json sdkVersion` / `package.json "expo": "~54.0.34"` | Verified |
| React Native version | `"0.81.5"` | `package.json` | Verified |
| iOS deployment target | **NOT SPECIFIED** | `app.json ios` | Missing; defaults to Expo SDK 54 floor (iOS 16) |
| EAS profiles | `preview`, `development` | `eas.json` | **`production` profile ABSENT** |
| `supportsTablet` | **ABSENT** | `app.json ios` | Was `false` in prior audit — REGRESSION |
| `ITSAppUsesNonExemptEncryption` | **ABSENT** | `app.json ios.infoPlist` | Was `false` in prior audit — REGRESSION |
| EAS project ID | `a075728d-bd77-446f-843d-0f63fd54cc2e` | `app.json extra.eas.projectId` | Verified |

---

## 7. Permission Audit Table

| Permission | Declared | Purpose String | Actual Feature Need | Status |
|---|---|---|---|---|
| `NSCameraUsageDescription` | **YES** | "K Scan uses your camera to photograph your outfit for style analysis." | Fashion scan feature — camera required | **PASS** — specific, accurate |
| `NSPhotoLibraryUsageDescription` | **NO** | Absent | `expo-image-picker` removed; no inspiration upload in current home screen | **PASS** — absence is correct |
| `NSPhotoLibraryAddUsageDescription` | **NO** | Absent | No save-to-camera-roll feature | **PASS** — correct absence |
| `NSMicrophoneUsageDescription` | **NOT EXPLICITLY SET** | expo-camera plugin has no `microphonePermission: false` | App does not use microphone | **WARNING** — removing `microphonePermission: false` from expo-camera plugin may cause expo prebuild to emit a default microphone permission string. Needs verification after `expo prebuild`. If emitted, App Review will question microphone use. |
| `NSUserTrackingUsageDescription` | **NO** | Absent | No tracking/ATT SDK in use | **PASS** — correct absence |
| `NSLocationWhenInUseUsageDescription` | **NO** | Absent | No location features | **PASS** — correct absence |
| `NSFaceIDUsageDescription` | **NO** | Absent | No Face ID features | **PASS** — correct absence |
| `NSContactsUsageDescription` | **NO** | Absent | No contacts access | **PASS** — correct absence |
| `NSBluetoothAlwaysUsageDescription` | **NO** | Absent | No Bluetooth features | **PASS** — correct absence |
| `NSLocalNetworkUsageDescription` | **NO** | Absent | Not applicable | **PASS** — correct absence |
| `ITSAppUsesNonExemptEncryption` | **ABSENT** | Was `false` in prior audit | Standard HTTPS only | **WARNING** — Needs to be re-declared as `false` in `ios.infoPlist`. Export compliance question in App Store Connect requires this answer. Without it, EAS build may not correctly auto-answer encryption during submission. |

---

## 8. Entitlements / Capabilities Table

| Capability | Present | Expected | Status |
|---|---|---|---|
| Camera access | YES (`expo-camera` plugin) | YES — scan feature | PASS |
| Photo Library read | NO (`expo-image-picker` removed) | NO — no photo picker in current app | PASS |
| Sign in with Apple | NO (`usesAppleSignIn` absent, `expo-apple-authentication` removed) | NO — no third-party login, Apple Sign-In not required | PASS |
| Push notifications | NO (`expo-notifications` not in dependencies) | NO — not a feature | PASS |
| Associated domains / universal links | NO | NO — not configured; shared rooms use browser URL | PASS |
| In-app purchases | NO | NO — not a feature | PASS |
| Bluetooth | NO | NO | PASS |
| Location services | NO | NO | PASS |
| Contacts | NO | NO | PASS |
| Background fetch | NO | NO | PASS |
| Microphone | NOT EXPLICITLY BLOCKED | NO — app does not use microphone | **WARNING** — `microphonePermission: false` removed from expo-camera plugin; may be emitted by prebuild |

---

## 9. Apple Sign-In Audit

| Item | Status |
|---|---|
| `expo-apple-authentication` in package.json | **ABSENT** — removed since prior audit |
| `expo-apple-authentication` in plugins | **ABSENT** — removed |
| `ios.usesAppleSignIn: true` in app.json | **ABSENT** — removed |
| Apple Sign-In code in `app/auth/index.tsx` | **ABSENT** — auth screen is email/password only |
| Google Sign-In in auth screen | **ABSENT** — no third-party login of any kind |
| Nonce/SHA-256 flow | N/A — Apple Sign-In not present |
| Token revocation strategy | N/A — Apple Sign-In not present |

**Assessment:** Apple Sign-In is no longer implemented or configured. The current `app/auth/index.tsx` only offers email/password authentication with no third-party login. Per App Store guidelines, Sign in with Apple is **only required when third-party login is offered**. Since no third-party login (Google, Facebook, etc.) exists in the current auth screen, the absence of Apple Sign-In is **NOT a blocker or warning** per App Store guideline 4.8.

**App Review risk:** None from this specific area. A reviewer testing authentication will use email/password only.

---

## 10. Account Deletion — Apple Standard Audit

| Item | Result | Evidence |
|---|---|---|
| In-app deletion initiation present | **YES** | `app/privacy.tsx` — "Delete Account" button with `testID="privacy-delete-account-button"`, visible to authenticated users |
| Deletion accessible without support-only contact | **YES** | Accessible from Privacy screen directly; not hidden |
| Request-based copy accurate | **YES** | Modal body: "Your account will be marked pending deletion while K Scan AI processes required retention, security, and legal checks." |
| Edge Function routing present | **YES** | `services/accountDeletion.js`: `supabase.functions.invoke('handle-user-deletion', { body: {} })` |
| No direct `.from('deletion_requests').insert()` in UI path | **YES** | Not found in `app/privacy.tsx` or `services/accountDeletion.js` (client insert removed per recent fixes) |
| `already_requested` handling present | **YES** | `app/privacy.tsx` line 157: checks `result.status === 'already_requested'`, shows "Request already pending. You have been signed out." |
| Signs out after result handled | **YES** | `app/privacy.tsx`: `await signOut()` + `router.replace('/auth')` in `confirmDeletion()` regardless of `already_requested` or `submitted` path |
| Local privacy preference cleared | **YES** | `AsyncStorage.removeItem(LOCAL_PRIVACY_STORAGE_KEY)` called before signOut |
| Full deletion processor absent from client | **YES** | Only creates deletion request record; no auth.admin or storage purge from client |
| Service-role key absent from mobile code | **YES** | Service-role key only in `handle-user-deletion` Edge Function server-side; absent from all client-side code and `eas.json` env |
| Apple Sign-In deletion/revocation | **N/A** | Apple Sign-In removed; no Apple token revocation needed |
| Edge Function uses service-role key server-side only | **YES** | `handle-user-deletion/index.ts` uses `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` — server-only |
| **Overall deletion standard compliance** | **PASS** | In-app deletion initiation is reachable, request-based, routes through Edge Function, handles already_requested, signs out. Meets Apple's account deletion requirement. |

---

## 11. App Privacy Details Draft Inventory

> Based on current committed codebase only. `supabase/functions/search-vinted-secondhand/` is untracked and excluded.

| Data Category | Collected | Linked to User | Used for Tracking | Purpose | Evidence | Risk |
|---|---|---|---|---|---|---|
| **Email address** | YES | YES | NO | Account creation, authentication | `app/auth/index.tsx`, Supabase auth | Low — standard auth |
| **User ID (Supabase UUID)** | YES | YES | NO | All authenticated features, privacy preferences | `contexts/AuthSessionContext.tsx`, Supabase | Low |
| **Photos / scan images** | YES (in-transit) | YES | NO | Fashion AI analysis — image sent as base64 to `kscan-app-1.onrender.com` and to Gemini API via backend | `services/imageUtils.js`, `services/api.js`, privacy policy | **Medium** — third-party processor (Render backend → Gemini); must be disclosed in App Privacy label |
| **Scan metadata** (category, color, silhouette, date) | YES | YES (if signed in) / device-local (if signed out) | NO | Style Library display | `services/library.js`, `hooks/useLibrary.js` (AsyncStorage) | Low |
| **Privacy preferences** (`opt_out_of_sale`, `limit_sensitive_processing`) | YES | YES (if signed in) | NO | CCPA/CPRA compliance | `services/supabasePrivacy.js`, Supabase `privacy_settings` table | Low |
| **Account deletion requests** | YES | YES | NO | Compliance, 30-day processing | `handle-user-deletion` Edge Function, `deletion_requests` table | Low |
| **Crash/error logs** | YES (console.error only) | NO | NO | Internal debugging — no external SDK | `app/_layout.tsx` global error handler | Low — not transmitted |
| **Device identifiers (IDFA/IDFV)** | NO | N/A | N/A | Not collected | No tracking/advertising SDK in package.json | None |
| **Location** | NO | N/A | N/A | Not collected | No `expo-location` or location API | None |
| **Contacts** | NO | N/A | N/A | Not collected | No contacts SDK | None |
| **Browsing / search history** | NO | N/A | N/A | Not collected | No analytics SDK | None |
| **StyleChat messages** | UNCERTAIN | UNCERTAIN | NO | `stylechat-generate` Edge Function not found in current committed codebase; screen not accessible from current home screen | `supabase/functions/` glob shows no `stylechat-generate` | **Unclear** — if StyleChat is added in a future commit, message data must be included in App Privacy label |
| **Style Memory / personalization** | UNCERTAIN | UNCERTAIN | NO | Not visible in current home/nav flow | No committed StyleChat or Style Memory screens in current branch | **Unclear** — same as above |
| **Purchase/payment info** | NO | N/A | N/A | No in-app purchase SDK | No payment SDK | None |

**Key note:** The scan image flow sends data to `kscan-app-1.onrender.com` (a Render-hosted server) which proxies to the Gemini API. This is a third-party processor relationship. The App Privacy label must include **Photos and Videos** under "Data Linked to You" with purpose "App Functionality." Gemini processes the image but raw images are not retained by the backend per the privacy policy.

---

## 12. Privacy Manifest / SDK Findings

| Item | Status | Evidence |
|---|---|---|
| `ios.privacyManifests` in app.json | **ABSENT** — REGRESSION | `app.json` ios section has no `privacyManifests` key. Was declared in prior audit with UserDefaults (CA92.1) and FileTimestamp (C617.1). |
| `PrivacyInfo.xcprivacy` file | Cannot inspect — no `ios/` native directory (managed workflow) | Prebuild required |
| `NSPrivacyAccessedAPICategoryUserDefaults` | **NOT DECLARED** | `@react-native-async-storage/async-storage` accesses UserDefaults/AsyncStorage on iOS. Requires CA92.1 reason code. |
| `NSPrivacyAccessedAPICategoryFileTimestamp` | **NOT DECLARED** | `expo-file-system` may access file timestamps. Requires C617.1 reason code. |
| SDK manifest coverage — Expo SDK 54 | Expo SDK 54 bundles its own privacy manifests for Expo modules (expo-camera, expo-file-system, expo-image-manipulator, etc.). However, the **app-level manifest** must still be configured in `app.json` for app-specific API usage. | Architecture inference |
| `@react-native-async-storage/async-storage` | Requires `NSPrivacyAccessedAPICategoryUserDefaults` | package.json dependency |
| `expo-file-system` | Likely requires `NSPrivacyAccessedAPICategoryFileTimestamp` | package.json dependency |
| `expo-image-manipulator` | Uses file manipulation — may require FileTimestamp | package.json dependency |
| No analytics SDK | ✓ No Amplitude, Firebase, Mixpanel, Segment, etc. | package.json |
| No advertising/attribution SDK | ✓ No Adjust, AppsFlyer, Branch, Facebook, Meta | package.json |
| No crash reporting SDK | ✓ No Sentry, Bugsnag, Crashlytics | package.json |
| **Required action** | Re-add `ios.privacyManifests` to `app.json` with at minimum `NSPrivacyAccessedAPICategoryUserDefaults: ["CA92.1"]` and `NSPrivacyAccessedAPICategoryFileTimestamp: ["C617.1"]` | Evidence: prior audit confirmed these were needed and declared |

---

## 13. AI / Image / StyleChat Privacy Claim Audit

| Item | Finding | Risk |
|---|---|---|
| **Raw image / base64 handling** | Scan images are captured via expo-camera, compressed to base64 JPEG by `expo-image-manipulator` via `services/imageUtils.js`, then sent to `kscan-app-1.onrender.com` via `services/api.js`. Images are sent off-device via HTTPS. The Expo Route Handler `app/api/analyze+api.js` uses `GEMINI_API_KEY` (server-side `process.env`, not `EXPO_PUBLIC_`) and will not be bundled into the native iOS binary. | **PASS** — off-device processing disclosed in privacy policy at `kscan.app/legal/privacy`. Not claimed as on-device. |
| **StyleChat message handling** | `supabase/functions/stylechat-generate/` is NOT present in the current committed codebase. The `stylechat-generate` Edge Function referenced in the prior audit does not appear in the current `supabase/functions/` directory. No StyleChat screen is accessible from the current home screen. | **NEUTRAL** — StyleChat absent from current committed codebase. If re-added in a future commit, message data must be disclosed. |
| **Style Memory / personalization context** | No Style Memory context or personalization code visible in current committed app screens. | **NEUTRAL** — same as StyleChat above. |
| **On-device face blurring claim** | No on-device face blur is claimed in any app screen, component, or copy in the current codebase. The grep for `face`, `blur`, `on-device`, `privacy filter` in `app/` returns no relevant code-level claims. | **PASS** — no unsupported claim. Website privacy policy correctly states privacy sanitizer "may operate in pass-through mode during beta" and "K Scan does not represent this beta as active on-device face blurring." |
| **Biometric / facial recognition claim** | No `NSFaceIDUsageDescription` or biometric API usage found. No facial recognition claim in any screen. | **PASS** |
| **Model training claim** | No model training or third-party model training claim found in app code or accessible privacy copy. | **PASS** |
| **Gemini API key in native bundle** | `GEMINI_API_KEY` is a plain `process.env` variable (not `EXPO_PUBLIC_*`), so it will not be embedded in the native iOS binary by the Metro bundler. | **PASS** |
| **Service-role key in native bundle** | No service-role key found in `eas.json` env, `app.json`, or any client-side service file. Present only in `handle-user-deletion/index.ts` server-side via `Deno.env.get()`. | **PASS** |

---

## 14. Website / Legal Consistency

| Item | Status |
|---|---|
| Website commit `654d6c7` present | **VERIFIED** — Top of `git log --oneline -5` in `kscan-website` repo. |
| Delete-account page includes StyleChat/Style Memory coverage | **YES** — `app/legal/delete-account/page.tsx` line 65: "StyleChat conversations, saved style preferences, Style Memory, and personalization context connected to your account." |
| Data export CTA present | **YES** — "Request a data export before deleting your account" with link to `/support`. |
| Export CTA does not imply instant download | **PASS** — Links to support page; does not claim instant download. |
| Deletion copy does not imply instant deletion | **PASS** — "Account deletion is handled through a request workflow and is not immediate." |
| Processing time stated | **PASS** — "Deletion requests are processed within 30 days unless a legal, security, or technical exception applies." |
| Retention/legal exceptions intact | **PASS** — "K Scan may retain information where required or permitted for legal compliance, security, fraud prevention, dispute resolution, accounting or tax obligations, or de-identified and aggregated analytics." |
| Contact email consistent | **PASS** — `kscanai.app@gmail.com` in delete-account page; matches in-app support email. |
| Website copy vs app behavior | **MINOR CONCERN** — Website delete-account page mentions StyleChat, Style Memory, Dressing Rooms. These features are not accessible from the current home screen in this branch. This is acceptable for a legal page describing data categories, but reviewers following in-app navigation paths will not see these features. |
| In-app path stated correctly | **PASS** — Website says "go to Privacy and choose Delete Account." App has "PRIVACY CONTROL" button on home screen → Privacy screen → Delete Account. Path is correct. |
| Public delete-account URL readiness | **PASS** — `https://kscan.app/legal/delete-account` is a valid live URL per the presubmission audit. Should be set as the account deletion URL in App Store Connect. |
| Website copy status | **VERIFIED MERGED** — Commit `654d6c7` confirmed in website repo. |

---

## 15. App Store Metadata / Reviewer Note Findings

Two local submission documents were found:

### `kscan-presubmission-audit.md` (website audit, 2026-06-09)
Scope: website/web compliance. Not mobile-app-specific submission material.

Findings relevant to iOS submission:
- Privacy Policy URL for App Store Connect: **Use `https://kscan.app/legal/privacy`** (not `/privacy` which may serve stale content per the presubmission audit's critical finding B1 about Vercel caching). Evidence: `kscan-presubmission-audit.md` §5a.
- Delete-account URL for App Store Connect: `https://kscan.app/legal/delete-account` ✓
- Support URL: `https://kscan.app/support` ✓
- In-app deletion path mismatch between `/privacy` and `/legal/delete-account` pages was flagged. After the 654d6c7 website patch, the `/legal/delete-account` page says "go to Privacy and choose Delete Account" — this now matches the app. If the cached `/privacy` page still says "Settings > Account > Delete Account," that's a discrepancy only visible from the stale cached version.

### `qa/ios-release-candidate-audit-2026-06-09.md`
Prior iOS audit. Reconciled in this document (Sections 4–5 above).

No App Store review notes, no TestFlight "What to Test" document, no reviewer demo account checklist, no App Store metadata draft found in `docs/` or repo root.

**Missing submission documentation:**
- No "What to Test" TestFlight notes
- No reviewer demo account record
- No App Store Connect metadata draft (screenshots, description, keywords)

---

## 16. Validation Commands Run and Results

| Command | Result |
|---|---|
| `git branch --show-current` | `feature/beta-account-lifecycle` |
| `git status --short` | Many untracked QA artifacts; no staged changes; no tracked modifications |
| `git log --oneline -8` | Confirmed; HEAD = `61c8a09 merge(account): request-intake edge function routing` |
| `git log` in `kscan-website` | Confirmed commit `654d6c7` is present |
| `npm run lint` | **FAILED** — No `lint` script defined in `package.json`. Lint cannot be run. No TypeScript compiler or ESLint is configured as a package script. |
| Safe targeted test run | `npm run test:auth-privacy` and `npm run test:privacy` exist but not run — per audit rules, no execution of tests requiring live external services. **No safe targeted test run was performed.** |
| Grep for credential files | No `.p8`, `.p12`, `.mobileprovision` files in tracked source. `.env` and `.env.local` present but gitignored (not inspected). |
| Grep for service-role key in client code | None found in `app/`, `services/`, `contexts/`, `eas.json` env sections. |
| `ios/` directory check | Does not exist — managed workflow confirmed. |

---

## 17. Blockers Before TestFlight

| # | Blocker | Evidence | Confidence |
|---|---|---|---|
| **B1** | **EAS `build.production` profile ABSENT from `eas.json`** — The production build profile with `distribution: "store"` and iOS `buildConfiguration: "Release"` was present in the prior audit but is no longer in `eas.json`. `eas build --profile production --platform ios` cannot be executed without it. The `submit.production` section is empty and cannot be used without a corresponding build profile. | `eas.json` — only `preview` and `development` profiles present | Verified by code |
| **B2** | **EAS iOS credentials not verified** — No distribution certificate, provisioning profile, or App Store Connect API key status has been confirmed. `eas credentials -p ios` not run per safety rules. Cannot upload to TestFlight without valid credentials. | Not run — safety rules | Not verified |
| **B3** | **`ios.buildNumber` absent** — `ios.buildNumber` was `"2"` in the prior audit and is now entirely absent from `app.json`. With `appVersionSource: "local"`, EAS will attempt to read `ios.buildNumber` from the local config. Its absence may cause the build to fail or default to an unexpected value. If App Store Connect already has a build under `com.kscanai.app`, an incorrect or duplicate build number will cause the upload to be rejected. | `app.json ios` section; `eas.json cli.appVersionSource: "local"` | Verified by code |
| **B4** | **`ios.privacyManifests` absent** — The privacy manifest declaration that was confirmed present in the prior audit has been removed from `app.json`. Without it, `expo prebuild` will not generate a `PrivacyInfo.xcprivacy` file for `NSPrivacyAccessedAPICategoryUserDefaults` (CA92.1) and `NSPrivacyAccessedAPICategoryFileTimestamp` (C617.1). Apple requires required-reason APIs to be declared. Missing declarations may cause App Review rejection. `@react-native-async-storage/async-storage` and `expo-file-system` both require these declarations. | `app.json` ios section; package.json dependencies; prior audit §3 | Verified by code |
| **B5** | **`microphonePermission: false` removed from expo-camera plugin** — The prior audit confirmed `microphonePermission: false` in the expo-camera plugin config, which prevents `NSMicrophoneUsageDescription` from being added to the iOS build. This explicit block has been removed. If expo-camera v17 emits a default microphone permission string during prebuild (which is its behavior when not set to `false`), the app will request microphone access it does not use. App Review will reject an app with a permission string for a feature that is never invoked. | `app.json plugins expo-camera config`; prior audit §3 permission table | Verified by code; prebuild behavior inferred from architecture |

---

## 18. Warnings Before TestFlight

| # | Warning | Evidence |
|---|---|---|
| **W1** | **`ios.deploymentTarget` not specified** — Minimum iOS version defaults to Expo SDK 54's floor (iOS 16.0 inferred). Should be explicitly declared as `"16.0"` (or newer) in `app.json ios.deploymentTarget`. Prevents device-support surprises after submission. | `app.json` — no `deploymentTarget` key |
| **W2** | **`ios.supportsTablet` absent** — Was explicitly `false` in prior audit. Currently absent. Expo's default may allow iPad. For a portrait-only app with fashion scanning, iPad support is likely undesirable and unexpected. Should be set to `false`. | `app.json ios` section |
| **W3** | **`ITSAppUsesNonExemptEncryption: false` absent** — Was declared in prior audit. Currently removed. App uses standard HTTPS only and should declare `false`. Without this, the EAS submission process may prompt or fail the export compliance step. | `app.json ios.infoPlist` |
| **W4** | **`expo.owner` not set** — EAS project binding is not explicitly tied to an account slug. Should be set to match the EAS account to prevent project-binding ambiguity during builds. | `app.json` |
| **W5** | **`eas.json` preview profile has no iOS section** — If an internal iOS TestFlight smoke-test build is desired from the preview profile, an iOS section must be added. Currently `preview` is Android-only. | `eas.json build.preview` |
| **W6** | **No `lint` script in `package.json`** — No static analysis tool is configured. TypeScript compilation (`tsc`) is available via devDependencies but not as a package script. Code quality cannot be checked pre-build without manual configuration. | `package.json scripts` |
| **W7** | **Supabase anon key in `eas.json` plaintext** — `EXPO_PUBLIC_SUPABASE_ANON_KEY` is hardcoded in `eas.json` (preview env). The anon key is designed to be public and the risk is low, but using EAS secrets instead of `eas.json` inline env vars is a better practice. Confirmed: no service-role key present. | `eas.json preview.env` |
| **W8** | **No crash reporting SDK** — `console.error` only. Production crashes on TestFlight will only be visible via Xcode organizer or TestFlight crash logs, not a real-time dashboard. | `package.json` |
| **W9** | **`app/scan/index.tsx` re-exports from `../../app` (root `app.js`)** — The scan screen uses the original React Native component from `app.js`. This architecture may cause issues during Expo Router prebuild if `app.js` is not correctly handled. Needs verification during prebuild. | `app/scan/index.tsx:1` |

---

## 19. Nice-to-Have Polish Before TestFlight

| # | Item |
|---|---|
| N1 | Add a `lint` script (e.g., `"lint": "tsc --noEmit"`) to `package.json` for static type checking as part of CI. |
| N2 | Prepare App Store Connect metadata: app description, keywords, screenshots for iPhone 6.7" (Pro Max), 6.1" (standard), and optionally 5.5" (legacy). None found locally. |
| N3 | Create TestFlight "What to Test" notes covering: scan flow, account deletion flow (critical), auth sign-in/sign-up, session persistence, permission dialogs (camera), no microphone/ATT prompt. |
| N4 | Create a reviewer demo account with pre-populated scan history for App Review team. |
| N5 | Confirm which privacy URL to submit to App Store Connect. Per the presubmission audit, `https://kscan.app/legal/privacy` is preferred over `https://kscan.app/privacy` (which may serve a cached stale deployment). |
| N6 | Consider moving `EXPO_PUBLIC_SUPABASE_ANON_KEY` from `eas.json` inline env to EAS secrets for cleaner credential management. |
| N7 | Tag a clean release commit on a stable branch before triggering any EAS build. Current HEAD is a feature branch merge commit. A clean release branch or tag improves release history traceability. |
| N8 | Delete unused local QA artifacts (log files, XML dumps at repo root) from the repo root before any PR to `master` to keep the tree clean. |

---

## 20. Recommended Next Action

**Priority sequence before TestFlight:**

1. **Re-add `build.production` EAS profile** to `eas.json` with `distribution: "store"`, `ios: { buildConfiguration: "Release" }`. This is the single largest blocker — without it no App Store build can be triggered.

2. **Restore `ios.privacyManifests`** in `app.json` with the previously confirmed entries:
   ```json
   "privacyManifests": {
     "NSPrivacyAccessedAPITypes": [
       { "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryUserDefaults",
         "NSPrivacyAccessedAPITypeReasons": ["CA92.1"] },
       { "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryFileTimestamp",
         "NSPrivacyAccessedAPITypeReasons": ["C617.1"] }
     ]
   }
   ```

3. **Restore `microphonePermission: false`** in the expo-camera plugin config:
   ```json
   ["expo-camera", { "cameraPermission": "...", "microphonePermission": false }]
   ```

4. **Restore missing ios values** in `app.json`:
   - `"buildNumber": "1"` (or verify App Store Connect history and set appropriately)
   - `"supportsTablet": false`
   - `"deploymentTarget": "16.0"`
   - `"infoPlist": { "NSCameraUsageDescription": "...", "ITSAppUsesNonExemptEncryption": false }`

5. **Verify EAS iOS credentials** (`eas credentials -p ios`) — distribution cert + provisioning profile status.

6. **Verify App Store Connect bundle ID** `com.kscanai.app` exists and build number history before uploading.

7. **Add preview profile iOS section** if an iOS TestFlight smoke build from the preview profile is desired.

8. **Complete App Privacy Details** in App Store Connect — at minimum: Email Address (linked), User ID (linked), Photos and Videos (linked, app functionality, third-party processor: Render/Gemini), User Content if StyleChat is enabled.

9. **Run `expo prebuild` locally** (without submitting) to verify `Info.plist` content — specifically confirm no `NSMicrophoneUsageDescription` appears after restoring `microphonePermission: false`.

10. **Manual TestFlight smoke test** on physical iPhone covering: camera permission prompt, scan flow, account deletion flow, no microphone/ATT/location dialogs, session persistence, sign-in/sign-out.

---

## Files Inspected

| File | Purpose |
|---|---|
| `app.json` | Expo/iOS config, bundle ID, permissions, plugins |
| `eas.json` | EAS build profiles, iOS signing config, env vars |
| `package.json` | Dependencies, scripts |
| `app/_layout.tsx` | Root layout, auth gate, provider order |
| `app/index.tsx` | Home screen — feature entry points |
| `app/auth/index.tsx` | Auth screen — email/password, sign-in/sign-up |
| `app/privacy.tsx` | Privacy screen — deletion flow, preferences |
| `app/library.tsx` | Style library screen |
| `app/scan/index.tsx` | Scan screen (re-exports root app.js) |
| `app/api/analyze+api.js` | Expo Route Handler — Gemini image analysis (server-side) |
| `contexts/AuthSessionContext.tsx` | Auth session management |
| `services/accountDeletion.js` | Edge Function invocation for deletion |
| `services/supabasePrivacy.js` | Supabase privacy/data request helpers |
| `services/supabaseClient.ts` | Supabase client config (AsyncStorage, anon key) |
| `services/authConfig.js` | Auth callback URL |
| `services/api.js` | Backend scan API client |
| `services/imageUtils.js` | Image compression for upload |
| `supabase/functions/handle-user-deletion/index.ts` | Account deletion Edge Function |
| `docs/privacy-data-management.md` | Internal privacy architecture notes |
| `kscan-presubmission-audit.md` | Website/compliance presubmission audit (2026-06-09) |
| `qa/ios-release-candidate-audit-2026-06-09.md` | Prior iOS audit being reconciled |
| `C:\Users\jsmit\kscan-website\app\legal\delete-account\page.tsx` | Website delete-account page |
| `C:\Users\jsmit\kscan-website\app\legal\privacy\page.tsx` | Website privacy policy |

---

*End of K Scan AI iOS App Store Readiness Audit v2 — 2026-06-10*
*Audit conducted by: Senior iOS App Store Readiness Auditor / React Native Release Engineer / Privacy Compliance Reviewer*
*No code was modified. No credentials were created or changed. No builds were triggered. No iOS simulator or Android emulator was run.*
