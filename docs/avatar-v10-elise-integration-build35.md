# Avatar Engine V10 → Elise — Build 35 gated integration and certification

Lane: **gated integration + certification**, source and CI only.
No merge, no deploy, no EAS build, no production or staging mutation.

---

## 1. Authority and base

```
BASE_BRANCH      fix/notifications-final-convergence-v1
BASE_SHA         4b776a7733764cb85b2feab2026a7bccb1b02d30
                 ("Merge pull request #401 from
                   kscanaiapp/integration/build35-convergence-checkpoint-v1")
UPSTREAM_SHA     4b776a7733764cb85b2feab2026a7bccb1b02d30
AHEAD_BEHIND     0 / 0 at worktree creation
WORKTREE_CLEAN   YES (fresh `git worktree add`, 0 modified files)
BRANCH           integration/build35-elise-avatar-v10-v1
```

**Why this base, and not the checkout this lane started in.** The session's
initial checkout was on `master` @ `bc3a306`, which is a **297-file** tree with
**zero** avatar files — not the development authority. The Build 35 development
authority is named by `docs/build35-convergence-checkpoint.md`
(`fix/notifications-final-convergence-v1` @ `047cce3a`, checkpoint branch
`integration/build35-convergence-checkpoint-v1` @ `61e7d72e`); that checkpoint
has since been merged back via PR #401, so its tip `4b776a77` is the current
authority and carries the checkpoint as an ancestor. Verified:

```
$ git merge-base --is-ancestor 61e7d72e origin/fix/notifications-final-convergence-v1 && echo ancestor
ancestor
$ git merge-base --is-ancestor ee65cd0c origin/fix/notifications-final-convergence-v1 && echo ancestor   # PR #333 head
ancestor
$ git ls-tree -r --name-only origin/master | wc -l           # Build 34 release line, untouched
297
$ git ls-tree -r --name-only origin/master | grep -ci avatar
0
```

Build 34 release authority (`master`) was **not modified**.

### PR #333 status and relationship

`#333` — *"Build 35: certify V10 avatar engine source authority (staging)"* —
is **MERGED** (2026-09-10), head `ee65cd0c`, and is an ancestor of this base. It
changed **no application source**; it added
`docs/avatar-engine-v10-build35-staging-certification.md`. Its central finding is
confirmed independently below: V10 is already the sole unconditional visible
renderer for Elise, so there is no shadow-to-visible migration left to perform.
Its verdict was `SOURCE COMPLETE — DEVICE QA PENDING`, with one recorded coverage
gap, **V10-CERT-001** (no automated test for an in-progress utterance across a
real backgrounding or native audio interruption). **This lane closes
V10-CERT-001** — see §11.

---

## 2. V10 engine certification (Phase 0A)

Engine identity, from `services/avatars/engine/version.ts:30-31` and
`services/avatars/engine/contract.ts:34`: product `V10`, package `10.0.0`, wire
contract `2`. These are three independent numbers and are not interchangeable.

| Claim | Value | Anchor | Test |
|---|---|---|---|
| `V10_ENGINE_PRESENT` | **YES** | `services/avatars/engine/**` — 19 files, 2375 lines (`config.ts`, `contract.ts`, `types.ts`, `version.ts`, `runtime/AvatarRuntime.ts`, `speech/{compileTimeline,TimelineCursor,viseme,fallback}.ts`, `motion/{blink,composite,expression,gaze}.ts`, `package/{manifest,validate}.ts`, `validation/{alignment,generation}.ts`, `instrumentation/metrics.ts`) | `avatarEnginePackage`, `avatarEngineContract` |
| `V10_TESTS_PRESENT` | **YES** | 9 pre-existing suites: `avatarEngine{Contract,EliseConvergence,HostAdapter,Lifecycle,Package,Purity}`, `avatarIdlePresence`, `avatarShadowMode`, `avatarSpeechMotion` | — |
| `V10_TEST_BASELINE` | **242 / 242 pass, 0 fail** on the untouched base | `node --test` over the 16 avatar/Elise/speech suites at `4b776a77` | see §10 |
| `V10_RENDERER_PRESENT` | **YES** | `components/stylist/AnimatedStylistAvatar.tsx:129-214` (one tree for every state; mouth overlay at `98-127`) | `eliseMouthRegistration`, `avatarSpeechMotion` |
| `V10_STATE_API_PRESENT` | **YES** | `contract.ts:48-111` (`AvatarSpeechRuntimeSnapshot`, host → engine) and `178-215` (`AvatarVisualFrame`, engine → host) | `avatarEngineContract` |
| `V10_SPEECH_ANIMATION_PRESENT` | **YES** | `engine/speech/compileTimeline.ts` compiles provider character alignment into a frozen interval timeline; `TimelineCursor.ts` resolves a mouth state from the native playback position; `AvatarRuntime.ts:260-281` | `avatarEngineContract` ("the five governed phrases animate deterministically from native playback and finish closed") |
| `V10_STALE_EVENT_PROTECTION_PRESENT` | **YES** | `contract.ts:226-238` `isFrameApplicable` (avatarId + speechGeneration + motionEpoch triple); `AvatarRuntime.ts:334-378` `reconcileLifecycle`; `avatarEngineAdapter.ts:140-145` | `avatarEngineLifecycle`, and NC-2 below |
| `V10_REDUCE_MOTION_PRESENT` | **YES** | `AvatarRuntime.ts:242` — `if (snapshot.reduceMotion) return this.neutralFrame('reduced-motion', …)` | `avatarAccessibilityPosture` ("the engine returns a neutral frame and draws no mouth") |
| `V10_FALLBACK_PRESENT` | **YES** | `engine/package/validate.ts:280-316` fail-closed capability derivation; `engine/speech/fallback.ts`; `AnimatedStylistAvatar.tsx:79-90` `resolveMouthStateSource` degradation chain | `avatarEnginePackage`, `avatarAssetCoverage` |

**`ENGINE_INTEGRATABLE = YES`.** No engine construction was required. The engine
core was not modified by this lane.

---

## 3. Authoritative state map (Phase 0B)

Every authority below was traced from producer to consumer in source. Nothing
was invented, and no second owner was created.

### AUTHORITATIVE_ELISE_STATE_SOURCE

