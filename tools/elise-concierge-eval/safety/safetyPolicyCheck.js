'use strict';

/**
 * Structural validation of authority/safetyPolicyMap.json (spec section 43):
 * every listed policy must cite a real source file and an evaluation class,
 * and every POLICY_GAP must be explicitly labeled as such rather than
 * silently omitted. This is a completeness check on the MAP, not a live
 * safety judgment.
 */

const path = require('node:path');
const fs = require('node:fs');

function loadSafetyPolicyMap() {
  const p = path.join(__dirname, '..', 'authority', 'safetyPolicyMap.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function checkSafetyPolicyMapCompleteness(map) {
  const errors = [];
  if (!Array.isArray(map.policies) || !map.policies.length) {
    errors.push('safetyPolicyMap.policies must be a non-empty array');
  } else {
    map.policies.forEach((policy, i) => {
      if (!policy.id) errors.push(`policies[${i}] missing id`);
      if (!policy.status) errors.push(`policies[${i}] missing status`);
      if (policy.status === 'PROVEN' && !policy.sourceFile) {
        errors.push(`policies[${i}] (${policy.id}) status PROVEN but no sourceFile cited`);
      }
      if (!policy.evaluationClass) errors.push(`policies[${i}] (${policy.id}) missing evaluationClass`);
    });
  }
  if (!map.bodyAppearanceSafetyClass || map.bodyAppearanceSafetyClass.verdict !== 'SAFETY POLICY COVERAGE GAP') {
    errors.push('bodyAppearanceSafetyClass must explicitly record the SAFETY POLICY COVERAGE GAP verdict (spec section 44) rather than inventing a rule');
  }
  return { valid: errors.length === 0, errors };
}

/** Overall map status for reporting: COMPLETE only if every entry has a status and no structural errors exist. */
function summarizeStatus(map) {
  const gaps = (map.policies || []).filter((p) => p.status === 'POLICY_GAP').length;
  const proven = (map.policies || []).filter((p) => p.status === 'PROVEN').length;
  return {
    provenCount: proven,
    gapCount: gaps + (map.otherSafetyGapsObserved ? map.otherSafetyGapsObserved.length : 0),
    overall: gaps > 0 || (map.otherSafetyGapsObserved || []).length > 0 ? 'GAPS' : 'COMPLETE',
  };
}

module.exports = { loadSafetyPolicyMap, checkSafetyPolicyMapCompleteness, summarizeStatus };
