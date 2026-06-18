# K Scan AI — KS-REL-005D Supabase Staging Migration + RLS Verification

**Date:** 2026-06-18
**Engineer role:** Supabase Release Verification Engineer
**Status:** **HOLD — no confirmed non-production staging project exists**

---

## 1. Branch / Environment

| Item | Value |
|------|-------|
| Current branch | `feature/supabase-staging-verification-v1` |
| Base branch | `feature/release-integration-v2-backend-stack-v1` |
| Release foundation HEAD | `77e14f8 docs(qa): add saved_scans trigger patch merge report` |
| Trigger patch present | ✅ `3cd2656 fix(db): harden saved_scans updated_at trigger` |
| Working tree | Clean except untracked `android/.../mipmap-*` artifacts (not staged) |
| Supabase CLI | v2.106.0 (available) |
| `.supabase/project-ref` file | Does not exist locally |
| CLI link state | API reports `yzqjvdfgefveprobvvyw` as `linked: true` (account-side; no local config dir) |
| Environment confirmed staging/dev | **NO** |
| Production avoided | **YES — nothing applied/written; no relink performed** |
| Verification method | Supabase MCP (read-only SQL + project metadata); CLI `projects list`/`--version`; local repo grep |

---

## 2. Staging Discovery

**Result: no dedicated staging/dev project found.** Exactly two Supabase projects exist (same as the prior KS-REL-005A HOLD — none created since):

| Ref | Name | Region | Role |
|-----|------|--------|------|
| `yzqjvdfgefveprobvvyw` | "K Scan Privacy Controls" | us-west-1 | App backend — **used by BOTH `preview` and `production` (store/app-bundle) EAS profiles** |
| `wyyuqfdxucjksghsmhry` | "KScan waitlist Project" | us-east-2 | Separate waitlist project; not referenced by any app config; likely holds real signup PII |

### The blocking contradiction

The linked project `yzqjvdfgefveprobvvyw` has a **conflicting environment identity**:

- **Documented as "dev project":** [docs/stylechat-v0.3.md:161](docs/stylechat-v0.3.md#L161) ("Dev project ref: `yzqjvdfgefveprobvvyw`") and [docs/stylechat-v0.2.md:27](docs/stylechat-v0.2.md#L27) ("Applied: Yes, to dev project `yzqjvdfgefveprobvvyw`"). Dev-only test accounts were reportedly created/deleted there.
- **But used as the production/store backend:** [eas.json:34-39](eas.json#L34-L39) sets `build.production.env.EXPO_PUBLIC_SUPABASE_URL = https://yzqjvdfgefveprobvvyw.supabase.co` for the `app-bundle`/store distribution. [eas.json:13-17](eas.json#L13-L17) uses the same ref for `preview`. The local [.env:13](.env#L13) also points at the same ref.

This means the project simultaneously trips multiple **invalid-staging indicators** from the prompt:
- "project is used by Play Store/internal production backend" ✅
- "same ref is used by production app config" ✅
- "unclear environment identity" ✅

The team has been informally treating its single production/store backend as a "dev" project. There is **no isolated staging environment**. Per Step 3 + the v2 hardening drift guard ("if multiple candidates remain ambiguous, stop and report HOLD"; "confirm the current linked project is not the production/store backend") and the Absolute Stops ("environment cannot be confidently identified as staging/dev" / "a migration would run against production"), this is a hard stop.

**No relink was performed. No `supabase db push` was run. No test data/users were created.**

---

## 3. Migration Status (read-only)

Latest remote migration on `yzqjvdfgefveprobvvyw`: `20260611223807`. Both target migrations are **PENDING**, and neither table exists:

```sql
-- result: legal_acceptances_exists=0, saved_scans_exists=0, latest_remote_migration=20260611223807
```

| Migration | Local file | Patched | Remote status | Table exists |
|-----------|:-:|:-:|:-:|:-:|
| `20260617000001_create_legal_acceptances.sql` | ✅ | n/a | ❌ pending | ❌ |
| `20260617215307_create_saved_scans.sql` | ✅ | ✅ (trigger fixed) | ❌ pending | ❌ |

- Dry run: not performed (would target production; blocked).
- Applied in this run: **none**.
- Minor patches made: **none** (no safe target to verify against; patch authority not exercised).

### Trigger patch verification (static — Step 4)
The `saved_scans` migration now contains the hardened trigger and the prior defect is resolved:
- `create or replace function public.set_saved_scans_updated_at()` PL/pgSQL, `security invoker`, `set search_path = public` ([file lines 62-72](supabase/migrations/20260617215307_create_saved_scans.sql#L62-L72)).
- `drop trigger if exists update_saved_scans_updated_at` then `create trigger saved_scans_set_updated_at before update ... execute function public.set_saved_scans_updated_at()` (lines 75-81).
- **No `moddatetime` executable dependency; no `CREATE TRIGGER IF NOT EXISTS`.**
- `updated_at timestamptz not null default now()` (line 21).

Functional runtime verification of the trigger is **deferred** — it requires applying to a confirmed staging DB, which is blocked.

---

## 4. Schema Verification
**NOT PERFORMED on a live DB** — tables do not exist on the only reachable project, which is the production/store backend. Static review of both migration files (this run + KS-REL-005A) shows expected columns, indexes, CHECK constraints, partial unique index, RLS policies (own-row SELECT/INSERT for `legal_acceptances`; own-row SELECT[+`deleted_at is null`]/INSERT/UPDATE, no DELETE for `saved_scans`), and `revoke all from anon` + scoped `authenticated` grants. Live confirmation pending a staging target.

## 5. RLS Verification
**NOT PERFORMED** — requires applying migrations and writing test rows/users to a confirmed staging project. Blocked. **Mandatory cross-user isolation is unverified**, which by definition precludes "Ready."

## 6. Trigger Functional Test
**NOT PERFORMED** — blocked (no staging target). Static patch verified (see §3).

## 7. Test Data Cleanup
None created. Nothing to clean.

## 8. Generated Types
Not generated — no applied schema to generate from, and generation would target the production/store backend. No types file changed.

## 9. Feature Flag Safety
All gated flags are environment-driven and default `false` in [constants/featureFlags.ts](constants/featureFlags.ts); none are enabled in `.env`/`.env.local`:
`CLOUD_SAVED_SCANS_ENABLED`, `TEXTSCAN_BACKEND_ENABLED`, `TEXTSCAN_UI_ENABLED`, `TEXTSCAN_DEMO_RESULTS_ENABLED`, `SCAN_RESULTS_V2_UI_ENABLED`, `SCAN_ROOM_V2_UI_ENABLED`, `HOME_NAVIGATION_V2_ENABLED`, `ONBOARDING_FRAMEWORK_V1_ENABLED`. **No flags changed.**

## 10. Security / Hygiene
- No-secrets: no keys/JWTs/passwords/connection strings emitted; env grep redacted.
- `service_role` exposure: only in server-side edge functions, the admin deletion script, and docs/QA — **not in mobile/client code** (re-confirmed against KS-REL-005A finding). No client exposure.
- Working tree clean apart from untracked Android mipmap artifacts (not staged).
- No `.env`, backup, or native artifacts staged. Files created this run: this QA report only.

## 11. Issues / Fixes
- **Blocker (environment):** the only reachable project is the production/store backend with a contradictory "dev" designation; no isolated staging exists. No safe target for apply / RLS runtime tests.
- **Resolved since 005A:** `saved_scans` `updated_at` trigger defect — now patched (`3cd2656`), verified statically.
- Fixes made this run: none (patch authority not exercised — nothing safe to apply against).

## 12. Deferred
Android runtime smoke; `CLOUD_SAVED_SCANS_ENABLED` runtime validation; Gemini/OpenRouter TextScan; StyleChat; AAB build; Cloud image backup; **live schema/RLS/trigger/cross-user verification (pending staging target)**.

---

## 13. Final Recommendation

**HOLD.** The only code-side blocker from KS-REL-005A (the trigger) is fixed; the **sole remaining blocker is environment**. Verification cannot proceed safely until one of:

1. **A dedicated staging/dev Supabase project is created** (separate ref, no production app config pointing at it, no real user data) and its ref provided. Then re-run KS-REL-005D against it.
2. **Explicit, written owner authorization** to verify against `yzqjvdfgefveprobvvyw` *with full understanding that it is the production/store backend used by store builds.* Even then, applying unproven migrations + writing test rows to the live backend carries real risk and is outside this prompt's safety envelope without that authorization.

**Next required prompt:** provision (or designate) a real staging project and re-run KS-REL-005D against the confirmed staging ref — or an explicit owner decision authorizing the shared production project as the verification target.

### Addendum field summary (per v2 hardening Step 16)
- Current Supabase link before relink: `yzqjvdfgefveprobvvyw` (account-side); no relink performed
- Final Supabase link before db push: N/A — db push not run
- Staging backup: not performed (no apply attempted)
- Backup file committed: no
- Rollback plan documented: N/A — nothing applied
- Migration hash mismatch: N/A — target migrations not present remotely
- Push target verified immediately before db push: N/A — db push not run
- RLS table-level relrowsecurity: not checked live (tables absent)
- Foreign key cascade: static only — `user_id ... references auth.users(id) on delete cascade`
- Partial unique index functional test: not performed (blocked)
- Protected column updates: not performed (blocked)
- RLS performance: static only
- SQL impersonation method: not exercised (no apply)
- auth.uid() verification User A/B: not performed (no test users created)
- Types generated from confirmed staging: no
