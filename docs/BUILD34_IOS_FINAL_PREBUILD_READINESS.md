# K SCAN AI — BUILD 34 — iOS FINAL PRE-BUILD READINESS

Bounded pre-EAS readiness gate for the first K+ iOS build. Windows host; no macOS,
Xcode, simulator, compiled IPA or physical device was available, so every runtime claim
below is carried to artifact inspection or device QA and labelled that way. No EAS build
was run and nothing was submitted to Apple.

## 0. Authority

| Item | Value |
| --- | --- |
| Repository | `kscanaiapp/kscan-app` |
| Release branch | `release/kscan-pre-freeze-v1` |
| Frozen baseline | `1d39e5a3aae0512473d788f1980a428b5bac6ea5` (merge of #475) |
| Release tip at start and at handoff | `1d39e5a3…` — no divergence |
| Audit worktree / branch | `C:\b34ios` / `repair/build34-ios-final-prebuild` (isolated; the Android pass's `C:\b34ap` was not touched) |
| Primary checkout `C:\Users\jsmit\KScan` | `core.bare=true`; `git status` fails there, so it is not a valid checkout |
| Intended artifact checkout `C:\Users\jsmit\KScan-Build34-Artifact` | does not exist |
| Live App Store version (iTunes lookup, 2026-09-30) | 1.0.1, released 2026-09-15 |

## 1. Verdict

No verified iOS pre-build blocker. The candidate is ready for a real
`production-certification` EAS iOS build **as it stands at `1d39e5a3`**. The one change
in this lane is optional iOS polish (§3), and readiness does not depend on merging it.

## 2. Build and configuration (source/config verified unless stated)

| Check | Result | Class |
| --- | --- | --- |
| `production-certification` exists and resolves (eas-cli 24.8.0 `eas config`) | `extends: production`, `distribution: store`, `ios.buildConfiguration: Release`, `environment: production`, `credentialsSource: remote`, `autoIncrement: true`, no `ios.simulator` → device IPA for App Store / TestFlight | Source/config verified |
| `env` merge | eas-json `mergeProfiles` merges `env` objects with the child winning; resolved 56 variables | Source/config verified |
| EAS `production` environment | holds one Android-only file variable; nothing iOS-relevant, so analytics has no key and stays inert | Source/config verified |
| Backend | `EXPO_PUBLIC_SUPABASE_URL` = production `wyyuqfdxucjksghsmhry`; anon key decodes to `ref=wyyuqfdxucjksghsmhry, role=anon` | Source/config verified |
| Release JS bundle with the resolved env (`expo export --platform ios`) | exports (7.5 MB Hermes); production ref present; staging ref, `service_role`, `sk_live`/`sk_test`, `localhost:3001`, `10.0.2.2` all absent | Source/config verified |
| Build 34 flags true | K+ Early Access, Smart Watchlist, VTO UI, Packing V1, Concierge V1, Voice Scan, Multi-image scanner, Closet cloud sync / cross-device restore / legacy migration, Today with Elise, Elise V10 / speech / advice metadata, Dressing Room collaboration / messages / reactions, Text Scan (demo results `false`) | Source/config verified |
| Bundle ID / version | `com.kscanai.app`; `CFBundleShortVersionString` 1.0.2 (> live 1.0.1) | Source/config verified |
| Build number authority | `appVersionSource: remote`; EAS remote iOS counter reads 34, so `autoIncrement` makes the next build **35**. `app.json` `buildNumber: "26"` is ignored (see IOS-OBS-01) | Source/config verified |
| Info.plist (`expo config --type introspect`) | camera, photo library, location-when-in-use, microphone, speech-recognition strings all present and scoped; `ITSAppUsesNonExemptEncryption=false`; iPhone portrait, iPad four orientations; `UIRequiresFullScreen=false`; URL schemes `kscan`, `com.kscanai.app`; no background modes | Source/config verified |
| ATS / device capabilities in the introspection | `NSAllowsArbitraryLoads=true` and `armv7` come from the config-plugins introspection stand-in template (`@expo/config-plugins/build/plugins/withIosBaseMods.js`), not the prebuild template; the 2026-09-01 IPA had ATS locked | IPA inspection required |
| Entitlements | `aps-environment=production`, `com.apple.developer.applesignin`, `applinks:kscan.app` | Source/config verified; profile match = IPA inspection |
| Capabilities vs the last store-signed IPA (EAS 42e66187, 2026-09-01) | same three capabilities; the only change is `aps-environment` development → production, which is what a store profile carries | Source/config verified |
| Signing | EAS remote credentials; profile/certificate validity cannot be read non-interactively. `verify-apple-readiness` WARN says the same | Owner check before build |
| Universal Links | `https://kscan.app/.well-known/apple-app-site-association` serves `application/json`, appID `Y9K3XPR9J2.com.kscanai.app`, paths `/rooms/*`; `app/+native-intent.ts` maps room links | Source/config verified; team ID in the profile = IPA inspection; link opening = device |
| Privacy manifest | tracking false, no tracking domains; UserDefaults `CA92.1`, FileTimestamp `C617.1` (covers `attributesOfItem` in `IOSOutputVerifier.swift`); Device ID linked / App Functionality; Expo modules and AsyncStorage ship their own `PrivacyInfo.xcprivacy` | Source/config verified; merged manifest = IPA inspection |
| Native changes since the last compiled IPA (eb41b1f8) | `expo-application`, `expo-device` (Expo SDK 54 modules), `posthog-react-native` (JS; optional native peers resolved via try/require), and `.runOnQueue(.main)` in `KScanVoiceNativeModule.swift` — the API exists in installed ExpoModulesCore 3.0.30 and expo-haptics uses the same call | Source verified; **Swift compile is proven only by the EAS build** |
| No checked-in `ios/` | EAS will prebuild iOS from `app.json` | Source/config verified |
| Weather | foreground `expo-location` fix at `Accuracy.Low`, coordinates rounded client-side, forecast fetched server-side from Open-Meteo. No WeatherKit use or capability; none proposed | Source verified |

## 3. Changes in this lane

### Blocker repairs

None. No reproducible iOS-specific build failure, broken critical flow, or testing
obstruction was established.

### iOS polish — IOS-POL-01: Open Settings after a permanent Voice Scan denial

- **Observed:** iOS shows the microphone and speech prompts once. After a denial,
  `KScanVoiceNativeModule.requestPermissions` resolves `canAskAgain: false`, the sheet
  shows `permission_denied_permanently`: "Enable it in your device Settings, or search by
  typing below." — and offered only "Use Text Instead". Rendered at the baseline
  (`1d39e5a3`) through the repo's component renderer: the only action was
  `voice-scan-use-text`.
- **Change:** `components/text-scan/VoiceListeningSheet.tsx` — on iOS, for that one reason,
  a secondary "Open Settings" button (`Linking.openSettings()`); the sheet steps aside once
  Settings opens and stays up if it cannot. "Use Text Instead" stays primary. Same pattern
  as the scanner camera gate from #467.
- **Android isolation:** the branch is `Platform.OS === 'ios' && reason === 'permission_denied_permanently'`.
  `__tests__/iosVoiceScanSettings.test.js` executes the real component under both
  platforms: Android renders the same single action as before; two mutation controls prove
  the gate and the Android assertion both bite.
- **Remaining:** the Settings round-trip on a device (iOS relaunches the app when a privacy
  toggle changes).

## 4. Defect register

Severity is impact on users if shipped; "Blocker" is whether it stops the build or the
closed iOS test. Nothing below is a pre-build blocker.

| ID | Sev | Location | Type | Scope | Evidence / reproduction | Expected vs actual | Blocker | Suggested repair | Disposition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IOS-KNOWN-01 (known deferred) | P2 | `contexts/AiOutputReportingContext.tsx` `submit` (≈L95–118); `services/reportAiOutput.ts` `createAiOutputReportSubmissionGate` (≈L188) — report sheet | Async race across actor boundary | Shared | Account A submits; before it settles, sign out and in as B and open a report. The actor effect resets the sheet, but A's await still ends in `setState('success'|'error')` on B's sheet. The gate is per provider, not per actor, so B's Submit returns `started:false` and leaves B's sheet in `submitting` (Close disabled) until A's request settles, then shows A's outcome | Late result discarded; B can submit at once. Actual: B sees A's outcome and is briefly stuck | NO — needs an account switch mid-submit; testers can close after the request settles | Capture the actor key/generation at submit and ignore a result from an older one; reset or key the submission gate by actor; test with the renderer's `deferred()` to interleave the switch | Deferred (shared logic, out of scope) |
| SH-FS-01 | P3 | `components/style-chat/StyleChatBubble.tsx:18` → `components/concierge/ConciergeEvidenceBlock.tsx` → `services/concierge/conciergeClosetImageSource.ts:89` — Elise Concierge evidence cards | SDK 54 API misuse | Shared | `import * as FileSystem from 'expo-file-system'` is the SDK 54 new API; its `getInfoAsync` is a stub that throws ("imported from expo-file-system is deprecated", `node_modules/expo-file-system/src/legacyWarnings.ts`). The resolver catches and returns false, so every card falls back to text and each lookup logs a warning | Closet photos on Concierge cards; actual: always text cards | NO — fail-safe fallback | Import from `expo-file-system/legacy` (as the other 24 call sites do) and add a test that runs the resolver against the real module shape | Suggested |
| IOS-CLOSET-01b (carried forward) | P2 | `services/library.js` `referencesForeignDataContainer` (≈L333–357) and every store that persists `FileSystem.documentDirectory + …` absolute paths | Stored absolute container paths | iOS behaviour in shared code | Sweeps are now refused when records point into another iOS data container (good), but paths are never re-anchored, so after a container relocation (backup restore, device migration) images do not resolve | Media still shown; actual: missing thumbnails until re-saved | NO for the build; device QA must check install-over-Build-33 | Persist container-relative paths, or rebase the `/containers/data/application/<uuid>/` prefix to the current `documentDirectory` at read time | Deferred (shared storage) |
| IOS-OBS-01 | P3 | `eas.json` `cli.appVersionSource: remote`; `app.json` `ios.buildNumber: "26"` | Traceability | iOS config | `eas build:version:get` → 34; `autoIncrement` → next build 35. The stale `26` is ignored but still ships in the expo-constants manifest | The "Build 34" release will carry `CFBundleVersion` 35 | NO | Record 35 as the Build 34 iOS artifact; remove the stale field in a later cleanup (not changed here — manual build-number changes are excluded) | Recorded |
| IOS-SUB-01 | P3 | `store.config.json` `apple.info.en-US` | Store metadata | iOS submission | Description and release notes still describe the Build 33 scope ("Initial iOS release…", local saved scans) and omit K+, Voice Scan, VTO, Watchlist, Dressing Rooms. `eas submit` does not push this metadata | Accurate listing at submission | NO (build) — later App Store item | Update copy and screenshots in App Store Connect before review | Later submission item |
| IOS-SUB-02 | P3 | `components/text-scan/VoiceListeningSheet.tsx` `not_kplus` copy | Copy | Shared | "Upgrade to K+ to use Voice Scan." — K+ is complimentary Early Access with no purchase path; "Upgrade" can send a reviewer looking for one | Copy that matches the complimentary offer | NO | Reword (shared copy, product decision) | Suggested |
| OPS-01 | — | `ops/build34-ios-certification-dc1f59f4` workflow | Stale build pin | Ops | Its `SOURCE_SHA` is `dc1f59f4`; release is `1d39e5a3`. The workflow asserts `origin/release == SOURCE_SHA`, so it fails closed rather than building the wrong tree | Pin = final candidate | Condition (see §6) | Re-point `SOURCE_SHA` to the final candidate before dispatch | Recorded |
| OPS-02 | — | Server-side switches (carried forward from the 2026-09-24 audit, not re-read) | Backend enablement | Backend | Packing and Concierge server enablement unconfirmed (the client does not advertise them — Lane A); Watchlist real push depends on the worker and push credentials being enabled | Features reachable in closed testing as intended | NO for the build; affects what testers can exercise | Owner decision / governed backend lane | Recorded |

Earlier findings rechecked and closed at this candidate: the 2026-09-01 IPA P1s (Watchlist
list not scrollable; LiveScanCamera capture button off-screen in iPad landscape) are fixed
in source (`app/watchlist/index.tsx` owns a `ScrollView`; `computeScanRoomViewfinderSize`
budgets height). "VTO rejects iOS Limited Photos access" no longer applies —
`services/vto/vtoPersonInput.ts` no longer gates on the permission, and expo-image-picker
maps iOS `.limited` to `granted`. Every `KeyboardAvoidingView` now uses offset 0 or the
default.

## 5. Validation

| Gate | Baseline `1d39e5a3` | Branch |
| --- | --- | --- |
| TypeScript `tsc --noEmit -p tsconfig.json` | PASS | PASS |
| Focused: `iosVoiceScanSettings` (6) | — | 6/6 |
| Voice + neighbouring suites (voiceScanUiWiring, voiceScanPrivacyBoundary, voiceScanMicrophonePermission, externalUrlOpenSafety, iosAppReviewSurface, navigationExit, kplusCoreFreeBoundary, textScanCanonicalPath, aiOutputReportingReachability, stylistSpeechRecovery) | — | 135/135 |
| Full governed suite `scripts/run-all-tests.js` (Windows) | 9437 tests, 31 failures (13 known + 18 unexpected: PostHog disabled-state egress ×13, shared-client mutants ×4, one `\`-vs-`/` path assertion) — the same counts recorded for #475's base on this host; CI (Linux) is green | 9443 tests (+6 new, all pass), 31 failures — **identical failure identities** to the baseline (sorted diff empty) |
| CI at `1d39e5a3` (push) | 7/7 workflows success, incl. Security - Code and Dependencies (Linux full suite + tsc) | PR CI below |
| `verify:apple-readiness` | 40 PASS, 0 FAIL, 3 WARN (ASC app ID, review contact, interactive credential validation) | unchanged (no config touched) |
| `verify:native-config-parity` | PASS | unchanged |
| `verify:dependency-reachability` | PASS (no unapproved critical/high) | unchanged |
| `expo-doctor@latest` | 17/17 | unchanged |
| `expo export --platform ios` (plain and resolved-profile env) | PASS | unchanged (JS-only change) |

## 6. Carry-forward

**Before the build:** the release manager fixes the candidate (`1d39e5a3`, or the merge SHA
if the polish PR is merged — then CI must be green there); re-point the iOS certification
workflow's `SOURCE_SHA`; confirm EAS iOS distribution certificate and App Store profile are
valid (`eas credentials`) for team `Y9K3XPR9J2`.

**IPA inspection:** Swift compile of the Voice module; `CFBundleShortVersionString` 1.0.2 /
`CFBundleVersion` 35; ATS locked and `arm64` capability in the real plist; all five usage
strings; `embedded.mobileprovision` team `Y9K3XPR9J2` with push (production), Sign in with
Apple, associated domains; merged `PrivacyInfo.xcprivacy`; production Supabase ref only;
no background modes.

**Physical device:** install over App Store 1.0.1 (Closet / saved scan media intact);
camera, microphone/speech and photo denial → Settings → return; Voice Scan 15-second cap;
K+ activation, gates and recovery on a production account; auth keyboard on a small iPhone,
a Face ID iPhone and iPad (Slide Over unsolved); rapid Dressing Room navigation and nested
sheets (no "already presenting" warnings); report sheet signed out; Sign in with Apple and
Google OAuth; Universal Link `/rooms/*`; push token and delivery; VoiceOver and Dynamic Type;
iPad rotation and Split View.

**Later App Store submission:** IOS-SUB-01, IOS-SUB-02; review contact / demo account and
ASC app ID (apple-readiness WARNs); App Privacy answers consistent with the manifest.