```
file        hooks/useStyleChat.ts
lines       129 (declaration), 409 (set true), 812 (cleared in `finally`), 853 (exported)
type        React state `isSending: boolean`, mirrored into `isSendingRef`
owner       useStyleChat
updated_by  sendMessage() — true when a turn is sent, false when it settles
consumed_by app/style-chat/[sessionId].tsx:837  ->  <StyleChatHeader isThinking={isSending} />
```

```ts
// hooks/useStyleChat.ts:408-409
      isSendingRef.current = true;
      setIsSending(true);
```

### AUTHORITATIVE_LISTENING_SOURCE

```
file        services/voice/voiceStateMachine.ts (reducer), hooks/useVoiceScan.ts:268
lines       voiceStateMachine.ts:61,71-97 ; useVoiceScan.ts:268 (`isListening: state === 'listening'`)
updated_by  the Voice Scan capture session only
```

```ts
// hooks/useVoiceScan.ts:268
    isListening: state === 'listening',
```

**This authority governs Voice Scan, not Elise, and Voice Scan renders no
avatar.** Elise's composer has no voice input:

```ts
// components/style-chat/StyleChatInput.tsx:4
const VOICE_UI_ENABLED = false;
```

So **`LISTENING_CONNECTED = NO_AUTHORITY_EXISTS`**: the projection implements and
tests LISTENING, and the Elise host passes a literal `false` for it. Microphone
permission is never treated as listening — the projection has no permission,
amplitude or audio-level input at all, and `resolveAvatarSpeakingCoverage` has no
access to one. Wiring Voice Scan's state into the Elise avatar would have been
inventing a coupling the app does not have, which this lane is forbidden to do.

### AUTHORITATIVE_PLAYBACK_SOURCE

```
file        stores/avatarSpeechStore.ts (state)  +  services/avatarSpeech.ts (lifecycle)
lines       avatarSpeechStore.ts:3-9 (phases), 19-31 (state), 103-172 (transitions)
            avatarSpeech.ts:53 (generation counter), 152-235 (speak), 238-261 (stop)

start       beginAvatarSpeech()         store:103   phase 'requesting'
            markAvatarSpeechReady()     store:127   phase 'ready'   (alignment arrives)
active      markAvatarSpeechPlaying()   store:139   phase 'playing' (CONFIRMED native start)
            updateAvatarSpeechPlayback()store:143   position, ~12.5Hz
pause       NO AUTHORITATIVE PAUSE STATE EXISTS — see below
complete    finishAvatarSpeech()        store:168   -> reset to idle
cancel      markAvatarSpeechStopping()  store:155   phase 'stopping'
error       setAvatarSpeechError()      store:159   phase 'error'

utterance/session identity
            `generation` — a monotonic module-level counter owned by
            services/avatarSpeech.ts:53,83-86. Every start and every stop takes
            the next value. Identity is NEVER the message text: the service is
            given references only (actorId, sessionId, messageId, stylistId) and
            the authenticated Edge Function owns the text.
```

```ts
// services/avatarSpeech.ts:83-90
function nextGeneration(): number {
  generation += 1;
  return generation;
}

function isCurrent(value: number): boolean {
  return generation === value;
}
```

**On pause.** The lifecycle has no `paused` phase, and `expo-audio` is driven
without a user-facing pause control, so there is nothing authoritative to
observe. What the dispatch's "pause → stop/suspend speaking animation" asks for
is nonetheless satisfied structurally: the engine is driven by the **native
playback position only** (`contract.ts:60-72`), so a player that stops advancing
stops advancing the mouth, and the position is held rather than re-anchored to
zero. A frozen position for longer than the 3s stall bound is reclassified as a
failure by the watchdog (`stylistAudioPlayback.ts:31,66-74`), which ends the
utterance and closes the mouth. Recorded as **no-authority**, not as connected.

### AUTHORITATIVE_ACCESSIBILITY_SOURCE

```
file        hooks/useReducedMotion.ts
lines       20-24 (subscription), 52-54 (hook)
```

```ts
// hooks/useReducedMotion.ts:20-24
function ensureSubscribed() {
  if (subscription) return;
  subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setValue);
  AccessibilityInfo.isReduceMotionEnabled().then(setValue).catch(() => {});
}
```

One cross-platform React Native API, no `Platform.OS` branch, motion held **off**
until the native preference is known.

```
AUTHORITATIVE_STATE_CONFIDENCE     = HIGH
AUTHORITATIVE_PLAYBACK_CONFIDENCE  = HIGH
```

Both traced producer → consumer, and both now **executed** end to end by
`__tests__/avatarLifecycleHardening.test.js`, which runs the real store, the real
service, the real playback module and the real adapter together.

---

## 4. Live render path (Phase 0C)

```
app/style-chat/[sessionId].tsx:835-841
  -> components/style-chat/StyleChatHeader.tsx (isThinking={isSending}, sessionId)
     -> useAvatarSpeechState()                            store subscription, x1
     -> resolveAvatarSpeakingCoverage(visualAvatarId)     approved-asset capability
     -> deriveAvatarPresentation({...})                   THE projection
     -> getAvatarEngineAdapter().computeFrame({...})      V10, one call per render
        -> AvatarRuntime.update(snapshot)
     -> <AnimatedStylistAvatar state=… mouthState=… motion=… />
        -> <StylistAvatar />           approved base portrait
        -> <MouthStateLayer />         approved mouth frame, only when resolved
```

```
CURRENT_VISIBLE_RENDERER   Avatar Engine V10, via AnimatedStylistAvatar
V10_CURRENTLY_ACTIVE       YES
ACTIVATION_GATES           NONE
LEGACY_RENDERER            none reachable
ASSETS_BUNDLED             YES
```

