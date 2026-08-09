# GP-004 — Dressing Room block enforcement for item contributions

Production remediation record. Deployment performed 2026-08-09 under owner
authorization, from branch `audit/android-build25-final-google-remediation`
@ `9d2a09e`.

```text
Finding:
GP-004

Severity:
P1

Original production location:
public.can_contribute_to_dressing_room(uuid)

Affected RLS area:
public.dressing_room_items
  "Active participants can insert room items"  (INSERT)
  "Contributors can update own room items"     (UPDATE)
  "Contributors can delete own room items"     (DELETE)

Migration:
supabase/migrations/20260809120000_contribution_block_enforcement.sql

Test:
supabase/tests/dressing_room_contribution_blocking_test.sql   (pgTAP, plan(8))
__tests__/dressingRoomContributionBlocking.test.js            (source contract guard)

Original defect:
Blocked/left participants could still satisfy the contribution predicate.

Fix:
Added active-participant and block-aware contribution enforcement.

Why:
Blocking must prevent direct Dressing Room contribution bypass, not merely
messaging/UI access.

Production project:
wyyuqfdxucjksghsmhry

Deployment result:
SUCCESS. Applied 2026-08-09 via the Supabase migration mechanism as a single
isolated migration. No other pending migration was applied; production was not
reset and migration history was not rewritten. Ledger rows 85 -> 86.

Production function verification:
PASS. Post-deployment the live definition carries all three guards
(drp.left_at is null / rs.owner_id = dr.user_id / not
internal.is_dressing_room_pair_blocked(...)). Signature, return type,
volatility, language, SECURITY DEFINER, search_path and owner are byte-identical
to the pre-deployment snapshot; grants unchanged (anon EXECUTE remains false).
All 9 dressing_room_items policies survive, 3 still reference the function, and
no table privilege changed for anon or authenticated.

pgTAP result:
8/8 PASS against a disposable Postgres 17 replica built from the
post-deployment production definitions. Negative control against the pre-fix
predicate fails 4 of 8. Full output below.

Residual risk:
None identified for this finding. The predicate is now strictly more
restrictive than before; the only behaviour change is the denial of blocked and
departed participants. Legitimate owner, active-participant and post-unblock
re-redemption paths are all proven unaffected. Production carried 0 block rows
and 0 departed participants at deployment time, so no live session changed
behaviour.

Final status:
FIXED AND VERIFIED IN PRODUCTION
```

## Migration ledger entry

```text
version  | name
---------+--------------------------------
20260809102805 | contribution_block_enforcement
```

The applied version stamp differs from the source filename prefix
(`20260809120000`) because the deployment tool assigns its own timestamp. This
is the established convention for this project — the three Build 25 migrations
applied 2026-08-08 landed as `20260808201806` / `20260808202108` /
`20260808202222` against differently-named source files. It is not drift.

## Pre-deployment production snapshot

Recorded before any change was made.

| Attribute | Value |
|---|---|
| identity | `can_contribute_to_dressing_room(uuid)` |
| returns | `boolean` |
| language | `sql` |
| volatility | `s` (STABLE) |
| security definer | `true` |
| config | `search_path=""` |
| owner | `postgres` |
| anon EXECUTE | `false` |
| authenticated EXECUTE | `true` |
| service_role EXECUTE | `true` |
| definition md5 | `c204a90ba37ac8a0491018d62711b2fc` |

Vulnerable body (participant branch), confirmed still live immediately before
deployment — no `left_at`, no owner binding, no block check:

```sql
or exists (
  select 1
    from public.dressing_room_participants drp
    join public.room_shares rs
      on rs.id = drp.joined_via_share_id
     and rs.room_id = p_room_id
   where drp.dressing_room_id = p_room_id
     and drp.user_id = (select auth.uid())
     and rs.is_active = true
     and rs.revoked_at is null
     and (rs.expires_at is null or rs.expires_at > now())
)
```

Pre-deployment preconditions, all confirmed:

- `internal.is_dressing_room_pair_blocked(user_a uuid, user_b uuid)` present.
- `authenticated` holds USAGE on schema `internal`; `anon` does not.
- `dressing_room_participants.left_at`, `room_shares.owner_id` and
  `dressing_rooms.user_id` all exist — no schema drift blocking the migration.
- Migration `20260809120000` absent from the ledger; ledger tail was
  `20260808202222`, so nothing later had independently corrected the issue.

## Post-deployment production snapshot

| Attribute | Before | After | Preserved |
|---|---|---|---|
| identity | `can_contribute_to_dressing_room(uuid)` | same | yes |
| returns | `boolean` | `boolean` | yes |
| language | `sql` | `sql` | yes |
| volatility | `s` | `s` | yes |
| security definer | `true` | `true` | yes |
| config | `search_path=""` | `search_path=""` | yes |
| owner | `postgres` | `postgres` | yes |
| anon EXECUTE | `false` | `false` | yes |
| authenticated EXECUTE | `true` | `true` | yes |
| service_role EXECUTE | `true` | `true` | yes |
| definition md5 | `c204a90b…` | `e588d065…` | changed, intended |
| function comment | none | set | added, intended |

