# Batch 4 — Avatar Engine Posture (NOT INTEGRATED)

Scope note: Batch 4 integrated the **approved static avatar image set only**.
The avatar engine remains unfinished and was deliberately **not** integrated,
completed, shimmed, or newly activated. This document records its current shape
so a later interactive-Elise branch can start from facts rather than discovery.

Nothing in this document describes work performed in Batch 4.

---

## 1. What Batch 4 changed, and what it deliberately did not

**Changed (static image set):**

- `assets/stylist-avatars/portraits/stylist_portrait_0{1,2,3,4}.jpg` — refreshed
  to owner-approved subjects, stable IDs retained, all 1024×1024 sRGB.
- `assets/stylist-avatars/portraits/animated/avatar_stylist_02_mouth_*.png` —
  refreshed **only** to keep the already-live portrait-02 overlay from
  compositing the superseded subject's mouth onto the new face.
- `constants/stylistIdentity.ts` — accessibility labels for 01/02 corrected to
  the new subjects; portrait-02 `mouthRegion` recalibrated (y 0.49 → 0.48).

**Deliberately excluded:**

- Mouth-state assets and `SPEECH_CONFIG_ENTRIES` for portraits **01, 03, 04**
  (~23.3 MB, three *new* animation configs) available in donor `21637dd`.
  Accepting them would have expanded the unfinished animation surface.
- Any change to `AnimatedStylistAvatar`, `avatarSpeechMotion`, or the speech
  store beyond what the image refresh required. Those files are **byte-identical
  to the Batch 3 checkpoint**.

Net effect: the engine is exactly as (un)ready as it was at `1ae2f10`. Batch 4
enabled no animation capability that was not already live.

---

## 2. Current engine files

| File | Role | State |
|---|---|---|
| `components/stylist/AnimatedStylistAvatar.tsx` | Mouth-state overlay renderer + idle/thinking pulse | Unfinished |
| `services/avatarSpeechMotion.ts` | Derives `AvatarMouthState` from alignment | Unfinished |
| `stores/avatarSpeechStore.ts` | Generation-scoped speech/playback state | Production-grade |
| `services/avatarSpeech.ts` | Request → file → playback orchestration | Production-grade |
| `constants/stylistIdentity.ts` (`SPEECH_CONFIG_ENTRIES`) | Per-portrait mouth region + frame sources | Partial: 3 of 10 portraits |
| `assets/stylist-avatars/portraits/animated/` | Mouth frames | Partial: 02, 05, 08 only |

`stores/avatarSpeechStore.ts` and `services/avatarSpeech.ts` are listed as
production-grade deliberately — they are *speech* infrastructure, not avatar
animation, and they are already relied upon by shipping text-first behavior.

## 3. Engine entry points (live surfaces)

- `components/style-chat/StyleChatHeader.tsx:101`
- `components/home/HomeStylistCard.tsx:75`

Both mount `AnimatedStylistAvatar`. It renders the **static** `StylistAvatar`
unless `state === 'speaking'` **and** the preset has a complete, statically
bundled mouth-state set. Every other path degrades to the static portrait.

The static picker `components/stylist/PersonalizeStylistModal.tsx:241,267`
renders `StylistAvatar` directly and never touches the engine.

## 4. Interfaces consumed by the welcome / onboarding UI

**None.**

`components/account-home/WelcomeStepV1.tsx` and `AccountSetupStepV1.tsx` render
`assets/images/welcome-hero.png`. No onboarding route imports `StylistAvatar`,
`AnimatedStylistAvatar`, or `useStylistIdentity`. The onboarding tree therefore
cannot depend on the engine, on animation completion, or on speech — this holds
structurally, not merely by current configuration.

A future branch that introduces an avatar into onboarding must re-verify the
Batch 4 guarantee that no route blocks on animation or audio.

## 5. Asset identifiers the future engine will need

Canonical IDs are stable and must not be renumbered — persisted user selections
in `user_stylist_preferences.avatar_id` reference them directly:

- Portraits: `stylist_portrait_01` … `stylist_portrait_10`
- Abstract: `elise_default`, `editorial_plum`, `chrome_muse`, `deep_space`,
  `cream_gold`, `obsidian_orchid` (all `voiceProfile: 'silent'`)

Mouth-state coverage today: **02, 05, 08**. Missing: **01, 03, 04, 06, 07, 09,
10**. Frames for 01/03/04 already exist in donor `21637dd` and can be recovered
from there rather than regenerated.

Every portrait needs four states to be complete; `round` is currently absent for
all of them and falls back open → halfOpen → closed.

## 6. Known incomplete or unsafe wiring

1. **Mouth frames are full 1024×1024 face renders, not mouth crops.**
   `MouthStateLayer` loads the whole frame and offsets it behind a clipping
   window. Each state costs 2.2–2.7 MB. Ten fully-animated portraits would add
   roughly 75–80 MB to the bundle. This does not scale and should be replaced
   with cropped sprites or a texture atlas before coverage expands.

2. **`mouthRegion` is hand-calibrated per subject.** Any portrait refresh
   silently invalidates its region and its frames. Batch 4 hit exactly this with
   portrait 02. There is no automated check that a region still matches its
   image — a regeneration pipeline or a visual regression gate is needed.

3. **No error classification reaches the engine.** `stylistSpeechClient.ts:114`
   collapses quota-exhausted, rate-limited, auth-failure, and network-failure
   into one generic `'Speech is temporarily unavailable.'`. Safe today only
   because **nothing retries**; any future retry logic must add classification
   *first*, or quota exhaustion will be retried as a transient network error.

4. **No `AppState` handling in the speech/animation path.** Backgrounding
   mid-playback is not explicitly stopped. Harmless now (no new requests are
   issued while backgrounded), but real interactive behavior will need it.

5. **`round` mouth state is declared in the type but never supplied.**

## 7. Files likely to seed the interactive-Elise branch

```
components/stylist/AnimatedStylistAvatar.tsx
services/avatarSpeechMotion.ts
services/avatarSpeech.ts
services/avatars/stylistSpeechClient.ts
services/avatars/stylistAudioPlayback.ts
services/avatars/stylistSpeechFiles.ts
stores/avatarSpeechStore.ts
constants/stylistIdentity.ts        (SPEECH_CONFIG_ENTRIES only)
assets/stylist-avatars/portraits/animated/
supabase/functions/stylist-speech/  (server-side; holds the ElevenLabs key)
__tests__/avatarSpeechMotion.test.js
__tests__/stylistSpeechRecovery.test.js
__tests__/stylistSpeechClientLifecycle.test.js
```

Recoverable from donor `21637dd` when animation work resumes:
`avatar_stylist_0{1,3,4}_mouth_{closed,half_open,open}.png` plus their
`SPEECH_CONFIG_ENTRIES` blocks.

That branch should start only after the Batch 4 avatar/onboarding checkpoint is
committed, and must not be created during Batch 4.
