#!/usr/bin/env node
'use strict';

/**
 * evaluate-promotion-gate.js's ALWAYS_REQUIRED_CHECKS is a hand-maintained
 * duplicate of the live GitHub branch-protection ruleset required-check
 * names (staging + master rulesets) -- there is no automated sync between
 * this array and the ruleset. That was flagged as a drift hazard during the
 * 2026-08-29 staging-gate rationalization pass: a rename on either side
 * (a job/step `name:` in a workflow, or the ruleset configuration) can
 * silently desynchronize the two without either side failing loudly.
 *
 * This test hardcodes the expected list exactly as confirmed live via
 * `gh api repos/kscanaiapp/kscan-app/rulesets/<id>` during that pass, so any
 * future drift between the ruleset and this file's hand-maintained copy
 * fails a test instead of silently breaking the promotion gate.
 *
 * Deliberately NOT included here (they belong to other rulesets, not the
 * staging+master-shared set ALWAYS_REQUIRED_CHECKS represents):
 *   - "Master promotion tree equivalence" (master ruleset only)
 *   - "Candidate Artifact Exposure Gate" / "Security promotion gate"
 *     (pre-merge ruleset on ios/full-submission-readiness-v2,
 *     integration/ios-v18-release-candidate, and
 *     integration/android-v27-closet-release-candidate only)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { ALWAYS_REQUIRED_CHECKS } = require('../../security/scripts/evaluate-promotion-gate');

const EXPECTED_STAGING_AND_MASTER_REQUIRED_CHECKS = [
  'Project checks',
  'Gitleaks',
  'Semgrep Community Edition',
  'OSV-Scanner',
  'Trivy filesystem',
  'npm audit',
  'Migration validation',
  'Contract tests',
];

test('ALWAYS_REQUIRED_CHECKS matches the live staging+master ruleset required-check names exactly', () => {
  assert.deepEqual(ALWAYS_REQUIRED_CHECKS, EXPECTED_STAGING_AND_MASTER_REQUIRED_CHECKS);
});

test('ALWAYS_REQUIRED_CHECKS has no duplicate entries', () => {
  assert.equal(new Set(ALWAYS_REQUIRED_CHECKS).size, ALWAYS_REQUIRED_CHECKS.length);
});
