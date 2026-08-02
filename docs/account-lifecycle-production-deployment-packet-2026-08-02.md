# Account lifecycle evidence and external deletion production approval packet

Prepared: 2026-08-02

Production deployment performed: **No**

Readiness flag: **false**

Verdict: **CONDITIONAL — IMPLEMENTATION COMPLETE; NAMED STAGING OR POLICY GATES REMAIN**

## Release candidates

| Surface | Branch | Implementation SHA | Remote SHA verified |
|---|---|---|---|
| Mobile/backend evidence pipeline | `codex/account-lifecycle-evidence-v1` | `746e153af601abd07a9c3469c21f6863b1c78854` | Yes |
| Website authenticated intake | `codex/account-delete-intake-v1` | `45c5e01aae41b4c35560429e7153c1bfa850c9b7` | Yes |

The backend branch was initially preserved at
`68328865df15a6d243004eb8786a92a7698c2387`, then advanced with the
orchestration, cross-user verification, database terminal gate, alert sink,
web-source attribution, and retention packet.

## Staging target decision

No approved App Staging Supabase project exists in the connected inventory.

| Project | Reference | Documented role | Eligible for this deployment |
|---|---|---|---|
| KScan App Production | `wyyuqfdxucjksghsmhry` | Mobile production | **No; production is out of scope** |
| K Scan Privacy Controls | `yzqjvdfgefveprobvvyw` | Legacy/dev website, waitlist, privacy, and opt-out flows | **No; not approved App Staging** |

The production project has only its default `main` branch. Repository records
also state that true staging/production separation must be created. Therefore
the migration and Edge Functions were not applied to either project.

Required decision: name and approve a dedicated App Staging project reference
or a Supabase preview branch, then separately map the Vercel preview environment
to that target. Creating a paid project/branch requires the owner’s cost and
organization approval.

## Implemented controls

- Purge captures database, storage, and shared-room pre-inventory before
  destructive work.
- A new immutable evidence version is reserved before destructive stages.
- Direct-row, room-transfer, storage, session, and Auth deletion results are
  appended to the lifecycle ledger.
- Cross-user baselines preserve transferred room items, other participants,
  other messages, and other inspiration links; anomalies pause automation.
- Residual verification and cross-user verification precede bundle generation.
- All 16 required files are generated, uploaded with `upsert: false`, downloaded,
  and verified against `SHA256SUMS`.
- The evidence index must be complete and checksum-verified before the database
  permits `mark_deletion_request_purged`.
- Crash reconciliation can close only a request that already has complete,
  verified evidence. Other orphans pause for recovery.
- Critical lifecycle alerts carry the environment, severity, request ID,
  timestamp, function version, sanitized category, and optional evidence
  reference. Alert delivery failure leaves automation paused.
- `/account/delete` only requests authentication and always gives a generic
  anti-enumeration response.
- PKCE callback state is single-use, expires locally after five minutes, and is
  removed from the visible URL/history by a clean redirect.
- `/account/delete/confirm` requires a remotely validated user, same-origin
  mutation, CSRF token, explicit consent, and an authenticated bearer token.
- Website auth cookies are capped at ten minutes and cleared after success; no
  service-role credential is used by the website.
- `handle-user-deletion` allowlists `external_web` attribution and appends an
  authenticated web intake event without changing mobile authentication.

## Local and preview validation

| Validation | Result |
|---|---|
| Deletion/lifecycle/registry Node suites | 106 passed, 0 failed |
| Evidence-focused suite | 10 passed, 0 failed (included above) |
| Website intake contract suite | 4 passed, 0 failed |
| `deno check process-account-deletions` | Passed |
| `deno check handle-user-deletion` | Passed |
| Website ESLint | Passed |
| Next.js 16.2.2 production build | Passed; all delete routes dynamic |
| `git diff --check` | Passed after source normalization |
| Vercel preview | `dpl_DGV8uVAPhDqC4nc66Qq5WmeFWFRm`, READY, non-production |
| Preview `/account/delete` GET | 200; no-store, no-referrer, noindex, CSP, HSTS, frame denial |
| Production Vercel deployment | Unchanged at Git SHA `27700d0eea073b2e46a8a8954dd4377afb4b35e0` |

