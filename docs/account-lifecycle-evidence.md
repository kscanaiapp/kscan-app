# Account lifecycle evidence store

Status: implementation-ready, production deployment gated.

This component stores sanitized account-deletion evidence in the private
Supabase Storage bucket `account-lifecycle-evidence`. Evidence is never written
to Git, a public or user-facing bucket, a local worktree, Render disk, Vercel
temporary storage, or application logs as its system of record.

## Safety defaults

- The bucket is private and has no `storage.objects` policy for `anon` or
  `authenticated`.
- Evidence tables and internal views have RLS enabled, no client policies, and
  explicit client-role revocations.
- No retention-policy row or reviewer row is seeded. Legal/privacy approval and
  reviewer authorization must be explicit.
- `account_deletion_evidence_pipeline_ready` defaults to `false`.
- The live deletion worker checks that flag before claiming a request. A false
  flag sets automation to `PAUSED`, disables the worker, re-enables dry-run, and
  exits before destructive processing.
- The migration does not enable a scheduler or production deletion automation.

Supabase encrypts managed Storage data at rest at the platform layer. This
implementation adds application-level privacy, access, immutability, and
integrity controls; it does not claim customer-managed encryption keys.

## Object layout

Object paths are generated, never supplied as free-form input:

```text
<environment>/<UTC year>/<UTC month>/<deletion_request_id>/v<version>/<file>
```

Example:

```text
production/2026/08/2e981c64-7dd9-4ac7-930a-f1b3eb1e87d7/v1/manifest.json
```

The bucket name is not repeated inside the object path. Email addresses are
never used in paths. Uploads use `upsert: false`; a correction must use the next
version and provide `--change-note`.

## Required pre-deployment approvals

### 1. Retention policy

Legal/privacy stakeholders choose the retention period and approver identity.
Do not copy the sample duration without approval.

```sql
insert into public.evidence_retention_policies (
  environment,
  evidence_type,
  retention_days,
  legal_hold_enabled,
  policy_version,
  effective_at,
  approved_by
) values (
  'staging',
  'account_lifecycle',
  :approved_retention_days,
  true,
  'v1',
  now(),
  :approver_id
);
```

There is no indefinite default. Each evidence index row receives a concrete
`retention_expires_at`. A legal hold is request-specific and requires a reason,
actor, and timestamp on the evidence index. Legal holds must never be set by a
global retention default.

### 2. Reviewer authorization

Use a stable internal identity, not an email address. Capabilities are `view`,
`export`, and `retention_admin`.

```sql
insert into public.account_lifecycle_reviewers (
  reviewer_id,
  display_name,
  capabilities,
  approved_by
) values (
  :stable_reviewer_id,
  :display_name,
  array['view', 'export'],
  :approver_id
);
```

Reviewer access should be time-bounded with `valid_until` where practical and
disabled promptly when responsibilities change.

## Generate and verify a bundle

The exporter builds files in memory. It reserves a new index version, refuses
to overwrite a non-empty path, uploads every required object, downloads the
objects again, verifies `SHA256SUMS`, and only then marks the index complete.
Generation or round-trip verification failure invokes
`pause_account_deletion_automation`.

```powershell
$env:SUPABASE_URL = '<from approved secret store>'
$env:SUPABASE_SERVICE_ROLE_KEY = '<from approved secret store>'
npm run privacy:export-lifecycle-evidence -- `
  --request-id 2e981c64-7dd9-4ac7-930a-f1b3eb1e87d7 `
  --environment staging
```

For a correction:

```powershell
npm run privacy:export-lifecycle-evidence -- `
  --request-id 2e981c64-7dd9-4ac7-930a-f1b3eb1e87d7 `
  --environment staging `
  --version 2 `
  --change-note 'Corrected deployment version evidence'
```

Raw secrets must come from the approved execution environment. Do not paste
them into chat, reports, shell history, or source files.

## Review a dispute request

The reviewer command requires an authorized reviewer and a reason or case
number. It downloads only the required allowlisted filenames into an
OS-generated temporary directory, verifies checksums, records download/view
events, and removes the temporary directory in `finally`.

```powershell
npm run privacy:review-lifecycle -- `
  --request-id 2e981c64-7dd9-4ac7-930a-f1b3eb1e87d7 `
  --reviewer-id privacy-reviewer-01 `
  --reason 'Deletion completion dispute' `
  --case-number CASE-2026-001
```

Add `--open` to open the temporary `README.html`. Add `--export-dir <new-dir>`
only when an authorized sanitized export is required. The export directory
must not already exist and the reviewer must have the `export` capability.
The command records `EVIDENCE_EXPORT_CREATED` and the checksum of
`SHA256SUMS`.

Access events are append-only:

- `EVIDENCE_BUNDLE_VIEWED`
- `EVIDENCE_BUNDLE_DOWNLOADED`
- `EVIDENCE_EXPORT_CREATED`
- `EVIDENCE_CHECKSUM_FAILED`

A missing object or checksum failure records an integrity event when possible,
sets automation to `PAUSED`, and returns a nonzero exit code.

## Retention enforcement

Run the bounded retention command from an approved secret-bearing CI workflow
or scheduler. Do not run it from Vercel temporary storage or a mobile client.

```powershell
npm run privacy:purge-expired-evidence -- --limit 10
```

The command selects only expired rows without a legal hold, removes the fixed
required object list, minimizes the expired search key, marks the index
deleted, and appends `EVIDENCE_RETENTION_PURGED`. It stops and pauses deletion
automation on the first failure. Scheduling it is a production deployment
change and remains a build-manager gate.

## Search and timeline

Internal service-role tooling can query:

- `v_account_lifecycle_summary`
- `v_account_lifecycle_timeline`
- `account_lifecycle_evidence_index`

The index supports request ID, subject reference, normalized email hash,
request date, lifecycle state, bundle path/version, checksum state, legal hold,
and retention expiry. The raw email is prohibited.

`account_lifecycle_events` is append-only and chained per request using
SHA-256. Verify it with:

```sql
select *
from public.verify_account_lifecycle_hash_chain(
  :deletion_request_id
);
```

## Backup and restore gate

Before `LIMITED`, the build manager must configure and prove an encrypted,
restricted backup or archive replication mechanism supported by the approved
Supabase plan and organizational policy. The proof must include:

1. restore into an isolated non-production target;
2. no public URL or client-role access;
3. successful `SHA256SUMS` verification after restore;
4. a recorded access reason and reviewer identity;
5. cleanup of the restored test copy;
6. alert delivery for a deliberately missing or corrupted test object.

Repository code cannot truthfully manufacture platform backup/restore proof.
Do not set `account_deletion_evidence_pipeline_ready=true` until this test and
the full dispute-response acceptance test have passed.

## LIMITED acceptance test

Using a disposable staging request, prove this exact sequence:

```text
authorized reviewer lookup
→ search by deletion_request_id
→ locate immutable bundle
→ verify SHA256SUMS
→ open README.html
→ create authorized sanitized export
→ verify export checksum
→ confirm access events
→ confirm temporary directory removal
```

Also corrupt or remove one disposable object and verify:

```text
review fails
→ EVIDENCE_CHECKSUM_FAILED recorded
→ account_deletion_automation_mode = PAUSED
→ account_deletion_worker_enabled = false
→ account_deletion_worker_dry_run = true
```

Only after the bucket policies, retention approval, reviewer authorization,
worker/export integration, alert delivery, backup restore, and acceptance test
are evidenced may the readiness flag be considered for approval.
