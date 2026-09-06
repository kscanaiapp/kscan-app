# Live VTO Native Runtime N1 — Runtime Architecture (N1-B / N1-C / N1-D)

Companion to `vto-live-native-runtime-n1.md` (gate status) and
`vto-live-native-n1-conformance.md` (measured geometry conformance).
This document freezes the things a hostile audit has to be able to check
without reverse-engineering the code: the renderer backend, the thread
topology, the replay contract, and the privacy boundary.

## Renderer backend (amendment D9)

```
RENDERER BACKEND:            Android Canvas / drawBitmapMesh
PROVISIONAL:                 YES
STATUS:                      VALID FOR N1-B / N1-C / N1-D CONFORMANCE
FINAL CAMERA-RATE SUITABILITY: NOT YET DECIDED
```

Canvas is preserved deliberately for these gates. It was **not** rewritten to
GLES: no correctness limitation required it, and a rewrite would have
invalidated the conformance goldens for no measured reason.

**Migration trigger.** Revisited at N1-F, on measured physical-device
camera-rate evidence: migrate only if Canvas deformation + draw cannot
sustain an interactive Live experience without unacceptable UI
responsiveness or frame-latency degradation. No FPS number is invented here.

**If the backend ever changes**, every N1-C cross-runtime golden must be
re-run before the migrated renderer can close its gate. A silent
renderer-backend swap after the N1-C freeze is a **P1 defect**. The goldens
make this enforceable rather than aspirational: geometry is computed by
`LiveVtoGeometryPipeline` and is backend-independent, so a backend change
that alters the numbers is immediately visible.

## Thread topology (amendment D18)

```
kscan-live-vto-replay        (LiveVtoReplayDriver, one daemon thread)
    replay clock tick
    frame acquisition            InterpolatedPoseReplaySource.frameAt(index)
    BodyFrame production         (interpolation between committed keyframes)
    deformation / geometry       LiveVtoGeometryPipeline.compute
    publish                      LatestStateSlot.publish

Android UI / View draw thread
    LiveVtoTestRenderView.onDraw
    LatestStateSlot.consume / peek
    Canvas.drawBitmapMesh

Bridge / event dispatch
    ReplayEvent callback, raised on the replay thread
    state transitions ONLY -- never per frame
```

```
FRAME PRODUCTION:     NOT UI THREAD   (kscan-live-vto-replay)
DEFORMATION COMPUTE:  NOT UI THREAD   (kscan-live-vto-replay)
CANVAS RASTERIZATION: UI / View draw thread   (required by the Android View model)
```

This is enforced structurally, not by convention. The entire geometry stack
(`Vec2`, `LiveVtoJson`, `LiveVtoGarmentAttachment`, `LiveVtoGeometryPipeline`)
has **zero Android imports**, so it cannot touch a Canvas, a View, or a
Looper. The draw callback consumes a finished immutable snapshot and runs no
geometry of its own.

`LiveVtoReplaySession` owns **no threads at all**. It exposes `advance()` as
the single unit of production work and lets a driver decide what runs it —
a real executor on device, a deterministic loop in tests. That is why the
whole state machine and all backpressure accounting are testable on the JVM.

The driver uses `scheduleWithFixedDelay`, **not** `scheduleAtFixedRate`: a
slow tick must not cause the executor to fire a burst of catch-up ticks,
which would be a queue by another name. Each tick body is wrapped, because a
`ScheduledExecutorService` silently cancels a repeating task whose body
throws — which would look exactly like a clean stop while the session still
reported `PLAYING`.

## Replay state machine

```
IDLE ──load──> LOADING ──ok──> READY ──start──> PLAYING ⇄ PAUSED
                  │                                │
                  └──fail──> ERROR                 ├──stop──> STOPPED ──start──> PLAYING
                                                   └──exhausted──> EOF ──restart──> PLAYING

any state ──dispose──> DISPOSED   (terminal, idempotent)
```

Every transition is explicit. An operation illegal from the current state is
a **refused no-op returning false** — never an exception, never a silent
transition. Verified by `lifecycleFollowsTheDeclaredStateMachine`, including
that the transient `LOADING` state is actually observable rather than
skipped.

**EOF** stops frame production, emits a terminal state event, and **retains**
the final snapshot — the documented resource contract (mission section 20).
The sequence ended normally and the last frame is the correct thing to leave
on screen until the caller stops, restarts, or disposes. It does not loop
silently; `restart()` replays the whole source.

**ERROR** clears the latest-state slot. See N1-ENV-009 — without this a
renderer that peeks keeps drawing the last good frame while the session
behind it is broken.

**DISPOSE** is terminal and idempotent: production stops, the slot empties,
the source and garment references are released, exactly one terminal event
fires, and every subsequent command is a refused no-op that emits nothing.
Safe to call while a producer thread is actively running
(`disposeIsSafeWhileAProducerThreadIsRunning`).

## Backpressure (amendments D14 / D15)

```
REPLAY CLOCK
     ↓
FRAME + BODYFRAME PRODUCTION
     ↓
DEFORMATION COMPUTE
     ↓
LATEST STATE SLOT          (depth 0 or 1, by construction)
     ↓
UI / VIEW DRAW
```

The producer **never** waits for a render. `LatestStateSlot` holds at most
one value: overwriting an unconsumed value is a counted DROP, not a silent
loss, and no backlog can accumulate for a consumer to drain later.

Measured:

| Mode | Produced | Rendered | Dropped | Max depth |
|---|---|---|---|---|
| Deterministic, consume every 10th frame | 601 | 60 | 540 | **1** |
| Free-running producer thread vs 5 ms consumer, 250 ms | 7471 | 45 | 7425 | **1** |