RLS and privileges after deployment:

- `dressing_room_items` policy count 9 (unchanged); policies referencing the
  function 3 (unchanged); RLS still enabled.
- `dressing_room_messages` policy count 3 (unchanged).
- `anon` SELECT/INSERT on `dressing_room_items`: `false` / `false` (unchanged).
- `authenticated` INSERT/UPDATE/DELETE: `true` (unchanged).

Guard presence in the live definition: `drp.left_at is null` yes,
`not internal.is_dressing_room_pair_blocked(...)` yes,
`rs.owner_id = dr.user_id` yes.

## Regression contracts verified unchanged

All present, all `SECURITY DEFINER`, `anon` EXECUTE `false` on every one:

`public.block_dressing_room_user`, `public.unblock_dressing_room_user`,
`public.list_dressing_room_blocked_users`, `public.join_room_via_share_token`,
`public.can_access_room_messages`, `public.create_dressing_room_message`,
`public.resolve_dressing_room_collaboration_access`,
`public.list_dressing_room_messages`, `public.get_my_deletion_status`,
`public.is_active_account`, `public.reserve_privacy_request_rate_limit`,
`internal.is_dressing_room_pair_blocked`, `internal.lock_dressing_room_pair`,
`internal.dressing_room_pair_has_interacted`.

`internal.lock_dressing_room_pair` and
`public.reserve_privacy_request_rate_limit` correctly remain non-executable by
`authenticated`.

## Verification method

pgTAP is **not installed** in production (`pg_extension` count 0, available but
not created), and the suite creates `auth.users` fixtures. Running it against
production would have required both a schema change beyond the authorized
migration and test data in the live database, so it was not run there.

Instead a disposable `postgres:17` container was built with
`postgresql-17-pgtap`, and the schema was reconstructed from the **live
post-deployment production definitions** of `can_contribute_to_dressing_room`,
`join_room_via_share_token`, `block_dressing_room_user`,
`unblock_dressing_room_user`, `is_active_account`,
`internal.is_dressing_room_pair_blocked`, `internal.lock_dressing_room_pair`
and `internal.dressing_room_pair_has_interacted`, together with the exact
production column shapes and the full nine-policy RLS set on
`dressing_room_items`. The container was destroyed after the run.

The test harness caught one defect in the test itself:
`dressing_room_items.snapshot_payload` is `NOT NULL` with no default, so the
original `throws_ok` insert would have raised `23502` rather than `42501` and
proved nothing. Corrected before the run.

## pgTAP output — deployed fix

```text
 1..8
 ok 1 - the owner may contribute to their own room
 ok 2 - an active unblocked participant on a live share may contribute
 ok 3 - an account that never joined may not contribute
 ok 4 - a participant whose membership has ended may not contribute, block or no block
 ok 5 - GP-004: a blocked participant may not contribute despite the share staying live
 ok 6 - GP-004: the contributor INSERT policy rejects a blocked participant
 ok 7 - unblocking alone does not restore contribution; a fresh redemption is required
 ok 8 - a fresh share redemption after unblock restores contribution
 finish
 (exit code 0)
```

Assertion 6 executes under `set local role authenticated`, so it exercises the
RLS policy itself rather than the helper — that is the direct-PostgREST bypass
path, denied with `42501`.

## pgTAP output — negative control (pre-fix predicate)

```text
 ok 1 - the owner may contribute to their own room
 ok 2 - an active unblocked participant on a live share may contribute
 ok 3 - an account that never joined may not contribute
 not ok 4 - a participant whose membership has ended may not contribute, block or no block
 not ok 5 - GP-004: a blocked participant may not contribute despite the share staying live
 not ok 6 - GP-004: the contributor INSERT policy rejects a blocked participant
 not ok 7 - unblocking alone does not restore contribution; a fresh redemption is required
 ok 8 - a fresh share redemption after unblock restores contribution
 # Looks like you failed 4 tests of 8
```

`not ok 6` is the bypass reproduced end to end: with the pre-fix predicate the
blocked participant's direct `INSERT` into `dressing_room_items` **succeeded**.
Assertions 1, 2, 3 and 8 pass in both runs, which is what makes the four
failures meaningful — the suite discriminates the defect rather than failing
wholesale.

## Source / production consistency

The deployed function body is identical to the body in
`supabase/migrations/20260809120000_contribution_block_enforcement.sql`. There
is no undocumented production-only variant. The migration header now records
the deployment and the ledger version it landed as, and
`__tests__/dressingRoomContributionBlocking.test.js` asserts that record so the
file cannot silently drift back to claiming it is undeployed.
