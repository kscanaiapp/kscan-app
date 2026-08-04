#!/usr/bin/env bash
# Apply GitHub branch ruleset for protected integration branches.
# Requires: gh auth with admin:repo scope
# Usage: ./security/scripts/apply-branch-ruleset.sh

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
        { "context": "Project security checks", "integration_id": null },
        { "context": "Gitleaks secret scan", "integration_id": null },
        { "context": "Semgrep code scan", "integration_id": null },
        { "context": "OSV dependency scan", "integration_id": null },
        { "context": "Trivy repository scan", "integration_id": null },
        { "context": "npm dependency audit", "integration_id": null },
        { "context": "Security baseline comparison", "integration_id": null },
        { "context": "Static security gate", "integration_id": null },
        { "context": "Staging security gate", "integration_id": null },
        { "context": "ZAP Baseline staging", "integration_id": null },
        { "context": "ZAP API staging", "integration_id": null },
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
