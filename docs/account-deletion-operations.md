# K Scan Account Deletion Operations

Last updated: 2026-07-07

## Purpose

This runbook gives the release owner a manual account-erasure path for the current App Store submission build. The app already lets an authenticated user submit an in-app deletion request through the `handle-user-deletion` Edge Function. This runbook covers the operator step that completes the request within the stated 30-day window.

## Current Data Map

- `auth.users`: Supabase Auth account record.
- `public.profiles`: account profile row, references `auth.users(id)` with `on delete cascade`.
- `public.privacy_settings`: privacy preference row, references `auth.users(id)` with `on delete cascade`.
- `public.privacy_export_requests`: export request rows, references `auth.users(id)` with `on delete cascade`.
- `public.privacy_correction_requests`: correction request rows, references `auth.users(id)` with `on delete cascade`.
- `public.deletion_requests`: deletion request rows, references `auth.users(id)` with `on delete cascade`.
- `public.legal_acceptances`: legal/age acceptance rows, references `auth.users(id)` with `on delete cascade`.
- `public.saved_scans`: cloud scan metadata, references `auth.users(id)` with `on delete cascade`. Raw scan images remain local unless explicitly uploaded into room/library storage.
- `public.dressing_rooms`, `public.looks`, `public.room_shares`: user-owned room/look/share rows, reference `auth.users(id)` with `on delete cascade`.
- `public.dressing_room_items`, `public.look_items`: child rows removed through their parent room/look cascade.
- `public.dressing_room_messages`, `public.dressing_room_item_reactions`, `public.dressing_room_participants`: user-authored or membership collaboration rows, reference `auth.users(id)` with `on delete cascade`.
- `public.inspiration_items`, `public.dressing_room_inspiration_items`: user-uploaded inspiration metadata and room links, reference `auth.users(id)` with `on delete cascade`.
- `public.style_chat_sessions`, `public.style_chat_messages`, `public.style_memory_events`, `public.style_chat_usage`, `public.style_chat_daily_usage`: StyleChat content, memory, and usage rows, reference `auth.users(id)` with `on delete cascade`.
- `public.scan_identify_usage_daily`: authenticated scan quota rows, references `auth.users(id)` with `on delete cascade`.
- `public.content_reports`: optional moderation report rows. Reports filed by the deleted user cascade through `reporter_user_id`; reports about the deleted user are retained for moderation with `reported_user_id` set null.
- `public.wardrobe_*` free-tier sync tables: optional user-scoped utility rows, reference `auth.users(id)` with `on delete cascade` when those beta migrations are deployed.
- `public.style_chat_burst_usage`: StyleChat burst limiter rows. This table does not declare an Auth foreign key, so the processor deletes matching `user_id` rows before deleting the Auth user.
- `public.scan_intelligence_events`: optional scan intelligence/audit rows where deployed. The processor best-effort deletes matching `user_id` rows before deleting the Auth user and skips cleanly if the table is not present.
- `storage.objects` in bucket `style-library-images`: uploaded room/library image objects under `{userId}/scans/` and `{userId}/inspirations/`. The processor removes only those owned prefixes before deleting the Auth user.
- Local saved scans/thumbnails: stored in the app sandbox by `expo-file-system`. They are removed by in-app delete or app uninstall and are not server-side Supabase rows.

## Deletion Method Reference Table

The operator script follows this table. Tables marked **optional** are skipped without error if the migration is not deployed.