The Vercel preview is not a complete staging proof: its backend environment was
not shown to point to a dedicated App Staging Supabase project. No email was
submitted and no account was deactivated through the preview.

## Staging evidence still required

These artifacts are intentionally not claimed because no approved staging
backend was available:

- applied migration record, deployed Function versions, and staging project ref;
- bucket/grant/RLS negative-access report;
- named reviewer provisioning and unauthorized-user matrix;
- disposable-account bundle and sanitized sample export;
- checksum corruption/missing-file/idempotency/v2 report;
- retention expiry/hold/batch/failure report;
- platform backup/isolated restore/checksum/cleanup report;
- app-team delivery report for all eight required alert categories;
- authenticated external delete-flow behavioral report;
- full delete → restore → second delete → hard purge lifecycle report;
- Supabase security and performance advisor results after staging DDL.

The readiness flag must remain false while any item above is missing.

## Migration and deploy inventory

Migration:

- `supabase/migrations/20260802181610_account_lifecycle_evidence_store.sql`

Functions to deploy together from the same backend SHA:

- `handle-user-deletion`
- `process-account-deletions`
- shared dependencies under `supabase/functions/_shared/deletion/`

Website release candidate:

- `codex/account-delete-intake-v1@45c5e01aae41b4c35560429e7153c1bfa850c9b7`

## Approved-staging run order

Use Supabase CLI 2.109.1 or a reviewed newer compatible release. Replace every
placeholder and confirm the target name before each write.

```powershell
npx supabase link --project-ref <APP_STAGING_REF>
npx supabase db push --linked --dry-run
npx supabase db push --linked
npx supabase functions deploy handle-user-deletion --project-ref <APP_STAGING_REF> --use-api
npx supabase functions deploy process-account-deletions --project-ref <APP_STAGING_REF> --use-api --no-verify-jwt
```

`process-account-deletions` uses a dedicated constant-time worker secret, so its
platform JWT check remains disabled while its custom authentication remains
mandatory. `handle-user-deletion` keeps platform JWT verification enabled and
also calls `auth.getUser()`.

Before canary execution:

1. Confirm the migration inserted readiness `false`, worker enabled `false`, and
   worker dry-run `true`.
2. Insert the approved finite staging retention policy.
3. Provision named reviewers with only `view` and/or `export`; grant
   `retention_admin` only to the named policy custodian.
4. Configure the alert sink and prove a synthetic delivery failure pauses.
5. Configure platform backup/replication and prove isolated restore.
6. Configure Supabase Auth redirect allowlisting for the Vercel preview callback.
7. Configure Vercel Preview variables to the exact App Staging URL/key/domain.
8. Run negative access tests and Supabase security/performance advisors.
9. Run the complete acceptance matrix while readiness remains false.
10. Enable readiness only for the approved disposable canary, then return the
    system to worker-off/dry-run-on until production approval.

## Staging reviewer provisioning template

Do not use shared identities. Record the employee identity, role, ticket, and
expiry. Example values below are placeholders, not provisioned reviewers.

| Placeholder identity | Capabilities | Purpose |
|---|---|---|
| `<support-reviewer@company>` | `view` | Request lookup and readable review |
| `<dispute-exporter@company>` | `view`, `export` | Sanitized dispute package creation |
| `<privacy-policy-owner@company>` | `view`, `retention_admin` | Holds and retention administration |

Every review/export requires a reason and case number. Reviewers use the CLI;
they do not receive bucket-browser access or raw service-role credentials.

## Finite retention decision

No duration is approved. The decision matrix is in
`docs/account-lifecycle-retention-decision-packet.md`.

The balanced candidate presented for stakeholder decision—not an adopted legal
policy—is:

- active grace evidence: grace end + 30 days;
- completed deletion evidence: 365 days after purge;
- failed-purge evidence: 365 days after verified remediation;
- managed dispute exports: 30 days;
- reviewer access logs: 730 days;
- temporary completion-email envelopes: 7 days;
- legal holds: 90-day review cadence and explicit release;
- backup copies: primary expiry + no more than 30 days.

