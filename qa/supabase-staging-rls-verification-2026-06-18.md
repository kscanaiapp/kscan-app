# KS-REL-005D v2 — Supabase Staging RLS + Security Verification

**Project:** KScan App Staging
**Project ref:** `wyyuqfdxucjksghsmhry`
**Branch:** `feature/supabase-staging-rls-verification-v2`
**Base branch:** `feature/release-integration-v2-backend-stack-v1`
**Commit:** `b0c175c50673b5f5590e4aae9adbff9b7c987dbf`
**Date:** 2026-06-18
**Verified by:** Kimi Code CLI

---

## Executive Summary

**Status: FAIL**

The staging project is linked to the correct project and migrations are aligned, but it is **not safe for app runtime testing** in its current state. Two critical issues block the gate:

1. **Missing table grants for the `authenticated` role.** RLS policies exist on the core user-data tables, but the `authenticated` role has not been granted the underlying `SELECT`/`INSERT`/`UPDATE` privileges on most of them. The app uses direct Supabase client calls against these tables, so authenticated users will receive permission-denied errors at runtime.
2. **`saved_scans` soft-delete is broken.** Updating `deleted_at` to a non-null value on a row owned by the authenticated user fails with `new row violates row-level security policy for table "saved_scans"`. This contradicts the migration design that states "soft-delete only via UPDATE" and would prevent users from deleting saved scans.

No secrets, service-role keys, or hardcoded JWTs were found in the repo. Feature flags remain off. Anon is denied on all protected tables. Cleanup completed successfully.

---

## Step 0 — Project Link Emergency Check

- `supabase/.temp/project-ref` = `wyyuqfdxucjksghsmhry` ✅
- `supabase migration list` connected to staging ✅
- No protected project (`yzqjvdfgefveprobvvyw` / K Scan Privacy Controls) was touched.

## Step 1 — Reset Completeness Check

| Check | Result |
|-------|--------|
| `auth.users` count before testing | 2 (pre-existing staging/demo users) |
| `auth.users` count after cleanup | 2 |
| Database size | 12 MB |
| Public tables | Core app schema present; no legacy waitlist-era tables found |
| Storage buckets | `investor-docs` (private, legacy, 4 objects), `style-library-images` (private, 0 objects) |

**Notes:**
- `investor-docs` bucket is legacy waitlist-era residue. It is private and contains 4 objects. Not a direct data-leak risk, but it is undocumented staging residue.
- Two pre-existing auth users were present: `demo@kscan.app` and `delete@kscan.app`. These appear to be intentional staging/demo accounts and were not modified.

## Step 2 — Migration History Deep Verification

- `supabase migration list` returned `Local = Remote` for all 31 migrations.
- Local migration files match remote timestamps exactly.
- No waitlist-era migration names or timestamps were found.
- Migration history: **clean**.

## Step 3 — Free Tier Constraints

- Database size: **12 MB** (well under free-tier limits)
- Storage buckets: 2
- Storage objects: 4 (all in legacy `investor-docs`)
- Auth users before testing: 2
- Auth users created for testing: 2 (User A, User B)
- Auth users after cleanup: 2
- No PITR assumption; no large uploads; no concurrent load tests.

## Step 4 — Test User Setup

- Created two temporary staging auth users via staging admin SQL:
  - User A (`test-user-a@kscan-staging.local`)
  - User B (`test-user-b@kscan-staging.local`)
- Passwords are strong, random, and not stored or reported.
- Both users were deleted after testing (see Step 15).

## Step 5 — RLS Impersonation Method

Verified session impersonation with:

```sql
begin;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"USER_A_ID","role":"authenticated"}';
set local "request.jwt.claim.sub" = 'USER_A_ID';
select auth.uid() as simulated_uid;
rollback;
```

Result: `simulated_uid` returned the expected User A UUID. User B impersonation returned the expected User B UUID. Anon impersonation returned `anon`.

