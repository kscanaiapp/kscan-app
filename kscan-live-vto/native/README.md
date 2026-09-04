# LiveVTO native module — status

**Not built. Not compiled. Not device-tested in this session.**

This directory scaffolds the Section 10 Expo native-view module
(`LiveVTO`) that will eventually own camera → pose → segmentation →
deformation → rendering → capture entirely on the native side, exposing
only the narrow command/event surface defined in
`packages/live-vto-contract/src/nativeView.ts` to JavaScript.

## Why this is scaffolding, not a working module

This session runs in an isolated cloud container with:
- no camera hardware,
- no physical iOS or Android device,
- no Xcode (iOS builds require macOS + Xcode; unavailable here),
- an Android SDK/Gradle toolchain that is plausibly installable but that
  this session did not attempt to exercise, since a Gradle build with no
  device/emulator to actually run on would prove nothing beyond "the
  Kotlin compiles" — and even that has not been verified here.

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
