# Security control health monitoring

A security scanner that silently stops running is an outage even when the
application stays up. This defines what's monitored, thresholds, and the
alert/escalation path implemented by
`.github/workflows/security-control-health-monitor.yml` and
`security/scripts/check-security-control-health.js`.

## What's monitored

Per run of the monitor, for each of the six core security workflows (on
`staging/production-parity`, the canonical staging branch):
`Security - Code and Dependencies`, `K Scan Staging Security Gate`,
`Security - ZAP Baseline Staging`, `Security - ZAP API Staging`,
`Security - Promotion Gate`, `Security - Candidate Artifact Exposure Gate`.

Also covered qualitatively (no dedicated automated check yet — see
"Not yet automated" below): mandatory-report generation, artifact exposure
scan execution, promotion/Pre-Publish verdict creation, SHA mismatch, missing
required evidence, unexpected staging function deployment, migration drift,
production-target rejection events.

## Thresholds

| Condition | Level |
| --- | --- |
| Most recent run on `staging/production-parity` succeeded (or legitimately skipped) | HEALTHY |
| Exactly 1 of the last 5 completed runs failed | WARNING |
| 2 or more **consecutive** most-recent runs failed | CRITICAL |
| The workflow has never completed a run on `staging/production-parity` | CRITICAL |
| The health-check API call itself fails (GitHub API error) | CRITICAL for that workflow (fail closed — an unknown state is not assumed healthy) |

Rationale for "2 consecutive" as the CRITICAL bar rather than "any failure":
a single transient failure (flaky network call, GitHub Actions infra hiccup)
is a WARNING worth noticing, not a page; a second consecutive failure rules
out simple flake and indicates the control itself is actually broken —
exactly the ZAP Baseline situation this whole pass started from (every run
failed the same way for the same operational reason).

## Alert owner and escalation

- **Owner:** repository admin/maintainer of `kscanaiapp/kscan-app` (no
  distinct on-call rotation exists for this repo today — see "Not yet
  automated" below for what a future upgrade would add).
- **Mechanism:** a single tracked GitHub issue labeled
  `security-control-health`, opened/updated by the monitor workflow using
  the repository's own `GITHUB_TOKEN` — deliberately no new paid service.
- **Acknowledgement target:** review and comment on the issue within 1
  business day of it opening or being updated with a still-CRITICAL comment.
- **Escalation path:** if the issue remains open and CRITICAL for more than
  3 consecutive monitor runs, treat it as equivalent in priority to a
  production incident — the security funnel's own evidence trail is no
  longer trustworthy until resolved (this is a BLOCKER per the severity
  model: "a scanner operational failure is reported as PASS" is exactly
  what an unmonitored, silently-broken control risks).

## Maintenance behavior

- Planned maintenance (e.g. rotating the Gitleaks/OSV/Trivy pinned
  versions, editing workflow YAML) is expected to produce a transient
  WARNING or single CRITICAL blip while the change lands — the monitor does
  not distinguish planned from unplanned failure. Comment on the tracked
  issue (or preemptively note the maintenance window in the PR) rather than
  suppressing the check.
- The monitor itself has no dependency on the workflows it watches beyond
  read access to their run history — a broken `security-code.yml` cannot
  also break the monitor.

## Recovery validation

The next monitor run (manual `workflow_dispatch` today — see "Known
limitation" below) re-evaluates all six workflows from scratch. Once every
workflow returns to HEALTHY or WARNING, the monitor auto-comments and closes
the tracked issue. No manual "all clear" step is required, but the owner
should still confirm the underlying cause was actually fixed, not just that
the next run happened to pass.

## Known limitation: the cron trigger does not fire yet

`schedule:` triggers are only evaluated by GitHub from the copy of a
workflow file on the repository's **default branch**. This repo's default
branch is `master`, which currently carries no `.github/workflows` at all
(confirmed via `git ls-tree origin/master -- .github/workflows` — empty).
This is the same root cause already documented and worked around for
`workflow_run` in `security-promotion-gate.yml`. The cron schedule in
`security-control-health-monitor.yml` is kept for forward compatibility (it
starts working for free if these workflow files are ever published to
`master`) but **does not run unattended today**. Until then:

- Run it manually via `workflow_dispatch` (GitHub UI, or `gh workflow run
  "Security - Control Health Monitor"`).
- If unattended cadence is required before a `master` publish happens, that
  requires either publishing workflow files to `master` (a default-branch
  change outside this pass's authorized scope — `security/staging-prepublish-security-gate`
  is based on `staging/production-parity`, not `master`) or an external
  scheduler calling the `workflow_dispatch` API, which is a new integration
  point outside this pass's autonomous authority to add unprompted.

## Not yet automated

- Migration drift detection (would need a live staging schema snapshot to
  diff against `supabase/migrations` — no CI job collects that snapshot
  today; same gap noted for `rls-storage-guard.js`/`anon-grant-guard.js` in
  `docs/security/staging-security-pipeline-map.md`).
- Unexpected staging function deployment detection beyond
  `perimeter-manifest-guard.js`'s existing (but CI-unwired) manifest diff.
- A distinct on-call rotation / paging integration — out of this pass's
  scope ("new paid security service" is an explicit stop condition).
