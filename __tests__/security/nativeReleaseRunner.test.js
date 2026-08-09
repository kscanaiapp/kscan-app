'use strict';

// Proves the native runner's evidence builder and the certification parser agree.
//
// The builder runs inside the release workflow; the parser runs inside
// certification. If they disagree, a run could look green to one and missing to
// the other. Every test here therefore feeds builder output straight into the
// parser, which is exactly the production path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildEvidence, parseJUnit } = require('../../security/scripts/build-native-mobile-evidence.js');
const { parseEvidence } = require('../../security/scripts/parse-native-mobile-evidence.js');

const ROOT = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'security', 'native', 'release-flow-manifest.json'), 'utf8'));
const requiredFlows = JSON.parse(fs.readFileSync(path.join(ROOT, 'security', 'native', 'required-mobile-flows.json'), 'utf8')).flows;

const CANDIDATE_SHA = 'a99616ea249348bf2b5d0f37a444b15fdb0b280f';
const RUN_ID = '1234567890';
const LINKS = ['https://github.com/kscanaiapp/kscan-app/actions/runs/1234567890'];

function junitFor(ids, overrides = {}) {
  const cases = ids.map((id) => {
    const state = overrides[id];
    if (state === 'failed') {
      return `<testcase name="${id}" classname="release"><failure message="assertion failed">trace</failure></testcase>`;
    }
    if (state === 'skipped') {
      return `<testcase name="${id}" classname="release"><skipped/></testcase>`;
    }
    return `<testcase name="${id}" classname="release"/>`;
  });
  return `<?xml version="1.0"?><testsuites><testsuite name="release">${cases.join('')}</testsuite></testsuites>`;
}

function allIdsFor(platform) {
  return manifest.flows.filter((flow) => flow.platforms.includes(platform)).map((flow) => flow.id);
}

function build(platform, reportXml, extra = {}) {
  return buildEvidence({
    platform,
    candidateSha: CANDIDATE_SHA,
    runId: RUN_ID,
    buildIdentifier: `${platform}-release-${CANDIDATE_SHA.slice(0, 12)}`,
    runner: 'Maestro',
    reportXml,
    artifactLinks: LINKS,
    deviceIdentity: platform === 'android' ? 'Pixel_6_API_34' : 'iPhone-15,iOS-17.5',
    ...extra,
  });
}

function certify(evidence, platform) {
  return parseEvidence(evidence, { platform, candidate_sha: CANDIDATE_SHA, run_id: RUN_ID });
}

// ── Manifest integrity ───────────────────────────────────────────────────────

test('every required flow has a manifest entry and a flow file', () => {
  for (const required of requiredFlows) {
    const entry = manifest.flows.find((flow) => flow.id === required.id);
    assert.ok(entry, `required flow ${required.id} is missing from the release flow manifest`);
    for (const platform of required.platforms) {
      assert.ok(
        entry.platforms.includes(platform),
        `${required.id} must be mapped for ${platform}`,
      );
    }
    const flowPath = path.join(ROOT, manifest.flow_root, entry.file);
    assert.ok(fs.existsSync(flowPath), `flow file missing for ${required.id}: ${entry.file}`);
  }
});

test('each release flow declares its required flow id as its Maestro name', () => {
  // The builder matches Maestro testcases by name, so this binding is what makes
  // the evidence mapping deterministic rather than order-dependent.
  for (const entry of manifest.flows) {
    const content = fs.readFileSync(path.join(ROOT, manifest.flow_root, entry.file), 'utf8');
    assert.match(
      content,
      new RegExp(`^name:\\s*"?${entry.id.replace(/\./g, '\\.')}"?\\s*$`, 'm'),
      `${entry.file} must declare "name: ${entry.id}"`,
    );
  }
});

test('release flows are branch-neutral and carry no Build 2.5 dependency', () => {
  for (const entry of manifest.flows) {
    const content = fs.readFileSync(path.join(ROOT, manifest.flow_root, entry.file), 'utf8');
    assert.doesNotMatch(content, /build25|build-25|ios-build25/i, `${entry.file} must not depend on Build 2.5`);
  }
});

// ── Builder to parser agreement ──────────────────────────────────────────────

