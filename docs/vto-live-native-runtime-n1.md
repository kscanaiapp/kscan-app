# Live VTO Native Runtime N1

Android execution authority for a real, executable, installable native Live VTO runtime. iOS is deferred to N2 (mission section 54).

## Authority

- Precondition (mission section 1 / amendment B0): PR #303 (`feature/vto-phase4-2-catalog-addressability`) merged 2026-09-05T22:25:17Z per explicit owner directive, merge commit `909df8646a690b55c5af6b7b8c80193df64a2ec8`. Phase 4.2's own quota-blocked corpus-measurement closeout remains deferred on the program ledger (owner directive: do not reopen it here, do not wait on provider quota).
- Base / verified integration SHA: `909df8646a690b55c5af6b7b8c80193df64a2ec8` (`integration/backend-kplus-complimentary-staging-v1`), re-fetched and confirmed as an ancestor after the merge -- not assumed from a pre-merge value.
- Branch: `feature/live-vto-native-runtime-n1`, worktree `C:\src\KScan-live-vto-native-n1-20260905`.
- PR: opened draft against `integration/backend-kplus-complimentary-staging-v1` once the first commit landed (GitHub refuses a PR with zero diff).

## What already existed on integration before N1 (do not recreate)

The mission's amendment B3 describes a "P3-C application contract" as already merged. Verified true, not aspirational:

- Feature flag: `constants/featureFlags.ts` -- `EXPO_PUBLIC_LIVE_VTO_ENABLED` -> `LIVE_VTO_ENABLED`, default OFF, absent from every EAS profile (tested).
- Native module name constant: `LIVE_VTO_NATIVE_MODULE_NAME = 'KScanLiveVto'`.
- Command/event contract: `types/vtoLive.ts` -- `LIVE_VTO_COMMANDS`, `LIVE_VTO_EVENTS`, `FORBIDDEN_LIVE_EVENT_PAYLOAD_KEYS`, session states, runtime error states, the clean-frame rule (`assertCleanPersonFrame`), Photoreal intent state machine.
- Native module TS interface: `services/vto/liveVtoNativeModule.ts` -- `LiveVtoNativeModule` (the exact surface a real native module must expose), `describeLiveVtoNativeCapability` (safe, synchronous, total capability check), `getLiveVtoNativeModule` (lazy `requireOptionalNativeModule` lookup).
- Session/capability layers: `services/vto/vtoLiveSession.ts`, `services/vto/vtoLiveCapability.ts`, `hooks/useVtoLiveCapability.ts`, `hooks/useVtoLiveSession.ts`.
- Dev-only simulated harness (`services/vto/vtoLiveHarness.ts`, `EXPO_PUBLIC_LIVE_VTO_HARNESS`): exercises UI states with no frame concept at all. Not touched by N1 -- N1 builds the real path, a different code path gated by the same top-level flag.
- Test suite already governing all of the above: `__tests__/vtoLive*.test.js` (7 files) plus `vtoLiveIntegrationScope.test.js`.
- Existing local Expo Android module precedent: `modules/kscan-voice-native/android` (Kotlin, `expo.modules.kscanvoicenative`) -- used as N1-A's structural template. `modules/kscan-pii-native` is iOS-only, not a template for Android.

Divergences between the mission text and this merged reality are in the defect ledger (N1-ENV-001, N1-ENV-002), not silently resolved.

## Gate status

### N1-A -- module scaffold + registration

New local Expo module `modules/kscan-live-vto-native` (Android only; iOS deferred to N2), registered under `expo.modules.kscanlivevtonative.KScanLiveVtoNativeModule`, linked via `"kscan-live-vto-native": "file:./modules/kscan-live-vto-native"` in root `package.json` -- same pattern as `kscan-voice-native`.

`definition()` exposes exactly one member so far: `Function("getCapability")` (synchronous -- the merged JS adapter calls it without `await`; an `AsyncFunction` here would hand back a Promise and silently break every capability check), returning `{capable: false, runtimeReady: false, runtimeVersion: "n1-a"}`. No `Events()`, no commands yet -- those land gate by gate as their real implementations exist, not speculatively.

**Compile evidence:** `./gradlew projects` -- BUILD SUCCESSFUL, `:kscan-live-vto-native` present in the project graph alongside `:kscan-voice-native`, autolinked with zero manual `settings.gradle` edits. `./gradlew :app:assembleDebug` run for full-app compile + runtime evidence (see environment doc for toolchain versions).

