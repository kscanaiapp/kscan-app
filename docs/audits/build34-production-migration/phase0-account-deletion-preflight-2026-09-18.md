# K SCAN AI — BUILD 34
# PRODUCTION ACCOUNT DELETION MIGRATION PREFLIGHT

Phase 0 — read-only. Snapshot taken 2026-09-18T19:32Z–20:05Z against production
(`wyyuqfdxucjksghsmhry`) via the Supabase Management API and read-only SQL.

**PRODUCTION_MUTATED=NO.** No migration applied, no Edge Function deployed, no
`app_config` change, no storage change, no ledger change, no worker invocation,
nothing deleted.

---

## AUTHORITY

```
BACKEND_BRANCH=rebuild/backend-authority-v2
BACKEND_SHA=13a784413a1687e5599912047c11998c3e5cb07e
AUTHORITY_VERIFIED=YES
BACKEND_AUTHORITY_CHANGED=NO
```

`git ls-remote origin refs/heads/rebuild/backend-authority-v2` returns exactly
`13a784413a1687e5599912047c11998c3e5cb07e`. The branch has not moved.

`config/backend-authority.json` at that SHA names
`canonicalBranch: "rebuild/backend-authority-v2"` and
`role: "backend-deployment-authority"`. Governed source carries **172
migrations** and **25 governed Edge Functions**, matching its declared
`governedFunctionCount: 25`.

> **GOVERNANCE FLAG (A1).** The same file declares
> `approvedProjectRef: "yzqjvdfgefveprobvvyw"` — that is **staging**. The
> canonical authority manifest does **not** name production
> (`wyyuqfdxucjksghsmhry`) as an approved deployment target. This is a
> governance gap to close before the first production write, not a schema
> problem. See BLOCKERS.

---

## PRODUCTION

```
PROJECT_REF=wyyuqfdxucjksghsmhry            (KScan App Production, us-east-2)
STATUS=ACTIVE_HEALTHY
POSTGRES_VERSION=17.6 (platform 17.6.1.104, engine 17, ga)
MIGRATION_COUNT=95
PUBLIC_TABLE_COUNT=55                       (views: 0)
EDGE_FUNCTION_COUNT=18
```

All three expected baselines (95 / 55 / 18) reconfirmed live. Staging carries
172 migrations / 83 tables / 35 functions; the 77-migration and 17-function
deltas are **not** in scope and must never be closed by parity.

Platform note: production is on 17.6.1.104, staging on 17.6.1.155. Same major
and minor; no migration in scope depends on the difference.

---

## ACCOUNT DELETION CURRENT STATE

```
DELETION_REQUEST_COUNT=9
ACTIVE_REQUEST_COUNT=8
STATE_BREAKDOWN=deactivated:8, restored:1
INCOMPLETE_IDENTITY_ROWS=8
ACCOUNT_DELETION_WORKER_ENABLED=false
ACCOUNT_DELETION_WORKER_DRY_RUN=true
```

The previously observed "≈9 / 8 active" is confirmed exactly: 9 rows, 8
non-terminal.

**The 8 active rows are all identity-incomplete, and this is the single most
important finding of this preflight.** Every one of the 8 `deactivated` rows has
`user_id IS NULL`:

| property | value |
|---|---|
| `deactivated` rows | 8 |
| of which `user_id IS NULL` | **8** |
| of which `user_id` resolves to a live `auth.users` row | **0** |
| rows holding a `restoration_token_hash` | 8 |
| rows whose restoration token is still unexpired | **0** |
| `purged_at` set | 0 |
| `attempt_count` / `worker_id` | 0 / null on all rows |
| `subject_ref` populated | 9 of 9 (no nulls) |
| dangling `user_id` → `auth.users` | 0 |
| `deletion_state_transitions` rows | 10 |

Read together: these 8 Auth identities were deleted **outside** the governed
worker (`attempt_count = 0`, `worker_id` null, no purge transition), which set
`deletion_requests.user_id` to NULL via its `ON DELETE SET NULL`. The ledger
rows correctly survived, but they are **not restorable** (no Auth user, and
every restoration token has expired) and **not purgeable by the normal path**.
They are historical residue to be preserved, not processed.

This is benign under Build 34 as written: the governed worker's
`classifyDryRunCandidate()` returns `skipped_missing_user` for any row with no
`user_id`, so it never claims them even once live. No proposed mutation changes
these rows.