`ACTIVATION_GATES = NONE` was checked, not assumed: there is no feature flag, no
`__DEV__` gate, no EAS/profile gate and no remote-config read anywhere in the
call path. `eas.json` sets `EXPO_PUBLIC_ELISE_V10: "true"` on the staging
profiles, but **no app source reads that key** — it is decorative, and V10
renders identically in every profile including production. Pinned by
`avatarShadowMode` ("no visual-mode environment branch can resurrect the legacy
renderer", "no retired visual-mode gate can reactivate legacy rendering in
StyleChat"). No flag was added by this lane, and none was removed.

**Second render surface.** `components/home/HomeStylistCard.tsx:75-80` also
renders `AnimatedStylistAvatar`, with a hard-coded `state="idle"` and no engine
connection. That is correct as it stands: Elise cannot speak there — the only
callers of `speakAvatarMessage` are `hooks/useStyleChat.ts:328,773` and
`components/style-chat/StyleChatVoiceRetry.tsx:65`, all inside StyleChat. The
Home card is a static portrait, not a second animation authority, and was left
untouched.

```
LEGACY_RENDERER_DISPOSITION
  services/avatarSpeechMotion.ts   TYPE-ONLY. Its three importers
                                   (AnimatedStylistAvatar, avatarShadowBridge,
                                   avatarEngineAdapter) all use `import type`;
                                   `avatarEngineEliseConvergence` asserts zero
                                   active production importers.
  services/avatars/avatarShadowBridge.ts
                                   DEAD for rendering. Retained only as an
                                   instrumentation surface for existing tests;
                                   the header imports neither it nor its report
                                   formatter (pinned by `avatarShadowMode`).
  DISPOSITION                      Not used as a fallback, accidental or
                                   otherwise. Nothing in this lane revives
                                   either module. Their eventual deletion is a
                                   separate, undispatched decision.
```

---

## 5. Asset coverage grid (Phase 0D)

Machine-readable artifact: **`artifacts/avatar-v10-asset-coverage.json`**
Generator: **`scripts/generate-avatar-asset-coverage.js`** (`--check` fails if the
committed artifact drifts).

Coverage is derived twice and cross-checked: once from the **validated engine
package** (`avatarAssetCoverage.ts` → `resolveAvatarPackage` → `validate.ts`), and
once from the **registry's own `require()` paths on disk**, so an asset that is
declared but absent cannot be reported as approved. Result:
`registryAssetCount: 34`, `registryAssetsMissingOnDisk: []`.

`M` = MAPPED, `D` = DEGRADED, `—` = MISSING.

| preset | draws | voice | tier | IDLE | LISTEN | THINK | SPK_CLOSED | SPK_HALF | SPK_OPEN | INTERRUPT | ERROR |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `elise_default` | `stylist_portrait_01` | feminine | basic | M | D | M | M | **D** | M | D | M |
| `stylist_portrait_01` (Elise) | self | feminine | basic | M | D | M | M | **D** | M | D | M |
| `stylist_portrait_02` (Henry) | self | masculine | **full** | M | D | M | M | M | M | D | M |
| `stylist_portrait_05` (Sarah) | self | feminine | **full** | M | D | M | M | M | M | D | M |
| `stylist_portrait_08` | self | masculine | **full** | M | D | M | M | M | M | D | M |
| `stylist_portrait_03` (Janet) | self | feminine | none | M | D | M | **D** | **D** | **D** | D | M |
| `stylist_portrait_04` (Marie) | self | masculine | none | M | D | M | **D** | **D** | **D** | D | M |
| `stylist_portrait_06` (Vivian) | self | masculine | none | M | D | M | **D** | **D** | **D** | D | M |
| `stylist_portrait_07` | self | feminine | none | M | D | M | **D** | **D** | **D** | D | M |
| `stylist_portrait_09` | self | feminine | none | M | D | M | **D** | **D** | **D** | D | M |
| `stylist_portrait_10` | self | masculine | none | M | D | M | **D** | **D** | **D** | D | M |
| `editorial_plum` | self | **silent** | none | M | D | M | — | — | — | D | M |
| `chrome_muse` | self | **silent** | none | M | D | M | — | — | — | D | M |
| `deep_space` | self | **silent** | none | M | D | M | — | — | — | D | M |
| `cream_gold` | self | **silent** | none | M | D | M | — | — | — | D | M |
| `obsidian_orchid` | self | **silent** | none | M | D | M | — | — | — | D | M |

Totals: **MAPPED 61, DEGRADED 52, MISSING 15** across 16 presets × 8 states.
The 15 MISSING cells are the five silent abstract presets' three speaking states
— unreachable by construction, not absent artwork.

Exact paths are in the artifact. Representative cells:

```
stylist_portrait_01 / SPEAKING_CLOSED  MAPPED
  assets/stylist-avatars/portraits/animated/avatar_stylist_01_mouth_closed.png
stylist_portrait_01 / SPEAKING_HALF    DEGRADED  (degrades to closed)
  assets/stylist-avatars/portraits/animated/avatar_stylist_01_mouth_closed.png
stylist_portrait_02 / SPEAKING_HALF    MAPPED
  assets/stylist-avatars/portraits/animated/avatar_stylist_02_mouth_half_open.png
stylist_portrait_03 / SPEAKING_OPEN    DEGRADED  (base pose held)
  assets/stylist-avatars/portraits/stylist_portrait_03.jpg
```

**Elise's own half-open frame is deliberately not registered.** The file
`avatar_stylist_01_mouth_half_open.png` exists but is a different subject in a
different pose; `constants/stylistIdentity.ts:584-592` records the measurement
(11–23/255 difference for the registered frames vs 39–56/255 for that file) and
the consequence: clipping it into the mouth rectangle pasted a stranger's chin
over Elise's mouth. Consonants therefore degrade to `closed`. **No artwork was
generated, converted or substituted by this lane.**

### DEGRADATION_CONTRACT = PRESENT

Committed as executable text in `services/avatars/avatarAssetCoverage.ts`
(`AVATAR_DEGRADATION_CONTRACT`) so the behaviour and its description cannot
drift, and asserted by `avatarAssetCoverage`:

1. **MAPPED requires an approved descriptor** in the validated engine package.
   Coverage can only under-claim.
2. **Missing speaking frames degrade along the renderer's existing chain** —
   `round → open → halfOpen → closed`, and `halfOpen → closed`
   (`AnimatedStylistAvatar.tsx:79-90`). Never a placeholder, never a generated
   frame, never another portrait's artwork.
3. **No approved speaking frames is not a blocker.** The avatar holds its
   approved base pose and SPEAKING is carried by the header's existing status
   channel, so **degraded SPEAKING stays visibly distinct from IDLE** for all ten
   such avatars with no new artwork.
4. **LISTENING and INTERRUPTED** have no approved artwork on any avatar; both
   draw the approved base pose while the engine still receives the real mode.
5. **Reduce Motion** holds the approved base pose for every avatar, and the
   status channel again carries SPEAKING.

**For owner review:** rule 3 is the one that is a product judgement rather than a
mechanical consequence. Ten of the sixteen selectable presets — including six
shipped portraits a customer can choose today — cannot move their mouth at all,
and under this contract their only speech cue is an 8px status dot in the header.
That is honest and it is built from already-approved presentation, but if the
intent is that a chosen stylist should visibly speak, the answer is approved
mouth artwork for those six portraits, not a change here.

---

## 6. Edit surface

Declared before editing, and unchanged since except for the one addition noted.

| file | purpose |
|---|---|
| `services/avatars/avatarPresentation.ts` | **NEW.** The one pure avatar-state projection. |
| `services/avatars/avatarAssetCoverage.ts` | **NEW.** Per-avatar × per-state coverage + the degradation contract. |
| `components/style-chat/AvatarStateInspector.tsx` | **NEW.** Development-only inspector. |
| `components/style-chat/StyleChatHeader.tsx` | **EDIT.** Route the renderer state, the engine mode and the status channel through the projection; mount the inspector. |
| `scripts/generate-avatar-asset-coverage.js` | **NEW.** Emits the coverage artifact; `--check` guards drift. |
| `artifacts/avatar-v10-asset-coverage.json` | **NEW, generated.** The machine-readable grid. |
| `scripts/measure-avatar-integration-overhead.js` | **NEW.** JS-level measurement (§12). |
| `__tests__/avatarPresentationProjection.test.js` | **NEW.** 23 cases. |
| `__tests__/avatarAssetCoverage.test.js` | **NEW.** 18 cases. |
| `__tests__/avatarStateInspector.test.js` | **NEW.** 8 cases. |
| `__tests__/avatarLifecycleHardening.test.js` | **NEW.** 24 cases. |
| `__tests__/avatarAccessibilityPosture.test.js` | **NEW.** 9 cases. |
| `docs/avatar-v10-elise-integration-build35.md` | **NEW.** This report. |
| `services/avatars/avatarEngineAdapter.ts` | **EDIT, added to this list during Phase 2** — see §7. |

Files outside this list: **0**. Forbidden surfaces touched: **0** —

```
$ git diff --name-only 4b776a77..HEAD | grep -iE 'eas\.json|app\.json|supabase/|\.github/|android/|ios/|package(-lock)?\.json|config/|server\.js'
(no output)
```

No speech-generation, LLM, entitlement, Commerce, VTO, Packing, Watchlist or
backend change was required, so no `HOLD_ARCHITECTURE_CONFLICT`.

### Diff size — declared over the dispatch's 600-line threshold

```
$ git diff --numstat 4b776a77..HEAD | awk '{a+=$1;d+=$2} END {print a+d}'
4390
```

Justification, offered before this report was the last edit and with no further
source edit made after it:

| part | lines | why |
|---|---|---|
| generated artifact | 1092 | machine-written JSON; the dispatch requires a machine-readable grid |
| tests | 2024 | five suites; the dispatch requires full state coverage, an adversarial scheduler, 100-cycle leak tests, accessibility, failure isolation and six negative controls |
| scripts | 496 | the coverage generator and the measurement harness the dispatch asks for |
| **product source** | **778** | of which 279 + 230 + 93 = 602 are the three new modules the dispatch names (projection, coverage/degradation contract, inspector), heavily commented in this repository's house style; 77 is the header rewiring and 99 the adapter repair |

The **behavioural** change to shipped code is the header's rewiring (58 added, 19
removed) and the adapter's outer guard. Everything else is new, self-contained
presentation-only code, generated data, or verification.