for (const platform of ['android', 'ios']) {
  test(`${platform}: a complete passing run certifies as PASS`, () => {
    const evidence = build(platform, junitFor(allIdsFor(platform)));
    assert.equal(evidence.result, 'PASS');

    const certified = certify(evidence, platform);
    assert.equal(certified.result, 'PASS', JSON.stringify(certified.validation_failures));
    assert.equal(certified.contract_validated, true);
    assert.equal(certified.tested_sha, CANDIDATE_SHA);
    assert.equal(certified.missing_required_flows.length, 0);
    assert.ok(certified.flows_passed >= requiredFlows.filter((f) => f.required && f.platforms.includes(platform)).length);
  });

  test(`${platform}: a failed critical flow certifies as BLOCKED`, () => {
    const ids = allIdsFor(platform);
    const evidence = build(platform, junitFor(ids, { 'auth.sign_in': 'failed' }));
    assert.equal(evidence.result, 'BLOCKED');

    const certified = certify(evidence, platform);
    assert.equal(certified.result, 'BLOCKED');
    assert.ok(certified.flows_failed >= 1);
  });

  test(`${platform}: a missing required flow certifies as BLOCKED, not PASS`, () => {
    const ids = allIdsFor(platform).filter((id) => id !== 'privacy.settings');
    const evidence = build(platform, junitFor(ids));
    assert.equal(evidence.result, 'BLOCKED');

    const certified = certify(evidence, platform);
    assert.equal(certified.result, 'BLOCKED');
    assert.ok(certified.missing_required_flows.includes('privacy.settings'));
    assert.ok(certified.validation_failures.includes('REQUIRED_MOBILE_FLOW_MISSING'));
  });

  test(`${platform}: an infrastructure fault is OPERATIONAL_FAILURE, never BLOCKED`, () => {
    const evidence = build(platform, junitFor(allIdsFor(platform)), { infrastructureFailure: true });
    assert.equal(evidence.result, 'OPERATIONAL_FAILURE');

    const certified = certify(evidence, platform);
    assert.equal(certified.result, 'OPERATIONAL_FAILURE');
  });

  test(`${platform}: a missing report is OPERATIONAL_FAILURE`, () => {
    const evidence = build(platform, null);
    assert.equal(evidence.result, 'OPERATIONAL_FAILURE');
    assert.equal(evidence.reason, 'NATIVE_REPORT_MISSING');
    assert.equal(certify(evidence, platform).result, 'OPERATIONAL_FAILURE');
  });

  test(`${platform}: evidence for the wrong SHA is BLOCKED`, () => {
    const evidence = build(platform, junitFor(allIdsFor(platform)));
    const certified = parseEvidence(evidence, {
      platform,
      candidate_sha: '0'.repeat(40),
      run_id: RUN_ID,
    });
    assert.equal(certified.result, 'BLOCKED');
    assert.ok(certified.validation_failures.includes('MOBILE_TEST_SHA_MISMATCH'));
  });

  test(`${platform}: evidence from a different run id is BLOCKED`, () => {
    const evidence = build(platform, junitFor(allIdsFor(platform)));
    const certified = parseEvidence(evidence, {
      platform,
      candidate_sha: CANDIDATE_SHA,
      run_id: '999',
    });
    assert.equal(certified.result, 'BLOCKED');
    assert.ok(certified.validation_failures.includes('NATIVE_RUN_ID_MISMATCH'));
  });

  test(`${platform}: a required flow cannot opt out via skip`, () => {
    const evidence = build(platform, junitFor(allIdsFor(platform), { 'scanner.successful_scan': 'skipped' }));
    assert.equal(evidence.result, 'BLOCKED');
    assert.equal(certify(evidence, platform).result, 'BLOCKED');
  });

  test(`${platform}: TestSprite is rejected as a native runner`, () => {
    const evidence = build(platform, junitFor(allIdsFor(platform)));
    const certified = certify({ ...evidence, runner: 'TestSprite' }, platform);
    assert.equal(certified.result, 'BLOCKED');
    assert.ok(certified.validation_failures.includes('UNSUPPORTED_TESTSPRITE_NATIVE_RUNNER'));
  });

  test(`${platform}: evidence without artifact links is BLOCKED`, () => {
    const evidence = build(platform, junitFor(allIdsFor(platform)), { artifactLinks: [] });
    const certified = certify(evidence, platform);
    assert.equal(certified.result, 'BLOCKED');
    assert.ok(certified.validation_failures.includes('NATIVE_ARTIFACT_LINK_MISSING'));
  });

  test(`${platform}: the optional deep-link flow may be absent without blocking`, () => {
    const ids = allIdsFor(platform).filter((id) => id !== 'resilience.deep_link');
    const evidence = build(platform, junitFor(ids));
    assert.equal(evidence.result, 'PASS');
    assert.equal(certify(evidence, platform).result, 'PASS');
  });
}

// ── JUnit reader ─────────────────────────────────────────────────────────────

test('JUnit reader handles self-closing, failed, and skipped cases', () => {
  const xml = '<testsuites><testsuite>'
    + '<testcase name="a" classname="c"/>'
    + '<testcase name="b" classname="c"><failure message="boom">t</failure></testcase>'
    + '<testcase name="c" classname="c"><skipped/></testcase>'
    + '</testsuite></testsuites>';
  const cases = parseJUnit(xml);
  assert.equal(cases.length, 3);
  assert.equal(cases[0].failed, false);
  assert.equal(cases[1].failed, true);
  assert.equal(cases[1].message, 'boom');
  assert.equal(cases[2].skipped, true);
});

test('JUnit reader decodes escaped names', () => {
  const cases = parseJUnit('<testcase name="auth &amp; onboarding" classname="c"/>');
  assert.equal(cases[0].name, 'auth & onboarding');
});