### Orphan media — corroborated independently

```
storage.objects with owner not resolvable in auth.users:
  bucket style-library-images   7 objects   4 distinct vanished owners   1933 kB
  (bucket total: 53 objects)
```

This matches the governed migration's own recorded production observation
("Production currently holds 7 such objects across 4 vanished owners") exactly,
from a live read taken today. It is the same out-of-band Auth deletion event
that produced the 8 NULL-`user_id` rows.

---

## SCHEMA RECONCILIATION

```
MISSING_BUILD34_TABLES=public.deleted_owner_retained_media
MISSING_BUILD34_COLUMNS=public.deletion_requests.status_receipt_hash
MISSING_BUILD34_INDEXES=8  (listed below)
MISSING_BUILD34_CONSTRAINTS=none beyond deletion_requests_status_receipt_hash_uidx
MISSING_BUILD34_FUNCTIONS=4  (listed below)
DRIFTED_BUILD34_FUNCTIONS=none in-database
MISSING_BUILD34_TRIGGERS=none
RLS_DIFFERENCES=none
GRANT_DIFFERENCES=none
```

**Missing indexes (8)**

| index | source migration |
|---|---|
| `deletion_requests_status_receipt_hash_uidx` | 20260908230000 |
| `deleted_owner_retained_media_open` | 20260831140000 |
| `style_chat_messages_source_message_idx` | 20260917163000 |
| `elise_generation_operations_source_message_idx` | 20260917163000 |
| `elise_generation_operations_session_idx` | 20260917163000 |
| `dressing_room_messages_parent_message_idx` | 20260917163000 |
| `look_items_source_dressing_room_item_idx` | 20260917163000 |
| `outfit_decision_option_items_source_saved_scan_idx` | 20260917163000 |

**Missing functions (4)**

| function | source migration |
|---|---|
| `public.list_orphan_owner_media(...)` | 20260916130553 |
| `public.record_retained_owner_media(uuid,text,text,integer)` | 20260831140000 |
| `public.claim_retained_owner_media_for_sweep(int)` | 20260831140000 |
| `public.settle_retained_owner_media(text,text,integer)` | 20260831140000 |

**Present and correct — no action.** The 13 deletion RPCs production already
carries are all `SECURITY DEFINER` with a pinned `search_path`:
`append_deletion_state_transition`, `claim_deletion_requests_for_purge`,
`get_my_deletion_status`, `heartbeat_deletion_request_lease`,
`list_deletion_purge_candidates`, `mark_deletion_request_purged`,
`peek_restoration_resend_by_email`, `preview_pending_deletion_backfill`,
`reconcile_orphaned_purging_requests`, `restore_account_by_token_hash`,
`rotate_restoration_token_by_email`, `schedule_deletion_retry_or_fail`,
`set_deletion_requests_updated_at`. Also present: `is_active_account()`
(SECURITY DEFINER, `search_path=""`), `revoke_user_sessions`,
`user_device_sessions`, trigger `trg_deletion_requests_updated_at`, and the
`profiles` policy `"Users can read own profile"`.

`public.deletion_requests` holds all 31 columns of the production contract
(including `processed_at`, `confirmation_email_sent_at`, `notes`) — i.e. the
column set that `20260805120000` exists to backfill **onto staging**.

### Security invariants — all four hold, unchanged

```
PUBLIC_EXECUTE=0
UNPINNED_SECURITY_DEFINER_SEARCH_PATH=0
UNPINNED_TRIGGER_SEARCH_PATH=0
RLS_ENABLED_ON_ALL_PUBLIC_TABLES=YES   (0 public tables without RLS)
```

### RLS / grants on the deletion surface — intentional, do not change

| table | RLS | policies | grants |
|---|---|---|---|
| `deletion_requests` | enabled | **0** | `service_role` only (SELECT/INSERT/UPDATE/DELETE) |
| `deletion_state_transitions` | enabled | **0** | `service_role` only |

The security advisor reports `rls_enabled_no_policy` (level **INFO**) against 7
tables, including both of these. That is the documented backend-only posture:
RLS on, no client policies, no client grants. **Do not add policies to satisfy
the advisor.** No grant widening is proposed anywhere in this manifest.

---

## EDGE FUNCTIONS

Classified by source comparison, not version number. Governed `config.toml`
supplies every `VERIFY_JWT_EXPECTED`.

