# K Scan AI — Security CI Runbook (Phase 1)

## Purpose

This repository includes an automated, **report-only** GitHub Actions security pipeline. On every push and pull request (and via manual workflow dispatch), scanners generate machine-readable reports, human-readable job summaries, and downloadable Actions artifacts.

The pipeline produces **security evidence**. It does **not** prove that the application is secure.

Evidence labels used by this Phase 1 delivery:

| Label | Meaning |
| --- | --- |
| IMPLEMENTED | Pipeline configuration exists in the repository |
| CONFIGURATION VERIFIED | Local structural/config validation passed |
| LOCAL RUNTIME VERIFIED | Local helper/script validation passed where feasible |
| GITHUB RUNTIME VERIFIED | Actual GitHub Actions runs succeeded (not claimed until observed) |
| GITHUB RUNTIME UNVERIFIED | GitHub-hosted execution not yet evidenced |
| STAGING VERIFIED | Approved staging target scanned successfully (not claimed until observed) |
| PRODUCTION VERIFIED | Not applicable / not claimed for Phase 1 ZAP |

Until successful workflow runs are observed in GitHub Actions, GitHub runtime remains **GITHUB RUNTIME UNVERIFIED**.

## Triggers

Workflows:

- `.github/workflows/security-code.yml` — `Security - Code and Dependencies`
- `.github/workflows/zap-baseline-staging.yml` — `Security - ZAP Baseline Staging`

Both workflows trigger on:

| Trigger | Behavior |
| --- | --- |
| `push` | Full report-only scan suite |
| `pull_request` | Full report-only scan suite |
| `workflow_dispatch` | Manual run |

ZAP Baseline executes **only** when both repository variables are configured:

- `ZAP_STAGING_URL`
- `ZAP_ALLOWED_HOST`

If either variable is missing, ZAP skips successfully and records that **no fallback target was scanned**.

## Scanner coverage

| Scanner | Role |
| --- | --- |
| Gitleaks | Hardcoded secrets / credential-pattern history scan |
| Semgrep Community Edition | Static application-security patterns + K Scan custom rules |

Semgrep dual-report note (Phase 1):

- Use `--json-output=semgrep-results.json` and `--text-output=semgrep-results.txt`.
- Do **not** combine `--json --output=...` with `--text` / `--text-output`.
- With that incorrect combination, Semgrep 1.171.0 writes text into the `--output` path, JSON parsing fails, and the job fails as an operational/report-generation error even though the scan itself completed.
- Use `--no-error` so findings remain report-only; missing/malformed reports and nonzero engine exits still fail.
| OSV-Scanner | Known vulnerabilities in supported lockfiles (`package-lock.json`) |
| Trivy (filesystem) | Vulnerabilities, secrets, and misconfigurations |
| npm audit | npm advisory database against the existing lockfile |
| OWASP ZAP Baseline | Passive scan of an explicitly approved HTTPS staging URL |
| Existing project tests | Only scripts that already exist in `package.json` |

### Existing npm scripts inventory (inspected)

Present:

- `server`
- `test:privacy`
- `test:auth-privacy`
- `verify:supabase`
- `test:verify-supabase`
- `test:analyze-contract`
- `start`
- `start:server`
- `start:android`
- `android`
- `android:device`
- `ios`
- `qa:fixtures`
- `qa:convergence`
- `privacy:process-deletion`
- `verify:apple-readiness`
- `verify:apple-submission`

Absent (skipped; absence is not an error):

- `typecheck`
- `lint`
- `test`
- `test:unit`
- `test:integration`
- `test:inventory`
- `verify:test-inventory`
- `test:security`
- `verify:security`

Phase 1 `project-checks` runs:

- `npm run test:privacy`
- `npm run test:auth-privacy`
- `npm run test:verify-supabase`
- `npm run test:analyze-contract`

## Limitations

- ZAP scans a deployed web or API target, **not** native React Native UI behavior.
- A shared staging target may **not** contain the pull-request commit under test.
- Static findings require human exploitability review.
- Dependency severity does **not** prove mobile runtime exposure.
- Secret scanning can produce false positives.
- Passive ZAP does **not** deeply test authorization or active injection.
- This pipeline does **not** replace RLS testing, mobile artifact analysis, staging integration tests, or physical-device testing.

## Report-only policy

Phase 1 policy:

| Condition | Behavior |
| --- | --- |
| Security findings detected | Report, upload artifact, write summary, **do not block** |
| Scanner install/execution failure | **Fail** |
| Invalid configuration | **Fail** |
| Missing or malformed expected reports | **Fail** |
| Existing project test failures | **Fail normally** (not report-only) |

Whole-job `continue-on-error: true` is intentionally not used as the report-only mechanism.

ZAP Baseline exit codes are handled explicitly in Phase 1: `0` completes successfully,
`1` (FAIL-level findings) and `2` (WARN-level findings) upload reports and return success,
while `3` and unknown codes fail as operational errors.

## Reports

