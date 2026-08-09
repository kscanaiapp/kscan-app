#!/usr/bin/env node
'use strict';

// Single source of truth for whether native UI automation is a release gate.
//
// Certification and promotion validation both read this, so re-arming the gate
// is a policy-file edit rather than a code change -- and neither can drift from
// the other by accident.

const fs = require('node:fs');
const path = require('node:path');

const POLICY_PATH = path.join(__dirname, '..', 'release', 'native-ui-automation-policy.json');

// Fail closed: if the policy file is missing or unreadable, treat native UI
// automation as required. A deleted policy file must not silently drop a gate.
const REQUIRED_FALLBACK = Object.freeze({
  status: 'ACTIVE',
  required_for_release: true,
  reason: 'NATIVE_UI_AUTOMATION_POLICY_UNREADABLE',
  policy_outcome: 'REQUIRED_BLOCKING',
  source: 'fallback',
});

function loadPolicy(policyPath = POLICY_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch {
    return { ...REQUIRED_FALLBACK };
  }
  if (!parsed || typeof parsed !== 'object') return { ...REQUIRED_FALLBACK };

  const status = String(parsed.status || '').toUpperCase();
  // Only an explicit SUSPENDED + required_for_release:false suspends the gate.
  // Any other combination keeps it required.
  const suspended = status === 'SUSPENDED' && parsed.required_for_release === false;

  return {
    status: status || 'ACTIVE',
    required_for_release: !suspended,
    reason: parsed.reason || null,
    policy_outcome: suspended
      ? (parsed.policy_outcome || 'NOT_REQUIRED_BY_CURRENT_POLICY')
      : 'REQUIRED_BLOCKING',
    scope: Array.isArray(parsed.scope) ? parsed.scope : [],
    replacement: parsed.replacement ?? null,
    source: policyPath,
  };
}

/**
 * The audit-visible block certification embeds. It is informational: it never
 * contributes a blocker while suspended, and it never claims the tests passed.
 */
function certificationBlock(policy = loadPolicy()) {
  return {
    policy: policy.status,
    reason: policy.reason,
    required: policy.required_for_release,
    result: policy.required_for_release ? 'REQUIRED_BLOCKING' : 'NOT_REQUIRED_BY_CURRENT_POLICY',
  };
}

module.exports = { loadPolicy, certificationBlock, POLICY_PATH, REQUIRED_FALLBACK };
