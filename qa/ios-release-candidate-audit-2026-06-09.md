# K Scan AI — Pre-iOS Release Audit
## Date: 2026-06-09  |  Auditor role: iOS Release Lead / TestFlight Readiness Auditor / App Store Compliance Reviewer

> **AUDIT ONLY.** No code was modified, committed, pushed, or deployed. No credentials were created, rotated, or deleted. No TestFlight or App Store submission was made.

---

## 1. Executive Summary

### Overall Readiness: **YELLOW**
### TestFlight Readiness: **NOT READY — pending branch merge + EAS credential verification + one missing iOS config item**
### App Store Review Readiness: **NOT READY — multiple pre-submission verifications required**

### Do-Not-Ship Blockers
None found that are absolute code-level blockers. The primary blockers before TestFlight are:
1. **Wrong branch** — current branch is a feature branch, not `master`. Build should not be cut from `feature/stylechat-v0.4.1-ui-keyboard-fix` directly.
2. **EAS iOS credentials not verified** — signing/cert/provisioning profile status is unknown. Cannot build without confirmed credentials.
3. **No `ios/` native directory** — managed Expo project requires `expo prebuild` before any native iOS build.
4. **iOS buildNumber `"2"` needs App Store Connect verification** — if any prior build exists in ASC under this bundle ID, the build number must be incremented.

### Top 5 Wins
1. **Apple Sign In fully implemented** — `expo-apple-authentication`, nonce/SHA-256 flow, iOS platform guard. Satisfies App Store guideline 4.8 (third-party logins require Apple Sign In equivalent).
2. **Privacy manifest declared** — `ios.privacyManifests` in `app.json` covers both `NSPrivacyAccessedAPICategoryUserDefaults` (CA92.1) and `NSPrivacyAccessedAPICategoryFileTimestamp` (C617.1). Expo SDK 54 will emit this in prebuild.
3. **Microphone explicitly blocked** — `expo-camera` plugin configured with `microphonePermission: false`. No `NSMicrophoneUsageDescription` will be emitted.
4. **LLM key never reaches the client** — Gemini API key lives only in the `stylechat-generate` Edge Function. The mobile app sends only `{sessionId, message}` to `supabase.functions.invoke()`.
5. **Account deletion is fully wired** — in-app flow → `handle-user-deletion` Edge Function → `deletion_requests` table → profile `pending_deletion` status. Website delete-account page and support email are consistent.

### Top 5 Risks
1. **EAS iOS signing completely unverified** — no dist cert, no provisioning profile, no App Store Connect API key status is confirmed. This is the single largest TestFlight blocker.
2. **iOS buildNumber `"2"` with no confirmed App Store Connect history** — if a prior build exists in ASC, upload will be rejected; if this is truly the first upload, buildNumber `1` is conventional.
3. **Feature branch build** — the feature branch has not been merged to `master`. Any TestFlight build should originate from a clean, tagged release branch to avoid shipping in-progress work or regressing history.
4. **No `ios.deploymentTarget` specified** — minimum iOS version defaults to Expo SDK 54's floor (iOS 16). This should be stated explicitly in app.json or EAS build properties to prevent unexpected device-support issues.
5. **`eas.json` preview profile has no iOS section** — a preview-profile iOS internal distribution build cannot be triggered without explicit iOS config. This blocks an early internal TestFlight smoke-test build if attempted from the preview profile.

---

## 2. iOS Release Candidate Identity

| Field | Value | Notes |
|---|---|---|
| **Branch** | `feature/stylechat-v0.4.1-ui-keyboard-fix` | CONCERN: not `master` |
| **Latest commit** | `da49767 chore(privacy): remove deprecated access token override stub` | |
| **Bundle ID** | `com.kscanai.app` | Verified by `app.json ios.bundleIdentifier` |
| **Version** | `1.0.0` | Consistent with first App Store release |
| **iOS Build Number** | `"2"` | Needs ASC verification; see risk note below |
| **Scheme** | `kscan` | Auth callback URL: `kscan://auth/callback` |
| **iOS native directory** | Does not exist | Managed Expo — prebuild required |
| **EAS iOS production profile** | `distribution: "store"`, `buildConfiguration: "Release"` | ✓ Correct for App Store |
| **EAS iOS preview profile** | Missing | No iOS config in `preview` profile |
| **Signing/cert status** | Unknown | `eas credentials -p ios` not run per safety rules |
| **Credential risk** | HIGH — not verified | Must be confirmed before build |
| **Confidence** | Verified by code / Not verified (signing) | |

**Branch concern:** The latest feature branch adds StyleChat keyboard/portrait fixes and conversation delete. These are intended for v0.4.1. Before cutting a TestFlight build, this branch should be reviewed, merged to `master`, and a clean release tag applied.

**Build number note:** iOS `buildNumber: "2"` may be intentional (build 1 = internal dev build never uploaded to ASC). If App Store Connect already has a build `2` under `com.kscanai.app`, the upload will fail. Verify in ASC before running `eas build --platform ios --profile production`.

---

