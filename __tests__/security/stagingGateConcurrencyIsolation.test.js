'use strict';

/**
 * CI-CONCURRENCY-002 — staging-gate concurrency isolation.
 *
 * THE DEFECT THIS LOCKS OUT.
 *
 * `security-staging-gate.yml` used to declare, at WORKFLOW level:
 *
 *     concurrency:
 *       group: kscan-staging-deployment
 *       cancel-in-progress: false
 *
 * The group itself is legitimate — real staging writes must never overlap. Its
 * PLACEMENT was the defect. At workflow level it put every unrelated PR's pure
 * validation behind one repo-wide mutex, and GitHub keeps at most ONE pending
 * run per group: queue a third and the one already waiting is cancelled, even
 * with `cancel-in-progress: false` (that flag only protects the RUNNING run).
 *
 * Observed on the Build 35 drain: eight branches pushed together, staging-gate
 * runs queued behind the single group, older pending runs superseded before any
 * job started, `Contract tests` therefore never emitted a check-run for those
 * SHAs, and the Security promotion gate spent its whole convergence budget
 * before reporting OPERATIONAL FAILURE / "missing check: Contract tests".
 *
 * The gate was right to fail closed. The orchestration that prevented the
 * evidence from existing was wrong. These tests pin BOTH halves of the repair:
 * staging mutation stays globally serialized, and non-mutating validation is no
 * longer allowed to starve.
 *
 * The invariants are derived from the workflow file rather than hardcoded, so a
 * newly added staging-touching job is covered the day it appears.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const GATE = 'security-staging-gate.yml';

/** The one group that serializes writes to the shared staging project. */
const STAGING_MUTATION_GROUP = 'kscan-staging-deployment';

const readWorkflow = (name) => fs.readFileSync(path.join(WORKFLOWS, name), 'utf8');

/**
 * Split a workflow into its top-level job blocks.
 *
 * Deliberately a small structural reader rather than a regex over the whole
 * file: the questions here are "does THIS job carry the mutex" and "is the
 * mutex outside every job", which a flat regex cannot answer without being
 * accidentally satisfied by a different job's block.
 */
function parseJobs(source) {
  const lines = source.split('\n');
  const jobsIndex = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.notEqual(jobsIndex, -1, 'workflow must declare a jobs: mapping');

  const jobs = new Map();
  let current = null;
  for (const line of lines.slice(jobsIndex + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      jobs.set(current, []);
      continue;
    }
    // A non-blank line at column 0 ends the jobs mapping entirely.
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    if (current) jobs.get(current).push(line);
  }
  return new Map([...jobs].map(([name, body]) => [name, body.join('\n')]));
}

/**
 * Everything above `jobs:` — where a workflow-level `concurrency:` would live —
 * with comment lines removed.
 *
 * Comments are stripped because the invariant is about a DECLARATION, not a
 * mention: the workflow deliberately explains the removed global mutex by name
 * in prose, and that explanation must not read as the construct it warns about.
 */
