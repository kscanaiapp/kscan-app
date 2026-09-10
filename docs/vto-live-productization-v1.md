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

## 8. Staging activation — DONE, both halves

Live has **two independent gates**, by design: a build-time client flag and a
server-side operator switch. Neither can turn the other on, and both are now
set for Staging.

### The client half — OWNER RULING 2026-09-07

| | |
| --- | --- |
| **What** | `EXPO_PUBLIC_LIVE_VTO_ENABLED: "true"` |
| **Where** | the `staging-certification` EAS profile, and **no other profile** |
| **Backend it resolves to** | `yzqjvdfgefveprobvvyw` (staging), **inherited** from `staging` via `extends`, never restated |
| **Production / preview / development** | unchanged; asserted not to carry the flag |
| **Dev harness (`EXPO_PUBLIC_LIVE_VTO_HARNESS`)** | still set on **no** profile — the ruling did not touch it, and it must never ship: it *simulates* capability, and a build carrying it would be a build whose Live evidence was fabricated |

**How this was reached, because the sequence is the point.** The lane wrote the
flag onto `staging-certification` — the correct home, since it already carries
`EXPO_PUBLIC_VOICESCAN_ENABLED`, `EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED` and
`EXPO_PUBLIC_SMART_WATCHLIST_V1` on the same "staging exercises what production
has not shipped" reasoning. (`staging` itself was never an option:
`__tests__/staging/easProfileParity.test.js` requires it to expose *exactly*
production's client-feature flag set.)

Two governed gates refused it. The lane **reverted and escalated** rather than
editing the gates standing in its way, and the owner ruled. All three pins now
permit precisely this state and nothing wider, each carrying the ruling and its
limits in the diff:

- `__tests__/easConfigIntegrity.test.js` — `CERT_MATRIX_ENABLED` gains the key,
  and the **separate hardcoded matrix-size pin** in the same file moves 6 → 7.
  That second pin caught the change even after the list was updated, which is
  the redundancy working rather than a duplicate to remove.
- `__tests__/vtoLiveFeatureGate.test.js` — "no EAS profile sets it" becomes an
  **exact set**: `['staging-certification']`. Deliberately an exact set rather
  than a relaxed "production must not have it", because a rule that only names
  what it forbids stops being a rule the moment somebody adds a sixth profile.
- `__tests__/vtoLiveEnvironmentGate.test.js` — the posture assertion pins the
  same exact set, resolved **through `extends`**, which is the part human
  inspection of `eas.json` cannot do.

**What the ruling explicitly did NOT authorize**, held mechanically rather than
by prose: Production activation, store distribution, and external pilot use.
The approval is source/configuration readiness only. `eas.json`'s diff is
**one line**, and a programmatic check confirmed every other profile —
including `submit` and `cli` configuration — is byte-identical.

**The negative control is preserved, and is now load-bearing for the opposite
reason.** When nothing enabled Live, it existed so an all-pass result would not
be vacuous. With a real Live-enabled profile in the tree the rule is being
exercised for real, and the control is what proves it would still **refuse** a
Live-enabled Production candidate rather than having quietly become an
always-allow.

### The server half

| | |
| --- | --- |
| **What** | `app_config` row `vto_generation`, added key `live` = `{ "enabled": true, "supportedCategories": ["top"] }` |
| **Where** | Staging (`yzqjvdfgefveprobvvyw`) only |
| **When** | 2026-09-07, via the governed Supabase MCP against the staging project |
| **Effect on the generative path** | none — the server-side normalizer reads only `enabled`, `provider`, `supportedCategories` and `schemaVersion`, and ignores unknown keys |
| **Status** | PERSISTS_FOR_STAGING_PILOT |
| **To revert** | one `jsonb` statement removing the `live` key |

**PRODUCTION VTO ACTIVATION: NOT AUTHORIZED.**

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

---

## 12. Decision memos

Four decisions this lane made that a reviewer should be able to disagree with
on the record.

### 12.1 Occlusion: no segmentation was added

**Decision:** leave `setOutputSegmentationMasks(false)` exactly where it is.

The bundled MediaPipe Pose Landmarker **can** emit a segmentation mask — the
capability exists and is deliberately switched off, so this is not "there is no
local segmentation authority", it is "there is one and we are not turning it
on".

