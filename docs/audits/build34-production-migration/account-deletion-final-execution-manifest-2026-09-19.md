# K SCAN AI — BUILD 34
# ACCOUNT DELETION FINAL EXECUTION MANIFEST

Continuation of `phase0-account-deletion-preflight-2026-09-18.md`. Read-only.
Production state re-verified 2026-09-19T02:21:43Z and is byte-for-byte identical
to the Phase 0 snapshot.

**PRODUCTION_MUTATED=NO.** No migration applied, no function deployed, no
`app_config` write, no storage change, no ledger change, no worker invocation,
no governed-source edit.

---

## 1. AUTHORITY STATUS

```
BACKEND_SHA=13a784413a1687e5599912047c11998c3e5cb07e
BACKEND_AUTHORITY_CHANGED=NO
BACKEND_AUTHORITY_PROJECT_REF_CLASSIFICATION=INTENTIONAL_STAGING_AUTHORITY
PRODUCTION_DEPLOY_AUTHORITY_VALID=YES
```

`git ls-remote origin refs/heads/rebuild/backend-authority-v2` still returns
exactly `13a7844`. The tip has not moved.

### B1 is resolved: `approvedProjectRef` is intentionally staging

Phase 0 flagged `approvedProjectRef: "yzqjvdfgefveprobvvyw"` as a possible
governance gap. Tracing every consumer shows it is **by design**, and correcting
it would be the defect:

**Two governance tests forbid it from ever being production.**

| file | assertion |
|---|---|
| `__tests__/backendAuthorityGovernance.test.js:208-211` | test name: *"the approved project ref is staging, never production"*; `assert.equal(AUTHORITY.approvedProjectRef,'yzqjvdfgefveprobvvyw')` and `assert.notEqual(..., 'wyyuqfdxucjksghsmhry')` |
| `__tests__/edgeFunctionSourceParity.test.js:478-479` | same pair, commented `'staging, never production'` |

**Its consumers are the staging Edge Function path only** —
`scripts/deploy-edge-functions.js:168`, `scripts/check-edge-function-parity.js:80`,
`scripts/generate-edge-function-manifest.js:135`. Each aborts if the target ref
is not the approved (staging) ref. That is a staging-deploy interlock, not a
production authorisation list.

**Production is governed by a separate, stricter mechanism.** The three
production scripts read `backend-authority.json` only for the canonical
**branch** (`GOVERNED_BRANCH` / `assertGovernedCommit`), never for
`approvedProjectRef`:

- `scripts/lib/staging-constants.mjs:7` hard-pins
  `PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry'`.
- `assertProductionTarget()` (`production-helpers.mjs:32-67`) refuses if the ref
  is absent, equals staging, or is anything other than that constant; it also
  validates `SUPABASE_PRODUCTION_URL` against the ref and rejects a
  service-role key supplied where an anon/publishable key is expected.
- `assertGovernedCommit()` (`production-deploy-preflight.mjs:91-109`) requires
  `HEAD === origin/rebuild/backend-authority-v2` exactly — so production can
  only ever be deployed from the authority tip.
- `runSupabaseProduction()` refuses any argv naming the staging project.

So production is *more* tightly bound than `approvedProjectRef` would make it.
**No governance change is needed or wanted. Do not edit the authority file.**

> Operational consequence of `assertGovernedCommit`: the execution checkout must
> be exactly `13a7844` **and** that must still be the branch tip at run time. If
> the branch advances mid-migration, every remaining step refuses until the
> manifest is re-verified against the new tip.

---

## 2. PRODUCTION SAFETY GATES

```
GITHUB_PRODUCTION_ENVIRONMENT_EXISTS=NOT_VERIFIABLE_FROM_CURRENT_ACCESS
REQUIRED_REVIEWERS_CONFIGURED=NOT_VERIFIABLE_FROM_CURRENT_ACCESS
PRODUCTION_PROJECT_REF_VARIABLE=NOT_VERIFIABLE_FROM_CURRENT_ACCESS (declared: vars.SUPABASE_PRODUCTION_PROJECT_REF)
PRODUCTION_URL_VARIABLE_PRESENT=NOT_VERIFIABLE_FROM_CURRENT_ACCESS (declared: vars.SUPABASE_PRODUCTION_URL)
PRODUCTION_PUBLISHABLE_KEY_SECRET_PRESENT=NOT_VERIFIABLE_FROM_CURRENT_ACCESS (declared: SUPABASE_PRODUCTION_ANON_KEY)
SUPABASE_ACCESS_TOKEN_SECRET_PRESENT=NOT_VERIFIABLE_FROM_CURRENT_ACCESS
BACKUP_AVAILABLE=NOT_VERIFIABLE_FROM_CURRENT_ACCESS
PITR_AVAILABLE=NOT_VERIFIABLE_FROM_CURRENT_ACCESS
RECOVERY_WINDOW=NOT_VERIFIABLE_FROM_CURRENT_ACCESS
LATEST_RECOVERY_POINT=NOT_VERIFIABLE_FROM_CURRENT_ACCESS
PROJECT_PLAN_SUPPORTS_REQUIRED_RECOVERY=NOT_VERIFIABLE_FROM_CURRENT_ACCESS
SECRET_GATES=NOT_VERIFIABLE (see §4)
```

This session's GitHub connector exposes no environments, variables or secrets
API, and the Supabase MCP surface exposes no backups/PITR tool. `restore_project`
exists but restores a *paused* project and is not PITR; it was not called. No
PASS is invented for any of the above.