| Table | User-link column | Deletion method | Order |
|---|---|---|---|
| `public.style_chat_burst_usage` | `user_id` | Direct delete before auth delete | 1 |
| `public.scan_intelligence_events` | `user_id` | Direct delete before auth delete (skip if missing) | 2 |
| `public.dressing_rooms` | `user_id` | Transfer shared rooms to earliest **active** participant, then auth cascade | 3 |
| `storage.objects` (`style-library-images`) | path prefix `{userId}/scans/`, `{userId}/inspirations/` | Direct storage delete before auth delete | 4 |
| `auth.users` | `id` | Delete auth user; triggers all auth cascades | 5 |
| `public.profiles` | `id` | Auth delete cascade | 6 |
| `public.privacy_settings` | `user_id` | Auth delete cascade | 6 |
| `public.privacy_export_requests` | `user_id` | Auth delete cascade | 6 |
| `public.privacy_correction_requests` | `user_id` | Auth delete cascade | 6 |
| `public.deletion_requests` | `user_id` | Auth delete cascade | 6 |
| `public.legal_acceptances` | `user_id` | Auth delete cascade | 6 |
| `public.saved_scans` | `user_id` | Auth delete cascade | 6 |
| `public.dressing_room_inspiration_items` | `user_id` | Auth delete cascade | 6 |
| `public.dressing_room_item_reactions` | `user_id` | Auth delete cascade | 6 |
| `public.dressing_room_messages` | `sender_id` | Auth delete cascade | 6 |
| `public.dressing_room_participants` | `user_id` | Auth delete cascade | 6 |
| `public.room_shares` | `owner_id` | Auth delete cascade | 6 |
| `public.looks` | `user_id` | Auth delete cascade | 6 |
| `public.inspiration_items` | `user_id` | Auth delete cascade | 6 |
| `public.style_chat_sessions` | `user_id` | Auth delete cascade | 6 |
| `public.style_chat_messages` | `user_id` | Auth delete cascade | 6 |
| `public.style_memory_events` | `user_id` | Auth delete cascade | 6 |
| `public.style_chat_usage` | `user_id` | Auth delete cascade | 6 |
| `public.style_chat_daily_usage` | `user_id` | Auth delete cascade | 6 |
| `public.scan_identify_usage_daily` | `user_id` | Auth delete cascade | 6 |
| `public.content_reports` | `reporter_user_id` | Auth delete cascade (optional) | 6 |
| `public.content_reports` | `reported_user_id` | Auth delete set null (optional moderation retention) | 6 |
| `public.wardrobe_utility_items` | `user_id` | Auth delete cascade (optional) | 6 |
| `public.wardrobe_collections` | `user_id` | Auth delete cascade (optional) | 6 |
| `public.wardrobe_collection_items` | `user_id` | Auth delete cascade (optional) | 6 |
| `public.wardrobe_brand_sizing_notes` | `user_id` | Auth delete cascade (optional) | 6 |
| `public.wardrobe_outfit_feedback` | `user_id` | Auth delete cascade (optional) | 6 |
| `public.wardrobe_care_notes` | `user_id` | Auth delete cascade (optional) | 6 |
| `public.wardrobe_wishlist_intents` | `user_id` | Auth delete cascade (optional) | 6 |
| `public.wardrobe_wear_events` | `user_id` | Auth delete cascade (optional) | 6 |
| `public.wardrobe_activity_log` | `user_id` | Auth delete cascade (optional) | 6 |
| `public.dressing_room_items` | `dressing_room_id` | Parent cascade via `dressing_rooms` | 7 |
| `public.look_items` | `look_id` | Parent cascade via `looks` | 7 |
| `public.app_config` | — | Not user-linked; intentionally skipped | — |
| `public.product_catalog` | — | Not user-linked; intentionally skipped | — |

**Deletion order summary:**
1. Direct-delete non-cascade rows (`style_chat_burst_usage`, `scan_intelligence_events`).
2. Transfer shared `dressing_rooms` to the earliest remaining **active** participant (verified profile and auth user existence).
3. Delete owned `style-library-images` storage objects.
4. Delete the Supabase Auth user, which cascades all `auth.users` foreign-key rows.
5. Parent-cascade tables are cleaned up automatically by step 4; optional moderation reports about the deleted user are retained with `reported_user_id` set null.

## Service-Role Client Requirement

The operator script **must** create a Supabase client with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` and use it for all delete operations. The anon key must never be used for deletion processing. The script aborts if either environment variable is missing.

## Storage Buckets and Prefixes

Based on the discovery audit, only one storage bucket currently holds user-owned objects:

| Bucket | User-owned prefixes | Action |
|---|---|---|
| `style-library-images` | `{userId}/scans/` | Delete all objects under prefix |
| `style-library-images` | `{userId}/inspirations/` | Delete all objects under prefix |

Other buckets (e.g., legacy `investor-docs`) are not user-owned and are intentionally skipped. If a future feature adds a new user-owned prefix, add it to `STORAGE_RESOURCES` in `scripts/process-deletion-request.js` and update this table.

## Shared Room Safety

`dressing_rooms` cascade-deletes dependent rows (`dressing_room_items`, `dressing_room_messages`, `dressing_room_participants`, `room_shares`, etc.) when the owning user is removed. To avoid removing other participants' data, the processor now applies the following policy before calling `auth.admin.deleteUser`:

- For each `dressing_rooms` row owned by the deleted user, inspect `dressing_room_participants` ordered by `created_at` ascending.
- Validate each candidate in order until one passes all checks:
  - A `profiles` row exists for the candidate.
  - `profiles.account_status` is `active` (not `pending_deletion`, `locked`, `suspended`, or `deleted`).
  - The candidate still exists in `auth.users`.
- Transfer room ownership to the first valid candidate (`dressing_rooms.user_id = participant.user_id`).
- If no valid candidate exists, log `no_valid_recipient` and leave the room to cascade normally with the owner.
- The original owner's messages, reactions, and inspiration links are still removed by the auth cascade.
- `room_shares` rows for the original owner are removed by the auth cascade; the new owner can generate a fresh share link if desired.
- Rooms with no other participants are left to cascade normally and are fully removed with the owner.

## Intake Behavior

When the user taps Delete Account in the app, `supabase/functions/handle-user-deletion`:

1. Verifies the caller's bearer token with Supabase Auth and validates the returned user ID is a UUID.
2. Refuses duplicate open requests (`pending` or `processing`) for the same account.
3. Inserts a `deletion_requests` row with status `pending`.
4. Marks the profile `account_status = 'pending_deletion'`.
5. Returns the request ID and timestamp to the client.

The app then shows a native confirmation alert before sign-out. On future sign-in, pending or locked accounts are limited to Privacy controls and cannot continue to scan or library routes.

## Manual Processing Command

Use the tracked processor script from the mobile repo. It defaults to dry-run and requires an explicit confirmation flag before deleting anything.

```powershell
$env:SUPABASE_URL="https://<project-ref>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"