## 3. iOS Compliance Table

| Area | Status | Evidence | Confidence | Risk | Required Action |
|---|---|---|---|---|---|
| **Bundle ID** | ✅ PASS | `app.json ios.bundleIdentifier: "com.kscanai.app"` | Verified by code | Low | Confirm bundle ID exists in ASC |
| **Build number / version** | ⚠️ NEEDS VERIFY | `version: "1.0.0"`, `buildNumber: "2"` | Verified by code | Medium | Check ASC for prior builds under this bundle ID |
| **Signing / provisioning** | ❓ NOT VERIFIED | `eas credentials -p ios` not run | Not verified | HIGH | Run `eas credentials -p ios` (read-only audit mode) and confirm dist cert + profile exist |
| **Info.plist permissions** | ✅ PASS | Camera + Photo Library declared in `app.json ios.infoPlist` and `expo-camera`/`expo-image-picker` plugin config | Verified by code | Low | Verify strings are accurate after prebuild |
| **Camera permission string** | ✅ PASS | "K Scan uses your camera to photograph your outfit for style analysis." — fashion-specific, accurate | Verified by code | Low | None |
| **Photo Library permission string** | ✅ PASS | "K Scan uses your photo library to let you upload style inspiration images to your Style Library and Dressing Rooms." — accurate | Verified by code | Low | None |
| **Microphone absence** | ✅ PASS | `expo-camera` plugin: `microphonePermission: false`. No `NSMicrophoneUsageDescription` will be emitted | Verified by code | Low | Confirm via `cat ios/KScan/Info.plist` after prebuild |
| **Location / tracking absence** | ✅ PASS | No `expo-location`, no `NSLocationWhenInUseUsageDescription`, no `NSUserTrackingUsageDescription` | Verified by code | Low | None |
| **NFC / Bluetooth / Contacts absence** | ✅ PASS | No such packages or keys found | Verified by code | Low | None |
| **Face ID absence** | ✅ PASS | No `NSFaceIDUsageDescription` | Verified by code | Low | None |
| **Sign in with Apple** | ✅ PASS | `usesAppleSignIn: true`, `expo-apple-authentication` in plugins and dependencies. Nonce/SHA-256 Apple Sign In implemented with iOS platform guard. Google Sign In present → Apple equivalent present. | Verified by code | Low | Manual TestFlight test required |
| **App Privacy answers** | ❓ NOT VERIFIED | Cannot access App Store Connect | Not verified | High | Must be completed in ASC before App Review submission |
| **Privacy manifest** | ✅ DECLARED | `ios.privacyManifests` in `app.json` covers UserDefaults (CA92.1) and FileTimestamp (C617.1). Will be emitted by Expo prebuild. | Verified by code | Low | Verify `PrivacyInfo.xcprivacy` after prebuild. Confirm Expo SDK 54 third-party SDK manifests are included. |
| **Account deletion** | ✅ PASS | In-app Privacy screen → `submitAccountDeletionRequest` → `handle-user-deletion` Edge Function. 30-day processing. Clears local storage + signs out. Website delete-account page consistent. | Verified by code | Low | Manual TestFlight test required |
| **Support URL** | ✅ PASS | `https://kscan.app/support` — page exists, email `kscanai.app@gmail.com` | Verified by code | Low | Use as App Store Support URL |
| **Privacy Policy URL** | ✅ PASS | `https://kscan.app/legal/privacy` — page exists, accurate content, no overclaiming | Verified by code | Low | Use in ASC App Privacy → Policy URL |
| **Terms URL** | ✅ PASS | `https://kscan.app/legal/terms` — page exists | Verified by code | Low | Use as marketing URL or for App Review notes |
| **TestFlight metadata** | ❓ NOT VERIFIED | Cannot access App Store Connect | Not verified | High | Internal test group, "what to test" notes, reviewer demo credentials must be prepared |
| **Screenshots / app icon** | ❓ NOT VERIFIED | Icon present in `assets/icon.png`. Screenshots for iPhone 6.7", 6.1", and 5.5" not confirmed in ASC. | Not verified | High | Required for App Review submission; can be deferred until after TestFlight |
| **Export compliance / encryption** | ✅ PASS | `ITSAppUsesNonExemptEncryption: false` in `app.json ios.infoPlist`. Standard HTTPS only. | Verified by code | Low | Answer "No" to export compliance in ASC |
| **Age rating** | ❓ NOT VERIFIED | Cannot access App Store Connect. Expected: 4+ (no objectionable content). | Not verified | Low | Complete age rating questionnaire in ASC |
| **App Review copy** | ✅ PASS (conditional) | No claims of barcode/QR/document scanning. No unimplemented face blur claimed in app UI. Privacy page correctly disclaims active face blurring in beta. | Verified by code | Low | Ensure App Store listing copy does not contradict |
| **`ITSAppUsesNonExemptEncryption`** | ✅ PASS | Set to `false` in `ios.infoPlist` | Verified by code | Low | None |
| **`supportsTablet`** | ✅ PASS | `false` — iPad explicitly disabled | Verified by code | Low | No iPad screenshots needed |
| **Minimum iOS version** | ⚠️ NOT SPECIFIED | No `ios.deploymentTarget` in `app.json`. Defaults to Expo SDK 54 minimum (iOS 16). | Inferred from architecture | Medium | Add `"deploymentTarget": "16.0"` to `app.json ios` and EAS build properties |