**What IS verifiable, from the repository:**
`.github/workflows/production-controlled-deploy.yml` carries
`environment: production` on every job from line 224 onward ("Everything from
here on can mutate production"), requires
`confirm_production == "DEPLOY TO PRODUCTION"` (line 83), asserts the governed
commit, validates the four required production variables without printing them
(line 125-147), and refuses if the production ref equals staging. It has no
`push` or `schedule` trigger — dispatch only.

### Exact manual dashboard checks required (owner)

1. **GitHub** → Settings → Environments → `production`: confirm it exists and
   has **Required reviewers** configured. Confirm repository **Variables**
   `SUPABASE_PRODUCTION_PROJECT_REF` (= `wyyuqfdxucjksghsmhry`) and
   `SUPABASE_PRODUCTION_URL`, and **Secrets** `SUPABASE_PRODUCTION_ANON_KEY`,
   `SUPABASE_ACCESS_TOKEN`, `ACCOUNT_DELETION_WORKER_SECRET` exist on that
   environment. Presence only — never reveal values.
2. **Supabase** → project `wyyuqfdxucjksghsmhry` → Database → **Backups**:
   confirm daily backup present and note the latest restore point; confirm
   whether **PITR** is enabled and its window. Record both before Phase 1.

---

## 3. HISTORICAL RESIDUE

```
RESIDUE_BLOCKS_BUILD34=NO
RESIDUE_DISPOSITION=PRESERVE_AND_TRACK_SEPARATELY
```

Re-verified 2026-09-19: 9 `deletion_requests` — 8 `deactivated` (all
`user_id IS NULL`), 1 `restored`; 7 orphan storage objects across 4 vanished
owners. Each required question answered from source, not assumption:

| question | finding |
|---|---|
| Does any APPLY migration touch those rows? | **No.** `20260908230000`, `20260916130553`, `20260917163000` contain zero row-writing statements. `20260831140000` contains 5, and every one targets the **new** `deleted_owner_retained_media` table (lines 98, 103, 132, 170, 175) inside the new function bodies — never `deletion_requests`. |
| Any constraint conflict? | **No.** The only new constraint touching existing data is `deletion_requests_status_receipt_hash_uidx`, which is partial (`WHERE status_receipt_hash IS NOT NULL`); all 9 rows will be NULL. The new table's `unique (storage_bucket, storage_prefix)` and three CHECKs apply to an empty table. |
| New FK against existing rows? | `deleted_owner_retained_media.deletion_request_id → deletion_requests(id) ON DELETE CASCADE` is declared on the **new child** table, so no existing `deletion_requests` row is validated against anything. Production gains a dependent table; since no `deletion_requests` row is ever deleted, the cascade never fires. |
| Will the worker try to process them? | **No — blocked at two independent layers.** (a) **Database:** `claim_deletion_requests_for_purge` (production ledger `20260723131202`) both `join public.profiles p on p.id = dr.user_id` and `and dr.user_id is not null`, so a NULL-`user_id` row is unclaimable by construction — the migration even documents this. (b) **Edge:** governed worker returns `skipped_missing_user` (`index.ts:527`) and re-checks at line 861. |
| Does `deletion-status` expose them incorrectly? | **No.** It resolves a row *only* by `status_receipt_hash=eq.<hash>`. All 9 rows have that column NULL (it does not yet exist), so none is reachable. Even if one were, `deactivated → 'pending'` and the mapper refuses to report `purged` without `purged_at`, failing closed to `pending` on any unrecognised status. |
| Can orphan-media dry run safely report the residue? | **Yes.** `list_orphan_owner_media` is `stable`, reads `storage.objects` / `auth.users` / `dressing_room_items` only, deletes nothing, and is bucket-allowlisted. It is exactly the mechanism that surfaces this residue's 7 objects. |
| Does Build 34 explicitly skip missing-user rows? | **Yes**, at both layers above. |

No bounded reconciliation is required. **Do not mutate these rows.** Track them
as a separate post-certification item (Phase 0 item D1).

---

## 4. SECRET GATES

Derived from governed source at `13a7844`, following imports transitively into
`_shared/`. Values were never read; the Supabase MCP surface exposes no secrets
tool, and probing by invoking a production function is forbidden.

| SECRET_NAME | REQUIRED_BY | REQUIRED_BEFORE_PHASE | PRESENCE | BLOCKING_IF_MISSING |
|---|---|---|---|---|
| `SUPABASE_URL` | all six | platform | auto-provided | n/a |
| `SUPABASE_SERVICE_ROLE_KEY` | all six | platform | auto-provided | n/a |
| `SUPABASE_ANON_KEY` | p-a-d, h-u-d, r-o-m, r-a, r-r-e | platform | auto-provided | n/a |
| `ACCOUNT_DELETION_WORKER_SECRET` | process-account-deletions | 2 (before M5) | NOT_VERIFIABLE | **YES** — `requireWorkerAuth` throws 503 "Worker secret not configured"; every invocation fails closed |
| `DELETION_WORKER_DRY_RUN` | process-account-deletions | 2 (before M5) | NOT_VERIFIABLE | NO — absent ⇒ falsy ⇒ relies on `app_config` flags, which are already `enabled=false`/`dry_run=true` |
| `ORPHAN_MEDIA_SWEEP_SECRET` | reconcile-orphan-media | 2 (before M8) | NOT_VERIFIABLE | **YES** — fail-closed; absent ⇒ refuses every request |
| `ORPHAN_MEDIA_SWEEP_DRY_RUN` | reconcile-orphan-media | 2 (before M8) | NOT_VERIFIABLE | **YES for posture** — must be `"true"` to force dry run regardless of `app_config` |
| `ACCOUNT_RESTORATION_BASE_URL` | p-a-d, h-u-d, r-a, r-r-e | 2 | NOT_VERIFIABLE | NO — defaults to `https://kscan.app/account/restore` |
| `KSCAN_EMAIL_INTERNAL_SECRET` | p-a-d, h-u-d, r-a, r-r-e | 2 | NOT_VERIFIABLE | NO — absent ⇒ restoration mail skipped and logged, explicitly not an error |
| `KSCAN_EMAIL_RENDER_URL` | p-a-d, h-u-d, r-a, r-r-e | 2 | NOT_VERIFIABLE | NO — defaults to `https://kscan-app-1.onrender.com` |
| `REVENUECAT_PROJECT_ID`, `REVENUECAT_SECRET_API_KEY`, `REVENUECAT_KPLUS_ENTITLEMENT_ID`, `REVENUECAT_SYNC_ENABLED` | process-account-deletions (K+ mirror retirement at purge) | worker activation, **not** this migration | NOT_VERIFIABLE | NO for this migration — only reached on a live purge, which stays disabled |
| `KSCAN_ENVIRONMENT` | not referenced by any of the six | — | n/a | NO — Phase 0 listed it from the wider governed tree; it is **not** a gate for these functions |

`deletion-status` requires **only** the two platform secrets — the lightest gate
of the six.

---

## 5. DATABASE MUTATIONS — ORDERED

### Dependency proof (not accepted from the brief)

Each migration was checked for references to the others' objects:

| migration | references `deleted_owner_retained_media` | references `status_receipt_hash` | references `list_orphan_owner_media` | references the 6 indexes |
|---|---|---|---|---|
| `20260831140000` | creates it | no | no | no |
| `20260908230000` | no | creates it | no | no |
| `20260916130553` | **no** (documented: the retained queue "does not address" this case) | no | creates it | no |
| `20260917163000` | no | no | no | creates them |

**All four are mutually independent.** Every one depends only on objects
production already has (`deletion_requests`, `storage.objects`, `auth.users`,
`dressing_room_items`, and the five index parent tables — all verified present).
So the expected order AD-DB-001→004 is **valid but not forced by schema
dependency**; it is adopted because (a) ascending ledger version keeps
`schema_migrations` monotonic, and (b) AD-DB-001 unblocks the highest-risk
function deploy (M5) earliest. Any order would work; this one is recommended.

---

```
ID=AD-DB-001
TYPE=SCHEMA_DDL (additive: table + 3 functions + index + RLS + grants)
MIGRATION_VERSION=20260831140000
MIGRATION_NAME=deleted_owner_retained_media
OBJECTS_AFFECTED=
  TABLE public.deleted_owner_retained_media
    (id uuid pk default gen_random_uuid(),
     deletion_request_id uuid NOT NULL REFERENCES public.deletion_requests(id) ON DELETE CASCADE,
     storage_bucket text NOT NULL, storage_prefix text NOT NULL,
     retained_count integer NOT NULL DEFAULT 0,
     first_retained_at timestamptz NOT NULL DEFAULT now(),
     last_swept_at timestamptz, sweep_attempts integer NOT NULL DEFAULT 0,
     cleared_at timestamptz,
     CHECK char_length(storage_bucket) BETWEEN 1 AND 100,
     CHECK char_length(storage_prefix) BETWEEN 1 AND 400,
     CHECK retained_count >= 0,
     UNIQUE (storage_bucket, storage_prefix))
  INDEX deleted_owner_retained_media_open ON (first_retained_at) WHERE cleared_at IS NULL
  ALTER TABLE ... ENABLE ROW LEVEL SECURITY
  REVOKE ALL ON TABLE ... FROM public, anon, authenticated
  GRANT SELECT ON TABLE ... TO service_role
  FUNCTION public.record_retained_owner_media(p_request_id uuid, p_bucket text, p_prefix text, p_retained integer) RETURNS void
  FUNCTION public.claim_retained_owner_media_for_sweep(p_limit int DEFAULT 25) RETURNS SETOF public.deleted_owner_retained_media  [SECURITY DEFINER, search_path=public]
  FUNCTION public.settle_retained_owner_media(p_bucket text, p_prefix text, p_remaining integer) RETURNS boolean
  REVOKE ALL / GRANT EXECUTE TO service_role on each of the three
CURRENT_PRODUCTION_STATE=table absent; all 3 functions absent; index absent (verified)
TARGET_BUILD34_STATE=all present; RLS on; zero policies; service_role-only
GOVERNED_SOURCE=supabase/migrations/20260831140000_deleted_owner_retained_media.sql @13a7844
DEPENDENCIES=public.deletion_requests (present). None on AD-DB-002/003/004.
PRECONDITION_SQL=
  SELECT to_regclass('public.deleted_owner_retained_media') IS NULL AS ok;               -- expect true
  SELECT count(*)=0 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname IN
     ('record_retained_owner_media','claim_retained_owner_media_for_sweep','settle_retained_owner_media');
  SELECT count(*)=9 AS ok FROM public.deletion_requests;
MUTATION_SOURCE_SQL=the governed file, applied verbatim and unmodified
VALIDATION_SQL=
  SELECT to_regclass('public.deleted_owner_retained_media') IS NOT NULL;                 -- true
  SELECT relrowsecurity FROM pg_class WHERE oid='public.deleted_owner_retained_media'::regclass;  -- true
  SELECT count(*)=0 FROM pg_policy WHERE polrelid='public.deleted_owner_retained_media'::regclass;
  SELECT count(*)=0 FROM information_schema.role_table_grants
   WHERE table_name='deleted_owner_retained_media' AND grantee IN ('anon','authenticated','PUBLIC');
  SELECT count(*)=3 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname IN (the three);
  SELECT count(*)=0 FROM public.deleted_owner_retained_media;                            -- new table empty
  + the universal gate in §7
ROLLBACK=DROP the 3 functions, then DROP TABLE public.deleted_owner_retained_media.
         Safe ONLY while the table is empty and process-account-deletions has not
         been deployed (M5). Once M5 is live and the worker has enqueued a prefix,
         prefer FORWARD_FIX.
FORWARD_FIX_OPTION=leave the table in place; it is inert while the worker is
         disabled. A defect in one of the three functions is fixed by a new
         governed CREATE OR REPLACE migration, not by dropping the table.
CONTAINMENT=work-list bookkeeping only; holds no user content; no client role can
         read it; worker stays disabled + dry-run
DATA_RISK=NONE (no existing row read or written)
SECURITY_RISK=NONE (grants strictly narrower than any existing table; RLS on)
EXPECTED_LOCK_RISK=NONE on existing tables. The FK takes a brief SHARE lock on
         deletion_requests (9 rows) to validate the reference — milliseconds.
PHASE=1
```

```
ID=AD-DB-002
TYPE=SCHEMA_DDL (additive column + partial unique index + comment)
MIGRATION_VERSION=20260908230000
MIGRATION_NAME=deletion_status_receipt
OBJECTS_AFFECTED=
  ALTER TABLE public.deletion_requests ADD COLUMN IF NOT EXISTS status_receipt_hash text   -- nullable, no default
  CREATE UNIQUE INDEX IF NOT EXISTS deletion_requests_status_receipt_hash_uidx
    ON public.deletion_requests (status_receipt_hash) WHERE status_receipt_hash IS NOT NULL
  COMMENT ON COLUMN ...
CURRENT_PRODUCTION_STATE=column absent; index absent (verified). Table has 31 columns.
TARGET_BUILD34_STATE=32 columns; partial unique index present
GOVERNED_SOURCE=supabase/migrations/20260908230000_deletion_status_receipt.sql @13a7844
DEPENDENCIES=public.deletion_requests (present). None on AD-DB-001/003/004.
PRECONDITION_SQL=
  SELECT count(*)=0 AS ok FROM information_schema.columns
   WHERE table_schema='public' AND table_name='deletion_requests' AND column_name='status_receipt_hash';
  SELECT count(*)=9 AS ok FROM public.deletion_requests;
MUTATION_SOURCE_SQL=the governed file, verbatim
VALIDATION_SQL=
  SELECT is_nullable='YES' AND column_default IS NULL FROM information_schema.columns
   WHERE table_schema='public' AND table_name='deletion_requests' AND column_name='status_receipt_hash';
  SELECT indexdef LIKE '%WHERE (status_receipt_hash IS NOT NULL)%' FROM pg_indexes
   WHERE indexname='deletion_requests_status_receipt_hash_uidx';
  SELECT count(*)=9 AND count(status_receipt_hash)=0 FROM public.deletion_requests;  -- all 9 NULL
  SELECT count(*)=8 FROM public.deletion_requests WHERE status='deactivated';
  SELECT count(*)=1 FROM public.deletion_requests WHERE status='restored';
  + §7
ROLLBACK=DROP INDEX deletion_requests_status_receipt_hash_uidx; ALTER TABLE
         public.deletion_requests DROP COLUMN status_receipt_hash.
         Safe ONLY before M6/M7. After M6 is live, a client may hold a receipt
         whose hash is stored here — dropping the column silently destroys that
         capability, so use FORWARD_FIX instead.
FORWARD_FIX_OPTION=leave column and index; both are inert until a writer exists.
         handle-user-deletion treats a missing column as "no receipt binding",
         so the column can also simply go unused.
CONTAINMENT=stores a SHA-256 only, never a raw receipt; confers no restoration,
         deletion or account access; partial index cannot collide with legacy NULLs
DATA_RISK=NONE (additive nullable column; zero backfill; no UPDATE)
SECURITY_RISK=NONE (no grant or policy change; table remains service_role-only)
EXPECTED_LOCK_RISK=ACCESS EXCLUSIVE on deletion_requests for the ADD COLUMN and
         index build. 9 rows, no rewrite (nullable, no default) — milliseconds.
PHASE=1
```

```
ID=AD-DB-003
TYPE=SCHEMA_DDL (read-only function + grants)
MIGRATION_VERSION=20260916130553
MIGRATION_NAME=build33_orphan_owner_media_reconciliation_rpc
OBJECTS_AFFECTED=
  FUNCTION public.list_orphan_owner_media(p_bucket text, p_limit integer DEFAULT 100, p_after text DEFAULT null)
    RETURNS TABLE (object_name text, size_bytes bigint, owner_prefix text, created_at timestamptz)
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
  REVOKE EXECUTE FROM public, anon, authenticated
  GRANT EXECUTE TO service_role
CURRENT_PRODUCTION_STATE=absent. (The one %orphan% match in production is the
  unrelated, pre-existing reconcile_orphaned_purging_requests — do not confuse them.)
TARGET_BUILD34_STATE=present, service_role-only EXECUTE, search_path pinned
GOVERNED_SOURCE=supabase/migrations/20260916130553_build33_orphan_owner_media_reconciliation_rpc.sql @13a7844
DEPENDENCIES=storage.objects, auth.users, public.dressing_room_items (all present).
  Explicitly NOT dependent on AD-DB-001's table.
PRECONDITION_SQL=
  SELECT count(*)=0 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='list_orphan_owner_media';
  SELECT count(*)=7 AS ok FROM storage.objects o WHERE o.owner IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id=o.owner);   -- baseline to compare after
MUTATION_SOURCE_SQL=the governed file, verbatim
VALIDATION_SQL=
  SELECT p.prosecdef AND array_to_string(p.proconfig,',') LIKE '%search_path%'
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='list_orphan_owner_media';
  SELECT NOT has_function_privilege('anon', p.oid,'EXECUTE')
     AND NOT has_function_privilege('authenticated', p.oid,'EXECUTE') FROM pg_proc p ... ;
  -- read-only exercise (deletes nothing, service_role):
  SELECT count(*) FROM public.list_orphan_owner_media('style-library-images', 100, null);  -- expect 7
  SELECT count(*)=53 FROM storage.objects WHERE bucket_id='style-library-images';          -- unchanged
  + §7
ROLLBACK=DROP FUNCTION public.list_orphan_owner_media(text,integer,text)
FORWARD_FIX_OPTION=CREATE OR REPLACE via a new governed migration
CONTAINMENT=function only READS; it has no DELETE by construction; bucket-allowlisted
  (raises 22023 on a non-allowlisted bucket); never returns an object whose owner
  still resolves to a live auth.users row
DATA_RISK=NONE
SECURITY_RISK=NONE. SECURITY DEFINER is required to read storage.objects/auth.users,
  and is contained by the pinned search_path plus service_role-only EXECUTE.
  Preserves PUBLIC_EXECUTE=0 and UNPINNED_SECURITY_DEFINER_SEARCH_PATH=0.
EXPECTED_LOCK_RISK=NONE (function creation only)
PHASE=1
```

```
ID=AD-DB-004
TYPE=SCHEMA_DDL (6 partial/plain indexes)
MIGRATION_VERSION=20260917163000
MIGRATION_NAME=b34_fk_delete_path_indexes
OBJECTS_AFFECTED=
  style_chat_messages_source_message_idx              ON public.style_chat_messages (source_message_id) WHERE source_message_id IS NOT NULL
  elise_generation_operations_source_message_idx      ON public.elise_generation_operations (source_message_id) WHERE source_message_id IS NOT NULL
  elise_generation_operations_session_idx             ON public.elise_generation_operations (session_id)          -- NOT partial
  dressing_room_messages_parent_message_idx           ON public.dressing_room_messages (parent_message_id) WHERE parent_message_id IS NOT NULL
  look_items_source_dressing_room_item_idx            ON public.look_items (source_dressing_room_item_id) WHERE source_dressing_room_item_id IS NOT NULL
  outfit_decision_option_items_source_saved_scan_idx  ON public.outfit_decision_option_items (source_saved_scan_id) WHERE source_saved_scan_id IS NOT NULL
CURRENT_PRODUCTION_STATE=all 6 absent; all 6 table+column preconditions verified OK
TARGET_BUILD34_STATE=all 6 present
GOVERNED_SOURCE=supabase/migrations/20260917163000_b34_fk_delete_path_indexes.sql @13a7844
DEPENDENCIES=the 5 parent tables (present). None on AD-DB-001/002/003.
PRECONDITION_SQL=
  SELECT count(*)=0 AS ok FROM pg_indexes WHERE schemaname='public' AND indexname IN (the 6);
  -- migration-day row check (exact, taken 2026-09-19):
  -- style_chat_messages 1021, elise_generation_operations 82, dressing_room_messages 4,
  -- look_items 0, outfit_decision_option_items 0
MUTATION_SOURCE_SQL=the governed file, verbatim
VALIDATION_SQL=
  SELECT count(*)=6 FROM pg_indexes WHERE schemaname='public' AND indexname IN (the 6);
  -- no table, column, policy, grant or function changed:
  SELECT count(*)=55 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind='r';        -- (56 after AD-DB-001)
  + §7
ROLLBACK=DROP INDEX (each of the 6). Pure performance objects — dropping is
  always safe and loses no data. This is the one mutation where rollback is
  strictly preferable to forward-fix.
FORWARD_FIX_OPTION=not needed
CONTAINMENT=plain CREATE INDEX (migrations run in a transaction) briefly blocks
  writes to each table
DATA_RISK=NONE
SECURITY_RISK=NONE
EXPECTED_LOCK_RISK=LOW. Largest table is 1021 rows; two are empty. Build time is
  milliseconds per index. Contrast: this migration exists precisely because the
  UNINDEXED state is the performance risk on the delete path.
PHASE=1
```

---

## 6. EDGE FUNCTION MUTATIONS — ORDERED

```
ID=AD-FN-001
FUNCTION=process-account-deletions
CURRENT_PRODUCTION_VERSION=25 (ACTIVE, updated 2026-08-16T02:13:15Z)
CURRENT_PRODUCTION_HASH_OR_SOURCE_IDENTITY=ezbr_sha256 a2c20c459d8cbc08a0bacb04f4bc088a747e1f9a3b4846905cd61e58a0eab2a3;
  entrypoint process-account-deletions/index.ts; bundles a COMPACTED
  _shared/deletion/common.ts (~30 dense lines) and calls none of the 3
  retained-media RPCs
GOVERNED_BUILD34_HASH_OR_SOURCE_IDENTITY=index.ts 1031 lines;
  sha256(index.ts) 95be6971020864d6ca814a83126fed52640fc07ef03662e094c1bedc7b09115c;
  governed _shared/deletion/common.ts is 528 lines
HASH_MATCH=NO (decisive: the deployed bundle references none of
  record_retained_owner_media / claim_retained_owner_media_for_sweep / settle_retained_owner_media)
VERIFY_JWT_CURRENT=false   VERIFY_JWT_TARGET=false
DATABASE_DEPENDENCIES=10 RPCs. Present already: append_deletion_state_transition,
  claim_deletion_requests_for_purge, heartbeat_deletion_request_lease,
  list_deletion_purge_candidates, mark_deletion_request_purged,
  reconcile_orphaned_purging_requests, schedule_deletion_retry_or_fail
  (+ revoke_user_sessions via common.ts).
  MISSING until AD-DB-001: claim_retained_owner_media_for_sweep,
  record_retained_owner_media, settle_retained_owner_media
  (+ TABLE deleted_owner_retained_media).
SECRET_DEPENDENCIES=ACCOUNT_DELETION_WORKER_SECRET (blocking);
  DELETION_WORKER_DRY_RUN, ACCOUNT_RESTORATION_BASE_URL,
  KSCAN_EMAIL_* (non-blocking); REVENUECAT_* (live purge only, out of scope)
ACTION=DEPLOY_UPDATE
DEPLOY_ORDER=1 (after AD-DB-001; HARD gate)
POST_DEPLOY_VALIDATION=verify_jwt still false; app_config worker_enabled=false and
  worker_dry_run=true re-read AFTER deploy; deletion_requests count still 9;
  deleted_owner_retained_media still 0 rows; NO invocation in this migration
ROLLBACK_BUNDLE_AVAILABLE=**NO — see G2.** No commit on any fetched ref carries
  the compacted common.ts that v25 bundles (2 commits touch that file; neither
  matches), so v25 is not reproducible from git.
ROLLBACK_METHOD=rollback-production-function.mjs REFUSES when prior_version is
  present ("production rollback does not redeploy from the current tree ...
  prior source is unavailable for exact redeploy"). Therefore the v25 bundle MUST
  be captured to an artifact before deploying (see G2 mitigation), and rollback
  is a deliberate owner-approved redeploy from that artifact.
CONTAINMENT=deploying does NOT authorise activation. Worker stays
  enabled=false / dry_run=true. Kill switch remains app_config.
```

```
ID=AD-FN-002
FUNCTION=handle-user-deletion
CURRENT_PRODUCTION_VERSION=84 (ACTIVE, updated 2026-07-23T02:16:55Z)
CURRENT_PRODUCTION_HASH_OR_SOURCE_IDENTITY=ezbr_sha256 4d7a640a7982cdb3153e4a6a5b0508c34986416e5a8ae7c939d58b923aa1064e;
  single-file index.ts, no handler.ts; candidate git lineage d1bb36e
  (2026-07-22T02:01Z, last commit touching the function before deployment) —
  byte-equality UNVERIFIED
GOVERNED_BUILD34_HASH_OR_SOURCE_IDENTITY=multi-file (index.ts + handler.ts), 1594 lines;
  sha256(concat) 6afb56d1536b2b0d735b38584ae5647b226c406cea7331a38e6dde9e8dc720c6;
  handler.ts introduced 2026-09-08 (5cd3f72) — i.e. after deployment
HASH_MATCH=NO (structural: handler.ts did not exist when v84 was deployed)
VERIFY_JWT_CURRENT=true    VERIFY_JWT_TARGET=true
DATABASE_DEPENDENCIES=no rpc() calls; writes deletion_requests via REST.
  SOFT dep on AD-DB-002: handler.ts degrades explicitly when
  status_receipt_hash is absent ("treats a missing column as no receipt
  binding rather than an error") and also handles the uidx conflict by name.
SECRET_DEPENDENCIES=ACCOUNT_RESTORATION_BASE_URL, KSCAN_EMAIL_* (all non-blocking)
ACTION=DEPLOY_UPDATE
DEPLOY_ORDER=2 (after AD-DB-002; soft gate — deploy after anyway so the
  capability works on first request)
POST_DEPLOY_VALIDATION=verify_jwt still true; deletion_requests count still 9 and
  state distribution still 8/1; no new row created by validation
ROLLBACK_BUNDLE_AVAILABLE=PARTIAL — candidate commit d1bb36e exists but has not
  been proven byte-identical to v84
ROLLBACK_METHOD=capture the live v84 bundle to an artifact before deploying
  (same mitigation as G2); otherwise check out d1bb36e and redeploy, accepting
  that equivalence is unproven
CONTAINMENT=intake path only — it creates deletion requests, purges nothing
```

```
ID=AD-FN-003
FUNCTION=deletion-status
CURRENT_PRODUCTION_VERSION=NOT_DEPLOYED (deployed nowhere except staging)
CURRENT_PRODUCTION_HASH_OR_SOURCE_IDENTITY=n/a
GOVERNED_BUILD34_HASH_OR_SOURCE_IDENTITY=index.ts + config.toml, 279 lines;
  sha256(concat) a00f50f177bcde8574f7ee7e6f32ebc9113cc981c6a95388d6989323e9f24785
HASH_MATCH=N/A (new)
VERIFY_JWT_CURRENT=n/a     VERIFY_JWT_TARGET=false
DATABASE_DEPENDENCIES=no RPC. Reads public.deletion_requests filtered solely by
  status_receipt_hash=eq.<hash>. HARD dep on AD-DB-002.
SECRET_DEPENDENCIES=SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY only (lightest gate)
ACTION=DEPLOY_NEW
DEPLOY_ORDER=3 (after AD-DB-002)
POST_DEPLOY_VALIDATION=verify_jwt=false; unknown/absent receipt ⇒ no row disclosed;
  all 9 existing rows unreachable (status_receipt_hash NULL); no row mutated
ROLLBACK_BUNDLE_AVAILABLE=YES (no prior version to preserve)
ROLLBACK_METHOD=rollback-production-function.mjs deletes the new slug
  (strategy remove_or_disable_new_function) — clean, complete revert
CONTAINMENT=read-only status lookup; resolves at most one lifecycle row; grants
  no restoration, deletion or account access; fails closed to 'pending' on any
  unrecognised status
```

```
ID=AD-FN-004
FUNCTION=reconcile-orphan-media
CURRENT_PRODUCTION_VERSION=NOT_DEPLOYED
CURRENT_PRODUCTION_HASH_OR_SOURCE_IDENTITY=n/a
GOVERNED_BUILD34_HASH_OR_SOURCE_IDENTITY=index.ts + config.toml, 267 lines;
  sha256(concat) 7cf0071fae03c22542cd7f4c3be937aa181a615b0550b2d328deee5161225a49
HASH_MATCH=N/A (new)
VERIFY_JWT_CURRENT=n/a     VERIFY_JWT_TARGET=false
DATABASE_DEPENDENCIES=public.list_orphan_owner_media — HARD dep on AD-DB-003
SECRET_DEPENDENCIES=ORPHAN_MEDIA_SWEEP_SECRET (blocking, fail-closed);
  ORPHAN_MEDIA_SWEEP_DRY_RUN must be "true" (blocking for posture)
ACTION=DEPLOY_NEW
DEPLOY_ORDER=4 (after AD-DB-003 and the secret gate)
POST_DEPLOY_VALIDATION=verify_jwt=false; NO schedule and NO workflow invoker
  created on production; storage.objects in style-library-images still 53;
  orphan count still 7; nothing deleted
ROLLBACK_BUNDLE_AVAILABLE=YES (first deployment on this project)
ROLLBACK_METHOD=delete the slug
CONTAINMENT=EXECUTION_MODE=DRY_RUN_ONLY, DELETION_ENABLED=NO, SCHEDULING=DISABLED.
  Destructive orphan cleanup is NOT activated. The staging counterpart workflow
  is dry-run-only and explicitly denies production; no production analogue is
  created here.
```

```
ID=AD-FN-005 / AD-FN-006
FUNCTION=restore-account (v23) / resend-restoration-email (v23)
ACTION=KEEP_CURRENT — no new evidence requires deployment
```
Re-tested this pass. `restore-account`'s governed `index.ts` has an **identical
import list** and every behavioural marker of the deployed bundle
(`restored_pending_unban`, `restoration_unban_attempt_failed`,
`buildRestorationUrl`, `sendRestorationEmail`); the only difference found is
CRLF vs LF. Both functions import from `_shared/deletion/common.ts`, whose sole
post-deployment change (`fbbb3d5`, 2026-08-31) adds `AuthUser.isAnonymous` and
`isEligibleAccountActor` and touches `requireUser` — and **neither function
imports any of those symbols** (verified by grep). The change is therefore
behaviourally inert for both. `verify_jwt` already matches target (`false`/`false`).
Deploying would spend production risk for no Build 34 behaviour.
`HASH_MATCH=INDETERMINATE` (semantically equivalent, bytes differ).

---

### MANDATORY DEPENDENCY RULE

```
PROCESS_ACCOUNT_DELETIONS_SCHEMA_READY_BEFORE_DEPLOY=NO (today) / YES (after AD-DB-001)
HANDLE_USER_DELETION_SCHEMA_READY=YES today (degrades gracefully); prefer after AD-DB-002
DELETION_STATUS_SCHEMA_READY=NO (today) / YES (after AD-DB-002)
RECONCILE_ORPHAN_MEDIA_SCHEMA_READY=NO (today) / YES (after AD-DB-003)
```

Enumerated missing objects that `process-account-deletions` would call today:
`public.claim_retained_owner_media_for_sweep(int)`,
`public.record_retained_owner_media(uuid,text,text,integer)`,
`public.settle_retained_owner_media(text,text,integer)`, and
`public.deleted_owner_retained_media`. **All four arrive with AD-DB-001 and only
with AD-DB-001.** Deploying M5 first would leave the worker calling three
nonexistent RPCs.

---

## 7. VALIDATION GATES

**Universal gate — must PASS after every single mutation, DB or function:**

```sql
-- 1. ledger grew by exactly the one intended version (DB mutations only)
SELECT count(*) FROM supabase_migrations.schema_migrations;             -- 95 +N
-- 2. deletion ledger rows preserved, distribution unchanged
SELECT count(*) FROM public.deletion_requests;                         -- 9
SELECT status, count(*) FROM public.deletion_requests GROUP BY status;  -- deactivated 8, restored 1
SELECT count(*) FROM public.deletion_requests WHERE user_id IS NULL;   -- 8
-- 3. worker posture preserved
SELECT key, value->>'enabled' FROM public.app_config
 WHERE key IN ('account_deletion_worker_enabled','account_deletion_worker_dry_run');
                                                                       -- false, true
-- 4. no new orphan FK violations
SELECT count(*) FROM public.deletion_requests d WHERE d.user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id=d.user_id);    -- 0
-- 5. security invariants
SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prosecdef
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) c WHERE c LIKE 'search_path=%');  -- 0
SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prorettype='trigger'::regtype
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) c WHERE c LIKE 'search_path=%');  -- 0
SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity;  -- 0
-- PUBLIC_EXECUTE must remain 0
-- 6. deletion tables keep the service-role-only posture (0 policies, 0 client grants)
SELECT c.relname, (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid) AS policies
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN
  ('deletion_requests','deletion_state_transitions','deleted_owner_retained_media');  -- all 0
-- 7. orphan media baseline unchanged (nothing deleted)
SELECT count(*) FROM storage.objects WHERE bucket_id='style-library-images';  -- 53
SELECT count(*) FROM storage.objects o WHERE o.owner IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id=o.owner);      -- 7
```

Plus, after every mutation: **`get_advisors(type='security')` must introduce no
new ERROR/CRITICAL finding.** The pre-existing `rls_enabled_no_policy` **INFO**
on 7 tables is expected and must NOT be "fixed"; after AD-DB-001 it becomes 8
tables, because `deleted_owner_retained_media` is intentionally RLS-on/no-policy.
**That eighth INFO finding is a PASS, not a regression.**

Per-mutation PASS requirements are the `VALIDATION_SQL` blocks in §5 and the
`POST_DEPLOY_VALIDATION` lines in §6, in addition to this universal gate.

### FUNCTION SMOKE PLAN — prepared, NOT run

None of these may run in this pass, and none may use a real customer deletion
request for destructive testing. All are synthetic or read-only.

| # | check | method | expected | mutating? |
|---|---|---|---|---|
| 1 | worker auth: missing secret header | POST with no `x-deletion-worker-secret` / bearer | 401, log `worker_auth_rejected` | no |
| 2 | worker auth: wrong secret | POST with a deliberately wrong value | 401, constant-time compare, no detail leaked | no |
| 3 | worker auth: anon key rejected | POST presenting the anon key as the secret | 401 (explicitly rejected in `requireWorkerAuth`) | no |
| 4 | worker secret unconfigured | only if the secret is absent | 503 "Worker secret not configured" | no |
| 5 | worker disabled posture | authorised POST while `enabled=false` | `mode:"dry_run"`, `killSwitchEnabled:false`, log `kill_switch_skip`, `"No claims, Auth deletions, or Storage deletions were performed."` | no |
| 6 | dry-run enumeration | same call, inspect `summary.byEligibility` | plans returned, `wouldClaim:false` throughout | no |
| 7 | missing-user residue | in #6's output, the 8 NULL-`user_id` rows | each `eligibility:"skipped_missing_user"`, `wouldClaim:false`, empty tree/storage | no |
| 8 | retained-media ledger | `SELECT count(*) FROM public.deleted_owner_retained_media` after #6 | 0 — dry run enqueues nothing | no |
| 9 | deletion-status: unknown receipt | POST a random 32+ byte receipt | no row disclosed; generic response | no |
| 10 | deletion-status: legacy row unreachable | any existing row (all have NULL hash) | never resolvable; no row leaked | no |
| 11 | deletion request creation | **synthetic account only**, created for the test and torn down by the same test | row created with `status_receipt_hash` populated; count returns to 9 afterwards | yes — synthetic only, requires its own authorisation |
| 12 | restoration-token behaviour | synthetic row from #11 | token single-use; second use rejected; expiry honoured | yes — synthetic only |
| 13 | orphan-media dry run | authorised POST with `ORPHAN_MEDIA_SWEEP_DRY_RUN=true` | `mode=dry_run`, `dryRun=true`, reports 7 objects / 4 owners, **zero removals**; a non-dry-run response is a hard failure | no |

Checks 11 and 12 are the only mutating ones; they need a synthetic account and a
separate authorisation, and are **not** part of the migration gate.

---

## 8. ROLLBACK / CONTAINMENT

| ID | preferred strategy | why |
|---|---|---|
| AD-DB-001 | **rollback while empty** (drop 3 functions, then table) → **forward-fix once M5 is live** | dropping after the worker has enqueued a prefix would discard the record of media awaiting sweep |
| AD-DB-002 | **rollback before M6/M7** (drop index, drop column) → **forward-fix after** | after M6, a client may hold a receipt whose hash lives here; dropping silently voids that capability |
| AD-DB-003 | **rollback** (drop function) | read-only function, nothing depends on its persistence |
| AD-DB-004 | **rollback** (drop the 6 indexes) | pure performance objects; no data implication either way |
| AD-FN-001 | **pre-captured bundle redeploy** (see G2) | the governed rollback script refuses, and git cannot reproduce v25 |
| AD-FN-002 | **pre-captured bundle redeploy**; d1bb36e as unproven fallback | same refusal path; lineage plausible but unverified |
| AD-FN-003 / AD-FN-004 | **delete the slug** | first deployment on this project; a clean and complete revert |

Never used as rollback, per policy and confirmed against the tooling: restoring
staging data; deleting production customer records; resetting
`deletion_requests`; rewriting migration history; weakening RLS; widening
grants. `scripts/lib/staging-constants.mjs` additionally hard-blocks
`DROP DATABASE`, `DROP SCHEMA`, `TRUNCATE` and `db reset` as prohibited SQL
patterns, and `apply-production-migration.mjs` never uses `db push`, `db reset`
or `migration up`.

---

## 9. BLOCKERS

### G1 — HARD BLOCKER: the governed production applier refuses all four migrations

`config/migration-authority-manifest.json` declares
`ledgerReconciliation.environments` for **staging only**
(`yzqjvdfgefveprobvvyw`: 32 reconciled, 1 remoteOnly). There is **no entry for
`wyyuqfdxucjksghsmhry`**, so `loadLedgerReconciliation('wyyuqfdxucjksghsmhry')`
returns empty.

Executing the governed code against the live production ledger:

```
local migration files        : 172
production ledger rows       : 95
prod reconciliation entries  : reconciled=0, remoteOnly=0
PENDING (localOnly)          : 100      <-- all 4 APPLY migrations are among them
REMOTE_ONLY (unexplained)    : 23
```

Both gates fail:

- `compareMigrations` sets `ok=false` on `remoteOnly.length > 0` **and** on
  `pending.length > 1` → `production-deploy-preflight.mjs` exits 1.
- `apply-production-migration.mjs:138-143` independently computes
  `pendingVersions()` (which consults only `reconciled`, not
  `genuinelyUnapplied`) and fails unless `pending.length === 1`.

So **no account-deletion migration can be applied through the governed pipeline
in its current state.** This is a governance/manifest gap, not a schema defect —
the schema analysis in §5 stands unchanged.

Note that populating `reconciled` for the ~96 already-satisfied local versions is
necessary but **not sufficient**: four would still be pending, and the gate wants
one. Honest options, for the owner — none may be taken in this pass:

- **(a)** Add the production `ledgerReconciliation` block *and* extend the
  tooling so a named `APPROVED_MIGRATION_VERSION` may be applied while other
  migrations remain pending (`pending.includes(version)` instead of
  `pending.length === 1`). A governed-source change with its own review/tests.
  **Recommended** — it fixes the general case and keeps one-at-a-time approval.
- **(b)** Apply the four under explicit owner authorisation outside
  `apply-production-migration.mjs`, recording each in `schema_migrations`, then
  backfill the production reconciliation block. Faster, but bypasses the
  governed gate — it should be a written, time-boxed exception.
- **(c)** Reconcile production's ledger fully first (a larger project covering
  all 100 pending and 23 remote-only versions), then apply normally. Safest and
  slowest; it also resolves the 23 remote-only findings permanently.

