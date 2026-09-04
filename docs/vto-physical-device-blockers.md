# Live VTO — Physical-Device Blockers

Section 13 deliverable of the emulator-native validation lane. Its purpose is
narrow: **prevent simulator/emulator success from being misreported as phone
readiness.** Nothing in this document is new information about the product —
it is a checklist of exactly what an emulator or simulator run, however
successful, cannot tell you.

This list is distinct from, and must not be conflated with, the
**this-session's-environment blockers** recorded in
`docs/vto-native-device-handoff.md`'s "Emulator-native validation lane"
section. That section explains why *this specific cloud sandbox* could not
even attempt a compile or an emulator boot. This document explains what even
a *successful* emulator/simulator run on a *different, properly equipped*
session still would not prove. Do not read a fix to one as a fix to the
other — provisioning a session with Xcode or an Android SDK closes the first
gap. It does not close any item below.

## What no simulator or emulator can certify

- **Real front-camera behavior.** Simulator/emulator camera input is either
  absent, a virtual/synthetic feed, or host-webcam passthrough — none of
  which exhibits real sensor noise, real autofocus hunting, real exposure
  adjustment, or real front-camera field of view and distortion.
- **Real pose-model accuracy.** A pose model's *code* can run in a simulator
  or emulator; its *accuracy* was trained against and is only meaningful
  against real camera imagery of real bodies. A jitter number computed on a
  virtual-camera or replay-fixture pass measures the harness, not the model.
- **Real segmentation accuracy.** Same reasoning as pose accuracy, for
  whatever produces the person/part mask once one exists.
- **Real-world lighting.** No simulator/emulator reproduces backlight,
  mixed color temperature, low light, or the lighting estimator's actual
  operating conditions.
- **Body diversity.** A synthetic or replay fixture is exactly as diverse as
  its author made it — see `packages/static-renderer/src/fixtures/person.ts`'s
  own header: "does not validate human pose perception, body diversity, or
  production segmentation quality." An emulator run inherits that limitation
  from whatever frame source feeds it.
- **Camera latency.** Real AVFoundation/CameraX pipelines have real
  start-up, autofocus, and frame-delivery latency that a virtual camera does
  not reproduce, and a replay fixture bypasses entirely by construction.
- **Sustained thermal state.** Emulators/simulators run on host hardware
  with host thermal characteristics (or none, if the host throttles
  differently or not at all) — they cannot reproduce a phone reaching
  thermal steady state under sustained camera + inference + render load.
- **CPU/GPU performance.** Section 10's own rule, already stated in
  `docs/vto-native-device-handoff.md`: "Do not claim platform support from a
  simulator, an emulator, or a single flagship." Emulator CPU is host CPU,
  usually a multi-core desktop/server part wildly unlike a phone SoC;
  emulator GPU rendering is frequently a software or host-passthrough path
  with no relationship to the mobile GPU driver stack a shipped app runs
  against.
- **Device memory pressure.** Emulator/simulator memory limits are host
  configuration, not the phone's actual RAM ceiling or the OS's actual
  background-kill behavior under pressure.
- **True frame rate.** Whatever FPS an emulator run reports is bounded by
  host scheduling and virtualization overhead in ways that have no fixed
  relationship to a real device's sustained frame rate — see the emulator
  performance disclaimer rule (Section 10 of the emulator-native
  validation lane's authorization): every number must be labeled "EMULATOR
  PERFORMANCE — NOT DEVICE PERFORMANCE."
- **Real camera interruptions.** Phone calls, Control Centre camera access
  indicators, other apps requesting the camera, and OS-level camera-session
  preemption are physical-device behaviors a simulator/emulator session does
  not generate.
- **Orientation and device-specific issues.** Notch/Dynamic Island safe
  areas, foldable hinge states, per-OEM camera behavior (especially on
  Android, where CameraX behavior legitimately varies by manufacturer), and
  device-specific permission dialogs are not exercised by a single emulator
  image.

## What this means for the emulator-native validation lane's own success

Per that lane's own Section 16/17 framing: the best outcome available from
any emulator/simulator session — including one run on a session actually
equipped with the toolchain, which this one was not — is
**"EMULATOR-NATIVE VALIDATED."** That status certifies the native module
compiles, mounts, and exchanges commands/events correctly, and that the
JS/native privacy boundary holds under test. It does not and cannot certify
**"PHYSICAL-DEVICE VALIDATED."** The two statuses are not different
confidence levels of the same claim — they are claims about different
things, and `docs/vto-native-device-handoff.md`'s Section 3 device-test
procedure remains the only path to the second one.

## Cross-reference

- `docs/vto-native-device-handoff.md` — the full device-test procedure (its
  Section 3) that eventually closes every item above, plus this session's
  specific emulator-lane environment findings.
- `docs/vto-risk-register.md` — where these gaps should be reflected as risk
  status, not re-litigated here.
