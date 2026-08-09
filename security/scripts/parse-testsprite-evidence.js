#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INFRA_FAILURE_KINDS = new Set(['infrastructure', 'runner', 'environment', 'internal', 'timeout']);

function parseEvidence(run, context) {
  const status = String(run?.status || '').toLowerCase();
  const failureKind = String(run?.failureKind || '').toLowerCase();
  let result = 'OPERATIONAL_FAILURE';
  let reason = run?.error || null;
  if (status === 'passed') result = 'PASS';
  else if (status === 'queued' || status === 'running') result = 'PENDING';
  else if (status === 'failed' || status === 'blocked' || status === 'cancelled') {
    result = INFRA_FAILURE_KINDS.has(failureKind) ? 'OPERATIONAL_FAILURE' : 'BLOCKED';
  }
  if (!context.test_id) {
    result = 'BLOCKED';
    reason = 'MOBILE_EVIDENCE_NOT_CONFIGURED';
  } else if (context.attested_sha !== context.candidate_sha) {
    result = 'BLOCKED';
    reason = 'MOBILE_TEST_SHA_MISMATCH';
  }
  const summary = run?.stepSummary || {};
  return {
    platform: context.platform,
    test_id: context.test_id || null,
    run_id: run?.runId || null,
    result,
    tested_sha: context.attested_sha || null,
    flows_run: Number(summary.total || 0),
    flows_passed: Number(summary.passedCount || 0),
    flows_failed: Number(summary.failedCount || 0),
    artifact_links: [run?.dashboardUrl, run?.videoUrl].filter(Boolean),
    reason,
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
  if (!inputPath || !outputPath) throw new Error('Usage: --input <run.json> --output <evidence.json> --platform <android|ios> --test-id <id> --candidate-sha <sha> --attested-sha <sha>');
  const evidence = parseEvidence(JSON.parse(fs.readFileSync(inputPath, 'utf8')), {
    platform: arg(args, '--platform'),
    test_id: arg(args, '--test-id'),
    candidate_sha: arg(args, '--candidate-sha'),
    attested_sha: arg(args, '--attested-sha'),
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ result: evidence.result, run_id: evidence.run_id })}\n`);
}

if (require.main === module) main();
module.exports = { parseEvidence };
