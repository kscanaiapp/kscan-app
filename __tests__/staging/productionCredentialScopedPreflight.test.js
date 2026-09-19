/**
 * Governance tests for the CREDENTIAL-SCOPE SPLIT in the production pipeline.
 *
 * Production credentials belong on the `production` GitHub Environment, not at
 * repository scope — repository scope would hand them to every job in every
 * workflow, including the ones that run before the required-reviewer gate,
 * which is precisely what the gate exists to prevent.
 *
 * The consequence is that the `preflight` job, which runs BEFORE the gate so a
 * reviewer can see what they are approving, cannot hold those credentials. It
 * used to demand all four and die on "Missing required production variables"
 * on a correctly-secured repository, which made such a repository unable to
 * deploy at all.
 *
 * The repair moves WHERE the remote validation runs, not WHETHER it runs. The
 * danger of a change shaped like this is that it quietly becomes a way to reach
 * production with less checking, so these tests are written to fail if any of
 * the following stops being true:
 *
 *   (a) nothing outside the environment gate needs a production credential;
 *   (b) nothing outside the environment gate queries production;
 *   (c) the full live remote gate still runs inside `environment: production`;
 *   (d) the migration cannot execute if that live gate fails;
 *   (e) migration-only mode still deploys no Edge Function;
 *   (f) staging is still impossible to target.
 *
 * Where a property can be executed rather than read, it is: the live gate's own
 * assertion script is extracted from the workflow and run against crafted
 * reports, and the preflight script is spawned with its credentials stripped.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'production-controlled-deploy.yml');
const PREFLIGHT = path.join(ROOT, 'scripts', 'production-deploy-preflight.mjs');
const APPLIER = path.join(ROOT, 'scripts', 'apply-production-migration.mjs');

const source = fs.readFileSync(WORKFLOW, 'utf8');
const preflightSource = fs.readFileSync(PREFLIGHT, 'utf8');

const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';
const STAGING_REF = 'yzqjvdfgefveprobvvyw';
const APPROVED_VERSION = '20260831140000';

// --------------------------------------------------------------- workflow IR

/** Job keys sit at exactly two spaces under `jobs:`. */
function parseJobs(yaml) {
  const lines = yaml.split('\n');
  const jobsIndex = lines.findIndex((l) => l === 'jobs:');
  assert.ok(jobsIndex !== -1, 'workflow must declare a jobs: block');

  const jobs = {};
  let current = null;
  for (const line of lines.slice(jobsIndex + 1)) {
    const jobHeader = line.match(/^ {2}([a-z0-9-]+):\s*$/);
    if (jobHeader) {
      current = jobHeader[1];
      jobs[current] = [];
      continue;
    }
    if (current && line.trim() !== '' && !line.startsWith('  ')) break;
    if (current) jobs[current].push(line);
  }
  return Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n')]));
}

/**
 * Steps of one job, in order, as { name, body }. Splitting on the six-space
 * list marker means an assertion about "this step" cannot drift into the next
 * step or into a neighbouring job's YAML.
 */