**Runtime evidence -- captured, gate CLOSED.** Temporary diagnostic route `app/dev-n1-diagnostic.tsx`, reached via the app's own existing `EXPO_PUBLIC_DEV_INITIAL_ROUTE` dev harness (no product code touched), calls the real `describeLiveVtoNativeCapability()` adapter path. On the `Pixel_8_Pro` emulator (`sdk_gphone16k_x86_64`), device log:
```
LOG  [N1-A-PROBE] {"present":true,"capable":false,"runtimeReady":false,"runtimeVersion":"n1-a","provenance":"native","reason":null}
```
`present:true` + `provenance:"native"` proves `requireOptionalNativeModule('KScanLiveVto')` genuinely found the compiled module (not the dev harness); `capable:false, runtimeReady:false, runtimeVersion:"n1-a"` are the exact values `KScanLiveVtoNativeModule.kt` returns, proving the round trip crossed the real JS/Kotlin boundary rather than being asserted from source. Full detail: `evidence/vto-live-native-n1/n1a-getcapability-roundtrip.json`.

**N1-A GATE: PASS.** Module compiles (Gradle), registers (project graph + autolinking), JS finds it (`present:true`), `getCapability()` reaches Kotlin and returns truthful values. Local build/runtime notes: emulator dev-server default (`10.0.2.2:8081`) reached an unrelated Metro instance (a separate `node.exe` bound to port 8081, owned by another application on this machine) rather than this session's own Metro (moved to port 8082) -- resolved by writing `debug_http_host=10.0.2.2:8082` directly into the app's `SharedPreferences` via `adb shell run-as` (the same mechanism the in-app Dev Menu's "Change Bundle Location" writes to); worth fixing properly (e.g. a project-level Metro port convention) before this becomes a recurring N1 friction point. Also had to rebuild once with `-PreactNativeArchitectures=x86_64` -- the default all-ABI debug APK (271MB) didn't fit the emulator's free storage (635MB/5.8GB, 90% full) for the atomic install swap.

### N1-B -- first native render

**PASS. Geometry conformance AND physical-device visual evidence both complete.**

Native renderer (`LiveVtoTestRenderView`, `Canvas.drawBitmapMesh`), governed
garment fixture bundled in the APK, P3-A geometry stages 1-5 ported, oracle
conformance measured per control point.

- Fixture: `081350cef7f5c83e05c3e6c1` -- real, ACCEPTED, SYNTHETIC Phase 4
  asset, texture 271x302, mesh 8x10 vertices, 11 control points.
- BodyFrame: golden `neutral-frontal`. Canvas 720x960.
- Reference oracle: `kscan-live-vto` @ `266ab1a`, clean tree,
  `attachment.js` blob `72fbc013`.
- **Max control-point divergence on this fixture and pose: 6.2e-5 px.**
  Full per-point table: `docs/vto-live-native-n1-conformance.md`.
- Scale 0.98258805 native vs 0.98258823 oracle. Rotation 0.0 vs 0.0.
- Rigid gate: `passed:true, findings:[]`. Snapshot validation: no problems.

On-device (physical device: Samsung SM-S936U, Android 16 / API 36,
arm64-v8a) confirmation of the same numbers, captured from logcat, is in
`evidence/vto-live-native-n1/`. The device computes what the JVM
conformance harness computes.

**N1-B PHYSICAL-DEVICE SCREENSHOT: COMPLETE.** `evidence/vto-live-native-n1/n1b-physical-device-screenshot.png`
(full) and `n1b-physical-device-render-closeup.png` (cropped) show a
correctly-shaped garment silhouette with visible landmark markers, captured
on the physical device above. Getting there surfaced N1-ENV-012 (P0): the
renderer's `onDraw` was never actually being invoked by the Android View
system, on ANY device or emulator, since N1-B's inception -- every prior
geometry number was correct and nothing had ever painted a pixel. See the
defect ledger for the full root cause and repair.

Four geometry/rendering defects were found and repaired during this gate
(N1-ENV-004/005/006/012), the first three by running against the oracle
rather than by source review, the fourth by the mandatory physical-device
screenshot this gate's own amendment required.

### N1-C -- deformation conformance

**PASS on measured conformance.**

- Golden BodyFrame set: 13 valid poses + 8 refusal cases,
  `modules/kscan-live-vto-native/goldens/bodyframes.json`, read by BOTH
  runtimes.
- Asymmetric orientation fixture `n1c-asym-fixture`, verified to share zero
  pixels with its own horizontal mirror.
- 42 (fixture, case) pairs, 308 control points, 1600 mesh vertices.

| Measurement | Median | Max |
|---|---|---|
| Control-point delta | 2.68e-5 px | 5.63e-3 px |
| Mesh vertex delta | 2.51e-5 px | 1.04e-4 px |
| Scale delta | 1.85e-7 | 2.94e-6 |
| Rotation delta | 0 rad | 6.31e-8 rad |
| Bounds delta | 5.88e-5 px | 5.20e-3 px |

Unexplained semantic divergences: **0**. Left/right orientation
divergences: **0**. Over the 2 px investigation ceiling: **0**.

**FROZEN TOLERANCE: 0.05 px** per control point -- an order of magnitude
above the observed maximum, ~40x tighter than the investigation ceiling,
and explicitly not set equal to the largest observed error. Rationale and
the float32-vs-float64 root cause: the conformance document.

Two further defects found here: N1-ENV-007 (the native runtime invented
hips where the reference refuses) and N1-ENV-010/011 (the deformation stage
was a placeholder that did not render as a garment, and the mesh grid
convention was off by one). N1-ENV-008 records a defect in the REFERENCE
that the native runtime deliberately does not match.

### N1-D -- native replay

**PASS on architecture and lifecycle.**

Explicit state machine, native replay clock independent of render cadence,
non-vacuous backpressure, safe dispose, safe mid-replay product switching,
enforced privacy boundary. Full detail and the frozen thread topology:
`docs/vto-live-native-n1-runtime-architecture.md`.

| | Produced | Rendered | Dropped | Max slot depth |
|---|---|---|---|---|
| Deterministic, consume every 10th | 601 | 60 | 540 | 1 |
| Free-running producer vs 5 ms consumer, 250 ms | 7471 | 45 | 7425 | 1 |

N1-ENV-009 was found and repaired by its own test (entering ERROR left
renderable geometry in the latest-state slot).

### N1-E -- real local perception

**PASS on real-model execution and architecture. Gate calibration (rigid-gate pass on a real detection) remains open.**

Provider: MediaPipe Tasks Vision Pose Landmarker, `com.google.mediapipe:tasks-vision:1.0.0` (verified current, not assumed), model `pose_landmarker_lite.task` bundled locally (sha256 `59929e1d...`). Full provenance, architecture, and evidence: `docs/vto-live-native-n1-perception.md`.

Real, on-device, physical-device execution confirmed: `PoseLandmarker.detect()` genuinely invoked hundreds of times, returning a real 33-landmark BlazePose result (confidence ~0.9999) against a bundled procedurally-generated synthetic test image (no person imagery). Mapped through `LiveVtoBodyFrameAdapter` (0 adapter-level refusals) and `LiveVtoGeometryPipeline` (unchanged from N1-C) to a real `GeometrySnapshot`, published to the render slot.

Non-vacuous backpressure measured on real hardware with genuine (not simulated) inference latency: 295 produced / 144 inferred / 150 dropped in ~10s, slot depth bounded at 1. Network: 0 bytes attributable to MediaPipe across two independent measurement windows (294 and 218 real inferences) -- including empirical verification of a live third-party report of undocumented MediaPipe telemetry, which was NOT observed in this integration's actual bundled version.

**Open:** the rigid gate consistently rejects the real detected placement on `garment_largely_outside_torso` for the current bundled test image / `n1b-fixture` pairing (N1-ENV-014) -- a real, measured calibration finding, not a pipeline defect (scale and orientation checks pass cleanly; N1-C's own conformance goldens are unaffected). A future test-frame or fixture-pairing refinement is owed before a real detection can be shown reaching a drawn mesh on screen.

### N1-F / N1-G

Not started. Preparation only -- no N1-E code depends on live camera input.
Each gate's own hard requirements apply unchanged.

## Device authority

| Class | Status |
|---|---|
| `PHYSICAL_DEVICE` | **AVAILABLE, USED.** Samsung SM-S936U, Android 16 (API 36), arm64-v8a. |
| `EMULATOR` | USED. `Pixel_8_Pro` / `sdk_gphone16k_x86_64`. Secondary authority. |
| `CI` | Not used for N1 runtime evidence. |
| `EAS_BUILD` | Not used for N1-D; local Gradle is the compile authority. |

Evidence is labelled by class everywhere it appears and never merged into a
generic PASS claim.

**Emulator visual capture is additionally blocked** by the app's own
routing guard: the `__DEV__` diagnostic route is pushed only after the auth
gate settles to `allow`, and the emulator has no authenticated session. The
guard is behaving correctly and was deliberately NOT weakened to obtain a
screenshot -- it is a security surface, and defeating it for evidence would
be a worse outcome than the missing screenshot. The native views do mount
and compute (their probes and logs are captured); it is the on-screen
capture that the guard prevents.

As a substitute that is honest about what it is,
`tools/render-snapshot.mjs` rasterizes the exact mesh vertex array
`Canvas.drawBitmapMesh` consumes, for all 20 review cases
(`evidence/vto-live-native-n1/renders/`). These are **not** device
screenshots and must never be cited as physical-device evidence. They did
their job: N1-ENV-010 was found by looking at one.

## Evidence index

Screenshots/logs/build IDs go under `evidence/vto-live-native-n1/` as each gate closes (mission section 63 -- no committed raw user frames, no committed person imagery).
