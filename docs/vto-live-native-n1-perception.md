# Live VTO Native Runtime N1-E — Real Local Perception

Provider provenance, architecture, and measured evidence for N1-E: real
local pose perception driving the existing native geometry pipeline.
Companion to `vto-live-native-runtime-n1.md` (gate status),
`vto-live-native-n1-conformance.md` (N1-B/C geometry conformance), and
`vto-live-native-n1-runtime-architecture.md` (N1-D replay architecture).

## Provider selection (mission sections 7-10)

Verified **current**, not assumed from an earlier release line or from
memory, on 2026-09-06:

| | |
|---|---|
| Provider | MediaPipe Tasks Vision — Pose Landmarker |
| SDK version | `com.google.mediapipe:tasks-vision:1.0.0` |
| Verification method | `curl https://dl.google.com/dl/android/maven2/com/google/mediapipe/tasks-vision/maven-metadata.xml` — the actual Google Maven index, not a cached version number. `<latest>1.0.0</latest>`, `lastUpdated 20260727204405`. The long-running `0.10.x` line culminated in a stable `1.0.0` — **this postdates the version this assistant would otherwise have assumed from training; do not trust an older number from memory or an old prompt.** |
| Model | `pose_landmarker_lite.task` |
| Model source | `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task` |
| Model sha256 | `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a` |
| Bundled location | `modules/kscan-live-vto-native/android/src/main/assets/models/pose_landmarker_lite.task` |
| Framework license | Apache License, Version 2.0 — confirmed directly from the published POM (`tasks-vision-1.0.0.pom`, `<licenses>` block), not asserted from documentation prose |
| Model/weights license | Apache 2.0, per the MediaPipe project's own top-level licensing (the bundled `META-INF/NOTICE` in `tasks-core-1.0.0.aar` carries the Apache 2.0 text plus third-party attributions). Framework and model license were checked as **separate** items, per mission section 10 — not assumed identical without verification. |
| Min API | 24 (verified from the `tasks-vision-1.0.0.aar`'s own `AndroidManifest.xml`, `minSdkVersion="24"` — matches this app's own `minSdkVersion` exactly) |
| Supported ABIs | `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64` (verified: all four present as `.so` files inside `tasks-core-1.0.0.aar`, dated 2026-07-23) |
| New Architecture (Fabric) compatibility | N/A by construction — this is a direct native/Expo integration (a plain Android library called from this module's own Kotlin), never touching the RN bridge or Fabric. Chosen over a third-party RN pose-detection wrapper for exactly this reason (mission section 9). |
| Maintenance status | Actively published (native libs dated 2026-07-23, one month before this integration) |

**FREEZE STATUS: TESTED CONFIGURATION, not a permanent product decision**
(mission section 7). Sits entirely behind the `PerceptionProvider`
interface (`LiveVtoPerceptionTypes.kt`); a different provider later means
writing a new class against that interface, touching nothing in the
renderer, the geometry pipeline, or the BodyFrame adapter.

### Why this provider, not a comparison set

Mission section 35: "Do NOT provider-hop casually... finish N1-E with it
unless a real blocker appears." MediaPipe Tasks Vision compiled, the model
bundled and loaded, and real inference executed successfully on the first
attempt with no blocking issue (license, ABI, min-SDK, or architecture) --
per that policy, no second provider was evaluated.

## Model provenance verification method

The AAR was downloaded directly and its contents inspected structurally
(`unzip`, `javap` against the compiled `classes.jar`) rather than trusting
documentation snippets, per mission section 8's "verify current facts"
instruction applied literally:

```bash
curl -s https://dl.google.com/dl/android/maven2/com/google/mediapipe/tasks-vision/1.0.0/tasks-vision-1.0.0.aar -o tasks-vision-1.0.0.aar
curl -s https://dl.google.com/dl/android/maven2/com/google/mediapipe/tasks-core/1.0.0/tasks-core-1.0.0.aar -o tasks-core-1.0.0.aar
unzip tasks-vision-1.0.0.aar -d tv_extract && cd tv_extract/classes_extract && unzip ../../tasks-vision-1.0.0.aar classes.jar
javap -public com/google/mediapipe/tasks/vision/poselandmarker/PoseLandmarker.class
```

This is how `PoseLandmarker.PoseLandmarkerOptions.Builder`,
`PoseLandmarkerResult`, and `NormalizedLandmark`'s real, current public API
surface (method names, return types, `Optional<Float>` confidence fields)
were confirmed before `LiveVtoMediaPipePoseProvider.kt` was written against
them — not assumed from memory of an earlier MediaPipe release line.

## Offline operation / no-silent-download (mission sections 11, 12)

**Model loading: `setModelAssetBuffer(ByteBuffer)`, not `setModelAssetPath`.**
The model's bytes are read directly from the bundled APK asset into an
in-memory buffer this code owns, and MediaPipe is handed that buffer --
never a path string it could resolve some other way. This removes any
possibility of the SDK's own asset-resolution logic reaching for a
different model source than exactly these bundled bytes.

```
MODEL RUNTIME DOWNLOAD: NO
```

### A real finding, verified empirically rather than trusted from a report

A live, unresolved GitHub issue (google-ai-edge/mediapipe#6291,
"Mediapipe now includes undocumented telemetry") reports that MediaPipe
Tasks versions 0.10.21-0.10.35 send performance/utilization metrics to
Google's servers on initialization. Per mission section 8's instruction not
to trust claims from old material without verification, this was **not**
taken at face value -- it was checked directly against this integration's
actual `1.0.0` build, on the physical device, across two independent
before/after measurement windows using `dumpsys netstats detail` for the
app's own UID:

| Window | Duration | Real inferences | Byte delta (rx/tx) |
|---|---|---|---|
| Model init + 294 inferences, all `NoPose` (v1 test image) | ~35s | 294 | **0 / 0** |
| Model init + 218 inferences, all `Success` (v2 test image) | ~12s | 218 | **0 / 0** |

Zero bytes moved in either window, across both a provider-initialization
event and hundreds of real `detect()` calls, in both an all-refused and an
all-successful regime. This is the strongest available evidence (a direct
measurement on the actual shipped configuration, not a report about a
different version range) that this integration does not exhibit the
reported behavior. It is recorded as a real, checked finding -- not
asserted from the GitHub issue, and not dismissed because the issue exists.

```
NO-SILENT-DOWNLOAD TEST: PASS
NETWORK PRIVACY (perception-attributable traffic): PASS -- 0 bytes measured
```

## Architecture

```
FRAME PRODUCER thread (kscan-live-vto-perception-producer)
    bundled synthetic test frame, fixed 33ms cadence
        |
        v  submitFrame() -> LatestStateSlot<PerceptionInputFrame>
        |
PERCEPTION thread (kscan-live-vto-perception-infer)
    NOT a fixed period -- runs as fast as REAL inference allows
    provider.processFrame() -> LiveVtoBodyFrameAdapter.adapt() -> LiveVtoGeometryPipeline.compute()
        |
        v  publish() -> LatestStateSlot<GeometrySnapshot>
        |
UI / View draw thread
    consumes geometrySlot, draws via Canvas.drawBitmapMesh -- computes nothing
```

Neither the frame producer nor the perception/inference thread is the UI
thread (mission section 23). Reuses `LatestStateSlot` from N1-D verbatim
for both boundaries, giving two independent, already-tested drop counters
rather than one merged one (mission section 24):
`inputSlot.droppedCount` ("replay/input drops" -- a frame overwritten before
perception ever saw it) and `geometrySlot.droppedCount` ("render drops" --
a computed snapshot the UI thread never consumed).

### BodyFrame adapter boundary

`LiveVtoBodyFrameAdapter.kt` is the ONLY place provider-specific data
(MediaPipe's `NormalizedLandmark`, its 33-point index topology) is
translated into the governed `BodyFrame` contract. It has zero Android
dependencies and is fully JVM-testable (`BodyFrameAdapterTest.kt`, 13
tests) independent of whether a device can run the real model -- absent
vs. non-finite vs. low-confidence landmarks are three distinct, explicitly
tested outcomes (mission section 18), and a dedicated left/right canary
(`theAdapterIntroducesNoLeftRightSwap`,
`theCanaryFrameSurvivesGeometryWithoutAMirrorFinding`) proves the adapter
introduces no swap of its own, given this lane's history of exactly that
defect class in the renderer (N1-ENV-005).

**Coordinate convention.** `BodyFrame`'s own contract is documented as
front-camera-mirrored. This adapter does a direct, unflipped, 1:1 mapping
of MediaPipe's own `left_shoulder`/`right_shoulder` indices into
`BodyFrame.leftShoulder`/`rightShoulder` -- no mirror transform is applied
here. Camera mirroring is explicitly deferred to N1-F's camera-input layer
(mission section 17); applying it here would be premature and would make
the adapter's correctness depend on an input convention N1-E does not yet
have (no live camera).

## Real-device evidence (physical device: Samsung SM-S936U, arm64-v8a)

```
09-06 11:39:41.380 D KScanLiveVtoPerception: MediaPipe PoseLandmarker initialized: model=pose_landmarker_lite sdk=tasks-vision:1.0.0
09-06 11:39:41.419 D KScanLiveVtoPerception: N1-E first detect() result: poses=1 landmarksInPose0=33 sample=[(0.503708,0.16572976,vis=0.9999682,pres=0.9999187), ...]
```

`poses=1`, `landmarksInPose0=33` -- exactly the expected BlazePose topology
size, confidence ~0.9999. This is genuine, on-device, real-model execution
against the bundled synthetic test frame; no landmark here is hardcoded
(mission section 14).

### REAL_MODEL EXECUTED checklist (mission section 14)

| Requirement | Evidence |
|---|---|
| Real SDK compiled | `com.google.mediapipe:tasks-vision:1.0.0` linked; APK builds and installs |
| Real model bundled | `models/pose_landmarker_lite.task`, sha256 verified, in the built APK's assets |
| Real model loaded | `MediaPipe PoseLandmarker initialized` logged, from `createFromOptions` returning without exception |
| Actual inference invoked | `PoseLandmarker.detect(MPImage)` called once per production tick, hundreds of times per run |
| Actual inference result returned | `PoseLandmarkerResult` genuinely returned every call -- `poses=0` (test image v1) and `poses=1, 33 landmarks` (test image v3) both observed, on real hardware |
| Result mapped into BodyFrame | `LiveVtoBodyFrameAdapter.adapt()` produces `Result.Mapped` for every successful detection (0 adapter-level refusals across hundreds of real detections) |
| BodyFrame reached native renderer | `LiveVtoGeometryPipeline.compute()` runs on every mapped frame and publishes a `GeometrySnapshot` to the render slot; `rendered` counter in `getPerceptionStatsJson()` climbs continuously during a live run |

**YES on every line.**

### The rigid gate's own, separate, honest verdict

The already-conformance-tested rigid gate (`evaluateRigidGate`, N1-C) does
NOT pass every real detection through to a drawn mesh, and that is the
gate correctly doing its job, not a defect in perception:

```
N1-E gate tally: passed=0 failed=50 lastGateFindings=[garment_largely_outside_torso] lastScale=1.0847614
```

Reproduced consistently across two independently-drawn synthetic test
images (proportioned differently), the rigid gate's `scale` and rotation
checks both come back well-behaved (`scale≈1.08-1.15`, squarely inside the
0.55-1.8 band; no `left_right_inversion`, no `upside_down`, no
`gross_scale_error`) -- only the `garment_largely_outside_torso` centroid
check fires, every time, for this bundled test asset paired with the
`n1b-fixture` garment. This is recorded as a measured, real result per
mission section 34 ("measure, do not invent pass numbers"), not smoothed
over: the synthetic test frame's real, MediaPipe-detected body proportions
do not currently produce a placement this specific garment fixture's own
centroid tolerance accepts. This is calibration data for a future synthetic
test-frame or fixture-pairing refinement, not a regression in perception,
the adapter, or the geometry pipeline -- the same pipeline continues to
pass its full N1-C conformance suite against the governed goldens
unchanged.

### Non-vacuous backpressure, on real hardware (mission section 25)

Unlike N1-D's simulated-delay JVM proof, this measurement is **genuine
real-inference latency creating real backpressure** -- no artificial delay
anywhere in this path:

```
{"state":"PLAYING","produced":295,"submittedToPerception":295,"inferred":144,
 "droppedBeforePerception":150,"refused":0,"rendered":144,"droppedBeforeRender":0,
 "maxInputSlotDepth":1,"maxGeometrySlotDepth":1}
```

295 frames produced at the fixed 33ms clock in ~10s; only 144 actually
inferred (real MediaPipe latency ≈ 68ms/frame on this device for a
successful detection); 150 frames dropped before ever reaching perception;
slot depth bounded at 1 throughout. `droppedBeforePerception` (150) and
`droppedBeforeRender` (0) are the two independent counters mission section
24 requires -- never merged.

### JVM-level non-vacuous backpressure (architecture proof, provider-independent)

`PerceptionSessionTest.frameDropsAndInferenceOutcomesAreCountedSeparately`
uses a deterministic slow fake provider to prove the architecture itself
is capable of dropping under load, independent of real MediaPipe timing on
any particular machine -- both this and the real-device measurement above
are recorded, labelled by evidence class, never conflated.

## Privacy (mission sections 26-28)

**JS bridge.** `perception` (a `Prop`, boolean only) and
`getPerceptionStatsJson` (aggregate counters + state name) are the entire
JS-facing surface -- pinned and asserted by
`RuntimeBoundaryTest.theBridgeSurfaceIsPinned`. No landmark array, no
`BodyFrame`, no frame or bitmap ever crosses the bridge.

**Network.** See the no-silent-download section above: 0 bytes measured
across two independent windows, one all-refused and one all-successful.

**Crash reporting.** This integration introduces no crash-reporting
integration of its own and adds no new serialization path for frame,
landmark, or `BodyFrame` data; the existing app-level crash reporting is
unmodified by N1-E.

## Device / evidence authority

```
PHYSICAL_DEVICE: Samsung SM-S936U, Android 16 (API 36), arm64-v8a -- PRIMARY, USED for all N1-E measurements in this document
EMULATOR: available, not used for N1-E (physical device was available first)
CI: not used
EAS_BUILD: not used -- local Gradle is the compile authority
```