---

## 7. Changes

### 7a. `services/avatars/avatarPresentation.ts` — the projection (Phase 1A)

```ts
deriveAvatarPresentation({
  playbackPhase, playbackScopeMatches, playbackActive, utteranceGeneration,
  eliseProcessing, listening, reduceMotion, mouthCapable, assetsAvailable,
}) -> { state, rendererState, semanticMode, speaking, interrupted,
        speakingDegraded, statusSpeaking, statusThinking, reason,
        utteranceGeneration }
```

A pure function — no clock, no store, no React, no timer, no network — loaded in
tests through the engine harness, whose default is to **throw on any bare
import**, so its purity is proven rather than asserted. It replaces three
separate inline readings of the same authorities in the header.

Priority, highest first, each rule a read of an authority and never an
inference:

```
1. FALLBACK      no shipped preset for this avatar id
2. INTERRUPTED   playback was cancelled or failed for this surface
3. SPEAKING      playback is running for this surface
4. LISTENING     an authoritative capture session is live
5. THINKING      Elise is preparing a reply and playback is inactive
6. IDLE          none of the above
```

- **SPEAKING requires the store's phase and the host's own observation to
  agree**, so a malformed snapshot fails closed instead of opening the mouth.
- An **unrecognized phase is not activity**; a non-integer utterance identity is
  reported absent rather than guessed.
- **Reduce Motion never changes the state** — a Reduce Motion user is still told
  Elise is speaking — it only makes the renderer static and hands the
  distinction to the status channel.
- LISTENING outranks THINKING because a live capture is a present user action.
  The pair cannot both be true on any shipped surface today; the order is fixed
  here rather than left to whichever host reads them first.

### 7b. `components/style-chat/StyleChatHeader.tsx` — one projection per render

The renderer state, the engine's `semanticMode` and the status channel now all
read the same projection result. The retired inline ternaries cannot regrow —
`avatarPresentationProjection` asserts the header no longer contains
`avatarState = 'speaking'`, `avatarState = 'thinking'` or `isThinking &&
!isSpeaking`.

The status dot follows the projection rather than Reduce Motion or mouth
capability. **That is the single change that keeps degraded SPEAKING visibly
distinct from IDLE** for the ten avatars with no approved speaking frames and for
every Reduce Motion user.

