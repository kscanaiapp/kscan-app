# Automatic Account Deletion — Implementation Handoff

Date: 2026-07-22  
Workspace: `C:\Users\jsmit\KScan-account-deletion` (clean worktree)  
Branch: `feature/automatic-account-deletion`  
Starting HEAD: `0c9086af9257b8ef002b7d2c479bf3da43ca0b9b`  
Final HEAD (uncommitted implementation): same base; changes not yet committed  
Original dirty workspace preserved: `C:\Users\jsmit\KScan` on `ios/full-submission-readiness-v2`

Production project: `wyyuqfdxucjksghsmhry`

## Verdict

**PASS — DEPLOYED, AUTOMATIC CLAIMS HELD OFF BY KILL SWITCH**

## What shipped

### Database (DEPLOYED VERIFIED)

- Migration applied: `20260722191013_account_deletion_lifecycle`
- `deletion_requests.user_id` → nullable, `ON DELETE SET NULL` (DEPLOYED VERIFIED)
- Lifecycle columns, indexes, constraints (DEPLOYED VERIFIED)
- `deletion_state_transitions` ledger (DEPLOYED VERIFIED)
- Kill switch defaults: enabled=false, dry_run=true (DEPLOYED VERIFIED)
- RPCs: claim, heartbeat, restore, rotate token, preview backfill, mark purged, retry/fail, revoke sessions, get_my_deletion_status

### Edge Functions (DEPLOYED VERIFIED)

| Function | JWT | Notes |
|---|---|---|
| `handle-user-deletion` | verify on | deactivated lifecycle + email + session revoke |
| `restore-account` | verify on | opaque token restore |
| `resend-restoration-email` | verify on | enumeration-safe |
| `process-account-deletions` | no-verify-jwt | worker secret required |
| `stylechat-generate` | verify on | account-active guard |
| `scan-identify` | no-verify-jwt (existing) | account-active guard when authenticated |
| `tryon-clothes-pro` / `product-search-deals` / `search-vinted-secondhand` | | guard when JWT present |

Worker secret set as Edge secret `ACCOUNT_DELETION_WORKER_SECRET` (not committed).

### Tester backfill (DEPLOYED VERIFIED)

- Preview computed for all 6 pending rows (deadlines use max(requested+30d, now+7d))
- Controlled backfill applied: all 6 now `deactivated` with grace + hashed restoration tokens
- Ledger: 6 `TESTER_BACKFILL` transitions
- Plaintext tokens: `qa/deletion-backfill/restoration-tokens.local.json` (gitignored) — **must be emailed manually until RESEND_API_KEY is configured**

Final proposed deadlines (from preview/backfill):

| Request prefix | Final grace deadline (UTC) |
|---|---|
| 039c645b | 2026-08-06T19:58:29Z |
| fe2d1b6f | 2026-08-06T19:59:08Z |
| 656b0c8b | 2026-08-06T20:00:15Z |
| ef018427 | 2026-08-06T20:00:37Z |
| 08d4882e | 2026-08-06T20:01:13Z |
| 3c78f1bd | 2026-08-14T01:05:04Z |

### Worker runtime check (RUNTIME VERIFIED)

- Dry-run with secret → 200 `{ mode: dry_run, killSwitchEnabled: false, candidates: [] }`
- Without secret → 401
- Candidates empty because grace deadlines are still in the future (expected)

### Tests (SOURCE VERIFIED)

```text
node --test __tests__/processDeletionRequest.test.js \
  __tests__/deletionRegistryParity.test.js \
  __tests__/sevenTableCoverage.test.js \
  __tests__/accountDeletionLifecycle.test.js \
  __tests__/handleUserDeletionEdge.test.js
→ 54 pass / 0 fail
```

## Remaining gates before enabling claims

1. Configure `RESEND_API_KEY` (+ optional `RESTORATION_EMAIL_FROM`) and send restoration emails for the 6 testers (or deliver via the local token file).
2. Production-verify one restoration via `restore-account`.
3. Create Dashboard hourly schedule for `process-account-deletions` with `x-deletion-worker-secret` (`pg_cron` not installed).
4. Observe scheduled dry-runs.
5. Explicitly set `account_deletion_worker_enabled.enabled = true` and `account_deletion_worker_dry_run.enabled = false`.

## Accepted non-blockers

- Shared links remain active during the 30-day grace period.
- Historical Storage path re-pointing deferred.
- No separate residual-verification backend.

## Real remaining limitations

- Restoration emails require `RESEND_API_KEY` (not present at deploy time) — request intake still succeeds with `restorationEmailQueued: false`.
- Hourly scheduler must be created in Supabase Dashboard (no `pg_cron`).
- Mobile UI copy for exact deadline / resend is prepared in client service but needs coordinated QA build for privacy screen polish.
- Commits not created yet on the feature branch (ask to commit/PR when ready).
- One production restoration has not yet been end-to-end verified with a live email click.