```
FUNCTION=process-account-deletions
PRODUCTION_STATE=ACTIVE v25, deployed 2026-08-16T02:13:15Z, bundle a2c20c45…
BUILD34_SOURCE_STATE=index.ts 1031 lines; calls record_retained_owner_media,
                     claim_retained_owner_media_for_sweep, settle_retained_owner_media
HASH_MATCH=NO
VERIFY_JWT_PRODUCTION=false   VERIFY_JWT_EXPECTED=false   (match)
ACTION=DEPLOY_UPDATE   — hard-gated on M1
```
Decisive evidence: the deployed bundle references **none** of the three
retained-media RPCs, and bundles a compacted `_shared/deletion/common.ts`
(~30 dense lines) against the governed 528-line file. Deploying this before M1
would call three functions that do not exist.

```
FUNCTION=handle-user-deletion
PRODUCTION_STATE=ACTIVE v84, deployed 2026-07-23T02:16:55Z, single index.ts
BUILD34_SOURCE_STATE=multi-file (index.ts + handler.ts), 1594 lines; writes
                     deletion_requests.status_receipt_hash
HASH_MATCH=NO
VERIFY_JWT_PRODUCTION=true    VERIFY_JWT_EXPECTED=true    (match)
ACTION=DEPLOY_UPDATE   — order-tolerant, prefer after M2
```
Governed `handler.ts` explicitly degrades when the column is absent (treats a
missing `status_receipt_hash` as "no receipt binding", not an error), so it is
safe either side of M2. Deploy after M2 anyway, so the capability works on
first request.

```
FUNCTION=deletion-status
PRODUCTION_STATE=NOT_DEPLOYED
BUILD34_SOURCE_STATE=index.ts 279 lines + config.toml; reads status_receipt_hash
HASH_MATCH=N/A
VERIFY_JWT_PRODUCTION=n/a     VERIFY_JWT_EXPECTED=false
ACTION=DEPLOY_NEW      — gated on M2
```

```
FUNCTION=reconcile-orphan-media
PRODUCTION_STATE=NOT_DEPLOYED
BUILD34_SOURCE_STATE=index.ts 267 lines + config.toml; calls list_orphan_owner_media
HASH_MATCH=N/A
VERIFY_JWT_PRODUCTION=n/a     VERIFY_JWT_EXPECTED=false
ACTION=DEPLOY_NEW      — gated on M3; EXECUTION_MODE=DRY_RUN_ONLY, DELETION_ENABLED=NO
```

```
FUNCTION=restore-account
PRODUCTION_STATE=ACTIVE v23, deployed 2026-07-23T13:39:04Z
BUILD34_SOURCE_STATE=index.ts 141 lines — import list and every behavioural
                     marker identical to the deployed bundle
HASH_MATCH=INDETERMINATE (semantically equivalent; bytes differ by CRLF vs LF)
VERIFY_JWT_PRODUCTION=false   VERIFY_JWT_EXPECTED=false   (match)
ACTION=KEEP_PRODUCTION — no redeploy required for Build 34
```

```
FUNCTION=resend-restoration-email
PRODUCTION_STATE=ACTIVE v23, deployed 2026-07-23T13:39:08Z
BUILD34_SOURCE_STATE=index.ts 146 lines, same import surface
HASH_MATCH=INDETERMINATE (as above)
VERIFY_JWT_PRODUCTION=false   VERIFY_JWT_EXPECTED=false   (match)
ACTION=KEEP_PRODUCTION — no redeploy required for Build 34
```

Why the two restoration functions are **not** redeployed: the only governed
change to their shared dependency after they were deployed is commit `fbbb3d5`
(2026-08-31), which is purely additive — it adds `AuthUser.isAnonymous` and
`isEligibleAccountActor`, and touches `requireUser`. Neither function imports
`requireUser`, `AuthUser`, `isAnonymous` or `isEligibleAccountActor`
(verified by grep over both files). The change is therefore behaviourally inert
for both, and redeploying them buys no Build 34 behaviour while spending
production deployment risk. Both `verify_jwt` postures already match.

Every other production Edge Function (14 of 18) is outside account-deletion
scope and is **EXCLUDE** for this phase.

---

## SECRETS

