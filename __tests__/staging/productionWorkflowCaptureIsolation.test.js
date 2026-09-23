/**
 * Regression tests for CAPTURE-FILE ISOLATION in the production deploy workflow.
 *
 * Production run 35462960188 failed before it could write anything, with:
 *
 *   ERROR: Working tree is dirty; production never deploys from a dirty worktree
 *
 * Nothing was wrong with the checkout. The workflow ran
 *
 *   node scripts/production-deploy-preflight.mjs --static --json | tee preflight.json
 *
 * and a shell pipeline starts both sides at once: `tee` creates `preflight.json`
 * in $GITHUB_WORKSPACE immediately, while node is still loading. By the time the
 * preflight reached its FIRST gate -- gitWorkingTreeClean() -- its own
 * not-yet-written report was sitting in the checkout as an untracked file. The
 * gate did exactly what it should: it refused. The workflow, not the gate, was
 * wrong.
 *
 * The same defect sat in the gated live preflight, which would have failed the
 * moment a reviewer approved the run.
 *
 * The fix moves every pre-gate capture file to $RUNNER_TEMP, outside the checkout. The
 * gate is untouched: not relaxed, not gitignored, no --allow-dirty.
 *
 * These tests are written so that reintroducing the bug fails them. The central
 * one EXECUTES the real gate function against a real git repository under both
 * capture strategies, rather than asserting on the shape of the YAML.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'production-controlled-deploy.yml');
const HELPERS = path.join(ROOT, 'scripts', 'lib', 'staging-helpers.mjs');
const source = fs.readFileSync(WORKFLOW, 'utf8');

/** Capture files that must never be born inside the checkout before a clean-tree gate. */
const FORBIDDEN_IN_CHECKOUT = [
  'preflight.json',
  'live-preflight.json',
  'migration-result.json',
  'deploy-result.json',
];

// --------------------------------------------------------------- workflow IR

function parseJobs(yaml) {
  const lines = yaml.split('\n');
  const jobsIndex = lines.findIndex((l) => l === 'jobs:');
  assert.ok(jobsIndex !== -1, 'workflow must declare a jobs: block');
  const jobs = {};
  let current = null;
  for (const line of lines.slice(jobsIndex + 1)) {
    const header = line.match(/^ {2}([a-z0-9-]+):\s*$/);
    if (header) {
      current = header[1];
      jobs[current] = [];
      continue;
    }
    if (current && line.trim() !== '' && !line.startsWith('  ')) break;
    if (current) jobs[current].push(line);
  }
  return Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n')]));
}

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
const allSteps = Object.entries(jobs).flatMap(([job, body]) =>
  parseSteps(body).map((s) => ({ job, ...s })),
);
const stepNamed = (job, name) => {
  const found = parseSteps(jobs[job]).find((s) => s.name === name);
  assert.ok(found, `job ${job} must have a step named "${name}"`);
  return found;
};