Accounting invariant `produced == rendered + dropped + depth`: **HOLDS**.
Producer:renderer ratio under real concurrency: **166×**.

```
INTENTIONAL OVERLOAD TEST: PASS (non-vacuous)
```

The test asserts `dropped > 0` explicitly. A coupled
produce-then-await-render loop could not produce these numbers — it would
report zero drops and prove nothing, which is exactly the fake pass
amendment D15 exists to prevent.

**This proves the architecture, not real-camera performance.** Production
backpressure must be re-measured at N1-E/F against real perception and
camera workloads. The 33 ms driver period is deliberately not tuned to any
device or emulator.

## Product switching during replay (amendment D16)

`selectGarment` swaps the active asset **without restarting replay**.
Production is single-threaded through `advance()`, so a frame is either
entirely garment A or entirely garment B; there is no window in which one
snapshot could carry A's geometry and B's texture.

The swap clears the slot, so A's geometry can never be drawn once B is
active. `advance()` additionally re-checks garment identity after computing
geometry and discards the result if the garment changed mid-computation —
so a snapshot cannot appear under the wrong asset id.

Verified: B becomes current at the next frame boundary; replay state stays
`PLAYING`; A's pre-switch snapshot is unreadable after the switch; B is
driven by the *current* frame index, not a stale one; A→B→A is symmetric.
An invalid garment fails closed into `ERROR` without leaving renderable
geometry, and `dispose()` still works from `ERROR`.

## Privacy boundary (amendments D24 / section 25)

```
JS RECEIVES:   session state, fixture id, source id, fatal error,
               aggregate counters on explicit demand
JS NEVER RECEIVES: raw frames, bitmap bytes, mask frames, landmark arrays,
               BodyFrames, per-frame geometry, mesh vertices
```

Enforced, not asserted:

- `ReplayEvent` declares `ALLOWED_PAYLOAD_KEYS`, and
  `replayEventsCarryOnlyBoundedStateAndNoFrameData` asserts the **serialized
  payload keys equal that allowlist**. Adding a field to `ReplayEvent`
  without declaring it fails the build rather than silently widening the
  boundary.
- Every payload value must be a scalar (String / Number / Boolean / null) —
  a container could smuggle bulk data past a key-name check.
- `eventCountIsBoundedByTransitionsNotByFrameCount`: **≤ 10 events over a
  601-frame run**. A runtime emitting one event per frame would be a
  high-frequency channel regardless of each event's contents.
- The diagnostic geometry accessor is rate-limited to at most one distinct
  snapshot per second, and returns the cached string inside that window, so
  a JS caller polling it cannot turn it into a frame pump.
- `getReplayStatsJson` returns aggregate counters only
  (state, fixture id, produced / rendered / dropped / depth / refused).

**Network:** the replay and render pipeline performs no I/O of any kind. It
reads committed assets from the APK and computes; there is no HTTP client,
socket, upload, or analytics call anywhere in `modules/kscan-live-vto-native`.
Nothing it produces is persisted off-device.

`grep -rniE "http|okhttp|socket|upload|fetch|retrofit|url" modules/kscan-live-vto-native/android/src/main` returns no
network usage — see the N1-D evidence file for the captured output.

## Fixture provenance

| Fixture | Class | Source |
|---|---|---|
| `n1b-fixture` | SYNTHETIC | verbatim copy of Phase 4 generated asset `081350cef7f5c83e05c3e6c1` (real, ACCEPTED) |
| `n1c-asym-fixture` | SYNTHETIC | procedurally derived from the above: three non-mirror-symmetric marks drawn onto its texture; silhouette, alpha, control points and mesh byte-identical |
| replay pose sequence | SYNTHETIC | interpolated between committed golden keyframes, themselves perturbations of the research fixture generator's base standing pose |

No person imagery. No retailer imagery. No recorded video. No licensed
media. Nothing here carries a rights question.

## Hostile-audit scope (amendment D24)

Prepared, not yet run. Attacks this work should be probed with:

1. **Reference/native geometry drift** — re-run the goldens after any
   geometry edit; confirm the frozen 0.05 px tolerance still holds.
2. **Mirror inversion / left-right swapping** — the asymmetric fixture has
   zero mirror overlap; try to find a transform that defeats both the
   numeric ordering assertions and the raised-shoulder pair.
3. **Canvas / UI-thread misuse** — confirm no geometry runs in `onDraw`;
   confirm the geometry stack still has zero Android imports.
4. **Replay/render coupling** — confirm the producer still outruns a slow
   consumer by a wide margin; a regression toward 1:1 means coupling.
5. **Backpressure fake-pass** — confirm `dropped > 0` is still reachable;
   if it ever cannot be, the test is INVALID, not passing.
6. **Stale BodyFrames** — snapshots carry `bodyFrameId` = `sourceId#index`;
   look for any path where a drawn snapshot's index lags the cursor.
7. **Product-switch tearing** — try to observe A's geometry under B's id.
8. **Post-dispose callbacks** — try to make any event fire after the
   terminal `DISPOSED` event.
9. **Bridge payload leakage** — add a field to `ReplayEvent` and confirm the
   privacy test fails.
10. **Network leakage** — re-run the network grep; monitor a device run.
11. **Asset / variant identity** — confirm `activeAssetId` and
    `assetVersion` always describe the asset actually drawn.
12. **Reference-defect laundering** — confirm the four N1-ENV-008
    divergences are still printed and still classified, never folded into
    the agreeing count.
