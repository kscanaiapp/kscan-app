#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { validatePromotion } = require('../../security/scripts/validate-promotion-request');

const root = path.join(__dirname, '..', '..');

test('master tree check emits its exact governance context', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'master-promotion-validation.yml'), 'utf8');
  assert.match(workflow, /name: Master promotion tree equivalence/);
  assert.match(workflow, /git merge-tree --write-tree origin\/master/);
  assert.doesNotMatch(workflow, /Only immutable staging promotion/);
});

test('promotion workflow validates before creating a ref or PR', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'promote-certified-staging.yml'), 'utf8');
  assert.ok(workflow.indexOf('validate-promotion-request.js') < workflow.indexOf('git\/refs'));
  assert.ok(workflow.indexOf('git\/refs') < workflow.indexOf('gh pr create'));
  assert.match(workflow, /name: release-decision-\$\{\{ github\.run_id \}\}[\s\S]*retention-days: 90/);
});

test('promotion validator fails closed on a BLOCK decision', () => {
  const decision = validatePromotion({}, { release_decision: 'BLOCK' });
  assert.equal(decision.promotion_authorized, false);
  assert.ok(decision.validation_failures.includes('RELEASE_DECISION_NOT_APPROVE'));
});

test('staging Auth workflow can target only the staging project', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'configure-staging-auth-security.yml'), 'utf8');
  assert.match(workflow, /STAGING_REF: yzqjvdfgefveprobvvyw/);
  assert.doesNotMatch(workflow, /projects\/\$\{PRODUCTION_REF\}/);
  assert.match(workflow, /SUPABASE_PLAN_DOES_NOT_SUPPORT_HIBP/);
  assert.ok(workflow.indexOf("writeFileSync('staging-auth-security.json'") < workflow.indexOf('PATCH_CODE='));
});
