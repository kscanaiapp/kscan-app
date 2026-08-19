# Avatar Engine V10 — integration status

Phase: **Sarah shadow**. Updated 2026-08-19.

## Identifiers

Three different numbers describe this engine. They move independently and must
never be conflated — "V10" is not contract 10 and not package 10.0.0.

| Identifier | Value | Meaning |
|---|---|---|
| `ENGINE_PRODUCT_VERSION` | `V10` | Engine generation as product work. Successor to the V9 candidate. |
| `ENGINE_PACKAGE_VERSION` | `10.0.0` | Semver of the engine module. Vendored into the app, not published; declared for provenance. |
| `AVATAR_ENGINE_CONTRACT_VERSION` | `2` | Host/engine wire contract. Bumped only by a breaking snapshot or frame change. |

Derived from `@kscan/avatar-animation-engine` 9.0.0. Source of truth:
`services/avatars/engine/version.ts`. Pinned by test.

## Frozen decisions

### 1. `motionEpoch` is host-authoritative

The engine consumes the epoch and never increments or manufactures one. Owned by
`services/avatars/avatarMotionEpoch.ts`, which bumps on avatar switch, session
switch, actor change, or explicit invalidation.

This was a real defect in the V9 candidate: `loadAvatar` incremented the epoch
itself, every frame then carried an epoch the host had never issued, and the
renderer's identity check silently dropped all of them while the engine reported
`speaking-alignment` and believed it was animating correctly. Enforced
structurally — no engine file may contain a `motionEpoch` increment.

### 2. Android is source-compatible, **not** certified

Zero `Platform.OS` in the engine or adapter, deterministic seeded blink, and
identical calculation on both platforms are strong design evidence. They are not
runtime validation. Android is not validated until this delta is replayed onto
the Android convergence line and executed there.

```
CROSS-PLATFORM DESIGN:  READY
ANDROID RUNTIME:        NOT TESTED
IOS RUNTIME:            NOT TESTED
```

### 3. Elise package status is separate from engine validation

"Validates against the Elise registry entry" means the registry data forms a
structurally valid package. It is **not** a statement that Elise's facial artwork
is geometrically approved. The known Elise package problem is tracked separately
and is not cleared by any V10 result.

| Avatar | Engine validation | Art approval |
|---|---|---|
| Sarah (`stylist_portrait_05`) | valid; basic lip sync, no round | first integration control |
| Elise (`stylist_portrait_02`) | valid; adds round lip sync | **separate, unresolved** |

Eye and brow artwork exists for `stylist_portrait_02`, but no eye or brow
**region** is calibrated in the registry. Blink, brows and gaze therefore stay
off by fail-closed derivation rather than compositing at a guessed position.

### 4. Reduce Motion — verified, unchanged

Governance required preserving the current K Scan accessibility interpretation
rather than inventing a new one. **The existing contract is static neutral,
including the speech channel**, confirmed at three independent layers:

- `services/avatarSpeechMotion.ts` returns `closed` under `reducedMotion` for
  both aligned and fallback playback
- `hooks/useReducedMotion.ts`: *"Visual motion (idle, thinking, lip movement)
  must stop. Greeting text and manual audio playback remain available."*
- `components/stylist/AnimatedStylistAvatar.tsx` forces `state = 'static'`, which
  never enters the mouth-state branch

An existing passing test already asserted it. **V10 reproduces this exactly** —
no product-policy change. Audio keeps playing; the face does not move. Both paths
are now pinned together by a parity test so neither can drift alone.

## Migration modes

```
LEGACY        legacy calculates, legacy renders
V10_SHADOW    legacy calculates, legacy renders; V10 calculates, V10 records
V10_VISIBLE   V10 calculates, V10 renders          <- CLOSED THIS PHASE
```

Set with `EXPO_PUBLIC_AVATAR_VISUAL_MODE`. Default `LEGACY`; unrecognized values
fail closed to `LEGACY`.

