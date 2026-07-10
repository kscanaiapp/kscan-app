# Account Deletion E2E Gate Plan

This document defines the safe, gated steps for end-to-end verification of the
account-deletion flow without touching real users.

## Hard rules

- No destructive operator command runs without explicit approval.
- No production real user is deleted.
- No service-role key, JWT, password, or full user UUID is pasted into logs,
  shell arguments, screenshots, or reports.
- All examples use placeholders (`<STAGING_PROJECT_REF>`,
  `<DISPOSABLE_USER_ID>`).
- Disposable user IDs in reports are truncated to the first 8 characters only.

## Current state

- `handle-user-deletion` Edge Function validates the caller JWT and creates a
  pending `deletion_requests` row.
- `scripts/process-deletion-request.js` performs service-role erasure,
  shared-room transfer, storage cleanup, and auth user deletion.
- Local env files (`.env`, `.env.local`, `eas.json`) currently point to the
  production project (`wyyuqfdxucjksghsmhry`).
- No staging/test Supabase project is configured in the repo.

## Path A — Preferred: staging/test project

### Prerequisites

1. A separate Supabase project exists for non-production verification.
2. Local env is temporarily pointed at that project (never commit the change).
3. The project has the same schema/migrations as production.

### Deployment steps

```bash
# 1. Link to the staging/test project (do not link production).
supabase link --project-ref <STAGING_PROJECT_REF>

# 2. Apply pending migrations, including quota migration.
supabase db push --project-ref <STAGING_PROJECT_REF>

# 3. Deploy account-deletion intake function.
supabase functions deploy handle-user-deletion --project-ref <STAGING_PROJECT_REF> --use-api

# 4. Deploy scan-identify if quota changes depend on it.
supabase functions deploy scan-identify --project-ref <STAGING_PROJECT_REF> --no-verify-jwt --use-api
```

### Seed disposable data

- Create two disposable users via Supabase Auth:
  - `owner@example.test`
  - `participant@example.test`
- Create `profiles` rows with `account_status = 'active'`.
- Create a shared `dressing_rooms` row owned by the owner.
- Add both users to `dressing_room_participants`.
- Add `dressing_room_messages`, `saved_scans`, and owned storage objects under
  `style-library-images/{ownerId}/scans/`.

### Run the deletion flow

```bash
# Intake: authenticated request from the owner.
# Use the owner's access token; no user ID in body.
curl -X POST https://<STAGING_PROJECT_REF>.supabase.co/functions/v1/handle-user-deletion \
  -H "Authorization: Bearer <OWNER_ACCESS_TOKEN>" \
  -H "Content-Type: application/json"

# Operator: dry-run first.
node scripts/process-deletion-request.js \
  --user-id <OWNER_USER_ID> \
  --dry-run \
  --output-dir qa/deletion-processing

# Operator: confirm-delete only after dry-run is reviewed.
node scripts/process-deletion-request.js \
  --user-id <OWNER_USER_ID> \
  --confirm-delete \
  --verify \
  --output-dir qa/deletion-processing
```

### Verification checklist

- [ ] Owner auth user no longer exists.
- [ ] Owner `profiles` row is gone.
- [ ] Owner `saved_scans`, `looks`, `style_chat_sessions`, etc. are gone.
- [ ] Shared `dressing_rooms` ownership transferred to the active participant.
- [ ] Participant's messages/items in the room remain.
- [ ] `style-library-images/{ownerId}/scans/` and `.../inspirations/` are empty.
- [ ] `deletion_requests` row for the owner is gone.
- [ ] Audit JSON contains only partial user IDs and no email addresses.

## Path B — Fallback: production disposable test

Only use this path if:

- No staging/test project is available, **and**
- Justin gives explicit written approval.

### Additional constraints

- Create fresh disposable users specifically for the test.
- Use fake/test email addresses, not real user data.
- Run dry-run and review output before any `--confirm-delete`.
- Use `--output-dir qa/deletion-processing` so evidence is captured locally.
- Sanitize any shared report: partial user IDs only, no emails, no full UUIDs.

```bash
# Intake (production, disposable owner only).
curl -X POST https://wyyuqfdxucjksghsmhry.supabase.co/functions/v1/handle-user-deletion \
  -H "Authorization: Bearer <DISPOSABLE_OWNER_ACCESS_TOKEN>" \
  -H "Content-Type: application/json"

# Dry-run.
node scripts/process-deletion-request.js \
  --user-id <DISPOSABLE_OWNER_USER_ID> \
  --dry-run \
  --output-dir qa/deletion-processing

# Confirm-delete only after Justin reviews dry-run evidence.
node scripts/process-deletion-request.js \
  --user-id <DISPOSABLE_OWNER_USER_ID> \
  --confirm-delete \
  --verify \
  --output-dir qa/deletion-processing
```

## Read-only post-deploy checks

After any deploy, run these checks before user-facing validation.

### Quota table and RPC

```sql
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename = 'scan_identify_usage_daily';

SELECT proname
FROM pg_proc
WHERE proname = 'check_and_increment_scan_identify_daily_usage';

SELECT schemaname, tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'scan_identify_usage_daily';
```

### CORS / OPTIONS smoke test

```bash
curl -X OPTIONS https://<PROJECT_REF>.supabase.co/functions/v1/scan-identify \
  -H "Origin: https://kscan.app" \
  -H "Access-Control-Request-Method: POST"
```

Expected: HTTP 200 with CORS headers.

### Unauthenticated deletion rejection

```bash
curl -X POST https://<PROJECT_REF>.supabase.co/functions/v1/handle-user-deletion \
  -H "Content-Type: application/json" \
  -d "{}"
```

Expected: HTTP 401 with `error: 'Authentication required'`; no request row
created.

## Rollback / recovery

- Record deployed function version IDs before deploy.
- If a function regresses, redeploy the prior known-good source from the
  previous commit/tag.
- If the quota migration causes issues, prepare a reviewed corrective migration;
  do **not** run `supabase db reset` on production.
- The quota check is designed to fail open, so a broken quota table should not
  hard-block scans, but it must be corrected promptly.

## Approval gates

| Step | Approval required |
|---|---|
| Staging/test project setup | Justin |
| `supabase db push` to production | Justin + migration review |
| `supabase functions deploy` to production | Justin |
| Disposable production test | Explicit written approval from Justin |
| `--confirm-delete` operator run | Dry-run evidence reviewed + Justin approval |
