/**
 * Contract for the Build 29 manual deletion-worker verification workflow.
 *
 * This workflow is the only thing in the repository that invokes the account
 * deletion worker, which makes it the one place where "a narrow, staging-bound
 * manual probe" could quietly turn into either an automatic purge scheduler or
 * a generic Edge Function invoker pointed at whatever a caller supplies.
 * These assertions exist to make both forms of drift fail CI rather than ship.
 *
 * Properties locked here:
 *   * it can only be dispatched for governed manual testing;
 *   * it binds the protected `staging` environment, so the worker secret is
 *     only reachable from an environment the owner controls;
 *   * the project ref and the function slug are literals, never inputs;
 *   * the production project ref is an explicit deny;
 *   * a missing secret fails closed instead of making an unauthenticated call;
 *   * the secret is never echoed, and the raw worker response never reaches a
 *     log or an artifact.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  '..',
  '.github',
  'workflows',
  'staging-account-deletion-worker.yml',
);

const STAGING_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';

const source = fs.readFileSync(WORKFLOW_PATH, 'utf8');

test('the deletion worker verification workflow exists', () => {
  assert.ok(source.length > 0, 'workflow file must exist and be non-empty');
});

test('automatic purge scheduling is deferred and only governed manual dispatch remains', () => {
  assert.match(source, /^on:/m);
  assert.match(source, /workflow_dispatch:/);
  assert.doesNotMatch(source, /^\s*schedule:/m);
  assert.doesNotMatch(source, /\bcron:/);
});

test('it binds the protected staging environment', () => {
  assert.match(source, /environment:\s*staging/);
});

test('the project ref is a literal and production is explicitly denied', () => {
  assert.match(source, new RegExp(`STAGING_REF:\\s*${STAGING_REF}`));
  assert.match(source, new RegExp(`PRODUCTION_REF:\\s*${PRODUCTION_REF}`));
  // The deny is an actual runtime comparison, not just a recorded constant.
  assert.match(source, /if \[ "\$\{STAGING_REF\}" = "\$\{PRODUCTION_REF\}" \]/);
  assert.match(source, /Refusing/);
});

test('the production ref is never used as a request target', () => {
  const url = source.match(/https:\/\/\$\{[A-Z_]+\}\.supabase\.co[^"']*/)?.[0];
  assert.ok(url, 'the endpoint must be built from a variable, not hardcoded per-env');
  assert.match(url, /\$\{STAGING_REF\}/);
  assert.ok(
    !new RegExp(`https://${PRODUCTION_REF}`).test(source),
    'the production host must never appear as a URL',
  );
});

test('the function slug is a literal, not a caller-supplied input', () => {
  assert.match(source, /FUNCTION_SLUG:\s*process-account-deletions/);
  // The dispatch inputs must not let a caller choose what gets invoked.
  const inputsBlock = source.slice(source.indexOf('inputs:'), source.indexOf('permissions:'));
  assert.ok(
    !/function|slug|project|ref|url|endpoint/i.test(inputsBlock),
    'dispatch inputs must not accept a function, project, or endpoint',
  );
});

test('the worker secret comes only from the protected environment', () => {
  assert.match(source, /WORKER_SECRET:\s*\$\{\{\s*secrets\.ACCOUNT_DELETION_WORKER_SECRET\s*\}\}/);
  // No repository variables or literal fallbacks.
  assert.ok(!/vars\.ACCOUNT_DELETION_WORKER_SECRET/.test(source));
});

test('a missing secret fails closed', () => {
  assert.match(source, /if \[ -z "\$\{WORKER_SECRET:-\}" \]/);
  const guard = source.slice(source.indexOf('WORKER_SECRET:-'));
  assert.match(guard.slice(0, 400), /exit 1/, 'the missing-secret branch must abort');
});

test('the secret is never echoed and never passed on a command line', () => {
  // What matters is expanding the VALUE into stdout. Naming the variable in a
  // fail-closed error message is required for a usable diagnostic and is not a
  // disclosure, so the check targets `$WORKER_SECRET` / `${WORKER_SECRET}`
  // expansion inside an echo, not the string "WORKER_SECRET" appearing at all.
  const NEWLINE = String.fromCharCode(10);
  const echoedValue = source
    .split(NEWLINE)
    .filter((line) => line.includes('echo'))
    .filter((line) => line.includes('$WORKER_SECRET') || line.includes('${WORKER_SECRET'));
  assert.deepEqual(echoedValue, [], 'the secret value must never be expanded into stdout');
  assert.ok(
    !/--header\s+['"]x-deletion-worker-secret:/.test(source),
    'secret must not be an inline curl argument — it would appear in a process listing',
  );
  assert.match(source, /--header @"\$\{HDR\}"/, 'secret is passed via @file');
  assert.match(source, /trap 'rm -f "\$\{HDR\}"' EXIT/, 'the header file is always removed');
});

test('only a sanitized projection is logged; the raw response is discarded', () => {
  assert.match(source, /worker-summary\.json/);
  assert.match(source, /rm -f response\.json/);
  // The sanitized shape must not carry identifiers.
  const projection = source.slice(source.indexOf('const out = {'), source.indexOf('console.log(JSON.stringify(out))'));
  for (const forbidden of ['requestId', 'subjectRef', 'userId', 'eligibleRequestIds', 'plans', 'tree']) {
    assert.ok(!projection.includes(forbidden), `${forbidden} must not be surfaced`);
  }
});

test('the workflow takes no write permissions it does not need', () => {
  assert.match(source, /permissions:\s*\n\s*contents:\s*read/);
});

test('process-account-deletions is on the staging deployment allowlist', () => {
  // The scheduler is useless if registry/lifecycle fixes can never reach the
  // deployed worker.
  const {
    STAGING_DEPLOYMENT_ALLOWLIST,
  } = require('../../security/scripts/staging-deployment-allowlist');
  assert.ok(STAGING_DEPLOYMENT_ALLOWLIST.includes('process-account-deletions'));
});
