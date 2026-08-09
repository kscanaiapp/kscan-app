#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseEvidence } = require('../../security/scripts/parse-native-mobile-evidence');
const inventory = require('../../security/native/required-mobile-flows.json').flows;

const SHA = 'a'.repeat(40);
function evidence(platform, overrides = {}) {
  const flows = inventory.filter((flow) => flow.platforms.includes(platform)).map((flow) => ({
    id: flow.id,
    result: flow.required ? 'PASS' : 'NOT_APPLICABLE',
  }));
  return {
    platform, runner: 'maestro', build_identifier: `${platform}-build-42`, run_id: '42',
    tested_sha: SHA, result: 'PASS', flows,
    artifact_links: ['https://github.com/kscanaiapp/kscan-app/actions/runs/42'],
    ...overrides,
  };
}

for (const platform of ['android', 'ios']) {
  test(`${platform} complete exact-SHA evidence passes`, () => {
    const parsed = parseEvidence(evidence(platform), { platform, candidate_sha: SHA, run_id: '42' });
    assert.equal(parsed.result, 'PASS');
    assert.equal(parsed.contract_validated, true);
    assert.equal(parsed.flows_failed, 0);
  });

  test(`${platform} wrong SHA blocks`, () => {
    const parsed = parseEvidence(evidence(platform, { tested_sha: 'b'.repeat(40) }), { platform, candidate_sha: SHA, run_id: '42' });
    assert.equal(parsed.result, 'BLOCKED');
    assert.equal(parsed.reason, 'MOBILE_TEST_SHA_MISMATCH');
  });
}

test('runner infrastructure crash is operational failure', () => {
  const parsed = parseEvidence(evidence('android', { result: 'OPERATIONAL_FAILURE', infrastructure_failure: true }), {
    platform: 'android', candidate_sha: SHA, run_id: '42',
  });
  assert.equal(parsed.result, 'OPERATIONAL_FAILURE');
  assert.equal(parsed.reason, 'NATIVE_TEST_INFRASTRUCTURE_FAILURE');
});

test('known optional flow may be not applicable', () => {
  const parsed = parseEvidence(evidence('ios'), { platform: 'ios', candidate_sha: SHA, run_id: '42' });
  assert.equal(parsed.result, 'PASS');
  assert.ok(parsed.flow_results.some((flow) => flow.id === 'resilience.deep_link' && flow.result === 'NOT_APPLICABLE'));
});

test('missing required flow blocks the release evidence', () => {
  const input = evidence('android');
  input.flows = input.flows.filter((flow) => flow.id !== 'auth.session_restore');
  const parsed = parseEvidence(input, { platform: 'android', candidate_sha: SHA, run_id: '42' });
  assert.equal(parsed.result, 'BLOCKED');
  assert.equal(parsed.reason, 'REQUIRED_MOBILE_FLOW_MISSING');
});

test('TestSprite cannot be relabeled as a native runner', () => {
  const parsed = parseEvidence(evidence('ios', { runner: 'TestSprite frontend' }), {
    platform: 'ios', candidate_sha: SHA, run_id: '42',
  });
  assert.equal(parsed.result, 'BLOCKED');
  assert.equal(parsed.reason, 'UNSUPPORTED_TESTSPRITE_NATIVE_RUNNER');
});
