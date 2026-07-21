# E-4 Authorization and Retrieval — Verified Contract

## Actor identity

`runEliseAdvicePipeline` is always invoked with `actorId: userId`
(`index.ts`), where `userId` is derived from the authenticated session, never
from client-supplied request fields. `eliseWardrobeRetrieval.ts`'s
`listSharedRoomItems` data-source implementation additionally ignores its own
`_actorId` parameter (underscore-prefixed, intentionally unused) in favor of
the same closure-captured `userId` — redundant-but-safe, not a bug.

## Owned Saved Scans

`listSavedScans`: `supabase.from('saved_scans').select(...).eq('user_id',
actorId).is('deleted_at', null)`. Server-scoped by the authenticated actor;
soft-deleted rows excluded. `retrieveAuthorizedWardrobeCandidates` additionally
re-verifies `ownerMatches(row, actorId)` and a valid UUID before accepting
any row — a foreign or malformed row is rejected even if a data-source
implementation regressed. Verified by a passing hostile test
("client-claimed other-user Closet item is rejected").

## Inspiration Items

`listInspirationItems`: `.eq('user_id', actorId)`, same actor-scoping
pattern. Also re-verified at the retrieval layer.

## Owned Dressing Room items

`listOwnedRoomItems`: first resolves `dressing_rooms` filtered to
`user_id = actorId`, then selects `dressing_room_items` filtered to
`room_id IN (owned room ids)` — matches the pattern this audit's DR-1 pass
independently verified for `stylechat-generate`'s Elise evidence resolver.
Rows are marked `__room_owned_by_actor: true` by the data source; the
retrieval layer accepts a row only if one of `__authorized`, `ownerMatches`,
`__room_owner`, or `__room_owned_by_actor` is true — belt-and-suspenders
against multiple possible data-source field-naming conventions, all of which
trace back to the same server-side room-ownership join.

## Shared Dressing Room items — the critical focus, attacked case by case

`listSharedRoomItems` queries `shared_room_memberships` filtered to
`recipient_user_id = userId` (session-derived) and `removed_at IS NULL`,
inner-joined to `room_shares` for `is_active`/`revoked_at`/`expires_at`
(post-repair: also `owner_id`), then derives `roomIds` **only** from rows
that pass every live check, and finally queries `dressing_room_items` scoped
to `room_id IN (roomIds)`. Attack-case results:

| # | Attack | Result |
| - | ------ | ------ |
| 1 | Membership exists but share revoked | Excluded — `revoked_at` checked live, not from membership-creation-time state |
| 2 | Membership exists but share deleted | Excluded — `room_shares!inner` performs a real inner join; a membership whose share no longer exists is dropped from the result set entirely |
| 3 | Membership exists but room deleted | `dressing_room_items` FK-cascades from `dressing_rooms`; a deleted room's items cannot exist to be returned |
| 4 | Membership exists but item belongs to a different room | Structurally impossible — items are scoped by `room_id IN (verified roomIds)`, derived server-side, never by client-supplied item id alone |
| 5 | Share active but recipient never "opened" it | Not a real distinct state in this schema — `shared_room_memberships` rows are only ever created by `save_shared_room_for_me()`, which itself validates the share is live at creation time; existence *is* the save/open action |
| 6 | Membership removed by recipient | Excluded — `removed_at IS NULL` filter |
| 7 | Expired share | Excluded — `expires_at` checked live against `now()` |
| 8 | Malformed token | N/A to this path — tokens are only used at share-creation/redemption RPCs, not at retrieval time; retrieval works off already-validated membership rows |
| 9 | Actor supplies another user's room/item id | Structurally impossible — `retrieveAuthorizedWardrobeCandidates`/`listSharedRoomItems` never accept a client-supplied room or item id; every id is derived from the server-verified membership→share chain |
| 10 | Public-preview access without authenticated shared evidence access | Different code path entirely (`get_public_room_preview`, unauthenticated, DR-1-audited separately); E-4 never calls it |
| 11 | Stale access after owner revocation | Covered by #1 (`revoked_at`) |
| 12 | Account switch mid-retrieval | `userId` is captured once per request from the authenticated session at function-closure creation; no cross-request state to go stale within a single request |
| 13 | Participant access vs. membership access | E-4 does not consult `dressing_room_participants` at all for evidence — only `shared_room_memberships` + `room_shares`, the correct table per the established "membership ≠ collaboration participant" separation |
| 14 | Owner access vs. recipient access | Owner's own items are retrieved via `listOwnedRoomItems` (different, room-ownership-scoped path); `listSharedRoomItems` only ever returns items from rooms the actor does **not** own but has a live share for |
| 15 | Message access vs. styling-evidence access | E-4 never queries `dressing_room_messages`; unrelated to this path |

**One gap found and repaired (F-2):** the live query did not originally
re-verify that the share's recorded `owner_id` still matches the room's
current `dressing_rooms.user_id` — the same staleness check the codebase's
own `list_shared_rooms_for_me()` RPC already applies. Repaired by extending
the query and adding a room-ownership cross-check before deriving `roomIds`.
Classified P2 (not P1/P0) because the only ownership-transfer mechanism in
this codebase (account-deletion room transfer) cascades away the stale
share row via `room_shares.owner_id references auth.users(id) on delete
cascade` at the same time the original owner's auth account is deleted,
narrowing live exploitability to a transient window inside a single admin
script's own execution — not an externally-reachable request path.

## Retrieval bounds

`ELISE_ADVICE_LIMITS` (`eliseAdviceTypes.ts`): 40 initial candidates per
source, 24 ranked candidates after merge, 10 in the final grounded shortlist,
3 max looks. `retrieveAuthorizedWardrobeCandidates` enforces the 40-per-source
cap in each data-source call and the 24-candidate cap via
`.slice(0, ELISE_ADVICE_LIMITS.rankedCandidates)` after sort; the shared-room
source is additionally capped to `Math.min(limit, 20)`. `rankAndBoundCandidates`
(`eliseCompatibilityScoring.ts`) defaults to the 10-item grounded shortlist.
Each of the four source queries runs concurrently (`Promise.all`), so one
slow/hanging source does not serialize against the others; a per-source
`try/catch` sets `partialFailure = true` and continues rather than aborting
the whole retrieval — verified structurally and exercised by the existing
"E-4 pipeline bounds large Closet and keeps owned-first" test.

## No mutation capability

Grepped every E-4 pure-logic file (`eliseAdvice*.ts`, `eliseWardrobe*.ts`,
`eliseCompatibilityScoring.ts`, `eliseFashionFeatures.ts`,
`eliseFocusResolution.ts`) for `.insert(`/`.update(`/`.delete(`/`.upsert(`:
zero matches. E-4 is read-only against the database; it cannot execute a
checkout, cart mutation, or automatic save, satisfying the "transactional in
recommendation intent, but never able to execute checkout" constraint by
construction, not just by convention.

## Retailer neutrality / no commission signal

`eliseCompatibilityScoring.ts` contains no reference to `commission`, retailer
identity, or affiliate economics in its scoring dimensions — locked in by an
existing passing test (`assert.doesNotMatch(scoring, /commission/)`).
Priority ordering in `eliseWardrobeRetrieval.ts` is owned → saved → scanned →
shared → discovered(commerce), matching the required priority order exactly,
and is computed from `actorRelationship` alone, never from which retailer a
commerce candidate came from.
