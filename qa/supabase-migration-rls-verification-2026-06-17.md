# K Scan AI — KS-REL-005A Supabase Migration + RLS Verification

**Date:** 2026-06-18
**Engineer role:** Supabase Backend Verification Engineer
**Status:** **HOLD — environment blocker (production/shared project; migrations not applicable here)**

---

## 1. Branch / Environment

| Item | Value |
|------|-------|
| Current branch | `feature/supabase-rls-verification-v1` |
| Base branch | `feature/release-integration-v2-backend-stack-v1` |
| Base HEAD | `3c36845 docs(release): add v2 backend stack foundation handoff` |
| Release foundation tag | `release-foundation-v2-backend-stack-2026-06-17` (on HEAD) |
| Working tree | Clean except untracked `android/.../mipmap-*` artifacts (not staged) |
| Supabase CLI | v2.106.0 (available) |
| CLI-linked project ref | `yzqjvdfgefveprobvvyw` |
| Linked project name | "K Scan Privacy Controls" (region us-west-1, Postgres 17.6.1.121) |
| Other project | `wyyuqfdxucjksghsmhry` "KScan waitlist Project" (not linked) |
| Environment confirmed staging/dev | **NO — could not confirm staging** |
| Production confirmed avoided | **NO — linked project IS the production project** |
| Verification method | Supabase MCP (read-only: `list_migrations`, `execute_sql` SELECT, `get_project`); CLI for version/project list; local repo grep |

### Why this is a HOLD (Step 4 hard-stop)

`eas.json` maps **both** the `preview` and the `production` (store / `app-bundle`) build profiles to the **same** Supabase project:

```
eas.json  build.preview.env.EXPO_PUBLIC_SUPABASE_URL    = https://yzqjvdfgefveprobvvyw.supabase.co
eas.json  build.production.env.EXPO_PUBLIC_SUPABASE_URL  = https://yzqjvdfgefveprobvvyw.supabase.co
```

The CLI-linked project (`yzqjvdfgefveprobvvyw`) is therefore the **production / store-build backend**, not a dedicated staging project. There is no separate staging project (the only other project, `wyyuqfdxucjksghsmhry`, is a waitlist project). The neutral name "K Scan Privacy Controls" does not disambiguate environment.

The prompt's Step 4 rules require a hard stop when:
- "If this points to production, stop and report." ✅ triggered
- "If staging cannot be confirmed through project name, config, dashboard, or owner-provided project ref, stop and report." ✅ triggered

Per the prompt's "Not Allowed" list — **"Do not apply migrations to production"** — and because the mandatory RLS runtime tests require applying the two pending migrations and writing test rows / creating test users, these steps **cannot be performed safely on this project**. No migrations were applied. No test data was written. No test users were created.

---

## 2. Migration Status (read-only)

Remote migration history (`list_migrations`) ends at `20260611223807_fix_room_messages_authenticated_grants`. The two target migrations are **PENDING / not applied**:

| Migration | Local file present | In remote history | Table exists remotely |
|-----------|:-:|:-:|:-:|
| `20260617000001_create_legal_acceptances.sql` | ✅ | ❌ pending | ❌ does not exist |
| `20260617215307_create_saved_scans.sql` | ✅ | ❌ pending | ❌ does not exist |

Confirmation query:
```sql
select table_name from information_schema.tables
where table_schema='public' and table_name in ('legal_acceptances','saved_scans');
-- result: []  (neither table exists)
```

- Dry-run: not performed (would target production; blocked).
- Applied in this run: **none**.
- Existing row counts: N/A — tables do not exist.
- Migration files local integrity: no duplicate timestamps, no name conflicts, both target files present and well-formed.

---

## 3. Static Migration Review (local files — read-only)

Both migration files were reviewed locally. They look structurally sound, with two defects to verify/fix before apply:

**`legal_acceptances` (appears correct):**
- `id uuid pk`, `user_id → auth.users(id) on delete cascade`, `acceptance_type`, `policy_version`, `accepted_at`, `source`, `app_version`, `metadata jsonb`, `created_at`.
- CHECK: `acceptance_type in (terms,privacy,minimum_age)`, `source in (mobile,web,admin,system)`, non-empty `policy_version`, `metadata` is object.
- UNIQUE `(user_id, acceptance_type, policy_version)`.
- RLS enabled; SELECT + INSERT own-row policies for `authenticated`; **no UPDATE/DELETE policy** (correct for immutable ledger).
- `revoke all from anon`; `grant select, insert to authenticated`.
- Indexes on `user_id`, `(user_id, acceptance_type)`, `accepted_at`.

