# Sarah shadow QA protocol

> Historical protocol only. Build 32 visible convergence no longer imports the
> shadow bridge from the StyleChat runtime; this document is retained as source
> evidence for the V10 candidate measurements captured before convergence.
>
> **Build 34: the `EXPO_PUBLIC_AVATAR_VISUAL_MODE` variable referenced below no
> longer exists.** `services/avatars/avatarVisualMode.ts` was deleted — it had
> no production consumer and its own comments claimed V10 had "never rendered a
> pixel in the real app" while V10 was in fact the live visible renderer.
> Setting that variable now does nothing at all. The steps below cannot be run
> as written and are kept only as a record of how the candidate was measured.

Run this on a device against the real speech backend. It produces the dataset
that decides whether V10 goes to visible Sarah or needs one focused timing fix.

Frozen QA candidate: tag **`v10-sarah-shadow-qa-freeze-2026-08-19`** = `d0a11d6`
on `feature/avatar-engine-v10-integration-readiness`.

Build from that tag. Commits after it are documentation only — the built
application is byte-identical — but building the tag removes all doubt. No
engine changes until this dataset exists.

## Setup

Stylist must be **Sarah** (`stylist_portrait_05`) — the mouth-only control. Not
Elise, whose art status is separately gated.

```bash
EXPO_PUBLIC_AVATAR_VISUAL_MODE=V10_SHADOW npx expo start
```

Confirm before starting:

- a signed-in account with StyleChat access, so `stylist-speech` returns real
  audio and real alignment
- Reduce Motion **off** in system accessibility settings (its parity is already
  verified by test; leaving it on suppresses everything and produces no data)
- a dev build — capture is `__DEV__`-only
- the Metro / Xcode / logcat console visible

## What happens automatically

Each time an utterance stops playing, the full dataset prints to the console,
already formatted in the protocol's field names. Nothing to call, nothing to
install. Copy each block into the results table.

The visible avatar is still the **legacy** mouth. V10 is calculating invisibly.
If the avatar looks any different from today's build, that is itself a finding —
report it, because shadow mode must not change a pixel.

## Run each shape TWICE

`AUDIO_START` only answers "without changing audio start" if there is a baseline
to compare against. For each of the five shapes, capture:

1. `EXPO_PUBLIC_AVATAR_VISUAL_MODE=LEGACY` → engine never runs
2. `EXPO_PUBLIC_AVATAR_VISUAL_MODE=V10_SHADOW` → engine runs invisibly

`AUDIO_START` must be statistically unchanged between the two. Any consistent
increase is grounds to reject the integration outright — the engine is
structurally off the audio path, so movement there means something crossed the
speech boundary.

## The five shapes

Vary the sentence, not just the length, so a real engine problem can be told
apart from sentence-specific behaviour.

| # | Shape | Ask Sarah something that produces | Targets |
|---|---|---|---|
| 1 | Short greeting | one short sentence | first-mouth timing, startup |
| 2 | Many labials | a reply dense in **b / m / p** — ask about *bomber jackets, bags, boots, my best pieces* | the deliberate labial-closure change |
| 3 | Pauses | a reply with commas and clause breaks — ask for a list, e.g. *"what three things should I pack?"* | pause handling; chatter vs hang |
| 4 | Longer natural response | a full stylist answer, several sentences | sustained cadence, frame calc p95 |
| 5 | Interrupted mid-speech | start a long reply, then **navigate away or background the app mid-sentence** | interruption reset, stale takeover, no frozen open mouth |

Then, still in `V10_SHADOW`:

6. **Repeat** — trigger shape 1 again and confirm it still animates
   (`REPEAT_UTTERANCE PASS`)
7. **Avatar switch** — change stylist mid-session, then speak again; confirm no
   stale frame and `AVATAR_SWITCH_RESET` increments

## Also try to catch a stall

The stall-hold path is the single most important hardening in this pass and it
only exercises on a real device. Force it by degrading the network or
backgrounding briefly during playback, then check `STALL_HOLD > 0`.

When a stall occurs, the mouth must **hold its position and resume**, never snap
shut and replay the opening of the sentence. That visual check matters as much
as the counter.

## Record per sample

Printed automatically:

