# Production Migration Reconciliation

Status: OPEN — `PRODUCTION_MIGRATION_RECONCILIATION_REQUIRED`.
Machine-readable companion: `security/release/production-migration-reconciliation.json`
(that file is what the release control plane actually reads; this document
explains it).

Production remains read-only. Nothing in this document has been applied to
either Supabase project, and resolving any item below is an owner decision,
not an automation step.

## Why this exists

Phase 1 discovery compared the live migration ledgers of the staging
(`yzqjvdfgefveprobvvyw`) and production (`wyyuqfdxucjksghsmhry`) projects
against the repository. Staging matches the repository exactly (103 applied,
103 files). Production reports 87 applied entries, and **four of them have no
equivalent by name anywhere on `staging/production-parity`**.

That direction matters. Staging being *ahead* of production is the normal
pending-promotion backlog (18 such migrations today) and is expected.
Production being ahead of staging means **the environment we certify against
does not reproduce the environment we would promote into** — so a release
certified on staging cannot be assumed safe against production's actual
schema.

## The ledger-naming convention (read this before comparing anything)

This project's deploy tooling **stamps its own apply-time timestamp** rather
than preserving the migration's filename timestamp. So:

| Migration | Filename timestamp | Applied ledger version |
|---|---|---|
| `add_ai_output_reporting` | `20260809133736` | `20260809152053` |
| `contribution_block_enforcement` | `20260809120000` | `20260809102805` |
| `legal_acceptances_add_ai_processing` | `20260805120000` | `20260805170417` |
| `shared_room_item_contributions` | `20260725100000` | `20260808201806` |

**Always reconcile by migration name, never by version number.** A
version-number diff of these two projects produces a badly misleading answer.
This convention is documented in the GP-004/GP-006 migration headers and is
the reason `production-migration-reconciliation.json` keys everything by name.

## A second, more serious caveat: the ledger is not fully trustworthy

`docs/security/batch0-migration-source-restoration.md` records that
production's own `supabase_migrations.schema_migrations` table contains at
least two entries whose stored `statements` are placeholders rather than the
DDL that actually ran (one literally reads `applied via lifecycle rollout`;
another is a comment plus `select 1;`).

Consequently: **a ledger entry proves that something was recorded, not that
the recorded DDL is what executed.** The Phase 1 report's phrasing has been
corrected accordingly — "87 applied entries were observed" is a true
statement about the ledger; "production is at migration level 87" would be an
overstatement of provenance. This distinction is the whole reason production
source provenance is still classified UNKNOWN.

## The four items

### 1. `add_ai_output_reporting` — source found, off-branch

- Production ledger: `20260809152053`, observed applied.
- Repository source **does exist**: `supabase/migrations/20260809133736_add_ai_output_reporting.sql`,
  added by `03ee000` (Android line) and `04070ec` (iOS line). It is simply not
  on `staging/production-parity`, because those release lines do not merge
  back into it.
- Semantic status: `PRODUCTION_ONLY_INTENTIONAL`. This was a deliberate
  direct-to-production feature ship (GP-006), not an accident.
- **Decision needed**: forward-port onto `staging/production-parity` so
  staging reproduces production, or record a permanent documented waiver.

### 2. `contribution_block_enforcement` — source found, off-branch

- Production ledger: `20260809102805`, observed applied.
- Repository source exists at
  `supabase/migrations/20260809120000_contribution_block_enforcement.sql`
  (commit `dd4487a`), which also ships a pgTAP test
  (`supabase/tests/dressing_room_contribution_blocking_test.sql`).
- Same pattern and same decision as item 1 (GP-004).

### 3. `legal_acceptances_add_ai_processing` — source found, off-branch, **filename collision hazard**

- Production ledger: `20260805170417`, observed applied.
- Repository source exists at
  `supabase/migrations/20260805120000_legal_acceptances_add_ai_processing.sql`,
  landed as mirrored iOS/Android commits (`38787ae`, `07b47fd`).
- **Hazard**: `staging/production-parity` already carries a *different*
  migration at that exact `20260805120000` prefix —
  `20260805120000_reconcile_deletion_requests_to_production_columns.sql`. A
  naive forward-port would collide. Any promotion of this item must renumber
  it first.

### 4. `shared_room_item_contributions` — **the formal promotion blocker**

This one is different in kind from the other three, and is the reason
`PRODUCTION_MIGRATION_RECONCILIATION_REQUIRED` exists as a machine-enforced
state rather than a note.

- Production ledger: `20260808201806`, observed applied.
- Repository source sits in the **deferred quarantine directory**:
  `supabase/migrations-deferred/20260725100000_shared_room_item_contributions.sql`.
- `supabase/migrations-deferred/README.md` states that this migration
  **"is not applied in production"**, and defers it *precisely because*
  production was believed to define three `dressing_room_items` RLS policies
  differently, plus lack a `created_by` column the migration adds.
- Live production state contradicts that premise: a migration of this name is
  applied there.

So the repository's own written justification for quarantining this migration
is **stale** — and, because that justification is what the quarantine rests
on, the repository currently cannot be trusted on this object without
re-verification.

Resolving it is **not** a forward-port. It requires, in order:

1. A read-only comparison of production's *current* `dressing_room_items`
   policy set and column list against what the deferred file would create.
2. A determination of whether what production applied is semantically the
   same migration or a divergent variant that happens to share a name.
3. Only then: promote the deferred file, replace it with production's actual
   applied form, or re-document the deferral on accurate grounds.

Phase 2A deliberately did not perform step 1. This is a control-plane phase,
and step 1 is a production schema audit — it needs its own scoped,
owner-authorized pass.

## Effect on releases (what the control plane actually enforces)

While `overallStatus` is `PRODUCTION_MIGRATION_RECONCILIATION_REQUIRED`:

- **Staging manifests can still be created and frozen.** Staging work is not
  blocked by this, and Phase 2A's tests assert that explicitly.
- **Production promotion eligibility returns BLOCKED**, with blocker code
  `PRODUCTION_MIGRATION_RECONCILIATION_REQUIRED`, from
  `security/release/production-eligibility.js`.

`overallStatus` may only become `RESOLVED` when every record reaches a settled
semantic status *and* a settled provenance status, with any waiver recorded in
this document. **No automation may set `RESOLVED`** — it is an owner decision,
by construction.

## What was NOT done

- No migration was applied, promoted, renumbered, moved out of
  `migrations-deferred/`, or edited.
- No production SQL was executed and no production data was inspected.
- No item above was marked resolved. Every one carries an explicit
  `requiredDecision`.
