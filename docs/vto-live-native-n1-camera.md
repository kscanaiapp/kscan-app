# Live VTO Native Runtime N1-F — Camera-Live (Android + iOS)

Architecture, design decisions, and evidence tiers for N1-F: wiring the
front camera into the existing N1-B..N1-E native pipeline, on both
platforms. Companion to `vto-live-native-runtime-n1.md` (Android gate
status), `vto-live-native-n1-conformance.md` (geometry conformance),
`vto-live-native-n1-runtime-architecture.md` (N1-D replay architecture),
`vto-live-native-n1-perception.md` (N1-E real MediaPipe perception,
provider provenance), and `docs/vto-live-bridge-contract.md` (the shared
cross-platform bridge contract, §2/§10 updated for `camera`/
`getCameraStatsJson`).

Platform parity note (mission section 4): implementation differs
(Android: CameraX; iOS: AVFoundation) but product semantics — the mirror
decision, the backpressure design, the bridge surface, the known
constraints — are identical by construction, described once below and
called out only where a platform genuinely differs.

## What N1-F is, and is not (mission section 7)

N1-F adds exactly one new capability: a live camera frame source. Every
downstream stage is **reused, not rewritten**:

```
CameraX Preview (display)          CameraX ImageAnalysis (perception input)
        |                                    |
        v                                    v
 PreviewView (auto-mirrors           LiveVtoCameraFrameConverter
  front camera; unmodified                  |  (YUV -> Bitmap, rotate, mirror ONCE)
  CameraX default)                          v
                                     LiveVtoCameraController.frameSlot
                                     (LatestStateSlot<PerceptionInputFrame>)
                                             |
                                     LiveVtoPerceptionDriver (UNCHANGED --
                                       same class N1-E built; only its
                                       frameSource lambda is new)
                                             |
                                     LiveVtoPerceptionSession (UNCHANGED)
                                             |
                                     LiveVtoMediaPipePoseProvider (UNCHANGED)
                                             |
                                     LiveVtoBodyFrameAdapter (UNCHANGED)
                                             |
                                     LiveVtoGeometryPipeline / evaluateRigidGate
                                       / LiveVtoDeformation (ALL UNCHANGED)
                                             |
                                     GeometrySnapshot -> geometrySlot -> drawCameraOverlay()
                                       (new, but structurally identical to
                                        the existing drawPerception())
```

New files (both added to `RuntimeBoundaryTest`'s Android-boundary
allowlist, since both genuinely need `android.*`/`androidx.camera.*`):

- `LiveVtoCameraFrameConverter.kt` — `ImageProxy` (YUV_420_888) -> `Bitmap`.
- `LiveVtoCameraController.kt` — CameraX lifecycle (`Preview` + `ImageAnalysis`,
  front camera, permission check).

One minimal, backward-compatible change to existing code:
`LiveVtoPerceptionDriver`'s `frameSource` parameter is now
`() -> PerceptionInputFrame?` (was non-nullable). See that file's own
updated header comment for why: a push-based camera producer feeding a
pull-based fixed-cadence tick has ticks with nothing new to submit, and
returning null there is what makes "submit nothing this tick" the correct
behaviour instead of resubmitting a stale frame or blocking.
`StaticBitmapFrameSource` (N1-D/N1-E) never returns null, so its behaviour
is unchanged.

## The mirror decision (mission section 9)

Applied **once**, in `LiveVtoCameraFrameConverter.toBitmap(imageProxy,
mirror = true)`, to the actual pixel buffer handed to MediaPipe — not
anywhere else:

- The garment **bitmap** (its texture pixels) is never flipped, by this
  file or by the renderer. A backward logo would be P0 (mission section 10)
  and the surest way to avoid it is to never touch the garment asset's own
  pixels at all.
- `LiveVtoBodyFrameAdapter` already does (and continues to do) a **direct,
  unflipped 1:1 mapping** of whatever the provider reports — see that
  file's own header comment, written during N1-E, which explicitly named
  this as N1-F's job: "front-camera mirroring is deferred to N1-F's
  camera-input layer."
- CameraX's `PreviewView` mirrors the live front-camera preview
  **automatically** — this is its documented default behaviour, not
  something this module configures. Because the `BodyFrame` (and the mesh
  derived from it) is computed from the SAME already-mirrored bitmap
  MediaPipe saw, the mesh overlay and the auto-mirrored preview end up in
  the same coordinate space with **no second, independent flip** anywhere
  in the render path — satisfying "mirror the displayed video, never the
  garment texture... do not compensate for mirroring in multiple layers"
  with one transform, applied once, rather than two transforms that could
  drift out of sync.

