# Account-deletion migrations: repo vs production divergence

**Status: OPEN — owner decision required. Do not run `supabase db push` against
production from this branch until it is resolved.**

The account-deletion schema is fully applied and working in production
(`wyyuqfdxucjksghsmhry`). The migration *files* in this repo were reconciled
from `repair/account-deletion-hostile-audit-20260722` (`835ec97`), but the
versions recorded in production's `supabase_migrations.schema_migrations` do not
line up with those filenames.

## What production actually has applied

| version | name |
|---|---|
| 20260722191013 | account_deletion_lifecycle |
| 20260723021514 | account_deletion_security_hardening |
| 20260723021635 | account_deletion_device_sessions_and_revoke |
| 20260723021735 | account_deletion_claim_retry_peek_v2 |
| 20260723083904 | profiles_backfill_and_active_account_hardening |
| 20260723131202 | account_deletion_crash_recovery |
| 20260723131221 | account_deletion_rls_active_account |
| 20260723131423 | deletion_ledger_pii_sanitizer |
| 20260723132813 | harden_deletion_trigger_function_grants |

## How the repo differs

1. **Only `20260722191013_account_deletion_lifecycle.sql` matches by version.**
   Every other deletion migration in this repo carries a version production has
   never recorded, so `db push` would attempt to re-apply all of them.

2. **Three applied migrations have no file here at all:**
   `account_deletion_device_sessions_and_revoke`,
   `account_deletion_claim_retry_peek_v2`, and
   `harden_deletion_trigger_function_grants`. The repo therefore cannot
   reproduce the production schema from scratch.

3. **Same name, different content.** Production's
   `20260723021514_account_deletion_security_hardening` is a single ~121-character
   statement; the repo file of the same name is ~458 lines. They are not the
   same change, so renaming the file to match the version would assert a false
   equivalence.

4. `profiles_backfill_and_active_account_hardening` is `20260723070000` here and
   `20260723083904` in production.

## Why the files were still committed

Without them the branch has no source of record for a subsystem that is live in
production. Committing them makes the code reviewable and testable; this note
records that they are **not** a faithful migration history.

## Resolution options (owner's call)

- **Baseline/squash**: capture the current production schema as a single
  baseline migration and retire these files. Cleanest, and makes the repo
  reproducible.
- **Repair history**: extract the applied SQL from
  `supabase_migrations.schema_migrations.statements` for the nine versions above
  and commit them under their real versions, deleting the mismatched files.
- **Leave as-is**: acceptable only while nobody runs `db push`; the repo stays
  unable to rebuild the schema.

Verified read-only against production on 2026-07-25. No migration was applied,
re-applied, or altered during that verification.
