# K Scan Account Deletion Operations

Last updated: 2026-06-12

## Purpose

This runbook gives the release owner a manual account-erasure path for the current App Store submission build. The app already lets an authenticated user submit an in-app deletion request through the `handle-user-deletion` Edge Function. This runbook covers the operator step that completes the request within the stated 30-day window.

## Current Data Map

- `auth.users`: Supabase Auth account record.
- `public.profiles`: account profile row, references `auth.users(id)` with `on delete cascade`.
- `public.privacy_settings`: privacy preference row, references `auth.users(id)` with `on delete cascade`.
- `public.privacy_export_requests`: export request rows, references `auth.users(id)` with `on delete cascade`.
- `public.privacy_correction_requests`: correction request rows, references `auth.users(id)` with `on delete cascade`.
- `public.deletion_requests`: deletion request rows, references `auth.users(id)` with `on delete cascade`.
- Local saved scans: stored in the app sandbox by `expo-file-system`, not in Supabase. Users can remove saved scans in the app before deletion or remove them by uninstalling the app.

## Intake Behavior

When the user taps Delete Account in the app, `supabase/functions/handle-user-deletion`:

1. Verifies the caller's bearer token with Supabase Auth.
2. Refuses duplicate open requests for the same account.
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
2. Run a dry-run for the request and review the user ID, email, request timestamp, and linked row counts.
3. Confirm no legal hold, fraud/security exception, or billing obligation applies. This release has no in-app purchases or subscriptions.
4. Run with `--confirm-delete`.
5. Save the generated audit JSON path or terminal output in the support ticket.
6. Reply to the user, if contact is available, that the account deletion request has been processed.

## What The Processor Does

On confirmed processing, `scripts/process-deletion-request.js`:

1. Marks the deletion request `processing`.
2. Locks the profile with `account_status = 'pending_deletion'` and `account_locked_at`.
3. Calls `supabase.auth.admin.deleteUser(user_id)`.
4. Relies on the schema's `on delete cascade` foreign keys to remove the user's linked public rows.
5. Optionally writes a local audit JSON file outside the app data path.

Because `deletion_requests` currently cascades from `auth.users`, the request row is expected to be removed with the Auth user. Keep the generated audit JSON or support-ticket note as the operational completion record.

## App Review Statement

For App Review notes, use wording like:

> Users can request account deletion in the app from Privacy > Delete Account. The request is recorded server-side, the account is marked pending deletion, and pending-deletion accounts are blocked from normal app use. K Scan processes deletion requests manually using a service-role Supabase operator script and completes eligible requests within 30 days.

Do not claim instant deletion or automated downstream erasure until a production job replaces this manual process and has been verified.
