# K Scan AI — KS-REL-005B saved_scans Trigger Migration Patch Report

**Patch branch:** `feature/saved-scans-trigger-migration-fix-v1`
**Date:** 2026-06-17
**Patch engineer:** Kimi Work Release Agent
**Base:** `feature/supabase-rls-verification-v1` (contains KS-REL-005A HOLD report)
**Defect found during:** KS-REL-005A Supabase Migration and RLS Verification

---

## 1. Branch / Commit

| Field | Value |
|-------|-------|
| **Current branch** | `feature/saved-scans-trigger-migration-fix-v1` |
| **Base branch** | `feature/supabase-rls-verification-v1` |
| **Commit** | `8ace8ef` docs(qa): add Supabase migration and RLS verification (HOLD) |
| **Working tree** | Modified: `supabase/migrations/20260617215307_create_saved_scans.sql`; Untracked: generated Android artifacts only |

---

## 2. Defect

| Field | Value |
|-------|-------|
| **Original issue** | `updated_at` trigger was only created if `moddatetime` extension was pre-installed. The migration used invalid `CREATE TRIGGER IF NOT EXISTS` inside a conditional `DO $$` block. |
| **Risk** | If `moddatetime` is not installed, no trigger exists. `updated_at` column will never auto-update on row changes, breaking timestamp semantics for saved scans. |
| **Where found** | `supabase/migrations/20260617215307_create_saved_scans.sql` lines 58–72 |
| **Severity** | **Blocker for migration reliability** — triggers must be deterministic and not depend on extension availability. |

---

## 3. Migration Patch

| Field | Value |
|-------|-------|
| **File** | `supabase/migrations/20260617215307_create_saved_scans.sql` |
| **Full-file inventory preserved** | ✅ Yes — all columns, constraints, indexes, RLS, policies, grants, and comment remain unchanged. |
| **updated_at default** | ✅ `updated_at timestamptz not null default now()` — already present and unchanged. |
| **Old behavior** | Conditional trigger creation inside `DO $$` block. Only created if `moddatetime` extension was pre-installed. Used invalid `CREATE TRIGGER IF NOT EXISTS`. Promised fallback function was never defined. |
| **New behavior** | Deterministic PL/pgSQL trigger function `public.set_saved_scans_updated_at()` always created. Trigger always created after table definition. No extension dependency. |
| **moddatetime dependency** | ❌ Removed — no dependency on `moddatetime` or any extension. |
| **CREATE TRIGGER IF NOT EXISTS** | ❌ Removed — replaced with `DROP TRIGGER IF EXISTS` followed by plain `CREATE TRIGGER`. |
| **Fallback trigger function** | ✅ `public.set_saved_scans_updated_at()` — defined inline, self-contained, no external dependencies. |
| **Security mode** | `security invoker` — function runs with the caller's privileges, not definer. |
| **search_path** | `set search_path = public` — prevents search path injection. |

### Trigger function

```sql
create or replace function public.set_saved_scans_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
```

### Trigger creation

```sql
-- Drop old trigger if it exists from a previous version of this migration.
drop trigger if exists update_saved_scans_updated_at on public.saved_scans;

-- Create trigger using the PL/pgSQL function.
create trigger saved_scans_set_updated_at
before update on public.saved_scans
for each row
execute function public.set_saved_scans_updated_at();
```

---

## 4. Validation

