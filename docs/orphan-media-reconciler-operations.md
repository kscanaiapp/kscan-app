# Orphan-owner media reconciler: operations (staging)

`reconcile-orphan-media` finds `style-library-images` objects whose owner no
longer resolves to an `auth.users` row and that nothing references
(B33-STO-002). Its governed invoker is
`.github/workflows/staging-orphan-media-reconciler.yml`, which runs
`scripts/invoke-orphan-media-reconciler.mjs` (B34-BE-STO-001).

**It is a dry-run observer. Nothing in this setup can delete an object.**

## Safety locks

Deletion requires every one of these locks to be released, and each one is an
independent owner action:

| Lock | Where | Staging state (2026-09-17) |
|---|---|---|
| Kill switch | `app_config.orphan_media_sweep_enabled` | row absent, which reads as OFF |
| Dry-run flag | `app_config.orphan_media_sweep_dry_run` | row absent; not consulted while the kill switch is OFF |
| Dry-run env lock | function secret `ORPHAN_MEDIA_SWEEP_DRY_RUN` | `true`, which forces dry run regardless of `app_config` |
| Invoker invariant | `scripts/invoke-orphan-media-reconciler.mjs` | exits 3 on any response other than a disarmed dry run |
| Invoker shape | workflow file | no live mode, no mode input, and a request body the function ignores |

Clients cannot write `app_config`. RLS has no insert/update/delete policy, so a
rolled-back probe returned 42501 for inserts and 0 affected rows for
updates/deletes. The candidate RPC `list_orphan_owner_media` is `service_role`
only.

## Credentials (names only)

- `ORPHAN_MEDIA_SWEEP_SECRET`: set both as a Supabase function secret on
  `yzqjvdfgefveprobvvyw` and as a secret in the GitHub `staging` environment.
  Both copies must hold the same value. It was rotated on 2026-09-17, and the
  audit-era value is no longer valid.
- `ORPHAN_MEDIA_SWEEP_DRY_RUN`: Supabase function secret, value `true`.

To rotate, generate a fresh random value and write it to a BOM-less file.
Run `supabase secrets set --env-file <file> --project-ref yzqjvdfgefveprobvvyw`
and `gh secret set ORPHAN_MEDIA_SWEEP_SECRET --env staging < <value-file>`.
Delete the files afterwards, then dispatch the workflow once to confirm.
`supabase secrets list` shows the SHA-256 of each value, so the two copies can
be compared without printing either one.

## Running it

- **Dispatch:** Actions → *Staging Orphan Media Reconciler (dry run)* → Run
  workflow. The optional `reason` is recorded in the summary.
- **Schedule:** daily at 09:40 UTC, 25 minutes after the staging deletion
  worker. GitHub only runs `schedule:` from the default branch, so the cadence
  starts once this file is promoted to `master`, as
  `staging-account-deletion-worker.yml` was. Until then, dispatch is the invoker.
- **Output:** a sanitized projection only:
  `{httpStatus, mode, dryRun, killSwitchEnabled, candidateCount, distinctOwners, totalBytes, hasMore, objectsDeleted}`.
  It never contains object paths, owner ids, or the raw response.

## Reading a run

| Result | Meaning | Action |
|---|---|---|
| green, `candidateCount` stable | The orphan inventory is unchanged | none |
| green, `candidateCount` rising | Auth users are still being deleted outside the deletion worker | investigate the deletion path, not the reconciler |
| exit 1 | Secret missing, or a non-staging target | provision the `staging` environment secret |
| exit 2 | Non-200 response, transport failure, or malformed body | check `function_logs` for `sweep_auth_rejected` / `orphan_sweep_error` |
| **exit 3** | **The function reported a live or armed sweep** | set `app_config.orphan_media_sweep_enabled` to `false`, confirm `ORPHAN_MEDIA_SWEEP_DRY_RUN=true`, and investigate before the next run |

## Enabling deletion

This is out of scope for Build 34 and is not authorized by this runbook. It
would require a reviewed change to the workflow and the invoker (a separate live
mode with a typed confirmation, modelled on
`production-account-deletion-worker.yml`), removing the env lock, and flipping
both `app_config` flags. Observe a dry-run count first; the 30 historical
staging objects (6 owners, 10,662,345 bytes) are intentionally retained.

## Staging proof (2026-09-17)

- Three governed dispatches (runs 35246921846, 35246973265, 35247031926) and
  three local authenticated calls returned identical results:
  `candidateCount=30`, `distinctOwners=6`, `totalBytes=10662345`,
  `hasMore=false`, `objectsDeleted=0`. Each call's function log shows
  `envDryRun:true`, `killSwitchEnabled:false`, and no removal event.
- Negative controls:
  - Missing, malformed, wrong or prefix-only secret, legacy anon JWT, and
    publishable key: all returned 401.
  - GET: returned 405.
  - A body asking for live deletion, and a `?dry_run=false` query: both still
    returned `dry_run`.
- Storage and database signatures were identical before and after the series:
  36 objects, 171-row ledger, and unchanged public/storage DML counters.
