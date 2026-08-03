# K Scan Staging Security Gate

## Purpose

The **K Scan Staging Security Gate** (`.github/workflows/security-staging-gate.yml`) deploys
pull-request merge candidates to **K Scan AI Staging** (`yzqjvdfgefveprobvvyw`) and runs
dynamic validation before protected-branch merge.

Production (`wyyuqfdxucjksghsmhry`) is never targeted by this workflow.

## Triggers

| Event | Behavior |
| --- | --- |
| `pull_request` (opened, synchronize, reopened, ready_for_review) | Full classification + staging path when staging-impact surfaces change |
| `push` to any branch | Assurance run (post-merge evidence on protected branches) |
| `workflow_dispatch` | Manual rerun |

## Concurrency

```yaml
concurrency:
  group: kscan-shared-staging-security
  cancel-in-progress: false
```

Only one staging deployment and dynamic scan runs at a time across all PRs.

## Change classification

| Tag | Staging dynamic validation |
| --- | --- |
| MOBILE | Static + contract tests only |
| WEB / API / SUPABASE FUNCTION / DATABASE MIGRATION / AUTH / STORAGE | Full staging deployment path |
| DOCUMENTATION ONLY | Static scans only |

## Staging deployment steps

1. Checkout PR merge candidate
2. Record head SHA and merge SHA
3. Verify staging project ref (`yzqjvdfgefveprobvvyw`)
4. Validate Supabase configuration
5. Migration syntax + destructive-operation detection
6. Deploy changed Edge Functions
7. Apply migrations (when present)
8. Health checks (`npm run test:verify-supabase` against staging env)
9. Synthetic auth/authz tests
10. Contract tests
11. Publish **Staging security gate** verdict

## GitHub environment: `staging`

### Variables

| Variable | Value |
| --- | --- |
| `SUPABASE_STAGING_PROJECT_REF` | `yzqjvdfgefveprobvvyw` |
| `SUPABASE_STAGING_URL` | `https://yzqjvdfgefveprobvvyw.supabase.co` |
| `ZAP_STAGING_URL` | Approved staging web/API hostname |
| `ZAP_ALLOWED_HOST` | Exact allowed host |
| `ZAP_API_DEFINITION_URL` | Optional remote OpenAPI URL |
| `ZAP_ACTIVE_ENABLED` | `false` (safe mode default) |

### Secrets (never logged)

- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_STAGING_ANON_KEY`
- `SUPABASE_STAGING_DB_PASSWORD` (migrations)
- Synthetic user credentials and JWT fixtures
- ZAP authenticated context material

## Synthetic test accounts

Configure dedicated staging-only accounts via environment secrets:

- `STAGING_SYNTHETIC_USER_EMAIL` / `STAGING_SYNTHETIC_USER_PASSWORD`
- Optional preissued JWT fixtures for cross-user, suspended, and deletion-pending scenarios

Tests use tagged session IDs and do not modify waitlist or privacy production records.

## Required check

**Staging security gate** — must return explicit PASS / PASS WITH REPORT-ONLY FINDINGS / BLOCKED / OPERATIONAL FAILURE.

## Rollback

If staging deployment fails or introduces regressions:

1. Re-deploy last known-good function versions from prior successful gate run
2. Revert migration on staging using approved rollback SQL (manual, tracked)
3. Re-run the staging gate on a fixed candidate commit
