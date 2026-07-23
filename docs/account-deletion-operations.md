# K Scan Account Deletion Operations

Last updated: 2026-07-22

## Purpose

This runbook covers K Scan AI’s **automatic account-deletion lifecycle**:

1. Verified request → account **deactivated**
2. **30-day** data preservation + self-service restoration email
3. Shared Dressing Rooms / share links remain active during grace (binding product decision)
4. Automatic worker purge after the grace deadline (kill-switch gated)
5. Manual CLI processor remains as emergency fallback

**Automatic claims are not active until the kill switch is explicitly enabled.** Default production state after this migration:

- `app_config.account_deletion_worker_enabled.enabled = false`
- `app_config.account_deletion_worker_dry_run.enabled = true`

## State model

| Status | Meaning |
|---|---|
| `deactivated` | Grace period active; data retained; account blocked from normal features |
| `restored` | User restored via email token; account active again |
| `purging` | Worker holds a lease and is deleting |
| `purged` | Hard delete finished; Auth user gone; request row survives with `user_id` null |
| `failed` | Retries exhausted |
| `legal_hold` / `legal_hold_until` | Scheduler must not claim |

Legacy statuses `pending` / `processing` may still appear on historical rows until backfill.

### Timing fields

- `requested_at`, `deactivated_at`
- `grace_period_ends_at = requested_at + 30 days` (new requests)
- Restoration token expires **exactly** at `grace_period_ends_at`
- Worker lease: `worker_id`, `worker_lease_expires_at`, `worker_heartbeat_at`

### Surviving lifecycle record

`deletion_requests.user_id` is **nullable** with `ON DELETE SET NULL`.

After Auth deletion the row remains with:

- `subject_ref` (opaque durable id)
- `status = purged`, `purged_at`, `processed_at`
- no email, no restoration token, no raw user id requirement

Append-only ledger: `deletion_state_transitions` (no Auth FK; service-role insert only).

## Request intake

Edge Function: `handle-user-deletion`

- Auth via verified JWT (`auth.getUser`); never trusts client user id
- Creates one active lifecycle (`deactivated`)
- Sets `profiles.account_status = pending_deletion`
- Generates hashed restoration token
- Sends restoration email via **Render transactional email** (`POST /internal/email/account-deletion-restoration`) using `KSCAN_EMAIL_INTERNAL_SECRET` (not direct Resend from Edge)
- Revokes sessions (`auth.admin.signOut(jwt,'global')` + `revoke_user_sessions` RPC)
- Idempotent on duplicate active request
- Does **not** revoke Dressing Room share links during grace

Response shape:

```json
{
  "status": "deactivated",
  "requestedAt": "...",
  "gracePeriodEndsAt": "...",
  "restorationEmailQueued": true
}
```

## Restoration

- URL: `https://kscan.app/account/restore?token=<opaque>`
- Endpoint: `restore-account` (POST `{ "token": "..." }`)
- Atomic RPC `restore_account_by_token_hash` races safely against worker claim
- Single-use; expires at grace deadline
- Resend: `resend-restoration-email` (POST `{ "email": "..." }`) — generic response; max 3 / 24h; does not extend deadline

## Account deactivation enforcement

Server guard: `assertAccountActive(userId)` in `_shared/deletion/common.ts`

Wired into authenticated mutation / paid-provider entry points including:

- `scan-identify`
- `stylechat-generate`
- `tryon-clothes-pro` / `product-search-deals` / `search-vinted-secondhand` (when JWT present)

Returns `403 ACCOUNT_DEACTIVATED`. Fail closed if status cannot be determined.

Client routing remains defense-in-depth only.

## Worker

Edge Function: `process-account-deletions`

### Authorization

Requires dedicated secret `ACCOUNT_DELETION_WORKER_SECRET` via header:

`x-deletion-worker-secret: <secret>`

Anon key is rejected. Do not commit the secret.

### Kill switch / dry-run

Checked on every invocation / before claim:

| Key | Default | Effect |
|---|---|---|
| `account_deletion_worker_enabled` | `false` | Prevents new claims |
| `account_deletion_worker_dry_run` | `true` | Preview only; no purging transition |
| `DELETION_WORKER_DRY_RUN=true` | env | Forces dry-run |

In-flight `purging` work may finish; kill switch only blocks **new** claims.

### Claim / lease

- RPC `claim_deletion_requests_for_purge` (`FOR UPDATE SKIP LOCKED`)
- Batch size 5
- Heartbeat via `heartbeat_deletion_request_lease` (5 minutes)
- Retries: exponential backoff in minutes — `2^attempt` minutes, floored at 1 min and capped at 240 min (4 h); default max 8 attempts (clamp 1–20) → `failed`. (Defined in `schedule_deletion_retry_or_fail`, migration `20260723040000_account_deletion_crash_recovery.sql`. The earlier "1h → 4h → 12h → 24h → 48h / max 5" schedule is superseded and no longer accurate.)

### Final order

1. Own valid lease + grace passed + not restored + no legal hold  
2. Revoke sessions  
3. Direct-delete non-cascade rows  
4. Transfer shared rooms  
5. Delete owned Storage prefixes  
6. Verify registry coverage (incl. seven added tables)  
7. Append `AUTH_DELETE_STARTED`  
8. Delete Auth user last (idempotent if already gone)  
9. Confirm request row survived (`user_id` null)  
10. Mark `purged` + ledger `PURGED`

## Seven-table registry additions

Authoritative registry: `lib/account-deletion/user-data-resources.json`  
Deno mirror: `supabase/functions/_shared/deletion/userDataResources.ts`  
Parity test fails CI on drift.

| Table | Ownership column |
|---|---|
| `user_stylist_preferences` | `user_id` |
| `dressing_room_collab_idempotency` | `actor_id` |
| `shared_room_memberships` | `recipient_user_id` |
| `outfit_decision_votes` | `user_id` |
| `stylechat_quota_events` | `user_id` |
| `style_outfit_burst_usage` | `user_id` |
| `style_outfit_daily_usage` | `user_id` |

These cascade on Auth delete; they are registered so verification is not blind.

## Manual CLI fallback

```bash
node scripts/process-deletion-request.js --list-pending
node scripts/process-deletion-request.js --request-id <uuid> --dry-run
node scripts/process-deletion-request.js --request-id <uuid> --confirm-delete --verify
```

Dry-run by default. Requires `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.

## Existing tester backfill (6 pending rows)

### Preview (read-only)

```bash
node scripts/preview-deletion-backfill.js
# or SQL: select * from public.preview_pending_deletion_backfill();
```

Deadline rule (runtime `now()`):

```sql
greatest(requested_at + interval '30 days', now() + interval '7 days')
```

Never shortens the original 30-day deadline.

### Apply (explicit confirm)

```bash
node scripts/apply-deletion-backfill.js --confirm-backfill [--write-tokens-file <path>]
```

Then send restoration emails (Resend / resend function). Do **not** enable the kill switch until:

1. Preview reviewed  
2. Backfill applied  
3. Restoration emails sent  
4. One restoration production-verified  
5. Worker dry-run output reviewed  

## Scheduler

`pg_cron` is **not** installed on production. Prefer Supabase Dashboard → Edge Functions → Schedules:

- Function: `process-account-deletions`
- Cron: `0 * * * *` (hourly)
- Header: `x-deletion-worker-secret: <ACCOUNT_DELETION_WORKER_SECRET>`

Start with kill switch **OFF** and dry-run **ON**.

## Legal hold

```sql
-- Apply hold (service role / SQL editor)
update public.deletion_requests
set legal_hold_until = now() + interval '90 days',
    status = 'legal_hold',
    updated_at = now()
where id = '<request_id>';

select public.append_deletion_state_transition(
  '<request_id>', '<subject_ref>', 'deactivated', 'legal_hold', 'admin', 'ops', 'LEGAL_HOLD', '{}'::jsonb
);

-- Clear hold
update public.deletion_requests
set legal_hold_until = null,
    status = 'deactivated',
    updated_at = now()