Every spelling the pre-existing suites pin was preserved deliberately — one
`useAvatarSpeechState()`, one `getAvatarEngineAdapter().computeFrame`, the
`mouthState={visual.mouthState}` binding, both `result.frame.*` reads, the
`speechState.phase === 'playing'` scope read, and the exact
`useAvatarIdlePresence({ enabled: !reducedMotion && !isSpeaking })` form.

### 7c. `services/avatars/avatarEngineAdapter.ts` — the one repair (P2)

`computeFrame()` was documented as *"never throwing"*, and the engine it calls
is: `AvatarRuntime.update()` converts any internal defect into a neutral frame.
**The adapter was not.** Normalizing host state runs before the engine is asked
anything, and it runs inside the Elise header's render, so a host value that
throws while being read escaped as an exception — which would have taken the
whole conversation surface down over a presentation detail. That is a direct
violation of this lane's own invariant ("renderer failure interrupts Elise
speech/conversation" is listed as a defect), which is why it is repaired here
rather than reported.

Severity **P2**, caused-by/blocking: the failure-isolation requirement of this
integration is what exposed it.

```
REPRODUCE (before):  computeFrame() with a speech snapshot whose `alignment`
                     getter throws  ->  the exception propagates out
AFTER:               one neutral frame, mouthState 'closed', applied false,
                     CALCULATION_ERRORS incremented; speech still playing and
                     still advancing
```

The neutral frame is built in the adapter rather than by calling back into the
runtime, so an error path cannot disturb the engine state of a live utterance.

### 7d. `components/style-chat/AvatarStateInspector.tsx` — dev-only inspector (Phase 1E)

Shows the authoritative Elise state, the mapped avatar state, the playback state,
the utterance identity, the animation epoch and the transition reason. Returns
`null` outside `__DEV__`, holds no state, starts no timer, makes no request,
logs nothing, and is hidden from assistive technology on both platforms. The
test **renders it in a sandbox where `useState`, `setTimeout` and `fetch`
throw**, so the claim is executed rather than read.

---

## 8. Phase 1 MVP gate

| requirement | status | evidence |
|---|---|---|
| 1. V10 connected to the real Elise render path | **MET** (pre-existing, verified) | §4; `avatarEngineEliseConvergence`, `avatarShadowMode` |
| 2. IDLE ↔ SPEAKING derives from authoritative playback | **MET** | `avatarPresentationProjection`; `avatarLifecycleHardening` drives the real store end to end |
| 3. Speech start never waits for V10 | **MET** | §12; NC-4 |
| 4. Playback cancel/end stops the speaking animation | **MET** | `avatarLifecycleHardening` SCHEDULER cases; NC-3 |
| 5. Avatar failure cannot break Elise | **MET** | §7c; `avatarLifecycleHardening` ISOLATION cases; NC-5 |
| 6. Unknown state maps safely | **MET** | `avatarPresentationProjection` "UNKNOWN input resolves safely" (8 hostile shapes) |
| 7. Approved assets / degradation contract honoured | **MET** | §5; `avatarAssetCoverage`; NC-6 |

---

## 9. Coherence invariants (Phase 1D)

Each is a defect; each is now pinned.

| invariant | pinned by |
|---|---|
| mouth moves after playback stops | `avatarLifecycleHardening` — post-cancel and post-completion frames are `closed` |
| mouth moves while Elise is only thinking | `avatarPresentationProjection` — THINKING yields `rendererState: 'thinking'`, engine mouth `closed` |
| listening pose appears when listening is false | `avatarPresentationProjection` — no permission/amplitude input exists; header passes literal `false` |
| thinking pose remains while idle | `avatarPresentationProjection` — IDLE yields `statusThinking: false`, `rendererState: 'idle'` |
| previous utterance callback modifies the current one | `avatarLifecycleHardening` — old-complete / old-error / old-progress after a new start |
| two animation loops control the same avatar | pre-existing `avatarIdlePresence` ("speech and idle never drive the clock at the same time"), preserved |
| cancelled speech continues animating | `avatarLifecycleHardening` — "events that arrive after cancellation change nothing" |
| unmounted/backgrounded avatar keeps working | `avatarLifecycleHardening` — BACKGROUND cases + 100 mount/unmount cycles |
| renderer failure interrupts Elise | §7c + ISOLATION cases |

---

## 10. Test baseline and classification

Baseline captured on the **untouched** base `4b776a77` before any edit.

```
$ node --test <16 avatar/Elise/speech suites>        # base, no edits
# tests 242   # pass 242   # fail 0

$ npx tsc --noEmit                                    # base, no edits
(clean)

$ node scripts/run-all-tests.js                       # base, no edits
# tests 8594  # pass 8515  # fail 14  # skipped 65
Known full-suite failure baseline: 19 identities.
Observed failures: 14; known: 13; unexpected: 1.
Unexpected failing tests:
- no ML Kit, Gradle, model asset or new permission came along
```

**The one "unexpected" baseline failure is an artifact of this session's shallow
clone, not of the source.** `__tests__/mirrorIosVisionParity.test.js:253` runs
`git show 507cec9a:app.json`, and that commit was not in the shallow history:

```
fatal: path 'app.json' exists on disk, but not in '507cec9a...'
```

After `git fetch origin 507cec9a`, the suite is **20/20 pass** with no source
change. The true baseline on the authority is therefore **13 known, 0
unexpected**. The baseline file `config/test-failure-baseline.json` was **not
modified** and **not widened**.

---

## 11. Phase 2 results

### 2A Full state coverage
IDLE, LISTENING, THINKING, SPEAKING, INTERRUPTED and FALLBACK are each resolved
and asserted, together with the full priority matrix, in
`avatarPresentationProjection`. No new application authority was created to
reach any of them.

### 2B Stale event / concurrency
Deterministic fake clock throughout. **No `sleep`, no wall-clock delay, no
"advance time then hope" anywhere** — every timer in
`avatarLifecycleHardening` is a fake whose firing the suite chooses, so each
assertion is an ordering. Superseded epochs are refused; repeated epoch bumps
never lock out the next utterance; a superseded player's watchdog cannot
terminate the live one.