**This has NOT been empirically verified against a real face** (no
physical device this session — see Evidence tiers below). The logo/
left-right canaries (mission sections 10, 11) are the mandatory next
check the moment a physical Android device is available, per this
project's own established practice (N1-E's onDraw defect was caught
by exactly this kind of physical-device check, not by any numeric
harness).

## Backpressure (mission section 8)

Three independently-counted, single-slot boundaries, all using the SAME
`LatestStateSlot<T>` primitive N1-D/N1-E already proved (`LiveVtoReplayRuntime.kt`)
rather than a new design per boundary:

| Boundary | Mechanism | Counters exposed |
|---|---|---|
| CameraX `ImageAnalysis` -> conversion | `STRATEGY_KEEP_ONLY_LATEST` (CameraX's own) | n/a (library-internal) |
| Conversion -> perception producer tick | `LiveVtoCameraController.frameSlot` | `cameraProduced`, `cameraConsumedByPerceptionTick`, `cameraDroppedBeforePerceptionTick` |
| Perception producer -> inference | `LiveVtoPerceptionSession.inputSlot` (UNCHANGED) | `submittedToPerception`, `droppedBeforePerception` |
| Inference -> render | `LiveVtoPerceptionSession.geometrySlot` (UNCHANGED) | `rendered`, `droppedBeforeRender` |

All exposed as one bounded, aggregate-only JSON via the new
`getCameraStatsJson` bridge member — never a frame, a landmark, or a
BodyFrame (mission section 26), consistent with every other diagnostic
read this module exposes.

## Bridge surface (mission section A7 / privacy boundary)

New, diagnostic-only additions, in the SAME style as `perception`/`replay`
(NOT part of the ten `LIVE_VTO_COMMANDS` the application contract declares
in `types/vtoLive.ts` — those remain unimplemented natively; see the N1-F
architecture-mapping notes for the current state of that gap):

- `Prop("camera")` — start/stop.
- `AsyncFunction("getCameraStatsJson")` — bounded counters, see above.

`RuntimeBoundaryTest.theBridgeSurfaceIsPinned`'s pinned set was updated to
include both, and its "no member name suggests it carries frame data"
check (banning `frame|bitmap|image|pixel|mask|landmark|mesh|texture|buffer`
as substrings) passes against both new names unchanged.

## Android: YUV conversion (mission section 34's hard-problem ceiling)

`ImageProxy` (YUV_420_888) is converted to NV21 by copying each plane
respecting its own reported `rowStride`/`pixelStride` (device/vendor-
specific; never assumed tightly packed), then `YuvImage.compressToJpeg`
+ `BitmapFactory.decodeByteArray`. Documented, revisitable simplification:
a JPEG round-trip is not the most performant possible path (a direct
YUV->RGB matrix or handing MediaPipe a YUV-backed `MPImage` directly would
avoid it), but pose inference itself — not this conversion — is the
dominant per-frame cost (see `vto-live-native-n1-perception.md`'s measured
MediaPipe latency), and `ImageAnalysis`'s `STRATEGY_KEEP_ONLY_LATEST` means
a slower conversion only drops more frames rather than corrupting anything,
per mission section 8. Revisit only if a future thermal/performance pass
(mission section 18) shows this conversion, not inference, is the
bottleneck.

## iOS: AVFoundation wiring and pixel-buffer conversion

Structural counterpart of the Android section above, files under
`modules/kscan-live-vto-native/ios/Camera/`:

- `LiveVtoCameraController.swift` — `AVCaptureSession` owning an
  `AVCaptureVideoPreviewLayer` (display) and an `AVCaptureVideoDataOutput`
  (perception input), front camera
  (`AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front)`).
  `output.alwaysDiscardsLateVideoFrames = true` is the AVFoundation
  equivalent of CameraX's `STRATEGY_KEEP_ONLY_LATEST`. Permission checked via
  `AVCaptureDevice.authorizationStatus(for: .video)`, fails closed to
  `.permissionDenied` rather than letting `AVCaptureSession` throw. One
  `AVCaptureSession` instance is exclusively owned by one controller across
  start/stop — unlike Android's process-wide `ProcessCameraProvider`, each
  `AVCaptureSession` claims hardware independently, so this constraint does
  NOT carry over to iOS (see the constraints list below).
- `LiveVtoCameraFrameConverter.swift` — `CMSampleBuffer` -> `CVPixelBuffer`
  -> `CIImage` -> (oriented + mirrored in ONE call, `.oriented(.leftMirrored)`)
  -> `CGImage` -> `UIImage`, feeding the EXISTING `LiveVtoStaticImageFrame`/
  `LiveVtoMediaPipePoseProvider` unmodified. `.leftMirrored` is the
  well-established constant for "front camera, portrait capture connection"
  (front and back cameras are mounted with opposite physical rotations,
  which is why the analogous back-camera constant would be `.right`, not
  `.left`) — chosen over a manual `CGAffineTransform` specifically because
  `CGImagePropertyOrientation` already has mirrored variants for every
  rotation, removing an entire class of extent/translation arithmetic bugs
  a hand-rolled transform could introduce. The capture connection's
  `videoOrientation` is pinned to `.portrait` — this lane does NOT support
  device rotation for the Live VTO camera screen; revisit only if the
  product needs landscape support.
- The renderer composite (`LiveVtoRenderView.swift`): a `UIView`'s own
  `draw(_:)` paints into its OWN layer, which composites BELOW any of its
  subviews — the Core Animation equivalent of the reasoning that drove
  Android's `dispatchDraw` change. So camera mode adds TWO child views
  instead of drawing into the parent's own `draw(_:)`: a
  `LiveVtoCameraPreviewContainerView` (its `layerClass` overridden to
  `AVCaptureVideoPreviewLayer`, inserted at index 0) for the live video, and
  a `LiveVtoMeshOverlayView` (a plain `UIView` forwarding its own `draw(_:)`
  to a closure) added ABOVE it for the garment mesh — the exact two-layer
  "video underneath, AR-style overlay on top" composition this is a
  standard UIKit pattern for.
- `AVCaptureVideoPreviewLayer` mirrors the live front-camera preview
  automatically (`automaticallyAdjustsMirroring`, its documented default),
  so — exactly like the Android design — the preview and the mesh (derived
  from a `BodyFrame` computed off the SAME already-mirrored analysis
  buffer) land in the same coordinate space with no second, independent
  flip anywhere.
- `NSCameraUsageDescription` is already present in `app.json`/Info.plist
  (added by `expo-camera` for the main Scan flow) — verified, not assumed;
  no new Info.plist entry was needed for this lane.

**Not empirically verified against a real face on either platform** — same
caveat as the Android section above. The logo/left-right canaries are the
mandatory next check on both platforms the moment physical devices are
available.

## Known, documented, prototype-scope constraints

- **`ProcessCameraProvider` is process-wide (Android only).**
  `LiveVtoCameraController.start()` calls `unbindAll()` before binding its
  own use cases. If some other camera-consuming feature in the app (the
  main Scan flow's `expo-camera`-based `LiveScanCamera`) were bound to the
  SAME provider at the exact same moment, starting Live VTO's camera would
  unbind it. Not exercised in normal navigation (different screens), and
  solving it (a shared, app-wide camera-ownership arbiter) is out of scope
  per mission section 5's scope fence against touching unrelated
  application code. **Does not apply to iOS** — each `AVCaptureSession`
  instance owns its own hardware claim independently, so an unrelated
  feature's own session (if it uses a separate `AVCaptureSession`) is
  unaffected by this controller's `unbindAll()`-equivalent reset.
- **Occlusion, capture (`capturePersonFrame`/`capturePreview`), and garment
  switching are NOT implemented by N1-F, on either platform.** Those are
  mission sections 21-31, explicitly separate scope. `camera` mode renders
  exactly one bundled fixture garment (`n1b-fixture`), identically to how
  `perception` mode does today.
- **The rigid gate is calibration-sensitive against real perception input**
  (documented pre-existing finding, N1-ENV-014 — see
  `vto-live-native-n1-perception.md`): real MediaPipe detections against
  the bundled fixture's canvas/scale assumptions have been observed to fail
  `garment_largely_outside_torso` on Android. This is calibration data
  carried over from N1-E, not a new N1-F defect, and not something N1-F's
  own canary tests can distinguish from a genuine camera-input mistake
  without a real face in frame — another reason the physical-device check
  is the mandatory next step, not optional polish. Not yet independently
  re-measured on iOS (no device evidence on either platform this session).
- **iOS camera orientation is pinned to portrait only** (see the iOS
  section above) — a documented, revisitable simplification, not a defect,
  but a genuine product-behavior gap versus a hypothetical landscape-
  capable Live VTO screen.

## Known device-level finding: front camera opens but never streams (Samsung SM-S936U, Android 16)

Physical-device certification (2026-09-06) reached a real HOLD-class finding
after three bounded, evidence-producing repair cycles (mission section 34's
ceiling for camera-ownership-class problems), none of which changed the
symptom:

**Symptom, reproduced every attempt across a clean app reinstall and
multiple fresh relaunches:** `LiveVtoCameraController` transitions to
`RUNNING` (`bindToLifecycle` never throws), but zero camera frames are ever
produced (`cameraProduced: 0` indefinitely) and the preview stays a black
rectangle. `adb shell dumpsys media.camera` shows the camera device genuinely
opened (`Device 1 is open`) but its capture session stuck permanently at
`Device status: UNCONFIGURED` / `No input stream configured. No output
streams configured.` `adb logcat` shows a tight, endless
`SurfaceView ... updateSurface: has no frame` loop and a system-level
`Camera2-FrameProcessorBase: Error waiting for new frames: Connection timed
out (-110)`.

**Root-cause narrowing, by direct evidence, not guesswork:**
- Not a competing app: `dumpsys media.camera`'s active-client list showed
  only `com.kscanai.app` holding the camera at the time of failure.
- Not `PreviewView`'s `SurfaceView`-backed default (cycle 1): switching
  `implementationMode` to `COMPATIBLE` (`TextureView`) did not change the
  symptom. **Kept** as the permanent implementation anyway — it is the more
  broadly-compatible choice for a `PreviewView` embedded the way this
  module embeds it, independent of this specific bug.
- Not the CameraX 1.6.2 release specifically (cycle 2): downgrading all
  four `androidx.camera:*` artifacts to 1.5.3 (the prior stable minor line)
  did not change the symptom. Reverted to 1.6.2 (the current stable
  release) since the downgrade bought nothing.
- Not the dual Preview+ImageAnalysis stream combination (cycle 3): binding
  `Preview` ALONE (temporarily, reverted after the test) still produced
  zero frames and the same `UNCONFIGURED` session.
- A detailed `logcat` trace across the bind sequence shows CameraX
  submitting the initial repeating-request session configuration
  (`UseCaseCameraState#updateState:... streams = [Stream-3, Stream-4]...
  Update RepeatingRequest:...`) chronologically BEFORE the camera device's
  own `Camera open completed` callback fires, immediately followed by the
  vendor HAL tearing down its internal 3A (auto-exposure) session
  (`FastAecDestroy`) and releasing sensor/CSIPHY subdevice handles
  (`ReleaseAllCache`/`ReleaseOneSubDevice`). This is consistent with a
  session-configuration-vs-device-open ordering race in CameraX's
  `camera2-pipe` implementation against this device's specific
  Snapdragon/Samsung CamX camera HAL, which the HAL does not recover from.

**Classification:** this is a genuine CameraX-library/vendor-HAL interaction
issue on this specific piece of hardware, not a defect in this module's own
Kotlin code (the three bisection cycles above each independently ruled out
a category this module DOES control). Per mission section 34's hard-problem
ceiling ("do not endlessly tune symptoms"), no further repair cycles were
spent chasing it this session.

- Cycle 4 (N1-G amendment G1, one bounded pass, 2026-09-06): deferred
  `LiveVtoCameraController.start()` until `PreviewView` has been through a
  real layout pass (`View.post`, after an `OnGlobalLayoutListener` attempt
  did not reliably fire in this RN native-view hierarchy) — kept
  permanently as a correctness improvement, but it did NOT change the
  symptom either. This same pass captured the **confirmed error code**,
  replacing "ordering suspected" with a named, reproducible failure:
  `E Camera2-FrameProcessorBase: FrameProcessorBase: Error waiting for new
  frames: Connection timed out (-110)`, repeating every ~2s, logged by PID
  2240 (`cameraserver`, the SYSTEM camera service — not this app's
  process). `-110` is `ETIMEDOUT`. CameraX's own error tracking
  (`Camera2CameraController` state dumps) shows `last camera error = null`
  throughout — CameraX itself never observes a configuration failure; the
  camera framework's frame-delivery wait times out **below** CameraX,
  between `cameraserver` and the vendor HAL/driver. This is evidence the
  earlier "CameraX/HAL ordering race" description underspecified: the
  failure is not a race CameraX loses, it is the system camera service
  never receiving frames from the driver after a session it believes is
  correctly configured — a hardware/firmware/driver-level fault on this
  specific device, upstream of anything an app process (CameraX, camera2,
  or otherwise) can observe or repair.

```
HOLD -- ANDROID CAMERA RUNTIME
Confirmed error: Camera2-FrameProcessorBase ETIMEDOUT (-110), cameraserver (PID 2240)
```

Everything downstream of the camera boundary (BodyFrame adapter, rigid
gate, deformation, renderer, the bounded backpressure design, the
permission flow this session ALSO fixed -- see below) remains unverified
against a real live feed as a direct consequence, not because those stages
have their own defect. `N1-B`/`N1-D`/`N1-E` (static fixture, deterministic
replay, and synthetic-frame MediaPipe perception) all continued to run
correctly and concurrently on this same device throughout every attempt,
which is itself useful evidence: the camera framework issue is isolated to
the camera pipeline specifically, not a device-wide MediaPipe/rendering
regression.

**A real, separate, and successfully REPAIRED defect found in the same
session:** `services/vto/vtoLiveCameraPermission.ts`'s `loadExpoCamera()`
read `getCameraPermissionsAsync`/`requestCameraPermissionsAsync` off the
`expo-camera` package root, which does not exist in the installed
`expo-camera@17.0.10` (verified directly against its `build/index.js`:
those two functions are private module internals, exported only via the
`Camera` legacy namespace object and the `useCameraPermissions` hook). This
made `ensureLiveCameraPermission()` -- the ONLY permission path Live VTO
uses -- silently and permanently return `{state: 'unavailable', prompted:
false}` on every call, on a real device, before this fix. Confirmed fixed
on-device: after reading `Camera.getCameraPermissionsAsync`/
`Camera.requestCameraPermissionsAsync` instead, the SAME device produced a
real OS permission grant (`{state: 'granted', prompted: true}`). This bug
was NOT specific to N1-F or to this diagnostic screen -- it affected the
real, shipped Live VTO permission flow on every platform build using this
expo-camera version, and would have made Live VTO permanently
non-functional (always reporting the camera as unavailable) the moment
anyone tried to use it for real. `components/scan-room/LiveScanCamera.tsx`
(the main Scan feature) was unaffected because it correctly uses the
`useCameraPermissions` hook, not the broken top-level functions.

## Evidence tiers (mission section 13/19 — do not upgrade one tier into another)

```
ANDROID
COMPILE (Kotlin, full module):        PASS  (:kscan-live-vto-native:compileDebugKotlin)
UNIT/JVM TESTS:                       PASS  (59/59, zero regressions; RuntimeBoundaryTest's
                                             updated boundary allowlist and pinned bridge
                                             surface both assert cleanly against the new files)
FULL APP BUILD (:app:assembleDebug):  PASS
EMULATOR — module mounts/lifecycle:   PENDING-RUNTIME
                                       (the emulator's `__DEV__` diagnostic route is gated
                                        behind an auth guard with no session on the emulator --
                                        the SAME blocker N1-B..N1-E already documented and
                                        which mission section 13 says should not be retried
                                        the same way; not re-attempted this session)
DEVICE (Samsung SM-S936U, Android 16) --
  camera opens, permission grant/deny,
  lifecycle, teardown, N1-B/D/E (static/
  replay/synthetic-perception) all
  continue working normally:          DEVICE-PASS
DEVICE -- live front-camera streaming
  (Preview and/or ImageAnalysis
  actually producing frames):         FAIL -- see "Known device-level finding" below.
                                       Real person/logo/left-right/tracking canaries are
                                       consequently PENDING-RUNTIME: they need a live video
                                       feed to exercise at all, and none is produced on this
                                       device. This is not a "no device" gap -- a real Samsung
                                       SM-S936U was used; the camera pipeline itself does not
                                       stream on it.

iOS
SWIFT SOURCE:                         written this session (ios/Camera/*.swift,
                                       ios/Drivers/LiveVtoPerceptionDriver.swift nullable
                                       frameSource, ios/LiveVtoRenderView.swift camera prop,
                                       ios/KScanLiveVtoNativeModule.swift bridge members)
SWIFTPM HOST TESTS (LiveVtoCore):     N/A for this specific code -- ios/Camera is outside the
                                       LiveVtoCore SwiftPM target by design (matches
                                       ios/Drivers, ios/Perception); LiveVtoRuntimeBoundaryTests'
                                       updated network-surface scan and pinned bridge surface
                                       DO exercise the changed contract and must stay green
                                       (see PR #313's CI for this commit's actual result)
IOS APP BUILD (expo prebuild + pod
  install + xcodebuild, macOS CI):    see PR #313's CI for this commit's actual result -- this
                                       is the REAL compile check for ios/Camera/*.swift (no
                                       local macOS this session; never claimed PASS without CI
                                       evidence)
DEVICE — real camera, real person,
  logo/left-right canaries, tracking
  loss/reacquire, thermal, resource
  stress:                             PENDING-RUNTIME (no physical iPhone, no macOS/Xcode
                                       locally, this session)
```

`N1-F ENGINEERING COMPLETE — DEVICE EVIDENCE PENDING` (mission section 19), both platforms.
