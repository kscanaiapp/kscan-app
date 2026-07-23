# Deletion Scheduler Activation Plan — for the independent validation agent

**Status at handoff:** scheduler DISABLED, global kill switch OFF
(`account_deletion_worker_enabled = {"enabled": false}`), dry-run ON
(`account_deletion_worker_dry_run = {"enabled": true}`). Do NOT change these
until the independent verification has completed its own review and the owner
approves go-live.

This plan does not enable anything. It documents exactly how the reviewer/owner
should turn the worker on, what to watch, and how to roll back.

## Deployed components this plan depends on (already live)

- Migrations (applied to project `wyyuqfdxucjksghsmhry`):
  `account_deletion_crash_recovery` (claim reclaim + dry-run guard + retry guard
  + `revoke select`), `account_deletion_rls_active_account`,
  `deletion_ledger_pii_sanitizer`, `profiles_backfill_and_active_account_hardening`,
  `harden_deletion_trigger_function_grants`.
- Edge function `process-account-deletions` (repaired): reclaim call, post-purge
  residual verification, storage reference-protection, `alertEvent()` alerting.
- RPCs `claim_deletion_requests_for_purge`, `reconcile_orphaned_purging_requests`,
  `schedule_deletion_retry_or_fail`, `mark_deletion_request_purged` — all
  `SECURITY DEFINER`, `EXECUTE` granted to `service_role` only.

## Enablement steps (owner/verifier only — DO NOT run during this audit)

1. Keep `account_deletion_worker_dry_run.enabled = true` for the first live
   invocation. Enable the worker: set
   `account_deletion_worker_enabled = {"enabled": true, "updatedAt": "<ts>"}`.
   With dry-run still ON, the claim RPC returns zero rows (verified: DB-layer
   dry-run guard) — this proves the wiring end-to-end without mutating.
2. Confirm the hourly invocation reaches the function (200, `mode: "dry_run"`).
3. Only after a clean dry-run invocation: set
   `account_deletion_worker_dry_run = {"enabled": false}` to allow live purges.

## Schedule

- **Mechanism:** Supabase Dashboard → Edge Functions → Schedules (pg_cron is NOT
  installed on this project; do not add it as part of go-live). The function
  requires header `x-deletion-worker-secret: <ACCOUNT_DELETION_WORKER_SECRET>`.
- **Cadence:** hourly, `0 * * * *`.
- **Timezone:** UTC (all deletion timestamps — `grace_period_ends_at`,
  `requested_at` — are `timestamptz`; the worker compares against `now()` in UTC).

## Worker parameters (as deployed)

| Parameter | Value | Source |
|---|---|---|
| Batch size | 5 per invocation | `process-account-deletions/index.ts` `p_limit: 5` |
| Hard cap | 25 | `claim_deletion_requests_for_purge` `least(coalesce(p_limit,5),25)` |
| Lease duration | 5 minutes | `p_lease default interval '5 minutes'` |
| Heartbeat | between every pipeline step | `heartbeat_deletion_request_lease` |
| Stale-lease reclaim | `status='purging' AND worker_lease_expires_at <= now()` (live-user) + `reconcile_orphaned_purging_requests` (user_id NULL, post-auth-delete) | crash-recovery migration |
| Retry backoff | `2^attempt` minutes, floor 1, cap 240 (4h) | `schedule_deletion_retry_or_fail` |
| Max attempts | 8 (clamped 1–20) → terminal `failed` | same |
| Retry classification | uniform `PURGE_ERROR` (transient vs terminal not differentiated — accepted P3) | worker catch block |

## Durable failure handling

- Per-request `failure_code`/`failure_message`/`attempt_count` on
  `deletion_requests`; every transition appended to append-only
  `deletion_state_transitions` (PII-redacted).
- Attempts exhausted → terminal `status='failed'` (dead-letter). Never silently
  dropped.
- Crash after auth-delete but before mark-purged → `user_id` nulled by FK; the
  row is closed out by `reconcile_orphaned_purging_requests` on the next run.

## Alert thresholds (implemented — emitted to stderr with `"severity":"alert"`)

Configure a log drain / Logflare alert on `severity = "alert"`:
- `ALERT_deletion_request_dead_lettered` — attempts exhausted; manual attention.
- `ALERT_deletion_request_stuck_purging` — `purging` past lease (from dry-run health path).
- `ALERT_deletion_request_failed_seen_in_dry_run` — a `failed` row exists.
- `ALERT_purge_verification_failed` — residual user rows after auth delete.
- `ALERT_storage_partial_removal` — storage `remove()` left objects behind.
- `ALERT_resend_email_failed_after_rotate` — token rotated but email undelivered.

Because the read-only dry-run path emits the `stuck_purging`/`failed` alerts,
running the hourly dry-run while the live scheduler is still disabled already
functions as the stuck-request monitor.

## Rollback procedure (non-destructive)

1. Set `account_deletion_worker_enabled = {"enabled": false}` (halts all NEW
   claims immediately; the DB-layer check in the claim RPC enforces this even
   against a direct service-role call). In-flight `purging` rows finish or
   time out and are reclaimed.
2. Set `account_deletion_worker_dry_run = {"enabled": true}`.
3. Disable the Dashboard schedule.
4. Roll back `process-account-deletions` to a prior version if needed.
5. Migrations are additive `create or replace` / additive policies — prior
   function bodies are recoverable from migration history; no data migration to
   reverse.

## First-run monitoring plan

- Watch the first 3 hourly invocations at dry-run (expect `eligibleCount: 0`
  while dry-run ON, or the true count once OFF) — confirm 200 + no `ALERT_`.
- After enabling live purge, watch the first batch: confirm each request moves
  `deactivated → purging → purged`, `deletion_state_transitions` gets the
  expected chain, and no `ALERT_purge_verification_failed`.
- Confirm no future-grace request is touched (see verification SQL).

## Verification SQL

```sql
-- Eligible now (grace elapsed, active deletion, not restored/purged):
select count(*) from public.deletion_requests dr
join public.profiles p on p.id = dr.user_id
where dr.status='deactivated' and dr.restored_at is null and dr.purged_at is null
  and dr.grace_period_ends_at <= now()
  and coalesce(p.account_status,'active')='pending_deletion';

-- Future-grace rows that MUST remain untouched:
select id, grace_period_ends_at from public.deletion_requests
where status='deactivated' and grace_period_ends_at > now() order by grace_period_ends_at;

-- Stuck / dead-lettered:
select id, status, attempt_count, worker_lease_expires_at from public.deletion_requests
where status in ('purging','failed')
  and (status='failed' or worker_lease_expires_at < now());

-- Guardrail state:
select key, value from public.app_config
where key in ('account_deletion_worker_enabled','account_deletion_worker_dry_run');
```

## Expected treatment of future-grace rows

Future-grace requests (`grace_period_ends_at > now()`) are excluded by the claim
query's `grace_period_ends_at <= now()` predicate and must never be purged early.
The global 30-day grace policy must not be shortened to make any request eligible;
a controlled disposable-account purge test uses a request-scoped server-side
eligibility mechanism (a single row's `grace_period_ends_at`), never the global
policy and never the scheduler.
