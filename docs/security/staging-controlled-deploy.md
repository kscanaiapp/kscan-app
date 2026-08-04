# Staging Controlled Deployment Pipeline

## Purpose

Make deployments to **K Scan AI Staging** (`yzqjvdfgefveprobvvyw`) predictable,
observable, and recoverable. Production (`wyyuqfdxucjksghsmhry`) is never targeted.

## Entry points

| Path | Role |
| --- | --- |
| `scripts/staging-deploy-preflight.mjs` | Identity, secrets, migration inventory, allow-list |
| `scripts/apply-staging-migration.mjs` | Exactly one approved migration |
| `scripts/deploy-staging-function.mjs` | Exactly one Edge Function + health + rollback on failure |
| `scripts/rollback-staging-function.mjs` | Manifest-driven rollback |
| `.github/workflows/staging-controlled-deploy.yml` | Ordered controlled deploy workflow |
| `.github/workflows/security-staging-gate.yml` | PR staging gate (hardened secret preflight) |

## Hard rules

- Never `supabase db push --project-ref …` (unsupported on CLI 2.109.1)
- Never blanket `db push` in the normal pipeline
- Never `DEPLOY_FUNCTIONS=all`
- Default deploy scope is empty (deploy nothing)
- One function per deployment
- Fail closed on remote-only migration drift
- Fail closed on multiple unapproved pending migrations

## Controlled deploy

```bash
# Dry-run preflight (requires staging env vars)
node scripts/staging-deploy-preflight.mjs --json

# Optional single migration
APPROVE_STAGING_MIGRATION=YES MIGRATION_VERSION=20260804090000 \
  node scripts/apply-staging-migration.mjs

# Deploy staging-health
DEPLOY_FUNCTIONS=staging-health FUNCTION_NAME=staging-health EXPECTED_VERIFY_JWT=false \
  node scripts/deploy-staging-function.mjs
```

Or use GitHub Actions → **K Scan Staging Controlled Deploy**.

## Health

`staging-health` returns only:

```json
{
  "status": "healthy|degraded|unhealthy",
  "environment": "staging",
  "service": "kscan-backend",
  "timestamp": "...",
  "version": "...",
  "checks": { "runtime": "ok", "database": "ok", "migrations": "ok|skip", "core_tables": "ok|skip" }
}
```

## Monitoring

`internal.edge_function_errors` stores redacted events (service_role only).
Shared helper: `supabase/functions/_shared/security/errorEvents.ts`.

## Rollback

Deployment manifests land in `artifacts/staging-deployments/`.
Rollback does **not** reverse database migrations.
