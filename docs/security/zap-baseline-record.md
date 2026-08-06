# ZAP findings baseline and sensitivity tuning

## Current state (2026-08-06)

**No operational ZAP findings baseline exists yet.** Every recorded run of
`Security - ZAP Baseline Staging` prior to this date failed operationally
(health-check step probed the bare Supabase project root — HTTP 404 by
default — before ZAP ever started; see
`docs/security/staging-security-pipeline-map.md` "Repairs made in this
pass"). `security/zap/zap-findings-baseline.json` intentionally records
`baseline_established: false` rather than an empty-by-omission findings
list, so it is unambiguous that "no findings" here means "never
successfully run," not "scanned clean."

## Establishing the initial baseline (Phase 14)

Do this only after both conditions hold for the **same** `candidate_sha`:

1. `Security - ZAP Baseline Staging` and `Security - ZAP API Staging` both
   complete with all mandatory reports present and parseable (see their
   `report-validation.txt` diagnostics).
2. Both workflows' `zap-out/diagnostics/run-context.json` /
   `zap-api-out/diagnostics/run-context.json` report `sha_match: true` —
   i.e. the scan actually validated what's deployed, not an unrelated SHA.

Then:

1. Download the `zap-baseline-diagnostics-<run>` and `zap-api-diagnostics-<run>`
   artifacts (or the `zap-baseline-report-<run>` / `zap-api-report-<run>`
   artifacts for the full alert list).
2. For each alert, record: ZAP rule ID, risk level, endpoint (method + path,
   with query values redacted), a short non-sensitive evidence snippet
   (never a full response body, header, cookie, or token — see the
   diagnostics-writing steps in both ZAP workflows, which already withhold
   these), and `first_seen_candidate_sha`/`first_seen_at`.
3. Set `baseline_established: true`, fill `candidate_sha` /
   `deployed_staging_sha` / `established_at`, replace `findings: []` with
   the recorded list.
4. Commit as `security: establish initial ZAP findings baseline`.

**Never baseline:**
- An operational failure (ZAP didn't start, or exited abnormally).
- A run with a missing or unparseable mandatory report.
- A run where `sha_match` is `false` or unknown.
- A run against a different backend/target than the approved staging host
  (`yzqjvdfgefveprobvvyw.supabase.co`).

## Sensitivity tuning (Phase 15)

Once the baseline exists, classify every subsequent finding as one of:
`confirmed_vulnerability`, `probable_vulnerability`,
`configuration_weakness`, `informational`, `verified_false_positive`, or
`manual_validation_required` (see the `finding_schema` block in
`zap-findings-baseline.json`).

For any rule-severity adjustment, record in the finding entry (or a
dedicated changelog section below): ZAP rule ID, original severity,
adjusted severity, reason, evidence, endpoint, owner, and an expiration/review
date. Prefer lowering a **verified** false positive to `informational` over
suppressing it outright — it stays visible, just correctly weighted.

**Never downgrade**, regardless of how well-understood a finding seems:
- Production target rejection (`validate-zap-target.js` rejecting
  `wyyuqfdxucjksghsmhry.supabase.co` or any private/metadata host).
- Missing mandatory reports.
- An operational failure classification.
- A SHA mismatch (`sha_match: false`).
- Any secret-exposure finding (Gitleaks, Trivy, or the Candidate Artifact
  Exposure Gate classifier).
- Missing exact-SHA evidence.

Active scanning stays disabled (`ZAP_ACTIVE_ENABLED=false`) regardless of
how mature the baseline becomes — re-enabling active scanning is a distinct,
explicit decision outside this pass's authority (see "Autonomous authority"
stop conditions: "ZAP active mode" requires an explicit ask).

## Severity-adjustment log

| Date | ZAP rule ID | Original severity | Adjusted severity | Reason | Evidence | Endpoint | Owner | Review date |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| _(none yet — baseline not established)_ | | | | | | | | |