1. Open the GitHub Actions run for the commit or pull request.
2. Read each job’s `GITHUB_STEP_SUMMARY`.
3. Download artifacts named like:
   - `gitleaks-report-<run_number>`
   - `semgrep-report-<run_number>`
   - `osv-report-<run_number>`
   - `trivy-report-<run_number>`
   - `npm-audit-report-<run_number>`
   - `zap-baseline-report-<run_number>`
4. Match reports to the commit SHA and workflow run ID shown in the summary tables.

Artifact retention: **30 days**.

## GitHub variables

Create repository variables (not secrets) for the unauthenticated passive ZAP scan:

Location:

`Repository → Settings → Secrets and variables → Actions → Variables`

| Variable | Example placeholder |
| --- | --- |
| `ZAP_STAGING_URL` | `https://staging.example.com` |
| `ZAP_ALLOWED_HOST` | `staging.example.com` |

Validation rules (Phase 1):

- HTTPS only
- Exact hostname match (no wildcard subdomains)
- No embedded credentials
- No URL fragments
- No query parameters
- No localhost / private / link-local / cloud-metadata targets
- No production fallback and no target discovery from repository files

## Production prohibition

**Phase 1 ZAP must never target production.**

Active, destructive, authenticated, deletion, rate-limit, and provider-cost testing belongs only in isolated staging with synthetic accounts and controlled quotas.

## Finding classification

Every finding must later be classified as one of:

- `MOBILE RUNTIME`
- `BACKEND RUNTIME`
- `BUILD/CI`
- `DEVELOPMENT ONLY`
- `TEST ONLY`
- `FALSE POSITIVE`
- `UNVERIFIED`

npm severity alone does not prove exploitability.

## Exceptions

Each accepted false positive or accepted risk must record:

| Field | Required |
| --- | --- |
| Finding ID | Yes |
| Scanner | Yes |
| Affected file or endpoint | Yes |
| Classification | Yes |
| Reason | Yes |
| Evidence | Yes |
| Owner | Yes |
| Created date | Yes |
| Expiration date | Yes |
| Retest date | Yes |
| Compensating control | Yes |

Permanent unowned suppressions are not permitted.

## Enforcement roadmap

### Phase 1

All security findings are report-only.

### Phase 2

- New Critical findings block.
- New High findings block.
- Existing classified findings remain tracked.

### Phase 3

- Security status checks become required.
- Expired exceptions block.
- Relevant staging ZAP checks become required.

Before Phase 2/3 blocking enforcement, re-verify that every GitHub Action pin uses a full immutable commit SHA reviewed against the official release tag.

## Dependency policy

`npm audit fix --force` is **prohibited** without an approved framework and dependency-upgrade plan.

Forced Expo / React Native upgrades may introduce breaking native and runtime changes and are out of scope for this Phase 1 CI task.

Dependabot is configured for weekly npm and GitHub Actions updates (America/New_York, Monday morning), limited to five open PRs per ecosystem, with no automerge.

The OSV-Scanner v2.4.0 Linux binary is checked against the SHA-256 published in the
official v2.4.0 release before it is installed or executed.

## Future active ZAP policy

Future authenticated or active scans must run:

- nightly or weekly
- staging only
- synthetic accounts only
- controlled provider quotas
- no real user data

They remain out of Phase 1.

## Ten security layers

Mapping Phase 1 automation against the ten security layers:

| Layer | Phase 1 coverage |
| --- | --- |
| Authentication | Partial (static patterns / project auth-privacy tests; not full auth matrix) |
| Backup and recovery | Not covered |
| Encryption | Partial (misconfig/secret heuristics only) |
| Rate limiting | Not covered by these scanners |
| Logging | Partial (custom Semgrep rules for token/image logging) |
| Dependencies | Covered (OSV, Trivy, npm audit, Dependabot) |
| Session handling | Partial (token-in-URL / logging rules) |
| Input validation | Partial (Semgrep / ZAP passive headers-ish signals) |
| Monitoring | Not covered |
| AI boundaries | Partial at best (static heuristics only; not model-runtime assurance) |

## ZAP rules file

`.zap/baseline-rules.tsv` is intentionally minimal for Phase 1:

- No `IGNORE` overrides used to greenwash results
- Ordinary alerts remain WARN / report-only via baseline `-I`
- Rule ID tuning follows the first real staging report
- Configuration errors still fail the job

## ZAP image pin review

The Phase 1 workflow pins the official ZAP `stable` image to an
immutable multi-platform digest and records both the ZAP version and digest in the
workflow summary. Review the pin monthly and whenever ZAP publishes a stable security
or scanner update. Resolve `stable` from the official GHCR registry, run `zap.sh -version`
from the digest-pinned image, review upstream release notes, and update the version and
digest together. Validate the workflow and run a staging baseline before accepting the
new pin; never replace the digest with a mutable tag-only reference.

## Local helpers

Optional CI helpers (Node built-ins only):

- `security/scripts/validate-zap-target.js`
- `security/scripts/write-security-summary.js`

## Permissions and safety

Workflows use:

```yaml
permissions:
  contents: read
```

They do **not** use `pull_request_target`, do not accept arbitrary ZAP targets via `workflow_dispatch` inputs, do not require a service-role key, and do not grant write permissions for issues, pull requests, security events, packages, or id-token.
