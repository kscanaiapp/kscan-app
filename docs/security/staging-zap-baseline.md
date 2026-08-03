# K Scan Staging ZAP Baseline

## Overview

Workflow: `.github/workflows/zap-baseline-staging.yml`  
Check name: **ZAP Baseline staging**

Passive OWASP ZAP baseline against the approved staging HTTPS target.

## Trigger behavior

| Event | Variables absent | Variables present |
| --- | --- | --- |
| Push to ordinary development branch | **Skip success** with summary | Validate, health-check, scan |
| Pull request to protected integration branch | **Fail** with missing-variable error | Validate, health-check, scan |

Protected base branches are listed in workflow env `PROTECTED_BASE_BRANCHES`.

## Target validation

`security/scripts/validate-zap-target.js` enforces:

- HTTPS only
- Exact hostname match with `ZAP_ALLOWED_HOST`
- Rejects production project host (`wyyuqfdxucjksghsmhry.supabase.co`)
- Rejects localhost, private addresses, metadata endpoints
- Rejects query parameters and embedded credentials
- Rejects redirects to non-approved hosts during health check

Self-test:

```bash
node security/scripts/validate-zap-target.js --self-test
```

## Health check

When `ZAP_STAGING_URL` is a Supabase project root (`/`), the workflow probes
`${ZAP_STAGING_URL}/auth/v1/health` (returns 401 without a key, which is acceptable).
Bare project roots commonly return `404` and must not be treated as healthy.

Accepted reachability HTTP statuses: **2xx, 3xx, 401, 403**.

Do **not** treat 404/405 as healthy: a missing route must not pass the health check.

The passive ZAP scan still uses the configured `ZAP_STAGING_URL` value.

## Exit policy

| Code | Initial rollout | After baseline approved |
| --- | --- | --- |
| 0 | Scan completed | Scan completed |
| 1 | Scan completed (FAIL findings) | New FAIL finding may **BLOCK** |
| 2 | Scan completed (WARN findings) | WARN = report-only |
| 3 | **Pipeline failure** | **Pipeline failure** |

## Reports

Uploaded to `zap-baseline-report-<run_number>` only after a successful ZAP run (JSON, HTML, Markdown, rules TSV).

## Image pin

```
ghcr.io/zaproxy/zaproxy:stable@sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2
```

ZAP version: **2.17.0**

## PR candidate SHA

Each run records the PR head SHA (or push SHA) in the workflow summary.
