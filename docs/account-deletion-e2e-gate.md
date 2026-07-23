# Account Deletion E2E Gate Plan

Last updated: 2026-07-22

This document defines gated verification for the **automatic** account-deletion
lifecycle (30-day grace, restoration, worker) without destroying real users.

## Hard rules

- No destructive operator command runs without explicit approval.
- No production real user is hard-deleted during gate validation except the six
  known tester requests **after** backfill + restoration emails + dry-run review
  + kill-switch enablement.
- No service-role key, JWT, password, restoration token plaintext, or full user
  UUID is pasted into logs, screenshots, or reports.
- Disposable user IDs in reports are truncated to the first 8 characters only.

## Target architecture (post-implementation)

| Component | Role |
|---|---|
| `handle-user-deletion` | Creates `deactivated` lifecycle + restoration email + session revoke |
| `restore-account` | Consumes opaque restoration token |
| `resend-restoration-email` | Enumeration-safe resend (max 3 / 24h) |
| `process-account-deletions` | Protected worker; kill switch + dry-run |
| `scripts/process-deletion-request.js` | Emergency CLI fallback |
| `scripts/preview-deletion-backfill.js` | Read-only preview for legacy `pending` rows |
| `app_config.account_deletion_worker_enabled` | Default **false** |
| `app_config.account_deletion_worker_dry_run` | Default **true** |

## Gate sequence

### G0 — Source / unit

```bash
node --test __tests__/processDeletionRequest.test.js
node --test __tests__/deletionRegistryParity.test.js
node --test __tests__/sevenTableCoverage.test.js
node --test __tests__/accountDeletionLifecycle.test.js
node --test __tests__/handleUserDeletionEdge.test.js
```

### G1 — Migration applied

Confirm columns/RPCs/ledger/kill-switch defaults on the target project.

### G2 — Functions deployed

Deploy (JWT verify on for user-facing; worker may use `--no-verify-jwt` because it
uses the dedicated worker secret):

```bash
supabase functions deploy handle-user-deletion --project-ref <REF> --use-api
supabase functions deploy restore-account --project-ref <REF> --use-api
supabase functions deploy resend-restoration-email --project-ref <REF> --use-api
supabase functions deploy process-account-deletions --project-ref <REF> --no-verify-jwt --use-api
```

Set secrets: `ACCOUNT_DELETION_WORKER_SECRET`, `RESEND_API_KEY` (optional but required for email).

### G3 — Disposable restoration path

1. Create disposable Auth user on staging (preferred) or isolated synthetic account.
2. Call `handle-user-deletion` with that user’s JWT.
3. Confirm `status=deactivated`, `grace_period_ends_at ≈ now+30d`, profile `pending_deletion`.
4. Confirm share links for any shared rooms remain active.
5. Restore via `restore-account` with the emailed token.
6. Confirm `status=restored`, profile `active`, token single-use failure on second call.

### G4 — Race / claim safety

- Attempt restore while a synthetic row is force-claimed → exactly one winner.
- Worker secret missing / anon key → 401.
- Kill switch false → no claim; dry-run lists candidates only.

### G5 — Existing six tester requests

1. `node scripts/preview-deletion-backfill.js` — record deadlines.
2. Review output (no writes).
3. `node scripts/apply-deletion-backfill.js --confirm-backfill` after approval.
4. Send restoration emails.
5. Production-verify **one** restoration.
6. Invoke worker (dry-run) and review candidates.
7. Only then enable kill switch.

### G6 — Scheduler

Hourly schedule for `process-account-deletions` with worker secret header.
`pg_cron` is not installed; use Dashboard schedules.

Start with kill switch OFF.

## Pass criteria for automatic claims

Only after G0–G6:

1. Kill switch enabled by authorized operator
2. Dry-run disabled
3. First live run observed with monitoring

Until then report:

`PASS — DEPLOYED, AUTOMATIC CLAIMS HELD OFF BY KILL SWITCH`

## Rollback

Disable kill switch + dry-run ON + disable schedule. Do not reverse a completed purge.
