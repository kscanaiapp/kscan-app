# Avatar Engine V10 — Build 35 staging certification

Phase: **Build 35 post-repair source authority, source-level certification.**
Dated 2026-09-07.

## A. Authority

```
BASE            origin/fix/notifications-final-convergence-v1
BASE SHA        219f27aa0f2586d3bded1ca02f751a63d1960c48  (merge of PR #327, merged 2026-09-07)
BRANCH          integration/build35-v10-staging-certification-v1
HEAD            219f27aa0f2586d3bded1ca02f751a63d1960c48  (no source changes — see Section C)
V10 FREEZE SHA  d0a11d6c5bc65728123023cbd36ed4f9140bab9e  (tag v10-sarah-shadow-qa-freeze-2026-08-19)
```

PR #327's merge commit matches the dispatched authority exactly. `d0a11d6` and
the historical integration-readiness tip `5bcd323` are **not** git ancestors of
`219f27a` — Build 35 was assembled by cherry-pick/squash convergence, not a
straight merge chain, so ancestry is the wrong test. Verified instead by
content: `services/avatars/engine/**` is present, and has demonstrably evolved
past the frozen tag (e.g. `engine/config.ts` documents a Build-34-era behavior
change; `avatarVisualMode.ts` no longer exists). Provenance: **VERIFIED by
content, not ancestry.**

## B. Verified starting state (corrects the dispatch's stated hypothesis)

The dispatch for this lane assumed V10 was running in shadow mode with legacy
as the visible authority, gated by `EXPO_PUBLIC_AVATAR_VISUAL_MODE`. That is
**no longer true** and predates this lane:

```
V10 CODE IN APP:             YES
V10 CONNECTED TO HOST:       YES — UNCONDITIONAL, ALL BUILD PROFILES
V10 VISIBLE AUTHORITY:       YES (StyleChatHeader.tsx — the only surface
                              where Elise's mouth animates)
LEGACY VISIBLE AUTHORITY:    NO — no code path can reach it
SHADOW MODE:                 DEAD CODE (avatarShadowBridge.ts; retained only
                              as an instrumentation surface for existing tests)
PRODUCTION ACTIVATED:        YES (unconditionally — see below)
```

Commit `0bbd222` (`fix(avatars): reject the mouth crossfade with evidence,
delete the dead visual gate`, authored by the repo owner, 2026-09-02, an
ancestor of `219f27a`) deleted `services/avatars/avatarVisualMode.ts` and the
`EXPO_PUBLIC_AVATAR_VISUAL_MODE` gate, stating explicitly: *"V10 is the live
visible renderer"*. `StyleChatHeader.tsx` calls
`getAvatarEngineAdapter().computeFrame()` unconditionally on every render, with
no environment or feature-flag check anywhere in the call path. `eas.json`
still sets `EXPO_PUBLIC_ELISE_V10: "true"` in the `staging`/
`staging-certification` profiles and omits it from `production`, but that key
is decorative — nothing in app source reads it, and V10 renders identically in
every build profile including `production`. Pinned by test:
*"no retired visual-mode gate can reactivate legacy rendering in StyleChat"*,
*"no visual-mode environment branch can resurrect the legacy renderer"*
(`avatarEngineEliseConvergence.test.js`, both PASS).

**This was confirmed with the repo owner during this lane as an intentional,
already-shipped decision.** Sections 11/12/38 of the dispatch (build a
staging-only visibility flag, prove flag-off/flag-on, do not promote to
production) are therefore **moot** — there is nothing left to gate, and adding
a new flag now would itself be an undispatched behavior change to a decision
already made and tested. No flag was added.

## C. Changes

**None to application source.** Two local, gitignored, per-developer
environment files were created/replaced in the worktree so the Android build
could run at all (neither is part of the diff, neither ships):

- `android/local.properties` — a hand-written version (via `printf`) mangled
  the Java-properties `\\` escaping and broke `:app` configuration with
  `IOException: The filename, directory name, or volume label syntax is
  incorrect`. Replaced by copying a known-good file from an existing worktree.
- `android/app/debug.keystore` — absent in a fresh worktree; `:app:assembleDebug`
  failed at `validateSigningDebug`. Copied from an existing worktree's debug
  keystore (standard Android debug-only signing, not a release credential).

This certification's only committed artifact is this document.

## D. Staging / Production

```
STAGING MUTATIONS:     0
PRODUCTION MUTATIONS:  0
```

No Supabase, Edge Function, remote config, EAS environment, or release-channel
change was made on either project (staging `yzqjvdfgefveprobvvyw` or
production `wyyuqfdxucjksghsmhry`).

## E. Platform matrix

Structural, not device-measured (see Section N):

