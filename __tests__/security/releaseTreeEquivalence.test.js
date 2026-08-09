#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { computeFromEntries, isIncluded } = require('../../security/scripts/compute-runtime-release-tree');

const entry = (file, object) => ({ mode: '100644', type: 'blob', object, path: file });

test('runtime projection includes every required runtime category', () => {
  for (const file of [
    'app/index.tsx', 'server.js', 'services/api.js', 'android/app/build.gradle', 'ios/KScan/AppDelegate.swift',
    'supabase/functions/scan-identify/index.ts', 'supabase/migrations/20260101000000_x.sql',
    'package.json', 'package-lock.json', 'eas.json', 'render.yaml', '.env.example', 'supabase/config.toml',
  ]) assert.equal(isIncluded(file), true, file);
});

test('projection excludes only reviewed governance/evidence/test surfaces', () => {
  for (const file of [
    '.github/workflows/master-required-checks.yml', 'docs/release/report.md', '__tests__/unit.test.js',
    'security/reports/certification.json', '.maestro/flows/smoke.yaml',
  ]) assert.equal(isIncluded(file), false, file);
});

test('intentional master governance divergence preserves release-tree equivalence', () => {
  const candidate = [entry('app/index.tsx', '1'.repeat(40)), entry('package-lock.json', '2'.repeat(40))];
  const merged = [...candidate, entry('.github/workflows/master-required-checks.yml', '3'.repeat(40))];
  assert.equal(computeFromEntries(candidate).digest, computeFromEntries(merged).digest);
});

test('unsafe runtime divergence blocks release-tree equivalence', () => {
  const candidate = [entry('app/index.tsx', '1'.repeat(40)), entry('package-lock.json', '2'.repeat(40))];
  const merged = [entry('app/index.tsx', '4'.repeat(40)), entry('package-lock.json', '2'.repeat(40))];
  assert.notEqual(computeFromEntries(candidate).digest, computeFromEntries(merged).digest);
});

test('master workflow compares projected runtime digests rather than whole-tree equality', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'master-promotion-validation.yml'), 'utf8');
  assert.match(workflow, /CANDIDATE_RUNTIME_TREE/);
  assert.match(workflow, /MERGED_RUNTIME_TREE/);
  assert.doesNotMatch(workflow, /test "\$CANDIDATE_TREE" = "\$MERGE_TREE"/);
});
