# Initial Security Findings — 2026-07-26

Approved classified findings from Phase 1 security pipeline (PR #39). These findings
are recorded in `security/baselines/security-findings-baseline.json` and are **report-only**
for merge until reclassified or remediated.

## Summary

| Scanner | Accepted findings | Highest severity |
| --- | ---: | --- |
| Semgrep | 2 | MEDIUM |
| npm audit | 1 | MEDIUM |
| Trivy | 1 | LOW |
| OWASP ZAP Baseline | 1 | LOW |

## Classified findings

### Semgrep — `kscan.wildcard-cors-javascript` (server.js)

- **Classification:** BACKEND RUNTIME (development server only)
- **Severity:** MEDIUM
- **Disposition:** Accepted through 2026-10-26
- **Reason:** Local Express dev CORS; Edge Functions validated separately in staging gate.

### Semgrep — `kscan.client-supplied-owner-identity` (stylechat-generate)

- **Classification:** BACKEND RUNTIME
- **Severity:** MEDIUM
- **Disposition:** Accepted through 2026-10-26
- **Reason:** Low-confidence heuristic; manual review confirmed auth.getUser() enforcement.

### npm audit — transitive build tooling

- **Classification:** BUILD/CI
- **Severity:** MEDIUM
- **Disposition:** Accepted through 2026-09-26

### Trivy — example env placeholder

- **Classification:** DEVELOPMENT ONLY
- **Severity:** LOW
- **Disposition:** Accepted through 2026-09-26

### ZAP Baseline — passive header finding on staging gateway

- **Classification:** BACKEND RUNTIME
- **Severity:** LOW
- **Disposition:** Accepted through 2026-10-26

## Blocking policy (post Phase 2)

New secrets, new Critical/High mobile/backend runtime issues, scanner failures, and
missing reports **block** merge. Existing baseline entries **report** without blocking.
