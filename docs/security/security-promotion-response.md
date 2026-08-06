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

2026-08-06: the branch ruleset has **no bypass actors at all**
(`bypass_actors: []`) — `kscanaiapp/kscan-app` is a personal-account
repository, not a GitHub organization, so the `OrganizationAdmin`/`Team`
bypass actor types this doc previously described are not valid for it (the
Rulesets API rejects them outright: "ruleset source must be in an
organization"). This applies to the repo owner too; there is no user or
role that can push past the required checks while the ruleset is active.

To bypass in a genuine emergency, a repo admin must temporarily disable or
delete the ruleset itself via the GitHub UI or `gh api --method PATCH
repos/kscanaiapp/kscan-app/rulesets/<id> -f enforcement=disabled` (or
`--method DELETE`), then re-apply it via
`security/scripts/apply-branch-ruleset.sh` once the emergency is resolved.
Every such bypass must be:

- Recorded in incident log
- Retested within 24 hours
- Followed by a corrective PR

Identity: the repository owner (`kscanaiapp`), the only account with the
permission this action requires.

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