/** A step's shell body with comment lines stripped, so prose cannot satisfy or defeat an assertion. */
function shellOf(step) {
  const at = step.body.indexOf('run: |');
  if (at === -1) return '';
  return step.body
    .slice(at)
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

const STATIC_STEP = 'Static precheck and migration plan (no production credentials)';
const LIVE_STEP = 'Live remote preflight against production (post-approval, pre-write)';
const APPLY_STEP = 'Apply one approved migration';
const DEPLOY_STEP = 'Deploy function';

// ============================================================================
// THE CENTRAL EXECUTION TEST
//
// Reproduces the real failure and proves the real fix, using the REAL gate
// function against a REAL git repository. If someone moves a capture file back
// into the checkout, the "outside" case below starts behaving like the "inside"
// case and this test fails.
// ============================================================================

/**
 * Builds a throwaway git repo whose worktree is genuinely clean, runs
 * `node probe.mjs | tee <capture>` inside it, and reports what the real
 * gitWorkingTreeClean() saw from within that node process.
 */
function observeGateUnderCapture(captureTarget) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-repo-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-temp-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');

    // The probe imports the REAL gate, so this test cannot drift from it.
    fs.writeFileSync(
      path.join(repo, 'probe.mjs'),
      `import { gitWorkingTreeClean } from ${JSON.stringify(HELPERS)};\n` +
        `process.stderr.write('CLEAN=' + gitWorkingTreeClean() + '\\n');\n` +
        `process.stdout.write(JSON.stringify({ ok: true }) + '\\n');\n`,
    );
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'committed\n');
    git('add', '-A');
    git('commit', '-qm', 'init');

    // Precondition: with nothing piped anywhere, the tree really is clean.
    assert.equal(git('status', '--porcelain').trim(), '', 'fixture repo must start clean');

    const capture = captureTarget === 'INSIDE' ? 'preflight.json' : path.join(outside, 'production-preflight.json');

    const run = spawnSync('bash', ['-c', `node probe.mjs | tee ${JSON.stringify(capture)} >/dev/null`], {
      cwd: repo,
      encoding: 'utf8',
    });

    const sawClean = /CLEAN=true/.test(run.stderr);
    const captureLanded = fs.existsSync(path.isAbsolute(capture) ? capture : path.join(repo, capture));
    return { sawClean, captureLanded, stderr: run.stderr };
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

test('1. EXECUTION: capturing into the checkout makes the real gate see drift; capturing outside does not', () => {
  // The bug, reproduced against the real gate.
  const inside = observeGateUnderCapture('INSIDE');
  assert.equal(
    inside.sawClean,
    false,
    'capturing into the checkout must make gitWorkingTreeClean() report dirt — this is the production failure',
  );
  assert.equal(inside.captureLanded, true, 'the capture file really was written into the checkout');

  // The fix, proven against the same gate.
  const outside = observeGateUnderCapture('OUTSIDE');
  assert.equal(
    outside.sawClean,
    true,
    'capturing outside the checkout must leave the worktree clean in the gate\'s eyes',
  );
  assert.equal(outside.captureLanded, true, 'the capture file is still written — it just lives elsewhere');

  // Non-vacuity: the two cases must actually differ, or the test proves nothing.
  assert.notEqual(
    inside.sawClean,
    outside.sawClean,
    'inside and outside capture must produce different gate verdicts',
  );
});

