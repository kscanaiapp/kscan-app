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
- `public.wardrobe_*` free-tier sync tables: optional user-scoped utility rows, reference `auth.users(id)` with `on delete cascade` when those beta migrations are deployed.
- `public.style_chat_burst_usage`: StyleChat burst limiter rows. This table does not declare an Auth foreign key, so the processor deletes matching `user_id` rows before deleting the Auth user.
- `public.scan_intelligence_events`: optional scan intelligence/audit rows where deployed. The processor best-effort deletes matching `user_id` rows before deleting the Auth user and skips cleanly if the table is not present.
- `storage.objects` in bucket `style-library-images`: uploaded room/library image objects under `{userId}/scans/` and `{userId}/inspirations/`. The processor removes only those owned prefixes before deleting the Auth user.
- Local saved scans/thumbnails: stored in the app sandbox by `expo-file-system`. They are removed by in-app delete or app uninstall and are not server-side Supabase rows.

## Shared Room Safety

`dressing_rooms` cascade-deletes dependent rows (`dressing_room_items`, `dressing_room_messages`, `dressing_room_participants`, `room_shares`, etc.) when the owning user is removed. To avoid removing other participants' data, the processor now applies the following policy before calling `auth.admin.deleteUser`:

- For each `dressing_rooms` row owned by the deleted user, inspect `dressing_room_participants` ordered by `created_at` ascending.
- If another participant exists, transfer room ownership to the earliest joined participant (`dressing_rooms.user_id = participant.user_id`).
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
```

You may use `--user-id "<auth-user-id>"` instead of `--request-id` when working from a support ticket that records the Supabase user ID.

## Operator Checklist

1. Confirm the request came from the authenticated in-app deletion path or a matching support ticket.
2. Run a dry-run for the request and review the user ID, email, request timestamp, linked row counts, and the shared-room transfer summary.
3. Confirm no legal hold, fraud/security exception, or billing obligation applies. This release has no in-app purchases or subscriptions.
4. Run with `--confirm-delete`.
5. Save the generated audit JSON path or terminal output in the support ticket.
6. Reply to the user, if contact is available, that the account deletion request has been processed.

## What The Processor Does

On confirmed processing, `scripts/process-deletion-request.js`:

1. Marks the deletion request `processing`.
2. Locks the profile with `account_status = 'pending_deletion'` and `account_locked_at`.
3. Transfers any shared dressing rooms to the earliest remaining participant (see Shared Room Safety above).
4. Removes owned storage objects from `style-library-images` under `{userId}/scans/` and `{userId}/inspirations/`.
5. Deletes known user-linked non-cascade rows such as `style_chat_burst_usage` and optional `scan_intelligence_events`.
6. Calls `supabase.auth.admin.deleteUser(user_id)` last.
7. Relies on the schema's `on delete cascade` foreign keys to remove the user's remaining linked public rows.
8. Optionally writes a local audit JSON file outside the app data path, using a partial user ID only. The audit includes the room-transfer result, storage results, direct-deletion results, and deletion coverage map.

Because `deletion_requests` currently cascades from `auth.users`, the request row is expected to be removed with the Auth user. Keep the generated audit JSON or support-ticket note as the operational completion record.

## App Review Statement

For App Review notes, use wording like:

> Users can request account deletion in the app from Privacy > Delete Account. The request is recorded server-side, the account is marked pending deletion, and pending-deletion accounts are blocked from normal app use. K Scan processes deletion requests manually using a service-role Supabase operator script and completes eligible requests within 30 days.

Do not claim instant deletion or automated downstream erasure until a production job replaces this manual process and has been verified.
