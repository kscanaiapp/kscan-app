#!/usr/bin/env node
/**
 * Bootstrap certification gate CLI (DEF-B29-SVV-013B).
 *
 * Assembles the observed GitHub Actions run metadata and live git state, then
 * defers the decision to security/release/validate-bootstrap-certification.js.
 * Deliberately thin: the policy must live in one testable place, not in YAML,
 * so this file only marshals inputs and reports the verdict.
 *
 * Fails closed. Any missing input, unreadable file or malformed metadata is a
 * refusal, never a pass.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateBootstrapCertification } = require('./validate-bootstrap-certification.js');

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? '' : (process.argv[index + 1] || '');
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`ACTIVATION_CERTIFICATION_OPERATIONAL_FAILURE: cannot read ${label} (${file}): ${err.message}`);
    process.exit(1);
  }
  return null;
}

const certification = readJson(arg('certification'), 'certification report');
const runMetadata = readJson(arg('run-metadata'), 'certification run metadata');
const candidateRuns = readJson(arg('candidate-runs'), 'candidate certification runs');

const observed = {
  supplied_run_id: arg('supplied-run-id'),
  certification_run_id: String(runMetadata.id ?? runMetadata.databaseId ?? ''),
  certification_workflow: runMetadata.name ?? runMetadata.workflowName ?? '',
  certification_event: runMetadata.event ?? '',
  certification_head_branch: runMetadata.head_branch ?? runMetadata.headBranch ?? '',
  certification_head_sha: runMetadata.head_sha ?? runMetadata.headSha ?? '',
  certification_status: runMetadata.status ?? '',
  certification_conclusion: runMetadata.conclusion ?? '',
  certification_completed_at: runMetadata.updated_at ?? runMetadata.updatedAt ?? '',
  candidate_sha: arg('candidate-sha'),
  candidate_tree_sha: arg('candidate-tree-sha'),
  staging_head_sha: arg('staging-head-sha'),
  candidate_runs: Array.isArray(candidateRuns) ? candidateRuns : [],
  now: new Date().toISOString(),
};

const result = validateBootstrapCertification(certification, observed);

// Identity and verdict only: no report contents, no tokens, no findings bodies.
console.log(JSON.stringify({
  authorized: result.authorized,
  certification_run_id: result.certification_run_id,
  candidate_sha: result.candidate_sha,
  candidate_tree_sha: result.candidate_tree_sha,
  certification_verdict: result.certification_verdict,
  certification_completed_at: result.certification_completed_at,
  certification_age_ms: result.certification_age_ms,
  latest_for_candidate: result.latest_for_candidate,
  failures: result.failures,
}, null, 2));

if (!result.authorized) {
  console.error(`ACTIVATION_CERTIFICATION_REFUSED: ${result.failures.join(', ')}`);
  process.exit(1);
}