`V10_VISIBLE_MODE_AVAILABLE` is `false`. A request for `V10_VISIBLE` is
**downgraded to `V10_SHADOW`** rather than rejected, so a typo or stale build
profile cannot put an unproven visual system in front of a user, while the
request still produces data. Opening the gate is a deliberate one-line change
made only after visible Sarah is approved.

The mode affects visuals only. It is never consulted to decide whether a message
speaks, whether audio starts, or how the speech lifecycle behaves.

## Shadow wiring

One call site: `components/style-chat/StyleChatHeader.tsx`, in a post-render
effect. The legacy value is computed, rendered and remains authoritative; V10
recalculates the same snapshot, records, and its answer is discarded.

Running in an effect rather than during render means the visible path never pays
for V10's calculation and no shadow system sits between the host and what it
draws. It reuses the `speechState` the component already subscribed to, so there
is no second subscription, no duplicated speech state and no second clock.

```
ONE message · ONE speech request · ONE alignment · ONE audio player
ONE playback clock · ONE generation · ONE motion epoch
```

## Sarah dataset to capture

Collected by `services/avatars/avatarShadowBridge.ts` via `getAvatarShadowReport()`.

| Measurement | Source |
|---|---|
| Audio start unchanged | existing speech regressions |
| V10 timeline compile ms | `engine.timelineCompileMs` |
| V10 frame calc p50/p95/max | `engine.frameCalcMs` |
| Playback → first legacy mouth | `legacy.playbackToFirstMouthMs` |
| Playback → first V10 mouth | `v10.playbackToFirstMouthMs` |
| Alignment input/retained/discarded | `engine.counters.ALIGNMENT_*` |
| Transitions per second, both paths | `legacy` / `v10.transitionsPerSecond` |
| Completion + interruption resets, both paths | `legacy.resets`, `engine.counters.RESET_*` |
| Repeat utterance | `repeatUtterancePasses` |
| Stale frame rejections + reasons | `v10.staleFrameRejections`, `v10.frameReasons` |
| Engine error fallback | `v10.calculationErrors`, `v10.neutralFrames` |
| Resource cleanup | `engine.activeEngineTimers/SubscriptionsAfterTeardown` |

**No acceptance thresholds are defined yet, by design.** Sarah's measured
baseline comes first; gates for later avatars and platforms are justified from
that data, not invented ahead of it.

### Expected divergence

V10 differs from the legacy path in two deliberate ways: it applies **no global
0.100s minimum-state floor**, and it **closes the mouth on labial consonants**
(b/m/p), where the legacy path opened them to `halfOpen`. Both produce a busier,
more literal reading of the same alignment.

On synthetic character alignment the divergence is already measurable — roughly
3× the transitions and ~0.67 frame agreement. Those numbers are **not** the Sarah
baseline; they only indicate the shape of the difference the real dataset must
adjudicate. Whether it reads better on a device is exactly what shadow mode is
for.

## Exit conditions

- Speech unchanged **and** V10 data correct → visible Sarah
- Speech unchanged **but** V10 visual timing poor → stay in shadow, fix only the
  demonstrated engine problem
- Speech timing or lifecycle changes at all → **reject the integration**;
  something crossed the speech boundary despite the structural protections

Only after visible Sarah passes does Henry follow. Elise follows Henry, gated
separately on art approval.

## Deferred

Blink during speech (`blinkDuringSpeech: false`, explicit config flag), brows,
expressions, gaze, Elise asset expansion, full body (contract reserved, optional
`body` channel, unimplemented).

## Known unrelated failure

`__tests__/eliseIdentity.test.js` → "accessible labels use dynamic Elise
language" fails on pristine `convergence/build29-ios-release-candidate`.
`components/style-chat/StyleChatAttachmentBar.tsx` hard-codes the attach
accessibility label instead of reading `ELISE_IDENTITY.attachAccessibilityLabel`.
Pre-existing, tracked separately, does not affect V10 pass/fail — but it is still
a failure and must be corrected before full release certification.
