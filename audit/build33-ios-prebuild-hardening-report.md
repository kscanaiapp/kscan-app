# Build 33 — iOS App Store Pre-Build Hardening Report

**Scope:** iOS only. Pre-build only. No EAS build was run, nothing was submitted to Apple,
and no production backend was mutated.

| | |
|---|---|
| Repository | `kscanaiapp/kscan-app` |
| Worktree | `C:\src\KScan-build33-ios-hardening` |
| Branch | `release/ios-build33-app-review-hardening` |
| Starting SHA (Build 32 authority) | `5b68cd4e6ecf0601a8b5f6df20b7468c2106771b` |
| Ending SHA (last code change) | `271f50f2ac15ad92d106b8276e8701c2f8778ad1` |
| Branch tip | this report commit — **docs-only**, no product code |
| Version | 1.0.1 (unchanged) |
| Current remote iOS build | **32** |
| Expected next build | **33** |
| Bundle ID | `com.kscanai.app` |
| Production Supabase | `wyyuqfdxucjksghsmhry` (ACTIVE_HEALTHY) |
| Report date | 2026-08-28 |

---

## 1. Executive summary

Apple rejected Build 32 with **ITMS-90118**, an App Store Connect configuration error: a
Routing App Coverage File was attached to an app whose binary does not declare itself a
routing app. The Build 32 **binary was clean**. The fix is to remove that file in App Store
Connect — an owner action that no source change can perform.

What this pass found, and what makes it worth more than a resubmit: the repository was the
source of the mistake. It shipped `assets/routing-app-coverage.geojson` together with
`docs/routing-app-coverage.md`, which instructed the release owner to upload that file to
App Store Connect as a "proactive compliance measure." That advice is wrong — the coverage
file is reserved for turn-by-turn navigation apps — and it would have caused the owner to
re-attach the file on the next submission and reproduce the identical rejection. Build 33
removes the asset and replaces the document with a prohibition, guarded by a test.

Alongside that, three narrow preventive items were applied: unused Always-location purpose
strings are suppressed, unfinished "Coming Soon" surfaces (Voice Scan, Microphone,
Notifications) are removed from the screens App Review sees first, and the three Expo SDK 54
patch drifts are aligned.

**What Build 33 deliberately does NOT change:** Android (untouched), the marketing version,
bundle ID, signing, Apple team, production Supabase project, React Native 0.81.5, the Expo
SDK minor, the React Native architecture, iPad support, the privacy manifest, production
feature flags, scanner/commerce/Elise architecture, and the microphone posture (still
disabled). No routing capability was added. `store.config.json` was intentionally not edited.

**Verdict: READY FOR OWNER TO RUN iOS EAS BUILD** — with three owner actions required in
App Store Connect before submission (§21), of which the routing-file removal is mandatory.

---

## 2. Exact Build 32 source authority

`convergence/build29-ios-release-candidate` resolved to
`5b68cd4e6ecf0601a8b5f6df20b7468c2106771b` both locally and on `origin` — verified before any
work began. A fresh linked worktree was created directly from that SHA on a new branch. The
starting tree was clean, with no stray tracked or untracked product files, and no `.env`
present (which avoids the known environment artifact that makes a Supabase-authority test
fail spuriously).

Git identity was confirmed as `justin.landes@gmail.com` / `Justin Smith` before committing.