**`saved_scans` — ⚠️ DEFECT (updated_at trigger):**
- The `updated_at` trigger is created **only inside a `do $$ ... if exists (... moddatetime) ...`** guard (lines 63–72). If the `moddatetime` extension is **not** already enabled on the target project, **no trigger is created and `updated_at` will never auto-update** — which fails the prompt's mandatory trigger functionality test.
- The comment claims "the fallback local function is defined below," but **no fallback function or trigger is actually defined**. The guard has no `else` branch.
- `create trigger if not exists` is used (line 66). `IF NOT EXISTS` is **not valid syntax for `CREATE TRIGGER`** in PostgreSQL (through PG17). If the `moddatetime` branch is ever reached, the migration will **error out**.
- **Recommendation:** rewrite to `create extension if not exists moddatetime;` followed by `drop trigger if exists ... ; create trigger ...` (no `IF NOT EXISTS` on the trigger), OR define a self-contained `set_updated_at()` plpgsql function + trigger that does not depend on the extension. Must be fixed before apply, and trigger function must be runtime-tested afterward.

Other `saved_scans` notes (appear correct): partial unique index `(user_id, local_id) where local_id is not null`; indexes on `user_id`, `(user_id, saved_at desc)`, `(user_id, deleted_at)`; CHECK constraints for `source`, `scan_type`, jsonb-object on `analysis_result`/`metadata`, jsonb-array on `products`, non-empty `local_id`; RLS SELECT(own + `deleted_at is null`)/INSERT/UPDATE for authenticated, no DELETE policy (soft-delete only); `revoke all from anon`; `grant select, insert, update to authenticated`.

> Note: `WITH CHECK (auth.uid() = user_id)` on UPDATE prevents re-assigning a row to another user, but does **not** restrict which columns the owner may edit — an owner can modify `analysis_result`/`products`/`deleted_at`. This is service-layer-controlled by design; flagged for awareness, not a blocker.

---

## 4. RLS Runtime Verification

**NOT PERFORMED** — requires applying pending migrations and writing test rows/users to the project, which is the production/store backend. Blocked by Section 1. Mandatory cross-user isolation is therefore **unverified**, which on its own precludes a "Ready" recommendation.

---

## 5. Test Data Cleanup
None created. Nothing to clean.

## 6. Generated Types
Not generated (no schema applied to verify against). No types file changed.

## 7. Feature Flag Safety
Not modified by this sprint. Flags must remain:
`CLOUD_SAVED_SCANS_ENABLED=false`, `TEXTSCAN_BACKEND_ENABLED=false`, `TEXTSCAN_UI_ENABLED=false`, `TEXTSCAN_DEMO_RESULTS_ENABLED=false`. **No flags changed.**

## 8. Security / Hygiene
- `service_role` references (repo grep): only in server-side edge functions (`supabase/functions/*`), the admin script `scripts/process-deletion-request.js`, and docs/QA reports. **No `service_role` in mobile/client code** — no client exposure.
- No secrets printed. No JWTs, passwords, or connection strings emitted.
- Working tree clean apart from untracked Android mipmap artifacts (not staged).
- Files created this run: this QA report only.

## 9. Issues / Fixes
- **Blocker (environment):** linked project is production/shared (preview + store builds); no staging project available. No safe target for migration apply or RLS runtime tests.
- **Defect (code, pre-apply):** `saved_scans` `updated_at` trigger is conditionally created and uses invalid `CREATE TRIGGER IF NOT EXISTS`; no working fallback. Will leave `updated_at` non-functional (or error) depending on `moddatetime` state.
- No fixes applied (out of scope without approval).

## 10. Deferred
Android runtime smoke; `CLOUD_SAVED_SCANS_ENABLED` runtime validation; Gemini/OpenRouter TextScan; StyleChat; AAB build; Cloud image backup.

## 11. Final Recommendation

**HOLD.**

1. **Environment must be resolved first.** Provide/confirm a dedicated **staging** Supabase project ref (or explicitly authorize, in writing, verification against `yzqjvdfgefveprobvvyw` understanding it is the production/store backend). Verification cannot proceed safely until then.
2. **Fix the `saved_scans` `updated_at` trigger defect** before any apply.
3. After a confirmed staging target + trigger fix: apply migrations to staging, then run mandatory schema, CHECK-constraint, trigger, and cross-user RLS runtime tests.

**Next required prompt:** re-run KS-REL-005A against a confirmed staging project (and with the trigger migration patched), or an explicit owner authorization defining the correct target environment.