| Capability | Android | iOS |
|---|---|---|
| V10 source loaded | SOURCE-PROVEN | SOURCE-PROVEN |
| Same engine semantics | SOURCE-PROVEN — zero `Platform.OS`/`Platform.select` branches anywhere in `services/avatars/**` | same |
| Same host lifecycle | SOURCE-PROVEN — single shared `StyleChatHeader.tsx` | same |
| Speech-first invariant | CI-PROVEN — `AvatarEngineAdapter.computeFrame` is synchronous, never awaited on the audio path (`avatarEnginePurity.test.js`) | same |
| Timing authority | CI-PROVEN, see Section F | same |
| Mouth timeline | CI-PROVEN (`compileTimeline`, `TimelineCursor`) | same |
| Interruption | CI-PROVEN | same |
| Completion reset | CI-PROVEN | same |
| Rapid utterance replacement | CI-PROVEN (`ELISE-NC-002: an A -> B -> A cycle still discards the first generation's reply`) | same |
| Background/foreground | CI-PROVEN at the engine-input level (`foreground` boolean); no dedicated native `AppState` interruption test exists for an *in-progress utterance* — coverage gap, not a known defect | same |
| Audio interruption | PARTIAL — generic phase-based handling is exercised (`terminal native playback failures release the player and close speech once`); the documented iOS/Android `playbackState` divergence (iOS never reports `'idle'`, relies on the 3s stall watchdog) is real and intentional but has no dedicated automated regression pinning the detection-latency difference | PARTIAL, see Android note |
| Reduce Motion | CI-PROVEN — matches a **pre-existing, deliberately tested K Scan product decision** that Reduce Motion stops mouth motion too (not just decorative motion). This is a source-verified divergence from dispatch Section 23's literal text ("mouth movement may remain as functional feedback"); it predates this lane, is pinned by `"Reduce Motion: V10 reproduces the existing K Scan interpretation exactly"`, and was left untouched as out of this lane's repair authority (not a defect — a settled decision) | same |
| Legacy fallback | N/A — no legacy path is reachable; see Section B | same |
| Staging-visible V10 path | N/A — moot, see Section B | same |
| No new API dependency | CONFIRMED — `services/avatars/engine/**` is pure TS, no network/audio/backend import (`avatarEnginePurity.test.js`) | same |
| Device perceptual QA | PENDING-RUNTIME | PENDING-RUNTIME |

## F. Timing

```
ALIGNMENT SOURCE     Character-level provider alignment (TTS response),
                      compiled once per utterance into a frozen interval
                      timeline (services/avatars/engine/speech/compileTimeline.ts)
PLAYBACK CLOCK        expo-audio AudioPlayer.currentTime, one shared cross-
                      platform native module (services/avatars/stylistAudioPlayback.ts)
POSITION INTERVAL     80ms (createAudioPlayer updateInterval: 80) = 12.5Hz,
                      matches the documented "playback progress re-renders
                      this header ~12.5 times a second" in StyleChatHeader.tsx
FRAME STRATEGY        Direct playback-position consumption, no separate
                      high-resolution local clock — the engine has no ambient
                      clock of its own (engine/speech/compileTimeline.ts,
                      "now" is optional and instrumentation-only). Matches the
                      dispatch's documented fallback-acceptable design
                      ("direct playback-position events... intentionally
                      consumed directly").
IDLE-ONLY CADENCE      A separate 2Hz ticker drives idle/breathing/head-tilt
                      only while NOT speaking (avatarIdlePresence.test.js:
                      "the cadence is 2 Hz — presence, not animation"); the
                      two clocks are mutually exclusive by construction
                      ("speech and idle never drive the clock at the same time").
```

Identical on iOS and Android — same `expo-audio` abstraction, same React
component, no native module split.

## G. Latency

Not collected — requires a live authenticated app session and a running TTS
backend call, unavailable in this shell environment. **PENDING-RUNTIME.**

## H. Perceptual QA

Not collected — requires a human watching a real device screen.
**PENDING-RUNTIME.**

## I. Resource / stress

Not device-measured, but a real 5000-iteration bounded-metrics regression
already exists in source and passed: `avatarEngineLifecycle.test.js`,
*"metrics stay bounded across a long session"* — exceeds the dispatch's
suggested 50-lifecycle minimum by two orders of magnitude. **SOURCE/CI-PROVEN**
for the JS-level lifecycle; native CPU/memory trend is **PENDING-RUNTIME.**

## J. Accessibility

`useReducedMotion()` uses React Native's cross-platform
`AccessibilityInfo.isReduceMotionEnabled()` / `reduceMotionChanged` — the
standard shared abstraction, not a platform branch. See Section E for the
Reduce-Motion-includes-mouth-motion note. No dedicated accessibility-tree
regression exists asserting the avatar adds no spurious screen-reader
announcement; the avatar wrap is already marked
`accessibilityElementsHidden` / `importantForAccessibility="no-hide-descendants"`
in `StyleChatHeader.tsx`, which structurally prevents that class of defect.