`genuinelyUnapplied` exists in the manifest schema but is **not** consulted by
`pendingVersions()`, so it cannot be used to shrink `pending`. Do not rely on it.

### G2 — BLOCKER for AD-FN-001: no exact rollback bundle exists

`rollback-production-function.mjs:89-97` refuses when `prior_version` is present
and the prior source is unavailable. No commit on any fetched ref carries the
compacted `_shared/deletion/common.ts` that `process-account-deletions` v25
bundles (only 2 commits touch that file; neither matches), so v25 cannot be
reproduced from git.

**Mitigation (mandatory precondition, not itself a mutation):** before deploying
AD-FN-001 or AD-FN-002, capture each function's live bundle source via the
Management API (`get_edge_function`) into
`artifacts/production-deployments/pre-b34/` and record its `ezbr_sha256`. Rollback
then becomes a deliberate redeploy from that artifact. Add this as gate **AD-PRE-001**.

### G3 — Open, unverifiable from this session
GitHub `production` Environment existence and required reviewers; production
variables/secrets presence; backup and PITR availability. Exact manual checks are
listed in §2. Do not treat any of them as PASS without that check.

### G4 — Secret gates
`ACCOUNT_DELETION_WORKER_SECRET` (AD-FN-001), `ORPHAN_MEDIA_SWEEP_SECRET` and
`ORPHAN_MEDIA_SWEEP_DRY_RUN="true"` (AD-FN-004) are blocking and unverifiable
here. AD-DB-001..004 and AD-FN-002/003 need no secret beyond the platform pair.

