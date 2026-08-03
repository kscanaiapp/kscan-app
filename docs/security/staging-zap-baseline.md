# K Scan Staging ZAP Baseline

## Overview

Workflow: `.github/workflows/zap-baseline-staging.yml`  
Check name: **ZAP Baseline staging**

Passive OWASP ZAP baseline against the approved staging HTTPS target.

## Target validation

`security/scripts/validate-zap-target.js` enforces:

- HTTPS only
- Exact hostname match with `ZAP_ALLOWED_HOST`
- Rejects localhost, private addresses, metadata endpoints
- Rejects query parameters and embedded credentials
- Rejects redirects to non-approved hosts during health check

## Exit policy

| Code | Initial rollout | After baseline approved |
| --- | --- | --- |
| 0 | Scan completed | Scan completed |
| 1 | Scan completed (FAIL findings) | New FAIL finding may **BLOCK** |
| 2 | Scan completed (WARN findings) | WARN = report-only |
| 3 | **Pipeline failure** | **Pipeline failure** |

## Reports

Uploaded to `zap-baseline-report-<run_number>` (JSON, HTML, Markdown, rules TSV).

## Image pin

```
ghcr.io/zaproxy/zaproxy:stable@sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2
```

ZAP version: **2.17.0**

## PR candidate SHA

Each run records `${{ github.event.pull_request.head.sha || github.sha }}` in the workflow summary.