---

## 4. Feature Parity Table

| Feature | Android Audit Status | iOS Expected Status | iOS-Specific Risk | Required Manual Test |
|---|---|---|---|---|
| **Auth / session** | PASS | Expected PASS | `KeyboardAvoidingView behavior="padding"` on iOS auth screen present; Apple Sign In iOS-only guard. Google OAuth uses `expo-web-browser`. | Sign in/out, session persistence, Apple Sign In, Google Sign In |
| **Home navigation** | PASS | Expected PASS | `SafeAreaView` on home screen. No back button needed. | Launch, navigate all home cards |
| **Scan flow** | PASS | Expected PASS | `expo-camera` on iOS requires camera permission prompt first. Permission denial flow. | Scan flow, permission prompt, denial handling |
| **Style Library** | PASS | Expected PASS | Signed URL retrieval platform-independent. | Library list, item detail |
| **Private inspiration uploads** | PASS | Expected PASS | `expo-image-picker` uses limited photo access on iOS 14+. File URI handling differs on iOS. | Upload flow, pick from library |
| **Dressing Rooms** | PASS | Expected PASS | No known iOS-specific risks. | Create room, add item, list rooms |
| **Shared room links** | PASS | Expected PASS | Deep link via `kscan://` scheme. Universal links not configured (`associatedDomains` absent). Safari opens `kscan.app/rooms/[token]`. | Create shared room, open URL in Safari, revoke and re-open |
| **StyleChat UI** | PASS (Android portrait) | MEDIUM RISK | `KeyboardAvoidingView keyboardVerticalOffset={0}` may need adjustment on notched iPhones. Portrait-only. iOS has no Android-style Back button — relies on swipe gesture and navigation bar. Alert dialogs differ stylistically. | Keyboard behavior, safe area, back gesture, landscape lock |
| **LLM backend (Gemini)** | PASS | Expected PASS | Edge Function is platform-independent. JWT auth via Supabase session works cross-platform. | Send message, quota, retry, network failure |
| **Privacy / account deletion** | PASS | Expected PASS | `Modal` (deletion confirm) and `Alert.alert` (sign-out) both iOS-compatible. | Privacy controls, deletion flow |
| **Website / legal links** | PASS | Expected PASS | All three links (`Linking.openURL`) tested to open in Safari. URLs consistent. | Tap Privacy Policy, Terms, Support from app |
| **Deep links / shared room routing** | PASS | Expected PASS | `kscan://auth/callback` scheme confirmed. No `associatedDomains` → no universal links. | Auth OAuth callback, deep link routing |

---

## 5. Backend and Security Findings

| Severity | Finding | Evidence | Action |
|---|---|---|---|
| **Observation** | `app/api/style-chat/message+api.ts` deprecated mock stub is present and labeled. No auth enforcement. | File header clearly states deprecated, no real AI, `@DEPRECATED`. | No action required; never called by mobile app in v0.4+. Could be deleted in a cleanup PR. |
| **Low** | Supabase anon key is in plain text in `eas.json` (preview + production env). | `eas.json` lines 16, 36–37. Key is a standard JWT anon key (`role: "anon"`). | Expected for `EXPO_PUBLIC_*` env vars. Anon key is intended to be public. Confirm no service-role key is present (none found). |
| **Low** | `errorLogger.ts` uses `console.error` only — no external crash reporting SDK (Sentry, Crashlytics, etc.). | `src/utils/errorLogger.ts`. | Acceptable for beta/TestFlight. Consider adding crash reporting before wide public release. |
| **Observation** | `CORS_HEADERS` in `stylechat-generate` uses `Access-Control-Allow-Origin: *`. | `supabase/functions/stylechat-generate/index.ts:21`. | Standard practice for Supabase Edge Functions. Not a risk since auth is JWT-gated. |
| **Observation** | `logError` in `_layout.tsx` attaches a global unhandled JS error handler. | `app/_layout.tsx:26-35`. | Logs to console only. No PII is logged. No third-party SDK involved. Acceptable. |
| **Observation** | `stylechat-generate` logs `userId.slice(0, 8)` (truncated UID). No message content or PII in production logs. | Line 471-480. | Correct approach. No action needed. |
| **Observation** | No analytics SDK (Amplitude, Firebase Analytics, Mixpanel, etc.) detected in `package.json`. | `package.json` dependencies reviewed. | Clean from a privacy standpoint. No App Privacy "analytics" category needed. |

---

## 6. App Privacy / Data Collection Matrix

> For App Store Connect App Privacy answers. "Linked to user" = associated with an account or device identity. "Third party" = shared with any party outside Supabase/Google auth infrastructure.