**No secret value was read, printed, or logged.** The Supabase MCP surface
available to this session exposes no secrets-listing tool, and verifying
`ACCOUNT_DELETION_WORKER_SECRET` by invoking the worker is forbidden by this
phase. Presence is therefore reported honestly as unverified:

```
ACCOUNT_DELETION_WORKER_SECRET=NOT_VERIFIABLE_VIA_AVAILABLE_SURFACE (required)
ORPHAN_MEDIA_SWEEP_SECRET=NOT_VERIFIABLE_VIA_AVAILABLE_SURFACE (required by M8)
ORPHAN_MEDIA_SWEEP_DRY_RUN=NOT_VERIFIABLE_VIA_AVAILABLE_SURFACE (must be "true")
```

Additional account-deletion-related secret names referenced by governed Build 34
source, to be confirmed by the owner on the production project:

```
OTHER_REQUIRED_SECRET_NAMES=
  DELETION_WORKER_DRY_RUN            (worker forces dry run when "true")
  ACCOUNT_RESTORATION_BASE_URL       (defaults to https://kscan.app/account/restore)
  KSCAN_EMAIL_INTERNAL_SECRET        (restoration mail via Render→Resend; absent ⇒ mail skipped, not an error)
  KSCAN_EMAIL_RENDER_URL             (defaults to https://kscan-app-1.onrender.com)
  KSCAN_ENVIRONMENT
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY   (platform-provided)
```

`GITHUB_PRODUCTION_ENVIRONMENT_PROTECTION=NOT_VERIFIABLE` and
`REQUIRED_REVIEWERS=NOT_VERIFIABLE` — no environments API is exposed to this
session. `BACKUP_PITR_AVAILABILITY=NOT_VERIFIABLE` for the same reason. What is
verifiable from the repository: `.github/workflows/production-controlled-deploy.yml`
carries `environment: production` on every job that can mutate production,
requires `confirm_production == "DEPLOY TO PRODUCTION"`, asserts the governed
commit, and refuses any argument naming the staging ref.

---

## MIGRATION RECONCILIATION TABLE

Classification is by **physical effect**, verified live — never by filename or
timestamp.

| VERSION | NAME | CLASSIFICATION | RATIONALE | RISK |
|---|---|---|---|---|
| 202605130003 | deletion_requests | ALREADY_EQUIVALENT | In ledger; table present with full 31-column production contract. | none |
| 202605160001 | deletion_requests_client_insert | ALREADY_EQUIVALENT | In ledger; current posture is service_role-only with 0 policies, which is the later hardened state. Re-applying would re-grant client insert — **must not run**. | none if excluded |
| 20260722191013 | account_deletion_lifecycle | ALREADY_EQUIVALENT | Version in ledger. Ledger `statements` holds only the stub `applied via lifecycle rollout` (29 chars), but every physical object it defines is present and verified. | none |
| 20260723021145 | account_deletion_security_hardening | OBSOLETE_REMOTE_ONLY | Cannot execute after the lifecycle migration — it issues `CREATE OR REPLACE` on `schedule_deletion_retry_or_fail` with a changed return type (text→boolean), which Postgres rejects. Superseded superset. | would abort |
| 20260723021515 | reconcile_account_deletion_subsystem_to_production | ALREADY_EQUIVALENT | This migration exists to bring **staging** to production's contract, and its three objects were captured *from* production. All three verified present: `is_active_account()` (SECURITY DEFINER, `search_path=""`), `set_deletion_requests_updated_at()` (SECURITY DEFINER, `search_path=public`), policy `"Users can read own profile"`. Production is the authority here. | none |
| 20260723021635 | account_deletion_device_sessions_and_revoke | ALREADY_EQUIVALENT | Version in ledger with 4283 chars of real SQL; `user_device_sessions` and `revoke_user_sessions` present. | none |
| 20260723021735 | account_deletion_claim_retry_peek_v2 | ALREADY_EQUIVALENT | Version in ledger, 6192 chars; `schedule_deletion_retry_or_fail` present returning boolean. | none |
| 20260723040000 | account_deletion_crash_recovery | ALREADY_EQUIVALENT | Effects applied as ledger version **20260723131202** (6602 chars). `claim_deletion_requests_for_purge` present. Version differs, physical effect identical. | none |
| 20260723050000 | account_deletion_rls_active_account | ALREADY_EQUIVALENT | Effects applied as ledger **20260723131221** (966 chars). | none |
| 20260723060000 | deletion_ledger_pii_sanitizer | ALREADY_EQUIVALENT | Effects applied as ledger **20260723131423** (1326 chars). `append_deletion_state_transition` present. | none |
| 20260723132813 | harden_deletion_trigger_function_grants | ALREADY_EQUIVALENT | Version in ledger (631 chars). `PUBLIC_EXECUTE=0` confirms the hardening holds. | none |
| 20260805120000 | reconcile_deletion_requests_to_production_columns | ALREADY_EQUIVALENT | Explicitly a staging catch-up to the production column contract. All three columns already present in production. | none |
| 20260813224918 | backfill_legacy_pending_deletion_requests | ALREADY_EQUIVALENT (no-op) | Targets `status='pending' AND user_id IS NOT NULL`. Production holds **0 pending rows** (8 deactivated + 1 restored), so it would transition nothing. Excluded rather than run, to avoid a ledger row asserting work that did not happen. | none |
| **20260831140000** | **deleted_owner_retained_media** | **APPLY** | Table, 3 functions, 1 index, grants — all verified **MISSING**. Hard prerequisite for `process-account-deletions` Build 34 source. | low |
| **20260908230000** | **deletion_status_receipt** | **APPLY** | Column + partial unique index verified **MISSING**. Prerequisite for `deletion-status`. | low |
| **20260916130553** | **build33_orphan_owner_media_reconciliation_rpc** | **APPLY** | `list_orphan_owner_media` verified **MISSING** (the one `%orphan%` match in production is the unrelated `reconcile_orphaned_purging_requests`). Read-only function; deletes nothing. | low |
| **20260917163000** | **b34_fk_delete_path_indexes** | **APPLY** | All 6 indexes verified **MISSING**; all 6 table/column preconditions verified **OK**. | low |
| — | 8 identity-incomplete `deactivated` rows | **MANUAL_RECONCILIATION** | Not a migration. Pre-existing residue from out-of-band Auth deletion; no governed migration addresses it. See D1. | owner decision |

