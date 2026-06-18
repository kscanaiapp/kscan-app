# KS-REL-005E v2 - Staging Grants + saved_scans Soft Delete RLS Patch

**Status:** PASS WITH NOTES
**Project:** KScan App Staging
**Project ref:** `wyyuqfdxucjksghsmhry`
**Branch:** `feature/staging-grants-saved-scans-rls-fix-v2`
**Base verification branch:** `feature/supabase-staging-rls-verification-v2`
**Base verification commit:** `99a03942`
**Patch commit:** pending at report creation; final response reports pushed branch HEAD.
**Date:** 2026-06-18

## Prior Failure Summary

Source report: `qa/supabase-staging-rls-verification-2026-06-18.md`

`KS-REL-005D v2` failed because:

1. The `authenticated` role lacked table grants on core app tables, so existing RLS policies could not execute for direct Supabase client calls.
2. `saved_scans` owner soft-delete failed under RLS.
3. Legacy `resend-email` Edge Function remained deployed in staging.
4. Legacy `investor-docs` storage bucket remained in staging.

No protected project was touched. The linked project ref was checked repeatedly and matched `wyyuqfdxucjksghsmhry`.

## Migrations Applied

- `supabase/migrations/202606180001_fix_staging_grants_saved_scans_soft_delete.sql`
- `supabase/migrations/202606180002_fix_saved_scans_soft_delete_select_policy.sql`
- `supabase/migrations/202606180003_fix_style_chat_messages_session_rls.sql`

Migration history was clean before apply and aligned after apply through `202606180003`.

## Free-Tier Headroom

Before patch:

| Metric | Value |
|---|---:|
| Database size | 13 MB |
| Storage buckets | 2 |
| Storage objects | 4 |
| Auth users | 2 |

After cleanup:

| Metric | Value |
|---|---:|
| Database size | 13 MB |
| Storage buckets | 1 |
| Storage objects | 0 |
| Auth users | 2 |

No load testing or heavy concurrent queries were run. Two metadata queries timed out while run in parallel; each passed when retried singly after a 30 second wait.

## Grants

Before patch, `authenticated` had grants only on:

- `saved_scans`: `SELECT`, `INSERT`, `UPDATE`
- `legal_acceptances`: `SELECT`, `INSERT`
- `dressing_room_messages`: `SELECT`, `INSERT`

After patch:

- `authenticated` has `SELECT`, `INSERT`, `UPDATE`, `DELETE` table grants on the core mutable user-data tables so RLS can be evaluated.
- `legal_acceptances` remains `SELECT` and `INSERT` only.
- No anon table grants were added to protected user-data tables.
- `anon` still has public schema usage, but protected table access is denied at table/RLS level.

## DELETE Policy Audit

`saved_scans` has no physical DELETE policy.

Existing DELETE policies remain owner-scoped on:

- `dressing_room_item_reactions`
- `dressing_room_items`
- `dressing_rooms`
- `look_items`
- `looks`

No UPDATE or DELETE policy was added to `legal_acceptances`.

## saved_scans RLS

Final policy set:

- `saved_scans_select_own`: owner may select own rows.
- `saved_scans_insert_own_active`: owner may insert own active rows only.
- `saved_scans_update_own_active`: owner may update own active rows; `WITH CHECK` preserves ownership.

Verification found that the originally requested active-row SELECT policy shape still blocked soft-delete in staging: an UPDATE that made `deleted_at` non-null failed because the updated row no longer satisfied the SELECT visibility policy. The follow-up migration keeps ownership as the SELECT RLS boundary and requires active-row lists to query `deleted_at is null` explicitly.

Design result:

- Owner can soft-delete an active row.
- Owner cannot update a row once it is soft-deleted because the UPDATE `USING` clause requires `deleted_at is null`.
- Owner cannot spoof another `user_id` because `WITH CHECK` requires ownership.
- Active-row queries using `deleted_at is null` do not return soft-deleted rows.

## Functional Verification

All checks used authenticated SQL impersonation with `auth.uid()` verified for User A and User B.

### saved_scans

| Check | Result |
|---|---|
| User A inserts own rows | PASS |
| User A updates title | PASS |
| `updated_at` trigger advances | PASS |
| User A sets `deleted_at = now()` | PASS after `202606180002` |
| Active-row SELECT hides soft-deleted row | PASS |
| User B cannot read User A active row | PASS |
| User B cannot update User A row | PASS |
| User A cannot insert with User B `user_id` | PASS |
| Anon cannot read `saved_scans` | PASS |

### legal_acceptances

| Check | Result |
|---|---|
| User A inserts own row | PASS |
| User A reads own row | PASS |
| User A cannot update own row | PASS |
| User A cannot delete own row | PASS |
| User B cannot read User A row | PASS |
| User B cannot insert as User A | PASS |

