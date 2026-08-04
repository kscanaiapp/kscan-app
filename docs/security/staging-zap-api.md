# K Scan Staging ZAP API Scan

## Overview

Workflow: `.github/workflows/zap-api-staging.yml`  
Check name: **ZAP API staging**

## OpenAPI definition

Primary spec: `security/openapi/staging-api.yaml`

Built from reachable staging Edge Functions discovered in the repository:

- stylechat-generate
- product-search-deals
- kickscrew-sneaker-description
- handle-user-deletion
- privacy-data-export
- privacy-correction-request
- search-vinted-secondhand
- tryon-clothes-pro
- nike-shoe-details

Override with repository variable `ZAP_API_DEFINITION_URL` when needed.

## Modes

| Mode | Flag | When |
| --- | --- | --- |
| **ZAP API Safe Scan** | `zap-api-scan.py -S` | Default on every PR |
| **ZAP API Active Scan** | full `zap-api-scan.py` | `ZAP_ACTIVE_ENABLED=true` |

Safe mode imports the API definition and performs passive baseline scanning without the active API attack phase.

## Test coverage (safe + active)

- Missing / malformed / expired authentication
- Invalid request body and content type
- Oversized requests
- Cross-user object access (with synthetic JWT fixtures)
- Unexpected server errors and provider error leakage
- CORS behavior
- Unsafe response headers

## Rules

`.zap/api-rules.tsv` — no IGNORE greenwashing overrides.

## Reports

| Report | Files |
| --- | --- |
| ZAP API Safe Scan | `zap-api-report.{json,html,md}` |
| ZAP API Active Scan | `zap-api-active-report.{json,html,md}` |

Artifact: `zap-api-report-<run_number>` (30-day retention)
