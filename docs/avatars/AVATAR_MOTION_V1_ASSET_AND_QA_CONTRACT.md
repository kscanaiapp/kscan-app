# Elise Avatar Animation V1 — Capability, Asset, and Deferred QA Contract

Source-only document. No build, export, deploy, or device measurement was
performed for it. Every capability claim below is derived from the shipped
avatar configuration in `constants/stylistIdentity.ts` by
`services/avatarMotionCapabilities.ts`; nothing here is asserted independently
of that configuration.

## 1. Capability truth at the current baseline

Priority portraits (`stylist_portrait_01` … `stylist_portrait_04`; 05 and 08
carry the same mouth configuration):

| Capability | State | Basis |
| --- | --- | --- |
| Three-state mouth | YES | closed / half-open / open 1024×1024 PNG sets are bundled and calibrated per portrait |
| Round mouth | NO — assets missing | no `round` entry exists in any `mouthStateSources`; renderer falls back round → open |
| Blink | NO — assets missing | no eye overlays exist; blink must never be simulated by distorting the portrait |
| Brows | NO — assets missing | no brow overlays exist |
| Independent gaze | NO — assets missing | no eye overlays exist; no camera or attention tracking is in scope |
| Head motion | YES | rigid whole-composite transform; needs no new assets |
| Upper-body motion | YES | rigid whole-composite transform; needs no new assets |

Abstract avatars, portrait placeholders, and unknown IDs resolve to the
fail-closed all-false capability set and render as static treatments.

### 1.1 Facial expansion status (feature/avatar-facial-expansion-v2)

The facial expansion pass implemented the complete **source systems** for all
five deferred feature groups, asset-ready and fully tested:

| Feature group | Source status | Asset status |
| --- | --- | --- |
| Round mouth | rendering + viseme mapping + fallback COMPLETE | **BLOCKED — 4 approved assets required** |
| Blink | deterministic scheduler + driver + eye layer COMPLETE | **BLOCKED — 12 approved eye overlays required** |
| Brows | deterministic rules + rendering path COMPLETE | **BLOCKED — 12 approved brow overlays required** |
| Local gaze targeting | semantic targets + arbitration COMPLETE | rendering gated on the eye package |
| Tap acknowledgement | COMPLETE and active behind the motion flag | none required |

Capabilities remain **false** because the overlay registry
(`constants/avatarFacialOverlays.ts`) is empty: producing, visually
reviewing, measuring, and registering the owner-approved overlay art is the
single remaining act that flips each capability on. The rendering paths are
proven asset-ready by tests that inject a simulated registry — those doubles
are clearly marked test-only and are never presented as production assets.

Round mouth, blink, brows, and gaze must **not** be described as shipped
until their assets land and pass visual review.

## 2. Future asset specification

New eye, brow, and round-mouth assets should be **localized transparent
overlays**, not full-canvas images, wherever technically feasible. Each asset
package must define:

- `avatarId`
- `source` (static local `require`)
- localized region (normalized x, y, width, height)
- anchor point
- pixel dimensions
- blend margin
- supported state
- fallback state

The current full-canvas mouth files stay exactly as they are. Migrating them
to the localized-overlay coordinate convention is a separate, dedicated,
tested change and must not be folded into motion work.

### 2.1 Asset requirements report

**Round-mouth overlays — 4 required**

| # | File | Avatar | Purpose |
| --- | --- | --- | --- |
| 1 | `avatar_stylist_01_mouth_round.png` | 01 | rounded vowel viseme (o/u/w) |
| 2 | `avatar_stylist_02_mouth_round.png` | 02 | same |
| 3 | `avatar_stylist_03_mouth_round.png` | 03 | same |
| 4 | `avatar_stylist_04_mouth_round.png` | 04 | same |

Must match the existing per-portrait mouth region calibration, lighting, and
skin tone. Until they exist, `roundMouth` stays false and the renderer serves
the open frame.

**Eye overlays — 3 states × 4 avatars = 12 required**

`open`, `half`, `closed` per avatar. Localized to the eye region with a blend
margin wide enough to hide the seam at the rendered header size (67 px) and at
the Home card size (75–90 px).

**Brow overlays — 3 states × 4 avatars = 12 required**

`neutral`, `raised`, `focused` per avatar. Localized to the brow region.

No fabricated, generated, or approximated substitutes may be shipped for any
of the above.

## 3. Feature control

| Flag | Default | Effect when off |
| --- | --- | --- |
| `EXPO_PUBLIC_AVATAR_MOTION_V1` | false (fails closed) | **fully static portrait** — see the contract below |
| `EXPO_PUBLIC_AVATAR_SPEECH_FIXTURE` | false (plus `__DEV__`) | the local speech fixture is unreachable |

### 3.1 Static flag-off contract (owner decision, KAVA-P2-003)

`EXPO_PUBLIC_AVATAR_MOTION_V1=false` means a **fully static portrait**. With
the flag off there is:

- no legacy pulse (the previous idle/thinking scale loop was **removed**, not
  merely bypassed — there is no animated fallback presentation any more);
- no breathing;
- no head movement;
- no blink;
- no brow movement;
- no gaze movement;
- no tap animation;
- **zero `Animated.loop` calls** and a **neutral (absent) composite
  transform**, asserted directly by `avatarIdleMotion.test.js`;
- no motion-only subscriptions (the conversation hook and mode hook subscribe
  to nothing and start no timers);
- voice remains independently available.