function preamble(source) {
  const lines = source.split('\n');
  const jobsIndex = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  return lines
    .slice(0, jobsIndex === -1 ? lines.length : jobsIndex)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

/** The concurrency group declared directly on a job block, or null. */
function jobConcurrency(body) {
  const m = /^ {4}concurrency:\s*\n\s+group:\s*(\S+)\s*\n\s+cancel-in-progress:\s*(\S+)/m.exec(body);
  return m ? { group: m[1], cancelInProgress: m[2] } : null;
}

/**
 * A job touches the shared staging project if it declares `environment: staging`.
 * That is the repo's own marker for "this job reaches the real staging project",
 * and it is what gates the environment's secrets, so it cannot be quietly
 * dropped while keeping staging access.
 */
function touchesStaging(body) {
  return /^ {4}environment:\s*staging\s*$/m.test(body);
}

// ── Test A — no global workflow-level mutex ─────────────────────────────────

test('A: the staging gate declares no workflow-level concurrency at all', () => {
  const pre = preamble(readWorkflow(GATE));
  assert.doesNotMatch(
    pre,
    /^concurrency:/m,
    'a workflow-level concurrency block puts EVERY job — including pure validation — behind one group',
  );
});

test('A: no job-independent declaration of the staging mutation group survives above jobs:', () => {
  const pre = preamble(readWorkflow(GATE));
  assert.ok(
    !pre.includes(STAGING_MUTATION_GROUP),
    `${STAGING_MUTATION_GROUP} must not be declared outside a job in ${GATE}`,
  );
});

// ── Test B — staging mutation remains globally serialized ───────────────────

test('B: every staging-touching job carries the shared staging mutation group', () => {
  const jobs = parseJobs(readWorkflow(GATE));
  const staging = [...jobs].filter(([, body]) => touchesStaging(body));

  assert.ok(staging.length > 0, 'expected at least one staging-touching job to exist');

  for (const [name, body] of staging) {
    const concurrency = jobConcurrency(body);
    assert.ok(concurrency, `job "${name}" reaches staging but declares no concurrency group`);
    assert.equal(
      concurrency.group,
      STAGING_MUTATION_GROUP,
      `job "${name}" reaches staging and must share the ${STAGING_MUTATION_GROUP} mutex`,
    );
    assert.equal(
      concurrency.cancelInProgress,
      'false',
      `job "${name}" must never cancel an in-flight staging operation`,
    );
  }
});

test('B: the known staging-mutating jobs are all present and all serialized', () => {
  const jobs = parseJobs(readWorkflow(GATE));
  // deploy-staging applies migrations and deploys Edge Functions; synthetic-tests
  // creates and deletes real staging auth users; staging-health reads staging
  // under the staging environment's credentials.
  for (const name of ['deploy-staging', 'staging-health', 'synthetic-tests']) {
    const body = jobs.get(name);
    assert.ok(body, `job "${name}" must still exist`);
    assert.ok(touchesStaging(body), `job "${name}" must still declare environment: staging`);
    assert.deepEqual(jobConcurrency(body), { group: STAGING_MUTATION_GROUP, cancelInProgress: 'false' });
  }
});

test('B: the controlled deploy workflow still shares the same global mutex', () => {
  // Cross-workflow serialization matters as much as intra-workflow: a staging
  // write from staging-controlled-deploy.yml must not overlap one from the gate.
  const controlled = readWorkflow('staging-controlled-deploy.yml');
  assert.match(controlled, new RegExp(`group:\\s*${STAGING_MUTATION_GROUP}`));
});

// ── Test C — validation survives competing PRs ──────────────────────────────

test('C: no non-staging job is placed behind the staging mutation group', () => {
  const jobs = parseJobs(readWorkflow(GATE));
  for (const [name, body] of jobs) {
    if (touchesStaging(body)) continue;
    const concurrency = jobConcurrency(body);
    assert.ok(
      !concurrency || concurrency.group !== STAGING_MUTATION_GROUP,
      `job "${name}" does not touch staging and must not wait on the staging deployment mutex`,
    );
  }
});

test('C: the required-check producers are free of any concurrency group', () => {
  const jobs = parseJobs(readWorkflow(GATE));
  // These four produce (or gate) the evidence the promotion gate requires.
  // If any of them is serialized repo-wide, an unrelated PR can starve it —
  // which is precisely how "missing check: Contract tests" was produced.
  for (const name of ['classify-changes', 'migration-validation', 'contract-tests', 'staging-security-gate']) {
    const body = jobs.get(name);
    assert.ok(body, `job "${name}" must still exist`);
    assert.equal(jobConcurrency(body), null, `job "${name}" must not be serialized behind any group`);
  }
});

test('C: three concurrent PR runs can each emit Contract tests independently', () => {
  // Model the exact scenario that broke: three unrelated candidate SHAs whose
  // runs exist at the same time. Validation jobs share no group, so no run can
  // supersede another's pending validation, and each SHA gets its own check-run.
  const jobs = parseJobs(readWorkflow(GATE));
  const contract = jobs.get('contract-tests');
  assert.ok(contract, 'contract-tests must exist');

  const groupFor = (job) => {
    const c = jobConcurrency(job);
    return c ? c.group : null;
  };

  const candidates = ['sha-root-a', 'sha-stacked-b', 'sha-root-c'];
  const occupied = new Map();
  for (const sha of candidates) {
    const group = groupFor(contract);
    // A null group means the run is unconstrained: it can never be queued
    // behind, or evicted by, another candidate's run.
    assert.equal(group, null, `contract-tests for ${sha} must not contend for a shared group`);
    assert.ok(!occupied.has(group), 'no two candidates may contend for the same validation slot');
    if (group !== null) occupied.set(group, sha);
  }
  assert.equal(occupied.size, 0, 'all three candidate runs must be independently runnable');
});

// ── Test D — cancellation negative control ─────────────────────────────────

test('D: NEGATIVE CONTROL — restoring a workflow-level global mutex fails these invariants', () => {
  const source = readWorkflow(GATE);
  // Reintroduce exactly the construct that caused the outage.
  const regressed = source.replace(
    /^env:/m,
    `concurrency:\n  group: ${STAGING_MUTATION_GROUP}\n  cancel-in-progress: false\n\nenv:`,
  );
  assert.notEqual(regressed, source, 'the mutation must actually apply');

  const pre = preamble(regressed);
  assert.match(pre, /^concurrency:/m, 'the regressed fixture must carry a workflow-level block');
  assert.match(
    pre,
    new RegExp(`^concurrency:\\n\\s+group:\\s*${STAGING_MUTATION_GROUP}$`, 'm'),
    'the regressed fixture must DECLARE the global staging group above jobs: — which Test A forbids',
  );
});

test('D: NEGATIVE CONTROL — dropping the mutex from a staging job is detected', () => {
  const source = readWorkflow(GATE);
  const jobs = parseJobs(source);
  const body = jobs.get('deploy-staging');
  const stripped = body.replace(
    /^ {4}concurrency:\s*\n\s+group:.*\n\s+cancel-in-progress:.*\n/m,
    '',
  );
  assert.notEqual(stripped, body, 'the mutation must actually remove the block');
  assert.ok(touchesStaging(stripped), 'the fixture still reaches staging');
  assert.equal(
    jobConcurrency(stripped),
    null,
    'an unserialized staging deploy job must be observable — Test B is what rejects it',
  );
});

// ── Tests E/F/G — the gate's fail-closed semantics are NOT relaxed ──────────
//
// The concurrency repair fixes how evidence is PRODUCED. It must not, anywhere,
// change what the gate does when evidence is ABSENT. These three guard exactly
// the failure modes the outage produced, so a future "make CI green" change
// cannot quietly turn the real fix into a bypass.

const {
  evaluateLocal,
  resolveCheckRunVerdict,
  classifyCheckFailure,
  ALWAYS_REQUIRED_CHECKS,
  OPERATIONAL_KEYS,
} = require('../../security/scripts/evaluate-promotion-gate');

const SHA = 'f8122a491589f049cbfdd1490578274f87fd1cd0';
const ok = () => ({ status: 'completed', conclusion: 'success', head_sha: SHA, completed_at: new Date().toISOString() });

/** Every required check green except the ones named, which are omitted entirely. */
function allGreenExcept(omitted) {
  const byName = new Map();
  for (const name of ALWAYS_REQUIRED_CHECKS) {
    if (omitted.includes(name)) continue;
    byName.set(name, ok());
  }
  return byName;
}

test('E: Contract tests remains a required check, and its absence fails closed', () => {
  assert.ok(
    ALWAYS_REQUIRED_CHECKS.includes('Contract tests'),
    'Contract tests must stay in the always-required set — the repair makes it reliably PRODUCED, never optional',
  );

  const verdict = resolveCheckRunVerdict({
    repository: 'kscanaiapp/kscan-app',
    sha: SHA,
    byName: allGreenExcept(['Contract tests']),
    projectCheckReport: null,
  });

  assert.equal(verdict.finalVerdict, 'OPERATIONAL FAILURE', 'a missing Contract tests check must never pass');
  assert.ok(verdict.missingChecks.includes('Contract tests'));
  assert.ok(verdict.failures.includes('missing check: Contract tests'));
});

test('F: a missing required artifact still fails closed', () => {
  const verdict = evaluateLocal({ missingRequiredArtifact: true });
  assert.notEqual(verdict.finalVerdict, 'PASS', 'a missing required artifact must never read as PASS');
  assert.ok(
    verdict.failures.includes('missingRequiredArtifact'),
    'the missing artifact must be named in the verdict, not silently tolerated',
  );
});

test('G: a ZAP operational failure still blocks promotion', () => {
  for (const name of ['ZAP Baseline (staging)', 'ZAP API staging']) {
    const classified = classifyCheckFailure(name, 'failure');
    assert.equal(classified.key, 'zapOperationalFailure', `${name} must classify as a ZAP operational failure`);
    assert.ok(OPERATIONAL_KEYS.has(classified.key));
  }
  const verdict = evaluateLocal({ zapOperationalFailure: true });
  assert.notEqual(verdict.finalVerdict, 'PASS', 'a ZAP operational failure must never read as PASS');
});

test('E/F/G: an all-green candidate still passes — these guards are not a blanket refusal', () => {
  // Without this control the three tests above could be satisfied by a gate
  // that fails everything, which would prove nothing.
  const verdict = resolveCheckRunVerdict({
    repository: 'kscanaiapp/kscan-app',
    sha: SHA,
    byName: allGreenExcept([]),
    projectCheckReport: null,
  });
  assert.ok(
    ['PASS', 'PENDING'].includes(verdict.finalVerdict),
    `an all-green required set must not be blocked (got ${verdict.finalVerdict}: ${verdict.blockingReason || ''})`,
  );
});
