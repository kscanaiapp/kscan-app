# K Scan account lifecycle deployment-readiness packet

Prepared: 2026-08-02  
Verdict: **CONDITIONAL — NAMED STAGING, POLICY, OAUTH, DEVICE, AND ALERT GATES REMAIN**  
Production deployment performed: **No**  
Production readiness flag changed: **No**

## Frozen candidates

| Surface | Branch | Candidate SHA | Governing provenance |
|---|---|---|---|
| Backend/evidence | `codex/account-lifecycle-evidence-v1` | `e3870cd54efc9005aa51bec5ab3bd236cc9cba6d` | required checkpoint `b50a1ad9d6d66ad3b243e3c7b116a4f3b48616d3` |
| Website | `codex/account-delete-intake-v1` | `3d12fac0f64fba49b09717e875b6d9c5a898677b` | required checkpoint `45c5e01aae41b4c35560429e7153c1bfa850c9b7` |
| Android | `codex/account-lifecycle-android-v1` | `40e748eba7d6db32d77fe65f4b3d08f22a21a7ee` | accepted descendant `4d0ceb40655a7de7a2430bc4014ef0710aa8ca66`, descended from `dd306ee` |
| iOS | `codex/account-lifecycle-ios-v1` | `f7231c7b0172d0402902d19cb7d554ba99d656d2` | accepted descendant `5c761ba7df2cfc7b22efa3d3326dca46850e02f0`, containing contract fix `a6f9228` |

All four SHAs were pushed to `origin`. The packet commit may be a documentation-only
successor to the backend candidate SHA above.

## Required inputs and exact blocked tests

The following approved values were not supplied and were not invented:

| Missing input | Acceptance tests blocked |
|---|---|
| Dedicated App Staging Supabase project ref | all remote DDL, Function deploy, RLS/Storage negative tests, advisors, lifecycle and session tests |
| Approved finite retention policy/version | policy insertion, expiry/non-expiry/hold/bounded cleanup proof |
| Named staging reviewer identities | authorized/unauthorized dispute retrieval and append-only access proof |
| Approved app-team alert channel/recipients | delivery proof for all 16 events and deliberate delivery-failure pause proof |
| Private backup/replication target | replication, isolated restore, independent retrieval, checksum equality, cleanup, missing-backup delivery proof |
| Email/password, Apple, and Google staging accounts | complete delete/restore/delete/purge, two-session revocation, OAuth grant revocation, device reconciliation |

Known project references are not substitutes: `wyyuqfdxucjksghsmhry` is production
and `yzqjvdfgefveprobvvyw` is a legacy/privacy project, not approved App Staging.
Neither was modified.

## Implemented source controls

- Automatic purge claims now require `initial_deletion_notice_verified = true`
  and `notification_review_required = false`; existing rows default to the
  fail-closed combination and are not backfilled.
- Intake returns deletion request and correlation IDs and records successful
  notice verification only after the mail boundary reports queued success.
- Apple/Google revocation is ordered after session revocation and before the
  first destructive data stage. It uses provider subject identifiers, never
  email, and accepts only `REVOKED` or `ALREADY_REVOKED` from the configured
  secret broker. Missing credentials/material or ambiguous Google grant type
  blocks purge and pauses automation. Email/password is `NOT_APPLICABLE`.
- The 16-event sanitized lifecycle alert contract is connected across intake,
  restoration, purge, evidence, integrity, anomaly, lease, backup, and pause
  paths. Critical worker failures pause before alert delivery.
- Backup verification is target-neutral: both copies must contain all 16 fixed
  files, each checksum manifest must verify, and restored bytes must equal the
  primary bytes. A failure pauses first and emits `BACKUP_FAILED` when the sink
  is configured.
- Android and iOS share response normalization, duplicate-submit suppression,
  immediate post-acceptance sign-out, same-owner grace markers, cross-account
  isolation, idempotent terminal cleanup primitives, and fresh-login restoration
  reconciliation through `get_my_latest_deletion_status_v2()`.
- Post-purge device cleanup still requires an authoritative terminal signal on
  a disposable device and is therefore not claimed staging-proven.
- The six historical-row owner decision template is
  `docs/account-deletion-historical-notice-decision-2026-08-02.md`. It sends no
  notices and authorizes no row mutation.

## Dependency advisory report

The controlled 11-row triage is in
`docs/account-delete-dependency-advisory-triage-2026-08-02.md`. No uncontrolled
`npm audit fix` was used. The final website tree reports zero known
vulnerabilities; account intake tests, ESLint, the Next production build, and
lockfile review passed.

## Verification record

