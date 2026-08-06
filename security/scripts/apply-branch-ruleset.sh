#!/usr/bin/env bash
# Apply GitHub branch ruleset for protected integration branches.
# Requires: gh auth with admin:repo scope
# Usage: ./security/scripts/apply-branch-ruleset.sh
#
# 2026-08-06: required_status_checks previously listed context names that no
# job has ever produced (e.g. "Project security checks", "ZAP Baseline
# staging" without parens, "Security baseline comparison", "Static security
# gate") and the ref list omitted staging/production-parity — the actual
# canonical staging branch this whole security funnel protects. A GitHub
# branch ruleset requiring a status-check context that can never be reported
# blocks merges permanently (fail-closed, but for the wrong reason, forever).
# Names below are the exact check-run names evaluate-promotion-gate.js
# requires (security/scripts/evaluate-promotion-gate.js — keep both in sync).

set -euo pipefail

REPO="${GITHUB_REPOSITORY:-kscanaiapp/kscan-app}"

RULESET_JSON="$(cat <<'EOF'
{
  "name": "K Scan pre-merge security gate",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": [
        "refs/heads/master",
        "refs/heads/staging/production-parity",
        "refs/heads/ios/full-submission-readiness-v2",
        "refs/heads/integration/ios-v18-release-candidate",
        "refs/heads/integration/android-v27-closet-release-candidate"
      ],
      "exclude": []
    }
  },
  "rules": [
    { "type": "pull_request", "parameters": { "required_approving_review_count": 1, "dismiss_stale_reviews_on_push": true, "require_code_owner_review": false, "require_last_push_approval": false } },
    { "type": "required_status_checks", "parameters": {
      "strict_required_status_checks_policy": true,
      "required_status_checks": [
        { "context": "Project checks", "integration_id": null },
        { "context": "Gitleaks", "integration_id": null },
        { "context": "Semgrep Community Edition", "integration_id": null },
        { "context": "OSV-Scanner", "integration_id": null },
        { "context": "Trivy filesystem", "integration_id": null },
        { "context": "npm audit", "integration_id": null },
        { "context": "Migration validation", "integration_id": null },
        { "context": "Contract tests", "integration_id": null },
        { "context": "Candidate Artifact Exposure Gate", "integration_id": null },
        { "context": "Security promotion gate", "integration_id": null }
      ]
    }},
    { "type": "non_fast_forward" },
    { "type": "deletion" }
  ],
  "bypass_actors": [
    {
      "actor_id": 1,
      "actor_type": "OrganizationAdmin",
      "bypass_mode": "always"
    }
  ]
}
EOF
)"

echo "Applying ruleset to ${REPO}..."
echo "${RULESET_JSON}" | gh api --method POST "/repos/${REPO}/rulesets" --input -
echo "Ruleset applied. Emergency bypass: OrganizationAdmin role (document owner identity in runbook)."
