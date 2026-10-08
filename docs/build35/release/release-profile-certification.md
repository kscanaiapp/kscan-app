# Build 35 release profile and holds — 2026-10-08

Verdict: **SOURCE_HOLDS_VERIFIED / RELEASE_CERTIFICATION_INCOMPLETE**. This lane creates a conservative store build configuration; it does not claim a signed artifact, a device pass, store purchase certification, or release approval. No EAS build, store submission, production setting change, secret write, backend deployment, or push send was performed.

## Configuration repair

The existing `build35-testing` profile inherits `production-certification`, whose environment enables features for evidence gathering. It must not become the store release by inheritance. The base production profile also leaves Today greeting and weather enabled even while the Today master flag is OFF.

`build35-release` now extends `production` independently, selects the production EAS environment, store distribution, Android app bundle, and iOS physical-device Release build. It keeps remote version numbering and automatic incrementing. Both app identities remain `com.kscanai.app`; the guard checks the authoritative Android application ID/namespace as well as declarative iOS/Android identity. Checked-in version seeds remain unchanged: Expo/Android `1.0.1`, Android versionCode `23`; iOS `1.0.2`, build `26`. The real next remotely allocated build numbers require build-time verification and must not be inferred from these seeds.

This is an explicitly flagged **EAS environment configuration change**. Existing production/certification/testing profiles, backend targets, public key values, authentication, storage policies, database assumptions, and production integration logic are not changed by the new profile.

| Capability | Release configuration | Remaining proof |
| --- | --- | --- |
| Today, generated greeting, weather | All three explicit OFF | Separate authorization and full customer flow evidence |
| Closet cloud sync, restore, historical migration | All three explicit OFF | Device restore/privacy/retry/lifecycle and honest advertising evidence |
| Stylist spoken replies | Explicit OFF with real runtime/client gates | Enabled signed-device generation/playback/interruption proof |
| Complimentary K+ Early Access | Explicit OFF | Separately authorized campaign and granting proof |
| Multi-image Scanner | Explicit OFF | Review/cancel/partial failure/isolation proof |
| Packing Intelligence | Explicit OFF | Mature end-to-end authenticated free/K+ proof |
| Smart Watchlist | Explicit OFF | Ownership/refresh/event/no-spam and K+ proof |
| Generative VTO | Explicit OFF | Entitlement/provider/lifecycle and real generation proof |
| Voice Scan and placeholder | Explicit OFF; native selectors absent | Native permissions/on-device recognition/interruption proof |
| Live VTO, development harness/demo/debug flags | Absent or OFF | No implicit release opt-in |

`production-certification` remains an evidence-gathering profile with conditional capabilities enabled. `build35-testing` remains its internal APK descendant. Neither is a store-release certificate.

## Guard and regression coverage

Run `node scripts/check-build35-release-profile.js`. The CI workflow **Build 35 Release Profile Guard** runs this on pushes and pull requests, runs release/speech/native negative controls, and runs native configuration parity. It performs no deployment and requires no production credentials.

The guard validates the complete inheritance chain before resolving it, rejects missing/invalid parents and cycles, requires explicit release OFF overrides, checks inherited platform build shape, exact production origin and anon-key identity, and rejects unknown enabled public capabilities against a fixed baseline allowlist. It rejects simulator/debug build overrides, unapproved legacy endpoints, and secret-shaped public variables. Values and decoded key claims are never printed.

The optional command `node scripts/check-build35-release-profile.js --effective-env-json <private-file>` also validates a complete resolved build environment supplied as a JSON object. Keep that file outside the tracked repository; do not publish it as evidence or upload its raw contents. This check cannot independently establish that a supplied snapshot came from a real EAS build, nor can it observe remote EAS values during ordinary source CI.

Native parity now classifies selector enablement by the same trimmed, case-insensitive `true` comparison used by Gradle. Explicit false holds no longer count as native permission grants. Its isolated fixture now copies both push capability manifests, and its Gradle mutation targets the actual current selector assignment; negative controls therefore exercise the intended defect instead of failing because fixtures omit governed inputs.

Stylist speech previously had an EAS flag with no runtime readers. `STYLIST_SPEECH_ENABLED` now resolves exact `true` only. The orchestration service returns before lifecycle binding, state mutation, fetch, file creation, or playback while held. The authenticated client independently rejects direct calls while held. The preference switch and retry control are hidden, including when an old preference is ON or an old speech error remains. Existing cleanup is available while held. Existing enabled speech tests explicitly select enabled fixtures; lifecycle/retry/cancellation coverage is preserved.

## External blockers and device/store evidence

1. **Backend worker hold:** the autonomous worker reads live `app_config.watchlist_worker_enabled`. EAS client flags cannot turn this control OFF. Verify and capture its live production OFF state without invoking a sweep. This lane has not established that live value.
2. **Backend push hold:** delivery checks per-watch `push_enabled` and registered device tokens. There is no global push kill switch in the source inspected here. A release client with Watchlist OFF cannot establish that historical devices will receive no server pushes. Separate server control/proof is required; disabling the worker alone is insufficient because user-triggered refresh can also deliver events. No synthetic EAS push/worker flag is presented as a real server control.
3. **Advertising:** merged contextual K+ surfaces must remain unable to claim cloud persistence, cross-device restore or sync while these flags are OFF. Review the final merged acquisition catalog and render evidence; the pre-integration profile alone cannot certify later PR copy.
4. **Signed native artifacts:** build from the exact fully green integrated SHA using this canonical profile only after proof prerequisites are met. Record EAS profile/build ID/source SHA, artifact hash, actual remote version/build numbers, signing identity and package IDs. Inspect the merged Android manifest to prove microphone, notification and boot restoration holds. Inspect generated iOS entitlements/privacy declarations and signing; source parity does not prove manifest merge behavior.
5. **Physical devices and stores:** execute held-feature absence and all retained free/paid flows on physical iOS and Android devices. Complete interrupted requests, background/resume, account switch/sign-out/deletion, clean-install/upgrade, permission denial, receipt purchase/restore/refund, RevenueCat identity and trial/lifetime reconciliation evidence. The native RevenueCat keys already present in production source are preserved; source key presence is not store readiness proof.
6. **Current-head CI and TestSprite:** this local lane supplies focused source tests. Parent integration must verify final-head full CI and the requested deployment-aware TestSprite loop. A previous deployed build cannot verify this source change.

The React best practices skill was reviewed for the two UI changes: existing hooks stay unconditional, conditional rendering uses explicit ternaries, and the service rejects held work before asynchronous side effects. No unrelated component refactor was made.

## Local validation record

The ten focused release/speech/config/identity test files passed **243/243**, with zero failures or skips. Output is saved in `focused-validation.txt`. The release guard and all 17 native configuration parity checks passed. `git diff --check` passed. The focused tests include disabled speech side-effect and actual UI-render controls plus the existing enabled playback/retry/cancellation suites. These are source/controlled-runtime checks, not provider, physical-device, store, deployed-URL or signed-artifact evidence. Final integrated-head full-suite, typechecking, remote CI and TestSprite are the parent integration lane's responsibility.
