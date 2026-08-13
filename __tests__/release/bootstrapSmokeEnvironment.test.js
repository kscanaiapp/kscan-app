#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const workflow = fs.readFileSync(
  path.join(REPO_ROOT, '.github', 'workflows', 'staging-release-bootstrap.yml'),
  'utf8',
);

function bootstrapActivationEnvironment() {
  const start = workflow.indexOf('- name: Run bootstrap activation');
  const end = workflow.indexOf('\n        run:', start);
  assert.notEqual(start, -1, 'bootstrap activation step must exist');
  assert.notEqual(end, -1, 'bootstrap activation step must have a run block');
  return workflow.slice(start, end);
}

test('EXECUTE explicitly enables the staging contract suite', () => {
  assert.match(bootstrapActivationEnvironment(), /STAGING_CONTRACT_TESTS: '1'/);
});

test('EXECUTE supplies both staging key names from the same publishable-key secret', () => {
  const env = bootstrapActivationEnvironment();
  assert.match(
    env,
    /SUPABASE_STAGING_ANON_KEY: \$\{\{ secrets\.SUPABASE_STAGING_PUBLISHABLE_KEY \}\}/,
  );
  assert.match(
    env,
    /SUPABASE_STAGING_PUBLISHABLE_KEY: \$\{\{ secrets\.SUPABASE_STAGING_PUBLISHABLE_KEY \}\}/,
  );
});
