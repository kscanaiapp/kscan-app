# Android Voice — production activation runbook (ANDROID-VOICE-01)

This document exists because "no future source repair is needed" is not
proven unless the release operator knows exactly how to activate production
Voice Scan. It records the exact, already-wired mechanism this repair added.
**None of the steps below have been performed.** Production Voice Scan
remains OFF, and `KSCAN_VOICE_NATIVE_CAPABILITY` is committed to no EAS
profile, production included.

## What changed, in one sentence

Android's native Voice capability (RECORD_AUDIO + the already-compiled-in
`KScanVoiceNative` bridge) is now reachable from two independent selectors
instead of one: the existing `KSCAN_VOICE_CERTIFICATION` (unchanged, still
locked to the `staging-certification` EAS profile only) and a new, generic,
non-public `KSCAN_VOICE_NATIVE_CAPABILITY`, which `android/app/build.gradle`
additionally permits under the `production` profile — but only once a release
operator supplies it out of band. Nothing in `eas.json` sets it today.

## The two governed controls

| Control | Name | Public | Default | Where it's defined |
|---|---|---|---|---|
| Runtime / product flag | `EXPO_PUBLIC_VOICESCAN_ENABLED` | Yes (`EXPO_PUBLIC_*`) | OFF | `constants/featureFlags.ts` (`resolveVoiceScanEnabled`) |
| Native / build capability | `KSCAN_VOICE_NATIVE_CAPABILITY` | No | OFF | `android/app/build.gradle` (Gradle property `kscan.voiceNativeCapability`) |

Both must resolve identically or the Gradle build refuses (the Voice
invariant guard in `android/app/build.gradle`). Neither is sufficient alone.

## Activation steps (NOT performed by this repair)

1. **Confirm production backend/K+ prerequisites are satisfied.** Voice Scan
   is K+-gated at runtime (`KPlusGate`, `useVoiceScan`); this repair does not
   touch K+ entitlement, RevenueCat, or complimentary early-access logic.
2. **Explicitly enable the non-public Android Voice native capability** at
   the governed production release configuration surface — set
   `KSCAN_VOICE_NATIVE_CAPABILITY=true` in the environment the production
   `eas build` invocation runs under (an EAS-side environment variable/secret
   scoped to that build, or an explicit `-Pkscan.voiceNativeCapability=true`
   passed to the native build). Do **not** add this key to `eas.json`'s
   committed `production.env` block as a standing change — that would enable
   it for every future production build silently, which is exactly what this
   repair's governed guards and tests (see
   `__tests__/androidBuild34CertificationGuards.test.js`,
   `__tests__/nativeConfigParityGate.test.js`) exist to keep visible and
   deliberate.
3. **Explicitly enable `EXPO_PUBLIC_VOICESCAN_ENABLED=true`** through the same
   out-of-band mechanism, at the same time as step 2 — the two must resolve
   identically or the build refuses before producing an artifact.
4. **Run the build.** `android/app/build.gradle`'s guards validate the pair
   automatically (no separate command): a mismatched pair, an unapproved
   profile, or the capability selector active anywhere but
   `staging-certification`/`production` all throw `GradleException` and stop
   the build before an artifact is produced.
5. **Build the production Android artifact** (`eas build --profile
   production`) once steps 2–4 are satisfied. This step, and every step after
   it, is authorized only by a separate, explicit decision — this repair does
   not authorize it.
6. **Prove the final merged manifest contains `RECORD_AUDIO`.** Not provable
   from source (see `config/native-config-authority.json`
   `artifactVerificationRequired` on the `VOICE_SCAN_PRODUCTION_READINESS_CAPABILITY`
   exception) — inspect the built AAB's merged manifest directly.
7. **Prove the native Voice bridge is present and reachable**, including
   under R8 (see "R8 / release shrinking" below) — inspect the artifact, not
   just the build log.
8. **Run physical-device Voice certification** — on-device speech
   recognition, permission prompts, and the full Voice Scan → Text Scan
   → commerce path, on real hardware.
9. **Only then approve rollout.** Steps 1–8 are prerequisites, not a
   substitute for an explicit rollout decision.

## Rolling back

Omit `KSCAN_VOICE_NATIVE_CAPABILITY` and `EXPO_PUBLIC_VOICESCAN_ENABLED` from
the next production build's environment (or set both to `false`/leave unset).
The build-time guard requires them to agree, so there is no state where one
is on and the other silently isn't. No source change is needed to roll back,
mirroring the "no source change to roll forward" property this repair adds.

## R8 / release shrinking

`android.enableMinifyInReleaseBuilds=true` is already the governed setting
(`android/gradle.properties`, pinned by
`__tests__/androidBuild34CertificationGuards.test.js` "Objective F"). No
Voice-specific ProGuard/R8 keep rule exists in
`android/app/proguard-rules.pro`, and this repair did not add one, because
none is demonstrated to be required:

- `KScanVoiceNativeModule` registers through Expo's compiled autolinking
  entry point (`modules/kscan-voice-native/expo-module.config.json` →
  `expo.modules.kscanvoicenative.KScanVoiceNativeModule`, a direct compiled
  reference reachable from the app's generated module list, not a
  runtime/reflective class lookup by string), and its exported functions use
  the `ModuleDefinition` DSL over `Map<String, Any?>` and primitive types —
  there are no custom `Record` data classes whose fields R8 could rename or
  strip via reflection.
- `expo-modules-core` — a direct dependency of this module and already part
  of this app — ships its own consumer ProGuard rules
  (`node_modules/expo-modules-core/android/proguard-rules.pro`), automatically
  applied by the Android Gradle plugin to every consumer. They include
  `-keep,allowoptimization,allowobfuscation class * extends expo.modules.kotlin.modules.Module { public <init>(); public ... definition(); }`,
  which keeps `KScanVoiceNativeModule`'s no-arg constructor and `definition()`
  by construction — exactly the surface the generated registration code and
  the `ModuleDefinition` DSL need at runtime.

This is confirmed by reading the actual shipped consumer rules, not inferred;
step 7 above (inspecting a real R8-shrunk artifact) remains the
artifact-level proof obligation this cannot replace.

## Where the guards live (so this list cannot drift unnoticed)

- Build-time consistency validator: `android/app/build.gradle` (search
  `ANDROID-VOICE-01`).
- Declared manifest exception:
  `config/native-config-authority.json` →
  `platforms.android.buildProfileManifestExceptions.exceptions` →
  `VOICE_SCAN_PRODUCTION_READINESS_CAPABILITY`.
- Parity enforcement: `scripts/check-native-config-parity.js`, exercised by
  `__tests__/nativeConfigParityGate.test.js`.
- Gradle guard structural + truth-table coverage:
  `__tests__/androidBuild34CertificationGuards.test.js`.
- End-to-end state matrix (production default / staging-certification /
  minimal-delta future production / all negative controls):
  `__tests__/androidVoiceProductionReadiness.test.js`.