### 2C Adversarial scheduler
Delayed, duplicated, reordered, post-cancel, post-unmount,
old-complete-after-new-start and error-after-new-start, plus a superseded stall
watchdog. In every case the newest authoritative state wins and the stale event
reaches neither the screen nor the lifecycle.

### 2D Leaks
- **100 conversation turns**: live timers return to baseline **after every single
  turn** (asserted per turn, not just at the end); **one** AppState listener
  serves the whole conversation; all 100 temporary speech files released; the
  final frame is `closed`.
- **100 adapter mount/unmount cycles**: each disposed adapter answers `closed`
  with `reason: 'disposed'` and retains no timeline.
- **Background**: no animation channel advances while backgrounded — two
  consecutive background frames are identical and `neutral`.

**Recorded, not repaired (P3, instrumentation only).** After a *clean completion*
the engine retains exactly one compiled timeline — the last utterance's — which
the next utterance replaces. The adapter's `reconcileSpeechEnd` does not fire on
a clean completion because `finishAvatarSpeech` clears the utterance's identity
in the same store update that clears its phase, so the adapter no longer "owns"
the utterance it would be ending, and `RESET_COMPLETION` stays at zero. It is
**visually inert** (a non-playing phase already yields a closed mouth) and
**bounded, not accumulating** — the retained interval count after 100 turns
equals the count after 10, which the leak test asserts. Pre-existing on the
authority, outside this lane's minimal surface, and reported rather than fixed.

### 2E Accessibility
`avatarAccessibilityPosture` executes `hooks/useReducedMotion.ts` against a fake
`AccessibilityInfo`:

```
REDUCE_MOTION_IOS       = PASS (source+harness)  AccessibilityInfo.isReduceMotionEnabled / reduceMotionChanged
REDUCE_MOTION_ANDROID   = PASS (source+harness)  same API; zero Platform branches
```

One cross-platform API serves iOS **Reduce Motion** and Android **Remove
animations**; motion is held off until the native preference is actually known;
the subscription does not leak. With motion reduced, all three states hold the
face static **and all three remain distinguishable** — the status channel gives
IDLE / SPEAKING / THINKING three different signatures. The avatar, its mouth
overlay, the status dot and the inspector are all hidden from the accessibility
tree on both platforms; nothing asks for focus; a screen-reader user still
receives text rather than speech.

Note: iOS Reduce Motion and Android Remove Animations were verified at the
**source and harness** level. Neither was toggled on a physical device — see
§16.

### 2F Failure isolation
Missing asset, unknown avatar id, malformed snapshot (every optional field
invalid), renderer defect, playback event with no renderer mounted, and a speech
backend failure. In every case **Elise continues, speech continues, and a safe
static approved presentation remains.**

### 2G Negative controls — 6 / 6

Each mutant was applied locally, the named protection test was required to
**fail**, the file was reverted, the tree was proven clean, and the test was
required to pass again. **No mutant was committed** (`git status --porcelain`
empty after every revert).

| ID | mutant | target test | mutant | reverted | tree |
|---|---|---|---|---|---|
| **NC-1** | key utterance identity on speaker+session instead of the utterance lifecycle (`operationKey` drops `messageId`) — `services/avatarSpeech.ts` | `REPEATED UTTERANCE: the same text twice is two utterances, keyed on the lifecycle` | **FAIL** ✓ | PASS | clean |
| **NC-2** | remove stale motion-epoch protection from `isFrameApplicable` — `engine/contract.ts` | `STALE EPOCH: a frame from a superseded epoch is never applied` | **FAIL** ✓ | PASS | clean |
| **NC-3** | skip the cancellation cleanup (`finishAvatarSpeech` after stop) — `services/avatarSpeech.ts` | `SCHEDULER: events that arrive after cancellation change nothing` | **FAIL** ✓ | PASS | clean |
| **NC-4** | await avatar readiness on the playback-start path — `services/avatarSpeech.ts` | `SPEECH START never awaits avatar readiness` | **FAIL** ✓ | PASS | clean |
| **NC-5** | let a renderer exception propagate (remove the §7c guard) — `avatarEngineAdapter.ts` | `ISOLATION: an engine calculation failure becomes a neutral frame, not an exception` | **FAIL** ✓ | PASS | clean |
| **NC-6** | permit a borrowed asset to be reported as approved coverage — `avatarAssetCoverage.ts` | `ASSET AUTHORITY: MAPPED requires an approved descriptor in the engine package` | **FAIL** ✓ | PASS | clean |

NC-1 note: the speech service is never given the reply text — it takes
references only — so "identity keyed on text alone" is not directly
representable. The mutant used is its nearest faithful form: collapse identity so
that two *different* replies become one utterance. The engine-side equivalent
(identity not taken from the generation counter) is separately pinned by the
pre-existing `avatarEngineLifecycle` "a repeated utterance after completion
starts cleanly".

### 2H Performance

`node scripts/measure-avatar-integration-overhead.js` — Node process, fake audio
player, **no device and no simulator**. The script records
`claimsPhysicalDeviceLatency: false` in its own output.

```
playback start, avatar path IDLE    BASELINE  mean 0.1675ms  p50 0.1428  p95 0.2137  max 0.8135
playback start, avatar path DRIVEN  AFTER     mean 0.1566ms  p50 0.1516  p95 0.1977  max 0.2272
                                    DELTA     -0.0109ms  (n=50 each; negative, i.e. inside noise)

rendered frames (projection + engine), 50 turns x 38 frames at the header's real 12.5Hz cadence
                                    n 1900   mean 0.0097ms  p50 0.0063  p95 0.0164  max 0.4347
drift, first half -> second half    -0.0015ms
live timers at end                  0
final phase                         idle
```

Anomalies: **none**. The only outliers are single-sample maxima consistent with
JIT warm-up (baseline max 0.8135ms on the first of 50 iterations).

The architectural requirement — **zero avatar readiness gating of speech start**
— is established by the architecture test and NC-4, not by these numbers. The
numbers only corroborate it. **No physical-device latency is claimed.**

### 2I Cost / network proof

```
NEW_AI_API_CALLS   = 0
NEW_AI_PROVIDER    = 0
NEW_PROVIDER_COST  = 0
```