### Resolved this pass
- **B1 (Phase 0) — CLOSED.** `approvedProjectRef` is intentionally staging;
  production is independently and more strictly governed. No change required.
- **D1 (Phase 0) — not a blocker.** Residue is preserved and cannot be processed;
  see §3.

---

## 10. FIRST PRODUCTION WRITE

```
FIRST_WRITE_ID=AD-DB-001
FIRST_WRITE_MIGRATION=20260831140000_deleted_owner_retained_media
```

**WHY_FIRST**
It is the only mutation that is simultaneously (a) a hard prerequisite for
another step — `process-account-deletions` calls three RPCs that exist nowhere
else, so nothing about M5 can proceed without it; (b) entirely self-contained —
it creates one new empty table and three new functions and reads no existing row,
so its blast radius is bounded by objects that did not exist a moment earlier;
and (c) fully reversible at this instant, because the table is empty and no
deployed function references it yet — a property it **loses** the moment
AD-FN-001 ships. AD-DB-002 by contrast touches the live `deletion_requests`
table, and AD-DB-003/004 unblock nothing that is otherwise waiting. First write
should be the one with the highest dependency value and the lowest, and most
temporary, rollback cost.

**PRECONDITIONS** (all must hold, in order)
1. `BACKEND_AUTHORITY_CHANGED=NO`; execution checkout is exactly `13a7844` and
   that is still the branch tip (`assertGovernedCommit` enforces this).