If stakeholders choose category-specific durations, a follow-up migration is
required because the current schema enforces one bundle-level duration.

## Required configuration names

Supabase Functions:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `ACCOUNT_DELETION_WORKER_SECRET`
- `DELETION_WORKER_DRY_RUN`
- `KSCAN_ENVIRONMENT`
- `FUNCTION_VERSION`
- `DEPLOYMENT_SHA`
- `ACCOUNT_LIFECYCLE_ALERT_WEBHOOK_URL`
- `ACCOUNT_LIFECYCLE_ALERT_WEBHOOK_TOKEN`
- existing restoration-email/Render configuration used by deletion functions

Vercel Preview/Production, configured independently:

- `ACCOUNT_DELETE_SUPABASE_URL`
- `ACCOUNT_DELETE_SUPABASE_PUBLISHABLE_KEY`
- `ACCOUNT_DELETE_SITE_URL`

No service-role key belongs in Vercel for this flow. The preview and production
values must never be copied across environments without target verification.

## Production commands — approval required, do not run from this packet

Preflight only:

```powershell
npx supabase link --project-ref <PRODUCTION_REF>
npx supabase db push --linked --dry-run
```

After designated production approval and a second target check:

```powershell
npx supabase db push --linked
npx supabase functions deploy handle-user-deletion --project-ref <PRODUCTION_REF> --use-api
npx supabase functions deploy process-account-deletions --project-ref <PRODUCTION_REF> --use-api --no-verify-jwt
```

Vercel plan:

1. Freeze the reviewed website SHA.
2. Copy only approved production variable values into the Production scope.
3. Deploy the SHA as a preview and repeat GET/header/auth-negative tests.
4. Promote that exact immutable deployment only after backend approval.
5. Verify `/account/delete`, callback failure behavior, confirmation auth guard,
   production logs, and production domain headers without submitting a real user.

Render/app-team plan:

1. Confirm whether the approved alert endpoint is hosted by Render or another
   notification service.
2. Configure the two alert webhook secrets only in Supabase Function scope.
3. Prove all required sanitized alert categories in staging before copying
   production values.
4. Existing restoration-email Render configuration remains unchanged unless
   its owner separately approves a change.

## Rollback and safe-stop procedure

Database migration is additive and security-restrictive. Do not drop evidence
tables or buckets during an incident. Safe stop is:

1. Set readiness false, worker enabled false, worker dry-run true, and automation
   mode `PAUSED`.
2. Disable the scheduler/worker invoker.
3. Redeploy the previously approved `handle-user-deletion` and worker sources if
   function rollback is required; retain the private evidence schema.
4. Promote the previous known-good Vercel production deployment if the website
   must be rolled back.
5. Preserve failed/partial evidence versions and alert records for recovery.
6. Do not mark an orphaned request purged manually; complete and verify its
   evidence bundle first.

## Readiness activation checklist

- [ ] Dedicated App Staging ref named and approved
- [ ] Finite retention model and durations approved
- [ ] Migration applied in staging and recorded
- [ ] Bucket private; anon/authenticated list/read denied
- [ ] Internal tables/views/RPC permissions negatively tested
- [ ] Named reviewers provisioned and access events proven
- [ ] Worker and web-source handler deployed from frozen SHA
- [ ] Required-file, checksum, corruption, missing-file, retry, and v2 tests pass
- [ ] Residual and cross-user verification tests pass
- [ ] Retention/hold/bounded purge/failure tests pass
- [ ] Backup, isolated restore, checksum, log, and cleanup tests pass
- [ ] All required app-team alerts delivered without PII/secrets
- [ ] Website preview variables verified as staging-only
- [ ] Valid, harassment, expired, reused, invalid-state, duplicate, network,
      already-deactivated, and restoration-compatible web tests pass
- [ ] Full disposable lifecycle passes
- [ ] Supabase advisors reviewed after DDL
- [ ] Production command transcript peer-reviewed
- [ ] Designated production approval recorded
- [ ] Only then consider readiness true