Net: **4 APPLY, 13 no-action, 1 manual reconciliation.** Nothing in this
manifest rewrites migration history, renames a file to match a ledger version,
or asserts a false equivalence.

> **LEDGER NOTE (not a proposed change).** Production's ledger holds placeholder
> `statements` for `20260722191013` ("applied via lifecycle rollout") and
> `20260723021514` (`-- applied from 20260723021145_… in follow-up if needed` +
> `select 1;`). The original artefacts are unrecoverable. Per
> `ACCOUNT_DELETION_HISTORY=PRESERVE_AND_FORWARD_RECONCILE` these rows are left
> exactly as they are. Physical state, verified above, is the authority.
> Separately, `supabase/migrations/ACCOUNT_DELETION_MIGRATION_DIVERGENCE.md` is
> **stale** at this SHA: it claims three applied migrations have no file in the
> repo, but `20260723021635`, `20260723021735` and `20260723132813` are all
> present now, recovered under their real ledger versions.

---

## DATA-PRESERVATION CHECKS

Every check below was evaluated against the live 9 rows, not assumed.

| check | result |
|---|---|
| all 9 current `deletion_requests` remain preservable | **PASS** — all 4 APPLY migrations are additive DDL; none touches a row |
| no migration truncates or recreates `deletion_requests` | **PASS** — no `TRUNCATE`, `DROP TABLE` or `CREATE TABLE` against it |
| no migration silently resets state/status | **PASS** — the only status-writing migration (20260813224918) is excluded, and would no-op anyway (0 pending rows) |
| no migration invalidates restoration capability | **PASS** — `restoration_token_hash` / `_expires_at` / `_used_at` untouched. Restoration is already unavailable for the 8 orphaned rows (no Auth user, tokens expired); the migration does not cause that |
| no migration orphans retained media | **PASS** — M1/M3 *reduce* orphan exposure; neither deletes |
| no FK or NOT NULL addition fails against existing rows | **PASS** — zero FK and zero NOT NULL additions in scope |
| no new uniqueness constraint conflicts | **PASS** — `deletion_requests_status_receipt_hash_uidx` is `WHERE status_receipt_hash IS NOT NULL`; all 9 rows will be NULL, so no collision (mirrors the existing `restoration_token_hash` partial-unique shape) |
| historically incomplete identity fields accounted for | **PASS, with D1** — 8 rows with `user_id IS NULL` are preserved untouched; the Build 34 worker classifies them `skipped_missing_user` and never claims them |
| `auth.users` relationships remain valid | **PASS** — 0 dangling `user_id` references |
| service-role-only tables remain inaccessible to clients | **PASS** — 0 policies, 0 client grants on both deletion tables, before and after |
| worker-disabled posture survives the migration | **PASS** — no proposed mutation writes `app_config`; `enabled=false` / `dry_run=true` are already correct and stay |