2. **G1 resolved** by an explicit owner decision between options (a)/(b)/(c).
   Without this the applier refuses — this is the gating precondition.
3. **G3 resolved manually**: GitHub `production` Environment exists with required
   reviewers; the four production variables/secrets present; backup/PITR
   confirmed with a known-good recent restore point.
4. Worker posture re-read immediately before: `account_deletion_worker_enabled=false`,
   `account_deletion_worker_dry_run=true`.
5. `PRECONDITION_SQL` for AD-DB-001 (§5) returns `ok` on every row — table and
   all three functions absent, `deletion_requests` count 9.
6. `ALLOW_DESTRUCTIVE_MIGRATION` **not** set: the governed prohibited-pattern
   scan must pass on its own (the file contains no DROP/TRUNCATE of an existing object).
7. Deploy runs via `production-controlled-deploy.yml` with
   `confirm_production = "DEPLOY TO PRODUCTION"` and human approval at the
   `environment: production` gate.

**VALIDATION** — the AD-DB-001 `VALIDATION_SQL` block plus the §7 universal gate.
Specifically: table present, RLS enabled, **0** policies, **0** anon/authenticated/
PUBLIC grants, all three functions present with `search_path` pinned and
`service_role`-only EXECUTE, new table empty, `deletion_requests` still 9 rows at
8 `deactivated` / 1 `restored`, worker flags still `false`/`true`,
`PUBLIC_EXECUTE=0`, `UNPINNED_SECURITY_DEFINER_SEARCH_PATH=0`, all public tables
RLS-enabled (now 56 tables), ledger at 96, and no new ERROR/CRITICAL advisor
finding — with the **expected** new `rls_enabled_no_policy` INFO on
`deleted_owner_retained_media` counted as a PASS.

