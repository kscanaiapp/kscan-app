# K Scan AI — KS-INFRA-001A Waitlist Consolidation QA Report

**Status: HOLD — awaiting owner approval before any destination write.**
**Date:** 2026-06-18
**Branch:** `feature/waitlist-project-consolidation-v1`

> This report is redacted. No real emails, names, keys, JWTs, connection strings,
> or row contents are included — only counts and structural/aggregate facts.

---

## 1. Branch / Commit

- Current branch: `feature/waitlist-project-consolidation-v1` (created from `feature/supabase-staging-verification-v1`)
- Working tree before this task: clean except pre-existing untracked `android/` icon assets (NOT staged by this task).
- New artifacts this task: one additive migration draft + this QA report (not yet committed at time of writing).

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
| Created | 2026-04-04 | 2026-05-14 |

- **Confirmed source** ref == `wyyuqfdxucjksghsmhry` ✅
- **Confirmed destination** ref == `yzqjvdfgefveprobvvyw` ✅
- Destination is the current production/store backend (confirmed by schema: it holds the live app + privacy-controls tables, style chat, and the active edge functions). ✅
- Source is safe to read from (read-only inventory only; no writes, no `supabase link`). ✅
- Plan/tier is **not exposed** via the MCP management API; recorded as "not visible via MCP".

---

## 3. Capacity / Rollback

| Metric | Value |
|---|---|
| Source DB size | ~12 MB (12,479,635 bytes) |
| Destination DB size | ~13 MB (13,421,715 bytes) |
| Waitlist data footprint | 20 rows, well under 1 MB |
| Estimated import size | Negligible (< 50 MB threshold; < 1 MB actual) |
| Headroom | Ample on any Supabase tier |
| Row-count gates | 20 rows — under the 1,000 / 10,000 thresholds; no batching needed |

- **PITR / restore posture:** PITR/branching availability is not exposed via the MCP API (recorded as unknown). It is **not required** here because (a) the migration is purely additive and trivially reversible (`drop table public.waitlist_signups` if ever needed), and (b) the source project is retained untouched as the authoritative recovery source (Step 17).
- **Backup required for the additive migration?** No — `CREATE TABLE` cannot affect existing data, and the source remains intact.

---

## 4. Source Inventory (read-only)

**Public tables (14):** `app_config`, `deletion_requests`, `dressing_room_item_reactions`, `dressing_room_items`, `dressing_rooms`, `investor_inquiries`, `look_items`, `looks`, `privacy_correction_requests`, `privacy_export_requests`, `privacy_settings`, `profiles`, `room_shares`, **`waitlist_signups`**.

> Note: the "waitlist project" is actually a broader **legacy app backend** that also collected waitlist signups. Only `waitlist_signups` is in scope for this task.

**`waitlist_signups` schema:**

| Column | Type | Null | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| email | text | NO | — |
| source | text | YES | 'homepage' |
| page | text | YES | — |
| created_at | timestamptz | NO | now() |
| name | text | YES | — |
| referrer | text | YES | — |

- Indexes/constraints: PK on `id`; **UNIQUE(email)** (case-sensitive). No triggers. No check constraints. No foreign keys.
- RLS: **enabled**. Only policy = **"Service key only access"** (`service_role`, ALL, `true`/`true`).
- Table grants: `anon` and `authenticated` hold broad default grants (ALL), but RLS blocks them (no permissive policy) → **emails are not publicly readable**. Insert path is server-side via `service_role`.

**Source data quality (`waitlist_signups`):**

| Metric | Value |
|---|---|
| Total rows | 20 |
| Distinct emails (case-insensitive) | 20 (no dupes) |
| Invalid emails (`@` check) | 0 |
| Null emails | 0 |
| Rows with name | 10 |
| Rows with referrer | 7 |
| Date range | 2026-04-24 → 2026-06-18 (latest = today; waitlist still active) |

**Source distribution by `source`:** `homepage` = 11; the remaining **9 rows are test/diagnostic** (`debug` ×2, `codex-test`, `codex-email-normalization-test`, `diag`, `live-prod-test`, `prod-debug`, `sql-editor`, `test`). → at most ~11 "real" signups.