No Build 34 migration in scope assumes clean data that production does not
satisfy. The one production reality that Build 34 does not model — the 8
identity-incomplete rows — is handled by the worker's existing skip path, so no
migration needed to be reclassified `MANUAL_RECONCILIATION` on its account.

---

## PROPOSED MUTATIONS

All are **PHASE 1 (schema)** or **PHASE 2 (functions)**. None is authorised by
this document; this is the manifest to review.

```
ID=M1
TYPE=SCHEMA_DDL (additive)
OBJECT=public.deleted_owner_retained_media + record_retained_owner_media,
       claim_retained_owner_media_for_sweep, settle_retained_owner_media,
       index deleted_owner_retained_media_open, grants
CURRENT_STATE=absent (table, 3 functions, index all verified MISSING)
TARGET_STATE=present; RLS enabled; revoked from public/anon/authenticated;
             SELECT + EXECUTE granted to service_role only
SOURCE=supabase/migrations/20260831140000_deleted_owner_retained_media.sql @13a7844
DEPENDENCIES=none
PRECONDITION=to_regclass('public.deleted_owner_retained_media') IS NULL
MUTATION=apply the governed migration unmodified
VALIDATION=table present; 3 functions present; RLS on; 0 policies;
           PUBLIC_EXECUTE still 0; UNPINNED_SECURITY_DEFINER_SEARCH_PATH still 0;
           deletion_requests row count still 9
ROLLBACK=drop the 3 functions and the table (new, empty, nothing references it)
CONTAINMENT=work-list table only; holds no user content; no worker enabled
RISK=LOW
PHASE=1
```

```
ID=M2
TYPE=SCHEMA_DDL (additive column + partial unique index)
OBJECT=public.deletion_requests.status_receipt_hash,
       deletion_requests_status_receipt_hash_uidx
CURRENT_STATE=column absent, index absent
TARGET_STATE=nullable text column; unique index WHERE status_receipt_hash IS NOT NULL
SOURCE=supabase/migrations/20260908230000_deletion_status_receipt.sql @13a7844
DEPENDENCIES=none
PRECONDITION=column absent; all 9 existing rows will hold NULL (no unique conflict)
MUTATION=apply the governed migration unmodified
VALIDATION=column present and nullable; index present and partial;
           all 9 rows NULL; row count still 9; no status value changed
ROLLBACK=drop index, drop column (no reader depends on it until M6/M7)
CONTAINMENT=stores only a SHA-256 of a capability, never a raw receipt;
            grants no restoration, deletion or account access
RISK=LOW
PHASE=1
```

```
ID=M3
TYPE=SCHEMA_DDL (read-only function)
OBJECT=public.list_orphan_owner_media(...)
CURRENT_STATE=absent
TARGET_STATE=present, service_role-only EXECUTE
SOURCE=supabase/migrations/20260916130553_build33_orphan_owner_media_reconciliation_rpc.sql @13a7844
DEPENDENCIES=none
PRECONDITION=function absent (do not confuse with the unrelated, present
             reconcile_orphaned_purging_requests)
MUTATION=apply the governed migration unmodified
VALIDATION=function present; SECURITY DEFINER with pinned search_path;
           EXECUTE revoked from public/anon/authenticated;
           a read-only call reports the 7 known orphans across 4 owners;
           storage.objects count in style-library-images still 53
ROLLBACK=drop function
CONTAINMENT=function only READS; it deletes nothing by construction
RISK=LOW
PHASE=1
```