```
$ git diff 4b776a77..HEAD -- package.json package-lock.json | wc -l
0

$ git diff --name-only 4b776a77..HEAD | grep -E 'package(-lock)?\.json|supabase/functions'
(no output)

$ git diff 4b776a77..HEAD -- '*.ts' '*.tsx' '*.js' | grep -E '^\+' | \
    grep -iE 'fetch\(|axios|XMLHttpRequest|WebSocket|EventSource|\.invoke\(|supabase|elevenlabs|openai|anthropic|gemini|replicate|https?://'
(no output)
```

Pinned by two executed tests in `avatarLifecycleHardening`:
- *"COST: the avatar integration adds no network call site and no provider"* —
  the three new modules contain no `fetch`/`axios`/`XMLHttpRequest`/`WebSocket`,
  no Supabase or Edge-Function call, no provider name and no URL; their only
  bare import across all four avatar files is `react-native`.
- *"COST: the new modules pull in no dependency the app did not already have"* —
  every bare specifier used by this lane's files is already used elsewhere in the
  app, and a set of state-management and provider packages is asserted absent.

No new application state-management library was introduced.

---

## 12. Runtime speech evidence

```
PLAYBACK_WIRING_VERIFIED   = YES
RUNTIME_SPEECH_VERIFIED    = PENDING
```

`PLAYBACK_WIRING_VERIFIED` is a **contract** claim and is earned: the real store,
the real `services/avatarSpeech.ts`, the real `stylistAudioPlayback.ts` and the
real `speechAppState.ts` are executed together, with only the backend, the temp
file and the native player injected. Start, active, complete, cancel, error, the
stall watchdog and both platforms' native-interruption shapes are all driven.

`RUNTIME_SPEECH_VERIFIED = PENDING` because no live ElevenLabs call was made and
none could be: it needs an authenticated session and the deployed
`stylist-speech` Edge Function. **The synthetic playback contract tests above
must not be read as live ElevenLabs runtime evidence.** No EAS profile and no
staging secret was modified to manufacture this certification.

---

## 13. Visibility and flags

No EAS, profile, remote-config or production flag change was committed, and none
was needed: V10 is already unconditionally visible (§4). No local runtime
injection was required either. Nothing in this lane needs future activation —
there is no new flag to turn on.

---

## 14. Phase 3 clean verification

Run from a clean tree (`git status --porcelain` empty) after all edits finished
and after every negative-control revert.

| verification | command | result |
|---|---|---|
| typecheck | `npx tsc --noEmit` | **PASS** (exit 0, no output) |
| lane suites (28 files) | `node --test <28 avatar/Elise/speech/header/parity suites>` | **PASS — 468 / 468, 0 fail, 0 skipped** |
| new suites (5 files) | included above | **PASS — 82 / 82** (23 + 18 + 8 + 24 + 9) |
| negative controls | see §2G | **6 / 6 PASS** |
| coverage artifact currency | `node scripts/generate-avatar-asset-coverage.js --check` | **PASS** — "artifact is current" |
| dependency reachability | `npm run verify:dependency-reachability` | **PASS** — no unapproved findings, no path drift |
| native config parity | `npm run verify:native-config-parity` | **PASS** — app.json agrees with the authoritative source |
| security validation | `npm run verify:security` | **11 passed, 1 failed — KNOWN_BASELINE**, see below |
| clean tree / diff | `git status --porcelain` | empty |
| full governed regression | `node scripts/run-all-tests.js` | **PASS (exit 0) — 8598 / 8676, 13 fail, all 13 known baseline, 0 unexpected** |

```
$ node scripts/run-all-tests.js          # clean tree, after all edits
Total test files to execute: 488
# tests 8676   # pass 8598   # fail 13   # skipped 65
Known full-suite failure baseline: 19 identities.
Observed failures: 13; known: 13; unexpected: 0.
Only recorded pre-existing failures remain; fixed baseline failures are allowed to disappear.
```

Test count moved from the base's **8594** to **8676**: +82, exactly the cases
added by this lane. The 13 remaining failures are the same 13 recorded
identities present on the untouched base — Closet media dimensions, migration
schema assumptions, `config.toml` JWT posture, two cross-path parity checks, five
`stylechat-generate` edge-source checks, an anon-EXECUTE migration check and two
staging flag-parity checks. **None touches avatars, Elise, speech or
accessibility.** `config/test-failure-baseline.json` is unmodified.

The one security failure is *"ZAP target validation matrix localhost reject:
staging URL hostname does not exactly match ZAP_ALLOWED_HOST"* — an unset
environment variable in this shell, not a source finding. Confirmed pre-existing
by checking out the untouched base `4b776a77` and re-running: **same 1 failure**.

### Classification

```
PASS            every lane suite and every governed verification above
KNOWN_BASELINE  13 pre-existing full-suite failures (unchanged, not widened)
                + 1 ZAP environment-variable security check
NEW_FAILURE     0
```

### NOT_RUN — mandatory disclosure

```
NOT_RUN_COUNT = 7

1. iOS native build           No macOS/Xcode toolchain here, and this repository
                              has no `ios/` project at all (it would need
                              `expo prebuild --platform ios` first).
2. Android native build       Not attempted this lane. PR #333 built
                              `:app:assembleDebug` successfully at `219f27a`;
                              this lane changed no native, Gradle or manifest
                              file, so that result is unaffected — but it was
                              not re-run here and is not claimed as this lane's.
3. Physical iOS device QA     No device attached.
4. Physical Android device QA No device attached.
5. Live ElevenLabs speech     Needs an authenticated session and the deployed
                              Edge Function. §12.
6. Perceptual / visual QA     Needs a human watching a real screen. In
                              particular, nobody has LOOKED at degraded
                              SPEAKING on the six mouthless portraits.
7. On-device Reduce Motion /  Verified at source and harness level only (§2E);
   Remove Animations          neither OS setting was toggled on hardware.
```

---

## 15. Defect ledger