Turning it on is neither free nor verifiable here. It adds real per-frame mask
generation to a pipeline whose device behaviour is entirely unmeasured and
whose one measured device already carries a camera hold; and *consuming* a mask
means a new masked-compositing path in the renderer whose visual correctness
cannot be judged without a phone. §46 forbids performance work without device
evidence — shipping an unvalidatable performance **regression** is the same rule
read backwards.

**What was done instead**, which is §30's own stated fallback:

- **z-order preserved and asserted** — the camera preview is inserted beneath
  the view's own drawing, the view opts back into `onDraw`, and mesh draws
  correspond one-to-one with the four modes;
- **replay tests for the likely occlusion cases** — arm across torso (both
  sides), arms overhead, arms absent, partial torso turn, and every golden
  degradation case;
- **the invariant that actually matters without a mask**: when an arm moves,
  the **torso** control points are bit-identical and only the **sleeves**
  articulate. A limb drawn under the garment is a survivable limitation; a
  garment that swims whenever the customer gestures reads as a broken renderer.

That test's first version asserted *nothing* should move and failed
immediately — `LiveVtoGarmentAttachment` says in its own words that "sleeves
are the one family that does not follow the torso frame". The corrected version
asserts both halves, the second as a negative control so a refactor that froze
the sleeves could not pass by making the first trivially true.

**Occlusion QUALITY verdict: PENDING-RUNTIME.** Journey C5 collects it.

### 12.2 Photoreal: HOLD — PROVIDER, zero attempts

**Decision:** make no provider call. **Attempts: 0 of the 3 permitted. Billable
attempts: 0. Spend: $0.**

Two independent reasons, either sufficient:

1. **No credential path exists from this environment.** There is no `.env`, and
   no `SUPABASE_STAGING_*` variable is set. The harness cannot authenticate, so
   there was nothing to attempt.
2. **The paid path is owner-gated by design.** `vto-e2e.yml`'s
   `staging-full-certification` job requires a `workflow_dispatch` with
   `confirm_paid_certification: YES`. Triggering that is an owner act, and §27
   forbids authorizing new spend.

§27's instruction where cost cannot be determined safely is to **stop and
record OWNER ACTION — SPEND AUTHORITY REQUIRED**, which is what this is.

**What was proven instead, at the contract level:** the refusal set (§52) is
executed in `__tests__/vtoLivePilotNegativeControls.test.js` — a composited
`PREVIEW` refused at the gate, every malformed handle refused, every failure
code returning a usable Live session, no provider identity reachable in
customer copy, and no network client anywhere in the handoff. Prior evidence
already established client → staging → provider as **CONNECTED**, with the last
provider outcome `submit_http_429`. A successful generation remains
**NOT YET PROVEN**.

### 12.3 Pilot assets: BLOCKED — SOURCE MATERIAL

**Decision:** the governed pilot set stays at two assets.

§20 permits expansion only from source imagery that already exists in the
repository or in approved project inputs and can pass through the *existing*
governed asset factory. No such material exists. Third-party retailer imagery
may not be newly bundled into a distributable binary without owner
authorization, and fabricating assets or hand-authoring them outside the
factory is forbidden outright.

`vtoLivePilotNegativeControls.test.js` pins the count at two with the full
rights record an addition would need, so a later expansion is a deliberate act
rather than a quiet append.

### 12.4 Staging build flag: reverted, escalated, then ruled on

Covered in full in §8. The short version: the correct home for the flag is
`staging-certification`; two governed gates said that list was owner-ratified;
§36's own instruction is to fail closed when authority cannot be resolved. The
lane therefore reverted its own change and escalated instead of editing the
gates standing in its way.

**The owner ruled on 2026-09-07** and the flag is now set — on that profile and
no other, authorizing source/configuration readiness only. What is worth
keeping from the episode is its shape: the gate refused, the lane stopped, a
person decided, and all three pins were updated to permit exactly the decided
state, each carrying the decision and its limits in its own diff rather than in
a commit message nobody will read again.

A fourth pin turned up during the update — a hardcoded matrix-size assertion in
`easConfigIntegrity.test.js` that failed even after `CERT_MATRIX_ENABLED` had
been corrected. That is the redundancy working, not a duplicate to remove.

The rule governing *where* a Live-enabled build may point, and its negative
control, are unchanged by the ruling and still refuse a Production target.