## Step 6 — Core Table + RLS Policy Inventory

### Tables and RLS status

| Table | RLS enabled | RLS forced |
|-------|-------------|------------|
| `profiles` | ✅ | no |
| `privacy_settings` | ✅ | no |
| `legal_acceptances` | ✅ | no |
| `saved_scans` | ✅ | no |
| `dressing_rooms` | ✅ | no |
| `dressing_room_items` | ✅ | no |
| `dressing_room_messages` | ✅ | no |
| `inspiration_items` | ✅ | no |
| `style_chat_sessions` | ✅ | no |
| `style_chat_messages` | ✅ | no |
| `style_memory_events` | ✅ | no |

### Policy summary

- `profiles`, `privacy_settings`, `saved_scans`, `dressing_rooms`, `dressing_room_items`, `dressing_room_messages`, `legal_acceptances` — policies scoped to `authenticated` role.
- `inspiration_items`, `style_chat_sessions`, `style_chat_messages`, `style_memory_events` — policies scoped to `public` role (anon + authenticated). This is slightly unconventional; because the qualifiers use `auth.uid() = user_id`, anon will simply see zero rows rather than leak data.
- Ownership/membership logic:
  - Most tables enforce `auth.uid() = user_id` for SELECT/INSERT/UPDATE.
  - `dressing_room_items` and `dressing_room_messages` are scoped through `dressing_rooms` ownership (`dressing_rooms.user_id = auth.uid()`).
  - `legal_acceptances` has only INSERT/SELECT policies, enforcing immutability.
  - `saved_scans` SELECT policy also enforces `deleted_at IS NULL`.

### Critical finding — missing table grants

Despite the policies above, the `authenticated` role has **no table-level privileges** on most tables. Verified via `information_schema.table_privileges`:

| Table | `authenticated` grants found |
|-------|------------------------------|
| `saved_scans` | SELECT, INSERT, UPDATE ✅ |
| `legal_acceptances` | SELECT, INSERT ✅ |
| `dressing_room_messages` | SELECT, INSERT ✅ |
| `dressing_rooms` | **none** ❌ |
| `dressing_room_items` | **none** ❌ |
| `inspiration_items` | **none** ❌ |
| `style_chat_sessions` | **none** ❌ |
| `style_chat_messages` | **none** ❌ |
| `style_memory_events` | **none** ❌ |
| `profiles` | **none** ❌ |
| `privacy_settings` | **none** ❌ |

In Postgres, RLS policies alone do not grant table access; the role must also hold the underlying privilege. Because the app calls `supabase.from('<table>')...` for these tables, authenticated users will hit `permission denied` at runtime. This is the primary reason for the FAIL classification.

## Step 7 — Functional Cross-User Isolation Tests

Isolation tests were run using transaction-scoped impersonation. Only tables with sufficient `authenticated` grants could be tested end-to-end.

### Tables with proven isolation

| Table | User A own row | User B read blocked | User B update blocked | User B delete blocked | User B spoof blocked |
|-------|----------------|---------------------|-----------------------|-----------------------|----------------------|
| `saved_scans` | ✅ | ✅ 0 rows | ✅ 0 rows | ✅ 0 rows | ✅ denied |
| `legal_acceptances` | ✅ | ✅ 0 rows | ✅ denied | ✅ denied | ✅ denied |
| `dressing_room_messages` | ✅ | ✅ 0 rows | N/A (no UPDATE policy) | N/A (no DELETE policy) | ✅ denied for non-owner room |

### Tables blocked from testing

The following tables could not be tested for cross-user isolation because the `authenticated` role lacks the table privileges required to even insert a row:

- `dressing_rooms`
- `dressing_room_items`
- `inspiration_items`
- `style_chat_sessions`
- `style_chat_messages`
- `style_memory_events`
- `profiles`
- `privacy_settings`

Cross-user isolation is **not proven** for these tables.

### Dressing-room message membership note