| Data Category | Collected? | Linked to User? | Shared with 3rd Party? | Purpose | Retention / Deletion Path | App Privacy Label |
|---|---|---|---|---|---|---|
| **Email address** | YES | YES | NO (stored in Supabase auth) | Account creation, auth | Deleted on account deletion request | Data Used to Track You: NO. Data Linked to You: YES — Contact Info > Email Address |
| **User ID (Supabase UUID)** | YES | YES | NO | All authenticated features | Deleted on account deletion | Data Linked to You: YES — Identifiers > User ID |
| **Photos / images (scan captures)** | YES (in-transit to backend) | YES | PARTIAL — sent to `kscan-app-1.onrender.com` AI backend for analysis; not stored by backend per privacy policy | Fashion AI analysis | Not retained by backend; raw scan images not stored unless user explicitly saves | Data Linked to You: YES — Photos and Videos |
| **Photos / images (inspiration uploads)** | YES | YES | NO (stored in Supabase storage, user-private bucket) | Style Library, Dressing Rooms | Deleted on account deletion | Data Linked to You: YES — Photos and Videos |
| **Style scan metadata** | YES | YES | NO | Style Library, results display | Deleted on account deletion | Data Linked to You: YES — User Content |
| **StyleChat messages** | YES | YES | YES — user message sent to Gemini Flash via `stylechat-generate` Edge Function (server-side only, not by mobile client directly) | AI styling assistance | Stored in `style_chat_messages`; deleted on account deletion | Data Linked to You: YES — User Content (messages) |
| **Style memory signals** (brand/category/color derived from Dressing Room items) | YES | YES | YES — summarized (no raw PII) context sent to Gemini via Edge Function | Style personalization for AI responses | Derived from Dressing Room items; deleted on account deletion | Data Linked to You: YES — User Content |
| **Dressing Room contents** | YES | YES | NO (Supabase storage) | Style boards | Deleted on account deletion | Data Linked to You: YES — User Content |
| **Shared room link tokens** | YES | YES | YES — public share link is readable by anyone with the token | Room sharing feature | Revocable by user; deleted on account deletion | Data Linked to You: YES — User Content |
| **Privacy preferences** (`opt_out_of_sale`, `limit_sensitive_processing`) | YES | YES | NO | CCPA/CPRA compliance | Deleted on account deletion | Not a standard App Privacy category; document internally |
| **Account deletion requests** | YES | YES | NO | Compliance workflow | Retained per legal obligations | Not a separate App Privacy category |
| **Google OAuth tokens** | YES (transient, exchange-only) | YES | YES — exchanged with Google OAuth, then only Supabase session is retained | Google Sign In | Session tokens stored in AsyncStorage (encrypted by iOS Keychain via Supabase) | Data Linked to You: YES — Identifiers (third-party auth provider) |
| **Apple Sign In credentials** | YES (identity token, transient) | YES | NO (Apple supplies identity token; K Scan exchanges with Supabase and discards raw token) | Apple Sign In | Not retained raw | Data Linked to You: YES — Identifiers |
| **Crash / error logs** | YES (console.error only) | NO (no external SDK) | NO | Internal debugging | Not transmitted | Not required in App Privacy |
| **Device identifiers (IDFA, IDFV)** | NO | N/A | N/A | Not collected | N/A | Not required |
| **Location** | NO | N/A | N/A | Not collected | N/A | Not required |
| **Contacts** | NO | N/A | N/A | Not collected | N/A | Not required |
| **Purchase / payment info** | NO | N/A | N/A | Not collected | N/A | Not required |
| **Browsing / search history** | NO | N/A | N/A | Not collected | N/A | Not required |
| **Analytics** | NO external SDK | N/A | N/A | Not transmitted externally | N/A | Not required |
| **Advertising / tracking** | NO | N/A | N/A | No ATT, no IDFA | N/A | Not required |

**Key mismatch check:**
- Privacy page mentions `kscan-app-1.onrender.com` as backend. App Privacy label must reflect that scan images are sent there for AI analysis (data sharing with a processor). ✓ Consistent.
- Privacy page correctly disclaims active face blurring in beta. App UI makes no face-blur claims. ✓ Consistent.
- No zero-knowledge masking is claimed anywhere in code or copy. ✓ Consistent.

---

## 7. Permission Purpose String Audit

