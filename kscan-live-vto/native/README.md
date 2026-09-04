# LiveVTO native module — status

**Not built. Not compiled. Not device-tested. Not emulator-tested.**

This directory scaffolds the Section 10 Expo native-view module
(`LiveVTO`) that will eventually own camera → pose → segmentation →
deformation → rendering → capture entirely on the native side, exposing
only the narrow command/event surface defined in
`packages/live-vto-contract/src/nativeView.ts` to JavaScript.

## Why this is scaffolding, not a working module

This session runs in an isolated cloud container with:
- no camera hardware,
- no physical iOS or Android device,
- no macOS host, so no Xcode and no iOS Simulator are possible here at
  all — this is a structural fact about the container OS, not a missing
  install step (`uname` reports Linux; Xcode cannot run on Linux);
- an Android SDK/Gradle toolchain that turned out **not** to be practically
  installable this session: `dl.google.com` (the Android SDK / Google Maven
  host, which also serves the `expo-modules-core` Android AAR) returned
  **403 from this session's egress proxy** on a live check, and separately
  `/dev/kvm` is absent, so even a fully provisioned SDK could not boot a
  hardware-accelerated Android emulator here. A prior version of this note
  called the Android toolchain "plausibly installable but not attempted" —
  a later session attempted it and found it is not installable in this
  specific sandbox, for reasons outside this program's control. See
  `docs/vto-native-device-handoff.md` Section 0 for the full table of
  what was checked.

Every file under `ios/` and `android/` below is hand-written against the
Expo Modules API's documented shape (module definition, view manager,
prop/event declarations) so a developer with a real device and the Expo
CLI (`npx expo run:ios` / `npx expo run:android` from a dev-client build
— **not** Expo Go, per Section 10) has a structurally correct starting
point. Treat every native file here as **unverified against a real
compiler** until someone builds it on real toolchain + hardware and
records the result in `docs/vto-phase1-status.md`.

## What exists

- `ios/LiveVTOModule.swift` — Expo Module definition: registers the
  `LiveVTO` native view, wires the `start/stop/pause/resume/loadGarment/
  switchGarment/capture/dispose` commands from
  `LiveVTOCommands` and the `ready/trackingAcquired/.../fatalError` events
  from `LiveVTOEventName`. Subsystem bodies (camera, pose, segmentation,
  deformation, renderer, capture) are `// TODO` stubs — see file comments
  for exactly which Phase 1/2 section each one implements.
- `ios/LiveVTOView.swift` — the `ExpoView` subclass AVFoundation capture
  will eventually render into.
- `android/.../LiveVTOModule.kt` and `LiveVTOView.kt` — Kotlin mirrors of
  the above using CameraX, once a real build environment exists.
- `ios/LiveVTOPerceptionProvider.swift` and
  `android/.../LiveVTOPerceptionProvider.kt` — the emulator-native
  validation lane's two-mode perception adapter: a `FrameSource` enum
  (`EMULATOR_CAMERA` / `SIMULATOR_CAMERA` / `NATIVE_REPLAY_FIXTURE`), a
  `PerceptionProvider` interface, a `RealLocalPoseProvider` TODO stub, and
  a `NativeReplayPerceptionProvider` that parses the JSON fixture format
  defined in `packages/evaluation/src/nativeReplayFixture.ts`. Same
  unverified-against-a-compiler status as every other file here.

## Explicitly out of scope here (Section 1 non-authorization + physical constraints)

- Bundling a real pose model (MediaPipe Pose Landmarker or Apple's Vision
  body-pose API) — needs a device to validate against, and a deliberate
  model-pinning decision per Section 12.
- Any actual camera permission flow, AVFoundation/CameraX session,
  segmentation inference, or GPU rendering — all require a physical
  device per Section 30 ("Do not claim platform-wide support based on
  simulator/emulator/one flagship phone" — the stronger version of that
  rule is "do not claim *any* device support without ever running on
  one").