function parseSteps(jobBody) {
  const lines = jobBody.split('\n');
  const steps = [];
  let current = null;
  for (const line of lines) {
    if (/^ {6}- /.test(line)) {
      if (current) steps.push(current);
      const named = line.match(/^ {6}- name:\s*(.+)$/);
      current = { name: named ? named[1].trim() : '(unnamed)', lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) steps.push(current);
  return steps.map((s) => ({ name: s.name, body: s.lines.join('\n') }));
}

const jobs = parseJobs(source);
const stepsOf = (job) => parseSteps(jobs[job]);
const stepNames = (job) => stepsOf(job).map((s) => s.name);
const stepNamed = (job, name) => {
  const found = stepsOf(job).find((s) => s.name === name);
  assert.ok(found, `job ${job} must have a step named "${name}"`);
  return found;
};
const stepIndex = (job, name) => {
  const i = stepNames(job).indexOf(name);
  assert.ok(i !== -1, `job ${job} must have a step named "${name}"`);
  return i;
};

/** The `if:` expression of one job, whitespace-collapsed ('' when there is none). */
function jobIf(name) {
  const body = jobs[name];
  assert.ok(body !== undefined, `job ${name} must exist`);
  const block = body.match(/^ {4}if:\s*\|?\s*\n((?: {6}.*\n?)+)/m);
  if (block) return block[1].replace(/\s+/g, ' ').trim();
  const inline = body.match(/^ {4}if:\s*(.+)$/m);
  return inline ? inline[1].trim() : '';
}

/** The `needs:` list of one job. */
function jobNeeds(name) {
  const body = jobs[name];
  const block = body.match(/^ {4}needs:\s*\n((?: {6}- .*\n?)+)/m);
  if (block) {
    return block[1]
      .split('\n')
      .map((l) => l.trim().replace(/^- /, ''))
      .filter(Boolean);
  }
  const inline = body.match(/^ {4}needs:\s*(.+)$/m);
  if (!inline) return [];
  const value = inline[1].trim();
  return value.startsWith('[')
    ? value.slice(1, -1).split(',').map((v) => v.trim()).filter(Boolean)
    : [value];
}

/**
 * Evaluates one GitHub `if:` expression against simulated job results. Only the
 * fragment this workflow actually uses is supported -- always(), needs.X.result,
 * needs.X.outputs.Y, string equality, && || and parentheses -- and anything
 * else throws rather than being silently treated as true.
 */
function evaluateIf(expr, { results, outputs }) {
  let js = expr.replace(/\s+/g, ' ').trim();
  js = js.replace(/always\(\)/g, 'true');
  js = js.replace(/needs\.([a-z0-9-]+)\.outputs\.([a-z0-9_]+)/g, (_m, job, out) =>
    JSON.stringify(outputs[job]?.[out] ?? ''),
  );
  js = js.replace(/needs\.([a-z0-9-]+)\.result/g, (_m, job) =>
    JSON.stringify(results[job] ?? 'skipped'),
  );

  const residue = js
    .replace(/"[^"]*"/g, '')
    .replace(/'[^']*'/g, '')
    .replace(/\btrue\b|\bfalse\b/g, '');
  assert.ok(
    !/[A-Za-z_$]/.test(residue),
    `unsupported expression left unresolved (${residue.trim()}) in: ${expr}`,
  );
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${js});`)();
}

/**
 * Walks the job graph the way GitHub does: a job runs when its needs succeeded
 * (unless its condition calls always()) AND its condition is true. Returns each
 * job's simulated result.
 */
function simulateRun({ migrationOnly, apply }) {
  const order = Object.keys(jobs);
  const seen = new Set();
  for (const job of order) {
    for (const need of jobNeeds(job)) {
      assert.ok(seen.has(need), `job order is not topological: ${job} needs ${need}`);
    }
    seen.add(job);
  }

  const outputs = {
    preflight: {
      migration_only: migrationOnly ? 'true' : 'false',
      function_name: migrationOnly ? 'none' : 'deletion-status',
      migration_version: APPROVED_VERSION,
      verify_jwt: 'true',
    },
    'migration-plan': { apply: apply ? 'true' : 'false' },
  };

  const results = {};
  for (const job of order) {
    const needs = jobNeeds(job);
    const condition = jobIf(job);
    const needsSatisfied = needs.every((n) => results[n] === 'success');
    const overridesNeeds = /always\(\)|failure\(\)|cancelled\(\)/.test(condition);
    const runs = condition
      ? (overridesNeeds || needsSatisfied) && evaluateIf(condition, { results, outputs })
      : needsSatisfied;
    results[job] = runs ? 'success' : 'skipped';
  }
  return results;
}

/** Every job that carries the production Environment gate. */
const GATED_JOBS = Object.keys(jobs).filter((j) => /^ {4}environment: production$/m.test(jobs[j]));
/** Every job that does not — i.e. everything that can run before approval. */
const UNGATED_JOBS = Object.keys(jobs).filter((j) => !GATED_JOBS.includes(j));

const CREDENTIAL_REF = /\$\{\{\s*(secrets|vars)\.[A-Z0-9_]+\s*\}\}/g;
const LIVE_GATE_STEP = 'Live remote preflight against production (post-approval, pre-write)';
const APPLY_STEP = 'Apply one approved migration';

/**
 * Pulls the live gate's `node -e "..."` program out of the workflow so it can
 * be executed against crafted reports. The program is single-quoted throughout,
 * so the terminator is the first line that is nothing but a double quote.
 */
function extractLiveGateProgram() {
  const body = stepNamed('approved-single-migration', LIVE_GATE_STEP).body;
  const lines = body.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'node -e "');
  assert.ok(start !== -1, 'the live gate must assert on the report with an inline node program');
  const end = lines.findIndex((l, i) => i > start && l.trim() === '"');
  assert.ok(end !== -1, 'the inline node program must be terminated');
  const program = lines.slice(start + 1, end).join('\n');
  assert.ok(!program.includes('"'), 'the extracted program must not contain a double quote');
  return program;
}

/**
 * Runs the extracted live gate against one report.
 *
 * The gate locates its report through LIVE_PREFLIGHT_JSON rather than a
 * checkout-relative path: the workflow captures into $RUNNER_TEMP so the
 * preflight's clean-worktree gate never sees its own output as drift. This
 * harness mirrors that contract, so the program under test is byte-identical
 * to the one production runs.
 */
function runLiveGate(report, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-gate-'));
  try {
    const reportPath = path.join(dir, 'live-production-preflight.json');
    fs.writeFileSync(reportPath, JSON.stringify(report));
    fs.writeFileSync(path.join(dir, 'gate.js'), extractLiveGateProgram());
    const result = spawnSync(process.execPath, ['gate.js'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        LIVE_PREFLIGHT_JSON: reportPath,
        EXPECTED_VERSION: APPROVED_VERSION,
        EXPECTED_REF: PRODUCTION_REF,
        FORBIDDEN_REF: STAGING_REF,
        ...env,
      },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A report that a healthy live run would produce. */
function healthyReport(overrides = {}) {
  const base = {
    ok: true,
    mode: 'live-remote-gate',
    credentialFree: false,
    remoteVerified: true,
    environment: {
      expectedProductionRef: PRODUCTION_REF,
      forbiddenStagingRef: STAGING_REF,
      projectRef: PRODUCTION_REF,
      url: `https://${PRODUCTION_REF}.supabase.co`,
    },
    migrations: {
      localCount: 200,
      remoteCount: 95,
      unexplainedLocal: [],
      unexplainedRemote: [],
      approvedPending: { version: APPROVED_VERSION, name: 'deletion_requests_retention' },
      approvedSelectedForExecution: 1,
      blockers: [],
    },
  };
  return {
    ...base,
    ...overrides,
    environment: { ...base.environment, ...(overrides.environment || {}) },
    migrations: { ...base.migrations, ...(overrides.migrations || {}) },
  };
}