```
ID=M4
TYPE=SCHEMA_DDL (6 partial indexes)
OBJECT=style_chat_messages_source_message_idx,
       elise_generation_operations_source_message_idx,
       elise_generation_operations_session_idx,
       dressing_room_messages_parent_message_idx,
       look_items_source_dressing_room_item_idx,
       outfit_decision_option_items_source_saved_scan_idx
CURRENT_STATE=all 6 absent
TARGET_STATE=all 6 present
SOURCE=supabase/migrations/20260917163000_b34_fk_delete_path_indexes.sql @13a7844
DEPENDENCIES=none
PRECONDITION=all 6 table+column preconditions verified OK; exact row counts
             style_chat_messages 1021, elise_generation_operations 82,
             dressing_room_messages 4, look_items 0,
             outfit_decision_option_items 0 — so each build is trivial
MUTATION=apply the governed migration unmodified
VALIDATION=all 6 indexes present; no table/policy/grant/function changed
ROLLBACK=drop the 6 indexes (pure performance objects)
CONTAINMENT=plain CREATE INDEX briefly blocks writes per table; at ≤1021 rows
            this is milliseconds, and the migration-day row check is satisfied
RISK=LOW
PHASE=1
```

```
ID=M5
TYPE=EDGE_FUNCTION_DEPLOY (update)
OBJECT=process-account-deletions
CURRENT_STATE=ACTIVE v25, no retained-media RPC calls, compacted shared common.ts
TARGET_STATE=governed source @13a7844 (1031-line index.ts), verify_jwt=false
SOURCE=supabase/functions/process-account-deletions @13a7844
DEPENDENCIES=M1 (HARD — calls 3 functions M1 creates)
PRECONDITION=M1 validated; app_config account_deletion_worker_enabled=false
             AND account_deletion_worker_dry_run=true re-read immediately before
MUTATION=deploy governed source with verify_jwt=false
VALIDATION=verify_jwt still false; worker flags still false/true;
           no invocation performed as part of this phase
ROLLBACK=redeploy the captured v25 bundle
CONTAINMENT=deploying does NOT authorise activation. Worker stays disabled and
            dry-run. Kill switch remains app_config.account_deletion_worker_enabled
RISK=MEDIUM (largest behavioural delta in scope)
PHASE=2
```

```
ID=M6
TYPE=EDGE_FUNCTION_DEPLOY (update)
OBJECT=handle-user-deletion
CURRENT_STATE=ACTIVE v84, single-file, no receipt binding
TARGET_STATE=governed multi-file source @13a7844, verify_jwt=true
SOURCE=supabase/functions/handle-user-deletion @13a7844
DEPENDENCIES=M2 (SOFT — governed source degrades gracefully if column absent)
PRECONDITION=M2 validated
MUTATION=deploy governed source with verify_jwt=true
VALIDATION=verify_jwt still true; deletion_requests row count still 9
ROLLBACK=redeploy captured v84 bundle
CONTAINMENT=this is the intake path; it creates deletion requests but purges nothing
RISK=MEDIUM
PHASE=2
```

```
ID=M7
TYPE=EDGE_FUNCTION_DEPLOY (new)
OBJECT=deletion-status
CURRENT_STATE=NOT_DEPLOYED anywhere
TARGET_STATE=deployed, verify_jwt=false
SOURCE=supabase/functions/deletion-status @13a7844
DEPENDENCIES=M2 (HARD — queries status_receipt_hash)
PRECONDITION=M2 validated
MUTATION=deploy governed source with verify_jwt=false
VALIDATION=verify_jwt=false; responds only to a presented capability hash
ROLLBACK=this is its first deployment anywhere — deleting the slug is a clean revert
CONTAINMENT=read-only status lookup; resolves at most one lifecycle row;
            grants no restoration, deletion or account access
RISK=LOW
PHASE=2
```

```
ID=M8
TYPE=EDGE_FUNCTION_DEPLOY (new)
OBJECT=reconcile-orphan-media
CURRENT_STATE=NOT_DEPLOYED
TARGET_STATE=deployed, verify_jwt=false, EXECUTION_MODE=DRY_RUN_ONLY,
             DELETION_ENABLED=NO
SOURCE=supabase/functions/reconcile-orphan-media @13a7844
DEPENDENCIES=M3 (HARD), S1
PRECONDITION=M3 validated; ORPHAN_MEDIA_SWEEP_SECRET present;
             ORPHAN_MEDIA_SWEEP_DRY_RUN="true" CONFIRMED BEFORE DEPLOY
MUTATION=deploy governed source with verify_jwt=false
VALIDATION=verify_jwt=false; secret-gated and fail-closed;
           NO scheduled invoker created; storage.objects in
           style-library-images still 53 objects
ROLLBACK=delete the slug (first deployment on this project)
CONTAINMENT=**no schedule, no trigger, no invocation in this migration.**
            Destructive orphan-media cleanup is NOT activated. The staging
            counterpart workflow is dry-run-only and explicitly denies production
RISK=LOW while dry-run is enforced
PHASE=2
```