Voice scope: speech audio and its three-state mouth overlay are part of the
separately controlled voice feature that shipped before this flag existed.
They are unaffected by the motion flag — that is what "voice remains
independently available" requires, and it is why the mouth overlay is absent
from the prohibition list above. Lip-sync uses no animation loop, so the
zero-loop guarantee holds during speech as well.

The same fully static presentation is used whenever motion is unavailable for
any other reason: Reduce Motion, a `static` avatar state, or an avatar without
head/upper-body motion capability (for example any abstract preset).

### 3.2 The flag is build-time, not runtime

`AVATAR_MOTION_V1_ENABLED` is resolved once from `process.env` at module
evaluation. It is **not** dynamically switchable during a live session:
changing the environment variable requires a new bundle/build, and there is no
in-session toggle, no remote-config lookup, and no runtime override path.
Enabling or disabling motion for a running install is a release action, not a
configuration action. Remote configuration is explicitly out of scope for this
pass.

Motion and voice are independently controllable: disabling motion never
disables speech audio, and the existing voice-responses preference never gates
motion. No automatic device-memory classification was added — there is no
trusted device-capability abstraction in the repository to base one on, so
degradation is configuration-driven plus measured device QA.

## 4. Graceful degradation

- **Speech failure** — neutral idle, text response retained, no negative
  expression, no stuck mouth, no stuck timer.
- **Controller failure / disposal** — every input is rejected, listeners are
  cleared, snapshot returns to neutral, static portrait remains visible.
- **Asset failure** — round → open → half-open → closed; a missing facial
  overlay degrades to the static portrait. StyleChat is never blocked.
- **Flag failure / absence** — fails closed to static behavior.
- **Reduce Motion** — no breathing, head, gaze, blink, or decorative
  expression transition; no anti-pop interpolation; mouth closed; status text
  retained.

The static portrait is always the final safe fallback.

## 5. Source-level performance evidence

Measured by the focused suites, not by device instrumentation:

| Property | Evidence |
| --- | --- |
| Timeline construction count | `avatarMotionTimeline.test.js` — one build per alignment generation across hundreds of playback lookups |
| Lookup cost | same suite — advancing cursor stays near O(intervals + ticks); a rescan-per-tick implementation fails the bound |
| Discrete rerender count | `avatarHeaderRenderCount.test.js` — the real `StyleChatHeader` is driven through a counting render root: ~90 in-interval playback ticks produce **zero** rerenders, and rerender count tracks discrete mouth changes rather than tick volume. Store-level corroboration in `avatarMotionRenderIsolation.test.js` |
| Motion lifecycle reset | `avatarMotionLifecycleMatrix.test.js` — unmount, background/inactive, and avatar switch from each of pending-listening, listening, thinking, ready/preparing, anti-pop, speaking, and reacting all end fully neutral, with stale callbacks rejected and re-entry still able to speak |
| Malformed input safety | `avatarMotionInputValidation.test.js` — malformed alignment yields an empty timeline or the deterministic fallback and never an invalid open-mouth interval; invalid generations are rejected without mutating generation authority |
| Flag-off static contract | `avatarIdleMotion.test.js` — zero `Animated.loop` calls and a neutral (absent) composite transform in every state when the flag is off |
| Timer count at rest | `avatarMotionController.test.js` — the controller source contains no `setTimeout`/`setInterval`/`requestAnimationFrame`; the single listening-hysteresis timer is cleared by its effect cleanup (`avatarMotionHardening.test.js`) |
| Subscription count after teardown | `avatarMotionRenderIsolation.test.js` (upstream released at zero subscribers), `avatarSpeechLifecycle.test.js` (one AppState listener, removed on teardown) |
| Disposal | `avatarMotionController.test.js` — dispose clears listeners and rejects every later input |
| Stale-callback rejection | `avatarSpeechLifecycle.test.js`, `avatarLocalSpeechFixture.test.js`, `avatarMotionController.test.js` |
| Selected-avatar-only mounting | `avatarMotionRendererAdapter.test.js` — one base portrait and at most one mouth overlay; composite keyed by `avatarId` |
| Avatar-switch teardown | `avatarIdleMotion.test.js` — old loops stop and values reset before the new avatar animates |

No explicit native image-cache eviction is claimed. Assigning an `Image`
source to null is **not** treated as a cache purge anywhere in this work.

No CPU, memory, or frame-rate thresholds are asserted. Budgets must be
established from real device measurements.

## 6. Deferred device QA protocol

Run on representative low-, typical-, and higher-performance iOS and Android
hardware selected from the team's confirmed available test matrix. No specific
device models are required here because availability has not been confirmed.

Scenarios:

1. Cold launch to static portrait
2. Idle → listening → thinking → speaking → idle
3. Background mid-speech
4. Foreground after interruption
5. Rapid avatar switching
6. Reduce Motion enabled (including toggled mid-speech)
7. Screen reader enabled
8. Provider failure
9. Local speech fixture
10. Repeated utterances
11. Leaving and reopening StyleChat
12. Mouth registration during head motion

Memory measurement points to record for each device:

- baseline memory before entering StyleChat
- memory after repeated utterances
- memory after rapid avatar switching
- memory after leaving StyleChat
- render smoothness observations
- background/foreground cleanup behavior

**Pass condition:** no monotonic retained-memory pattern attributable to
active avatar instances, based on real device evidence. Frame-rate and CPU
budgets are to be derived from these measurements, not assumed in advance.
