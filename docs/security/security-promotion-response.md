# Security Promotion Response

## Verdicts

| Verdict | Meaning |
| --- | --- |
| **PASS** | All required checks succeeded; no blocking findings |
| **PASS WITH REPORT-ONLY FINDINGS** | Merge allowed; review attached reports |
| **BLOCKED** | New blocking finding or failed security test |
| **OPERATIONAL FAILURE** | Scanner/deploy infrastructure failure |

## When merge is blocked

1. Open the failed GitHub Actions run for the PR head SHA
2. Download artifacts:
   - `baseline-comparison-<run>`
   - `promotion-verdict-<run>`
   - Scanner-specific reports
3. Read **Security promotion gate** job summary

## Triage by failure type

| Failure | First action |
| --- | --- |
| New secret (Gitleaks) | Rotate credential; remove from history; never commit fix without rotation |
| New Critical/High runtime | Fix code or request time-bound exception with owner + expiration |
| Baseline comparison BLOCKED | Confirm fingerprint is truly new vs baseline drift |
| Staging deploy failure | Check `SUPABASE_ACCESS_TOKEN` and staging project ref guard logs |
| ZAP operational (exit 3) | Verify `ZAP_STAGING_URL`, host allowlist, staging reachability |
| Missing report | Re-run failed scanner job; check artifact upload |

## Emergency bypass

Branch ruleset allows **OrganizationAdmin** bypass only. Every bypass must be:

- Recorded in incident log
- Retested within 24 hours
- Followed by a corrective PR

Identity: GitHub organization administrators for `kscanaiapp`.

## Promotion procedure (normal)

1. Open PR targeting protected branch
2. Wait for all 12 required checks on latest commit
3. Confirm **Security promotion gate** = PASS or PASS WITH REPORT-ONLY FINDINGS
4. Obtain required review approval
5. Merge (branch must be up to date)

## Rollback after bad merge

1. Revert merge commit on protected branch
2. Re-deploy last green staging candidate
3. Open incident record with artifact links from last known-good run