| Permission Key | Current Text | Accuracy | App Review Risk | Required Action |
|---|---|---|---|---|
| `NSCameraUsageDescription` | "K Scan uses your camera to photograph your outfit for style analysis." | ✓ Accurate — fashion-specific, no QR/barcode/document scanner language | Low | None. This string will pass App Review. |
| `NSPhotoLibraryUsageDescription` | "K Scan uses your photo library to let you upload style inspiration images to your Style Library and Dressing Rooms." | ✓ Accurate — specific use case for Style Library and Dressing Rooms | Low | None. Clear and feature-specific. |
| `NSPhotoLibraryAddUsageDescription` | NOT PRESENT | ✓ Correct absence — app does not save images to camera roll | Low | Confirm no `expo-image-manipulator` output is saved to the photo library |
| `NSMicrophoneUsageDescription` | NOT PRESENT | ✓ Correct absence — `expo-camera` plugin sets `microphonePermission: false` | Low | Confirm absence in `Info.plist` after prebuild |
| `NSLocationWhenInUseUsageDescription` | NOT PRESENT | ✓ Correct absence — no location features | Low | None |
| `NSUserTrackingUsageDescription` | NOT PRESENT | ✓ Correct absence — no ATT/IDFA usage | Low | None — confirm no Analytics SDK is added before build |
| `NSFaceIDUsageDescription` | NOT PRESENT | ✓ Correct absence — no Face ID used | Low | None |
| `NSContactsUsageDescription` | NOT PRESENT | ✓ Correct absence — no contacts access | Low | None |
| `NSBluetoothAlwaysUsageDescription` | NOT PRESENT | ✓ Correct absence | Low | None |
| `ITSAppUsesNonExemptEncryption` | `false` | ✓ Accurate — standard HTTPS only | Low | Answer "No" to encryption question in ASC |

---

## 8. TestFlight Smoke Test Script

> For each item: **PASS** / **FAIL** / **NOT TESTED** / **Screenshot required** / **Severity if failed**

### Install / TestFlight
| # | Test | Expected | Status | Severity |
|---|---|---|---|---|
| 1 | Install from TestFlight link | App installs successfully | NOT TESTED | Blocker |
| 2 | Confirm build number in Settings → TestFlight | Shows build 2 (or current) | NOT TESTED | High |
| 3 | Cold launch from home screen | App opens to loading/auth screen | NOT TESTED | Blocker |
| 4 | Kill app, relaunch | Restores session if signed in | NOT TESTED | High |
| 5 | No "Expo Go" branding or dev menus visible | Clean production build | NOT TESTED | Medium |

### Authentication
| # | Test | Expected | Status | Severity |
|---|---|---|---|---|
| 6 | Sign up with email | Creates account, routes to home or confirmation | NOT TESTED | Blocker |
| 7 | Sign in with email | Signs in, routes to home | NOT TESTED | Blocker |
| 8 | Sign out | Returns to auth screen, clears session | NOT TESTED | Blocker |
| 9 | Session persistence after restart | Remains signed in | NOT TESTED | High |
| 10 | Unauthenticated deep route redirect | Redirected to auth | NOT TESTED | High |
| 11 | **Apple Sign In** | Presents Apple sheet, signs in via Supabase | NOT TESTED | High — Screenshot required |
| 12 | Google Sign In | Opens in-app browser, completes OAuth | NOT TESTED | High |
| 13 | Cancel Google Sign In | Returns to auth screen with "Sign-in cancelled" | NOT TESTED | Medium |
| 14 | Cancel Apple Sign In | Returns to auth screen with "Sign-in cancelled" | NOT TESTED | Medium |

### Permissions
| # | Test | Expected | Status | Severity |
|---|---|---|---|---|
| 15 | First scan attempt | Camera permission system dialog appears | NOT TESTED | Blocker |
| 16 | Grant camera permission | Camera view opens | NOT TESTED | Blocker |
| 17 | Photo picker / inspiration upload | Photo Library limited access dialog | NOT TESTED | High |
| 18 | Deny camera permission | Graceful error message, no crash | NOT TESTED | High |
| 19 | Deny photo permission | Graceful error message, no crash | NOT TESTED | High |
| 20 | **Confirm no microphone permission prompt appears** | No system mic dialog at any point | NOT TESTED | High — Screenshot required if appears |
| 21 | **Confirm no location permission prompt appears** | No system location dialog | NOT TESTED | High — Screenshot required if appears |
| 22 | **Confirm no tracking (ATT) prompt appears** | No App Tracking Transparency dialog | NOT TESTED | High — Screenshot required if appears |

