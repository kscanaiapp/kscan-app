# Account Deletion Completion Handoff — 2026-07-22/23

## Final verdict

**CONDITIONAL — DELETION TREE COMPLETE, IRREVERSIBLE PRODUCTION TEST PENDING**

## Why not PASS

PASS requires all of: irreversible disposable-account lifecycle, kill switch deliberately enabled, and first monitored live scheduler run. Those remain blocked on explicit disposable-account approval and intentional activation.

## A. Deletion-tree matrix

See `docs/account-deletion-tree-matrix.md` (canonical + registry-backed).

## B. Architecture flow

```
Deletion request (handle-user-deletion)
  → immediate session revocation
  → account deactivation (profiles.account_status=pending_deletion)
  → hashed restoration token
  → restoration email:
       Supabase Edge
       → POST Render /internal/email/account-deletion-restoration
         (x-kscan-email-secret / KSCAN_EMAIL_INTERNAL_SECRET)
       → Resend (idempotency key deletion-restore:{requestId})
  → 30-day restoration window
  → scheduler invokes process-account-deletions (worker secret)
  → claim lease (FOR UPDATE SKIP LOCKED) when kill switch ON and dry-run OFF
  → deletion tree + storage cleanup
  → Auth delete
  → deletion_requests survives (user_id SET NULL) + ledger finalization
```

## C. Source-control evidence

### Deletion app repo (`kscanaiapp/KScan` worktree)

| Item | Value |
|---|---|
| Workspace | `C:\Users\jsmit\KScan-account-deletion` |
| Branch | `feature/automatic-account-deletion` |
| Starting SHA | `0c9086af9257b8ef002b7d2c479bf3da43ca0b9b` |
| Dirty primary tree preserved | `C:\Users\jsmit\KScan` on `ios/full-submission-readiness-v2` (untouched) |

### Render email repo (`kscanaiapp/kscan-app`)

| Item | Value |
|---|---|
| PR #32 | https://github.com/kscanaiapp/kscan-app/pull/32 (merged) |
| PR #34 | https://github.com/kscanaiapp/kscan-app/pull/34 (merged) |
| Master SHA | `9bb0b57ed9c4869047a795fb0544e962bc306d4a` |

## D. Deployment evidence

| Item | Value |
|---|---|
| Migration | `20260722191013_account_deletion_lifecycle` applied |
| Kill switch | OFF (`account_deletion_worker_enabled.enabled=false`) |
| Dry-run | ON (`account_deletion_worker_dry_run.enabled=true`) |
| Edge functions redeployed | handle-user-deletion, restore-account, resend-restoration-email, process-account-deletions |
| Edge secrets added | `KSCAN_EMAIL_RENDER_URL`, `KSCAN_EMAIL_INTERNAL_SECRET` |
| Render route | `/internal/email/account-deletion-restoration` live |
| Render health | GET `/api/health` → 200 |
| Analyze tombstone | POST `/api/analyze` → 410 |
| Unauthorized email | → 401 |
| Scheduler | Dashboard schedule still required (no `pg_cron`); **not enabled for live purge** |

## E. Test evidence

### Unit (deletion worktree)

Command:

```bash
node --test __tests__/accountDeletionLifecycle.test.js __tests__/deletionRegistryParity.test.js __tests__/handleUserDeletionEdge.test.js __tests__/sevenTableCoverage.test.js __tests__/processDeletionRequest.test.js
```

Result: **56 passed / 0 failed / 0 skipped**

### Unit + route (Render)

Command:

```bash
node --test __tests__/transactionalEmailRoute.test.js __tests__/accountDeletionRestorationEmail.test.js
```

Result: **15 passed / 0 failed / 0 skipped**

Do not combine totals.

### Production dry run

Invoked `process-account-deletions` with worker secret while kill switch OFF / dry-run ON.

| Field | Result |
|---|---|
| mode | `dry_run` |
| killSwitchEnabled | false |
| eligibleCount | 0 |
| planCount | 6 |
| byEligibility | all `skipped_future_grace` |
| wouldClaim | false for all |
| tree nodes / plan | 43 |
| storage | `style-library-images` enumerated, not deleted |
| tokens in response | none |
| rows after dry-run | still 6 `deactivated` |

Tester request IDs (private engineering):

- `039c645b-2b43-4cd1-91bb-afea5b7fc41e`
- `fe2d1b6f-fc2e-441e-b1a9-9cd90de5af91`
- `656b0c8b-ac5a-4297-84be-cc8e880b1a35`
- `ef018427-127c-4260-a184-0d297a82e982`
- `08d4882e-be20-41f0-8f8e-509f7cab14e7`
- `3c78f1bd-b025-4c06-b40e-873bce952368`

Artifact: `_audit_snapshots/account-deletion-audit-2026-07-22/dry-run-production-2026-07-22.json`

### Restoration email live probe

- Event `account_deletion_restoration` → **200 SENT** to approved tester `kscanai.app@gmail.com`
- Duplicate idempotency key → **200 SENT** (provider-suppressed duplicate)
- No token in HTTP response body

### Controlled irreversible test

**Not run** — no explicitly approved disposable production account provided in this pass.

## F. Remaining external gates

1. Explicit approval of a **disposable** production tester account for irreversible lifecycle
2. Inbox confirmation / restore-link click for a real deactivated account (not only synthetic Render probe)
3. Payment-provider deletion/retention decision (Stripe/etc. not in automated tree)
4. Legal retention sign-off if required beyond current ledger design
5. **Secret rotation** for `KSCAN_EMAIL_INTERNAL_SECRET` / Resend key previously exposed in chat (coordinate to avoid downtime)
6. Operator action: create Supabase Dashboard hourly schedule for `process-account-deletions` **only after** kill-switch activation gate

## Activation sequence (remaining)

1. Confirm disposable account + inbox access
2. End-to-end restore during window on that account
3. Re-initiate deletion → expire window → irreversible purge
4. Post-purge auth + restore failure proofs
5. Create Dashboard scheduler (hourly, worker secret header)
6. Keep dry-run ON for first scheduled invocations if desired, then disable dry-run
7. Enable kill switch deliberately
8. Monitor first live run
9. Rotate email secrets after stable

## Security checklist (this pass)

- Service-role / worker secret server-side only
- Email internal secret not shipped to clients
- Restoration tokens hashed at rest; not logged in dry-run artifact
- Render remains transactional-email-only; `/api/analyze` remains 410
- No LLM provider credentials required on Render for deletion mail
- Kill switch remains OFF