test('2. the clean-worktree gate itself is untouched and still refuses a dirty tree', () => {
  const preflight = fs.readFileSync(path.join(ROOT, 'scripts', 'production-deploy-preflight.mjs'), 'utf8');
  const helpers = fs.readFileSync(HELPERS, 'utf8');

  // Both entry points still gate.
  assert.match(preflight, /if \(!gitWorkingTreeClean\(\)\) \{\s*\n\s*fail\('Working tree is dirty/);
  assert.equal(
    (preflight.match(/if \(!gitWorkingTreeClean\(\)\)/g) || []).length,
    2,
    'both --static and the live mode must keep their clean-worktree gate',
  );

  // The gate was not softened, and no escape hatch was added. Comments are
  // stripped first: the preflight's own docstring says "--allow-dirty is not
  // offered", and that sentence must not be mistaken for the flag existing.
  const code = preflight
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

  assert.match(helpers, /execFileSync\('git', \['status', '--porcelain'\]/);
  assert.ok(!/--allow-dirty/.test(code), 'production must never offer --allow-dirty');
  assert.ok(
    !/ALLOW_DIRTY|SKIP_CLEAN|FORCE_DIRTY/.test(code),
    'no environment escape hatch may bypass the clean-worktree gate',
  );
  // argv is still parsed without any dirty-tree escape.
  assert.match(code, /json: argv\.includes\('--json'\)/);
  assert.ok(
    !/argv\.includes\('--allow-dirty'\)/.test(code),
    'the argument parser must not accept a dirty-tree override',
  );
});

test('3. the capture filenames were not gitignored as a workaround', () => {
  const ignoreFiles = ['.gitignore', path.join('.github', '.gitignore')]
    .map((f) => path.join(ROOT, f))
    .filter((f) => fs.existsSync(f));

  for (const file of ignoreFiles) {
    const body = fs.readFileSync(file, 'utf8');
    for (const name of FORBIDDEN_IN_CHECKOUT) {
      assert.ok(
        !new RegExp(`^\\s*/?${name.replace('.', '\\.')}\\s*$`, 'm').test(body),
        `${name} must not be gitignored — that would hide real drift, not fix the race (${file})`,
      );
    }
  }

  // And git itself must still consider such a file drift, in the real repo.
  const probe = path.join(ROOT, 'preflight.json');
  const preexisting = fs.existsSync(probe);
  assert.equal(preexisting, false, 'preflight.json must not exist in the repo');
  try {
    fs.writeFileSync(probe, '{}');
    const status = execFileSync('git', ['status', '--porcelain', '--', 'preflight.json'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.match(status, /\?\? preflight\.json/, 'preflight.json must still register as untracked drift');
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

// ============================================================================
// WHERE EACH CAPTURE LANDS
// ============================================================================

test('4. the static preflight report is captured outside the checkout', () => {
  const shell = shellOf(stepNamed('preflight', STATIC_STEP));

  assert.match(
    shell,
    /export STATIC_PREFLIGHT_JSON="\$RUNNER_TEMP\/[\w.-]+"/,
    'the static capture path must be rooted at $RUNNER_TEMP',
  );
  assert.match(
    shell,
    /--static --json \| tee "\$STATIC_PREFLIGHT_JSON"/,
    'the static preflight must tee into that path',
  );
  assert.match(
    shell,
    /require\(process\.env\.STATIC_PREFLIGHT_JSON\)/,
    'the summary reader must read the same temp path, not a checkout-relative one',
  );
  assert.ok(
    !/require\('\.\/preflight\.json'\)/.test(shell),
    'the summary reader must not read a checkout-relative report',
  );
});

test('5. the live remote preflight report is captured outside the checkout', () => {
  const shell = shellOf(stepNamed('approved-single-migration', LIVE_STEP));

  assert.match(
    shell,
    /export LIVE_PREFLIGHT_JSON="\$RUNNER_TEMP\/[\w.-]+"/,
    'the live capture path must be rooted at $RUNNER_TEMP',
  );
  assert.match(
    shell,
    /production-deploy-preflight\.mjs --json \| tee "\$LIVE_PREFLIGHT_JSON"/,
    'the live preflight must tee into that path',
  );
  assert.match(
    shell,
    /require\(process\.env\.LIVE_PREFLIGHT_JSON\)/,
    'the gate assertions must read the same temp path',
  );
  // It is still the FULL preflight — the fix must not have quietly changed mode.
  assert.ok(!/--static/.test(shell), 'the live gate must still run the full preflight');
  assert.ok(!/--skip-remote/.test(shell), 'the live gate must still query production');
});

test('6. the live preflight still enforces the clean worktree, from inside the environment gate', () => {
  const preflight = fs.readFileSync(path.join(ROOT, 'scripts', 'production-deploy-preflight.mjs'), 'utf8');

  // The live path's gate sits before the governed-commit check and before any write.
  const mainAt = preflight.indexOf('function main()');
  const mainBody = preflight.slice(mainAt);
  const gateAt = mainBody.indexOf('gitWorkingTreeClean()');
  const governedAt = mainBody.indexOf('assertGovernedCommit(governedBranch)');
  const compareAt = mainBody.indexOf('compareMigrations(');
  assert.ok(gateAt !== -1, 'the live mode must gate on a clean worktree');
  assert.ok(gateAt < governedAt, 'the clean-worktree gate runs before the governed-commit check');
  assert.ok(gateAt < compareAt, 'the clean-worktree gate runs before the ledger comparison');

  // And the job it runs in is still the environment-gated one.
  assert.match(
    jobs['approved-single-migration'],
    /^ {4}environment: production$/m,
    'the live preflight must stay behind the production Environment gate',
  );
});

test('7. the migration result is captured outside the checkout', () => {
  const shell = shellOf(stepNamed('approved-single-migration', APPLY_STEP));

  assert.match(
    shell,
    /export MIGRATION_RESULT_JSON="\$RUNNER_TEMP\/[\w.-]+"/,
    'the migration result path must be rooted at $RUNNER_TEMP',
  );
  assert.match(
    shell,
    /apply-production-migration\.mjs \| tee "\$MIGRATION_RESULT_JSON"/,
    'the applier must tee into that path',
  );
});

test('8. the function deploy result is captured outside the checkout and keeps its manifest output', () => {
  const shell = shellOf(stepNamed('deploy-one-function', DEPLOY_STEP));

  assert.match(
    shell,
    /export DEPLOY_RESULT_JSON="\$RUNNER_TEMP\/[\w.-]+"/,
    'the function deploy result path must be rooted at $RUNNER_TEMP',
  );
  assert.match(
    shell,
    /deploy-production-function\.mjs \| tee "\$DEPLOY_RESULT_JSON"/,
    'the deployer must tee into that external path',
  );
  assert.match(
    shell,
    /grep[^\n]+"\$DEPLOY_RESULT_JSON"/,
    'manifest parsing must read the same external capture',
  );
  assert.match(shell, /echo "manifest_path=\$\{MANIFEST\}" >> "\$GITHUB_OUTPUT"/);
});

test('9. no step anywhere creates the capture files inside the checkout', () => {
  for (const step of allSteps) {
    const shell = shellOf(step);
    if (!shell) continue;
    for (const name of FORBIDDEN_IN_CHECKOUT) {
      const escaped = name.replace('.', '\\.');
      // A bare (checkout-relative) tee target or redirection for these names.
      const bareTee = new RegExp(`\\|\\s*tee\\s+${escaped}\\b`);
      const bareRedirect = new RegExp(`>\\s*${escaped}\\b`);
      assert.ok(
        !bareTee.test(shell),
        `${step.job} / "${step.name}" must not tee ${name} into the checkout`,
      );
      assert.ok(
        !bareRedirect.test(shell),
        `${step.job} / "${step.name}" must not redirect into ${name} in the checkout`,
      );
    }
  }
});

test('10. the uploaded artifacts point at the temp captures, not the checkout', () => {
  const preflightUpload = stepNamed('preflight', 'Upload preflight artifact').body;
  assert.match(
    preflightUpload,
    /path: \$\{\{ runner\.temp \}\}\/[\w.-]+\.json/,
    'the preflight artifact must be uploaded from the runner temp dir',
  );
  assert.ok(!/path: preflight\.json/.test(preflightUpload), 'stale checkout-relative artifact path');

  const migrationUpload = stepNamed('approved-single-migration', 'Upload migration artifact').body;
  assert.match(migrationUpload, /\$\{\{ runner\.temp \}\}\/live-production-preflight\.json/);
  assert.match(migrationUpload, /\$\{\{ runner\.temp \}\}\/production-migration-result\.json/);
  assert.ok(
    !/^\s+live-preflight\.json\s*$/m.test(migrationUpload),
    'stale checkout-relative live-preflight.json artifact path',
  );
  assert.ok(
    !/^\s+migration-result\.json\s*$/m.test(migrationUpload),
    'stale checkout-relative migration-result.json artifact path',
  );

  const deployStage = stepNamed('deploy-one-function', 'Stage deploy artifacts outside checkout').body;
  assert.match(deployStage, /DEPLOY_ARTIFACT_ROOT="\$RUNNER_TEMP\/production-deploy-artifact"/);
  assert.match(
    deployStage,
    /cp -R artifacts\/production-deployments "\$DEPLOY_ARTIFACT_ROOT\/artifacts\/"/,
    'the staged artifact must retain artifacts/production-deployments for rollback',
  );

  const deployUpload = stepNamed('deploy-one-function', 'Upload deploy artifacts').body;
  assert.match(deployUpload, /path: \$\{\{ runner\.temp \}\}\/production-deploy-artifact\//);
  assert.ok(!/^\s+deploy-result\.json\s*$/m.test(deployUpload), 'stale checkout-relative deploy result');
});

test('11. every capture written before a clean-worktree gate is rooted at RUNNER_TEMP', () => {
  // Scripts that gate on a clean worktree. Any step piping one of these must
  // capture outside the checkout; steps running other scripts need not, and
  // this test must not silently start demanding it of them.
  const GATING_SCRIPTS = ['production-deploy-preflight.mjs', 'deploy-production-function.mjs'];

  let checked = 0;
  for (const step of allSteps) {
    const shell = shellOf(step);
    if (!shell) continue;
    for (const line of shell.split('\n')) {
      if (!/\|\s*tee\s/.test(line)) continue;
      if (!GATING_SCRIPTS.some((s) => line.includes(s))) continue;
      checked += 1;
      assert.match(
        line,
        /\|\s*tee\s+"\$[A-Z_]+"/,
        `${step.job} / "${step.name}": a gating script's capture must go to a temp variable, got: ${line.trim()}`,
      );
    }
  }
  assert.equal(checked, 3, 'both direct preflights and the deployer wrapper must be covered');
});

// ============================================================================
// NOTHING ELSE MOVED
// ============================================================================

test('12. migration-only mode still deploys zero Edge Functions', () => {
  const staticShell = stepNamed('preflight', STATIC_STEP).body;
  assert.match(
    staticShell,
    /DEPLOY_FUNCTIONS: \$\{\{ steps\.scope\.outputs\.migration_only == 'true' && '' \|\| inputs\.function_name \}\}/,
  );

  const liveShell = stepNamed('approved-single-migration', LIVE_STEP).body;
  assert.match(
    liveShell,
    /DEPLOY_FUNCTIONS: \$\{\{ needs\.preflight\.outputs\.migration_only == 'true' && '' \|\| needs\.preflight\.outputs\.function_name \}\}/,
  );

  // No step in the migration job may deploy a function.
  for (const step of parseSteps(jobs['approved-single-migration'])) {
    assert.ok(
      !/deploy-production-function\.mjs|functions deploy/.test(shellOf(step)),
      `migration job step "${step.name}" must not deploy an Edge Function`,
    );
  }

  // And the function chain stays excluded in migration-only mode.
  const collapse = (s) => s.replace(/\s+/g, ' ');
  for (const job of ['source-validation', 'deploy-one-function']) {
    assert.match(collapse(jobs[job]), /needs\.preflight\.outputs\.migration_only != 'true'/);
  }
});

test('13. migration selection, credentials, approval and refs are unchanged', () => {
  // Selection.
  assert.match(source, /approved_migration_version:/);
  assert.match(
    jobs['approved-single-migration'],
    /APPROVED_MIGRATION_VERSION: \$\{\{ needs\.preflight\.outputs\.migration_version \}\}/,
  );
  assert.match(jobs['approved-single-migration'], /APPROVE_PRODUCTION_MIGRATION: YES/);

  // Confirmation phrase and environment gate.
  assert.match(jobs.confirm, /!= "DEPLOY TO PRODUCTION"/);
  assert.match(jobs['approved-single-migration'], /^ {4}environment: production$/m);

  // Credential scope: still nothing before the gate.
  const GATED = Object.keys(jobs).filter((j) => /^ {4}environment: production$/m.test(jobs[j]));
  for (const job of Object.keys(jobs).filter((j) => !GATED.includes(j))) {
    const refs = jobs[job].match(/\$\{\{\s*(secrets|vars)\.[A-Z0-9_]+\s*\}\}/g) || [];
    assert.deepEqual(refs, [], `ungated job ${job} must still hold no credential`);
  }

  // Refs pinned, staging still refused inside the gate.
  assert.match(source, /EXPECTED_PRODUCTION_REF: wyyuqfdxucjksghsmhry/);
  assert.match(source, /STAGING_REF: yzqjvdfgefveprobvvyw/);
  assert.match(jobs['approved-single-migration'], /Staging project ref is forbidden here/);
});


test('14. production function deploy verifies required Supabase secret names without logging secret inventory', () => {
  const deployJob = jobs['deploy-one-function'];
  const step = stepNamed('deploy-one-function', 'Verify required Edge Function secret names');
  const shell = shellOf(step);

  assert.match(
    deployJob,
    /^ {4}environment: production$/m,
    'secret-name verification must remain behind the production Environment gate',
  );
  assert.match(
    shell,
    /supabase --output json secrets list/,
    'the workflow must use the read-only Supabase secret inventory command',
  );
  assert.match(
    shell,
    /--project-ref "\$\{SUPABASE_PRODUCTION_PROJECT_REF\}"/,
    'the inventory must target the pinned production project ref',
  );
  assert.match(
    shell,
    /SECRET_LIST_JSON="\$RUNNER_TEMP\/production-edge-secrets\.json"/,
    'the secret inventory capture must live outside the checkout',
  );

  // K+ reconcile has three hard prerequisites for a future live RevenueCat
  // connection. The internal invoker secret and the enable flag are different:
  // if absent, the deployed function is inert/fail-closed rather than unsafe.
  assert.match(
    shell,
    /kplus-reconcile-revenuecat[\s\S]*?required=\([\s\S]*?REVENUECAT_PROJECT_ID[\s\S]*?REVENUECAT_KPLUS_ENTITLEMENT_ID[\s\S]*?REVENUECAT_SECRET_API_KEY[\s\S]*?\)/,
  );
  assert.match(
    shell,
    /optional_safe_disabled=\([\s\S]*?KPLUS_RECONCILE_INTERNAL_SECRET[\s\S]*?REVENUECAT_SYNC_ENABLED[\s\S]*?\)/,
  );
  assert.match(shell, /vto-generate[\s\S]*?required=\(RAPIDAPI_KEY\)/);

  assert.ok(
    !/cat\s+"?\$SECRET_LIST_JSON"?/.test(shell),
    'the raw remote secret inventory must never be printed',
  );
  assert.ok(
    !/console\.log\([^\n]*(digest|value)/i.test(shell),
    'the verifier must not log secret values or digests',
  );
  assert.match(
    shell,
    /Missing required production Edge Function secret names:/,
    'hard prerequisites must still fail closed before deployment',
  );
  assert.match(
    shell,
    /optional activation secret absent; function remains safe-disabled:/,
    'safe-disabled activation inputs must be reported without blocking deploy',
  );

  const reconcile = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', 'kplus-reconcile-revenuecat', 'index.ts'),
    'utf8',
  );
  const revenueCat = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', '_shared', 'revenuecat', 'revenueCatClient.ts'),
    'utf8',
  );

  assert.match(
    reconcile,
    /!expectedSecret \|\| !providedSecret \|\| providedSecret !== expectedSecret[\s\S]*?401/,
    'a missing internal reconcile secret must leave the function fail-closed at 401',
  );
  assert.match(
    revenueCat,
    /Deno\.env\.get\('REVENUECAT_SYNC_ENABLED'\) \?\? ''[\s\S]*?=== 'true'/,
    'an absent RevenueCat sync flag must default to disabled',
  );
});
