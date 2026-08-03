#!/usr/bin/env node
'use strict';

/**
 * Writes the candidate-scoped staging deployment evidence summary to
 * GITHUB_STEP_SUMMARY (or stdout): base/head SHA, per-migration outcome,
 * changed function directories, changed shared modules, the affected
 * function manifest, what was actually deployed, the staging project
 * reference, production-ref guard result, and a before/after comparison of
 * both the function inventory and the legitimate staging data tables.
 *
 * Node built-ins only. Reads its inputs from JSON files written by the
 * preceding workflow steps (paths given via env vars) rather than shelling
 * out itself, so it never needs network access.
 *
 * Env:
 *   BASE_SHA, HEAD_SHA, STAGING_PROJECT_REF (required)
 *   MIGRATION_RESULT_FILE, FUNCTION_RESULT_FILE (required)
 *   INVENTORY_DIFF_FILE, LEGITIMATE_BEFORE_FILE, LEGITIMATE_AFTER_FILE (optional)
 */

const fs = require('node:fs');
const { PRODUCTION_REF } = require('./select-candidate-migrations');
const { diffSnapshots } = require('./snapshot-legitimate-staging-data');

function env(name, fallback = '') {
  const v = process.env[name];
  return v == null || v === '' ? fallback : v;
}

function readJsonIfExists(pathEnvVar) {
  const p = process.env[pathEnvVar];
  if (!p || !fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function buildMigrationSection(migrationResult) {
  const lines = ['### Candidate migrations', ''];
  if (!migrationResult) {
    lines.push('_No migration result recorded — step may not have run._', '');
    return lines;
  }
  lines.push(`**Outcome:** ${migrationResult.outcome}`, '');
  const migrations = migrationResult.migrations || migrationResult.candidates || [];
  if (migrations.length === 0) {
    lines.push('_No candidate migration files in this diff._', '');
  } else {
    lines.push('| Version | Name | Status |', '| --- | --- | --- |');
    for (const m of migrations) {
      lines.push(`| ${m.version} | ${m.name} | ${m.status} |`);
    }
    lines.push('');
  }
  if (migrationResult.excluded && migrationResult.excluded.length > 0) {
    lines.push('**Excluded from candidate list:**', '');
    for (const e of migrationResult.excluded) {
      lines.push(`- \`${e.path}\`: ${e.reason}`);
    }
    lines.push('');
  }
  return lines;
}

function buildFunctionSection(functionResult) {
  const lines = ['### Changed-function deployment', ''];
  if (!functionResult) {
    lines.push('_No function deployment result recorded — step may not have run._', '');
    return lines;
  }
  lines.push(
    `**Changed function directories:** ${(functionResult.changedFunctionDirs || []).join(', ') || '(none)'}`,
    '',
    `**Changed shared modules:** ${(functionResult.changedSharedFiles || []).join(', ') || '(none)'}`,
    '',
    `**Functions importing a changed shared module:** ${(functionResult.sharedImporters || []).join(', ') || '(none)'}`,
    '',
    `**Affected function manifest:** ${(functionResult.manifest || []).join(', ') || '(none)'}`,
    '',
    `**Deployed:** ${(functionResult.deployed || []).join(', ') || '(none)'}`,
    '',
    `**Outcome:** ${functionResult.outcome || (functionResult.deployed && functionResult.deployed.length ? 'DEPLOYED' : 'NO_CHANGED_FUNCTIONS')}`,
    '',
  );
  if (functionResult.refused && functionResult.refused.length > 0) {
    lines.push(`**Refused (not a valid deploy target):** ${functionResult.refused.join(', ')}`, '');
  }
  return lines;
}

function buildInventorySection(inventoryDiff) {
  const lines = ['### Function inventory side effects', ''];
  if (!inventoryDiff) {
    lines.push('_No inventory diff recorded._', '');
    return lines;
  }
  if (!inventoryDiff.unintendedlyDeployed || inventoryDiff.unintendedlyDeployed.length === 0) {
    lines.push('No functions deployed outside the affected manifest.', '');
  } else {
    lines.push('**Unintended deployments (present after, not before this run):**', '');
    lines.push('| Function | Version | verify_jwt |', '| --- | --- | --- |');
    for (const f of inventoryDiff.unintendedlyDeployed) {
      lines.push(`| ${f.slug} | ${f.version} | ${f.verifyJwt} |`);
    }
    lines.push('');
  }
  return lines;
}

function buildLegitimateDataSection(before, after) {
  const lines = ['### Legitimate staging data comparison', ''];
  if (!before || !after) {
    lines.push('_Before/after snapshot unavailable for this run._', '');
    return lines;
  }
  const { rows, anyChanged } = diffSnapshots(before, after);
  lines.push('| Table | Before | After | Changed |', '| --- | ---: | ---: | :---: |');
  for (const r of rows) {
    lines.push(`| ${r.table} | ${r.before} | ${r.after} | ${r.changed ? '⚠️ YES' : 'no'} |`);
  }
  lines.push('', anyChanged
    ? '**⚠️ One or more legitimate tables changed row count during this deploy — review before promoting.**'
    : 'All legitimate table row counts unchanged.', '');
  return lines;
}

function main() {
  const baseSha = env('BASE_SHA', 'unknown');
  const headSha = env('HEAD_SHA', 'unknown');
  const stagingRef = env('STAGING_PROJECT_REF', 'unknown');

  const migrationResult = readJsonIfExists('MIGRATION_RESULT_FILE');
  const functionResult = readJsonIfExists('FUNCTION_RESULT_FILE');
  const inventoryDiff = readJsonIfExists('INVENTORY_DIFF_FILE');
  const legitimateBefore = readJsonIfExists('LEGITIMATE_BEFORE_FILE');
  const legitimateAfter = readJsonIfExists('LEGITIMATE_AFTER_FILE');

  const lines = [
    '## Staging deployment (candidate-scoped)',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Base SHA | ${baseSha} |`,
    `| Head SHA | ${headSha} |`,
    `| Staging project reference | ${stagingRef} |`,
    `| Production-ref guard | ${stagingRef === PRODUCTION_REF ? '❌ FAILED — refused' : `✅ passed (staging ≠ ${PRODUCTION_REF})`} |`,
    '',
    ...buildMigrationSection(migrationResult),
    ...buildFunctionSection(functionResult),
    ...buildInventorySection(inventoryDiff),
    ...buildLegitimateDataSection(legitimateBefore, legitimateAfter),
  ];

  process.stdout.write(`${lines.join('\n')}\n`);
}

if (require.main === module) {
  main();
}

module.exports = { buildMigrationSection, buildFunctionSection, buildInventorySection, buildLegitimateDataSection };
