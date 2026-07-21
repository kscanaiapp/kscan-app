# Test and validation evidence

All commands run from `C:\src\KScan-dr-tree-hostile-audit-20260721` on branch `audit/dressingrooms-dr1-dr4-hostile-final`.

Test-side dependency: `npm install typescript@5.9.2 --no-save --no-audit --no-fund` was executed once to enable the Node-native `--test` runner (the test files use on-the-fly `ts.transpileModule` via `require('typescript')`). This install is a local-only, no-save side effect and does not modify `package.json` or `package-lock.json`.

## `git diff --check`

Exit 0 (clean).

## Project TypeScript

```
npx tsc --noEmit
```

Exit 0. No diagnostics.

## Deno check (stylechat-generate)

```
deno check supabase/functions/stylechat-generate/index.ts
```

`Check supabase/functions/stylechat-generate/index.ts`. Exit 0.

## Focused DR-1..DR-4 suites

```
node --test __tests__/dr3Collaboration.test.js __tests__/dr4Hardening.test.js \
  __tests__/dr2Integration.test.js __tests__/dr2PlatformParity.test.js \
  __tests__/dressingRoomCanonicalItemContract.test.js __tests__/dressingRoomItemContract.test.js \
  __tests__/dressingRoomSavePolicy.test.js
```

- tests: 68
- suites: 0
- pass: 68
- fail: 0

## Complete node test suite (pre-repair)

```
node --test __tests__/*.test.js
```

- tests: 1703
- pass: 1694
- fail: 9

Failures traced to two root causes:

1. `styleChatTextRequest.test.js` (8 failures) — `customRequire` allowlist did not include `../../../constants/featureFlags`, which DR-2 commit `e931547 feat(elise): wire stable room attachments for the next mobile build` added to `services/style-chat/providers/edgeStyleChatProvider.ts`.
2. `processDeletionRequest.test.js` (1 failure) — `USER_DATA_RESOURCES` in `scripts/process-deletion-request.js` did not register `elise_generation_operations` (pre-DR Elise foundation table; auth cascade functions, but coverage-reporting test surfaced the gap).

Both repaired in this audit; see [`11_DEFECT_AND_REPAIR_LEDGER.md`](11_DEFECT_AND_REPAIR_LEDGER.md).

## Complete node test suite (post-repair)

```
node --test __tests__/*.test.js
```

- tests: 1703
- suites: 2
- pass: 1703
- fail: 0
- cancelled: 0
- skipped: 0
- todo: 0
- duration_ms: ~13,448

## Controlled migration replay (executed)

Classification: **MIGRATION REPLAY VERIFIED**.

Disposable Postgres database created inside a sibling audit's local Supabase Docker Postgres 17.6.1 stack (`supabase_db_KScan-phase4-audit-backend`, port 55322). Steps:

1. `CREATE DATABASE dr_audit_replay` from the sibling's pre-DR-3 schema+data (via `pg_dump -n public -n auth --no-owner --no-acl | psql`). Result: 46 public tables, pre-DR-3 helper `can_access_room_messages` present, DR-3/DR-4 objects absent.
2. Apply `20260721170559_dr3_collaborative_interactions.sql` under `-v ON_ERROR_STOP=1`. Result: exit 0. Verified `dressing_room_collab_idempotency` table present, `collaboration_access_version` column present, `client_message_id` + `parent_message_id` columns present, all four new RPCs present, flat-thread trigger function present, DR-3 unique constraint present.
3. Apply `20260721183308_dr4_collab_idempotency_room_scope.sql` under `-v ON_ERROR_STOP=1`. Result: exit 0. Verified DR-3 unique dropped, DR-4 room-scoped unique present, `room_id` set to NOT NULL.
4. Run 22 hostile scenarios (seeded with `auth.users` for owner/active/revoked/unrelated actors, room+item+share+participant rows for each access relationship, cross-room fixtures for the DR-4 requestId test).
5. `DROP DATABASE dr_audit_replay` after run. Sibling audit DB untouched.

Hostile scenario results (all as expected):

| # | Scenario | Actor | Expected | Actual |
| --- | --- | --- | --- | --- |
| S1 | Resolve access | owner | `ok`, `relationship=owner` | `ok`, `relationship=owner`, `accessVersion=1` |
| S2 | Resolve access | active recipient | `ok`, `relationship=shared_recipient` | `ok`, `relationship=shared_recipient`, `accessVersion=1` |
| S3 | Resolve access | participant w/ revoked share | `!ok`, `unauthorized` | `!ok`, `unauthorized`, `accessVersion=1` |
| S4 | Resolve access | unrelated authenticated | `!ok`, `unauthorized` | `!ok`, `unauthorized` |
| S5 | Send message | owner | success | success, stable UUID id returned |
| S6 | Same requestId, same payload | owner | cached result | **same UUID id as S5** returned (no duplicate insert) |
| S7 | Same requestId, DIFFERENT body | owner | reject `22023` | reject `22023 Idempotency key reused with different payload` |
| **S8** | **Same requestId, different room** | owner | **success (DR-4 fix)** | **success, NEW UUID id returned** — DR-4 room-scoped ledger verified |
| S9 | Reply-to-reply | owner | reject `22023` | reject `22023 Replies to replies are not allowed` |
| S10 | Cross-room parent | owner | reject `22023` | reject `22023 Parent message must belong to the same room` |
| S11 | Empty body (whitespace) | owner | reject `22023` | reject `22023 Message cannot be empty` |
| S12 | Body > 1000 chars | owner | reject `22023` | reject `22023 Message too long` |
| S13 | Non-v4 request id | owner | reject `22023` | reject `22023 Invalid client message id` |
| S14 | Send message | revoked recipient | reject `42501` | reject `42501 Shared room is unavailable` |
| S15 | Set reaction | active recipient | success | success, `myReaction=love`, `active=true` |
| S16 | Same requestId, different reaction state | active recipient | reject `22023` | reject `22023 Idempotency key reused with different payload` |
| S17 | React to item in different room | active recipient | reject `42501` | reject `42501 Item not found in room` |
| S18 | Owner revokes | owner | success, access_version bumped | success (`t`), version bumped from 1 to 2 |
| S19 | Access after revoke | formerly-active recipient | `!ok`, `unauthorized`, `accessVersion=2` | exactly that |
| S20 | Message history after revoke | owner | count > 0 | count = 1 (owner's S5 message preserved) |
| S21 | Keyset pagination | owner | ordered ASC, cursor structure | root+hello+reply returned in ascending order, `newestCursor` present, `nextCursor=null` at end of history |
| S22 | Anonymous invocation | anon (no jwt.sub) | reject `28000` | reject `28000 Authentication required` |

Fixture SQL: `scratchpad/dr_replay_hostile.sql`. Full output archived at `scratchpad/replay_output.txt`.

## Android / iOS static checks

Native builds are explicitly out of scope for this audit per Section 4 (Not authorized: APK/AAB/IPA/TestFlight/App Store builds). Static checks that do not require a build were not executed; DR-3/DR-4 add no native platform code.
