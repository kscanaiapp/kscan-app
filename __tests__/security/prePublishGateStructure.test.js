#!/usr/bin/env node
'use strict';

/**
 * Structural guarantees for the Pre-Publish Release Security Gate workflow.
 *
 * These tests exist because the gate finished as "No jobs were run" three
 * times (runs 31111680352, 31112532309, 31120887611 — each total_jobs: 0),
 * caused by an invalid `administration` permission key that made the whole
 * file fail GitHub's schema validation. A gate that reports nothing is
 * indistinguishable from a gate that passed.
 *
 * Everything here is asserted against the real workflow file, not a
 * fixture, so the guarantees cannot rot away from what actually ships.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const WORKFLOW_PATH = path.join(
  __dirname, '..', '..', '.github', 'workflows', 'pre-publish-release-security-gate.yml',
);

const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const workflow = yaml.load(raw);

// The exact set GitHub's workflow schema accepts for `permissions:`.
// "administration" is deliberately absent — it is a GitHub App permission,
// not a workflow permission, and declaring it breaks the entire file.
const VALID_PERMISSION_SCOPES = new Set([
  'actions', 'attestations', 'checks', 'contents', 'deployments', 'discussions',
  'id-token', 'issues', 'models', 'packages', 'pages', 'pull-requests',
  'repository-projects', 'security-events', 'statuses',
]);

const PREFLIGHT_JOB = 'prepublish-preflight';
const VERDICT_JOB = 'publish-verdict';

test('the workflow file is valid YAML and declares jobs (the literal "No jobs were run" precondition)', () => {
  assert.ok(workflow, 'workflow must parse');
  assert.ok(workflow.jobs && Object.keys(workflow.jobs).length > 0, 'workflow must declare at least one job');
});

test('every declared permission scope is one GitHub actually accepts (the original parse-failure defect)', () => {
  const check = (perms, ctx) => {
    if (!perms || typeof perms !== 'object') return;
    for (const key of Object.keys(perms)) {
      assert.ok(
        VALID_PERMISSION_SCOPES.has(key),
        `${ctx} declares invalid permission scope "${key}" — this makes the entire workflow fail schema validation and produce "No jobs were run"`,
      );
    }
  };
  check(workflow.permissions, 'top-level permissions');
  for (const [name, job] of Object.entries(workflow.jobs)) {
    check(job.permissions, `job ${name}`);
  }
});

test('at least one job carries no eligibility `if:` at all — something always runs when the workflow triggers', () => {
  const unconditional = Object.entries(workflow.jobs).filter(([, job]) => job.if === undefined);
  assert.ok(
    unconditional.length > 0,
    'every job has an `if:` — a workflow where all jobs can skip can still report "No jobs were run"',
  );
});

test('the preflight job exists and is unconditional', () => {
  const preflight = workflow.jobs[PREFLIGHT_JOB];
  assert.ok(preflight, `${PREFLIGHT_JOB} must exist`);
  assert.equal(preflight.if, undefined, `${PREFLIGHT_JOB} must carry no eligibility condition`);
  assert.equal(preflight.needs, undefined, `${PREFLIGHT_JOB} must not depend on another job that could skip it`);
});

test('preflight exposes the structured outputs downstream jobs and the verdict depend on', () => {
  const outputs = workflow.jobs[PREFLIGHT_JOB].outputs || {};
  for (const key of [
    'eligible', 'candidate_sha', 'staging_validated_sha',
    'sha_match', 'evidence_available', 'preflight_verdict', 'preflight_reason',
  ]) {
    assert.ok(Object.hasOwn(outputs, key), `preflight must output "${key}"`);
  }
});

test('the final verdict job uses always()', () => {
  const verdict = workflow.jobs[VERDICT_JOB];
  assert.ok(verdict, `${VERDICT_JOB} must exist`);
  assert.match(
    String(verdict.if),
    /always\(\)/,
    `${VERDICT_JOB} must run with always() so a failed/skipped/cancelled dependency still yields a verdict`,
  );
});

test('the final verdict job depends on preflight', () => {
  const needs = workflow.jobs[VERDICT_JOB].needs;
  const list = Array.isArray(needs) ? needs : [needs];
  assert.ok(list.includes(PREFLIGHT_JOB), `${VERDICT_JOB} must depend on ${PREFLIGHT_JOB}`);
});

test('the final verdict job depends on the candidate-evaluation job so a skip there is classified, not invisible', () => {
  const needs = workflow.jobs[VERDICT_JOB].needs;
  const list = Array.isArray(needs) ? needs : [needs];
  assert.ok(list.includes('evaluate-candidate'), `${VERDICT_JOB} must depend on evaluate-candidate`);
});

test('verdict artifacts are uploaded with always()', () => {
  const steps = workflow.jobs[VERDICT_JOB].steps || [];
  const upload = steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/upload-artifact@'));
  assert.ok(upload, 'the verdict job must upload artifacts');
  assert.match(String(upload.if), /always\(\)/, 'verdict artifact upload must use always()');
});

test('a GitHub step summary is always written', () => {
  const steps = workflow.jobs[VERDICT_JOB].steps || [];
  const summary = steps.find((s) => s.name && /summary/i.test(s.name));
  assert.ok(summary, 'the verdict job must write a step summary');
  assert.match(String(summary.if), /always\(\)/, 'the summary step must use always()');
});

test('artifact upload cannot decide the verdict (it is continue-on-error and precedes enforcement)', () => {
  const steps = workflow.jobs[VERDICT_JOB].steps || [];
  const uploadIdx = steps.findIndex((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/upload-artifact@'));
  const enforceIdx = steps.findIndex((s) => s.name === 'Enforce verdict');
  assert.ok(uploadIdx !== -1 && enforceIdx !== -1);
  assert.equal(steps[uploadIdx]['continue-on-error'], true, 'upload failure must not abort before enforcement');
  assert.ok(uploadIdx < enforceIdx, 'upload must happen before enforcement so a blocked verdict is still retained');
});

test('the verdict job passes both dependency results to the verdict builder, so a skip is classified', () => {
  const steps = workflow.jobs[VERDICT_JOB].steps || [];
  const build = steps.find((s) => s.id === 'verdict');
  assert.ok(build, 'the verdict-building step must exist');
  assert.match(build.run, /--job-status\s+"preflight=/, 'preflight result must be passed to the verdict builder');
  assert.match(build.run, /--job-status\s+"evidence_evaluation=/, 'evaluation result must be passed to the verdict builder');
});

test('every action is pinned to a full commit SHA, not a mutable tag', () => {
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps || []) {
      if (!step.uses) continue;
      assert.match(
        step.uses,
        /@[0-9a-f]{40}$/,
        `${jobName} step "${step.name || step.uses}" must pin a full commit SHA`,
      );
    }
  }
});

test('the gate remains workflow_dispatch-only — it never fires automatically on a push', () => {
  const on = workflow.on || workflow.true; // js-yaml parses bare `on:` as boolean true
  assert.ok(Object.hasOwn(on, 'workflow_dispatch'), 'must support manual dispatch');
  assert.ok(!Object.hasOwn(on, 'push'), 'must not trigger on push');
  assert.ok(!Object.hasOwn(on, 'pull_request'), 'must not trigger on pull_request');
});