```
ID=S1
TYPE=SECRET_PROVISION (names only; owner action)
OBJECT=ORPHAN_MEDIA_SWEEP_SECRET, ORPHAN_MEDIA_SWEEP_DRY_RUN
CURRENT_STATE=NOT_VERIFIABLE via available surface
TARGET_STATE=ORPHAN_MEDIA_SWEEP_SECRET present; ORPHAN_MEDIA_SWEEP_DRY_RUN="true"
DEPENDENCIES=none
PRECONDITION=owner confirms on the production project
MUTATION=set secret names/values out of band; no value ever printed here
VALIDATION=owner confirms presence; dry-run flag reads "true"
ROLLBACK=remove secret ⇒ M8 fails closed rather than running unauthenticated
CONTAINMENT=absent secret makes the reconciler refuse to run — safe default
RISK=LOW
PHASE=0/2 boundary
```

**Explicitly NOT proposed:** enabling the worker; clearing dry-run; any real
customer deletion; any destructive orphan-media cleanup; any migration-history
rewrite; any `app_config` copy from staging; any anonymous/Apple/Google auth
change; wearable, website-privacy or investor schema or functions; pgtap;
Build 35 work; removal of `public-assets`; any deletion of production-only state.

---

## BLOCKERS

**B1 — Authority manifest does not approve production.** `AUTHORITY_VERIFIED=YES`
for branch and SHA, but `config/backend-authority.json` sets
`approvedProjectRef: "yzqjvdfgefveprobvvyw"` (staging). No field in the canonical
manifest authorises `wyyuqfdxucjksghsmhry`. Owner must either add production as
an approved target at the authority SHA, or record an explicit out-of-band
authorisation for this migration. **Governance, not schema. Blocks the first
production write.**

**B2 — Secret presence unverified.** `ACCOUNT_DELETION_WORKER_SECRET`,
`ORPHAN_MEDIA_SWEEP_SECRET` and `ORPHAN_MEDIA_SWEEP_DRY_RUN` cannot be checked
from this session (no secrets tool; invoking the worker to probe is forbidden in
Phase 0). **Blocks M8 only.** M1–M4 need no secret.

**B3 — GitHub `production` Environment protection unverified.** No environments
API is exposed here, so required-reviewer status is unconfirmed. The controlled
deploy workflow depends on that gate existing to satisfy the human-approval
requirement. Owner to confirm.

**B4 — Backup / PITR availability unverified.** Not exposed to this session.
Confirm a restore point exists before Phase 1, since M1–M4 are the first
Build 34 writes to production.

**D1 — Owner decision: the 8 identity-incomplete rows.** Not a blocker for
M1–M8, which leave them untouched, and the Build 34 worker will always skip
them (`skipped_missing_user`). But they will remain in `deactivated` forever and
their 7 storage objects across 4 vanished owners stay orphaned until the
orphan-media sweep is eventually allowed to delete — a separate,
post-certification decision. Options, for a later phase, not now: (a) leave as
permanent preserved residue; (b) a bounded forward-safe transform recording a
terminal `purged`-equivalent state with an audit transition noting out-of-band
Auth deletion, preserving every row; (c) let the orphan sweep clear only the
media and leave the ledger untouched. **Recommendation: (a) or (c) — neither
deletes a ledger row.** No mutation proposed in this manifest.

---

## FINAL STATUS

```
ACCOUNT_DELETION_BUILD34_RECONCILIATION=READY_FOR_EXECUTION_MANIFEST
PRODUCTION_MUTATED=NO
```

Schema reconciliation is complete and unambiguous: **4 migrations to APPLY, 13
requiring no action, 0 requiring a modified/bounded transform, 4 Edge Function
actions (2 update, 2 new), 2 Edge Functions correctly left alone, 1 owner
decision deferred.** Every data-preservation check passes and all four security
invariants hold and are preserved by every proposed mutation.

Execution remains gated on **B1** (production not named by the authority
manifest) and, for M8 only, **B2**. B3 and B4 should be confirmed before the
first write. No production mutation is authorised by this document.