The immutable unique constraint `(user_id, acceptance_type, policy_version)` was not changed.

### Cross-User Isolation

Owner reads passed and User B was denied read/update/spoof attempts for:

- `profiles`
- `privacy_settings`
- `dressing_rooms`
- `dressing_room_items`
- `inspiration_items`
- `style_chat_sessions`
- `style_chat_messages`
- `style_memory_events`

`profiles` is read-only at user table policy level. `style_memory_events` remains client-read-only for direct table access; User A seeded a row through the existing owner-scoped RPC and read it back.

### dressing_room_messages Model

The deployed model is owner-only:

- User A created a room and inserted a message.
- User A could read the room message.
- User B could not read or insert a message in User A's room.

No membership/share message policy was found or added.

### StyleChat Message Follow-Up

After table grants were fixed, verification found a pre-existing gap: User B could insert a `style_chat_messages` row into User A's session by setting `user_id` to User B. Migration `202606180003` replaced the read/insert policies so both `user_id` ownership and parent session ownership are required.

Retest result:

- User B cannot insert into User A's session.
- User B cannot read User A's message.
- User B cannot read the mismatched-session probe row created before the hardening migration.

## Anon Checks

| Check | Result |
|---|---|
| `anon` public schema usage | true |
| `anon` read `saved_scans` | denied |

Anon schema usage alone does not grant protected table access.

## Legacy Residue Cleanup

### Edge Function

`resend-email` was deployed in staging before cleanup. It was removed with:

```text
supabase functions delete resend-email --project-ref wyyuqfdxucjksghsmhry
```

Final function list no longer includes `resend-email`.

### Storage Bucket

`investor-docs` existed before cleanup as a private legacy bucket with 4 objects.

SQL deletion was blocked by Supabase's storage protection trigger, so cleanup used the supported Storage API path:

```text
supabase --experimental --yes storage rm --linked --recursive ss:///investor-docs
```

Final storage state:

- `style-library-images` remains private.
- `investor-docs` is removed.
- Storage object count is 0.

## Service Role / Secret Scan

No service-role key value was found in client/mobile code.

Expected server-side/env references remain in:

- `scripts/process-deletion-request.js`
- `supabase/functions/handle-user-deletion/index.ts`
- `supabase/functions/privacy-correction-request/index.ts`
- `supabase/functions/privacy-data-export/index.ts`

Existing public anon JWT material was matched in ignored/local config and tracked release QA artifacts. Values were not copied into this report. This is not a `service_role` exposure, but it remains a hygiene note because the scan pattern expects no hardcoded JWT-looking material.

## Feature Flags

`constants/featureFlags.ts` remains default-off/env-driven for:

- `CLOUD_SAVED_SCANS_ENABLED`
- `TEXTSCAN_BACKEND_ENABLED`
- `TEXTSCAN_UI_ENABLED`
- `TEXTSCAN_DEMO_RESULTS_ENABLED`
- `TEXTSCAN_VOICE_PLACEHOLDER_ENABLED`
- `SCAN_RESULTS_V2_UI_ENABLED`
- `SCAN_RESULTS_DEMO_UI_ENABLED`
- `SCAN_ROOM_V2_UI_ENABLED`
- `HOME_NAVIGATION_V2_ENABLED`
- `ONBOARDING_FRAMEWORK_V1_ENABLED`

Targeted env-name search found no overrides for those flags in `.env` or `eas.json`. StyleChat provider configuration remains env-driven inside the Edge Function and was not changed.

## Cleanup Confirmation

Cleanup deleted test child rows first, then public parent rows, then auth users.

Final verification returned 0 rows for:

- auth test users
- `profiles`
- `privacy_settings`
- `legal_acceptances`
- `saved_scans`
- `dressing_rooms`
- `dressing_room_messages`
- `inspiration_items`
- `style_chat_sessions`
- `style_chat_messages`
- `style_memory_events`

## Remaining Blockers

No DB/RLS blocker remains for the staged patch.

Notes:

- Existing tracked public anon JWT material remains outside this task's allowed file scope.
- `saved_scans` active lists must explicitly filter `deleted_at is null`; RLS ownership alone now allows owners to select their own soft-deleted rows for auditability and to permit the soft-delete UPDATE path.

## Final Recommendation

PASS WITH NOTES - staging grants, `saved_scans` soft-delete, StyleChat message isolation, legacy Edge Function cleanup, legacy storage cleanup, and test-data cleanup are complete. KScan App Staging is ready to proceed to the next focused runtime smoke gate, with the anon JWT hygiene note tracked separately.
