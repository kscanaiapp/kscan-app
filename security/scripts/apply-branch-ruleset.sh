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
#
# 2026-08-06, same day: this script's payload also failed GitHub's current
# Rulesets API schema validation (422 "data matches no possible input") —
# `required_review_thread_resolution` is a required `pull_request` rule
# parameter this script omitted, and `integration_id: null` on a
# `required_status_checks` entry is invalid (the field must be omitted
# entirely, not passed as null). A third issue: `bypass_actors` with
# `actor_type: "OrganizationAdmin"` is rejected outright ("ruleset source
# must be in an organization") because kscanaiapp/kscan-app is owned by a
# personal GitHub account, not an organization — OrganizationAdmin/Team
# bypass actor types only exist for org-owned repos. Removed rather than
# guessed at a RepositoryRole numeric ID: an empty bypass_actors list (no
# bypass for anyone, including the repo owner) is the safer default and
# avoids a second wrong guess. All three confirmed by iterating against
# `enforcement: "disabled"` test rulesets (created and immediately deleted,
# no live effect) before fixing this file. `gh api --method POST
# "/repos/..."` also needs the leading slash removed on Git Bash / MSYS,
# which otherwise rewrites it as a filesystem path before `gh` sees it.

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
    { "type": "pull_request", "parameters": { "required_approving_review_count": 1, "dismiss_stale_reviews_on_push": true, "require_code_owner_review": false, "require_last_push_approval": false, "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": {
      "strict_required_status_checks_policy": true,
      "required_status_checks": [
        { "context": "Project checks" },
        { "context": "Gitleaks" },
        { "context": "Semgrep Community Edition" },
        { "context": "OSV-Scanner" },
        { "context": "Trivy filesystem" },
        { "context": "npm audit" },
        { "context": "Migration validation" },
        { "context": "Contract tests" },
        { "context": "Candidate Artifact Exposure Gate" },
        { "context": "Security promotion gate" }
      ]
    }},
    { "type": "non_fast_forward" },
    { "type": "deletion" }
  ],
  "bypass_actors": []
}
EOF
)"

echo "Applying ruleset to ${REPO}..."
# No leading slash on the endpoint: some shells (Git Bash / MSYS on
# Windows) rewrite a leading "/repos/..." as a filesystem path before gh
# ever sees it. See https://github.com/cli/cli docs on this MSYS quirk.
echo "${RULESET_JSON}" | gh api --method POST "repos/${REPO}/rulesets" --input -
echo "Ruleset applied. No bypass actors — kscanaiapp/kscan-app is a personal-account repo, not an organization, so OrganizationAdmin/Team bypass types are unavailable; this applies to the repo owner too. To bypass in a genuine emergency, an admin must temporarily disable or delete the ruleset via the GitHub UI or 'gh api'."