**Other source assets (all OUT OF SCOPE — not migrated):**
- `investor_inquiries`: 1 row (sibling contact table; not waitlist — flagged for separate human decision).
- Functions: 12 (all app logic — looks, rooms, privacy, `handle_new_user`; **none waitlist-related**).
- Triggers: 12 (app logic; none on `waitlist_signups`).
- Storage: 2 buckets / 4 objects (legacy app assets; not waitlist).
- Auth users: **2** (admin/test accounts — NOT imported per rule; waitlist members live in the table, not in `auth.users`).
- Edge functions: `resend-email`, `kickscrew-sneaker-description`, `product-search-deals`, `nike-shoe-details`. `resend-email` may be the site's signup/email path — relevant only to the later frontend handoff, not to the table migration.

---

## 5. Historical Import Decision

| Question | Answer | Evidence |
|---|---|---|
| Needed for app functionality? | No | No app code reads historical waitlist rows; table is standalone. |
| Needed for marketing/contact continuity? | Marginal | Only ~11 non-test rows; not a material list. |
| Can it be archived instead of imported? | Yes | Source project retained untouched; exportable any time. |
| Does importing PII increase risk? | Yes | Adds 20 emails/10 names of PII to the production backend for negligible benefit. |
| Is future-only capture sufficient? | Yes | New table serves all future signups. |

**Decision: Outcome A — fresh start (future signups only). Do NOT import historical PII now.**
Rationale: ~45% of rows are test noise, footprint is trivial, and the source is retained as the recovery/export source — so nothing is lost and production PII is minimized. The migration is nonetheless designed to *accept* a clean future import (provenance columns + case-insensitive uniqueness) if the owner later approves it.

- Historical data archived: source project retained (authoritative). Optional local file export deferred — see §6.
- Historical data imported: **No.**

---

## 6. Backup Status

- **Primary backup = the retained source project** (`wyyuqfdxucjksghsmhry`), left fully untouched per Step 17. This is a live, complete copy of all 20 rows.
- No separate local PII file was created, deliberately: pulling 20 real emails/names into the working context or repo would *increase* exposure with no safety benefit, given the additive migration cannot affect existing data and the source is intact.
- If a standalone local archive is wanted (e.g., before any future eventual source decommission), the safe path — run locally, never committed, requires the **source DB password**:
  ```
  supabase db dump --db-url "<SOURCE_POSTGRES_CONNECTION_STRING>" \
    --data-only --table public.waitlist_signups \
    --file ../kscan-waitlist-archive/waitlist-source-backup-2026-06-18.sql
  ```
  or a Supabase dashboard CSV export of `public.waitlist_signups`. Store **outside** the repo.

---

## 7. Destination Conflict Check (read-only)

Searched destination `yzqjvdfgefveprobvvyw` for anything waitlist-named:

- Tables matching `%waitlist%`: **none**
- Functions matching `%waitlist%`: **none**
- Policies on `%waitlist%` tables: **none**
- Storage buckets matching `%waitlist%`: **none**

→ **No conflict.** A new `public.waitlist_signups` is fully additive.

- Destination already has `investor_inquiries`? No (so that sibling table is also absent — out of scope regardless).
- Destination applied migrations end at `20260611223807_fix_room_messages_authenticated_grants`. The new migration timestamp `20260618091336` sorts after it. ✅

---

## 8. Destination Migration (DRAFT — not applied)

- **File:** `supabase/migrations/20260618091336_create_waitlist_signups_main_backend.sql`
- **Tables created:** `public.waitlist_signups` (additive, `create table if not exists`).
- **Columns:** `id, email, name, source, page, referrer, consent_recorded_at, metadata (jsonb), created_at, imported_from, imported_at`.
- **Indexes:** unique `lower(email)`; `created_at desc`.
- **Constraints:** email `@` check; metadata must be a JSON object.
- **RLS:** enabled. Broad `anon`/`authenticated` grants **revoked**. **No public policy. No service_role policy** (service_role bypasses RLS for server-side insert — matches source access model).
- **Grants:** none added (no public SELECT/INSERT).
- **Transaction strategy:** wrapped in `begin … commit`; idempotent (`if not exists`).
- **Applied:** **NO (HOLD).** Dry run: not yet run (Step 11, post-approval).

### Migration review gate — result: PASS