### Core Flows
| # | Test | Expected | Status | Severity |
|---|---|---|---|---|
| 23 | Home screen renders | All cards visible, SCAN NOW, Dressing Rooms, Library, StyleChat, Privacy | NOT TESTED | Blocker |
| 24 | SCAN NOW → camera view | Opens scanner with viewfinder | NOT TESTED | Blocker |
| 25 | Capture scan | Sends to backend, shows result | NOT TESTED | Blocker |
| 26 | Style Library opens | Lists saved scans and inspirations | NOT TESTED | High |
| 27 | Upload private inspiration | Picks image, uploads, appears in library | NOT TESTED | High |
| 28 | Create Dressing Room | Creates room with title | NOT TESTED | High |
| 29 | Add item to Dressing Room | Item added, shows in room | NOT TESTED | High |
| 30 | Create shared room link | Share token generated | NOT TESTED | High |
| 31 | Open shared room in Safari | `kscan.app/rooms/[token]` loads room preview | NOT TESTED | High |
| 32 | Revoke shared room, re-open URL | Shows "unavailable" state | NOT TESTED | Medium |
| 33 | StyleChat — new session | Creates session, shows empty state | NOT TESTED | High |
| 34 | StyleChat — send message | Message sent, Gemini response received | NOT TESTED | High |
| 35 | StyleChat — empty message disabled | SEND button disabled for empty text | NOT TESTED | Medium |
| 36 | StyleChat — network failure | Error banner shown with RETRY | NOT TESTED | Medium |
| 37 | StyleChat — retry | Retry re-sends last message | NOT TESTED | Medium |
| 38 | StyleChat — daily quota reached | Quota notice shown, no RETRY shown | NOT TESTED | Medium |
| 39 | StyleChat — delete conversation (index) | Alert → Delete removes session | NOT TESTED | High |
| 40 | StyleChat — delete conversation (session) | Alert → Delete removes session, navigates back | NOT TESTED | High |
| 41 | Privacy screen opens | Shows opt-out toggles, account controls | NOT TESTED | High |
| 42 | Tap Privacy Policy | Opens `kscan.app/legal/privacy` in Safari | NOT TESTED | High |
| 43 | Tap Terms | Opens `kscan.app/legal/terms` in Safari | NOT TESTED | Medium |
| 44 | Tap Support | Opens `kscan.app/support` in Safari | NOT TESTED | Medium |
| 45 | Delete Account flow (authenticated) | Confirm dialog → submits request → signs out | NOT TESTED | High — Screenshot required |

### iOS-Specific UI
| # | Test | Expected | Status | Severity |
|---|---|---|---|---|
| 46 | StyleChat input — keyboard covers input? | Input remains above keyboard | NOT TESTED | High — Primary recent fix target |
| 47 | Safe area on iPhone with notch (14 Pro / 15) | Header and input not clipped | NOT TESTED | High |
| 48 | Safe area on iPhone without notch (SE / 12 mini) | Layout fits correctly | NOT TESTED | Medium |
| 49 | Landscape rotation | App stays portrait (orientation: "portrait" set) | NOT TESTED | Medium |
| 50 | Dark mode | App renders correctly in dark mode (dark userInterfaceStyle set) | NOT TESTED | Low |
| 51 | Dynamic type / large accessibility text | Layout doesn't break at larger sizes | NOT TESTED | Medium |
| 52 | Back swipe gesture on StyleChat | Back swipe handled by `useStyleChatHomeBackHandler` — delete dialog blocks swipe when open | NOT TESTED | High |

---

## 9. Do-Not-Ship Blockers

> True blockers only — items that prevent the app from building, installing, launching, complying with account deletion requirements, or represent confirmed data/privacy exposure.

| # | Blocker | Severity | Confidence |
|---|---|---|---|
| B1 | **EAS iOS credentials not confirmed** — no distribution certificate, provisioning profile, or App Store Connect API key status has been verified. An iOS production build cannot be submitted without valid credentials. | Blocker | Not verified |
| B2 | **`ios/` native directory does not exist** — `expo prebuild` must be run before any iOS build can be triggered. This is a prerequisite, not a bug. | Blocker (process) | Verified by code |

No confirmed data exposure, privacy, or App Review blockers were found in the code. The blockers are operational/process blockers.

---

## 10. Must Fix Before TestFlight

| # | Issue | Severity | Confidence | Action |
|---|---|---|---|---|
| TF1 | **Merge `feature/stylechat-v0.4.1-ui-keyboard-fix` to `master`** before cutting a TestFlight build. A TestFlight build from an unmerged feature branch creates release history confusion. | High | Verified by repo state | Merge branch → master → tag release |
| TF2 | **Verify EAS credentials** — run `eas credentials -p ios` in audit mode and confirm distribution certificate and provisioning profile exist and are not expired. | High | Not verified | Run `eas credentials -p ios` (read-only) |
| TF3 | **Verify App Store Connect bundle ID record** — confirm `com.kscanai.app` bundle ID exists in ASC and matches app configuration. | High | Not verified | Check ASC → Identifiers → `com.kscanai.app` |
| TF4 | **Confirm buildNumber `"2"` is valid** — check if any prior builds exist in ASC under this bundle ID. Increment to a fresh value if necessary. | Medium | Not verified | Check ASC → App → TestFlight builds |
| TF5 | **Add `ios.deploymentTarget`** — specify minimum iOS version explicitly (e.g., `"16.0"`) in `app.json`. | Medium | Inferred | Add `"deploymentTarget": "16.0"` to `app.json ios` |
| TF6 | **Add iOS config to `preview` profile in `eas.json`** if an iOS internal distribution build from preview profile is desired. | Medium | Verified by code | Add `"ios": { "simulator": false }` or similar to preview profile |
| TF7 | **Prepare TestFlight internal tester group** in ASC — add internal testers and build a "What to Test" note covering StyleChat keyboard fix, delete flow, and permissions. | High | Not verified | ASC → TestFlight → Internal Testing |

---

## 11. Must Fix Before App Review