| Check | Result |
|-------|--------|
| **Residual old syntax scan** | 1 match in comment `"No dependency on moddatetime extension"` — acceptable documentation. No executable `moddatetime` or `CREATE TRIGGER IF NOT EXISTS` remains. |
| **Destructive SQL scan** | 3 matches: `DROP POLICY IF EXISTS` x 3 (safe idempotent pattern, already in original migration). No `DROP TABLE`, `TRUNCATE`, `DISABLE RLS`, `DROP COLUMN`, or `ALTER TABLE ... DROP` found. |
| **Function safety scan** | `create or replace function` ✅, `security invoker` ✅, `security definer` ❌ 0, `set search_path = public` ✅, `language plpgsql` ✅, `return new` ✅ |
| **Trigger scan** | `drop trigger if exists` ✅, `create trigger saved_scans_set_updated_at` ✅, `before update on public.saved_scans` ✅, `execute function public.set_saved_scans_updated_at` ✅ |
| **updated_at default scan** | `updated_at timestamptz not null default now()` ✅ |
| **Local SQL validation** | Not performed — Supabase CLI not available locally. Static SQL patch validation completed. |
| **Seed/config impact** | No `seed.sql` or `config.toml` found in this project. No impact. |
| **No-secrets scan** | No secrets in migration file. Existing QA docs contain only references to `service_role` (documented as server-side only) and `anon` key (documented as client-safe). No hardcoded credentials. |
| **TypeScript** | No TypeScript changes in this patch. |
| **Tests** | No test changes in this patch. Existing tests 249/252 pass. |

---

## 5. Files Changed

| File | Status | Description |
|------|--------|-------------|
| `supabase/migrations/20260617215307_create_saved_scans.sql` | Modified | Replaced fragile `moddatetime` conditional trigger block with deterministic PL/pgSQL trigger function + `CREATE TRIGGER` |
| `qa/saved-scans-trigger-migration-fix-2026-06-17.md` | New | This patch report |

---

## 6. Feature Flag State

| Flag | Value | Changed? |
|------|-------|----------|
| `CLOUD_SAVED_SCANS_ENABLED` | `false` | No |
| `TEXTSCAN_BACKEND_ENABLED` | `false` | No |
| `TEXTSCAN_UI_ENABLED` | `false` | No |
| `TEXTSCAN_DEMO_RESULTS_ENABLED` | `false` | No |
| `SCAN_RESULTS_V2_UI_ENABLED` | `false` | No |
| `SCAN_ROOM_V2_UI_ENABLED` | `false` | No |
| `HOME_NAVIGATION_V2_ENABLED` | `false` | No |
| `ONBOARDING_FRAMEWORK_V1_ENABLED` | `false` | No |

**No feature flags changed.**

---

## 7. Environment Safety

| Check | Result |
|-------|--------|
| **Production touched** | ❌ No — no remote database connection made |
| **Staging touched** | ❌ No — no staging database exists yet |
| **Migrations applied** | ❌ No — no `supabase db push` or remote apply performed |
| **Remote database modified** | ❌ No — patch is local file edit only |
| **Migration state before patch** | Assumed unapplied on remote (KS-REL-005A confirmed no apply occurred). Supabase CLI not available locally; local Docker state unknown. |

---

## 8. Remaining Blockers

| Blocker | Status |
|---------|--------|
| **Dedicated staging Supabase project** | Still required — none exists |
| **KS-REL-005A rerun** | Required after this patch is merged and staging exists |
| **RLS runtime verification** | Still required — must verify SELECT/INSERT/UPDATE policies with real auth tokens |
| **Cross-user isolation** | Still required — must confirm user A cannot see user B's saved_scans |
| **Trigger functional test** | Still required — verify `updated_at` changes on UPDATE in real database |
| **Local SQL validation** | Deferred — Supabase CLI not available in this environment |

---

## 9. Final Recommendation

| Decision | Status |
|----------|--------|
| **Ready to merge patch** | ✅ **Yes** — patch is deterministic, idempotent, and preserves all existing schema |
| **Ready to apply migrations** | ❌ No — requires a confirmed staging Supabase project first |
| **Hold** | Not required for the patch itself; hold was for the prior KS-REL-005A environment gap |
| **Next required prompt** | `KS-REL-005A rerun — Staging Supabase migration + RLS verification` |

### Migration delta summary

```text
1 file changed
21 insertions(+), 12 deletions(-)
0 columns changed
0 constraints removed
0 indexes removed
0 RLS policies weakened
0 grants removed
1 trigger function added (deterministic, PL/pgSQL, no extension dependency)
1 trigger added (always created, idempotent)
1 old trigger name safely dropped if exists
```

---

*Report generated by KS-REL-005B migration patch workflow — 2026-06-17*
