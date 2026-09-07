# Live VTO — Productization & Runtime Readiness V1

**Lane:** `feature/vto-productization-runtime-readiness-v1`
**Base authority:** `219f27aa0f2586d3bded1ca02f751a63d1960c48` (the PR #327 merge)
**Date:** 2026-09-07
**Devices available to this lane:** none. No physical Android or iOS hardware
was reachable at any point, and no simulator or emulator result is presented
here as device evidence.

This is the source-of-truth record for what the Live VTO runtime does **now**.
It supersedes specific statements in
[`vto-live-bridge-contract.md`](./vto-live-bridge-contract.md); those passages
are marked in place rather than deleted, because the history of why they were
true matters.

---

## 0. What changed, in one paragraph

Live VTO had a working technical prototype that no customer could ever reach.
Three independent things made that true, and all three are now closed: the
native runtime reported itself permanently incapable, the tracking contract was
declared but never implemented, and the camera was mounted only on a
`__DEV__` diagnostic screen. What is still open is the runtime itself — nothing
below has been executed on a phone.

---

## 1. The tracking-quality contract

### The gap

`types/vtoLive.ts` has declared `trackingAcquired`, `trackingWeak`,
`trackingLost` and `trackingRecovered` since the contract was promoted.
Neither platform ever emitted one: the only `emitSessionEvent` call sites in
either render view were `ready`, `garmentLoaded` and `fatalError`. The JS
reducer had exhaustive, tested handling for states nothing could produce, and
`VtoLivePanel` gated both capture controls on `state === 'TRACKING'` — a state
that was therefore unreachable, so the controls were disabled on every build
that has ever existed.

### The contract

`LiveVtoTrackingQuality.kt` / `LiveVtoTrackingQuality.swift` — pure, no
platform imports, no clock of their own — turn perception and geometry facts
into the four phases:

| Phase | Meaning | Event emitted on entry |
| --- | --- | --- |
| `ACQUIRING` | Session started, nothing resolved well enough yet | *(none — silence is honest here)* |
| `ACQUIRED` | Sustained gate-passing, high-confidence geometry | `trackingAcquired`, or `trackingRecovered` from `WEAK`/`LOST` |
| `WEAK` | Seen, but not well enough to render truthfully | `trackingWeak` (+ guidance) |
| `LOST` | Not seen at all for `LOST_AFTER_MS` | `trackingLost` |

The inputs are all real:

- whether the provider resolved a pose (`PerceptionResult`);
- the adapted `BodyFrame`'s own `trackingConfidence` — read at the adapter
  boundary, never the vendor's raw score;
- `GeometrySnapshot.gatePassed`;
- `GeometrySnapshot.failure` (a `LiveVtoGeometryPipeline.Refusal`);
- whether a clean person frame is *actually buffered right now*.

**Time is used for exactly one thing: staleness.** There is no cosmetic
progress, no "acquiring for two seconds then say Ready" animation, and no
random state. A session that stops resolving poses says so.

### Guidance

Refusals map to coarse, non-anatomical instructions:

| Refusal / condition | Guidance | Customer copy |
| --- | --- | --- |
| `missing_shoulders`, `missing_hips` | `step_back` | "Step back so we can see you." |
| `degenerate_shoulder_span` | `step_closer` | "Come a little closer." |
| `degenerate_body_axis` | `center_yourself` | "Turn to face the camera." |
| `non_finite_landmark`, `non_finite_geometry` | `hold_still` | "Hold still — finding you." |
| confidence below the weak floor | `improve_lighting` | "Try somewhere brighter." |
| `missing_garment_control_points`, `degenerate_garment_span` | `none` | *(the state line stands)* |
| pose refused entirely | `step_back` | "Step back so we can see you." |

The last row of that table is deliberate: a garment-side refusal is not
something a customer can stand differently to fix, so it produces no framing
instruction at all. Telling them to step back would be a lie about the cause.

### Thresholds — FROZEN, PENDING-RUNTIME CALIBRATION

| Constant | Value | What it means |
| --- | --- | --- |
| `STRONG_CONFIDENCE` | 0.60 | Below this a resolved pose is not strong |
| `WEAK_FLOOR_CONFIDENCE` | 0.30 | Below this, guidance blames lighting |
| `ACQUIRE_STREAK` | 3 | Consecutive strong observations before ACQUIRED (~100 ms at the 33 ms producer cadence) |
| `DEMOTE_STREAK` | 2 | Consecutive non-strong observations before WEAK |
| `WEAK_AFTER_MS` | 400 | No resolved pose for this long while ACQUIRED → WEAK |
| `LOST_AFTER_MS` | 900 | No resolved pose for this long → LOST |
| `RE_EMIT_INTERVAL_MS` | 250 | Minimum spacing between two events of the same phase |

**None of these were fitted to measured hardware behaviour**, because no
hardware was available. They are chosen to be conservative. Journey C of the
[physical QA run packet](./vto-physical-qa-run-packet.md) collects exactly the
evidence needed to revisit them.

### Cross-platform parity

Both platforms execute **one committed fixture**,
`modules/kscan-live-vto-native/goldens/tracking-quality-scenarios.json`, step
for step, with the same tolerance:

- Android: `TrackingQualityConformanceTest.kt` (runs under
  `:kscan-live-vto-native:testDebugUnitTest`)
- iOS: `LiveVtoTrackingQualityTests.swift` (runs under `swift test`)
- JS: `__tests__/vtoLiveTrackingContract.test.js` governs the fixture itself —
  that both runners read it, that both platforms' declared constants agree with
  each other and with the fixture's parameters, and that every event and
  guidance token in it exists in the application contract.

Two suites of hand-written cases that merely look alike cannot prove parity:
the first typo reads as a divergence and a real divergence reads as a typo. The
fixture is what makes the claim falsifiable.

**It has already earned its keep.** On its first execution it failed, and the
failure was real: a session demoted to `LOST` kept its pre-loss strong-frame
streak, so it re-acquired on the very first good frame afterwards — ten minutes
of darkness, one frame, straight back to "Ready" with a live capture control.
Demotion now clears the streaks.

---

## 2. Capability — truthful, and why it was not

`getCapability()` returned a hardcoded `capable: false, runtimeReady: false` on
both platforms. That was correct at N1-A, when registration was all that
existed, and was left in place through every gate that built the runtime it
describes. `services/vto/vtoLiveCapability.ts` reads exactly those two fields
and reports `device_unsupported` on the first one that fails, so **Live could
not be offered to a customer on any device, in any environment, however the
build flag and the operator switch were set.**

The fix is not `true`. `LiveVtoRuntimeCapability` (both platforms) decides over
real evidence gathered at call time:

| Evidence | Android | iOS |
| --- | --- | --- |
| OS floor | `Build.VERSION.SDK_INT >= 24` (the app's own Expo floor) | major version `>= 15` (the podspec's own deployment target) |
| Front camera | `PackageManager.FEATURE_CAMERA_FRONT` | `AVCaptureDevice.DiscoverySession` on `.front` returns a device |
| Pose model | the bundled `.task` asset actually OPENS | the model actually RESOLVES in the governed resource bundle |
| Governed assets | each allowlisted directory's `manifest.json` actually PARSES | same |

`capable` = OS floor + front camera. `runtimeReady` = `capable` + model + at
least one loadable governed asset. Evidence gathering is wrapped; anything that
throws yields `UNKNOWN`, which is a flat no — the same fail-closed posture the
JS adapter already applies to a module that throws.

---

## 3. Capture readiness — one authority

Section 14's rule, implemented once, in
`services/vto/vtoLiveSession.ts:deriveCaptureReady`:

```
SESSION VALID            state is TRACKING (or CAPTURE_READY), never ERROR
+ TRACKING SUFFICIENT    the runtime says it is tracking, not weak, not lost
+ PERSON FRAME AVAILABLE the runtime's own captureReady on the last tracking
                         event; ABSENT reads as false
+ NO ACTIVE INVALIDATION garmentStatus is RENDERED — nothing loading, nothing
                         failed
-> CAPTURE READY
```

**Recomputed on every event, never latched.** A tracking loss, a fatal error, a
garment switch, or a runtime that stops reporting a buffered frame each
withdraw it on the event that carries the bad news — not on a later cleanup.

Native carries the answer additively on every tracking event
(`LiveVtoTrackingReadiness`), because the runtime is the only party that knows
all the conditions at once. A runtime that predates the field omits it and the
reducer reads it as `false`: the customer keeps a disabled control on a session
that might have been ready, rather than an enabled one on a session that would
capture nothing.

### VTO-TRACK-001

`captureCleanFrame()` read `frameSlot.peek()` — the **consume-once** back
pressure slot the perception producer empties every 33 ms. Whether a capture
succeeded therefore depended on a thread race, and a readiness flag built on
the same read would have flapped at the camera cadence. Both platforms now
retain the latest frame separately from the backpressure slot (one reference,
overwritten per frame, cleared on stop — retention is still exactly one frame
and it still dies with the session), and both capture and readiness read that.

---

## 4. Garment lifecycle

`LIVE_VTO_GARMENT_STATUSES`: `IDLE → SELECTED → LOADING → RENDERED | FAILED`,
carried alongside `pendingProductRef` — the identity a completion is checked
against.

**Stale completions are rejected.** A `garmentLoaded` naming a product that is
not the pending one is dropped whole: it does not become `loadedProductRef`, it
does not clear the loading state, and it does not hand the capture control back.
Without that identity, a slow load of A completing after a switch to B reported
success, cleared the loading state, and left the surface claiming B while the
runtime still drew A.

Rejection requires an ACTIVE disagreement. With nothing pending there is
nothing to be stale relative to, and the runtime's report is simply the truth
about what it has — the ordinary first-load case.

---

## 5. The garment resolver and the pilot asset registry — UNCHANGED

Deliberately untouched by this lane.
`services/vto/vtoLiveGarmentRegistry.ts` still indexes the two governed,
bundled `.ksgarment` assets by their manifests' own
`productIdentity.productRef`, and still returns `null` (NOT_FOUND) for
everything else.

**That most real `productRef` values are not in it is success, not a gap.**
Commerce's `productRef` is a correlation handle for an ephemeral per-scan
result, not a stable catalog SKU, and Gate E measured 3 of 220 real products as
`LIVE2D_ELIGIBLE`. A resolver that returned ELIGIBLE for arbitrary refs would
be lying.

`PILOT_ASSET_EXPANSION: BLOCKED — SOURCE MATERIAL.` No additional
rights-cleared source imagery exists in the repository or in approved project
inputs that could pass through the governed asset factory, and third-party
retailer imagery may not be newly bundled into a distributable binary without
owner authorization. The two existing governed assets stand.

---

## 6. The customer surface

`VtoLivePanel` mounts the runtime. Its own header used to say plainly that no
camera view was mounted there, and the only surface that mounted it was
`app/dev-n1-diagnostic.tsx`.

- `VtoLiveNativeView` resolves the native view lazily and wrapped; a missing
  module renders nothing rather than crashing the sheet.
- It sets the **`live`** prop — a first-class product entry point declared
  separately from the diagnostic `active`/`replay`/`perception`/`camera` props
  on both platforms, and now part of the pinned native bridge surface, so a
  customer-reachable path cannot be added or removed without review. Same
  pipeline; honest labelling.
- Both capture controls bind to `session.captureReady` and nothing else.
- Tracking copy is customer copy: no MediaPipe, no BodyFrame, no confidence
  value, no frame rate, no native state id, no geometry refusal.
- One derived status line, so guidance replaces the state line rather than
  competing with it.
- Accessibility announcements are coalesced **by value** (not by timer — a
  debounce would delay the change a customer most needs to hear) and never move
  focus.
- A **recoverable** failure offers "Try Live again", which is a full restart
  through the tested entry path, not a resume of a runtime that already failed.
  An unrecoverable one does not, because a button that cannot work is worse
  than a clear explanation.

### VTO-TRACK-002

Every early return in `startCamera()` on both platforms set `loadError` — a
diagnostic string the view draws on *itself* — and returned, emitting nothing.
`startSession()` had already moved the native machine to STARTING and the JS
controller to GARMENT_LOADING, so a customer whose camera could not start sat
on "Loading this piece…" **forever**. Each abandonment now reports a bounded
runtime error state.

---

## 7. Privacy — unchanged, and re-proven

- Live camera → local perception → local geometry → local render. No
  continuous frame, mask, landmark or body-proxy value crosses the bridge; the
  event vocabulary has no per-frame member, and `assertNoRawLiveData` screens
  every inbound payload recursively.
- The tracking events added by this lane carry a confidence number, a bounded
  guidance token and a boolean. Nothing else.
- Photoreal remains a separate, explicit customer action. `PERSON_FRAME` is the
  only eligible generative source; `PREVIEW` is refused at
  `assertCleanPersonFrame`, and that negative control is unchanged and still
  passing.

---

## 8. Staging activation — HALF DONE, HALF OWNER ACTION

Live has **two independent gates**, by design: a build-time client flag and a
server-side operator switch. Neither can turn the other on.

### The server half — DONE

| | |
| --- | --- |
| **What** | `app_config` row `vto_generation`, added key `live` = `{ "enabled": true, "supportedCategories": ["top"] }` |
| **Where** | Staging (`yzqjvdfgefveprobvvyw`) only |
| **Why** | Section 5 permits VTO feature/config activation in Staging through governed mechanisms; without it the device QA session stalls at the packet's §8 table |
| **When** | 2026-09-07, via the governed Supabase MCP against the staging project |
| **Effect today** | **None.** `services/vto/vtoFeatureControl.ts` reads it, but the router requires the build flag as well, and no build sets that. The generative path is untouched: the server-side normalizer reads only `enabled`, `provider`, `supportedCategories` and `schemaVersion`, and ignores unknown keys |
| **Status** | PERSISTS_FOR_STAGING_PILOT |
| **To revert** | one `jsonb` statement removing the `live` key |

### The client half — OWNER ACTION REQUIRED

`EXPO_PUBLIC_LIVE_VTO_ENABLED` is set on **no** EAS profile. It was written to
`staging-certification` during this lane and then **deliberately reverted**.

**Why it was reverted.** `staging-certification` is the correct home — it
already carries `EXPO_PUBLIC_VOICESCAN_ENABLED`,
`EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED` and `EXPO_PUBLIC_SMART_WATCHLIST_V1`
on exactly the "staging exercises what production has not shipped" reasoning,
and it inherits the staging backend rather than restating it. (`staging`
itself is not an option: `__tests__/staging/easProfileParity.test.js` requires
it to expose *exactly* production's client-feature flag set.)

But **two existing governed gates say that list is owner-ratified, not
lane-editable**:

- `__tests__/easConfigIntegrity.test.js` pins the certification matrix to
  "the approved rulings … the Build 34 target matrix", exactly;
- `__tests__/vtoLiveFeatureGate.test.js` asserts no EAS profile sets the Live
  flag at all.

Widening an owner-ratified certification matrix is not a defect repair, and a
lane that rewrites the gate standing in its way has defeated a control to
manufacture completion. Section 36's own instruction is to **fail closed when
authority cannot be resolved**, and here it genuinely could not be: the lane
brief authorizes Staging activation and two ratified gates say this particular
list is not the lane's to change.

**What the owner does to activate it** (three lines, one review):

1. add `"EXPO_PUBLIC_LIVE_VTO_ENABLED": "true"` to the `staging-certification`
   profile's `env` in `eas.json`;
2. add `EXPO_PUBLIC_LIVE_VTO_ENABLED` to `CERT_MATRIX_ENABLED` in
   `__tests__/easConfigIntegrity.test.js`;
3. update the "no EAS profile sets it" assertion in
   `__tests__/vtoLiveFeatureGate.test.js` and the "current, owner-ruled
   posture" assertion in `__tests__/vtoLiveEnvironmentGate.test.js` to name
   `staging-certification`.

Everything downstream is already in place and already tested:

- the certification profile **already** resolves to the staging backend, and
  `vtoLiveEnvironmentGate.test.js` asserts that adding the flag there would be
  classified `allowed`;
- that same gate resolves every profile through `extends` — which human
  inspection cannot see through — and refuses any Live-enabled profile that
  does not land on staging;
- its **negative control** constructs the Live-enabled production candidate the
  rule exists to stop and asserts the same function refuses it, so the rule is
  proven able to fail rather than merely never having fired.

**PRODUCTION VTO ACTIVATION: NOT AUTHORIZED**, and production, preview and
development are asserted not to carry the flag.

## 9. Holds carried forward

| Hold | State |
| --- | --- |
| **Android physical camera** (Samsung `Camera2-FrameProcessorBase ETIMEDOUT (-110)`: binds, reports RUNNING, never delivers a frame) | PENDING RECLASSIFICATION ON A SECOND PHYSICAL DEVICE. Not redesigned around in this lane — a hardware condition that cannot be reproduced is not a thing to guess at. The tracking heartbeat does mean this condition now reports TRACKING LOST instead of a stale "Ready" |
| **iOS physical runtime** | PENDING. Never exercised on hardware |
| **Photoreal successful generation** | Not attempted in this lane. Prior outcome was `submit_http_429` |
| **Occlusion quality** | UNPROVEN. No local segmentation stack behind the renderer; z-order is preserved and nothing was added |
| **Perceptual quality verdict** | PENDING-RUNTIME. Owner-ratified from device evidence only — see the QA packet's §4 matrix |
| **External pilot** | NOT AUTHORIZED. Photoreal sends authorized person imagery across an external provider boundary; the disclosure, consent and sub-processor posture is an owner and counsel decision |
| **Production VTO activation** | NOT AUTHORIZED |

---

## 10. What this lane did not prove

Stated plainly so nothing is inferred from silence:

- No frame has been rendered on a phone by this lane's code.
- No tracking state has been observed on hardware. Every phase transition
  above is proven against the shared fixture, on the JVM and (in CI) under
  `swift test`.
- The thresholds in §1 are unmeasured.
- Occlusion, latency, thermal behaviour and battery are entirely unaddressed.
- Compilation is not runtime certification, and the diagnostic screen is not a
  customer proof.

---

## 11. Where to look next

- [`vto-physical-qa-run-packet.md`](./vto-physical-qa-run-packet.md) — the
  numbered device run, the evidence format, and the perceptual matrix.
- [`vto-live-bridge-contract.md`](./vto-live-bridge-contract.md) — the shared
  bridge surface, with this lane's supersessions marked in place.
- `modules/kscan-live-vto-native/goldens/tracking-quality-scenarios.json` — the
  tracking contract, executable.
