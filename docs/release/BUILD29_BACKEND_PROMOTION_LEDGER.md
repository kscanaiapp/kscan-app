# Build 29 — Backend Promotion Ledger

Repair branch: `repair/build29-shared-system-fixes` (base `48731a2c`).

**No production or staging mutation was performed to produce this ledger.** Every
row is evidence gathered by reading deployed function source and live database
catalog, plus one migration validated inside a transaction that was rolled back.
Promotion itself remains a separately governed action.

Projects:

| role | project ref |
| --- | --- |
| production | `wyyuqfdxucjksghsmhry` |
| app staging | `yzqjvdfgefveprobvvyw` |

All live readings taken **2026-08-15**.

---

## 1. `stylist-speech` — PROMOTION REQUIRED

| field | value |
| --- | --- |
| **source** | cue mode present (`handler.ts` `CUE_REQUEST_KEYS`, `speechCues.ts`, six approved cues) |
| **staging** | **v31** — matches source; cue mode fully present |
| **production** | **v29** — message mode only; no `speechCues.ts` in the deployment at all |
| **user-facing dependency** | Elise's deterministic voice moments. Build 29 ships them; they cannot work in production until this is promoted. |
| **promotion required?** | **YES** |

### Exact contract difference

Production v29 parses with:

```ts
const REQUEST_KEYS = new Set(['sessionId', 'messageId', 'stylistId']);
if (Object.keys(record).some((key) => !REQUEST_KEYS.has(key))) throw INVALID_REQUEST;
```

