# Avatar Engine V10 — integration status

Phase: **Build 32 canonical Elise visible convergence**. Updated 2026-08-26.

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

### 2. Android uses the same source authority

Zero `Platform.OS` in the engine or adapter and deterministic calculation keep
the V10 authority identical on iOS and Android. Platform certification is
recorded separately from this source contract.

```
CROSS-PLATFORM DESIGN:  READY
ANDROID RUNTIME:        SEE BUILD 32 CONVERGENCE REPORT
IOS RUNTIME:            SEE BUILD 32 CONVERGENCE REPORT
```

### 3. Canonical Elise package authority

The persisted `elise_default` identity resolves to the owner-approved visible
portrait `stylist_portrait_01`. `stylist_portrait_02` remains Henry. V10 follows
that current Build 32 authority; it does not reinterpret portrait 02 as Elise.

| Avatar | Engine validation | Art approval |
|---|---|---|
| Sarah (`stylist_portrait_05`) | valid; basic lip sync, no round | first integration control |
| Elise (`stylist_portrait_01`) | valid; basic lip sync, no round | approved historical closed/half-open/open set, alpha-blended at `dc13d04` |
| Henry (`stylist_portrait_02`) | valid; adds round lip sync | Henry-only package; never assigned to Elise |

Eye and brow artwork exists for Henry (`stylist_portrait_02`), but no eye or brow
**region** is calibrated in the registry. Blink, brows and gaze therefore stay
off by fail-closed derivation rather than compositing at a guessed position.

### 4. Reduce Motion — verified, unchanged

Governance required preserving the current K Scan accessibility interpretation
rather than inventing a new one. **The existing contract is static neutral,
including the speech channel**, confirmed at three independent layers:

- Avatar Engine V10 returns `closed` under `reducedMotion` for both aligned and
  fallback playback
- `hooks/useReducedMotion.ts`: *"Visual motion (idle, thinking, lip movement)
  must stop. Greeting text and manual audio playback remain available."*
- `components/stylist/AnimatedStylistAvatar.tsx` forces `state = 'static'`, which
  never enters the mouth-state branch

Audio keeps playing; the face does not move. V10 pins this policy directly.

## Visible authority

```
avatarSpeechStore       speech lifecycle authority
stylistAudioPlayback    native playback authority
Avatar Engine V10       alignment, timeline and visible mouth authority
AnimatedStylistAvatar   the single pixel renderer
```

`StyleChatHeader` computes its mouth state directly through the process-wide V10
adapter. It has no legacy visual-mode branch and no import of
`deriveAvatarMouthState`, so a build flag cannot resurrect the prior compiler.

## Runtime wiring

One visible call site: `components/style-chat/StyleChatHeader.tsx`. It reuses the
single existing `speechState` subscription and feeds the real generation,
normalized alignment and native playback position into V10. No second speech
state, playback clock, provider request, subscription or timer is introduced.

```
ONE message · ONE speech request · ONE alignment · ONE audio player
ONE playback clock · ONE generation · ONE motion epoch
```

## Historical Sarah dataset

The shadow bridge remains test/diagnostic source history only. It is not imported
by the visible StyleChat runtime.

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

- Speech unchanged and V10 lifecycle correct → converge the same authority to Android
- Any speech timing or lifecycle regression → reject the convergence
- Any Elise/Henry asset crossover or second timeline → reject the convergence

## Deferred

Blink during speech (`blinkDuringSpeech: false`, explicit config flag), brows,
expressions, gaze, optional Elise round-mouth expansion, full body (contract reserved, optional
`body` channel, unimplemented).

## Regression note

The former attachment accessibility assertion expected the static
`ELISE_IDENTITY.attachAccessibilityLabel`. The production component already uses
the selected stylist's `resolvedStylistName`; the regression now pins that
dynamic label instead of requiring the obsolete static constant.