The deployed policy only allows the **room owner** to read/send messages. There is no policy that grants access via `room_shares` or other membership mechanism. If shared-room access is intended, an additional policy is required.

## Step 8 — saved_scans Trigger + Soft Delete Test

- Trigger `saved_scans_set_updated_at` exists as `BEFORE UPDATE` on `saved_scans` ✅
- Functional test as User A:
  - Insert own saved scan: ✅
  - Update mutable field (`title`): ✅ `updated_at` advanced
  - Set `deleted_at = now()`: ❌ **FAILS** with `ERROR: new row violates row-level security policy for table "saved_scans"`
  - Set `deleted_at = null`: ✅
  - Update `saved_at`: ✅

The soft-delete path is currently broken for authenticated users. This is the second critical issue behind the FAIL classification.

## Step 9 — legal_acceptances Immutability Test

- User A can insert own legal acceptance row ✅
- User A cannot update the row ✅ (`permission denied for table legal_acceptances`)
- User A cannot delete the row ✅ (`permission denied for table legal_acceptances`)
- User B cannot read/update/delete User A row ✅
- User B cannot insert a row with `user_id = User A` ✅
- Duplicate `(user_id, acceptance_type, policy_version)` blocked by unique constraint ✅

Immutability is correctly enforced.

## Step 10 — Anon Denial + Auth Schema Access

Anon impersonation was denied on every protected table and auth schema object:

| Target | Anon result |
|--------|-------------|
| `public.saved_scans` | permission denied ✅ |
| `public.legal_acceptances` | permission denied ✅ |
| `public.dressing_rooms` | permission denied ✅ |
| `public.inspiration_items` | permission denied ✅ |
| `public.style_chat_sessions` | permission denied ✅ |
| `public.style_chat_messages` | permission denied ✅ |
| `public.profiles` | permission denied ✅ |
| `public.privacy_settings` | permission denied ✅ |
| `auth.users` | permission denied ✅ |
| `auth.identities` | permission denied ✅ |
| `auth.sessions` | permission denied ✅ |

## Step 11 — Storage RLS / Bucket Check

| Bucket | Public flag | Objects | Notes |
|--------|-------------|---------|-------|
| `investor-docs` | false | 4 | Legacy waitlist-era residue; private |
| `style-library-images` | false | 0 | App bucket; private |

Storage policies on `storage.objects`:
- `Users can upload own style library images` (INSERT)
- `Users can read own style library images` (SELECT)
- `Users can update own style library images` (UPDATE)
- `Users can delete own style library images` (DELETE)

All policies scope objects to `bucket_id = 'style-library-images'` and `storage.foldername(name)[1] = auth.uid()::text`.

No policies exist for `investor-docs`.

## Step 12 — Edge Function Security Check

### Local functions

Local Edge Functions:
- `handle-user-deletion`
- `kickscrew-sneaker-description`
- `nike-shoe-details`
- `privacy-correction-request`
- `privacy-data-export`
- `product-search-deals`
- `search-vinted-secondhand`
- `stylechat-generate`
- `tryon-clothes-pro`

Findings:
- `SUPABASE_SERVICE_ROLE_KEY` is used only inside server-side Edge Functions (`handle-user-deletion`, `privacy-correction-request`, `privacy-data-export`) and is read from `Deno.env.get(...)`.
- `stylechat-generate` creates a Supabase client with the anon key and the caller's JWT; it does not use service_role.
- No hardcoded JWTs, service-role keys, or API keys were found in local function code.

### Deployed functions in staging

| Name | Status | Notes |
|------|--------|-------|
| `resend-email` | ACTIVE | **Legacy function** not present in local repo. Accepts arbitrary `to`, `subject`, `html` and has no auth check. Uses `RESEND_API_KEY` from env. |
| `kickscrew-sneaker-description` | ACTIVE | Present locally |
| `product-search-deals` | ACTIVE | Present locally |
| `nike-shoe-details` | ACTIVE | Present locally |

