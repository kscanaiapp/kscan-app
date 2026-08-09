#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RESULTS = new Set(['PASS', 'BLOCKED', 'PENDING', 'NOT_APPLICABLE', 'OPERATIONAL_FAILURE']);
const SHA = /^[0-9a-f]{40}$/i;

function normalize(value) {
  return String(value || 'OPERATIONAL_FAILURE').trim().toUpperCase().replace(/[ -]+/g, '_');
}

function defaultRequiredFlows() {
  return require('../native/required-mobile-flows.json').flows;
}

function parseEvidence(input, options = {}) {
  const platform = String(options.platform || input.platform || '').toLowerCase();
  if (!['android', 'ios'].includes(platform)) throw new Error('platform must be android or ios');

  const candidateSha = String(options.candidate_sha || '');
  const expectedRunId = options.run_id == null ? null : String(options.run_id);
  const testedSha = typeof input.tested_sha === 'string' ? input.tested_sha : null;
  const runner = typeof input.runner === 'string' ? input.runner.trim() : '';
  const buildIdentifier = typeof input.build_identifier === 'string' ? input.build_identifier.trim() : '';
  const runId = input.run_id == null ? '' : String(input.run_id).trim();
  const requestedResult = normalize(input.result || input.status);
  const flows = Array.isArray(input.flows) ? input.flows.map((flow) => ({
    id: typeof flow.id === 'string' ? flow.id.trim() : '',
    result: normalize(flow.result || flow.status),
    artifact_links: Array.isArray(flow.artifact_links) ? flow.artifact_links.filter((link) => typeof link === 'string' && link) : [],
    reason: typeof flow.reason === 'string' ? flow.reason : null,
  })) : [];
  const artifactLinks = Array.isArray(input.artifact_links)
    ? input.artifact_links.filter((link) => typeof link === 'string' && /^https:\/\//.test(link))
    : [];
  const required = (options.required_flows || defaultRequiredFlows())
    .filter((flow) => flow.required && flow.platforms.includes(platform))
    .map((flow) => flow.id);
  const byId = new Map(flows.map((flow) => [flow.id, flow]));
  const missing = required.filter((id) => !byId.has(id));
  const invalidFlowResults = flows.filter((flow) => !flow.id || !RESULTS.has(flow.result));
  const requiredNotPassing = required.filter((id) => byId.has(id) && byId.get(id).result !== 'PASS');
  const failures = [];

  if (!SHA.test(candidateSha)) failures.push('INVALID_CANDIDATE_SHA');
  if (!testedSha || testedSha !== candidateSha) failures.push('MOBILE_TEST_SHA_MISMATCH');
  if (!runner) failures.push('NATIVE_RUNNER_MISSING');
  if (/testsprite/i.test(runner)) failures.push('UNSUPPORTED_TESTSPRITE_NATIVE_RUNNER');
  if (!buildIdentifier) failures.push('NATIVE_BUILD_IDENTIFIER_MISSING');
  if (!runId) failures.push('NATIVE_RUN_ID_MISSING');
  if (expectedRunId && runId !== expectedRunId) failures.push('NATIVE_RUN_ID_MISMATCH');
  if (!RESULTS.has(requestedResult)) failures.push('INVALID_NATIVE_RESULT');
  if (missing.length) failures.push('REQUIRED_MOBILE_FLOW_MISSING');
  if (invalidFlowResults.length) failures.push('INVALID_MOBILE_FLOW_RESULT');
  if (!artifactLinks.length) failures.push('NATIVE_ARTIFACT_LINK_MISSING');

  let result = requestedResult;
  if (failures.includes('MOBILE_TEST_SHA_MISMATCH') || failures.some((failure) => [
    'UNSUPPORTED_TESTSPRITE_NATIVE_RUNNER', 'NATIVE_BUILD_IDENTIFIER_MISSING', 'NATIVE_RUN_ID_MISSING',
    'NATIVE_RUN_ID_MISMATCH', 'REQUIRED_MOBILE_FLOW_MISSING', 'INVALID_MOBILE_FLOW_RESULT',
    'NATIVE_ARTIFACT_LINK_MISSING', 'INVALID_CANDIDATE_SHA', 'INVALID_NATIVE_RESULT',
  ].includes(failure))) {
    result = 'BLOCKED';
  } else if (input.infrastructure_failure === true || requestedResult === 'OPERATIONAL_FAILURE') {
    result = 'OPERATIONAL_FAILURE';
  } else if (requiredNotPassing.some((id) => byId.get(id).result === 'BLOCKED')) {
    result = 'BLOCKED';
  } else if (requiredNotPassing.some((id) => byId.get(id).result === 'OPERATIONAL_FAILURE')) {
    result = 'OPERATIONAL_FAILURE';
  } else if (requiredNotPassing.some((id) => byId.get(id).result === 'PENDING')) {
    result = 'PENDING';
  } else if (requiredNotPassing.length) {
    result = 'BLOCKED';
    failures.push('REQUIRED_MOBILE_FLOW_NOT_PASSING');
  } else if (requestedResult === 'PASS') {
    result = 'PASS';
  }

  const reason = failures[0]
    || (result === 'OPERATIONAL_FAILURE' ? 'NATIVE_TEST_INFRASTRUCTURE_FAILURE' : null)
    || (result === 'PENDING' ? 'NATIVE_TEST_STILL_RUNNING' : null)
    || (result === 'BLOCKED' ? 'CRITICAL_MOBILE_FLOW_FAILED' : null);

  return {
    platform,
    runner: runner || null,
    build_identifier: buildIdentifier || null,
    run_id: runId || null,
    tested_sha: testedSha,
    result,
    flows_run: flows.length,
    flows_passed: flows.filter((flow) => flow.result === 'PASS').length,
    flows_failed: flows.filter((flow) => flow.result === 'BLOCKED').length,
    artifact_links: artifactLinks,
    flow_results: flows,
    required_flows: required,
    missing_required_flows: missing,
    validation_failures: failures,
    reason,
    contract_validated: failures.length === 0,
  };
}

function arg(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function main() {
  const args = process.argv.slice(2);
  const inputPath = arg(args, '--input');
  const outputPath = arg(args, '--output');
  const platform = arg(args, '--platform');
  const candidateSha = arg(args, '--candidate-sha');
  const runId = arg(args, '--run-id');
  if (!inputPath || !outputPath || !platform || !candidateSha) {
    throw new Error('Usage: --input <json> --output <json> --platform <android|ios> --candidate-sha <sha> [--run-id <id>]');
  }
  const evidence = parseEvidence(JSON.parse(fs.readFileSync(inputPath, 'utf8')), {
    platform, candidate_sha: candidateSha, run_id: runId,
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ platform, result: evidence.result, reason: evidence.reason })}\n`);
  process.exit(evidence.result === 'PASS' ? 0 : 1);
}

if (require.main === module) main();
module.exports = { parseEvidence, normalize, RESULTS };
