# K Scan AI — KS-INFRA-001A Waitlist Consolidation QA Report

**Status: APPLIED & VERIFIED.** Owner approved on 2026-06-18; migration applied to the main
backend (`yzqjvdfgefveprobvvyw`) via a targeted single-migration apply. Historical rows were
**not** imported (Outcome A, per owner instruction).
**Date:** 2026-06-18
**Branch:** `feature/waitlist-project-consolidation-v1`

> This report is redacted. No real emails, names, keys, JWTs, connection strings,
> or row contents are included — only counts and structural/aggregate facts.

---

## 0. Approval & Apply Trail

- Approval phrase received (verbatim):
  `APPROVE WAITLIST MERGE TO MAIN BACKEND — Migration file: 20260618091336_create_waitlist_signups_main_backend.sql`
- Owner constraints: **targeted apply only** (no blanket `supabase db push`); **do not import historical rows**; then verify RLS and update this report.
- Applied via MCP `apply_migration` (project `yzqjvdfgefveprobvvyw`, name `create_waitlist_signups_main_backend`). This applies exactly one migration and could not touch the two pending local migrations.
- **Recorded migration version:** `20260618132214` (Supabase uses UTC). The migration file was renamed
  `20260618091336_… → 20260618132214_create_waitlist_signups_main_backend.sql` so the filename matches the
  recorded version (and the repo's UTC convention). **The SQL content is unchanged from what was approved**;
  only the filename timestamp was aligned. The begin/commit wrapper was omitted at apply time because
  `apply_migration` runs inside its own transaction; the committed file keeps begin/commit for psql/db-push use.

---

## 1. Branch / Commit

- Branch: `feature/waitlist-project-consolidation-v1` (from `feature/supabase-staging-verification-v1`).
- Commit 1 (`fdb77c9`): migration draft + this report (HOLD).
- Commit 2 (this commit): file rename to applied version + report updated to APPLIED & VERIFIED.
- Working tree otherwise clean except pre-existing untracked `android/` icons (never staged). Not pushed.

---

## 2. Projects

| | Source | Destination |
|---|---|---|
| Name | KScan waitlist Project | K Scan Privacy Controls |
| Ref | `wyyuqfdxucjksghsmhry` | `yzqjvdfgefveprobvvyw` |
| Region | us-east-2 | us-west-1 |
| Organization | `dtcbsuytyjpvadcnyymn` | `dtcbsuytyjpvadcnyymn` (same) |
| Postgres | 17.6.x | 17.6.x |
| Status | ACTIVE_HEALTHY | ACTIVE_HEALTHY |

- Confirmed source == `wyyuqfdxucjksghsmhry` ✅ · Confirmed destination == `yzqjvdfgefveprobvvyw` ✅
- Destination confirmed as current production/store backend (live app + privacy-controls + style-chat schema and active edge functions).
- Read-only inventory on both; no `supabase link`; the only write was the approved additive migration on the destination.
- Plan/tier: not exposed via the MCP management API.

---

## 3. Capacity / Rollback

| Metric | Value |
|---|---|
| Source DB size | ~12 MB |
| Destination DB size | ~13 MB (pre-apply); new table adds ~0 (empty) |
| Headroom | Ample on any tier |
| Estimated import size | N/A (no import) |

- **Rollback:** trivial — `drop table public.waitlist_signups;` (the migration is additive and isolated). The legacy source project is retained untouched as the authoritative recovery source.
- **PITR/restore:** not exposed via MCP; not required given the above.

---

## 4. Source Inventory (read-only)

The "waitlist project" is actually a broader **legacy app backend**; only `waitlist_signups` is in scope.

**`waitlist_signups` (source):** `id uuid PK`, `email text NOT NULL UNIQUE` (case-sensitive), `source text default 'homepage'`, `page text`, `name text`, `referrer text`, `created_at timestamptz`. No triggers, no FKs, no check constraints. RLS on; only policy = **"Service key only access"** (service_role). anon/authenticated held broad default grants but were RLS-blocked → emails not publicly readable. Insert path is server-side via service_role.

**Source data quality:** 20 rows; 0 invalid, 0 null, 20 distinct (case-insensitive); 10 have a name, 7 a referrer; dates 2026-04-24 → 2026-06-18. **By `source`: 11 `homepage`, 9 test/diagnostic** (`debug`×2, `codex-test`, `codex-email-normalization-test`, `diag`, `live-prod-test`, `prod-debug`, `sql-editor`, `test`).

**Out of scope (not migrated):** `investor_inquiries` (1 row); 12 app functions (none waitlist); 2 storage buckets/4 objects; 2 auth users (NOT imported); edge functions incl. `resend-email`.

---

## 5. Historical Import Decision

**Outcome A — fresh start (future signups only); historical PII NOT imported.** Confirmed by owner.
Rationale: ~45% of source rows are test noise, footprint is trivial, importing PII into production adds risk for negligible benefit, and the retained source remains the export/recovery source. Historical data archived = retained source project. Historical data imported = **No (0 rows).**

---

## 6. Destination Migration (APPLIED)

- **File:** `supabase/migrations/20260618132214_create_waitlist_signups_main_backend.sql`
- **Recorded version:** `20260618132214` / `create_waitlist_signups_main_backend`
- **Applied:** ✅ YES (MCP `apply_migration`, `{"success":true}`). **Dry run:** N/A (single targeted apply; pre-apply state confirmed table absent). **Transaction:** wrapped by apply_migration; file is idempotent (`if not exists`).

**Verified table state on destination:**
- Columns (11): `id, email, name, source, page, referrer, consent_recorded_at, metadata(jsonb), created_at, imported_from, imported_at` — types/nullability/defaults match design.
- Constraints: `waitlist_signups_email_check` = `CHECK (POSITION('@' IN email) > 1)`; `waitlist_signups_metadata_object_check` = `CHECK (jsonb_typeof(metadata) = 'object')`; PK on `id`.
- Indexes: `waitlist_signups_email_unique_idx` = UNIQUE `lower(email)`; `waitlist_signups_created_at_idx` = `(created_at DESC)`; pkey.
- RLS enabled = **true**; policy count = **0** (intentional); row count = **0**.

### Review gate (pre-apply) — PASS
No DROP/TRUNCATE/DELETE/ALTER-DROP-COLUMN/DISABLE-RLS; no FK to auth.users; no public SELECT grant; no service_role policy; no existing table modified; additive + transaction-wrapped.

---

## 7. Data Import

Not performed (Outcome A). Source 20 → imported 0 → duplicates 0 → errors none.

---

## 8. RLS / Exposure Verification (post-apply, via `has_table_privilege`)

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| anon | ❌ false | ❌ false | ❌ false | ❌ false |
| authenticated | ❌ false | ❌ false | ❌ false | ❌ false |
| service_role | ✅ true | ✅ true | (retained) | (retained) |

- Lockdown is enforced at **two layers**: broad grants revoked (anon/authenticated have no privilege at all) **and** RLS enabled with no policy. service_role retains access and bypasses RLS → server-side insert path works.
- **Production app exposure:** `waitlist_signups` appears only in the migration + this report; **no mobile/app client code references it** (repo-wide search). No anon-key SELECT exposure.
- **Service-role exposure in client code:** none introduced (no client code changed).
- **Security advisors:** only `rls_enabled_no_policy` (INFO) for `waitlist_signups` — the intended design, matching the existing `style_chat_burst_usage` pattern. No ERROR findings; all WARN findings are pre-existing on unrelated objects (out of scope).

---

## 9. Environment Handoff (informational — not executed)

- To route future signups to the main backend, repoint the waitlist frontend `SUPABASE_URL` / `SUPABASE_ANON_KEY` to `yzqjvdfgefveprobvvyw`.
- The table is **service-role-only**: the site must insert **server-side** (service_role / an edge function), exactly as the legacy site does today. Direct anon insert is blocked by design. The legacy `resend-email` edge function path is not present on the main backend — decide whether to deploy an equivalent or insert server-side directly.
- Never grant anon/authenticated SELECT on this table. Retire legacy waitlist env only after the new path is verified. Coordinate cutover so in-flight signups aren't lost (source still active; latest signup = today).

---

## 10. Source Retention Rule

The legacy source (`wyyuqfdxucjksghsmhry`) **remains the recovery source** and must not be reset, deleted, or repurposed until: (1) destination verified [done], (2) import decision complete [done — none], (3) future-signup path confirmed, (4) a stability window passes with no issues, (5) a separate staging-setup prompt runs.

---

## 11. Security / Hygiene

- No-secrets scan over committed files: pass (matches are descriptive words only; no keys/JWTs/connection-strings/PII).
- Real emails committed: none. Env files: none. Backup/import files: none.
- Only the migration file (renamed) + this report are staged. Never used `git add .`.

---

## 12. Remaining Items / Human Decisions

1. **Frontend env handoff** — separate task (repoint + server-side insert path / edge function).
2. **`investor_inquiries`** (1 row) — out of scope; decide separately if it needs a main-backend home.
3. **Two pending local migrations** (`20260617000001_create_legal_acceptances`, `20260617215307_create_saved_scans`) remain **unapplied** on the destination — unrelated to this task and deliberately left untouched. A future `supabase db push` would apply them; apply intentionally.
4. **Source decommission** — not now; honor the retention rule above.

---

## 13. Final Recommendation

- **Consolidated:** ✅ applied & verified (future-signups table on main backend, service-role-only, empty).
- **Historical import:** not done (recommended not to).
- **Ready for future signups:** ✅ after the frontend env handoff (server-side insert).
- **Ready to repurpose source:** ❌ No — retain as recovery source.
- **Next prompt:** frontend env handoff, then (later) a separate staging-setup task.