`resend-email` is a waitlist-era email relay. It is publicly callable and could be abused if `RESEND_API_KEY` is set. Recommend removing it from staging.

## Step 13 — Service Role Exposure Scan in App Repo

Scanned the repo (excluding `node_modules`, `.git`, `android`, `ios`, `.expo`, `build`, `dist`) for:
- `service_role`
- `SUPABASE_SERVICE_ROLE_KEY`
- `supabaseAdmin`
- `createClient.*service`
- `eyJhbGciOi` (JWT prefix)

Findings:
- `SUPABASE_SERVICE_ROLE_KEY` appears only in `scripts/process-deletion-request.js` and in three Edge Functions, always read from environment variables.
- No actual JWT tokens were found.
- No service-role usage in mobile/client code.

## Step 14 — Feature Flag Verification

From `constants/featureFlags.ts`:

| Flag | Default state |
|------|---------------|
| `CLOUD_SAVED_SCANS_ENABLED` | false |
| `TEXTSCAN_BACKEND_ENABLED` | false |
| `TEXTSCAN_UI_ENABLED` | false |
| `TEXTSCAN_DEMO_RESULTS_ENABLED` | false |
| `TEXTSCAN_VOICE_PLACEHOLDER_ENABLED` | false |
| `SCAN_RESULTS_V2_UI_ENABLED` | false |
| `SCAN_RESULTS_DEMO_UI_ENABLED` | false |
| `SCAN_ROOM_V2_UI_ENABLED` | false |
| `HOME_NAVIGATION_V2_ENABLED` | false |
| `ONBOARDING_FRAMEWORK_V1_ENABLED` | false |

All flags are environment-driven and default to **disabled**. No `.env` file in the repo enables the cloud/TextScan flags.

## Step 15 — Mandatory Cleanup

Deleted all test data related to User A and User B:

- `saved_scans`
- `legal_acceptances`
- `dressing_rooms`
- `dressing_room_items`
- `dressing_room_messages`
- `inspiration_items`
- `style_chat_sessions`
- `style_chat_messages`
- `style_memory_events`
- `privacy_settings`
- `profiles`
- Auth users `test-user-a@kscan-staging.local` and `test-user-b@kscan-staging.local`

Verification:

```sql
select count(*) as auth_test_users
from auth.users
where email in ('test-user-a@kscan-staging.local', 'test-user-b@kscan-staging.local');
-- Result: 0
```

All app tables returned 0 rows for the test UUIDs.

## Step 16 — Remaining Blockers

1. **Missing `authenticated` grants on 8 core tables.** Must add `GRANT SELECT, INSERT, UPDATE` (and `DELETE` where intended) on `dressing_rooms`, `dressing_room_items`, `inspiration_items`, `style_chat_sessions`, `style_chat_messages`, `style_memory_events`, `profiles`, and `privacy_settings` to the `authenticated` role. Until this is fixed, the app cannot read/write these tables from the client.
2. **`saved_scans` soft-delete update fails RLS.** Investigate why `UPDATE saved_scans SET deleted_at = now()` violates the `WITH CHECK` clause for the row owner. The UPDATE policy may need to explicitly allow `deleted_at` updates, or the SELECT policy's `deleted_at IS NULL` qualifier may be interacting incorrectly with the update.
3. **Legacy `resend-email` Edge Function deployed.** Remove from staging or add an auth gate.
4. **Legacy `investor-docs` bucket.** Review/empty if no longer needed.
5. **Dressing-room message sharing.** If room sharing is intended, add a policy that grants message access to shared users, and test both allowed/denied paths.

## Final Recommendation

**FAIL — do not use KScan App Staging for app runtime testing until the missing table grants and the broken `saved_scans` soft-delete path are resolved.**

After fixes, re-run this verification gate with particular attention to:
- Cross-user isolation on all 11 core tables.
- `saved_scans` soft-delete and trigger behavior.
- Dressing-room shared-message access if applicable.