| ID | severity | status | what |
|---|---|---|---|
| AV10-INT-001 | **P2** | **FIXED** (§7c) | `AvatarEngineHostAdapter.computeFrame` could throw out of the Elise header's render while normalizing host state, despite being documented as never throwing. Pinned by NC-5. |
| AV10-INT-002 | **P3** | **REPORTED, not fixed** (§2D) | `reconcileSpeechEnd` does not fire on a clean completion, because the store clears the utterance's identity in the same update as its phase. One compiled timeline is retained until the next utterance, and `RESET_COMPLETION` stays 0. Visually inert, bounded, pre-existing. |
| V10-CERT-001 | coverage gap | **CLOSED** | PR #333's recorded gap — no automated test for an in-progress utterance across a backgrounding or native audio interruption. Now pinned on both platforms' shapes (§2D). |

No P0 or P1 defect was found. No unrelated defect was hunted.

---

## 16. Counter-report — the case against READY

**The strongest reason this may still be wrong is that nobody has looked at it.**
Every claim here is source, harness or CI evidence; not one frame of Elise has
been rendered on a screen in this lane. The change that most deserves a human
eye is the one I am most confident about architecturally and least able to
verify perceptually: routing the status dot through the projection so that
degraded SPEAKING is "visibly distinguishable" from IDLE. I have proven that the
projection emits three distinct status signatures and that the header consumes
them — but "an 8px dot changes colour" being an adequate speech cue for the six
shipped portraits that cannot move their mouths is a **product judgement made on
a JSON grid, not on a phone**, and a reviewer could reasonably call it
insufficient. The same applies to Reduce Motion: I proved one cross-platform API
and three distinguishable states, but I toggled a fake `AccessibilityInfo`, not
an iOS or Android settings switch. A second, narrower risk: the projection is
pure and total, but it is now the single point through which all four
authorities flow, so any future authority added to Elise that is *not* passed
into it will silently present as IDLE — a failure mode that is invisible rather
than loud.

**The strongest unavailable evidence is runtime.** There is no device, no
simulator, no macOS toolchain and no live ElevenLabs call in this environment, so
`RUNTIME_SPEECH_VERIFIED` is honestly PENDING and every timing number is a Node
measurement that must not be read as latency. `PLAYBACK_WIRING_VERIFIED = YES`
rests on executing the real store, service, playback module and AppState binding
against an injected native player — strong for the contract, silent about what
`expo-audio` actually does on an interrupted iPhone. Two further limits are worth
naming plainly: the Android native build was **not** re-run this lane (PR #333's
successful build stands, and nothing native changed, but that is inference rather
than this lane's measurement), and AV10-INT-002 is a real divergence between a
documented mechanism and its behaviour that I chose to report rather than repair
under P3 authority. None of that makes the integration wrong; it makes the
verdict *source-complete and device-pending* rather than certified. Reconsidering
on that basis, `READY_FOR_OWNER_REVIEW` would overstate what was actually
proven — the integration is correct and the degradation is real, documented and
deliberate, which is exactly `READY_WITH_DOCUMENTED_DEGRADATION`, and the
device-certification limits belong in the NOT_RUN list rather than in the verdict,
since no device claim is being made at all.

---

## 17. Required final flags

```
ENGINE_INTEGRATABLE                 = YES
AUTHORITATIVE_STATE_CONFIDENCE      = HIGH
AUTHORITATIVE_PLAYBACK_CONFIDENCE   = HIGH

V10_VISIBLE_RENDER_PATH_CONNECTED   = YES  (pre-existing; independently verified)
PLAYBACK_WIRING_VERIFIED            = YES
RUNTIME_SPEECH_VERIFIED             = PENDING

LISTENING_CONNECTED                 = NO_AUTHORITY_EXISTS
                                      (projected + tested; Elise has no voice
                                       input; mic permission is never listening)
THINKING_CONNECTED                  = YES  (useStyleChat.isSending)
SPEAKING_CONNECTED                  = YES  (avatarSpeechStore phase + generation)
INTERRUPTION_SAFE                   = YES
REPEATED_UTTERANCE_SAFE             = YES
STALE_EVENT_SAFE                    = YES
UNKNOWN_STATE_MAPS_SAFE             = YES

AVATAR_GATES_SPEECH_START           = NO

FAILURE_ISOLATION_SAFE              = YES
REDUCE_MOTION_IOS                   = PASS (source + harness; not device-toggled)
REDUCE_MOTION_ANDROID               = PASS (source + harness; not device-toggled)
BACKGROUND_LOOP_SAFE                = YES

ASSET_COVERAGE_GRID                 = PRESENT  (artifacts/avatar-v10-asset-coverage.json)
DEGRADATION_CONTRACT                = PRESENT  (AVATAR_DEGRADATION_CONTRACT)

LEGACY_RENDERER_DISPOSITION         = UNREACHABLE, TYPE-ONLY IMPORTS, NOT USED
                                      AS A FALLBACK; deletion deferred as a
                                      separate decision

NEW_AI_API_CALLS                    = 0
NEW_AI_PROVIDER                     = 0
NEW_PROVIDER_COST                   = 0

IOS_SOURCE_PATH_VERIFIED            = YES  (one shared implementation; zero
                                            Platform.OS branches in
                                            services/avatars/**)
ANDROID_SOURCE_PATH_VERIFIED        = YES  (same shared implementation)
IOS_DEVICE_VERIFIED                 = NO
ANDROID_DEVICE_VERIFIED             = NO

NOT_RUN_COUNT                       = 7   (§14)
NEW_FAILURE_COUNT                   = 0
```

---

## 18. Final verdict

```
READY_WITH_DOCUMENTED_DEGRADATION
```

The integration is correct and minimal: V10 was already the sole visible
renderer, and this lane supplies what was actually missing — one reviewable
projection instead of three inline readings, LISTENING resolved honestly as
having no Elise authority, a machine-readable coverage grid with an explicit
degradation contract, a development-only inspector, one P2 repair to make the
integration surface total, and falsification across concurrency, leaks,
background, accessibility and cost with six negative controls.

The **documented degradation** is real and is the owner's call, not mine: ten of
sixteen selectable presets — six of them shipped portraits — have no approved
speaking artwork, and for them SPEAKING is carried by the header's status channel
alone. Elise's own canonical portrait has no approved half-open frame, so her
consonants degrade to closed.

READY does **not** mean device certification occurred. It did not: no iOS build,
no device on either platform, no live ElevenLabs call, no human has watched a
frame. Those are §14's NOT_RUN list.

**No merge. No deploy. No EAS build.** Owner merges.