| Check | Result |
|---|---|
| No DROP TABLE | ✅ |
| No TRUNCATE | ✅ |
| No DELETE FROM production tables | ✅ |
| No ALTER TABLE DROP COLUMN | ✅ |
| No DISABLE ROW LEVEL SECURITY | ✅ (enables it) |
| No FK to auth.users | ✅ (no FKs) |
| No public SELECT grant | ✅ (no GRANT at all) |
| No service_role policy | ✅ (no policy at all) |
| No existing app table modified | ✅ |
| Additive + transaction-wrapped | ✅ |

---

## 9. Data Import

- Import method: **N/A** (Outcome A — not importing).
- Source row count: 20. Imported row count: 0. Duplicates skipped: N/A. Errors: none.

---

## 10. RLS / Exposure Verification

**Planned posture (verifiable after apply):**
- anon insert: ❌ blocked (no grant, no policy)
- anon select/update/delete: ❌ blocked
- authenticated insert/select/update/delete: ❌ blocked
- service_role: ✅ server-side insert (bypasses RLS) — intended path
- service_role exposure in client code: none introduced (no client code changed)

**Production app exposure check (destination repo, read-only):** searched for `waitlist_signups` / `from('waitlist'` / `from("waitlist'` / `select(...waitlist` — see §0 search results in the run log. No client SELECT on waitlist data is introduced by this change. (Full pre-commit search recorded below.)

---

## 11. Environment Handoff (informational — not executed)

If/when future waitlist signups should flow to the main backend:
- Repoint the waitlist frontend `SUPABASE_URL` / `SUPABASE_ANON_KEY` to the **main** project (`yzqjvdfgefveprobvvyw`).
- Because the table is **service-role-only**, the site must insert **server-side** (service_role / an edge function), exactly as the legacy site does today — direct anon insert will be blocked by design.
- The legacy site's email/signup path appears to use the source `resend-email` edge function; decide whether to deploy an equivalent on the main backend or insert server-side directly. (Not done here.)
- Confirm no SELECT permission is ever granted to anon/authenticated.
- Retire legacy waitlist env vars only after the new path is verified.
- Sequencing: the source keeps receiving signups until cutover, so coordinate the switch to avoid losing in-flight signups (latest signup observed = today).

---

## 12. Source Retention Rule

The legacy waitlist project (`wyyuqfdxucjksghsmhry`) **remains the recovery source** and must not be reset, deleted, or repurposed until **all** of:
1. destination migration is verified,
2. historical-import decision is complete,
3. the future-signup path is confirmed,
4. no data issues are observed after a stability window,
5. a separate staging-setup prompt is executed.

---

## 13. Security / Hygiene

- No-secrets scan over committed files: see run log (Step 19). No service_role/keys/JWTs/connection-strings/PII in the migration or this report.
- Real emails in committed files: none.
- Env files committed: none.
- Backup files committed: none.
- Import files committed: none (none created).
- Only two files staged for commit: the migration draft + this report.

---

## 14. Remaining Blockers / Human Decisions

1. **Owner approval to apply the migration** (the only thing blocking destination write).
2. **`investor_inquiries`** (1 row) — out of scope here; decide separately whether it needs a home in the main backend.
3. **Frontend handoff** — separate task (env repoint + server-side insert path / edge function).
4. **Pending local migrations** — `20260617000001_create_legal_acceptances` and `20260617215307_create_saved_scans` exist locally but are **not** in the destination's applied set. A blanket `supabase db push` would also apply those. **Recommendation:** apply this waitlist migration in a **targeted** way (e.g., MCP `apply_migration`) so the consolidation does not silently sweep in unrelated pending migrations — unless the owner intends those too.

---

## 15. Final Recommendation

- **Consolidation approach:** Outcome A — create the future-signups table on the main backend; archive history in the retained source; do not import PII.
- **Migration:** reviewed, additive, locked-down (service-role-only). Ready to apply **on approval**.
- **Do not** repurpose/reset the source project yet.

**Required approval phrase to proceed with apply:**
```
APPROVE WAITLIST MERGE TO MAIN BACKEND — Migration file: 20260618091336_create_waitlist_signups_main_backend.sql
```

(Only if the owner later decides to import the historical rows, a second phrase is required:
`APPROVE HISTORICAL WAITLIST IMPORT TO MAIN BACKEND` — current recommendation is **not** to import.)
