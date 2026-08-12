'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  '.github',
  'workflows',
  'staging-release-bootstrap.yml'
);

/**
 * Splits the workflow body into per-job blocks, keyed by job id, using the
 * 2-space-indented `  <jobId>:` header lines as delimiters. Sufficient for a
 * single flat `jobs:` map with no nested job-id-shaped keys at that indent.
 */
function splitJobs(text) {
  const jobsStart = text.indexOf('\njobs:\n');
  assert.notEqual(jobsStart, -1, 'workflow must have a top-level jobs: map');
  const body = text.slice(jobsStart + '\njobs:\n'.length);
  const headerRe = /^  ([a-zA-Z_][\w-]*):\s*\n/gm;
  const headers = [...body.matchAll(headerRe)];
  assert.ok(headers.length > 0, 'jobs: map must contain at least one job');
  const jobs = {};
  for (let i = 0; i < headers.length; i += 1) {
    const start = headers[i].index + headers[i][0].length;
    const end = i + 1 < headers.length ? headers[i + 1].index : body.length;
    jobs[headers[i][1]] = body.slice(start, end);
  }
  return jobs;
}

function assertBootstrapWorkflowSafety(text, label) {
  // 1. Discoverable: valid top-level shape at the conventional path/name.
  assert.match(text, /^name: Staging Release Bootstrap Activation/m, `${label}: must have a name`);

  // 2 & 3. workflow_dispatch only — no push/schedule/pull_request/other auto trigger.
  const onMatch = text.match(/^on:\n([\s\S]*?)\n(?=\S)/m);
  assert.ok(onMatch, `${label}: must have an on: block`);
  const onBlock = onMatch[1];
  assert.match(onBlock, /^\s+workflow_dispatch:/m, `${label}: on: must include workflow_dispatch`);
  for (const forbidden of ['push:', 'schedule:', 'pull_request:', 'repository_dispatch:', 'workflow_run:']) {
    assert.ok(
      !new RegExp(`^\\s+${forbidden}`, 'm').test(onBlock),
      `${label}: on: must not include automatic trigger ${forbidden}`
    );
  }

  // 5. No caller-selectable production/project ref input — only mode + confirm_execute.
  const inputsMatch = onBlock.match(/inputs:\n([\s\S]*)/);
  assert.ok(inputsMatch, `${label}: workflow_dispatch must declare inputs`);
  const inputNames = [...inputsMatch[1].matchAll(/^\s{6}([a-zA-Z_][\w-]*):\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(
    inputNames,
    ['mode', 'confirm_execute'],
    `${label}: inputs must be exactly mode and confirm_execute, never a caller-selectable ref/projectRef`
  );
  assert.ok(
    !/project.?ref/i.test(inputsMatch[1]),
    `${label}: no input may let a caller select a Supabase project ref`
  );

  // 6. No production credentials/identifiers anywhere in the workflow.
  assert.ok(!/SUPABASE_PRODUCTION/i.test(text), `${label}: must not reference production Supabase secrets`);
  assert.ok(!/PROD_/.test(text), `${label}: must not reference a PROD_-prefixed credential`);

  // 11. contents: write scoped to persistence only; default/top-level is read.
  const topPermissions = text.match(/^permissions:\n(\s+contents: \w+)/m);
  assert.ok(topPermissions, `${label}: must declare top-level permissions`);
  assert.match(topPermissions[1], /contents: read/, `${label}: top-level permissions must default to read`);
  const writeOccurrences = (text.match(/^\s+contents: write\s*$/gm) || []).length;
  assert.equal(writeOccurrences, 1, `${label}: exactly one contents: write block is allowed`);

  // 12. No EAS/mobile build behavior.
  for (const forbidden of ['eas build', 'eas submit', 'expo build', '.ipa', '.aab']) {
    assert.ok(!text.toLowerCase().includes(forbidden), `${label}: must not perform EAS/mobile builds (${forbidden})`);
  }

  const jobs = splitJobs(text);
  assert.deepEqual(
    Object.keys(jobs),
    ['preflight', 'plan', 'execute', 'persist'],
    `${label}: job graph must be exactly preflight -> plan -> execute -> persist`
  );

  // 4. Every job that can touch staging secrets is scoped to the staging environment.
  for (const jobId of Object.keys(jobs)) {
    assert.match(jobs[jobId], /environment: staging/, `${label}: job "${jobId}" must be scoped to environment: staging`);
  }

  // 7 & 8. Every checkout is pinned to staging/production-parity or the
  // preflight-validated candidate SHA — never an implicit/default ref, and
  // never anything master-derived.
  const checkoutRefs = [...text.matchAll(/uses: actions\/checkout@[^\n]*\n(\s+with:\n\s+ref: ([^\n]+)\n)?/g)]
    .map((m) => m[2])
    .filter(Boolean);
  assert.ok(checkoutRefs.length >= 4, `${label}: expected an explicit checkout ref in every job`);
  for (const ref of checkoutRefs) {
    assert.ok(
      ref === 'staging/production-parity' || ref.includes('needs.preflight.outputs.candidate_sha'),
      `${label}: checkout ref "${ref}" must be the canonical staging branch or the validated candidate SHA, never an implicit ref`
    );
  }
  assert.match(
    jobs.preflight,
    /origin\/staging\/production-parity/,
    `${label}: preflight must validate HEAD against origin/staging/production-parity`
  );

  // 9. PLAN_ONLY performs no mutation.
  assert.match(jobs.plan, /permissions:\s*\n\s+contents: read/, `${label}: plan job must be read-only`);
  assert.doesNotMatch(jobs.plan, /--execute\b/, `${label}: plan job must never pass --execute`);
  assert.doesNotMatch(jobs.plan, /supabase (functions deploy|secrets set)/, `${label}: plan job must not mutate Supabase`);

  // 10. EXECUTE requires the typed confirmation phrase, gated before mutation.
  assert.match(
    jobs.preflight,
    /CONFIRM"\s*!=\s*"ACTIVATE-STAGING-BOOTSTRAP"/,
    `${label}: EXECUTE must be gated behind the typed confirmation phrase`
  );
  assert.match(jobs.execute, /if: \$\{\{ inputs\.mode == 'EXECUTE' \}\}/, `${label}: execute job must be gated on mode == EXECUTE`);

  // 11 (continued). Only persist declares contents: write, and only under EXECUTE+success.
  assert.match(jobs.persist, /permissions:\s*\n(\s+#[^\n]*\n)*\s+contents: write/, `${label}: persist job must hold contents: write`);
  assert.match(
    jobs.persist,
    /if: \$\{\{ inputs\.mode == 'EXECUTE' && needs\.execute\.result == 'success' \}\}/,
    `${label}: persist must only run after a successful EXECUTE`
  );
  assert.doesNotMatch(jobs.preflight, /contents: write/, `${label}: preflight must not hold contents: write`);
  assert.doesNotMatch(jobs.plan, /contents: write/, `${label}: plan must not hold contents: write`);
  assert.doesNotMatch(jobs.execute, /contents: write/, `${label}: execute must not hold contents: write`);
}

test('master copy of staging-release-bootstrap.yml exists at the conventional registration path', () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH), 'workflow must live at .github/workflows/staging-release-bootstrap.yml for GitHub to register it from the default branch');
});

test('master copy satisfies every bootstrap-workflow safety property', () => {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  assertBootstrapWorkflowSafety(text, 'master copy');
});

test('master copy stays byte-identical to the canonical staging workflow (best-effort)', (t) => {
  let remoteText;
  try {
    execFileSync('git', ['fetch', 'origin', 'staging/production-parity'], { stdio: 'ignore' });
    remoteText = execFileSync(
      'git',
      ['show', 'origin/staging/production-parity:.github/workflows/staging-release-bootstrap.yml'],
      { encoding: 'utf8' }
    );
  } catch (err) {
    t.skip(`could not fetch origin/staging/production-parity in this environment (${err.message}); skipping drift check`);
    return;
  }
  const localText = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  assert.equal(
    localText,
    remoteText,
    'master and staging copies of staging-release-bootstrap.yml have diverged — see docs/release/STAGING_BOOTSTRAP_WORKFLOW_REGISTRATION.md for the sync rule'
  );
  // The remote copy is also re-checked against the safety properties: if a
  // future edit lands on staging alone, this is the test that catches it
  // before someone reflexively copies it over unreviewed.
  assertBootstrapWorkflowSafety(remoteText, 'staging copy');
});