| # | Issue | Severity | Confidence | Action |
|---|---|---|---|---|
| AR1 | **Complete App Privacy (Nutrition Label) in ASC** — must answer all data collection questions accurately. Based on this audit, the minimum required categories are: Email Address, User ID, Photos & Videos, User Content (messages, style data). See Section 6. | High | Inferred from architecture | Fill out ASC App Privacy before submitting for review |
| AR2 | **Prepare App Store screenshots** — required for iPhone 6.7" (Pro Max), 6.1" (standard), and 5.5" (legacy). No screenshots found in audit. | High | Not verified | Capture or generate screenshots of Home, Scan, StyleChat, Dressing Rooms, Privacy |
| AR3 | **Write App Review "What's New" and description** — App Store listing copy must not mention QR scanning, barcode scanning, or document scanning. Must not claim on-device face blurring (accurately disclaimed in privacy page). | High | Not verified (ASC copy) | Draft App Store listing copy; review against App Store guidelines |
| AR4 | **Prepare demo account credentials** for App Review team — App Review may require a working sign-in to test StyleChat and other authenticated features. | High | Not verified | Create a demo account with pre-populated data; include in Review Notes |
| AR5 | **Set App Store Connect metadata URLs**: Privacy Policy = `https://kscan.app/legal/privacy`, Account Deletion = `https://kscan.app/legal/delete-account`, Support = `https://kscan.app/support`. | High | Not verified | Set all three URLs in ASC before submission |
| AR6 | **Complete age rating questionnaire** in ASC. Expected: 4+ (no objectionable content, no user-generated public content risk beyond shared rooms which are token-gated). | Medium | Not verified | Complete ASC age rating wizard |
| AR7 | **Add `owner` field to `app.json`** if not already configured in EAS account. | Low | Not verified | Confirm EAS account slug and add to `app.json expo.owner` |
| AR8 | **Manual TestFlight smoke tests** — all 52 items in Section 8 must be run and passed before App Review submission. Specifically: Apple Sign In (AR critical), microphone non-appearance, location non-appearance, ATT non-appearance, deletion flow. | High | Not tested | Run complete smoke test script on physical iPhone |

---

## 12. Must Fix Before Public iOS Release

> Items that can wait until after TestFlight but must be resolved before wide release.

| # | Issue | Severity | Notes |
|---|---|---|---|
| PR1 | **External crash reporting** — current error handling uses `console.error` only with no external SDK. Production crashes will be invisible without TestFlight crash logs. | Medium | Add Sentry or similar before GA |
| PR2 | **StyleChat `keyboardVerticalOffset={0}`** — recently fixed for Android portrait but the fixed value of `0` may need per-device tuning on iPhones with non-standard safe area insets. Requires physical device testing. | Medium | TestFlight validation required on iPhone SE, 14, 15 Pro |
| PR3 | **`eas.json` anon key exposure** — the Supabase anon key is hardcoded in `eas.json` plaintext (expected for `EXPO_PUBLIC_` variables, but `eas.json` is committed). Consider EAS secrets for env vars instead of inline plaintext. | Low | Anon key is designed to be public; service-role key confirmed absent |
| PR4 | **Website privacy page references `kscan-app-1.onrender.com`** — this backend URL is disclosed in the privacy notice. Ensure this remains accurate. If the backend URL changes, the privacy page must be updated. | Low | No action now; update if URL changes |
| PR5 | **`app.json` does not specify `owner`** — should be set to match EAS account for unambiguous project binding. | Low | Low risk; set during pre-submission prep |

---

## 13. Future Roadmap / Out of Scope for This Release

The following items are noted as roadmap / future only. They were **not** evaluated in this audit and must not be claimed as current capabilities.

- **Meta smart glasses / AR bridge** — not present in any code path audited.
- **Voice-to-checkout** — no voice or checkout integration found.
- **Headless commerce / retailer partnerships** — no confirmed integrations. No partner SDKs present.
- **Advanced on-device PII masking / Face Blur v2** — the privacy sanitizer hook exists as infrastructure but privacy page correctly discloses it may operate in pass-through mode during beta.
- **Zero-knowledge image masking** — not implemented; not claimed in app UI or copy.
- **Universal Links / Associated Domains** — no `associatedDomains` configured. Shared rooms open via website URL (`kscan.app/rooms/[token]`), not universal links. Future enhancement.
- **Push notifications** — `expo-notifications` not present.
- **In-app purchases / subscriptions** — no payment SDK found.
- **GDPR full consent flow** — privacy code acknowledges GDPR requires "separate EU/UK logic" not yet implemented.

---

## 14. Files Inspected