where id = '<request_id>';
```

Holds do not reactivate the account. Users must not see investigation details.

## Monitoring (structured logs)

Events: `deletion_request_accepted`, `session_revocation_*`, `restoration_*`, `worker_invocation`, `worker_claim`, `purge_success`, `purge_failure`, `kill_switch_skip`, `resend_*`.

### Operator alerts (implemented — Finding P1-4)

Alertable conditions are now emitted actively as structured **stderr** log lines
with a stable `"severity":"alert"` marker and an `ALERT_`-prefixed `event`
(via `alertEvent()` in `_shared/deletion/common.ts`). Configure a Supabase log
drain / Logflare alert on `severity = "alert"` (no external alerting
integration is required — the marker is the trigger). Emitted alerts:

| Event | Emitted from | Meaning |
|---|---|---|
| `ALERT_deletion_request_dead_lettered` | live worker, on terminal `failed` | attempts exhausted; a partially-purged user needs manual attention |
| `ALERT_deletion_request_failed_seen_in_dry_run` | dry-run health check | a `failed` row exists and won't self-resolve |
| `ALERT_deletion_request_stuck_purging` | dry-run health check | a `purging` row past its lease (crashed worker not yet reclaimed) |
| `ALERT_purge_verification_failed` | live worker | residual user rows found after Auth delete; request will retry then dead-letter |
| `ALERT_storage_partial_removal` | live worker | storage `remove()` left objects behind; request will retry |
| `ALERT_resend_email_failed_after_rotate` | resend function | token rotated but email delivery failed; user has no working link until next resend |

Because the read-only dry-run path emits `stuck_purging` / `failed` alerts,
running the hourly dry-run (kill switch OFF, dry-run ON) doubles as the
stuck-request monitor even while the live purge scheduler is disabled.

Still operator-configured (outside code): "deadline passed but never claimed"
and "scheduler silence (no hourly invocation)" — both require a scheduler-side
heartbeat/monitor that the repo cannot assert on its own.

## Rollback (non-destructive)

1. Set `account_deletion_worker_enabled.enabled = false`
2. Set `account_deletion_worker_dry_run.enabled = true`
3. Disable Dashboard schedule
4. Roll back Edge Function versions if needed
5. Request intake / restoration can remain available

Do **not** attempt to roll back a completed hard deletion.

## Email provider

Smallest approved path: **Supabase Edge → Render `/internal/email/account-deletion-restoration` → Resend**.

Required Edge secrets:

| Secret | Purpose |
|---|---|
| `KSCAN_EMAIL_RENDER_URL` | Base URL only (`https://kscan-app-1.onrender.com`) |
| `KSCAN_EMAIL_INTERNAL_SECRET` | Same value as Render `KSCAN_EMAIL_INTERNAL_SECRET` |
| `ACCOUNT_DELETION_WORKER_SECRET` | Worker / scheduler auth |
| `ACCOUNT_RESTORATION_BASE_URL` | Optional; default `https://kscan.app/account/restore` |

Do **not** put `RESEND_API_KEY` on Supabase for deletion mail. Resend stays on Render only.

If unset, request still succeeds; `restorationEmailQueued` is false and ops must deliver tokens via backfill file / support process.

## Secrets checklist

| Secret | Where |
|---|---|
| `ACCOUNT_DELETION_WORKER_SECRET` | Edge Function secrets |
| `KSCAN_EMAIL_RENDER_URL` | Edge Function secrets |
| `KSCAN_EMAIL_INTERNAL_SECRET` | Edge Function secrets (matches Render) |
| `RESEND_API_KEY` | Render only |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge runtime (existing) |
| Service role for CLI | Operator environment only |

## Production release gates

Do not claim **PASS — AUTOMATIC DELETION ACTIVE** until:

1. Migration applied  
2. Functions deployed  
3. Restoration verified in production  
4. Dry-run worker observed  
5. Kill switch explicitly enabled by an authorized operator  

Until then the correct verdict is **PASS — DEPLOYED, AUTOMATIC CLAIMS HELD OFF BY KILL SWITCH** (or conditional if deploy pending).
