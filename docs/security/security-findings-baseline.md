# Security Findings Baseline

## File

`security/baselines/security-findings-baseline.json`

## Purpose

Distinguishes **existing accepted findings** from **newly introduced findings** during pre-merge promotion.

## Normalized fields

| Field | Description |
| --- | --- |
| Scanner | Gitleaks, Semgrep, OSV-Scanner, Trivy, npm audit, ZAP |
| Rule or advisory ID | Scanner-specific identifier |
| File or package | Affected path or package name |
| Normalized path | Repository-relative normalized path |
| Installed version | Package version when applicable |
| Severity | CRITICAL / HIGH / MEDIUM / LOW |
| Runtime classification | MOBILE RUNTIME, BACKEND RUNTIME, BUILD/CI, etc. |
| Finding fingerprint | Stable SHA-256 prefix for comparison |

## Scripts

| Script | Role |
| --- | --- |
| `security/scripts/normalize-security-findings.js` | Produce normalized finding records |
| `security/scripts/compare-security-baseline.js` | Compare current vs baseline |

## Blocking policy

| Condition | Verdict |
| --- | --- |
| Confirmed new secret | BLOCK |
| New Critical mobile/backend runtime | BLOCK |
| New High mobile/backend runtime | BLOCK |
| Existing accepted baseline issue | REPORT |
| New Medium/Low issue | REPORT |
| Scanner execution failure | BLOCK |
| Missing/malformed scanner output | BLOCK |
| Existing project-test failure | BLOCK |

## Updating the baseline

1. Run full static scan on approved integration branch
2. Normalize findings from scanner artifacts
3. Security owner reviews and classifies each finding
4. Update `security-findings-baseline.json` with fingerprints and acceptance metadata
5. Document in `docs/security/initial-security-findings-2026-07-26.md`

Bootstrap note (2026-08-03): the baseline was regenerated from CI run
`30775628038` normalized findings (153 findings across Gitleaks/Semgrep/OSV/Trivy/npm audit)
so the promotion gate can distinguish *new* findings from the already-classified inventory.
Gitleaks hits in `eas.json` and synthetic test fixtures are accepted as report-only until
rotated/remediated; newly introduced secrets still **BLOCK**.

Never add permanent unowned suppressions.
