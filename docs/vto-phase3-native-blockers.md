# Live VTO Phase 3 — P3-B Native Blockers

Section 28/29 deliverable. This document exists so P3-A's deterministic,
headless-renderer evidence (packages `realism`, `realism-preview`,
`photoreal-bridge`, and `evidence/phase3-preview/`) is never mistaken for
P3-B: real native validation. Every item below is **NOT YET VALIDATED**, and
none can be passed synthetically — see the Phase 3 build plan's own
instruction: "Do not fake P3-B with JS timers, synthetic performance claims
or uncompiled native code."

This list is Phase 3's own; it does not re-litigate Phase 1-2's identical,
still-true findings in `docs/vto-native-device-handoff.md` §0
(no macOS host is possible in this Linux container at all; Android is
blocked by a live 403 on `dl.google.com` and an absent `/dev/kvm`) or
`docs/vto-physical-device-blockers.md` (what even a *successful* emulator
run could never certify). Both remain true, unchanged, this session —
verified by the identical structural facts still holding: still a Linux
container, still no `xcodebuild`/`xcrun`/`swift`, still no `$ANDROID_HOME`.

## What P3-A actually proved (so the boundary below is legible)

- `packages/realism`'s temporal-stability, semantic-occlusion, and
  metric logic: real, tested (84+ passing tests across `realism`,
  `realism-preview`, `photoreal-bridge`), and exercised end-to-end through
  the real (unmodified) `renderRigidStage`/`renderDeformedStage` pipeline —
  see `evidence/phase3-preview/`.
- Every mask, sequence, and semantic scene in that evidence is
  `PRECOMPUTED` (see `packages/realism/src/foregroundMask.ts`) or
  synthetic-fixture-authored. Nothing here ran a real segmentation, pose, or
  perception model.

## P3-B — exact unvalidated list

1. **Real temporal segmentation.** No segmentation model of any kind exists
   in this workspace (confirmed again this session: no rembg, MediaPipe,
   TensorFlow/TFLite, ONNX, OpenCV, or similar dependency in any
   `package.json`). `ForegroundMaskFrame.provenance: 'REAL_MODEL'` is a
   defined value in the Section 8 contract that **nothing in this
   repository can produce**.
2. **Real arm crossing.** Cases 3/4 in `evidence/phase3-preview/` (forearm
   crossing, both arms interacting with torso) use hand-authored rectangular
   masks at fixed fractional coordinates, not a detector's output on any
   real or synthetic camera frame.
3. **Real hair segmentation.** Case 5's hair region is the same kind of
   hand-authored rectangle. No multiclass semantic segmentation model has
   ever run against any image in this program, at any phase.
4. **Live renderer.** `packages/static-renderer` (Phase 1-2) and this
   phase's `realism-preview` are both headless, CPU, deterministic
   evaluation renderers. Neither is the native GPU-backed live-camera
   renderer `native/` (still unbuilt — see below) would need. Frame-rate,
   GPU filtering, and color-management behavior are all unproven.
5. **Actual front-camera capture.** No camera code runs anywhere in this
   program. `packages/photoreal-bridge`'s `ExplicitStillCapture` is a typed
   contract with a `localUri: string` field; nothing produces a real one.
6. **Actual explicit still handoff.** `packages/photoreal-bridge`'s
   `mockBridgeAdapter.ts` is explicitly test-only (see its own header) and
   transmits nothing — it builds a request object in memory and returns it.
   No real still has ever been captured, confirmed, or hand off to anything.
7. **Network/privacy capture.** The privacy claims in
   `packages/photoreal-bridge/src/privacyStateModel.ts` and the "no raw live
   frame" guarantee in `bridgePayload.ts` are enforced by **type contract
   and unit test** (structural: the payload shape cannot carry a forbidden
   key; see `FORBIDDEN_BRIDGE_PAYLOAD_KEYS` and its contract tests) — this
   is real but different evidence from a device-level network traffic
   capture during a live session, which Phase 1-2's own §32 requirement
   (`docs/vto-native-device-handoff.md` step 7) still correctly reserves for
   physical-device testing. No traffic capture of any kind has run.
8. **Sustained performance.** No thermal, frame-time, memory-pressure, or
   sustained-session data exists for any part of this program, headless
   renderer included — the renderer's per-case render time in
   `evidence/phase3-preview/summary.json` measures this Linux container's
   CPU, not a phone's, and is not reported as a performance claim anywhere
   in this program's evidence for exactly that reason.

## Native scaffold status — unchanged from Phase 1-2

`kscan-live-vto/native/` remains **not built, not compiled, not device-
tested, not emulator-tested** (its own `README.md`'s first line, re-verified
this session). Phase 3 added no native code and did not attempt to compile
anything — per instruction, P3-B is not this lane's to close.

## What would close each item

Identical prerequisites to Phase 1-2's own (`docs/vto-native-device-handoff.md`
§0, §5): a macOS host with Xcode for iOS, or an Android SDK + KVM-capable
host + unrestricted egress to `dl.google.com` for Android; then a real pose/
segmentation model selection (criteria already recorded in
`docs/vto-native-device-handoff.md` §2, unchanged); then the device-test
procedure in that same document's §3, extended to also record: (a) real
arm-crossing and hair-occlusion behavior against the semantic regions this
phase defined (`packages/realism`'s `SEMANTIC_REGIONS`), (b) an actual
front-camera capture through `requestPhotorealCapture()`'s state machine
end to end, and (c) a device-level network capture proving no field in
`FORBIDDEN_BRIDGE_PAYLOAD_KEYS` ever leaves the device during a Live
session, matching Phase 1-2's §32 audit but scoped to the Photoreal bridge
specifically rather than the native pose pipeline.

No item in this list is claimed PASS, HOLD-pending-review, or anything but
**NOT YET VALIDATED** anywhere else in this program's Phase 3 documentation.