```
AUDIO_START
PLAYBACK_TO_FIRST_MOUTH_LEGACY
PLAYBACK_TO_FIRST_MOUTH_V10
TIMELINE_COMPILE_MS
FRAME_CALC_P50 / P95 / MAX
ALIGNMENT_INPUT / RETAINED / DISCARDED
LEGACY_TRANSITIONS_PER_SEC
V10_TRANSITIONS_PER_SEC
FRAME_AGREEMENT
STALL_HOLD
COMPLETION_RESET
INTERRUPTION_RESET
REPEAT_UTTERANCE
STALE_FRAME_REJECTIONS
ENGINE_ERRORS
```

Filled in by the QA person. No interpretation required — just observation:

```
SAMPLE:                  1-5
MODE:                    LEGACY / V10_SHADOW
FIRST WORD SARAH SAYS:   <the opening word, verbatim>
VISIBLE LEGACY MOUTH:    looked normal / chatter / lag / other
AUDIO:                   normal / delayed / interrupted / other
NOTES:
```

`FIRST WORD` is not cosmetic. It is the only thing that makes
`PLAYBACK_TO_FIRST_MOUTH_V10` interpretable, and it cannot be recovered after
the run — see below.

Then, for cadence adjudication, a person watching the face:

```
MOUTH SYNC      legacy / V10 / tie
CADENCE         natural / too busy / too sluggish
LABIALS         correct / overclosed / underclosed
PAUSES          good / chatters / hangs
FACE STABILITY  pass / fail
```

### Why the opening word matters

A lower `PLAYBACK_TO_FIRST_MOUTH_MS` is **not** automatically better. The real
criterion is time to the first *phonetically correct* mouth change.

If the utterance opens on a bilabial (b / m / p), the correct behaviour is:

```
audio starts -> mouth stays CLOSED -> consonant releases -> mouth opens
```

V10 will report a later first-mouth than legacy there, and V10 is right —
legacy's immediate `halfOpen` is an incorrect opening that merely happens to
record 0 ms. If the utterance opens on a vowel, the same delay would be a
genuine defect.

The engine does not record the opening viseme, so this distinction has to come
from the sentence itself. Without the opening word written down, every
first-mouth number in the dataset becomes uninterpretable and the run has to be
repeated.

To judge MOUTH SYNC honestly, the legacy mouth is what is on screen. Compare the
**numbers** for timing, and use the visual only for cadence, labials, pauses and
stability. A true side-by-side visual comparison is not possible until visible
Sarah.

## The four questions this answers

1. **Timing** — does V10 reach the first *phonetically correct* mouth change
   sooner than legacy, with `AUDIO_START` unchanged? Read
   `PLAYBACK_TO_FIRST_MOUTH_V10` against the sample's FIRST WORD, never on its
   own: closer to zero is only better when the utterance opens on a vowel.
2. **Cadence** — `V10_TRANSITIONS_PER_SEC` vs `LEGACY_TRANSITIONS_PER_SEC`,
   adjudicated by the CADENCE judgment. Synthetic alignment predicts ~3×.
3. **Phonetics** — shape 2 plus the LABIALS judgment.
4. **Stability** — shapes 5–7, the stall, `STALE_FRAME_REJECTIONS`,
   `ENGINE_ERRORS`, and FACE STABILITY.

## No thresholds yet

None are defined anywhere in code or docs, deliberately. Sarah's measured
baseline comes first; gates for later avatars and platforms get justified from
it rather than invented ahead of it.

## If cadence reads as chatter

The fix is **not** to reintroduce a global minimum-duration floor. That is what
the legacy `0.100s` rule did, and it suppresses meaningful phonetic changes
along with the noise.

The correct fix is viseme-aware coalescing: merge adjacent intervals that are
visually equivalent, and extend the existing anti-pop attack, both of which
already exist as concepts in the engine (`noiseIntervalMs`, `microGapMergeMs`,
`speechAttackPlaybackMs`). Preserve that distinction — it is the difference
between removing noise and removing information.

## Outcomes

| Result | Next |
|---|---|
| Speech unchanged, V10 data correct | visible Sarah — open `V10_VISIBLE_MODE_AVAILABLE` |
| Speech unchanged, V10 timing poor | stay in shadow; fix only the demonstrated problem |
| Speech timing or lifecycle changed at all | **reject** — something crossed the speech boundary |