/** The body of one top-level function in an .mjs file, by brace matching. */
function functionBody(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start !== -1, `expected to find ${signature}`);
  let depth = 0;
  for (let i = start + signature.length - 1; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${signature}`);
}

// ================================================================ property (a)
// Nothing outside the environment gate needs a production credential.

test('a1. no job outside the production Environment gate references a secret or variable', () => {
  assert.ok(GATED_JOBS.includes('approved-single-migration'), 'the migration job must be gated');
  assert.ok(UNGATED_JOBS.includes('preflight'), 'preflight runs before the gate by design');

  for (const job of UNGATED_JOBS) {
    const refs = jobs[job].match(CREDENTIAL_REF) || [];
    assert.deepEqual(
      refs,
      [],
      `job ${job} runs before the production Environment gate and must hold no credential, found: ${refs.join(', ')}`,
    );
  }
});

test('a2. the preflight job installs no Supabase CLI and passes no SUPABASE_* env to any step', () => {
  const preflight = jobs.preflight;

  assert.ok(
    !/supabase\/setup-cli/.test(preflight),
    'a CLI in the pre-approval job is a credential-shaped capability it must not have',
  );

  // Strip comments first: the job explains WHY the variables moved, and an
  // assertion must not be satisfied (or defeated) by prose.
  const code = preflight
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  const leaked = code.match(/SUPABASE_[A-Z_]+/g) || [];
  assert.deepEqual(leaked, [], `preflight must reference no SUPABASE_* variable, found: ${leaked.join(', ')}`);
});

test('a3. the preflight job runs the preflight script in --static mode only', () => {
  const step = stepNamed('preflight', 'Static precheck and migration plan (no production credentials)');

  assert.match(
    step.body,
    /node scripts\/production-deploy-preflight\.mjs --static --json/,
    'the pre-approval job must use the credential-free mode',
  );

  for (const other of stepsOf('preflight')) {
    assert.ok(
      !/production-deploy-preflight\.mjs(?! --static)/.test(other.body.replace(/^\s*#.*$/gm, '')),
      `preflight step "${other.name}" must not invoke the preflight script outside --static mode`,
    );
  }
});

test('a4. BEHAVIOUR: --static succeeds past the credential check with every credential unset, and the live mode does not', async () => {
  const scrubbed = { ...process.env };
  for (const key of Object.keys(scrubbed)) {
    if (key.startsWith('SUPABASE_')) delete scrubbed[key];
  }

  const staticRun = spawnSync(process.execPath, [PREFLIGHT, '--static', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: scrubbed,
  });
  const staticOutput = `${staticRun.stdout}${staticRun.stderr}`;
  assert.ok(
    !/Missing required production variables/.test(staticOutput),
    `--static must not demand production credentials, got: ${staticOutput.slice(0, 400)}`,
  );

  // The differential half: this is what the pre-approval job used to run, and
  // it still fails exactly as before. --static is the ONLY credential-free
  // path, not a global relaxation of the requirement.
  const liveRun = spawnSync(process.execPath, [PREFLIGHT, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: scrubbed,
  });
  const liveOutput = `${liveRun.stdout}${liveRun.stderr}`;
  assert.notEqual(liveRun.status, 0, 'the live mode must fail without credentials');
  assert.match(
    liveOutput,
    /Missing required production variables/,
    'the live mode must still demand all four production variables',
  );
  for (const name of [
    'SUPABASE_ACCESS_TOKEN',
    'SUPABASE_PRODUCTION_PROJECT_REF',
    'SUPABASE_PRODUCTION_URL',
    'SUPABASE_PRODUCTION_ANON_KEY',
  ]) {
    assert.match(liveOutput, new RegExp(name), `the live mode must still require ${name}`);
  }
});

// ================================================================ property (b)
// Nothing outside the environment gate queries production.

test('b1. no ungated job runs the Supabase CLI or any production-touching script', () => {
  const PRODUCTION_SCRIPTS = [
    'apply-production-migration.mjs',
    'deploy-production-function.mjs',
    'capture-production-function.mjs',
    'rollback-production-function.mjs',
  ];

  for (const job of UNGATED_JOBS) {
    const code = jobs[job]
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');

    assert.ok(!/supabase\/setup-cli/.test(code), `ungated job ${job} must not install the Supabase CLI`);
    assert.ok(
      !/^\s*supabase\s/m.test(code),
      `ungated job ${job} must not invoke the Supabase CLI`,
    );
    for (const script of PRODUCTION_SCRIPTS) {
      // Invocation, not mention: the preflight summary NAMES the applier when
      // it tells a reviewer where the remote checks moved to, and that prose
      // must neither satisfy nor defeat this assertion.
      const invocation = new RegExp(String.raw`\bnode\s+\S*${script.replace('.', '\\.')}`);
      assert.ok(
        !invocation.test(code),
        `ungated job ${job} must not run ${script} before the environment gate`,
      );
    }
  }
});

test('b2. the --static code path contains no remote production call at all', () => {
  const body = functionBody(preflightSource, 'function staticMain(args) {');

  for (const forbidden of [
    'runSupabaseProduction',
    'getRemoteVersions',
    'compareMigrations',
    'assertProductionTarget',
    'missingRequiredProductionVars',
  ]) {
    assert.ok(
      !body.includes(forbidden),
      `staticMain must not call ${forbidden}: the pre-approval precheck never touches production`,
    );
  }

  // And it reports honestly about what it did NOT do, so the report can never
  // be mistaken for a remote verification.
  assert.match(body, /credentialFree: true/, 'the static report must declare itself credential-free');
  assert.match(body, /remoteVerified: false/, 'the static report must declare that it verified nothing remotely');
  assert.match(body, /mode: 'static-precheck'/, 'the static report must name its own mode');
});

test('b3. --static is dispatched before any credential is read', () => {
  const body = functionBody(preflightSource, 'function main() {');
  assert.ok(
    body.indexOf('if (args.static) return staticMain(args);') <
      body.indexOf('missingRequiredProductionVars()'),
    'the static branch must be taken before the credential requirement is evaluated',
  );
});

// -------- the credential-free precheck still refuses what it CAN see --------
// Making the pre-approval job credential-free must not make it toothless. What
// is decidable from the local tree and the declared authority is still decided
// there, against the REAL production manifest, so an illegitimate migration
// never even reaches a reviewer.

const loadStatic = async () => {
  const [{ staticApprovalCheck, loadLedgerReconciliation }, { listLocalMigrationVersions }] =
    await Promise.all([
      import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'migration-reconciliation.mjs')).href),
      import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'staging-helpers.mjs')).href),
    ]);
  return {
    check: (version) =>
      staticApprovalCheck({
        local: listLocalMigrationVersions(),
        approvedVersion: version,
        reconciliation: loadLedgerReconciliation(PRODUCTION_REF),
      }),
  };
};

test('b4. BEHAVIOUR: the credential-free precheck refuses HOLD, EXCLUDE, reconciled and unknown versions', async () => {
  const { check } = await loadStatic();

  const hold = check('20260915232402');
  assert.equal(hold.ok, false, 'a HOLD migration must be refused without any credential');
  assert.equal(hold.disposition, 'HOLD');
  assert.match(hold.blockers.join(' '), /declared HOLD/);

  const excluded = check('20260818000001');
  assert.equal(excluded.ok, false, 'an EXCLUDE migration must be refused without any credential');
  assert.equal(excluded.disposition, 'EXCLUDE');
  assert.match(excluded.blockers.join(' '), /declared EXCLUDE/);

  const missing = check('20990101000000');
  assert.equal(missing.ok, false, 'a version with no migration file must be refused');
  assert.match(missing.blockers.join(' '), /names no migration in supabase\/migrations/);

  const malformed = check('not-a-version');
  assert.equal(malformed.ok, false, 'a non-version string must be refused');
  assert.match(malformed.blockers.join(' '), /not a 12-14 digit migration version/);

  const empty = check('');
  assert.equal(empty.ok, false, 'an empty approval must be refused');
});

test('b5. BEHAVIOUR: the credential-free precheck accepts exactly the approvable Build 34 targets', async () => {
  const { check } = await loadStatic();

  // These four are the KNOWN_FUTURE_UNAPPLIED entries the campaign may execute.
  for (const version of ['20260831140000', '20260908230000', '20260916130553', '20260917163000']) {
    const result = check(version);
    assert.equal(result.ok, true, `${version} must pass the precheck: ${result.blockers.join('; ')}`);
    assert.equal(result.disposition, 'KNOWN_FUTURE_UNAPPLIED');
    assert.equal(result.migration.version, version);
  }
});

test('b6. the precheck documents that it does NOT decide the remote questions', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'migration-reconciliation.mjs'), 'utf8');
  const doc = src.slice(0, src.indexOf('export function staticApprovalCheck'));

  // A reader must not be able to mistake this for the gate. The body must also
  // not have grown a remote read.
  const body = functionBody(src, 'export function staticApprovalCheck({ local, approvedVersion, reconciliation }) {');
  for (const remote of ['remoteSet', 'listRemoteVersions', 'runSupabase']) {
    assert.ok(!body.includes(remote), `staticApprovalCheck must not consult ${remote}`);
  }
  assert.match(doc, /CREDENTIAL-FREE half of the approval decision/);
  assert.match(doc, /already applied on production/);
  assert.match(doc, /never substitutes for it/);
});

// ================================================================ property (c)
// The full live remote gate still runs inside `environment: production`.

test('c1. the migration job is environment-gated and revalidates the production target there', () => {
  assert.match(
    jobs['approved-single-migration'],
    /^ {4}environment: production$/m,
    'the migration job must carry the required-reviewer gate',
  );

  const validate = stepNamed('approved-single-migration', 'Validate required production variables (values never printed)');

  for (const name of [
    'SUPABASE_ACCESS_TOKEN',
    'SUPABASE_PRODUCTION_PROJECT_REF',
    'SUPABASE_PRODUCTION_URL',
    'SUPABASE_PRODUCTION_ANON_KEY',
  ]) {
    assert.match(validate.body, new RegExp(name), `${name} must be required inside the gate`);
  }
  assert.match(validate.body, /= "\$\{STAGING_REF\}"/, 'the staging ref must be refused inside the gate');
  assert.match(
    validate.body,
    /!= "\$\{EXPECTED_PRODUCTION_REF\}"/,
    'any ref other than the pinned production ref must be refused inside the gate',
  );
});

test('c2. the live remote preflight runs inside the gate, with credentials, in full remote mode', () => {
  const gate = stepNamed('approved-single-migration', LIVE_GATE_STEP);

  assert.match(
    gate.body,
    /node scripts\/production-deploy-preflight\.mjs --json/,
    'the gate must run the full preflight',
  );
  assert.ok(!/--static/.test(gate.body), 'the gate must not run the credential-free precheck');
  assert.ok(!/--skip-remote/.test(gate.body), 'the gate must not skip the remote comparison');
  assert.match(gate.body, /APPROVED_MIGRATION_VERSION: \$\{\{ needs\.preflight\.outputs\.migration_version \}\}/);

  // The approved version is a dispatch input. It reaches the shell through the
  // step's environment, never through `${{ }}` interpolation into the command,
  // so a crafted version string cannot become shell.
  const runBlock = gate.body.slice(gate.body.indexOf('run: |'));
  assert.ok(
    !/\$\{\{/.test(runBlock),
    'the live gate must not interpolate any expression directly into its shell command',
  );
  assert.match(runBlock, /EXPECTED_VERSION="\$\{APPROVED_MIGRATION_VERSION\}"/);

  for (const name of [
    'SUPABASE_ACCESS_TOKEN',
    'SUPABASE_PRODUCTION_PROJECT_REF',
    'SUPABASE_PRODUCTION_URL',
    'SUPABASE_PRODUCTION_ANON_KEY',
  ]) {
    assert.match(gate.body, new RegExp(`${name}: \\$\\{\\{ (secrets|vars)\\.`), `${name} must be supplied to the gate`);
  }
});

test('c3. the live gate runs immediately before the write, and the applier is the last step that can mutate', () => {
  const names = stepNames('approved-single-migration');
  const validateAt = stepIndex('approved-single-migration', 'Validate required production variables (values never printed)');
  const gateAt = stepIndex('approved-single-migration', LIVE_GATE_STEP);
  const applyAt = stepIndex('approved-single-migration', APPLY_STEP);

  assert.ok(validateAt < gateAt, 'the target must be validated before the remote preflight runs');
  assert.ok(gateAt < applyAt, 'the live gate must precede the write');
  assert.equal(
    gateAt + 1,
    applyAt,
    `nothing may run between the live gate and the write, got: ${names.slice(gateAt, applyAt + 1).join(' -> ')}`,
  );
});

test('c4. BEHAVIOUR: the live gate passes a healthy live report and names what it verified', () => {
  const result = runLiveGate(healthyReport());

  assert.equal(result.status, 0, `a healthy live report must pass, stderr: ${result.stderr}`);
  assert.match(result.stdout, /LIVE GATE PASSED against wyyuqfdxucjksghsmhry/);
  assert.match(result.stdout, /remote ledger 95 rows/);
  assert.match(result.stdout, /0 unexplained local drift/);
  assert.match(result.stdout, /0 unexplained remote drift/);
  assert.match(result.stdout, /exactly 1 migration selected \(20260831140000/);
});

test('c5. BEHAVIOUR: the applier itself re-runs the whole gate before the write', () => {
  const src = fs.readFileSync(APPLIER, 'utf8');
  const write = src.indexOf("runSupabaseProduction(['db', 'query'");
  assert.ok(write !== -1, 'the applier must execute the migration through a single known call');

  // Defence in depth: even if the workflow step above were removed, the applier
  // would still refuse. Each of these must precede the write inside the script.
  for (const guard of [
    'assertProductionTarget()',
    'assertGovernedCommit(governedBranch)',
    'scanSqlForProhibited',
    'listRemoteVersions()',
    'selectApprovedMigration(',
  ]) {
    const at = src.indexOf(guard);
    assert.ok(at !== -1, `the applier must call ${guard}`);
    assert.ok(at < write, `${guard} must run before the migration write`);
  }
});

// ================================================================ property (d)
// The migration cannot execute if the live gate fails.

test('d1. BEHAVIOUR: the live gate rejects every way a report can fail to prove the write is safe', () => {
  const cases = [
    ['a static precheck report', healthyReport({ mode: 'static-precheck', remoteVerified: false }), /did not verify production remotely/],
    ['a --skip-remote report', healthyReport({ mode: 'local-only', remoteVerified: false }), /did not verify production remotely/],
    ['remoteVerified quietly false', healthyReport({ remoteVerified: false }), /did not verify production remotely/],
    ['the staging project as target', healthyReport({ environment: { projectRef: STAGING_REF } }), /target is yzqjvdfgefveprobvvyw/],
    ['some other project as target', healthyReport({ environment: { projectRef: 'zzzzzzzzzzzzzzzzzzzz' } }), /target is zzzzzzzzzzzzzzzzzzzz/],
    ['a skipped ledger read', healthyReport({ migrations: { skipped: true } }), /the remote ledger was not read/],
    ['no remote ledger count', healthyReport({ migrations: { remoteCount: undefined } }), /no live remote ledger count/],
    ['unexplained local drift', healthyReport({ migrations: { unexplainedLocal: [{ version: '20260101000000' }] } }), /unexplained local drift: 20260101000000/],
    ['unexplained remote drift', healthyReport({ migrations: { unexplainedRemote: ['20260202000000'] } }), /unexplained remote drift: 20260202000000/],
    ['a different migration selected', healthyReport({ migrations: { approvedPending: { version: '20260908230000', name: 'other' } } }), /not the approved 20260831140000/],
    ['no migration selected', healthyReport({ migrations: { approvedPending: null } }), /selected migration is \(none\)/],
    ['two migrations selected', healthyReport({ migrations: { approvedSelectedForExecution: 2 } }), /selected 2 migrations for execution, not exactly 1/],
    ['zero migrations selected', healthyReport({ migrations: { approvedSelectedForExecution: 0 } }), /selected 0 migrations for execution, not exactly 1/],
    ['preflight blockers present', healthyReport({ ok: false, migrations: { blockers: ['HOLD migration selected'] } }), /preflight blockers: HOLD migration selected/],
  ];

  for (const [label, report, expected] of cases) {
    const result = runLiveGate(report);
    assert.equal(result.status, 1, `the live gate must reject ${label}`);
    assert.match(result.stderr, /LIVE GATE FAILED/, `${label} must be reported as a gate failure`);
    assert.match(result.stderr, expected, `${label} must say why`);
    assert.ok(
      !/LIVE GATE PASSED/.test(result.stdout),
      `${label} must never also report a pass`,
    );
  }
});

test('d2. BEHAVIOUR: a HOLD/EXCLUDE migration cannot reach the write through the live gate', () => {
  // The selection gate refuses these upstream, so the report arrives with a
  // blocker and no selection. Both halves are rejected here.
  const held = healthyReport({
    ok: false,
    migrations: {
      approvedPending: null,
      approvedSelectedForExecution: 0,
      blockers: ['APPROVED_MIGRATION_VERSION=20260915232402 is declared HOLD'],
    },
  });
  const result = runLiveGate(held, { EXPECTED_VERSION: '20260915232402' });
  assert.equal(result.status, 1, 'a HOLD migration must not pass the live gate');
  assert.match(result.stderr, /selected migration is \(none\)/);
});

test('d3. a failing gate step aborts the job before the write can run', () => {
  const gate = stepNamed('approved-single-migration', LIVE_GATE_STEP);
  const validate = stepNamed('approved-single-migration', 'Validate required production variables (values never printed)');
  const apply = stepNamed('approved-single-migration', APPLY_STEP);

  for (const [label, step] of [['the live gate', gate], ['the target validation', validate]]) {
    assert.ok(
      !/continue-on-error/.test(step.body),
      `${label} must not be allowed to fail without stopping the job`,
    );
    assert.ok(
      !/^\s{8}if:/m.test(step.body),
      `${label} must be unconditional — a condition is a way to skip it`,
    );
    assert.match(step.body, /set -euo pipefail/, `${label} must abort on the first failing command`);
  }

  assert.ok(
    !/continue-on-error|^\s{8}if:/m.test(apply.body),
    'the write must not be able to run when an earlier step failed',
  );
  assert.match(
    gate.body,
    /process\.exitCode = 1/,
    'the gate assertions must produce a non-zero exit, not just log',
  );
});

test('d4. the job still refuses anything but the governed branch tip inside the gate', () => {
  const refuse = stepNamed('approved-single-migration', 'Refuse anything but the governed branch tip');
  assert.match(refuse.body, /git fetch origin "\$\{GOVERNED_BRANCH\}"/);
  assert.match(refuse.body, /test "\$\(git rev-parse HEAD\)" = "\$\(git rev-parse "origin\/\$\{GOVERNED_BRANCH\}"\)"/);
  assert.ok(
    stepIndex('approved-single-migration', 'Refuse anything but the governed branch tip') <
      stepIndex('approved-single-migration', APPLY_STEP),
    'the governed-tip check must precede the write',
  );

  // And the pre-approval job checks it too, without needing a credential.
  assert.match(
    stepNamed('preflight', 'Refuse anything but the governed branch tip').body,
    /is not the current tip of/,
  );
});

// ================================================================ property (e)
// Migration-only mode still deploys no Edge Function.

test('e1. migration-only mode passes an empty function allow-list to BOTH preflight modes', () => {
  const staticStep = stepNamed('preflight', 'Static precheck and migration plan (no production credentials)');
  assert.match(
    staticStep.body,
    /DEPLOY_FUNCTIONS: \$\{\{ steps\.scope\.outputs\.migration_only == 'true' && '' \|\| inputs\.function_name \}\}/,
    'the pre-approval precheck must deploy nothing in migration-only mode',
  );

  // The live gate added by this change must not reintroduce a function.
  const gate = stepNamed('approved-single-migration', LIVE_GATE_STEP);
  assert.match(
    gate.body,
    /DEPLOY_FUNCTIONS: \$\{\{ needs\.preflight\.outputs\.migration_only == 'true' && '' \|\| needs\.preflight\.outputs\.function_name \}\}/,
    'the live gate must deploy nothing in migration-only mode either',
  );
});

test('e2. SIMULATION: migration-only mode runs the migration and nothing else', () => {
  // Evaluated rather than grepped. Only `source-validation` and
  // `deploy-one-function` name migration_only directly; health-check,
  // synthetic-tests and rollback-on-failure are excluded TRANSITIVELY, by
  // requiring a successful deploy-one-function. A grep for migration_only
  // would report that as a hole; running the graph shows it is not one.
  const migrationOnly = simulateRun({ migrationOnly: true, apply: true });

  assert.equal(migrationOnly['approved-single-migration'], 'success', 'the migration must still run');
  for (const job of [
    'source-validation',
    'deploy-one-function',
    'health-check',
    'synthetic-tests',
    'rollback-on-failure',
  ]) {
    assert.equal(migrationOnly[job], 'skipped', `${job} must be skipped in migration-only mode`);
  }

  // Non-vacuity: the same simulator must show the full chain running when the
  // run is NOT migration-only. A simulator that returned 'skipped' for
  // everything would pass the block above and fail here.
  const withFunction = simulateRun({ migrationOnly: false, apply: true });
  for (const job of ['source-validation', 'deploy-one-function', 'health-check', 'synthetic-tests']) {
    assert.equal(withFunction[job], 'success', `${job} must run when a function is being deployed`);
  }
  assert.equal(
    withFunction['rollback-on-failure'],
    'skipped',
    'rollback only runs on a health/synthetic failure',
  );
});

test('e3. no step in the migration job deploys a function', () => {
  for (const step of stepsOf('approved-single-migration')) {
    const code = step.body.replace(/^\s*#.*$/gm, '');
    assert.ok(
      !/deploy-production-function\.mjs|functions deploy/.test(code),
      `migration job step "${step.name}" must not deploy an Edge Function`,
    );
  }
});

// ================================================================ property (f)
// Staging is still impossible to target.

test('f1. BEHAVIOUR: the production target guard refuses staging', async () => {
  const { assertProductionTarget } = await import(
    pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'production-helpers.mjs')).href
  );

  assert.throws(
    () =>
      assertProductionTarget({
        projectRef: STAGING_REF,
        url: `https://${STAGING_REF}.supabase.co`,
        anonKey: 'anon',
      }),
    /equals staging/,
    'the staging ref must be refused by the guard the live preflight calls',
  );
  assert.throws(
    () =>
      assertProductionTarget({
        projectRef: PRODUCTION_REF,
        url: `https://${STAGING_REF}.supabase.co`,
        anonKey: 'anon',
      }),
    /points at staging/,
    'a production ref paired with a staging URL must also be refused',
  );
});

