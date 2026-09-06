# Live VTO Native Runtime N1-F — Camera-Live (Android)

Architecture, design decisions, and evidence tiers for N1-F: wiring the
front camera into the existing N1-B..N1-E native pipeline. Companion to
`vto-live-native-runtime-n1.md` (gate status), `vto-live-native-n1-conformance.md`
(geometry conformance), `vto-live-native-n1-runtime-architecture.md` (N1-D
replay architecture), and `vto-live-native-n1-perception.md` (N1-E real
MediaPipe perception, provider provenance).

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

## YUV conversion (mission section 34's hard-problem ceiling)

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

## Known, documented, prototype-scope constraints

- **`ProcessCameraProvider` is process-wide.** `LiveVtoCameraController.start()`
  calls `unbindAll()` before binding its own use cases. If some other
  camera-consuming feature in the app (the main Scan flow's
  `expo-camera`-based `LiveScanCamera`) were bound to the SAME provider at
  the exact same moment, starting Live VTO's camera would unbind it. Not
  exercised in normal navigation (different screens), and solving it
  (a shared, app-wide camera-ownership arbiter) is out of scope per
  mission section 5's scope fence against touching unrelated application
  code.
- **Occlusion, capture (`capturePersonFrame`/`capturePreview`), and garment
  switching are NOT implemented by N1-F.** Those are mission sections
  21-31, explicitly separate scope. `camera` mode renders exactly one
  bundled fixture garment (`n1b-fixture`), identically to how `perception`
  mode does today.
- **The rigid gate is calibration-sensitive against real perception input**
  (documented pre-existing finding, N1-ENV-014 — see
  `vto-live-native-n1-perception.md`): real MediaPipe detections against
  the bundled fixture's canvas/scale assumptions have been observed to fail
  `garment_largely_outside_torso`. This is calibration data carried over
  from N1-E, not a new N1-F defect, and not something N1-F's own canary
  tests can distinguish from a genuine camera-input mistake without a real
  face in frame -- another reason the physical-device check is the
  mandatory next step, not optional polish.

## Evidence tiers (mission section 13/19 — do not upgrade one tier into another)

```
COMPILE (Kotlin, full module):        PASS  (:kscan-live-vto-native:compileDebugKotlin)
UNIT/JVM TESTS:                       PASS  (59/59, zero regressions; RuntimeBoundaryTest's
                                             updated boundary allowlist and pinned bridge
                                             surface both assert cleanly against the new files)
FULL APP BUILD (:app:assembleDebug):  see vto-live-native-runtime-n1.md gate log for this date
EMULATOR — module mounts/lifecycle:   PENDING-RUNTIME
                                       (the emulator's `__DEV__` diagnostic route is gated
                                        behind an auth guard with no session on the emulator --
                                        the SAME blocker N1-B..N1-E already documented and
                                        which mission section 13 says should not be retried
                                        the same way; not re-attempted this session)
EMULATOR/DEVICE — real camera,
  real person, logo/left-right
  canaries, tracking loss/reacquire,
  thermal, resource stress:           PENDING-RUNTIME (no physical Android device attached
                                       this session; emulator evidence for any of these would
                                       not be REAL-PERSON evidence per mission section 13 even
                                       if the auth-guard blocker above were worked around)
```

`N1-F ENGINEERING COMPLETE — DEVICE EVIDENCE PENDING` (mission section 19).