## K. Cost

```
NEW API CALLS:       0
NEW LLM CALLS:       0
NEW PROVIDERS:       0
```

`services/avatars/engine/**` has no network, audio, or backend import
(`avatarEnginePurity.test.js`, PASS). No change was made to the TTS contract,
Elise generation, or any provider integration.

## L. Regression

```
Root typecheck:                              CLEAN
Avatar/Elise dispatch-required suites:        186 / 186 pass, 0 fail
  (avatarEngineContract, avatarEngineHostAdapter, avatarEngineLifecycle,
   avatarEnginePackage, avatarEnginePurity, avatarShadowMode,
   avatarIdlePresence, avatarEngineEliseConvergence, eliseSpeechInterruption,
   eliseSpeechRealism, stylistSpeechClientLifecycle)
Additional avatar/Elise-adjacent suites run: 104 / 104 pass, 0 fail
  (nativeConfigParityGate 20, eliseStaleCompletionIsolation +
   avatarSpeechMotion + eliseMouthRegistration 24, eliseSystemPromptChainIntegrity +
   homeEliseIntegration 32, eliseThinkingAndPendingUx + todayWithEliseCardUI 28)
Full governed regression (445 test files):    17 failures — 13 match the
  known baseline, 4 unexpected (reproduced in isolation, not a flake). ALL 17
  are in __tests__/curiosityGapPerformance/** (an unrelated lab, see
  project_curiosity_gap_performance_lab_v1). ZERO touch avatars, Elise, or
  speech. Outside this lane's diff fence — recorded, not fixed.
Android native build:                         PASS — :app:assembleDebug
  BUILD SUCCESSFUL in 1m53s, app-debug.apk produced (327MB, compileSdk 36,
  minSdk 24, NDK 27.1.12297006). Two environment-only local-worktree gaps
  found and closed (local.properties escaping, missing debug.keystore) — ​
  neither is a source defect nor part of this PR's diff.
iOS native build:                             NOT ACHIEVABLE — no ios/
  native project exists in this repo at all (would require
  `expo prebuild --platform ios` first), and this host has no macOS/Xcode
  toolchain. PENDING-RUNTIME.
```

## M. Defect ledger

No P0–P3 defects found in V10, its host adapter, or the visible-renderer
handoff. One coverage gap identified (not fixed — no evidence of an actual
behavioral defect, and building a new native-interruption simulation harness
without a device to validate it against risked a false-confidence test):

| ID | Severity | Platform | Location | Gap | Evidence | Disposition |
|---|---|---|---|---|---|---|
| V10-CERT-001 | Coverage gap, not a defect | Both | `stylistAudioPlayback.ts`, `avatarEngineAdapter.ts` | No automated test simulates an in-progress utterance being backgrounded or receiving a native OS audio-session interruption (phone call, audio-focus loss) and asserts mouth motion stops within a bound. Generic phase-based handling likely covers it (interruption/error paths are otherwise fully tested), but this specific scenario isn't pinned. | `stylistAudioPlayback.ts` comment documents the iOS/Android `playbackState` divergence and the 3s stall-watchdog fallback; no test exercises it end-to-end. | Recorded for device QA to close (Section N script), not repaired blind. |

## N. Final verdict

```
SOURCE COMPLETE — DEVICE QA PENDING
```

Source, CI, and one native platform build (Android) are fully verified against
current Build 35 authority. The V10 engine is already the sole, unconditional,
tested visible renderer for Elise across every environment — there is no
shadow-to-visible migration left to perform, confirmed intentional by the repo
owner during this lane. Cross-platform device certification cannot be
performed from this environment (no Android device attached, no iOS toolchain
at all on this Windows host) and remains **PENDING-RUNTIME**, along with
latency baselines, perceptual QA, and cadence/resource measurement on real
hardware.

### Recommended next step for device QA

1. Install `app-debug.apk` (built this lane, see Section L) on a real Android
   device on the `staging` Supabase project.
2. Build and run the equivalent on a real iOS device from a macOS host — this
   lane could not do so.
3. Execute the scripted QA set already established for V10
   (`docs/avatar-engine-v10-sarah-shadow-qa.md`) on both, using the current
   canonical Elise package (`stylist_portrait_01`, per
   `docs/avatar-engine-v10-integration.md`) rather than the historical Sarah
   POC control.
4. Close V10-CERT-001 by observing an in-progress utterance across a real
   backgrounding and a real OS audio interruption (e.g. an incoming call) on
   each platform.

## O. Production status

```
PRODUCTION V10 ACTIVATION:  ALREADY LIVE (predates this lane; not an action
                             taken here — see Section B)
PRODUCTION MUTATIONS:       0
```
