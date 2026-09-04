# Live VTO — Native Device Handoff

**Nothing in this document is validated.** No native code in this program has
been compiled, and none has run on any device or emulator/simulator. This is
the specification a developer with a physical device and a real toolchain
needs in order to produce the first device evidence — and the criteria by
which the pose-model decision should be made when someone is in a position to
measure rather than guess.

## 0. Emulator-native validation lane — this session's environment findings

A later authorization asked this program to compile and mount the native
module in a simulator/emulator as an intermediate step short of a physical
device (Section 1's plan already anticipated this: "Do not claim platform
support from a simulator, an emulator, or a single flagship" — the emulator
lane exists to get *architecture* evidence, not device-quality evidence,
before a physical device is available). This session attempted that and
could not proceed past the assessment step, for reasons specific to *this
cloud sandbox*, recorded here so a future session does not repeat the
exploration:

| Check | Result |
|---|---|
| macOS host | Absent (Linux container: `uname -a` → `Linux ... x86_64 GNU/Linux`). Xcode requires macOS; this is not installable into a Linux host by any amount of session time. |
| `xcodebuild`, `xcrun`, `swift` | Not found |
| iOS Simulator | Not available — requires Xcode |
| Android SDK (`$ANDROID_HOME`) | Not installed; unset |
| `adb`, `emulator` binaries | Not found |
| `/dev/kvm` | Absent — no hardware-accelerated virtualization, so even a fully provisioned Android SDK could not boot an AVD at usable speed inside this container |
| Network reachability to `dl.google.com` (Android SDK components, Google's Maven — including the `expo-modules-core` Android AAR) | **403 from this session's egress proxy** — confirmed live, not assumed. Blocks even a compile-only Gradle attempt, independent of the KVM/emulator-binary gaps above. |
| Network reachability to `repo1.maven.org` (Maven Central) | 200 — reachable, but does not host the Android dependencies this build needs |
| Java, Gradle | Present (OpenJDK 21, Gradle 8.14.3) — necessary but not sufficient without the two blockers above |
| `native/android/livevto` | Source files only; no `build.gradle`/`settings.gradle` exists yet, so there is no Gradle project to invoke even before the network/KVM gaps |

**Conclusion for this session:** both platforms' "MANDATORY: compile the
native module" step is **NOT AVAILABLE**, for reasons that are properties of
this specific execution environment (no macOS host is possible here at all;
Android is blocked by network policy and missing virtualization, not by
missing effort). This is not evidence of a defect in the native scaffolding,
and it is not the same claim as "physical-device blockers" — see
`docs/vto-physical-device-blockers.md`, which is about what even a
*successful* emulator run could never certify. This section is about why no
emulator run was possible here at all.

**What this session did instead**, staying within what is honestly
achievable without a native compiler or runtime:

- Extended `native/ios/LiveVTOPerceptionProvider.swift` and
  `native/android/.../LiveVTOPerceptionProvider.kt` with the Section 4
  two-mode `FrameSource` / `PerceptionProvider` shape
  (`RealLocalPoseProvider` TODO stub + `NativeReplayPerceptionProvider`
  reading the JSON fixture format below) — still unbuilt, still unverified
  against a real compiler, same status as every other file under `native/`.
- Added `packages/evaluation/src/trackingStateMachine.ts` — the
  `trackingAcquired`/`trackingWeak`/`trackingLost`/`trackingRecovered`
  reference logic the native code above will eventually port, tested in
  Node against the existing synthetic golden sequences, with a boundary
  test proving its emitted payloads cannot carry a forbidden key.
- Added `packages/evaluation/src/nativeReplayFixture.ts` — the
  `NATIVE_REPLAY_FIXTURE` JSON format `NativeReplayPerceptionProvider`
  parses, plus a validator and round-trip tests.
- Added a static-renderer test proving a JSON-round-tripped `BodyFrame` (a
  stand-in for a native pipeline's export, since no native pipeline ran)
  renders pixel-identically through the full pipeline — Section 11's
  compatibility check, honestly scoped: it proves format compatibility, not
  native execution.
- Ran a static source audit (`grep` across every native and package source
  file) for network primitives (`URLSession`, `HttpURLConnection`,
  `fetch`, `XMLHttpRequest`, `axios`, sockets, …): none exist anywhere in
  this codebase today. This is real but weak evidence — nothing runs yet,
  so of course nothing calls the network. It is not a runtime capture and
  must not be cited as one; see the emulator-native validation lane's
  Section 7 for what a real offline/privacy test requires.

A session with the required toolchain (a macOS host for iOS; an Android SDK,
KVM-capable host, and unrestricted network egress to `dl.google.com` for
Android) starts from these files rather than the bare TODO stubs this
program began with.

## 1. Architecture

The Expo native view owns the whole loop. JavaScript never sees a frame.

```
        ┌──────────────────────── LiveVTO native view ────────────────────────┐
        │                                                                     │
 camera │  AVFoundation / CameraX                                             │
   ───► │        │                                                            │
        │        ▼                                                            │
        │  perception (pose, later segmentation) ──► BodyFrame (in-process)   │
        │        │                                                            │
        │        ▼                                                            │
        │  body state (One Euro filter, BodyProxy)                            │
        │        │                                                            │
        │        ▼                                                            │
        │  garment state ──► deformation ──► renderer ──► surface             │
        │                                                                     │
        └───────────────────────────────┬─────────────────────────────────────┘
                                        │ narrow, low-frequency
                                        ▼
                    JS:  start/stop/pause/resume/loadGarment/
                         switchGarment/capture/dispose
                    JS:  ready, trackingAcquired/Weak/Lost/Recovered,
                         garmentLoaded, captureReady, qualityChanged,
                         thermalChanged, privacyState, fatalError
```

The contract is `packages/live-vto-contract/src/nativeView.ts`, and it is the
source of truth: the Swift and Kotlin files mirror it, never the reverse.
`FORBIDDEN_EVENT_PAYLOAD_KEYS` names the keys that may never appear in an
event payload (`frame`, `pixels`, `imageData`, `mask`, `segmentationMask`,
`landmarks`, `bodyFrame`, `pose`) and is regression-guarded by
`tests/privacy/localOnlyDataClasses.test.js`.

**Why this shape.** A per-frame BodyFrame crossing the bridge would be both a
performance problem and a privacy one: it would put body landmarks into the JS
heap, into any JS-side logging, and within reach of any JS dependency. Keeping
perception in-process makes "pose data never leaves the native view" a
structural property rather than a policy.

### What the headless renderer already settles

`packages/static-renderer` is an evaluation renderer, not a native one, but
its semantics are the ones the native renderer must reproduce:

- **Mirroring convention.** Landmark and control-point names are the wearer's
  anatomical side; in the selfie-oriented frame the wearer's left sits at
  lower `u`. Get this wrong and the logo canary shows it immediately.
- **Attachment contract.** `computeControlPointTargets` derives every garment
  control point's destination from body landmarks (`SHOULDER_SEAM_OUTSET`,
  `HIP_LENGTH_HEM_DROP`, `SHORT_SLEEVE_FRACTION`).
- **Rigid stop gate.** Port `evaluateRigidGate` before porting deformation:
  it catches left/right inversion, upside-down placement, gross scale error,
  neckline misplacement, and a garment that has left the torso.
- **Deformation.** Affine MLS over the manifest's grid mesh, control points
  interpolated exactly.
- **Layer order.** person → garment → foreground limbs → UI.

Do **not** treat the headless PNGs as native golden images. Native
rasterization differs legitimately (GPU filtering, colour management,
premultiplication). Native goldens are established on device, against
device captures.

## 2. Pose-model decision — NOT YET MADE

The planning documents named MediaPipe. That is not a reason to choose it.
The decision should be made against measurements from the first device runs.

### Criteria

| Criterion | Why it is disqualifying if unmet |
|---|---|
| Fully on-device | Section 13's edge-first architecture. A cloud pose call ends the Zero-Knowledge Live claim outright. |
| Front-camera support | Live Preview is a selfie-orientation experience. |
| License compatibility | Must be redistributable in a commercial App Store / Play binary. |
| Keypoint coverage | Needs at minimum shoulders, elbows, wrists, hips, neck/head to populate `BodyFrame` without fabrication. |
| Segmentation availability | Occlusion (P1-E3 / P2-E) needs a person/part mask. A pose model that also emits one avoids a second runtime. |
| Latency | Must fit the perception budget alongside render at a sustainable cadence. |
| Model size | Counts against app download size, which is a product constraint, not an engineering preference. |
| Device support | Must cover the intended floor, not just current flagships. |

### Candidates

**A. MediaPipe Pose Landmarker (Google, TFLite)**
- On-device: yes. Front camera: yes. License: Apache-2.0.
- 33 landmarks — a superset of what `BodyFrame` needs.
- Ships lite/full/heavy variants; the smaller variants are the realistic
  starting point. Optional segmentation mask from the same runtime.
- **Cross-platform**, so one perception behavior on both platforms rather
  than two that drift.
- Cost: an extra runtime and model payload in the bundle; GPU delegate
  configuration differs per platform.

**B. Apple Vision `VNDetectHumanBodyPoseRequest` (iOS only)**
- On-device: yes. Front camera: yes. License: part of the OS — **no bundle
  size at all**, and no third-party SDK to put through the Section 32 privacy
  audit.
- 19 joints; sufficient for `BodyFrame`.
- Person segmentation is a separate Vision request
  (`VNGeneratePersonSegmentationRequest`, and instance masks on newer iOS),
  which is an advantage (no extra dependency) and a cost (two requests to
  schedule and keep in sync).
- Cost: **iOS only.** Choosing it means Android needs a different provider,
  and the two will diverge in landmark semantics and jitter characteristics —
  which is exactly what `BodyFrame` exists to absorb, but the divergence is
  real and must be measured, not assumed away.

**C. Apple ARKit body tracking — rejected on a fact, not a preference.**
`ARBodyTrackingConfiguration` is **rear-camera only**. Live Preview is a
front-camera experience, so this fails the second criterion outright. Recorded
here so nobody re-proposes it.

### How to decide

Run A and B side by side on the same device against the same movements, and
record: landmark jitter (the evaluation package already computes RMS
frame-to-frame displacement), latency distribution, behavior at tracking loss
and reacquisition, and behavior with bulky clothing (Section 16). Then choose.
A defensible outcome is "B on iOS, A on Android" — `BodyFrame` is
provider-neutral precisely so that is a legitimate answer rather than a
compromise.

## 3. First device test — exact procedure

Every item produces a recorded artifact. A step with no artifact did not
happen.

1. **Camera startup.** Cold launch → permission prompt → first frame.
   Record: time to first frame; behavior on denial; behavior on
   background/foreground; behavior on interruption (call, Control Centre);
   repeated open/close ×10 with no leak.
2. **Model initialization.** Record: model file, version, and hash; init time;
   memory delta; whether initialization blocks the camera preview.
3. **BodyFrame.** Enable the P2-A1-style diagnostic overlay (head, shoulders,
   elbows, wrists, torso, hips, orientation, confidence) and record video of:
   still, leaning, closer/farther, arms crossed, arms raised, moderate turn,
   deliberate tracking loss and recovery. Confirm the mirroring convention
   holds on a real front camera — raise the wearer's left hand and confirm it
   appears at lower `u`.
4. **No frame crosses the JS boundary.** Instrument the bridge and record
   every message for a 60-second session. Assert: no payload key in
   `FORBIDDEN_EVENT_PAYLOAD_KEYS`; message rate is event-driven, not
   frame-rate. Attach the message log.
5. **Offline operation.** Airplane mode → full Live session (camera, pose,
   quality analysis, capture, preview). It must work end to end. Record the
   session and the network state.
6. **Latency / performance.** Per-stage timings (camera frame, pose,
   segmentation, render), dropped-frame ratio, thermal state transitions,
   memory pressure — for a sustained session long enough to reach thermal
   steady state, not a 10-second sample.
7. **Network audit (Section 32).** Capture all traffic during a Live session.
   Acceptance: no request contains a camera frame, video frame, face crop,
   body crop, pose landmarks, segmentation mask, body proxy, or inferred body
   geometry. Also test whether any SDK queues telemetry offline and transmits
   later — run step 5, then re-enable the network and keep capturing.

## 4. Device evidence return protocol

Device evidence must not stay on a developer's phone.

```
evidence/device/
  ios/
    <device-model>-<YYYYMMDD>-<sha>/
      run.json          device model, OS, app SHA, model versions, timestamps
      metrics.json      per-stage latency, dropped frames, thermal, memory
      bridge-log.json   every JS/native message (step 4)
      network-audit/    traffic capture + written verdict (step 7)
      offline.md        step 5 result
      media/            screenshots / screen recordings, where authorized
  android/
    <device-model>-<YYYYMMDD>-<sha>/
      (same shape)
```

Rules:

- **No private or personal test footage** in repository artifacts. Media is
  included only where the subject consented for that use, and every consented
  human capture gets a row in `docs/fixture-consent-log.md` first.
- `run.json` must carry model versions and the app SHA. Section 12: changing
  a model invalidates applicable baselines, and evidence that cannot be tied
  to a model version cannot be compared to anything.
- A run that fails is still returned. Section 40: failure is evidence.

## 5. Target device matrix

At minimum, per Section 30: one current iPhone, one older supported iPhone,
one mid-range Android, one stronger Android — exact models recorded. Do not
claim platform support from a simulator, an emulator, or a single flagship.
The full production matrix is a later integration requirement, not this
program's.