node scripts/process-deletion-request.js --list-pending
node scripts/process-deletion-request.js --request-id "<request-id>"
node scripts/process-deletion-request.js --request-id "<request-id>" --confirm-delete --output-dir "qa/deletion-processing"
node scripts/process-deletion-request.js --request-id "<request-id>" --confirm-delete --output-dir "qa/deletion-processing" --verify
```

The `--verify` flag runs a read-only completeness check after deletion and reports any residual rows. It is safe to add to every confirmed run.

You may use `--user-id "<auth-user-id>"` instead of `--request-id` when working from a support ticket that records the Supabase user ID.

## Operator Checklist

1. Confirm the request came from the authenticated in-app deletion path or a matching support ticket.
2. Run a dry-run for the request and review the partial user ID, request ID, request timestamp, linked row counts, and the shared-room transfer summary.
3. Confirm no legal hold, fraud/security exception, or billing obligation applies. This release has no in-app purchases or subscriptions.
4. Run with `--confirm-delete`.
5. Save the generated audit JSON path or terminal output in the support ticket.
6. Reply to the user, if contact is available, that the account deletion request has been processed.

## What The Processor Does

On confirmed processing, `scripts/process-deletion-request.js`:

1. Marks the deletion request `processing`.
2. Locks the profile with `account_status = 'pending_deletion'` and `account_locked_at`.
3. Transfers any shared dressing rooms to the earliest remaining active participant (see Shared Room Safety above), or records `no_valid_recipient` when no active participant exists.
4. Removes owned storage objects from `style-library-images` under `{userId}/scans/` and `{userId}/inspirations/`.
5. Deletes known user-linked non-cascade rows such as `style_chat_burst_usage` and optional `scan_intelligence_events`.
6. Calls `supabase.auth.admin.deleteUser(user_id)` last.
7. Relies on the schema's `on delete cascade` foreign keys to remove the user's remaining linked public rows.
8. Optionally writes a local audit JSON file outside the app data path, using a partial user ID only. The audit includes the room-transfer result, storage results, direct-deletion results, and deletion coverage map.

Because `deletion_requests` currently cascades from `auth.users`, the request row is expected to be removed with the Auth user. Keep the generated audit JSON or support-ticket note as the operational completion record.

## Post-Deletion Verification

When `--verify` is passed, the operator script performs a read-only check after auth deletion:

- Counts rows in every user-linked table by the mapped user-link column.
- Checks that the auth user no longer exists.
- Reports any residual data as `verification.residuals`.

Verification intentionally excludes parent-cascade tables (`dressing_room_items`, `look_items`) because their lifecycle is governed by the parent row, and excludes `deletion_requests` because it is the operational request record.

## Audit Logging

The operator script emits a machine-readable JSON summary for every confirmed run. The summary includes:

- `deletionRequestId`
- `userId`: first 8 characters only
- `authUserDeleted`: `true` when `auth.admin.deleteUser` succeeded
- `roomTransferResults`: shared rooms transferred to a new owner
- `storageResults`: storage prefixes processed and object counts
- `directDeletionResults`: non-cascade rows deleted
- `auditFile`: local path of the full audit JSON
- `verification`: result of the `--verify` completeness check (if enabled)

Save this JSON or the terminal output in the support ticket for compliance.

## Active Sessions After Auth Deletion

After `auth.admin.deleteUser()` succeeds, the user's existing JWTs remain technically valid until they expire. Supabase does not provide a service-role method to revoke a specific user's sessions in the JS client. The app signs the user out immediately after submitting the deletion request, and pending-deletion accounts are blocked from normal app use on the next token refresh. If a future Supabase client version exposes user-specific session revocation, add it to the processor as an optional step.

## App Review Statement

For App Review notes, use wording like:

> Users can request account deletion in the app from Privacy > Delete Account. The request is recorded server-side, the account is marked pending deletion, and pending-deletion accounts are blocked from normal app use. K Scan processes deletion requests manually using a service-role Supabase operator script and completes eligible requests within 30 days.

Do not claim instant deletion or automated downstream erasure until a production job replaces this manual process and has been verified.