| Check | Result |
|---|---|
| Backend release-scoped lifecycle matrix | 162 passed, 0 failed |
| Affected Edge Function `deno check` | 5 passed |
| Android deletion contract matrix | 28 passed, 0 failed |
| iOS deletion contract matrix | 37 passed, 0 failed |
| Website authenticated intake | 4 passed, 0 failed |
| Website ESLint | passed |
| Next.js 16.2.12 production build | passed; sensitive account routes dynamic |
| Website `npm audit --audit-level=low` | 0 vulnerabilities |
| `git diff --check` | passed in all four worktrees |
| Supabase local DDL/advisors | blocked: Docker engine not running |
| Mobile TypeScript compile in isolated worktrees | not run: dependencies not installed; no alternate compiler fetched |

A repository-wide backend sweep also encountered unrelated baseline failures:
the branch lacks `services/transactionalEmail`, and older iOS/release-copy tests
do not match that backend checkpoint. These were not altered by this release.

## Website preview and production invariant

- Preview deployment: `dpl_Am2xBoiKeaX3RvzwLSsMrUncKgXH`
- Preview SHA: `3d12fac0f64fba49b09717e875b6d9c5a898677b`
- Preview state: `READY`, target `null` (non-production)
- Preview URL: `https://kscan-website-7wydzqrh4-justinlandes-projects.vercel.app`
- Direct external request is Vercel-auth protected and returned a 302 with
  `Cache-Control: no-store`, HSTS, `X-Frame-Options: DENY`, and `X-Robots-Tag: noindex`.
- Latest production deployment remains `dpl_2mtTK8ZfHiwJZqbg1QXriwyqo1ie`
  at Git SHA `27700d0eea073b2e46a8a8954dd4377afb4b35e0`.

The preview is not a staging proof until its Preview variables are shown to
reference the dedicated approved App Staging backend.

## Staging deployment inventory and exact order

Migrations, in repository order:

1. `20260722191013_account_deletion_lifecycle.sql`
2. `20260723021145_account_deletion_security_hardening.sql`
3. `20260723040000_account_deletion_crash_recovery.sql`
4. `20260723050000_account_deletion_rls_active_account.sql`
5. `20260723060000_deletion_ledger_pii_sanitizer.sql`
6. `20260723070000_profiles_backfill_and_active_account_hardening.sql`
7. `20260802181610_account_lifecycle_evidence_store.sql`
8. `20260802193330_account_deletion_notice_claim_guard.sql`

Functions to deploy from the same backend SHA:

- `handle-user-deletion`
- `restore-account`
- `resend-restoration-email`
- `process-account-deletions`
- shared modules under `supabase/functions/_shared/deletion/`

No staging migration or Function version is recorded because no staging target
was approved. After approval, verify the ref before every write:

```powershell
npx supabase link --project-ref <APP_STAGING_REF>
npx supabase db push --linked --dry-run
npx supabase db push --linked
npx supabase functions deploy handle-user-deletion --project-ref <APP_STAGING_REF> --use-api
npx supabase functions deploy restore-account --project-ref <APP_STAGING_REF> --use-api
npx supabase functions deploy resend-restoration-email --project-ref <APP_STAGING_REF> --use-api
npx supabase functions deploy process-account-deletions --project-ref <APP_STAGING_REF> --use-api --no-verify-jwt
```

Keep readiness false, worker disabled, dry-run true, and automation paused while
provisioning policy, reviewers, alert delivery, backup, website Preview values,
and disposable accounts. Run Supabase security and performance advisors after
DDL and record each Function deployment ID/version.

## Evidence, retrieval, backup, and retention commands

Run only against the approved staging ref with secrets injected by the approved
execution environment:

```powershell
npm run privacy:export-lifecycle-evidence -- --request-id <DISPOSABLE_REQUEST_UUID> --environment staging
npm run privacy:review-lifecycle -- --request-id <DISPOSABLE_REQUEST_UUID> --reviewer-id <NAMED_REVIEWER_ID> --reason '<SANITIZED_REASON>' --case-number <CASE>
npm run privacy:verify-evidence-backup -- --request-id <DISPOSABLE_REQUEST_UUID> --environment staging --source-dir <PRIMARY_DOWNLOAD> --restored-dir <ISOLATED_RESTORE_DOWNLOAD>
npm run privacy:purge-expired-evidence -- --limit 10
```

The unit-generated sanitized sample contains the fixed 16-file bundle and a
valid `SHA256SUMS`; it was intentionally not committed as user evidence. No
remote bundle, reviewer access event, backup copy, or retention event is
claimed. The current functions do not persist a completion-email envelope in
Supabase; provider-side queue/envelope retention and deletion require the email
system owner's approved policy and evidence.

