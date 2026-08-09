#!/usr/bin/env node
'use strict';

// Turns a Maestro JUnit report into the native mobile evidence document defined
// by docs/release/native-mobile-evidence-contract.md.
//
// This script only *reports*. It never decides that a release is acceptable:
// security/scripts/parse-native-mobile-evidence.js re-validates the output
// against security/native/required-mobile-flows.json during certification. That
// separation is deliberate — a runner cannot vouch for itself.
//
// Fail-closed rules:
//   - a required flow that Maestro never reported is simply absent from flows[],
//     so the parser raises REQUIRED_MOBILE_FLOW_MISSING
//   - an unparseable/missing report is OPERATIONAL_FAILURE, not BLOCKED, so an
//     emulator or build fault is never laundered into a security verdict
//   - a Maestro failure on a required flow is BLOCKED

const fs = require('node:fs');
const path = require('node:path');

const MANIFEST = path.join(__dirname, '..', 'native', 'release-flow-manifest.json');

function decodeXmlEntities(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`));
  return match ? decodeXmlEntities(match[1]) : null;
}

// Minimal JUnit reader. Maestro emits a flat <testsuites>/<testsuite>/<testcase>
// shape; a dependency-free reader keeps this runnable on a bare CI image.
function parseJUnit(xml) {
  const cases = [];
  const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let match;
  while ((match = caseRe.exec(xml)) !== null) {
    const tag = match[1];
    const body = match[3] || '';
    const name = attr(tag, 'name') || '';
    const classname = attr(tag, 'classname') || '';
    const failed = /<(failure|error)\b/.test(body);
    const skipped = /<skipped\b/.test(body);
    let message = null;
    const failureTag = body.match(/<(?:failure|error)\b([^>]*)>/);
    if (failureTag) message = attr(failureTag[1], 'message');
    cases.push({ name: name.trim(), classname: classname.trim(), failed, skipped, message });
  }
  return cases;
}

function normalizeKey(value) {
  return String(value).trim().toLowerCase().replace(/\.(yaml|yml)$/, '');
}

function buildEvidence(options) {
  const {
    platform,
    candidateSha,
    runId,
    buildIdentifier,
    runner,
    reportXml,
    artifactLinks = [],
    deviceIdentity = null,
    infrastructureFailure = false,
    manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')),
  } = options;

  const expected = manifest.flows.filter((flow) => flow.platforms.includes(platform));

  if (infrastructureFailure || reportXml == null) {
    return {
      platform,
      runner,
      build_identifier: buildIdentifier,
      run_id: runId,
      tested_sha: candidateSha,
      device: deviceIdentity,
      result: 'OPERATIONAL_FAILURE',
      reason: reportXml == null ? 'NATIVE_REPORT_MISSING' : 'NATIVE_TEST_INFRASTRUCTURE_FAILURE',
      flows: [],
      artifact_links: artifactLinks,
    };
  }

  let cases;
  try {
    cases = parseJUnit(reportXml);
  } catch (error) {
    return {
      platform,
      runner,
      build_identifier: buildIdentifier,
      run_id: runId,
      tested_sha: candidateSha,
      device: deviceIdentity,
      result: 'OPERATIONAL_FAILURE',
      reason: 'NATIVE_REPORT_UNPARSEABLE',
      flows: [],
      artifact_links: artifactLinks,
    };
  }

  // Release flows declare `name:` equal to their required flow id, so the primary
  // match is exact. Filename matching is a fallback for locally renamed flows.
  const byName = new Map();
  for (const testcase of cases) {
    for (const key of [testcase.name, testcase.classname]) {
      if (key) byName.set(normalizeKey(key), testcase);
    }
  }

  const flows = [];
  for (const expectedFlow of expected) {
    const testcase = byName.get(normalizeKey(expectedFlow.id))
      || byName.get(normalizeKey(expectedFlow.file));
    if (!testcase) continue; // absent -> parser raises REQUIRED_MOBILE_FLOW_MISSING

    let result = 'PASS';
    if (testcase.failed) result = 'BLOCKED';
    else if (testcase.skipped) result = 'NOT_APPLICABLE';

    flows.push({
      id: expectedFlow.id,
      result,
      reason: testcase.message || null,
      artifact_links: [],
    });
  }

  const requiredIds = new Set(
    require(path.join(__dirname, '..', 'native', 'required-mobile-flows.json')).flows
      .filter((flow) => flow.required && flow.platforms.includes(platform))
      .map((flow) => flow.id),
  );
  const requiredFlows = flows.filter((flow) => requiredIds.has(flow.id));
  const missing = [...requiredIds].filter((id) => !flows.some((flow) => flow.id === id));

  let result = 'PASS';
  let reason = null;
  if (missing.length) {
    result = 'BLOCKED';
    reason = 'REQUIRED_MOBILE_FLOW_MISSING';
  } else if (requiredFlows.some((flow) => flow.result === 'BLOCKED')) {
    result = 'BLOCKED';
    reason = 'CRITICAL_MOBILE_FLOW_FAILED';
  } else if (requiredFlows.some((flow) => flow.result === 'NOT_APPLICABLE')) {
    // A required flow may not opt out of running.
    result = 'BLOCKED';
    reason = 'REQUIRED_MOBILE_FLOW_NOT_PASSING';
  }

  return {
    platform,
    runner,
    build_identifier: buildIdentifier,
    run_id: runId,
    tested_sha: candidateSha,
    device: deviceIdentity,
    result,
    reason,
    flows,
    artifact_links: artifactLinks,
  };
}

function arg(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function main() {
  const args = process.argv.slice(2);
  const platform = arg(args, '--platform');
  const candidateSha = arg(args, '--candidate-sha');
  const runId = arg(args, '--run-id');
  const buildIdentifier = arg(args, '--build-identifier');
  const runner = arg(args, '--runner', 'Maestro');
  const reportPath = arg(args, '--report');
  const outputPath = arg(args, '--output');
  const deviceIdentity = arg(args, '--device');
  const artifactLinks = (arg(args, '--artifact-links', '') || '')
    .split(',')
    .map((link) => link.trim())
    .filter(Boolean);

  if (!platform || !candidateSha || !outputPath) {
    throw new Error('Usage: --platform <android|ios> --candidate-sha <sha> --output <json> [--report <junit.xml>] [--run-id <id>] [--build-identifier <id>] [--device <id>] [--artifact-links <csv>] [--runner <name>]');
  }

  let reportXml = null;
  if (reportPath && fs.existsSync(reportPath)) {
    reportXml = fs.readFileSync(reportPath, 'utf8');
  }

  const evidence = buildEvidence({
    platform,
    candidateSha,
    runId,
    buildIdentifier,
    runner,
    reportXml,
    artifactLinks,
    deviceIdentity,
    infrastructureFailure: args.includes('--infrastructure-failure'),
  });

  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ platform, result: evidence.result, reason: evidence.reason })}\n`);
}

if (require.main === module) main();
module.exports = { buildEvidence, parseJUnit };
