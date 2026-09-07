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

Both platforms expose the SAME 7 bridge members, mechanically pinned by a
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

No `Events()` channel exists on either platform at this gate — every
transition Android emits internally (`ReplayEvent`) stays inside the native
process; the bridge only exposes pull-based, rate-limited, aggregate reads.
iOS reproduces this exactly: `LiveVtoRenderView`'s replay/perception
sessions fire `ReplayEvent` callbacks that only trigger a `setNeedsDisplay()`,
never a bridge `sendEvent`.

**Banned substrings** (both platforms' boundary tests enforce this on every
member name): `frame`, `bitmap`, `image`, `pixel`, `mask`, `landmark`, `mesh`,
`texture`, `buffer`. None of the 7 names above contain any of them.

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
| No person imagery | perception exercises a bundled procedurally-generated synthetic test image, never a live camera frame | same bundled PNG, byte-identical copy |

All of the above is **PASS(STATIC)** evidence — proven by reading source, not
by observing a running process. See the FINAL REPORT for which claims, if
any, reach PASS(RUNTIME).

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