## Required configuration

Supabase Function scope:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `ACCOUNT_DELETION_WORKER_SECRET`
- `DELETION_WORKER_DRY_RUN`
- `KSCAN_ENVIRONMENT`
- `FUNCTION_VERSION`
- `DEPLOYMENT_SHA`
- `ACCOUNT_PROVIDER_REVOCATION_BROKER_URL`
- `ACCOUNT_PROVIDER_REVOCATION_BROKER_TOKEN`
- `ACCOUNT_LIFECYCLE_ALERT_WEBHOOK_URL`
- `ACCOUNT_LIFECYCLE_ALERT_WEBHOOK_TOKEN`
- existing approved restoration/completion email service configuration

Vercel Preview scope only during staging:

- `ACCOUNT_DELETE_SUPABASE_URL`
- `ACCOUNT_DELETE_SUPABASE_PUBLISHABLE_KEY`
- `ACCOUNT_DELETE_SITE_URL`

No service-role key belongs in Vercel or either mobile client. Values must be
independently entered by environment; do not copy staging values to Production.

## Disposable canary requirements

Use separate, non-production accounts with no real customer data:

- email/password, Apple, and Google identities;
- two independently established sessions per provider;
- known shared Dressing Room owner/member fixtures and referenced Storage object;
- approved test inboxes and provider revocation material in the secret broker;
- a named reviewer and case number;
- a deliberately corrupt evidence copy and deliberately missing backup object;
- retention fixtures that are expired, non-expired, legally held, and exceed
  one bounded batch.

The canary must prove delete → restore → fresh login reconciliation → delete →
provider revoke → hard purge, plus old JWT denial across Scanner, TextScan,
Elise, Recent Scans, Dressing Rooms, and protected commerce routes. It must also
prove cross-user preservation, evidence finalization before terminal state,
all 16 alert deliveries, isolated backup restore, temporary-copy cleanup, and
retention audit events.

## Production sequence — approval required, do not run from this packet

1. Freeze and peer-review the four candidate SHAs and complete every unchecked
   activation gate below.
2. Link to the explicitly approved production ref and run only `db push
   --linked --dry-run`; compare the target and SQL transcript twice.
3. Record designated production approval and a rollback owner.
4. Apply migrations; deploy all four Functions from one frozen backend SHA.
5. Verify readiness remains false, worker off, dry-run on, scheduler off.
6. Configure production secrets independently and re-run negative access tests
   and Supabase advisors.
7. Deploy the website SHA as a non-production preview, verify it, then promote
   that immutable deployment only after backend approval.
8. Enable readiness only for the named disposable production canary; return to
   worker-off/dry-run-on immediately after the bounded canary.

## Rollback and safe stop

1. Set evidence readiness false, worker enabled false, worker dry-run true, and
   automation mode `PAUSED`.
2. Disable the scheduler/invoker.
3. Redeploy the previously approved Function versions; retain the additive
   evidence schema and failed/partial bundles for recovery.
4. Restore the previous Vercel production deployment if website rollback is
   required.
5. Do not manually mark an orphaned request purged; complete and verify its
   evidence first.

## Activation checklist

- [ ] Dedicated App Staging ref named and approved
- [ ] Finite retention policy/version approved and inserted
- [ ] Named reviewers provisioned and negative access proven
- [ ] Alert channel configured; all 16 deliveries and failure pause proven
- [ ] Backup target configured; isolated restore, corruption/missing, and cleanup proven
- [ ] Email, Apple, and Google disposable accounts supplied
- [ ] Migrations and Function versions recorded from staging
- [ ] Bucket, RLS, grants/revokes, hash chain, and advisors verified
- [ ] Website Preview variables proven staging-only; authenticated flow matrix passed
- [ ] Android/iOS fresh-login restore and terminal device cleanup passed on devices
- [ ] Two-session revocation and old-JWT denial passed for every provider
- [ ] Apple and actual Google grant revocation proven before Auth deletion
- [ ] Full delete/restore/delete/purge and shared-data matrix passed
- [ ] Evidence generation, dispute retrieval, v2 immutability, and corrupt-object pause passed
- [ ] Retention, hold, bounded purge, audit events, and completion-envelope/provider cleanup passed
- [ ] Production dry-run transcript peer-reviewed and designated approval recorded
- [ ] Only then consider `account_deletion_evidence_pipeline_ready = true`

Final status remains **CONDITIONAL**. It is neither `LIVE` nor staging-proven.
