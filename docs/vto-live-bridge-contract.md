# Live VTO — Native Bridge Contract (v1)

Derived from the ACTUAL compiled Android implementation at
`ANDROID_NATIVE_PIN_SHA = 69167c9532d03c5533c8ee9987378d57fc0b5360`
(`feature/live-vto-native-runtime-n1`, PR #308) — not from the aspirational
TS interface, not from memory, not from prose documentation alone. Every
claim below was verified by reading the named source file at that SHA. This
document is versioned (see `docs/vto-live-native-n1-ios-catchup.md` for the
lane using it), not permanently frozen: a future gate that changes the
Android implementation must update this document and re-verify iOS against
it, per amendment/mission section 12.

---

## 0. Two contracts, not one — read this before anything else

This module sits under **two distinct contracts** that must not be conflated:

1. **The aspirational P3-C application contract** — `services/vto/liveVtoNativeModule.ts`'s
   `LiveVtoNativeModule` interface (`start`/`pause`/`resume`/`stop`/
   `loadGarment`/`switchGarment`/`capturePersonFrame`/`capturePreview`/
   `requestPhotorealCapture`/`dispose`, plus a `'liveVtoEvent'` listener
   carrying the 10 events in `types/vtoLive.ts`). This is what the app will
   eventually need from a real Live VTO runtime. **Neither platform
   implements this today.** It requires a live camera, which is explicitly
   out of scope for this catch-up lane (mission section 6) and for Android's
   own N1 lane (N1-F/G, "not started" per `docs/vto-live-native-runtime-n1.md`).

2. **N1's actual diagnostic surface** — the real, shipped, mechanically-pinned
   bridge Android's `RuntimeBoundaryTest.theBridgeSurfaceIsPinned` enforces.
   This is a gate-evidence scaffold, not a product surface. **This is what
   this catch-up lane reproduces on iOS.**

**SHARED CONTRACT QUESTION, resolved:** should this catch-up lane implement
contract (1) or contract (2)? Resolution: **(2), N1's real surface.**
Implementing (1) here would be leapfrogging Android, not catching up to it —
Android has not proven `start`→`ready`→`trackingAcquired`→`capturePersonFrame`
works on any platform, so there is nothing for iOS to "catch up" to in that
contract yet. Building it first on iOS, alone, unreviewed against a live
camera on either platform, would mean the FIRST real implementation of the
shared product contract has zero cross-platform verification — the opposite
of this lane's purpose. Camera work (mission section 46) is the correct place
for contract (1) to be built, jointly, on both platforms.

---

## 1. Module identity

| | Android | iOS |
|---|---|---|
| Registered name | `Name("KScanLiveVto")` — `KScanLiveVtoNativeModule.kt:33` | `Name("KScanLiveVto")` — `KScanLiveVtoNativeModule.swift` |
| JS lookup key | `constants/featureFlags.ts:198` `LIVE_VTO_NATIVE_MODULE_NAME = 'KScanLiveVto'` | same constant, unchanged |
| `expo-module.config.json` | `"android": {"modules": ["expo.modules.kscanlivevtonative.KScanLiveVtoNativeModule"]}` | **ADDED THIS LANE**: `"apple": {"modules": ["KScanLiveVtoNativeModule"], "podspec": "ios/KScanLiveVtoNative.podspec"}` |
| Native class | `expo.modules.kscanlivevtonative.KScanLiveVtoNativeModule` (Kotlin) | `KScanLiveVtoNativeModule` (Swift, `Module` subclass) |

**Classification: ABSENT, not STALE.** `expo-module.config.json` had no `"ios"`/`"apple"` key at all before this lane — there was no prior iOS stub to go stale. This is new scaffolding, not a repair.

---

## 2. Commands (the real, pinned surface)

Both platforms expose the SAME 18 bridge members, mechanically pinned by a
source-scanning test on each side (Android: `RuntimeBoundaryTest.kt`; iOS:
`LiveVtoRuntimeBoundaryTests.swift`):

| Member | Kind | Owner | Purpose |
|---|---|---|---|
| `getCapability` | `Function` (sync) | Module | Registration self-check |
| `active` | `Prop` (View) | View | Static N1-B canned-pose diagnostic render |
| `getGeometrySnapshotJson` | `AsyncFunction` (View) | View | One-shot geometry snapshot, rate-limited to 1/sec |
| `replay` | `Prop` (View) | View | Start/stop the N1-D deterministic replay clock |
| `getReplayStatsJson` | `AsyncFunction` (View) | View | Bounded aggregate replay counters |
| `perception` | `Prop` (View) | View | Start/stop the N1-E real-perception pipeline |
| `getPerceptionStatsJson` | `AsyncFunction` (View) | View | Bounded aggregate perception counters |
| `camera` | `Prop` (View) | View | Start/stop the N1-F LIVE front-camera pipeline (CameraX / AVFoundation feeding the SAME perception/geometry/render stack `perception` already proved) |
| `getCameraStatsJson` | `AsyncFunction` (View) | View | Bounded aggregate camera+perception counters |
| `capturePersonFrame` | `AsyncFunction` (Module) | Module | N1-G: the ONLY capture that may feed the generative path (§12) |
| `capturePreview` | `AsyncFunction` (Module) | Module | N1-G: composited local-display-only capture (§12) |
| `start` | `Function` (sync, Module) | Module | Part B: begin the session (§13) |
| `pause` | `Function` (sync, Module) | Module | Part B: pause a RUNNING session (§13) |
| `resume` | `Function` (sync, Module) | Module | Part B: resume a PAUSED session (§13) |
| `stop` | `Function` (sync, Module) | Module | Part B: idempotent teardown, session may `start()` again (§13) |
| `loadGarment` | `Function` (sync, Module) | Module | Part B: load a garment before/while starting (§13) |
| `switchGarment` | `Function` (sync, Module) | Module | Part B: atomic garment swap while RUNNING/PAUSED/READY (§13) |
| `dispose` | `Function` (sync, Module) | Module | Part B: terminal, idempotent teardown (§13) |

**Events.** `Events("liveVtoEvent")` (Part B, §13) is the one bridge event
channel on both platforms, carrying exactly `types/vtoLive.ts`'s
`LiveVtoEvent` shape (`{type, timestamp, payload}`) for the ten names in
`LIVE_VTO_EVENTS`. Every OTHER transition either platform tracks internally
(`ReplayEvent`, `CameraControllerState`, perception session state) stays
inside the native process exactly as before — this channel exists
specifically to feed `services/vto/vtoLiveSession.ts`'s already-implemented,
already-tested reducer, and carries nothing per-frame.

**Banned substrings** (both platforms' boundary tests enforce this on every
member name): `frame`, `bitmap`, `image`, `pixel`, `mask`, `landmark`, `mesh`,
`texture`, `buffer` — except the two already-governed exceptions
`capturePersonFrame`/`capturepersonframe` (§12.1). None of the other 17
names above contain any of them.

**N1-F note:** `camera`/`getCameraStatsJson` are diagnostic-only additions in
the SAME style as `perception`/`replay`. Full camera-lane design (mirror
decision, backpressure design, known constraints, evidence tiers):
`docs/vto-live-native-n1-camera.md` (Android + iOS).

---

## 3. Capability response

```
Function("getCapability") -> { capable: Bool, runtimeReady: Bool, runtimeVersion: String? }
```

Both platforms return `capable: false, runtimeReady: false` — **"registration
is not capability"** (both native module header comments say this verbatim).
Neither platform has implemented device-eligibility detection or runtime
initialization. `runtimeVersion` is a free-text diagnostic field, not part of
any pinned contract: Android emits `"n1-a"`; iOS emits `"n1-a-ios"`
(deliberately distinguishable so a captured log names which platform
answered — see `KScanLiveVtoNativeModule.swift`).

`getCapability` is a synchronous `Function` on both platforms, never
`AsyncFunction` — the application-side adapter
(`services/vto/liveVtoNativeModule.ts:describeLiveVtoNativeCapability`) calls
it without `await`; an `AsyncFunction` here would hand JS a `Promise` where a
plain object is expected and silently fail every capability check on either
platform.

---

## 4. State enums

### `ReplayState` (N1-D) / perception session state (N1-E, reuses the same enum)

```
IDLE, LOADING, READY, PLAYING, PAUSED, EOF, STOPPED, ERROR, DISPOSED
```

Identical on both platforms — Android: `enum class ReplayState` in
`LiveVtoReplayRuntime.kt:37-47`; iOS: `enum ReplayState: String` in
`LiveVtoReplayRuntime.swift`, with `rawValue`s matching Android's names
exactly (`"IDLE"`, `"LOADING"`, ... `"DISPOSED"`) so a logged state string is
byte-identical across platforms.

Transition table (both platforms, verified identical by
`LiveVtoReplayRuntimeTests.testLifecycleFollowsTheDeclaredStateMachine` on
iOS against the same scenarios as Android's `ReplayRuntimeTest.kt`):

```
IDLE --load--> LOADING --ok--> READY --start--> PLAYING <-> PAUSED
                  |                                |
                  +--fail--> ERROR                 +--stop--> STOPPED --start--> PLAYING
                                                    +--exhausted--> EOF --restart--> PLAYING
any state --dispose--> DISPOSED   (terminal, idempotent)
```

An illegal operation from the current state is a refused no-op returning
`false` on both platforms — never a thrown exception (Kotlin) / never a
trap (Swift).

### Perception-specific state (N1-E)

Reuses `ReplayState` directly (not a separate enum) — `LiveVtoPerceptionSession`
on both platforms transitions through `IDLE → LOADING → READY → PLAYING →
STOPPED/ERROR/DISPOSED` (no `PAUSED`/`EOF` — perception has no "end of
sequence" and no pause concept at this gate).

---

## 5. Error taxonomy

Three layers, none of them the aspirational `LIVE_VTO_RUNTIME_ERROR_STATES`
(that taxonomy belongs to contract (1) above and is unused by either
platform's N1 diagnostic surface):

1. **Geometry pipeline refusal reasons** (`LiveVtoGeometryPipeline.Refusal`
   on Android, `LiveVtoGeometryPipeline.Refusal` on iOS — identical string
   values): `missing_shoulders`, `missing_hips`, `degenerate_shoulder_span`,
   `degenerate_body_axis`, `non_finite_landmark`,
   `missing_garment_control_points`, `degenerate_garment_span`,
   `non_finite_geometry`.
2. **Rigid-gate findings** (not refusals — the pipeline still produces a
   `GeometrySnapshot`, just with `gatePassed: false`): `left_right_inversion`,
   `upside_down`, `gross_scale_error`, `neckline_outside_upper_torso`,
   `garment_largely_outside_torso`.
3. **Perception adapter outcomes** (`LiveVtoBodyFrameAdapter.Result`):
   `Mapped` / `NoUsablePose(reason)` / `InvalidProviderOutput(reason)` —
   identical three-way split on both platforms, and the same absent-vs-
   non-finite-vs-low-confidence policy (section 6 below).

---

## 6. BodyFrame — coordinate convention, absence, and confidence policy

`BodyFrame` is **deliberately not promoted** to `types/vtoLive.ts` on either
platform (`docs/vto-live-integration-manifest.md`, "Deliberately not
promoted": *"BodyFrame, segmentation masks, pose landmarks, the body proxy,
the deformation/renderer math, and the device-capability thresholds. Those
stay native."*). There is no shared TS source of truth. Both platforms
hand-declare the identical field set as a field-for-field re-declaration of
the disjoint research history (`kscan-live-vto/packages/live-vto-contract/src/bodyFrame.ts`),
never an import — mechanically enforced by
`scripts/check-vto-live-integration-scope.js` on Android and by this lane's
adherence to the same non-import discipline on iOS.

- Coordinates: normalized `[0,1]`, origin top-left, front-camera-mirrored
  convention (documented as "the wearer's own left is at the LOWER u" — a
  property of what a live camera frame is EXPECTED to look like once
  front-camera mirroring is applied at the capture stage; **not** something
  either platform's `BodyFrameAdapter` applies itself. Both adapters do a
  direct, unflipped, index-to-field mapping).
- Absence: a landmark the provider did not report at all -> `Absent`
  (Kotlin `Landmark.Absent`, Swift `.absent`) — never a guessed `(0,0)`.
- Non-finite: a landmark the provider reports as present but with a NaN/
  Infinite coordinate or confidence -> the WHOLE FRAME is rejected as
  `InvalidProviderOutput`, never partially mapped, on both platforms.
- Low confidence: a CRITICAL landmark (shoulders, hips) below
  `MINIMUM_LANDMARK_CONFIDENCE = 0.5` (identical constant, both platforms) is
  demoted to `Absent`, not passed through — "the renderer treating unreliable
  geometry as strong tracking" is what this policy exists to prevent, on
  both platforms identically.

---

## 7. Session / replay semantics

- **Backpressure**: a single-slot `LatestStateSlot<T>` (identical name, both
  platforms) — depth always 0 or 1, overwrite-on-publish is a counted DROP,
  never a queue. Android: `AtomicReference`/`AtomicLong`. iOS: `NSLock`-guarded
  plain state (Swift has no direct `AtomicReference` equivalent in the
  standard library at this deployment target; a single lock around all
  slot operations is a strictly safe, if marginally more conservative,
  substitute for the same bounded guarantee — verified non-vacuous on iOS by
  `LiveVtoReplayRuntimeTests.testProducerOutrunningConsumerDropsStaleFramesAndStaysBounded`
  and `.testProducerClockIsIndependentOfRenderCadence`, mirroring Android's
  own two backpressure tests).
- **Threading**: production + geometry compute run off the main/UI thread on
  both platforms. Android: a dedicated daemon thread via
  `Executors.newSingleThreadScheduledExecutor`, `scheduleWithFixedDelay` (not
  `scheduleAtFixedRate` — a slow tick must not burst catch-up ticks). iOS:
  a dedicated serial `DispatchQueue` using a recursive `asyncAfter`
  reschedule-after-completion pattern for the SAME fixed-delay (not
  fixed-rate) semantics, since `DispatchSourceTimer`'s repeating mode is
  fixed-RATE and would reintroduce the exact queueing behavior fixed-delay
  forbids. Perception's inference loop is a raw `Thread` tight loop (matching
  Android's `Executors.newSingleThreadExecutor` + `while` loop) with a 5ms
  backoff when idle — real inference latency, not a simulated delay, paces
  this loop on both platforms.
- **Garment identity comparison** (`advance()`'s "did the active garment
  change while geometry was computing" guard): Android compares by
  **reference** (`garment !== activeGarment`, since Kotlin's
  `KsgarmentManifest` is a heap object). iOS's `KsgarmentManifest` is a Swift
  **value type** with no reference identity, so iOS compares by **structural
  equality** instead — a deliberate, documented, provably-safe substitution
  (see `LiveVtoReplayRuntime.swift`'s inline comment): the only scenario
  where the two could disagree is a `selectGarment` reload with
  byte-identical manifest content, where discarding vs. keeping the in-flight
  snapshot are equally correct outcomes.

---

## 8. Perception provider

| | Android | iOS |
|---|---|---|
| Provider | MediaPipe Tasks Vision Pose Landmarker | same |
| Package | `com.google.mediapipe:tasks-vision:1.0.0` (Gradle) | `MediaPipeTasksVision` `1.0.0` (CocoaPods) — verified current against CocoaPods trunk 2026-09-06; Android's version verified current against Google Maven metadata at N1-E integration time. Both pin the SAME release. |
| Model | `pose_landmarker_lite.task`, bundled | same file, byte-identical (sha256 verified equal at copy time — see section 9) |
| Running mode | `RunningMode.IMAGE` (single-frame) | `.image` (single-frame) — a live camera pipeline (`.liveStream`) is explicitly out of scope for this lane on both platforms |
| Thresholds | `numPoses=1`, all confidence thresholds `0.5` | identical |
| Segmentation masks | never requested (`setOutputSegmentationMasks(false)`) | never requested — the iOS options object simply never sets a mask-output flag |
| Model loading | `setModelAssetBuffer(ByteBuffer)` — reads the bundled asset into memory, explicitly to remove any possibility of the SDK resolving a different model source | `PoseLandmarkerOptions.baseOptions.modelAssetPath` — the iOS Tasks Vision Swift API does not expose a public in-memory-buffer loading entry point the way the Android API does (**PRODUCT-CONTRACT-LEVEL PLATFORM DIFFERENCE, not an implementation defect** — verify against the installed SDK once real compilation is available; if a buffer-based loader does exist it should be preferred for exact parity). The path used points at a file this module bundled into its own resource bundle (`KScanLiveVtoNativeAssets.bundle`), never a user-writable or network location, so the underlying guarantee (the SDK cannot resolve a "different" model) still holds even though the loading MECHANISM differs. |
| Checksum enforcement | `config/on-device-model-authority.json`, `scripts/check-on-device-model-authority.js` (repo-provenance gate) | SAME governance file, new record `live-vto-pose-landmarker-lite-ios` (same sha256). **Additionally enforced at runtime**, not just in the governance manifest: `LiveVtoMediaPipePoseProvider.initialize()` computes the bundled file's SHA-256 (via `CryptoKit`) and refuses to load (returns `false`, `perceptionReady` stays `false`) if it does not match `approvedModelSha256` — satisfying mission section 30's "must also be enforced by the runtime/model loader," which the Android side satisfies only via the repo-provenance gate, not a runtime check. This is an iOS ADDITION beyond parity, not a divergence that weakens anything. |

**Perception confidence figure**: MediaPipe Tasks Vision's iOS Swift API
surface (as documented) does not expose a distinct overall pose-level
confidence separate from per-landmark visibility/presence the way the
translate step might want; the iOS provider uses the minimum per-landmark
confidence as a conservative stand-in for `poseConfidence`. **Flagged for
verification once real compilation/execution is available** — if the iOS SDK
does expose an equivalent overall figure, prefer it for exact parity with
whatever Android's `PoseLandmarkerResult` surfaces.

---

## 9. Model governance

`config/on-device-model-authority.json` gained one new `approvedModels`
record, `live-vto-pose-landmarker-lite-ios`, pointing at
`modules/kscan-live-vto-native/ios/Assets/models/pose_landmarker_lite.task`.
Verified **byte-identical** to the Android copy at commit time:

```
sha256 (both copies): 59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a
```

`modelFreeModules` (`modules/kscan-pii-native`) is untouched — this record
does not touch that categorical prohibition.

---

## 10. Privacy boundary

| Guarantee | Android mechanism | iOS mechanism |
|---|---|---|
| No network surface | `RuntimeBoundaryTest.theNativeRuntimeHasNoNetworkSurface` — greps for `okhttp`/`retrofit`/`HttpURLConnection`/etc. | `LiveVtoRuntimeBoundaryTests.testTheNativeRuntimeHasNoNetworkSurface` — greps for `URLSession`/`CFNetwork`/`NWConnection`/etc., same PASS(STATIC) evidence class |
| No runtime model download | `setModelAssetBuffer` reads only the bundled APK asset | `modelAssetPath` resolves only within the module's own bundled resource bundle; the SHA-256 runtime check (section 8) additionally fails closed on any substituted file |
| Bridge payload allowlist | `ReplayEvent.ALLOWED_PAYLOAD_KEYS` mechanically pinned | `ReplayEvent.allowedPayloadKeys` (Swift `Set<String>`), identical 4 keys (`state`, `fixtureId`, `sourceId`, `error`), asserted by `LiveVtoReplayRuntimeTests.testReplayEventsCarryOnlyBoundedStateAndNoFrameData` |
| Bridge member naming | banned substrings (section 2) | identical banned-substring list, checked by `LiveVtoRuntimeBoundaryTests.testTheBridgeSurfaceIsPinned` |
| Rate-limited diagnostic read | 1 distinct read/sec (`DIAGNOSTIC_SNAPSHOT_MIN_INTERVAL_NANOS`) | identical bound (`diagnosticSnapshotMinInterval = 1.0` sec) |
| No person imagery (`perception`/`replay`/`active` modes) | exercises a bundled procedurally-generated synthetic test image, never a live camera frame | same bundled PNG, byte-identical copy |
| Camera frames never cross the bridge (`camera` mode, N1-F) | the live front-camera frame stays inside `LiveVtoCameraController`/`LiveVtoMediaPipePoseProvider`/the geometry pipeline; only bounded aggregate counters (`getCameraStatsJson`) reach JS, same banned-substring enforcement as every other member | identical design (`LiveVtoCameraController`/`LiveVtoMediaPipePoseProvider`), same `getCameraStatsJson` shape |

All of the above is **PASS(STATIC)** evidence — proven by reading source, not
by observing a running process. See the FINAL REPORT for which claims, if
any, reach PASS(RUNTIME). N1-F specifically introduces the first REAL live
camera frames into this runtime (mission section 7) — the "no person
imagery" guarantee for `perception`/`replay`/`active` is unaffected (those
modes are still synthetic-only), and the camera path's privacy guarantee is
"never crosses the bridge," not "never exists," see the row above.

---

## 11. Known platform-level items carried forward, not resolved here

- **iOS Tasks Vision buffer-loading API** (section 8) — verify once real
  Xcode/SDK access exists; does not block this lane's engineering closure
  since the underlying privacy/governance guarantee holds regardless.
- **iOS overall pose confidence figure** (section 8) — same status.
- **`willNotDraw`-class bug is Android/View-specific** — UIKit's `UIView`
  has no equivalent "silently never call `draw(_:)`" default the way
  `ViewGroup` does, so this SPECIFIC defect class cannot recur on iOS. The
  BROADER lesson it established — numeric geometry conformance passing does
  not prove anything actually rendered a pixel — still applies, which is why
  this lane still treats a real-device screenshot as a required (not
  optional) PAINT gate, currently `PENDING-RUNTIME` (see FINAL REPORT).

---

## 12. Capture (N1-G) — `capturePersonFrame` / `capturePreview`

Unlike every member in §2 (diagnostic-only, View-scoped), these two are the
first REAL members of the aspirational application contract (§0) to be
implemented — `types/vtoLive.ts`'s `LIVE_VTO_COMMANDS`, already promoted
and already called by `services/vto/vtoLiveSession.ts`'s `capture()` (both
platforms match this exactly: no view ref, called directly on the module
object returned by `requireOptionalNativeModule('KScanLiveVto')`).

### 12.1 Contract shape (unchanged from `types/vtoLive.ts`)

```ts
type LiveVtoCapturedFrameKind = 'PERSON_FRAME' | 'PREVIEW';
interface LiveVtoCapturedFrame {
  captureId: string;
  kind: LiveVtoCapturedFrameKind;
  localUri: string;      // file:// URI -- never bytes, never base64
  width: number | null;
  height: number | null;
}
```
`capturePersonFrame(): Promise<LiveVtoCapturedFrame>` and
`capturePreview(): Promise<LiveVtoCapturedFrame>` reject (never resolve
`null`/an error object) on failure — `NO_ACTIVE_SESSION` (no Live view is
currently mounted) or `CAPTURE_UNAVAILABLE` (a view is mounted but has no
clean/composited source available yet, e.g. camera mode with zero frames
published). `vtoLiveSession.ts`'s `capture()` already catches both cases
and resolves `null` to its own caller either way — this document records
the two REASONS a rejection happens, `vtoLiveSession.ts` does not
distinguish between them today.

### 12.2 The clean-frame rule, and where it is enforced

`assertCleanPersonFrame()` (types/vtoLive.ts) is the ONLY gate: a capture
is safe to hand to Photoreal generation if and only if `kind ===
'PERSON_FRAME'`. This document adds the corresponding NATIVE-side
guarantee the JS-side gate depends on: `capturePersonFrame()` and
`capturePreview()` read from DISJOINT source fields on both platforms --
neither method's implementation touches any field the other reads
(Android: `LiveVtoTestRenderView.captureCleanFrame()` reads
`cameraController.frameSlot`/`perceptionSourceBitmap`, never
`cameraBitmap`/`perceptionBitmap` (the garment) or the mesh;
`captureCompositedFrame()` rasterizes the View via `draw(Canvas)` and
never touches the clean-frame fields at all. iOS: the same split between
`captureCleanFrame()` (`cameraController.frameSlot`/`perceptionSourceImage`)
and `captureCompositedFrame()` (`layer.render(in:)`), field-for-field).
There is no shared helper, no dimension comparison, no "does this look
composited" heuristic — the two paths are structurally incapable of
converging on the same pixels by construction, not by convention.

### 12.3 Clean-frame source per mode (both platforms, identical priority)

| Mode | `capturePersonFrame()` source | Notes |
|---|---|---|
| `camera` | latest published camera frame (`frameSlot.peek()`, non-destructive) | Real physical-camera evidence `PENDING-RUNTIME` — see `docs/vto-live-native-n1-camera.md`'s `HOLD -- ANDROID CAMERA RUNTIME`; this method is wired to the same controller and returns null honestly (not a fabricated result) while that HOLD stands |
| `perception` | the bundled synthetic test image perception itself infers against | No camera concept in this mode |
| `replay` / `active` / none | — | No person-frame concept exists in these modes; returns null |

`capturePreview()` has no per-mode table: it rasterizes whatever is
currently on screen (`View.draw`/`layer.render(in:)`) uniformly, which is
exactly why it can never accidentally converge with the clean-frame path
(§12.2).

### 12.4 Capture atomicity and lifecycle invariants

- **One session owns capture, same as camera ownership** (mission section
  14): both platforms register the currently-mounted view in a
  process-wide, `weak`-referenced static slot
  (`LiveVtoTestRenderView.currentInstance()` / `LiveVtoRenderView
  .currentInstance`) that the module-level `capturePersonFrame`/
  `capturePreview` functions read. `weak` on both platforms: a
  leaked/forgotten reference can never keep a destroyed view alive, and a
  stale reference from a torn-down session resolves to nil/null rather
  than resurrecting it -- this is the capture-specific instance of "late
  native callbacks cannot resurrect disposed sessions."
- **Stop/unmount invalidates the registry entry synchronously**: both
  platforms clear the registry in their detach path
  (`onDetachedFromWindow` / `didMoveToWindow` with `window == nil`) BEFORE
  any pending capture on that instance could complete, and again
  defensively in `deinit`/finalization. A capture call arriving after
  detach sees `NO_ACTIVE_SESSION`, never a torn-down view.
- **Switch-during-capture atomicity**: `captureCleanFrame()`/
  `captureCompositedFrame()` each read their source bitmap/image and the
  currently-loaded garment/mesh state SYNCHRONOUSLY, in one call, on
  whichever thread the bridge invokes them on -- there is no
  intermediate `await` between reading the garment state and rasterizing,
  so a `switchGarment` that completes strictly before or strictly after a
  capture call is well-defined; one that raced INSIDE a single capture
  call is not possible because there is no suspension point inside it for
  a concurrent switch to land in.
- **One-shot privacy boundary**: neither method has a "keep capturing"
  mode -- each call captures exactly one frame, synchronously, on demand.
  There is no periodic/background variant of either function anywhere in
  the bridge surface (mechanically enforced by §2's pinned-surface tests,
  now extended to include these two names).

### 12.5 Data retention (mission section 19)

Both platforms write to their own app-private cache location only, never
shared/external/photo-library storage, never logged:
- Android: `context.cacheDir/live-vto-captures/<uuid>.png`
- iOS: `FileManager.default.urls(for: .cachesDirectory, ...)[0]/live-vto-captures/<uuid>.png`

Lifetime is bounded to the mounted view's lifetime: the SAME detach path
that clears the instance registry (§12.4) also deletes the entire
`live-vto-captures` directory. A capture the caller has not yet consumed
(uploaded via the governed Photoreal handoff, displayed, or otherwise
persisted elsewhere) before the Live session ends is deleted with the
session, not kept as a stray temp file.

### 12.6 What this section does NOT cover

As of Part B (§13), `start`/`pause`/`resume`/`stop`/`loadGarment`/
`switchGarment`/`dispose` are implemented on both platforms. Two things
remain true from N1-G and are unchanged by Part B:
- `requestPhotorealCapture` has no native counterpart and needs none: it is
  a JS-level orchestration (`hooks/useVtoLiveSession.ts`'s
  `requestPhotoreal()` — already implemented, already tested) over the
  native `capturePersonFrame` this section documents.
- `capturePersonFrame`/`capturePreview` STILL work against whichever
  diagnostic mode (`camera`/`perception`) is active, exactly as before, for
  any view whose session was never started (§13.4) — this is what keeps
  the G3 real-staging test flow (dev-only, `perception`-mode) working
  unchanged by Part B.

## 13. Session control surface (Part B, 2026-09-06)

### 13.1 Two state machines, not one

`types/vtoLive.ts`'s `LiveVtoSessionState` (`INITIALIZING`/`READY`/
`TRACKING`/`TRACKING_WEAK`/`TRACKING_LOST`/`GARMENT_LOADING`/
`CAPTURE_READY`/`ERROR`) is the JS-facing vocabulary a UI renders, and
`services/vto/vtoLiveSession.ts`'s `reduceLiveVtoSession` (already
implemented, already tested) already owns it exhaustively — Part B does not
touch or duplicate that reducer.

What was missing was the layer BELOW it: a NATIVE-internal state machine
answering "is this command valid right now", independent of what the
camera/perception pipeline is doing frame-to-frame. That is
`LiveVtoSessionState`/`LiveVtoSessionMachine` (Android:
`LiveVtoSessionState.kt`; iOS: `ios/Core/LiveVtoSessionState.swift`, zero
platform imports, `swift test`/JVM-testable with no device):

```
CREATED → STARTING → RUNNING ⇄ PAUSED → STOPPING → STOPPED → (STARTING again)
   ↓          ↓          ↓         ↓          ↓
   └────────────────→ GARMENT_LOADING (from CREATED/STARTING/READY/STOPPED,
   |                   or from RUNNING/PAUSED/READY via switchGarment)
   └────────────────→ CAPTURING (from RUNNING/PAUSED only, single-flight)
   any state ──dispose()──→ DISPOSED (terminal, idempotent)
```

Full (state × command) allow-list, every named invariant
(no-start-after-dispose, no-duplicate-start, pause-only-from-running,
resume-only-from-paused, stop/dispose-idempotent,
capture-cannot-outlive-disposed, capture-is-single-flight,
failed-garment-load-cannot-pretend-ready, switch-cannot-attach-to-stale),
and every required race (stop-while-starting, dispose-while-starting,
garment-switch-during-start, stop-during-garment-load,
dispose-during-capture, rapid A→B→C garment switch) are exercised as pure
transition-table tests: `LiveVtoSessionStateTest.kt` /
`LiveVtoSessionStateTests.swift`, one-to-one ports of each other.

### 13.2 Wiring: reuses the pipeline, does not duplicate it

`startSession()`/`stopSession()`/`pauseSession()`/`resumeSession()` drive
the SAME `cameraController`/`cameraPerceptionSession`/
`cameraPerceptionDriver` fields the diagnostic `camera` Prop already owns,
via the SAME `startCamera()`/`stopCamera()` — there is no second
CameraX/AVFoundation pipeline. `STARTING → RUNNING` is driven off the SAME
`CameraControllerState.RUNNING`/`.running` signal the diagnostic camera
stats already report. Per the confirmed HOLD evidence
(`docs/vto-live-native-n1-camera.md`), `bindToLifecycle`/AVFoundation's own
bind succeeds on the certified device even though the HAL never delivers a
frame afterward — that is a downstream tracking-quality fact (the JS
`TRACKING_LOST` state), not a native `start()` failure, so `start()` reaches
`RUNNING` on this device class despite the carried camera HOLD.

`pauseSession()`/`resumeSession()` stop/start the perception driver without
tearing down the camera or perception session — `resumeSession()` restarts
the SAME driver rather than rebuilding the pipeline.

### 13.3 Generation/epoch protection

A monotonic counter (`sessionGeneration`, `AtomicInteger`/`Int32`) is bumped
on every `start()`/`stop()`/`dispose()`. Both platforms' completion
callbacks (camera-ready, garment-load success/failure) are guarded by the
session state itself rather than a separately-threaded generation parameter
for the camera-ready signal specifically: `handleCameraControllerStateForSession`
only acts while `sessionState == STARTING`, and both that callback and every
session command run on the main thread (Expo dispatches View-touching
`Function` calls there; the camera controller's own listener is posted via
the main executor), so a stop/dispose that already moved the state off
`STARTING` has already made a late completion a no-op by construction. The
explicit generation check is used for garment loads (`performGarmentLoad`),
which is the correct pattern for when a real async network-backed resolver
replaces the current bounded fixture (§13.5) — a stale load's completion for
an old epoch is dropped silently rather than overwriting a newer one.

### 13.4 Capture, gated only once a session is engaged

`captureCleanFrame()`/`captureCompositedFrame()` check
`beginCaptureIfSessionActive()` first: if `sessionState == CREATED` (a
session was never started on this view), the check passes through with NO
state change — §12's existing capture behavior against whichever
diagnostic mode is active is completely unaffected, which is what keeps the
dev-only G3 real-staging test flow (perception-mode capture) working
unchanged. Once a session HAS been started, capture is gated exactly like
every other command: `RUNNING`/`PAUSED` only, single-flight (a second
capture while one is in flight is refused, not queued), and refused outright
once `STOPPED`/`DISPOSED`.

### 13.5 Garment loading: a bounded scope decision

There is no live product-catalog → native-asset resolver anywhere in this
codebase (confirmed by research): `vto-phase4-pipeline/` is an offline
batch tool producing committed fixtures, not a runtime dependency, and this
section previously (§12.6, pre-Part-B) documented `loadGarment`/
`switchGarment` themselves as future work with no design on file. Rather
than inventing a network fetch or a new asset-factory, `loadGarment`/
`switchGarment` validate the descriptor (`productRef`/`imageUrl`/
`canonicalCategory` non-blank; `templateFamily` ∈ `t-shirt`/`simple-top`/
`sweater`, `types/vtoLive.ts`'s `LIVE_SUPPORTED_TEMPLATE_FAMILIES`) and
resolve EVERY supported family to the SAME governed bundled fixture (§12.3's
`n1b-fixture`) the diagnostic view already renders. `productRef`/
`assetVersion` (from the real, decoded `KsgarmentManifest`) are carried
honestly in the `garmentLoaded` event for identity — nothing about them is
fabricated — but a distinct visual asset per product is not yet addressed.
This is real, bounded, and documented here rather than silently assumed;
closing it (a real catalog → `.ksgarment` resolver) is future work.

### 13.6 Events emitted

`ready` (on `RUNNING`), `garmentLoaded` (`{productRef, assetVersion}`),
`fatalError` (`{state: 'RUNTIME_INITIALIZATION_FAILED'|'CAMERA_PERMISSION_DENIED'|'GARMENT_UNSUPPORTED', recoverable}`).
`trackingAcquired`/`trackingWeak`/`trackingLost`/`trackingRecovered`/
`captureReady`/`privacyStateChanged`/`performanceChanged` are declared in
`LIVE_VTO_EVENTS` and consumed by the JS reducer but are not yet emitted by
either native platform — they describe per-frame tracking quality, which is
downstream of the carried camera HOLD and out of Part B's scope (session
lifecycle, not tracking quality).

### 13.7 Defect found and fixed during verification: main-thread dispatch

A synchronous Expo `Function` (unlike a View `Prop` setter, which Expo
already guarantees runs on the main/UI thread) is dispatched on the JS
bridge's own background thread by default. `startSession()` constructs a
`PreviewView` (Android) / adds `LiveVtoCameraPreviewContainerView` and
`LiveVtoMeshOverlayView` as subviews (iOS), all of which require the main
thread. The first on-device attempt at `start()` threw a real
`IllegalStateException` from `PreviewView`'s constructor
(`Threads.checkMainThread()`), confirmed via a captured stack trace — not
assumed. `AsyncFunction` has a `.runOnQueue(Queues.MAIN)` modifier for
exactly this; the synchronous `Function` builder does not (confirmed by a
Kotlin "Unresolved reference" compile error when tried). Fixed with a
manual blocking main-thread dispatch on both platforms: a small
`runOnMainThreadBlocking` helper (`Handler`/`CountDownLatch`) on Android,
`DispatchQueue.main.sync` on iOS — both preserve the exact synchronous,
throwing-or-not contract `sendLiveVtoCommand` depends on. Re-verified live
on-device after the fix: `start()` now reaches `RUNNING` and emits `ready`
through the real bridge (see §14 evidence log).

## 14. G3 + Part B live verification evidence (2026-09-06)

Real, on-device evidence gathered against the physical certified device
(Samsung SM-S936U), signed in as a real staging actor with real K+
entitlement, in this exact order:

1. `capturePersonFrame()` via `perception` mode (no camera needed) →
   real capture, `kind=PERSON_FRAME`, real dimensions.
2. Negative control: real `capturePreview()` output (`kind=PREVIEW`) fed
   into the real `buildPhotorealPersonInput` → refused,
   `code=no_usable_still`.
3. `start()` → `ready` event received through the real `liveVtoEvent`
   bridge channel, confirming `RUNNING` was reached despite the carried
   camera HOLD (native `CameraControllerState` log: `STARTING` → `RUNNING`
   — `bindToLifecycle` succeeds; the HOLD is downstream frame delivery,
   not session startup).
4. `pause()` accepted from `RUNNING`.
5. `resume()` accepted from `PAUSED`.
6. `switchGarment(B)` while `RUNNING` → real `garmentLoaded` event with the
   correct `productRef` for B (not a stale A).
7. `loadGarment(A)` while `RUNNING` → correctly REJECTED ("not valid from
   the session's current state" — `switchGarment` is the correct command
   once running).
8. `stop()` accepted from `RUNNING`.
9. `dispose()` accepted (idempotent, never throws).
10. `start()` after `dispose()` → correctly REJECTED (no-start-after-dispose).
11. `capturePersonFrame()` after `dispose()` → correctly REJECTED ("no clean
    person frame is currently available" — capture-cannot-outlive-disposed).

Every rejection above is a REAL thrown `CodedException` propagated through
the Expo bridge to JS, not a simulated/unit-tested outcome — confirmed by
reading the exact error text back off the device. G3's own real-staging
Photoreal calls are covered separately in the mission's final report
(three bounded calls, all `rate_limited`/`submit_http_429` from the
third-party provider itself, confirmed via staging function logs).