test('f2. BEHAVIOUR: the live gate refuses a report naming staging even if the report claims to be ok', () => {
  const lying = healthyReport({ ok: true, environment: { projectRef: STAGING_REF } });
  const result = runLiveGate(lying);
  assert.equal(result.status, 1, 'staging must be refused no matter what the report claims');
  assert.match(result.stderr, /target is yzqjvdfgefveprobvvyw, not wyyuqfdxucjksghsmhry/);
});

test('f3. the staging ref is pinned in the workflow and checked inside the gate', () => {
  assert.match(source, new RegExp(`STAGING_REF: ${STAGING_REF}`), 'the staging ref is pinned as a workflow env');
  assert.match(
    source,
    new RegExp(`EXPECTED_PRODUCTION_REF: ${PRODUCTION_REF}`),
    'the production ref is pinned as a workflow env',
  );

  // The refusal must live in a gated job — a check the pre-approval job cannot
  // perform, because it has no project ref to check.
  const refusingJobs = Object.keys(jobs).filter((j) => /Staging project ref is forbidden here/.test(jobs[j]));
  assert.ok(refusingJobs.length > 0, 'some job must refuse the staging ref');
  for (const job of refusingJobs) {
    assert.ok(GATED_JOBS.includes(job), `the staging refusal in ${job} must sit behind the environment gate`);
  }
});

test('f4. BEHAVIOUR: the refs the pipeline is pinned to are the real ones', async () => {
  // Read the values, do not grep for them: both refs are defined once in
  // staging-constants.mjs and re-exported, so a grep of the wrong file would
  // pass or fail for reasons that have nothing to do with the pinning.
  const { STAGING_PROJECT_REF, PRODUCTION_PROJECT_REF } = await import(
    pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'production-helpers.mjs')).href
  );
  assert.equal(STAGING_PROJECT_REF, STAGING_REF);
  assert.equal(PRODUCTION_PROJECT_REF, PRODUCTION_REF);
  assert.notEqual(STAGING_PROJECT_REF, PRODUCTION_PROJECT_REF);

  // The static precheck never chooses a target at all; it reports the pinned
  // constants so a reviewer can see what the gated job will be held to.
  const body = functionBody(preflightSource, 'function staticMain(args) {');
  assert.match(body, /expectedProductionRef: PRODUCTION_PROJECT_REF/);
  assert.match(body, /forbiddenStagingRef: STAGING_PROJECT_REF/);
});
