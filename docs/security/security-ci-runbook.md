# K Scan AI — Security CI Runbook

## Purpose

Automated pre-merge security promotion pipeline for K Scan AI. Static scans run on every
push and pull request. Staging-impact changes trigger serialized deployment and dynamic
validation against **K Scan AI Staging** (`yzqjvdfgefveprobvvyw`).

Production (`wyyuqfdxucjksghsmhry`) is never modified by CI deployment steps.

## Workflows

| Workflow file | Check names produced |
| --- | --- |
| `.github/workflows/security-code.yml` | Project security checks, Gitleaks secret scan, Semgrep code scan, OSV dependency scan, Trivy repository scan, npm dependency audit, Security baseline comparison, Static security gate |
| `.github/workflows/security-staging-gate.yml` | Staging security gate |
| `.github/workflows/zap-baseline-staging.yml` | ZAP Baseline staging |
| `.github/workflows/zap-api-staging.yml` | ZAP API staging |
| `.github/workflows/security-promotion-gate.yml` | Security promotion gate |

## Triggers

All security workflows trigger on:

- `push` to any branch (`**`)
- `pull_request` types: opened, synchronize, reopened, ready_for_review
- `workflow_dispatch`

Post-merge pushes to protected branches provide assurance evidence; PR gates enforce merge.

### ZAP Baseline staging behavior

| Trigger | Missing `ZAP_STAGING_URL` / `ZAP_ALLOWED_HOST` | Variables configured |
| --- | --- | --- |
| Push to ordinary development branch | Skip success with summary | Validate target, health-check, passive scan |
| Pull request to protected integration branch | Fail with explicit missing-variable annotation | Validate target, health-check, passive scan |

Supabase project-root URLs use `/auth/v1/health` for reachability (accept 2xx/3xx/401/403 only; never 404/405). See `docs/security/staging-zap-baseline.md`.

## Required status checks (protected branches)

Configure via `security/scripts/apply-branch-ruleset.sh` after checks appear in GitHub:

1. Project security checks
2. Gitleaks secret scan
3. Semgrep code scan
4. OSV dependency scan
5. Trivy repository scan
6. npm dependency audit
7. Security baseline comparison
8. Static security gate
9. Staging security gate
10. ZAP Baseline staging
11. ZAP API staging
12. Security promotion gate

Ruleset targets: `master`, `ios/full-submission-readiness-v2`, active release promotion branches.

Emergency bypass: **OrganizationAdmin** (document every use).

## Baseline policy

See `docs/security/security-findings-baseline.md`.

## Blocking policy

| Condition | Result |
| --- | --- |
| Confirmed new secret | BLOCK |
| New Critical/High mobile or backend runtime | BLOCK |
| Existing accepted baseline | REPORT |
| New Medium/Low | REPORT |
| Scanner failure / missing report | BLOCK |
| Project test failure | BLOCK |

## Scanner versions (pinned)

| Scanner | Version |
| --- | --- |
| Gitleaks | 8.30.1 |
| Semgrep CE | 1.171.0 (Docker) |
| OSV-Scanner | 2.4.0 (SHA256 verified) |
| Trivy | via aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 |
| OWASP ZAP | 2.17.0, digest sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2 |

## Artifact locations

GitHub Actions artifacts, 30-day retention:

- `gitleaks-report-*`, `semgrep-report-*`, `osv-report-*`, `trivy-report-*`, `npm-audit-report-*`
- `baseline-comparison-*`
- `zap-baseline-report-*`, `zap-api-report-*`
- `promotion-verdict-*`, `synthetic-staging-tests-*`

## Local validation

```bash
npm run verify:security
npm run test:security
```

## Related docs

- `docs/security/staging-security-gate.md`
- `docs/security/staging-zap-baseline.md`
- `docs/security/staging-zap-api.md`
- `docs/security/security-promotion-response.md`
- `docs/security/initial-security-findings-2026-07-26.md`