**ROLLBACK**
While the table is still empty and AD-FN-001 has not shipped:
`DROP FUNCTION public.settle_retained_owner_media(text,text,integer);`
`DROP FUNCTION public.claim_retained_owner_media_for_sweep(int);`
`DROP FUNCTION public.record_retained_owner_media(uuid,text,text,integer);`
`DROP TABLE public.deleted_owner_retained_media;` (child first, then parent — the
FK points *at* `deletion_requests`, which is never touched), and remove the
`20260831140000` row from `schema_migrations` only if the SQL apply itself failed
midway. After AD-FN-001 ships, switch to FORWARD_FIX: a defect is corrected by a
new governed migration, never by dropping a table the worker may have written to.

---

## 11. FINAL STATUS

```
ACCOUNT_DELETION_EXECUTION_MANIFEST=BLOCKED
PRODUCTION_MUTATED=NO
```

The **schema and function reconciliation is complete and execution-ready**: four
mutually independent, additive database mutations with proven dependency order,
exact object lists, preconditions, validation and rollback; four Edge Function
actions with an enforced dependency order; two functions correctly left alone;
and historical residue proven harmless at both the database and Edge layers.

It is **BLOCKED**, not ready, on **G1**: the governed production applier refuses
every one of the four migrations because the migration-authority manifest has no
`ledgerReconciliation` entry for production, leaving 100 pending and 23
remote-only versions where the tooling demands exactly one and zero. That needs
an owner decision between the three options in §9 before any first write. **G2**
additionally requires the pre-deployment bundle capture (AD-PRE-001) before
AD-FN-001, and **G3/G4** require manual verification that this session cannot
perform.

Phase 0's B1 is **closed, not escalated**: production deployment authority is
valid, and the authority file should be left exactly as it is.

No production mutation is authorised by this document.
