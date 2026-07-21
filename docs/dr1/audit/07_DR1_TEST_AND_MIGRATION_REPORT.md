# 07 — DR-1 Test and Migration Report (Audit Rerun)

## Test-execution blocker and resolution

`node --test` on the DR-1 focused suite initially failed:
`Error: Cannot find module 'typescript'` (the DR-1 test harness transpiles
`.ts` sources in-process via `ts.transpileModule` and needs the `typescript`
package). The mounted `node_modules` in this audit sandbox is unpopulated,
and `npm install` failed in place with
`EPERM: operation not permitted, unlink node_modules` (a FUSE-mount
limitation of this sandbox, not a repository issue). Resolved by installing
`typescript@~5.9.2` — confirmed by grep to be the only external module any
DR-1 test file `require()`s — into a scratch directory and running tests with
`NODE_PATH` pointed at it. This does not require or imply any change to the
repository; a normal development machine with a working `npm install` does
not need this step.

## Commands run

```
NODE_PATH=<scratch>/node_modules node --test \
  __tests__/dressingRoomCanonicalItemContract.test.js \
  __tests__/dressingRoomItemContract.test.js \
  __tests__/eliseRoomItemEvidence.test.js \
  __tests__/dressingRoomSavePolicy.test.js
```

## Baseline result (before repair, at HEAD `5dc0b86`)

| Metric | Value |
| ------ | ----- |
| Tests | 31 |
| Pass | 31 |
| Fail | 0 |

Matches the original DR-1 handoff's claimed 31/31 exactly — independently
reproduced, not merely trusted.

## Repair commit and regression additions

After implementing the F-1 repair (see `02_DR1_FINDINGS_AND_SEVERITY.md`),
2 new tests were added to `__tests__/dressingRoomSavePolicy.test.js` plus 1
more (3 total) and 1 new test to `__tests__/scanResultActivation.test.js`.

```
NODE_PATH=<scratch>/node_modules node --test \
  __tests__/dressingRoomCanonicalItemContract.test.js \
  __tests__/dressingRoomItemContract.test.js \
  __tests__/eliseRoomItemEvidence.test.js \
  __tests__/dressingRoomSavePolicy.test.js \
  __tests__/scanResultActivation.test.js
```

| Metric | Value |
| ------ | ----- |
| Tests | 47 |
| Pass | 47 |
| Fail | 0 |

## Broad rerun — every test file importing a DR-1-touched module

Identified by grepping all `__tests__/*.test.js` for references to
`styleObjects.ts`, `scanResultDressingRoom`, `dressingRoomItemContract`,
`dressingRoomCommerce`, `dressingRoomDedupe`, `canonicalDressingRoomItem`,
`eliseRoomItemEvidence`, `attachmentContext.ts`, `attachments.ts`:

```
NODE_PATH=<scratch>/node_modules node --test \
  __tests__/dressingRoomCanonicalItemContract.test.js \
  __tests__/dressingRoomItemContract.test.js \
  __tests__/eliseRoomItemEvidence.test.js \
  __tests__/dressingRoomSavePolicy.test.js \
  __tests__/scanResultActivation.test.js \
  __tests__/aiStylistLooksContract.test.js \
  __tests__/eliseV1V2Compatibility.test.js \
  __tests__/ownedRoomImageRefresh.test.js \
  __tests__/roomShareRedemptionContract.test.js \
  __tests__/styleChatAttachmentContract.test.js \
  __tests__/styleObjectsContract.test.js
```

| Metric | Value |
| ------ | ----- |
| Tests | 155 |
| Pass | 155 |
| Fail | 0 |
| Skip | 0 |

Rerun again against the final committed HEAD (`3f62e41`) with the same
result: 155/155.

## `git diff --check`

Run against the full repair diff (`5dc0b86..3f62e41`): clean, no whitespace
errors, exit 0.

## Migration reconciliation — independently verified against live production

This audit had read-only MCP access to the production Supabase project
(`wyyuqfdxucjksghsmhry`) and used it to independently confirm the migration
reconciliation, rather than trusting the original DR-1 handoff's claim:

| Ledger | Count | Last version |
| ------ | ----- | ------------ |
| Local (this branch, `ls supabase/migrations \| wc -l`) | 60 | `20260720115423_scan_commerce_events` |
| Production (`list_migrations` on `wyyuqfdxucjksghsmhry`, live query) | 60 | `20260720115423 scan_commerce_events` |

Every one of the 60 local migration filenames' version prefixes matches a
production migration version in the live-fetched list; the ledgers are
reconciled. Confirmed independently, not merely trusted.

## Production security advisors (read-only, informational)

`get_advisors(type=security)` was run read-only against `wyyuqfdxucjksghsmhry`
per this audit's explicit inspection authority. No advisor entry references
`scan_commerce_events` (DR-1's one new table) at all — consistent with the
source review showing RLS enabled, `anon`/`authenticated` revoked, and a
`service_role`-only policy. Two pre-existing findings mention
`dressing_room_items`, **neither introduced by DR-1 and both outside this
audit's repair scope**:

1. `authenticated_security_definer_function_executable` on
   `public.create_look_from_dressing_room_items` — an AI Stylist/Looks RPC,
   unrelated to the DR-1 diff.
2. `auth_allow_anonymous_sign_ins` on `public.dressing_room_items` — a
   pre-existing note that some of the table's RLS policies are defined on a
   role set that includes anonymous sign-in scenarios; DR-1 did not add,
   remove, or modify any RLS policy on `dressing_room_items`.

Both are documented here per the audit's requirement to record unrelated
findings without expanding scope — not repaired, as they predate DR-1 and
touching them would be release-branch/production-policy work outside this
audit's authorization.

## Migration replay

**Not executed.** No Docker, Supabase CLI, or local Postgres is available in
this audit sandbox (`which supabase docker psql` → none found). In place of
an executable replay, the new migration
(`20260720115423_scan_commerce_events.sql`) was manually reviewed line by
line: every DDL statement is idempotent (`create table if not exists`,
`create index if not exists`), the file is explicitly marked as
already-applied-in-production (do-not-reapply), and no other migration file
in the diff range was edited. This is a static-safety review, not a
substitute for an executable replay — **EXTERNAL GATE — NOT
SOURCE-REPAIRABLE** (no database engine available to this sandbox).

## Deno tests

**Not executed.** No Deno runtime is available in this sandbox
(`which deno` → not found). The pure TypeScript logic the Deno-hosted
`stylechat-generate` function depends on (`attachments.ts`,
`eliseRoomItemEvidence.ts`, `attachmentContext.ts`) is exercised through the
Node/`ts.transpileModule` harness used by the DR-1 test suite, and that
coverage ran and passed above. `contextMessages.test.ts`
(Deno-specific) was not run. **EXTERNAL GATE — NOT SOURCE-REPAIRABLE.**

## Database lint / advisors

Not run — this audit had no live connection to the production or a local
Supabase project (read-only production inspection was not performed via MCP
in this pass; all verification was from repository source). Recorded as an
open item for whoever next has direct project access, not a blocker for this
source-level audit's PASS determination.