No branch was merged. `master` was not merged. No unrelated PR (#187, #188, #190, #204,
#205, #206) was merged.

---

## 3. Confirmed Apple rejection

```
ITMS-90118: Invalid routing app setting:
To upload a routing app coverage file on App Store Connect,
you must define the app binary as a routing app.
```

This is treated as the **sole confirmed cause** of the Build 32 Invalid Binary rejection.
Apple did not report a microphone (ITMS-90683), Apple Silicon Mac (ITMS-90863), location,
privacy-manifest, signing, entitlement, iPad, Guideline 2.1, or Expo SDK failure. Everything
else in this report is preventive review-risk reduction and is labelled as such.

### Provenance

`docs/routing-app-coverage.md` at the Build 32 SHA contained, verbatim:

> 1. Navigate to **App Store Connect > App Information > Platform Version Information**
> 2. Under **iOS**, click **Routing App Coverage File**
> 3. Upload `assets/routing-app-coverage.geojson`
> 4. Save changes

The asset was referenced by **no code, no configuration, and no build step** — confirmed by
searching the full tracked tree. It existed solely to be uploaded to App Store Connect.

### How it is corrected

There are exactly two ways to clear ITMS-90118, and only the first is correct here:

1. **Remove the Routing App Coverage File from App Store Connect.** ← the fix
2. Declare the binary as a routing app. ← **prohibited**

Adding `MKDirectionsApplicationSupportedModes` or an Apple Maps routing capability to satisfy
the file would misrepresent the product to App Review. K Scan provides no turn-by-turn
navigation; location is foreground-only, for weather-aware styling.

Source-side closure in Build 33:

- `assets/routing-app-coverage.geojson` — **deleted**
- `docs/routing-app-coverage.md` — **rewritten as a prohibition** ("DO NOT UPLOAD"), recording
  the rejection, the correct fix, and a per-submission owner checklist
- `__tests__/routingAppCoverage.test.js` — **new guard** that fails the suite if a routing
  declaration, a `.geojson` coverage asset, or upload instructions reappear

Verified absent from the whole tracked tree (excluding `android/`): `MKDirections`,
`MKDirectionsApplicationSupportedModes`, `com.apple.developer.maps`.

**The App Store Connect removal itself remains an owner action and is NOT verified by this
report.**

---

## 4 & 5. Source changes — every changed file and why

12 files changed, 2 added, 1 deleted. Net **−349 lines**. Four commits.

| # | Commit | Item |
|---|---|---|
| 1 | `5a83616` | GATE 0 — ITMS-90118 recurrence closure |
| 2 | `04de135` | H1 — Always-location suppression |
| 3 | `edc70f3` | H2 — unfinished review surfaces |
| 4 | `271f50f` | H4 — Expo SDK 54 patch alignment |

| File | Δ | Why | Item |
|---|---|---|---|
| `docs/routing-app-coverage.md` | rewritten | Instructed the ASC upload that caused ITMS-90118; now a prohibition | GATE 0 |
| `assets/routing-app-coverage.geojson` | **deleted** | Unreferenced; existed only for the ASC upload | GATE 0 |
| `__tests__/routingAppCoverage.test.js` | **new** | Fails if routing declaration/asset/instructions return | GATE 0 |
| `app.json` | +2 | `locationAlwaysPermission: false`, `locationAlwaysAndWhenInUsePermission: false` | H1 |
| `components/home/HomeLuxuryTechV1.tsx` | −95 | Removed VOICE SCAN / COMING SOON pill (**production Home**) + dead styles/imports | H2 |
| `components/home/HomeV2.tsx` | −63 | Same removal; unrouted, hardened against flag drift | H2 |
| `components/home/HomeLegacy.tsx` | −64 | Same removal; unrouted, hardened against flag drift | H2 |
| `components/account-home/PermissionsStepV1.tsx` | −47 | Removed "Coming Soon" Microphone + Notifications cards, dead badge branch/style, unused mic prop | H2 |
| `app/onboarding/index.tsx` | −2 | Stopped passing `requestMicrophonePermission` into the step | H2 |
| `__tests__/homeEliseIntegration.test.js` | rewritten test | Build 32 asserted the pill must exist; now asserts absence | H2 |
| `__tests__/kscanProductIcons.test.js` | rewritten test | Same contract inversion | H2 |
| `__tests__/phase4AccessibilityContracts.test.js` | rewritten test | Same contract inversion | H2 |
| `__tests__/todayWithEliseHomeMount.test.js` | −1 | Dropped the pill testID from the required-marker list | H2 |
| `__tests__/iosAppReviewSurface.test.js` | **new** | Standing contract: no Voice Scan, no unimplemented permissions, no reachable mic API, Elise playback preserved, foreground-only location | H2 |
| `package.json` / `package-lock.json` | 3 versions | `expo` 54.0.36→37, `expo-constants` 18.0.13→14, `expo-file-system` 19.0.23→24 | H4 |

Four Build 32 tests explicitly asserted the *opposite* contract — that the Coming Soon pill
must stay discoverable to screen readers. They were **rewritten to assert absence rather than
deleted**, so the coverage survives the intentional contract change.

**No unrelated file was modified.** No cleanup of unrelated code was performed.

---

## 6 & 7 & 8. Baseline vs final tests, and regression delta

Baseline captured at the untouched Build 32 SHA **before the first source change**.

| Command | Baseline (Build 32) | Final (Build 33) | New regression? |
|---|---|---|---|
| `npx tsc --noEmit` | **exit 0**, 0 errors | **exit 0**, 0 errors | **NO** |
| `npm run test:all` | exit 1 — 5133 tests / **5127 pass / 1 fail** / 5 skip | exit 1 — 5149 tests / **5143 pass / 1 fail** / 5 skip | **NO** |
| `npm run verify:apple-readiness` | **exit 0** — 37 PASS / 3 WARN | **exit 0** — 37 PASS / 3 WARN (identical) | **NO** |
| `npm run verify:apple-submission` | **exit 0** — 112 pass, lint valid | **exit 0** — 112 pass, lint valid | **NO** |
| `npx expo install --check` | exit 1 — 3 patch drifts | **exit 0** — "Dependencies are up to date" | **improved** |
| `npx expo-doctor` | exit 1 — **16/18** | exit 1 — **17/18** | **improved** |

**Gate result: NO NEW FAILURES VS. BASELINE.**

Test count rose by exactly +16 (`5133 → 5149`), matching the tests added: 4 routing-guard +
12 iOS-surface. Pass count rose by exactly the same +16.

### The one failing test is inherited, not a Build 33 regression

```
__tests__/eliseIdentity.test.js:271
✖ accessible labels use dynamic Elise language
  AssertionError: input did not match /ELISE_IDENTITY\.attachAccessibilityLabel/
```

This failure is **byte-identical at the untouched Build 32 SHA**, before any edit. It is a
source-text regex assertion against `StyleChatAttachmentBar.tsx`, a file this pass never
touched. Classified as **inherited Build 32 test debt**, not a Build 33 regression, and not an
iOS submission blocker.

No environment-caused baseline failure was observed (the worktree has no `.env`, so the known
Supabase-authority environment artifact did not occur).

---

## 9 & 10. Scratch iOS prebuild and generated Info.plist findings

**`npx expo prebuild -p ios --no-install` cannot generate the iOS project on Windows.** It
exits with:

```
⚠️  Skipping generating the iOS native project files.
   Run npx expo prebuild again from macOS or Linux to generate the iOS project.
CommandError: At least one platform must be enabled when syncing
```

This is a host/environment limitation, not a project defect. No `ios/` directory was produced,
so none was committed. Per A3, no risky source change was made to force Windows output.

**Stronger evidence was obtained instead.** `npx expo config --type introspect` runs the same
config-plugin mod chain that prebuild uses and emits the resulting `Info.plist` and
entitlements without needing native files. It was run in a **throwaway scratch copy** (source
copied, `node_modules` linked by junction), as a **controlled A/B**: once with the untouched
Build 32 `app.json`, once with the Build 33 `app.json`.

| Info.plist key | Build 32 (control) | Build 33 |
|---|---|---|
| `NSLocationWhenInUseUsageDescription` | PRESENT (scoped, product-specific) | **PRESENT (unchanged)** |
| `NSLocationAlwaysUsageDescription` | **PRESENT** — `Allow $(PRODUCT_NAME) to access your location` | **ABSENT** |
| `NSLocationAlwaysAndWhenInUseUsageDescription` | **PRESENT** — same generic string | **ABSENT** |
| `UIBackgroundModes` | ABSENT | **ABSENT** |
| `NSMicrophoneUsageDescription` | ABSENT | **ABSENT** |
| `NSCameraUsageDescription` | PRESENT (scoped) | **PRESENT (unchanged)** |
| `NSPhotoLibraryUsageDescription` | PRESENT (scoped) | **PRESENT (unchanged)** |

The control reproduces the exact symptom reported for the shipped Build 32 binary —
`$(PRODUCT_NAME)` expands to the product name at build time, yielding
"Allow KScan to access your location" — and confirms Build 33 removes both keys and changes
nothing else.

Other introspected iOS configuration, all correct:

- `CFBundleIdentifier` → `com.kscanai.app`; `CFBundleShortVersionString` `1.0.1`;
  `CFBundleDisplayName` `K Scan`
- Entitlements: `com.apple.developer.applesignin: ["Default"]`,
  `com.apple.developer.associated-domains: ["applinks:kscan.app"]`
- **No `aps-environment`**, no maps/routing entitlement
- `privacyManifests` present, `NSPrivacyTracking: false`, tracking domains empty
- `ITSAppUsesNonExemptEncryption: false`
- `supportsTablet: true`; `UIRequiresFullScreen: false` (iPad multitasking preserved)
- iPhone portrait-only; iPad all four orientations
- iOS icon configured (`./assets/images/kscan-ios-icon.png`)

The scratch copy and its `node_modules` junction were removed afterwards (the junction with
`rmdir`, never `rm -rf`, so the real dependency tree was untouched — verified intact). The
worktree contains **no `ios/` directory**.

**Caveat (A3):** this is a pre-build sanity check. The IPA the owner produces is the final
authority.

---

## 11. Microphone posture — no purpose string added

`NSMicrophoneUsageDescription` was **not** added, and microphone access remains disabled.
Apple's rejection was ITMS-90118, not ITMS-90683.

Evidence that no production path can request microphone access:

1. **Config:** `expo-camera` and `expo-audio` both set `microphonePermission: false`.
   `@expo/config-plugins` `applyPermissions()` *deletes* a key when the prop is exactly
   `false`, which is why the key is absent from the introspected plist.
2. **Zero reachable APIs.** A search of the entire product source (`app/`, `components/`,
   `services/`, `src/`, `hooks/`, `contexts/`, `stores/`, `lib/`, `app.js`) found **no**
   occurrence of `requestMicrophonePermissionsAsync`, `getMicrophonePermissionsAsync`,
   `requestRecordingPermissionsAsync`, `useMicrophonePermissions`, `useAudioRecorder`,
   `AudioRecorder`, `prepareToRecordAsync`, `startRecording`, `recordAsync`, or
   `mode="video"`. This is now enforced by a test.
3. **The one microphone function is inert on iOS.**
   `hooks/usePermissionPreferences.ts` → `requestMicrophonePermission()` returns immediately
   unless `Platform.OS === 'android' && VOICESCAN_ENABLED`, and `VOICESCAN_ENABLED` is a
   hard-coded literal `false`. It uses `PermissionsAndroid`, an Android-only API with no iOS
   effect. Build 33 additionally removes it from the onboarding surface entirely.
4. **Audio session never activates the record category.**
   `services/avatars/stylistAudioPlayback.ts` calls `setAudioModeAsync` with
   `allowsRecording: false`, `allowsBackgroundRecording: false`, `shouldPlayInBackground: false`.
   Activating the record category is what triggers an iOS microphone prompt.
5. `AVAudioRecorder` / `recordPermission` symbols exist only inside **linked third-party
   frameworks**, not in reachable K Scan application code.

**Corroboration:** the live privacy policy already states *"The mobile apps do not request
microphone permission for Elise spoken responses, do not collect raw microphone audio through
that feature, and do not create voiceprints."* Adding a purpose string defensively would have
put the binary in direct conflict with published legal copy.

Reconsider only if (a) Build 33 runtime actually prompts for microphone, (b) Apple returns an
explicit microphone validation error, or (c) source evidence proves a production feature needs it.

---

## 12. Location posture

- Foreground only. `services/weather/weatherStylingContext.ts` uses
  `requestForegroundPermissionsAsync`, `getForegroundPermissionsAsync`, `getCurrentPositionAsync`.
- **No** `requestBackgroundPermissionsAsync`, `startLocationUpdatesAsync`, `expo-task-manager`,
  or background-fetch anywhere in the tree.
- `isIosBackgroundLocationEnabled: false`; `UIBackgroundModes` absent from the generated plist.
- The when-in-use string remains scoped and truthful: *"K Scan AI uses your approximate
  location while you use the app to tailor StyleChat suggestions to your local weather. Your
  raw coordinates are not stored."*
- Only the two unused **Always** keys were suppressed. **The foreground weather flow is
  functionally unchanged** — no code path was modified.

Expo SDK 54 supports the suppression cleanly, so **no custom config plugin was written**.

---

## 13 & 14. Voice Scan removed / Elise speech preserved

These are different capabilities and were treated separately.

**Removed** (unimplemented, reviewer-visible):

| Surface | File | Reachable in production? |
|---|---|---|
| `VOICE SCAN` / `COMING SOON` pill | `HomeLuxuryTechV1.tsx` | **YES** — `app/index.tsx` renders this variant unconditionally |
| Same pill | `HomeV2.tsx`, `HomeLegacy.tsx` | No (unrouted) — removed anyway to prevent flag drift |
| "Coming Soon" **Microphone** card | `PermissionsStepV1.tsx` | **YES** — rendered by `app/onboarding` |
| "Coming Soon" **Notifications** card | `PermissionsStepV1.tsx` | **YES** — same |

**Preserved** (shipping): Elise text-to-speech playback, spoken responses, voice-profile
behaviour, "Voice couldn't play" error handling, and the `stylist-speech` backend client.
`services/avatars/stylistAudioPlayback.ts` was **not modified**, and a test now asserts it
still uses `createAudioPlayer` / `playStylistAudio` with recording disabled.

**Classified but intentionally left unchanged** (documented so the post-build strings scan does
not false-fail):

| Hit | Disposition |
|---|---|
| `TextScanFeatureRow` "VOICE TO SEARCH / Coming Soon" | Gated by `EXPO_PUBLIC_TEXTSCAN_VOICE_PLACEHOLDER`, which is **not set** in the production profile → does not render. Now asserted by test. |
| `app/(public)/rooms/[token].tsx` "Shared rooms are coming soon." | Dead branch behind `const ENABLE_IN_APP_SHARED_ROOMS = true` → unreachable. |
| `services/api.js` "Text analysis is coming soon." | Error string for a disabled TextScan backend; backend is **enabled** in production → unreachable in normal operation. |
| `voice-scan` icon in the icon set | Component-library entry only; **no production screen renders it** (asserted by test). |

Voice Scan was **not implemented**. Today with Elise was **not activated**.

---

## 15 & 16. Expo dependency alignment and Doctor disposition

Applied with `npx expo install --fix` (the supported installer):

```
expo             54.0.36 -> 54.0.37
expo-constants   18.0.13 -> 18.0.14
expo-file-system 19.0.23 -> 19.0.24
```

Confirmed unchanged: React Native **0.81.5**, React **19.1.0**, Expo SDK minor, `expo-location`
19.0.8, `expo-camera` 17.0.10, `expo-audio` 1.1.1. The lockfile **dropped no packages**. No
native module added or removed; no architecture change.

`npx expo install --check` → **exit 0**, "Dependencies are up to date".

**`npx expo-doctor` → 17/18** (from 16/18). The single remaining failure:

> Check for app config fields that may not be synced in a non-CNG project — This project
> contains native project folders but also has native configuration properties in app.json…

**Accepted, not silenced.** It fires because `android/` is intentionally committed (38 tracked
files). The acceptance conditions from the brief all hold:

- **No `ios/` folder is committed** (verified: `git ls-files ios` is empty)
- EAS Prebuild remains authoritative for iOS
- The generated iOS configuration was verified by introspection (§9/§10)
- Android source was **not** modified, and `.easignore` was **not** touched

Note the warning text is generic; because `ios/` is absent, EAS **does** run prebuild for iOS
and **does** apply `plugins`/`ios` config. That is confirmed empirically by the A/B
introspection, which shows the `expo-location` plugin executing and honouring the new props.

---

## 17. Production iOS environment flags

Audited `build.production.env` in `eas.json` against Build 32 intent. **No production flag was
changed by this pass.**

| Flag | Value | Required |
|---|---|---|
| `EXPO_PUBLIC_TODAY_WITH_ELISE_V1` | **`false`** | ✅ kept false |
| `EXPO_PUBLIC_HOME_NAVIGATION_V2` | `true` | ✅ |
| `EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED` | `true` | ✅ |
| `EXPO_PUBLIC_AI_STYLIST_ENABLED` | `true` | ✅ |
| `EXPO_PUBLIC_AI_STYLIST_BACKEND_ENABLED` | `true` | ✅ |
| `EXPO_PUBLIC_STYLECHAT_ATTACHMENTS_ENABLED` | `true` | ✅ |
| `EXPO_PUBLIC_ELISE_VISUAL_ATTACHMENTS_V1_ENABLED` | `true` | ✅ |
| `EXPO_PUBLIC_DRESSING_ROOM_MESSAGES_V1` | `true` | ✅ |
| `EXPO_PUBLIC_DRESSING_ROOM_REACTIONS_V1` | `true` | ✅ |
| `EXPO_PUBLIC_ENABLE_TEXTSCAN` | `true` | ✅ |
| `EXPO_PUBLIC_TEXTSCAN_BACKEND_ENABLED` | `true` | ✅ |
| `EXPO_PUBLIC_TEXTSCAN_VOICE_PLACEHOLDER` | **not set** | ✅ placeholder hidden |
| `EXPO_PUBLIC_SUPABASE_URL` | `https://wyyuqfdxucjksghsmhry.supabase.co` | ✅ production |

No staging flag was introduced. The Supabase project is unchanged. The anon key is public by
design; **no service-role or secret credential is present in `eas.json`.**

Note: `app.json` still carries `ios.buildNumber: "26"`. EAS reports it is *ignored* under
remote versioning. It was deliberately left in place because `verify:apple-readiness` asserts
it is a valid incrementing integer string; removing it is out of scope for this pass.
Non-blocking.

---

## 18. `store.config.json` / App Store Connect metadata authority

**Decision: STRATEGY B — App Store Connect is the metadata authority for this submission.
Do not run `eas metadata:push`. `store.config.json` is intentionally left unedited.**

### Why this is safe — verified, not assumed

The risk raised was that submitting could silently overwrite manually curated ASC metadata.
It cannot, on the owner's build+submit path. Inspecting the eas-cli source directly:
`metadataPath` is consumed by **only three modules** — `commands/metadata/lint.js`,
`metadata/download.js` (`metadata:pull`), and `metadata/upload.js` (`metadata:push`).
`build/commands/submit.js` contains **zero** references to metadata.

**`eas submit` does not push store metadata.** Metadata is uploaded only by an explicit
`eas metadata:push`. The stale file is therefore inert unless that command is deliberately run.

`metadataPath` was left in `eas.json` on purpose: `verify:apple-readiness` asserts
*"EAS production submit points at store.config.json metadata."* Removing it to "protect" ASC
would have broken a passing release gate — a net loss, given the file cannot auto-sync.

### `store.config.json` is stale — do not push it

| Field | Current file | Problem if pushed |
|---|---|---|
| `description` | "This release focuses on the core mobile experience: email/password account access, camera-based scan analysis, local saved scans, privacy controls…" | Understates the shipped product. **Omits Elise/StyleChat, Dressing Rooms, messaging/UGC, Sign in with Apple, Google login, retailer discovery.** |
| `releaseNotes` | "Initial iOS release…" | Wrong for Build 33 — not the initial release, and omits the actual feature set. |
| `advisory.*` | every category `NONE`, `ageRatingOverride: "NONE"`, `kidsAgeBand: null` | Conflicts with the **18+** posture published in the live Privacy Policy and Terms. |
| age-rating questionnaire | **not representable** in `configVersion: 0` | The schema has no field for *Messaging and Chat* or *User Generated Content*. A push could only ever degrade the required **YES/YES** answers. |
| App Review contact / demo account | **absent** | Reviewer credentials live only in ASC (flagged by a readiness WARN). |
| `ascAppId` | absent | Second readiness WARN. |

Verified **correct** in the file (no change needed if it is ever reconciled later): categories
`SHOPPING` + `LIFESTYLE`; version `1.0.1`; `automaticRelease: false` and `phasedRelease: false`
(manual release); no "free" keyword claim; no "Google Lens" wording. All four metadata URLs
return **HTTP 200** (`/`, `/support`, `/legal/privacy`, `/privacy`).

`eas metadata:lint` reports the file **schema-valid** — note that lint validates structure, not
accuracy, so a green lint does not mean it is safe to push.

**No evidence links `store.config.json` to ITMS-90118, and no such claim is made.** The routing
coverage file is attached in App Store Connect, not expressed in this file.

If the owner later wants the repo to become the metadata authority, `store.config.json` must
first be rewritten to match the curated ASC copy (description, release notes, promo text,
age posture) — that is a separate, deliberate task, not part of this submission.

---

## 19. Legal / support findings — 2 items need owner action (different repository)

All four pages return **HTTP 200**.

| Page | Status |
|---|---|
| `/legal/privacy` | ✅ **Accurate and iOS-ready** |
| `/legal/delete-account` | ✅ **Accurate**, platform-agnostic, in-app steps correct |
| `/legal/terms` | ⚠️ **Stale — describes the product as Android-only** |
| `/support` | ⚠️ **Beta-framed, no iOS mention** |

**Privacy policy — verified correct**, and notably strong: covers Google Play *and* Apple App
Store; foreground-only location with an explicit denial of background location; explicit
statement that the app does **not** request microphone permission; Elise/StyleChat, Dressing
Rooms, third-party AI processing, and account deletion all disclosed; **no false face-blur
claim** (it explicitly states no automatic face blurring or bystander masking is active);
18+ stated.

### ⚠️ Item 1 — `/legal/terms` describes the current release as Android-only

Current text:

> "K Scan AI currently operates a production Android application and may make iOS, TestFlight,
> beta, preview, or other platform versions available from time to time."

And in the Appendix:

> "Current production release; package com.kscanai.app. Other mobile or TestFlight versions may
> be made available separately."

This is the stale current-release wording flagged in the brief. Terms are linked from the App
Store listing; a reviewer reading them sees the product describing itself as an Android product
with iOS as a mere possibility.

**Suggested replacement copy:**

> "K Scan AI operates production mobile applications on Android and iOS, distributed through
> Google Play and the Apple App Store, and may make TestFlight, beta, preview, or other
> pre-release versions available from time to time."

And for the Appendix:

> "Current production releases; package / bundle identifier `com.kscanai.app` on Android and
> iOS. Pre-release and TestFlight versions may be made available separately."

### ⚠️ Item 2 — `/support` is beta-framed and omits iOS

The page presents **"Beta App Support"** and refers to *"Testers can report crashes."* This URL
is listed as the App Store support URL for a **public production release**, so beta/tester
framing is inaccurate and reads as an unfinished product.

**Suggested change:** retitle the section from "Beta App Support" to **"App Support"**, drop the
tester/crash-reporting framing (or move it to a clearly separate "Beta testers" subsection), and
state that K Scan AI is available on **iOS and Android**. Keep the existing contact route
(`kscanai.app@gmail.com`).

**The website lives in a different repository (`kscan-website`) and was NOT modified.** Exact
copy is reported above per instruction.

---

## 20. iPhone / iPad testing status

### GATE 26 (iPhone) and GATE 27 (iPad): **OWNER DEVICE TEST REQUIRED**

This is a Windows host. There is no iOS device, no macOS, and no iOS Simulator available, so
**no physical runtime evidence was produced and none is claimed.** iPad support was **not**
removed — `supportsTablet: true` and all four iPad orientations are preserved, with
`UIRequiresFullScreen` unset so Split View remains available.

Build 32 is already on TestFlight and can be used for the pre-build pass; the same script
should be repeated against Build 33 once it reaches TestFlight.

**Owner test script** — record DEVICE / iOS VERSION / BUILD / RESULT / ISSUES for each row.

| # | Step | Pass criteria |
|---|---|---|
| 1 | Cold launch (first install) | Launches to onboarding; **no microphone prompt**; no tracking prompt |
| 2 | Onboarding permissions screen | Shows **Camera and Photos only** — **no "Coming Soon" Microphone or Notifications card** |
| 3 | Account creation / email login | Succeeds |
| 4 | **Sign in with Apple** | Succeeds; account created/linked |
| 5 | Google login | Succeeds |
| 6 | Home | **No "VOICE SCAN / COMING SOON" pill anywhere** |
| 7 | Scanner — camera capture | Camera prompt appears only at point of use; **no microphone prompt** |
| 8 | Scanner — gallery upload | Photo prompt at point of use; scan completes |
| 9 | Scan result + retailer link | Results render; retailer link opens |
| 10 | Zero-result scan | Handled gracefully, no crash |
| 11 | Elise text chat | Responds |
| 12 | Elise image attachment | Attach from Photos / Recent Scans / Closet / Dressing Room |
| 13 | **Elise spoken response** | **Audio plays** — still works, and asks for no microphone permission |
| 14 | Closet / Recent Scans | Content persists across relaunch |
| 15 | Dressing Room | Join/invite, message, reactions, **report + block** controls work |
| 16 | Privacy screen | Opens; copy accurate |
| 17 | Account deletion entry | Present and reachable in-app |
| 18 | Foreground location | Prompted only in the weather-styling flow; **"While Using the App" only** |
| 19 | Location prompt text | Shows the scoped K Scan string, **not** "Allow KScan to access your location" |
| 20 | Rotation / landscape (iPad) | No layout failure |
| 21 | Split View / multitasking (iPad) | App remains usable |
| 22 | Background → foreground → relaunch | State preserved; no crash |

Rows **2, 6, 13, 18, 19** are the direct runtime confirmations of this pass's changes.

---

## 21. App Store Connect owner actions still required

Zero-build, owner-side. **None of these were performed by this pass** (no ASC modification was
authorized).

**Mandatory — blocks resubmission:**

- [ ] **Remove the Routing App Coverage File** — App Store Connect → App Information →
      Platform Version Information → Routing App Coverage File. **This is the ITMS-90118 fix.**
- [ ] **Re-check that field after creating the new submission** — creating a submission can
      resurface a previously attached file
- [ ] Confirm K Scan is **not** declared a routing app

**Intentional-configuration decisions (H0 — could not be inspected without ASC access):**

- [ ] **Pricing and Availability → "Make this app available on Apple Silicon Mac"** — disable
      unless a Mac release is intended. K Scan is a camera-first scanning app; Mac availability
      invites review on hardware where the core flow may not work.
- [ ] **"Make this app available on Apple Vision Pro"** — disable unless intended, for the same
      reason.

No Mac or Vision-specific capability was added to the binary.

**Metadata / review readiness:**

- [ ] **Do NOT run `eas metadata:push`** for this submission (see §18)
- [ ] Verify age rating reflects the **18+** posture published in the Privacy Policy and Terms
- [ ] Confirm **Messaging and Chat = YES**, **User Generated Content = YES**,
      Social Media = NO, Unrestricted Web Access = NO
- [ ] Confirm Content Rights completed
- [ ] Confirm primary category **Shopping**, secondary **Lifestyle**
- [ ] Fix the promotional typo **"save to you Dressing Room" → "save to your Dressing Room"**
      (this string is **not in source** — it exists only in ASC-curated copy)
- [ ] Confirm App Review notes describe the current feature set (Elise/StyleChat, Dressing
      Rooms, scanning) and contain **no Voice Scan claim**
- [ ] Confirm reviewer demo credentials are present in ASC
- [ ] Confirm screenshots intact and free of Voice Scan / Coming Soon UI
- [ ] Confirm non-exempt encryption answer remains **NO**
- [ ] Confirm no IAP, no App Store Server Notification URL, no shared secret
- [ ] Confirm manual release is still configured

**Website (separate repo `kscan-website`):**

- [ ] Update `/legal/terms` Android-only wording (§19, replacement copy provided)
- [ ] Update `/support` beta framing and add iOS (§19)

---

## 22. Backend review-path verification (read-only)

Production Supabase `wyyuqfdxucjksghsmhry` ("KScan App Production", us-east-2) —
**`ACTIVE_HEALTHY`**, Postgres 17.6.1.104.

All Edge Functions backing reviewer-visible flows are **ACTIVE**:

| Function | Version | Flow |
|---|---|---|
| `scan-identify` | 154 | Scanner |
| `stylechat-generate` | 98 | Elise / StyleChat |
| `stylist-speech` | 39 | Elise spoken responses |
| `apple-credential-link` | 7 | Sign in with Apple |
| `apple-revoke-credential` | 7 | Apple credential revocation on deletion |
| `handle-user-deletion` | 82 | Account deletion |
| `process-account-deletions` | 23 | Deletion worker |
| `restore-account` / `resend-restoration-email` | 21 / 21 | Restoration |
| `privacy-data-export` / `privacy-correction-request` | 37 / 37 | Privacy entry points |
| `shared-room-image-url` | 28 | Dressing Rooms |

**No production backend mutation was performed. No migration was applied. No function was
deployed.** Deletion automation flags were not changed.

Known hygiene items (schema drift, historical body-drain concerns) were **not reproduced as
reviewer-visible failures** in this pass and are **non-blocking** for Build 33. Live
authenticated end-to-end flows still require the device pass in §20.

---

## 23. Pre-build gate summary

| Gate | Result |
|---|---|
| 0 — Routing coverage file removed from ASC | **OWNER ACTION REQUIRED** (source-side closed + guarded) |
| 1 — Exact Build 32 SHA as authority | **PASS** |
| 2 — Fresh worktree clean | **PASS** |
| 3 — Pre-change baseline captured | **PASS** |
| 4 — No Android files touched | **PASS** |
| 5 — No unrelated PRs merged | **PASS** |
| 6 — No routing capability added | **PASS** |
| 7 — Apple Silicon Mac setting | **OWNER ACTION REQUIRED** (no ASC access) |
| 8 — Vision Pro setting | **OWNER ACTION REQUIRED** (no ASC access) |
| 9 — Scratch iOS prebuild plist verified | **PASS (by introspection A/B)** — native prebuild not possible on Windows |
| 10 — Foreground location still correct | **PASS** |
| 11 — No background location | **PASS** |
| 12 — Unfinished Voice Scan / Coming Soon removed | **PASS** |
| 13 — Elise spoken response preserved | **PASS** (source); runtime pending §20 |
| 14 — No reachable microphone request | **PASS** |
| 15 — No cold-launch microphone prompt | **PASS (source-level)** — runtime confirmation pending §20 |
| 16 — Expo patch alignment complete | **PASS** |
| 17 — Expo Doctor acceptable | **PASS** — 17/18 + documented Android/CNG exception |
| 18 — No new TypeScript failures | **PASS** |
| 19 — No new full-suite failures | **PASS** |
| 20 — Apple readiness verifier | **PASS** (exit 0, 3 pre-existing WARNs) |
| 21 — Apple submission verifier | **PASS** (exit 0) |
| 22 — Production env flags unchanged | **PASS** |
| 23 — Production Supabase confirmed | **PASS** |
| 24 — Metadata authority reconciled | **PASS** — Strategy B, evidence-backed |
| 25 — Legal/privacy/support reviewed | **PASS WITH 2 OWNER ITEMS** (terms, support) |
| 26 — iPhone review surface tested | **OWNER DEVICE TEST REQUIRED** |
| 27 — iPad review surface tested | **OWNER DEVICE TEST REQUIRED** |
| 28 — No production backend mutation | **PASS** |
| 29 — Remote EAS iOS build counter checked | **PASS** — remote 32, next 33 |
| 30 — Owner authorized cloud build | **NOT RUN — no build was executed** |

---

## 24. Known non-blocking conditions

1. **Inherited test failure** — `__tests__/eliseIdentity.test.js:271`, identical at the
   untouched Build 32 SHA. Pre-existing test debt, not a Build 33 regression.
2. **expo-doctor 17/18** — non-CNG check, caused by the intentionally committed `android/`
   tree. Accepted by design; iOS is unaffected (`ios/` not committed).
3. **3 readiness WARNs** (unchanged from Build 32) — ASC app ID not in `eas.json`; App Review
   contact/demo account not in `store.config.json`; EAS iOS credentials need interactive
   validation. All are external/ASC-side.
4. **`app.json ios.buildNumber: "26"`** is ignored under remote versioning; EAS advises removing
   it. Left in place because the readiness verifier asserts on it. Cosmetic.
5. **`store.config.json` is stale** but inert — `eas submit` does not push metadata (§18).
6. **Website copy** — `/legal/terms` and `/support` need updates in a different repository (§19).
7. **`voice-scan` icon** remains registered in the icon set but is rendered by no production
   screen (asserted by test).
8. Unreachable "coming soon" strings remain in dead branches (shared-rooms fallback, TextScan
   backend-disabled error). Documented in §13/14 so the post-build strings scan does not
   false-fail.

---

## 25. Exact command for the OWNER to run

**This agent did NOT run any EAS build, and must not.** When ready:

```bash
eas build --platform ios --profile production
```

Run from the worktree `C:\src\KScan-build33-ios-hardening` on the **branch tip** of
`release/ios-build33-app-review-hardening`. The last product-code commit is `271f50f`;
the tip adds only this report (docs-only), so either yields the same binary.

| | |
|---|---|
| Platform | iOS |
| Version | 1.0.1 |
| Expected build number | **33** (remote counter is 32, `autoIncrement: true`) |
| Bundle ID | `com.kscanai.app` |
| Distribution | store |
| Configuration | Release |
| Backend | `wyyuqfdxucjksghsmhry` (production) |

If EAS assigns anything other than 33, **stop and investigate** rather than forcing the version.

**Recommended:** remove the Routing App Coverage File in App Store Connect *before* building, so
the corrected configuration is in place when the new binary is processed.

---

## 26. Post-build IPA forensic audit checklist (for the next pass)

**Nothing below is verified — no Build 33 IPA exists.** No claim of "IPA verified", "binary
verified", "signing verified", or "App Store ready" is made or may be made until the owner
supplies the exact artifact.

Windows host: use **Python** (`zipfile`, `plistlib`, `hashlib`, `lief`, `macholib`,
`asn1crypto`). Do **not** use `codesign`, `otool`, `nm`, `xcrun`, `altool`, or `spctl`.

**Chain of custody:** IPA filename, byte size, **SHA-256**, EAS Build ID, source SHA
(branch tip; last code commit `271f50f`), version, build number, audit date. Do not modify the IPA.

**Identity:** `CFBundleIdentifier` = `com.kscanai.app`; `CFBundleShortVersionString` = `1.0.1`;
`CFBundleVersion` = assigned remote build; `CFBundleDisplayName` = `K Scan`.

**Build environment:** `DTXcode`, `DTXcodeBuild`, `DTSDKName`, `DTPlatformVersion`,
`MinimumOSVersion`, `CFBundleSupportedPlatforms` — current Apple upload SDK compliance.

**Signing / entitlements** (parse code signature + `embedded.mobileprovision`):
`get-task-allow` = **false**; `application-identifier` = `Y9K3XPR9J2.com.kscanai.app`;
team `Y9K3XPR9J2`; Sign in with Apple entitlement present; `applinks:kscan.app` present;
**no unexpected `aps-environment`**; no debug entitlement; App Store distribution profile.

**Mach-O** (main executable, every framework, dylib, extension): **arm64 only**; no `x86_64`,
`i386`, `armv7`; no simulator platform; `LC_CODE_SIGNATURE` present; no private framework
linkage; no stray dylibs; no `__LLVM`; no release `__DWARF` issue; **no UIWebView**.

**Permissions (compiled Info.plist)** — the direct check of this pass's work:

- `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`,
  `NSLocationWhenInUseUsageDescription` present and scoped
- **`NSLocationAlwaysUsageDescription` ABSENT**
- **`NSLocationAlwaysAndWhenInUseUsageDescription` ABSENT**
- **`UIBackgroundModes` ABSENT** (no background-location mode)
- **`NSMicrophoneUsageDescription` ABSENT**
- No tracking purpose string
- **`MKDirectionsApplicationSupportedModes` ABSENT**

**Icon (A14):** `CFBundleIconName` **present**, and the referenced AppIcon resolves in the
compiled asset catalog; expected iOS app icon present; App Store icon configuration did not
regress; no icon-related ITMS risk introduced.

**Privacy manifest:** `PrivacyInfo.xcprivacy` present and parses; `NSPrivacyTracking` = false;
tracking domains empty; required-reason APIs covered.

**Strings scan (classify framework noise separately from reachable product UI):** no reviewer-visible
`Voice Scan`; no product-UI `Coming Soon`; no exposed `staging`, `localhost`, or `ngrok`;
production backend hostname is `wyyuqfdxucjksghsmhry.supabase.co`. Expect benign hits from the
dead branches listed in §24.8 — those are not failures.

**Then:** re-run the §20 device script against the real Build 33 TestFlight build before
submitting.

---

## Final verdict

# READY FOR OWNER TO RUN iOS EAS BUILD

Source hardening is complete with **no new failures versus the Build 32 baseline**. The
ITMS-90118 recurrence is closed at source and guarded by a test; the App Store Connect removal
remains the owner's mandatory action.

Submission readiness cannot be decided here — it requires the actual Build 33 IPA and the
device pass. This report deliberately stops short of that.