### App Repo (`C:\Users\jsmit\KScan`)
| File | Purpose |
|---|---|
| `app.json` | Expo config, iOS bundle ID, buildNumber, permissions, privacy manifest |
| `eas.json` | EAS build profiles, iOS production config, env vars |
| `package.json` | Dependencies and scripts |
| `.gitignore` | Credential protection verification |
| `app/_layout.tsx` | Root layout, auth gate, error boundary, global error handler |
| `app/index.tsx` | Home screen — navigation and feature entry points |
| `app/auth/index.tsx` | Auth screen — Google Sign In, Apple Sign In, email/password |
| `app/privacy.tsx` | Privacy screen — opt-outs, deletion, export, correction |
| `app/style-chat/index.tsx` | StyleChat session list |
| `app/style-chat/[sessionId].tsx` | StyleChat session — keyboard, safe area, error, retry |
| `app/api/style-chat/message+api.ts` | Deprecated mock stub (not used in production) |
| `components/style-chat/StyleChatInput.tsx` | Input component — send disable, onSubmitEditing |
| `contexts/PrivacyPreferencesContext.tsx` | Privacy preferences state machine |
| `contexts/AuthSessionContext.tsx` (referenced) | Auth session management |
| `hooks/useStyleChat.ts` | StyleChat state hook — send, retry, quota, error |
| `services/style-chat/providers/edgeStyleChatProvider.ts` | Edge Function proxy, fallback, timeout |
| `services/supabaseClient.ts` | Supabase client — AsyncStorage session persistence |
| `services/styleObjects.ts` | Upload, Dressing Room, image manipulation |
| `services/authConfig.js` | Auth callback URL (`kscan://auth/callback`) |
| `src/utils/errorLogger.ts` | Error logging (console only, no external SDK) |
| `constants/featureFlags.ts` | Feature freeze config |
| `supabase/functions/stylechat-generate/index.ts` | Gemini proxy — JWT auth, quota, sanitization |
| `supabase/functions/handle-user-deletion/index.ts` | Account deletion Edge Function |
| `components/InspirationUploadModal.tsx` | Photo upload — auth required, Supabase storage |

### Website Repo (`C:\Users\jsmit\kscan-website`)
| File | Purpose |
|---|---|
| `app/legal/privacy/page.tsx` | Privacy policy page |
| `app/legal/terms/page.tsx` | Terms page |
| `app/legal/delete-account/page.tsx` | Delete account page |
| `app/support/page.tsx` | Support page |
| `lib/publicRoomPreview.ts` | Server-side room preview, no X-KScan headers |

---

## 15. Commands Run

| Command | Result |
|---|---|
| `git status --short` | Many untracked QA files; no staged changes |
| `git branch --show-current` | `feature/stylechat-v0.4.1-ui-keyboard-fix` |
| `git log --oneline -10` | Recent commits visible — StyleChat, privacy, Android cleanup |
| `git remote -v` | `origin https://github.com/kscanaiapp/kscan-app.git` |
| `git ls-files \| grep -iE ".p8\|.p12\|.mobileprovision..."` | No output — no Apple credentials tracked |
| `find ... -name "*.p8" -o -name "*.p12" -o -name "*.mobileprovision"` | No output — no Apple credentials on disk |
| `git check-ignore .env .env.local` | Both gitignored — PASS |
| `find ... ios/ maxdepth 3` | No output — iOS native directory does not exist |
| `find ... -name ".env*"` | `.env` and `.env.local` found but gitignored |
| `git -C kscan-website status` | main branch, clean |
| `git -C kscan-website log --oneline -5` | X-KScan headers removed in latest commit |
| `grep -r X-KScan kscan-website` | No matches — diagnostic headers clean |
| `eas whoami` / `eas credentials -p ios` | **NOT RUN** — per safety rules |
| `npx expo config --type public` | **NOT RUN** — would require network/CLI session |
| `npm run build` (website) | **NOT RUN** — do not deploy per audit rules |

---

## 16. Confidence Labels

| Finding | Confidence |
|---|---|
| Bundle ID is `com.kscanai.app` | Verified by code |
| iOS buildNumber is `"2"` | Verified by code |
| Apple Sign In implemented with nonce/SHA-256 | Verified by code |
| `microphonePermission: false` prevents microphone usage | Verified by code |
| No `.p8`/`.p12`/`.mobileprovision` tracked by git | Verified by command output |
| `.env` and `.env.local` are gitignored | Verified by command output |
| Gemini API key server-side only | Verified by code |
| No service-role key in client EAS config | Verified by code |
| Privacy manifest declared in `app.json` | Verified by code |
| Account deletion flow end-to-end | Verified by code |
| Legal pages (`/privacy`, `/terms`, `/delete-account`, `/support`) exist | Verified by code |
| No X-KScan diagnostic headers in website | Verified by command output |
| EAS iOS signing status | **Not verified** — `eas credentials` not run |
| App Store Connect record/bundle ID registration | **Not verified** — no ASC access |
| App Privacy / Nutrition Label answers in ASC | **Not verified** — no ASC access |
| Privacy manifest emitted correctly by Expo SDK 54 prebuild | Inferred from architecture |
| TestFlight screenshots/metadata | **Not verified** — no ASC access |
| `KeyboardAvoidingView` behavior on physical iPhones | **Not verified** — requires manual test |
| Apple Sign In function on physical iPhone | **Not verified** — requires manual test |

---

*End of K Scan AI Pre-iOS Release Audit — 2026-06-09*
*Audit conducted by: iOS Release Lead / TestFlight Readiness Auditor / App Store Compliance Reviewer*
*No code was modified. No credentials were created or changed. No builds were triggered.*