The mobile client sends cue requests as `{ cue, stylistId }`. `cue` is not in
that set, and the parser rejects *any* unknown key, so **every cue request is
rejected with HTTP 400 `INVALID_REQUEST`** ("The speech request contains
unsupported fields"). Production also has no cue allowlist module, no `mode`
discriminator on `StylistSpeechRequest`, and no `cue` field on the response.

Staging v31 parses the two modes as whole shapes, resolves cue text from a
server-side allowlist, and returns `{ cue, messageId: null, ... }`.

Message mode is byte-compatible between the two, which is why Elise's spoken
*replies* work in production today while her *cues* do not.

### Moments covered

All five Build 29 moments are present in staging and absent in production:

`image_understood` · `closet_saved` · `style_item` · `change_something` ·
`dressing_room_ready`

(Staging additionally carries `entry`, making six.)

### Validation evidence

`__tests__/stylistSpeechCuePromotionContract.test.js` runs the **real staging
handler source** against the **real mobile cue request body** (lifted from
`services/avatars/stylistSpeechClient.ts` by AST) for all five moments, and
asserts each is accepted, echoes its cue, and resolves its words from the server
allowlist rather than the request. It also asserts an unapproved cue key is
refused rather than spoken as something else, and that a hybrid cue+message body
is rejected.

### Secrets / dependencies

`ELEVENLABS_API_KEY`, `ELEVENLABS_FEMININE_VOICE_ID`,
`ELEVENLABS_MASCULINE_VOICE_ID`, `ELEVENLABS_MODEL_ID`,
`ELEVENLABS_OUTPUT_FORMAT` — already required by production v29's message mode,
so promotion introduces **no new secret**.

> Note: `readRequiredSecret` enforces `apiKey: /^[A-Za-z0-9_\-]{8,200}$/`. A
> previously observed outage came from `ELEVENLABS_API_KEY` holding a 64-hex key
> *identifier* rather than the `sk_` secret; that shape passes the regex and
> fails at the provider. Verify the credential's shape from inside the runtime
> as part of promotion.

---

## 2. `stylechat-generate` — PROMOTION REQUIRED (S7 / Closet intelligence)

| field | value |
| --- | --- |
| **source** | `closetIntelligenceContext` present — 13 references |
| **staging** | **v91** — 13 references, `parseClosetIntelligenceContext` 3, `ClosetInventoryState` 9 (matches source) |
| **production** | **v90** — `closetIntelligenceContext` references: **0** |
| **user-facing dependency** | Closet V2 / S7: Elise reasoning over the user's actual wardrobe. |
| **promotion required?** | **YES** |

### Exact contract difference

The client sends `closetIntelligenceContext` on every request. Production v90
contains no reference to that key whatsoever, so it is **silently dropped** —
the request succeeds and Elise answers without the wardrobe context the feature
exists to provide. There is no error and no degraded-mode signal; this is why it
was invisible.

**No client change is required or made.** The client contract is not defective —
it sends the field the certified server generation consumes. Building a second
transport would be inventing architecture around a deployment gap.

### Also confirmed on production v90 (no action)

`fashionContextV2` — **16 references**, matching source. E4.1 room source types
`owned_room_item` (17) and `shared_room_item` (29) are present. This corroborates
the audit's finding that the **E4.1 server was already capable** and the gap was
client-side; that client gap is closed on this branch (KSB29-028).

### Validation evidence

Reference counts read directly from the deployed function bodies of both
projects. E4.1's client→server path is proven end-to-end by
`__tests__/e41RealClientContract.test.js`, which drives the production request
builder into the production server normalizer.

`__tests__/s7ClosetIntelligencePromotion.test.js` pins the client→server pair
so the two cannot drift while this promotion is pending: the client places the
field on the outbound body, the certified server parses it and routes it to the
advice/gap/retrieval surfaces, both sides use the same key, and no alternative
transport has been introduced.

### Secrets / dependencies

None new.

---

## 3. `scan-identify` — NO PROMOTION REQUIRED (for Elise V2 activation)

| field | value |
| --- | --- |
| **source** | `identify_for_style`, `detect_items`, `identify_selected_item`, `closet_mirror` |
| **staging** | **v32** |
| **production** | **v147** — `identify_for_style` present (6 refs), `closet_mirror` present |
| **user-facing dependency** | Elise direct camera/gallery identification (KSB29-012); Mirror Selfie. |
| **promotion required?** | **NO** for KSB29-012. Mirror Selfie is assessed separately below. |

### Contract difference

Production already serves `identify_for_style`, which is what
`EXPO_PUBLIC_ELISE_IDENTIFICATION_V2_ENABLED` depends on. The flag's own comment
claimed otherwise; that claim was stale and is corrected in
`constants/featureFlags.ts` on this branch.

### Validation evidence

Deployed production function body read directly. The flag is now `"true"` in all
four EAS profiles, guarded by
`__tests__/eliseIdentificationV2Migration.test.js`.

### Mirror Selfie — bounded probe PARTIALLY RUN, no promotion claimed

| field | value |
| --- | --- |
| **source** | `closet_mirror` entry path present |
| **staging** | **v32** — `closet_mirror` in the entry-path vocabulary |
| **production** | **v147** — `closet_mirror` present |
| **user-facing dependency** | Mirror Selfie Closet intake. |
| **promotion required?** | **NONE APPARENT** — but see the limit below |

**Run and passing** (`__tests__/mirrorSelfieStagingProbe.test.js`), using the
REAL `closet_mirror` mobile contract rather than substitute semantics:

1. exact staging generation identified — scan-identify **v32**
2. the real payload from the production builder `buildClosetV2Request`
3. that payload is **accepted by the deployed request validator**, executed
4. ordinary Closet camera/gallery requests still validate, and Scanner entry
   paths stay distinct — a Closet request can never masquerade as Scanner

**NOT run: the live model round-trip.** An actual fashion-identification
RESPONSE from staging is not exercised. The governed probe for that is
`scripts/smoke-scan-identify.js`, which requires **`STAGING_USER_JWT`** — a real
staging user token that is not available in this environment. The script
explicitly refuses service-role keys and fabricated JWTs, and manufacturing one
to make the probe look complete would defeat the control it exists behind.

**Consequence.** The request contract is certified; the response is not. Both
environments already accept `closet_mirror`, so no promotion *appears* to be
required — but "appears" is not certification, and this is recorded as
outstanding rather than passed. Completing it needs only the credential.

**Mirror Selfie is NOT disabled** and stays `true` in all four EAS profiles.
The correct response to an unrun probe is to run it when the credential exists,
not to remove a feature that has already had implementation and testing
investment.

---

## 4. `content_reports` AI-output migration — STAGING PROMOTION REQUIRED

| field | value |
| --- | --- |
| **source** | `supabase/migrations/20260815120000_content_reports_ai_output.sql` (added on this branch) |
| **staging** | **absent** — no `ai_output_context` column, `ai_output` not in the target-type CHECK |
| **production** | **already present** — column and both constraints live |
| **user-facing dependency** | AI-output reporting (Google Play submission requirement). |
| **promotion required?** | **STAGING YES / PRODUCTION NO** |

### Exact contract difference

This drift runs the unusual direction: production is *ahead*. Production carries
`ai_output_context jsonb`, `'ai_output'` in
`content_reports_target_type_check`, and the full
`content_reports_ai_output_context_check`. No migration in the repository ever
declared any of it, so a database built from history — which is what staging is
— rejects every AI-output report at the CHECK.

### Validation evidence

The migration was applied to App Staging **inside a transaction and rolled
back**. The resulting `pg_get_constraintdef` output was **byte-identical** to
production's, and a follow-up query confirmed staging was left unchanged.
Classified `EXPANSION_SAFE` in
`security/release/migration-risk-classifications.json`.

### Known gap, deliberately reproduced

Because the guard is a CHECK, a row with `target_type = 'ai_output'` and
`ai_output_context IS NULL` evaluates to NULL rather than FALSE and is admitted.
The client refuses that shape before sending, so it is unreachable from the app.
Tightening it would diverge from production, which reproducing production
exactly is this migration's purpose — it belongs to its own governed change.

### Secrets / dependencies

None.

---

## 5. Dressing Room authorization — PROMOTION REQUIRED (staging + production)

| field | value |
| --- | --- |
| **source** | `supabase/migrations/20260815140000_dressing_room_items_blocking.sql` (added on this branch) |
| **staging** | block check **absent** on `dressing_room_items` and on all three share helpers |
| **production** | block check **absent** — identical to staging |
| **user-facing dependency** | User blocking in shared Dressing Rooms. A real authorization boundary, not moderation. |
| **promotion required?** | **YES — both environments** |

### Exact contract difference

`dressing_rooms` already refuses a blocked recipient (its recipient SELECT
policy carries `not internal.is_dressing_room_pair_blocked(...)`). Nothing else
does:

| object | checks block, before |
| --- | --- |
| `dressing_rooms` recipient SELECT policy | **yes** |
| `dressing_room_items` recipient SELECT policy | **no** |
| `list_shared_rooms_for_me` (SECURITY DEFINER) | **no** |
| `save_shared_room_for_me` (SECURITY DEFINER) | **no** |
| `touch_shared_room_for_me` (SECURITY DEFINER) | **no** |

So a blocked recipient was denied the room shell and could still read every
item in it directly, still see it listed as `available` with title and item
count, still save it, and still refresh its access time. The three helpers are
SECURITY DEFINER, so RLS never runs for them and the check has to be explicit.

The migration reuses `internal.is_dressing_room_pair_blocked` unchanged and
transcribes the item predicate from the working `dressing_rooms` policy, so the
two cannot disagree about what "blocked" means. Blocked access resolves to the
same `unavailable` status as a revoked or expired share, so it is not an oracle.

### Validation evidence

Applied to App Staging inside transactions that were **rolled back**: the
resulting policy carried the block check while preserving every existing share
condition (membership, not-removed, active, not-revoked, not-expired), both
rewritten RPCs kept SECURITY DEFINER and their pinned `search_path` and gained
the check, and a follow-up query confirmed staging was left unchanged.
Classified `REVERSIBLE` in
`security/release/migration-risk-classifications.json` — tightening only, no
table, column, or row touched. Guarded by
`__tests__/dressingRoomItemBlockingMigration.test.js`.

### Secrets / dependencies

None. Requires the `internal.is_dressing_room_pair_blocked` helper, which both
environments already have.

### KSB29-033 — NOT A DEFECT, no action

The audit reported no effective GRANT on `dressing_room_item_reactions`. Read
live on both projects: `authenticated` already holds SELECT, INSERT, UPDATE and
DELETE with RLS enabled, so its policies are reachable. Nothing is granted —
broadening a permission that is already correct would weaken the boundary
rather than repair it.

---

## Summary

| item | promotion |
| --- | --- |
| `stylist-speech` v29 → v31 | **REQUIRED** (production) |
| `stylechat-generate` v90 → v91 | **REQUIRED** (production, S7) |
| `scan-identify` | not required for KSB29-012; Mirror probe outstanding |
| AI-output migration | **REQUIRED** (staging only; production already has it) |
| Dressing Room authorization | **REQUIRED** (staging + production) |
