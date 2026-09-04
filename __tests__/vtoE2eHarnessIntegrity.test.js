#!/usr/bin/env node
'use strict';

/**
 * VTO E2E harness — certification-instrument integrity controls (repair
 * spec: false-green pipeline defect + invalid-SQL-command defect repair).
 * No live staging mutation anywhere in this file — everything here runs
 * against local subprocesses, synthetic fixtures, and pure functions.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

async function loadProvision() {
  return import('../scripts/vto-e2e/lib/provision.mjs');
}
async function loadActors() {
  return import('../scripts/vto-e2e/lib/actors.mjs');
}
async function loadRun() {
  return import('../scripts/vto-e2e/run.mjs');
}
async function loadWorkflowGuard() {
  return import('../scripts/vto-e2e/lib/workflow-guard.mjs');
}
async function loadValidateReport() {
  return import('../scripts/vto-e2e/validate-report.mjs');
}
async function loadReportSchema() {
  return import('../scripts/vto-e2e/lib/report-schema.mjs');
}
async function loadSql() {
  return import('../scripts/vto-e2e/lib/sql.mjs');
}
async function loadCleanup() {
  return import('../scripts/vto-e2e/lib/cleanup.mjs');
}

const WORKFLOW_PATH = path.join(__dirname, '..', '.github', 'workflows', 'vto-e2e.yml');

// ── Controls A1/A2 (spec §5): pipeline failure propagation ──────────────
// GitHub Actions' UNDECLARED default shell on Linux is `bash -e {0}` — no
// `-o pipefail`. Naming `shell: bash` switches to
// `bash --noprofile --norc -eo pipefail {0}`. These two helpers reproduce
// exactly those two invocations so the tests below prove the real defect
// and the real fix, not an approximation of either.

function runAsUndeclaredDefaultShell(script) {
  return spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8' });
}
function runAsNamedBashShell(script) {
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { encoding: 'utf8' });
}

test('Control A1 — failure propagation: node|tee is falsely green under the undeclared default shell, and correctly fails under named `shell: bash`', () => {
  const reportFile = path.join(os.tmpdir(), `vto-e2e-a1-${crypto.randomUUID()}.json`);
  const script = `node -e "process.exit(1)" | tee ${reportFile} > /dev/null`;

  const undeclared = runAsUndeclaredDefaultShell(script);
  assert.equal(undeclared.status, 0, 'undeclared default shell (bash -e, NO pipefail) must mask the node failure behind tee\'s own success — this is Defect A');

  const named = runAsNamedBashShell(script);
  assert.notEqual(named.status, 0, 'named `shell: bash` (pipefail) must propagate the node failure as the pipeline\'s own exit code — this is the repair');

  fs.rmSync(reportFile, { force: true });
});

test('Control A2 — legitimate success remains success under pipefail (the fix never turns a real pass into a false failure)', () => {
  const reportFile = path.join(os.tmpdir(), `vto-e2e-a2-${crypto.randomUUID()}.json`);
  const script = `node -e "process.exit(0)" | tee ${reportFile} > /dev/null`;
  const named = runAsNamedBashShell(script);
  assert.equal(named.status, 0);
  fs.rmSync(reportFile, { force: true });
});

// ── Control A3 (spec §5): structural YAML guard ──────────────────────────

test('Control A3 — the real vto-e2e workflow has pipefail-safe semantics for every piped run step', async () => {
  const { checkWorkflowPipefailSafety } = await loadWorkflowGuard();
  const yamlText = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const result = checkWorkflowPipefailSafety(yamlText);
  assert.equal(result.ok, true, `unsafe pipelines found: ${JSON.stringify(result.violations, null, 2)}`);
  assert.equal(result.workflowDefaultShell, 'bash');
});

test('Control A3 — the guard actually catches a reintroduced defect: pipe with no pipefail-safe shell anywhere in scope', async () => {
  const { checkWorkflowPipefailSafety } = await loadWorkflowGuard();
  const badYaml = [
    'name: Synthetic',
    'on: push',
    'jobs:',
    '  bad-job:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Run and tee',
    '        run: node scripts/x.mjs | tee report.json',
    '',
  ].join('\n');
  const result = checkWorkflowPipefailSafety(badYaml);
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].job, 'bad-job');
});

test('Control A3 — the guard accepts the same pipeline once a workflow-level pipefail-safe default is declared', async () => {
  const { checkWorkflowPipefailSafety } = await loadWorkflowGuard();
  const goodYaml = [
    'name: Synthetic',
    'on: push',
    'defaults:',
    '  run:',
    '    shell: bash',
    'jobs:',
    '  good-job:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Run and tee',
    '        run: node scripts/x.mjs | tee report.json',
    '',
  ].join('\n');
  const result = checkWorkflowPipefailSafety(goodYaml);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('Control A3 — the guard also accepts an inline `set -euo pipefail` with no declared shell default', async () => {
  const { checkWorkflowPipefailSafety } = await loadWorkflowGuard();
  const goodYaml = [
    'name: Synthetic',
    'on: push',
    'jobs:',
    '  good-job:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Run and tee',
    '        run: |',
    '          set -euo pipefail',
    '          node scripts/x.mjs | tee report.json',
    '',
  ].join('\n');
  const result = checkWorkflowPipefailSafety(goodYaml);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('Control A3 — a step with no pipe at all is never flagged, regardless of shell', async () => {
  const { checkWorkflowPipefailSafety } = await loadWorkflowGuard();
  const yaml = [
    'name: Synthetic',
    'on: push',
    'jobs:',
    '  fine-job:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Just install',
    '        run: npm ci',
    '',
  ].join('\n');
  const result = checkWorkflowPipefailSafety(yaml);
  assert.equal(result.ok, true);
});

// ── Concurrency contract (spec §25) ──────────────────────────────────────

test('concurrency contract: every live-staging job is single-flight (group=vto-e2e-certification, cancel-in-progress=false)', async () => {
  const { checkConcurrencyContract } = await loadWorkflowGuard();
  const yamlText = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const result = checkConcurrencyContract(yamlText);
  assert.equal(result.ok, true, JSON.stringify(result.violations, null, 2));
});

test('concurrency contract: the guard catches a job missing its concurrency guard', async () => {
  const { checkConcurrencyContract } = await loadWorkflowGuard();
  const yaml = [
    'jobs:',
    '  staging-dryrun:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: noop',
    '        run: echo hi',
    '',
  ].join('\n');
  const result = checkConcurrencyContract(yaml, ['staging-dryrun']);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].job, 'staging-dryrun');
});

// ── Report/artifact validator (spec §6-§8, §37): schema + stale-artifact ─

const VALID_AUTHORITY_SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const EXPECT = {
  runId: 'vto-dryrun-20260904T000000Z-abcd1234',
  projectRef: 'yzqjvdfgefveprobvvyw',
  mode: 'staging-dryrun',
  authoritySha: VALID_AUTHORITY_SHA,
};

function validReport(overrides = {}) {
  return {
    runId: EXPECT.runId,
    projectRef: EXPECT.projectRef,
    mode: EXPECT.mode,
    authoritySha: EXPECT.authoritySha,
    controls: [{ name: 'example control', ok: true, detail: 'pass' }],
    providerSubmits: 0,
    paidRequests: 0,
    cleanupStatus: { usersRemaining: 0, entitlementsRemaining: 0, vtoRequestsRemaining: 0, clean: true },
    verdict: 'PASS',
    ...overrides,
  };
}

function writeTempReport(obj) {
  const p = path.join(os.tmpdir(), `vto-e2e-artifact-${crypto.randomUUID()}.json`);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

test('artifact validator: missing artifact is rejected (ABSENT)', async () => {
  const { validateReportFile } = await loadValidateReport();
  const result = validateReportFile(path.join(os.tmpdir(), `vto-e2e-absent-${crypto.randomUUID()}.json`), EXPECT);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ABSENT');
});

test('artifact validator: empty (0-byte) artifact is rejected (EMPTY)', async () => {
  const { validateReportFile } = await loadValidateReport();
  const p = path.join(os.tmpdir(), `vto-e2e-empty-${crypto.randomUUID()}.json`);
  fs.writeFileSync(p, '');
  const result = validateReportFile(p, EXPECT);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EMPTY');
});

test('artifact validator: malformed JSON is rejected (MALFORMED)', async () => {
  const { validateReportFile } = await loadValidateReport();
  const p = path.join(os.tmpdir(), `vto-e2e-malformed-${crypto.randomUUID()}.json`);
  fs.writeFileSync(p, '{ this is not valid json ][');
  const result = validateReportFile(p, EXPECT);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MALFORMED');
});

test('artifact validator: wrong runId is rejected as STALE — a previous run\'s artifact must never certify a later run', async () => {
  const { validateReportFile } = await loadValidateReport();
  const p = writeTempReport(validReport({ runId: 'vto-dryrun-some-other-run-0000' }));
  const result = validateReportFile(p, EXPECT);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STALE');
});

test('artifact validator: wrong authoritySha is rejected as STALE', async () => {
  const { validateReportFile } = await loadValidateReport();
  const p = writeTempReport(validReport({ authoritySha: 'b'.repeat(40) }));
  const result = validateReportFile(p, EXPECT);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STALE');
});

test('artifact validator: wrong projectRef is rejected as STALE (production ref used as the deliberately-wrong value)', async () => {
  const { validateReportFile } = await loadValidateReport();
  const p = writeTempReport(validReport({ projectRef: 'wyyuqfdxucjksghsmhry' }));
  const result = validateReportFile(p, EXPECT);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STALE');
});

test('artifact validator: wrong mode is rejected as STALE', async () => {
  const { validateReportFile } = await loadValidateReport();
  const p = writeTempReport(validReport({ mode: 'contract' }));
  const result = validateReportFile(p, EXPECT);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STALE');
});

test('artifact validator: missing controls is rejected as STRUCTURAL', async () => {
  const { validateReportFile } = await loadValidateReport();
  const report = validReport();
  delete report.controls;
  const p = writeTempReport(report);
  const result = validateReportFile(p, EXPECT);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STRUCTURAL');
});

test('artifact validator: a valid, current artifact is accepted', async () => {
  const { validateReportFile } = await loadValidateReport();
  const p = writeTempReport(validReport());
  const result = validateReportFile(p, EXPECT);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.code, 'VALID');
});

test('artifact validator: nonzero providerSubmits outside staging-full-certification violates the hard zero-spend invariant (SPEND)', async () => {
  const { validateReportFile } = await loadValidateReport();
  const p = writeTempReport(validReport({ providerSubmits: 1 }));
  const result = validateReportFile(p, EXPECT);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SPEND');
});

test('artifact validator: nonzero paidRequests outside staging-full-certification violates the hard zero-spend invariant (SPEND)', async () => {
  const { validateReportFile } = await loadValidateReport();
  const p = writeTempReport(validReport({ paidRequests: 1 }));
  const result = validateReportFile(p, EXPECT);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SPEND');
});

test('artifact validator: a FAIL verdict is rejected even when otherwise structurally valid (VERDICT) — a workflow conclusion is never sufficient', async () => {
  const { validateReportFile } = await loadValidateReport();
  const p = writeTempReport(validReport({ verdict: 'FAIL' }));
  const result = validateReportFile(p, EXPECT);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VERDICT');
});

test('artifact validator: an oversized artifact (>= 10 MB) is rejected (OVERSIZED)', async () => {
  const { validateReportFile } = await loadValidateReport();
  const p = path.join(os.tmpdir(), `vto-e2e-oversized-${crypto.randomUUID()}.json`);
  const huge = JSON.stringify(validReport({ controls: [{ name: 'x'.repeat(11 * 1024 * 1024), ok: true }] }));
  fs.writeFileSync(p, huge);
  const result = validateReportFile(p, EXPECT);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OVERSIZED');
});

// ── Report schema (spec §7) direct unit coverage ─────────────────────────

test('report schema: rejects non-object, wrong-typed, and out-of-enum fields', async () => {
  const { validateReportArtifact } = await loadReportSchema();
  assert.equal(validateReportArtifact(null).ok, false);
  assert.equal(validateReportArtifact([]).ok, false);
  assert.equal(validateReportArtifact(validReport({ providerSubmits: '0' })).ok, false);
  assert.equal(validateReportArtifact(validReport({ paidRequests: '0' })).ok, false);
  assert.equal(validateReportArtifact(validReport({ verdict: 'MAYBE' })).ok, false);
  assert.equal(validateReportArtifact(validReport({ mode: 'production' })).ok, false);
  assert.equal(validateReportArtifact(validReport({ cleanupStatus: 'clean' })).ok, false);
  assert.equal(validateReportArtifact(validReport({ controls: [] })).ok, false, 'empty controls array proves nothing');
});

test('report schema: accepts a well-formed report with no expectations supplied', async () => {
  const { validateReportArtifact } = await loadReportSchema();
  const result = validateReportArtifact(validReport());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.stale, false);
});

// ── SQL injection negative control (spec §15) ────────────────────────────

test('SQL injection negative control: sqlQuote neutralizes quotes/semicolons/comments/unicode as inert literal content, never executable SQL', async () => {
  const { sqlQuote } = await loadSql();
  const hostile = "x'; DROP TABLE public.user_entitlements; --  日本語 payload  ";
  const quoted = sqlQuote(hostile);

  // Exact escaping contract.
  assert.equal(quoted, `'${hostile.replace(/'/g, "''")}'`);
  assert.equal(quoted[0], "'");
  assert.equal(quoted[quoted.length - 1], "'");

  // Un-double every escaped quote inside the literal body; no bare quote
  // capable of terminating the literal early may remain.
  const inner = quoted.slice(1, -1);
  assert.equal(inner.replace(/''/g, '').includes("'"), false);

  // A full statement built the harness's own way: the hostile value can only
  // ever be the CONTENTS of one string literal — proven by a balanced
  // (even) total quote count, meaning no quote inside the value closed the
  // literal early and started executable SQL.
  const statement = `delete from public.user_entitlements where user_id = ${sqlQuote(hostile)};`;
  const quoteCount = (statement.match(/'/g) || []).length;
  assert.equal(quoteCount % 2, 0);
  // The DROP/comment text is present only as inert data inside the literal.
  assert.ok(statement.includes(hostile.replace(/'/g, "''")));
});

test('SQL injection negative control: every SQL-construction call site imports the one shared sqlQuote — single governed venue (spec §12)', () => {
  const files = [
    'scripts/vto-e2e/lib/actors.mjs',
    'scripts/vto-e2e/lib/dryrun.mjs',
    'scripts/vto-e2e/lib/fullcert.mjs',
    'scripts/vto-e2e/lib/persistence.mjs',
    'scripts/vto-e2e/run.mjs',
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.match(src, /sqlQuote/, `${rel} must use sqlQuote for every SQL literal it constructs`);
    assert.match(src, /from ['"].*sql\.mjs['"]/, `${rel} must import sqlQuote from lib/sql.mjs`);
    assert.doesNotMatch(src, /function sqlQuote/, `${rel} must not define a private sqlQuote copy — repair spec §12's single SQL venue`);
  }
});

// ── Cleanup SQL contract (spec §16) ───────────────────────────────────────

test('cleanup contract: summarizeCleanupStatus sums exact-run residual counts across actors and is clean only when every actor is', async () => {
  const { summarizeCleanupStatus } = await loadCleanup();
  const evidence = {
    ACTIVE_KPLUS: {
      userId: 'u1',
      preState: { authUsers: 1, userEntitlements: 1, vtoGenerationRequests: 2 },
      postState: { authUsers: 0, userEntitlements: 0, vtoGenerationRequests: 0 },
      residual: 0,
      clean: true,
    },
    NEVER_ENTITLED: {
      userId: 'u2',
      preState: { authUsers: 1, userEntitlements: 0, vtoGenerationRequests: 0 },
      postState: { authUsers: 0, userEntitlements: 0, vtoGenerationRequests: 0 },
      residual: 0,
      clean: true,
    },
  };
  const status = summarizeCleanupStatus(evidence);
  assert.deepEqual(status, {
    usersRemaining: 0, entitlementsRemaining: 0, vtoRequestsRemaining: 0, clean: true, perActor: evidence,
  });
});

test('cleanup contract: any residual row anywhere makes the run-scoped counts nonzero and clean=false — never silently rounded away', async () => {
  const { summarizeCleanupStatus } = await loadCleanup();
  const evidence = {
    ACTIVE_KPLUS: {
      userId: 'u1',
      preState: {},
      postState: { authUsers: 0, userEntitlements: 1, vtoGenerationRequests: 0 },
      residual: 1,
      clean: false,
    },
  };
  const status = summarizeCleanupStatus(evidence);
  assert.equal(status.entitlementsRemaining, 1);
  assert.equal(status.usersRemaining, 0);
  assert.equal(status.clean, false);
});

test('cleanup contract: an empty evidence object (no actors ever provisioned) is vacuously clean with zero counts', async () => {
  const { summarizeCleanupStatus } = await loadCleanup();
  const status = summarizeCleanupStatus({});
  assert.deepEqual(status, {
    usersRemaining: 0, entitlementsRemaining: 0, vtoRequestsRemaining: 0, clean: true, perActor: {},
  });
});

// ── Defect B reproduction record (spec §10) ───────────────────────────────
// This is a recorded, source-level pin of the reproduction evidence, not a
// live CLI invocation (the contract suite runs with no staging credentials
// and must never depend on network/CLI availability). The actual CLI
// reproduction (supabase db query --help; a real `db query <sql> --linked
// --output-format json` invocation) was captured manually during this
// repair and is recorded in the PR description and Phase 1 report.

test('Defect B: the harness\'s one SQL execution path uses `supabase db query` via the shared, already-governed runSupabase helper — never a parallel mechanism', () => {
  const sqlModuleSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'vto-e2e', 'lib', 'sql.mjs'), 'utf8');
  assert.match(sqlModuleSrc, /runSupabase\(\['db', 'query', sql, '--linked', '--output-format', 'json'\]\)/);
  assert.match(sqlModuleSrc, /from ['"]\.\.\/\.\.\/lib\/staging-helpers\.mjs['"]/);

  // No other module in the harness may shell out to `supabase` itself —
  // scripts/vto-e2e/lib/sql.mjs must be the only one that IMPORTS
  // runSupabase (a prose mention inside a documentation comment, as
  // actors.mjs has, is fine and expected; an import is the real signal of
  // a second, ungoverned SQL execution path).
  const libDir = path.join(__dirname, '..', 'scripts', 'vto-e2e', 'lib');
  for (const file of fs.readdirSync(libDir)) {
    if (file === 'sql.mjs') continue;
    const src = fs.readFileSync(path.join(libDir, file), 'utf8');
    assert.doesNotMatch(
      src,
      /import\s*\{[^}]*\brunSupabase\b[^}]*\}\s*from/,
      `${file} must go through lib/sql.mjs, never import runSupabase directly`,
    );
  }
});

// ── confirmActorEmail SQL contract (incident-derived: generated-column
//    defect) ───────────────────────────────────────────────────────────
// Live evidence: staging-dryrun run vto-dryrun-20260904T154802Z-c5446aa2
// failed all three actors inside confirmActorEmail's `supabase db query
// --linked` call with Postgres error `column "confirmed_at" can only be
// updated to DEFAULT` — auth.users.confirmed_at is
// `GENERATED ALWAYS AS LEAST(email_confirmed_at, phone_confirmed_at)` and
// can never be assigned directly. These tests pin the corrected statement
// shape at the real call site (a captured runSql, never a live connection)
// and its negative-space: no generated-column assignment, ever.

test('confirmActorEmail: the emitted SQL assigns EXACTLY ONE writable column (email_confirmed_at), assigns no generated column, retains the id-scoped predicate and the email_confirmed_at IS NULL guard, and remains safely quoted', async () => {
  const { confirmActorEmail } = await loadActors();
  const userId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  let captured = null;
  const runSql = async (sql) => { captured = sql; return []; };

  await confirmActorEmail(runSql, userId);

  assert.ok(captured, 'confirmActorEmail must call runSql exactly once');

  const setClauseMatch = captured.match(/set\s+(.*?)\s+where/i);
  assert.ok(setClauseMatch, `SQL must have a SET ... WHERE shape, got: ${captured}`);
  const setClause = setClauseMatch[1];
  assert.equal(setClause.split(',').length, 1, `SET clause must assign exactly one column, got: ${setClause}`);
  assert.match(setClause, /^email_confirmed_at\s*=\s*now\(\)$/, 'the one writable column assigned must be email_confirmed_at');

  // \b does not fire between `_` and a letter, so this correctly matches a
  // bare `confirmed_at` reference without also matching inside the writable
  // `email_confirmed_at` column this statement legitimately assigns.
  assert.doesNotMatch(captured, /\bconfirmed_at\b\s*=/, 'must never assign the generated column confirmed_at directly');

  assert.match(captured, new RegExp(`where id = '${userId}'`, 'i'), 'id-scoped predicate must remain present');
  assert.match(captured, /email_confirmed_at is null/i, 'the email_confirmed_at IS NULL guard must remain present');

  const quoteCount = (captured.match(/'/g) || []).length;
  assert.equal(quoteCount % 2, 0, 'quotes must remain balanced — no literal left open');
});

test('confirmActorEmail: does not assign directly to the generated column confirmed_at', async () => {
  const { confirmActorEmail } = await loadActors();
  let captured = null;
  const runSql = async (sql) => { captured = sql; return []; };

  await confirmActorEmail(runSql, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

  assert.doesNotMatch(captured, /\bconfirmed_at\b/, 'the bare token confirmed_at must not appear anywhere in the emitted SQL');
});

test('confirmActorEmail: exact actor id scoping remains present — the predicate targets only the given user id, never a broader match or a second statement', async () => {
  const { confirmActorEmail } = await loadActors();
  const userId = 'f1f1f1f1-2222-3333-4444-555555555555';
  const otherUserId = '00000000-0000-0000-0000-000000000000';
  let captured = null;
  const runSql = async (sql) => { captured = sql; return []; };

  await confirmActorEmail(runSql, userId);

  assert.match(captured, new RegExp(`id = '${userId}'`));
  assert.doesNotMatch(captured, new RegExp(`id = '${otherUserId}'`));
  assert.equal((captured.match(/\bwhere\b/gi) || []).length, 1, 'exactly one WHERE clause');
  assert.equal((captured.match(/;/g) || []).length, 1, 'exactly one statement — never a stacked query');
});

test('confirmActorEmail: SQL remains safely quoted via the shared sqlQuote — a hostile/SQL-injection-shaped user id is neutralized as inert literal content (extends the existing sqlQuote injection control to this exact call site)', async () => {
  const { confirmActorEmail } = await loadActors();
  const { sqlQuote } = await loadSql();
  const hostileId = "x'; drop table auth.users; --";
  let captured = null;
  const runSql = async (sql) => { captured = sql; return []; };

  await confirmActorEmail(runSql, hostileId);

  assert.ok(captured.includes(sqlQuote(hostileId)), 'must quote the id through the shared sqlQuote helper, not ad hoc');
  const quoteCount = (captured.match(/'/g) || []).length;
  assert.equal(quoteCount % 2, 0, 'quotes must remain balanced — no literal left open for the injected payload to escape into');
  assert.ok(captured.includes(hostileId.replace(/'/g, "''")), 'the hostile payload must appear only as inert, escaped literal content');

  // Replacing the one quoted literal with a placeholder must leave EXACTLY
  // the expected fixed statement skeleton — proving the payload's own `;`
  // and `--` never reach real statement syntax, only ever the inside of
  // this one balanced literal (the "drop table" text remaining visible
  // above is expected: it is inert data, not a second executable statement).
  const skeleton = captured.replace(sqlQuote(hostileId), '<ID>');
  assert.equal(skeleton, 'update auth.users set email_confirmed_at = now() where id = <ID> and email_confirmed_at is null;');
});

test('contract: no SQL the harness constructs anywhere references the generated column confirmed_at (repair spec addendum) — email_confirmed_at is the sole verification authority', () => {
  const vtoE2eDir = path.join(__dirname, '..', 'scripts', 'vto-e2e');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.mjs')) files.push(full);
    }
  };
  walk(vtoE2eDir);
  assert.ok(files.length >= 5, 'sanity: the walk must actually find the harness source files');

  // Scoped to SQL the harness actually sends (template literals), not every
  // JS identifier in the tree — Supabase's own signup HTTP response JSON
  // happens to name a field `confirmed_at` (read once, pre-existing, in
  // signUpActor, to detect an already-confirmed signup); that is an
  // unrelated third-party API field, not SQL this harness constructs
  // against the generated DB column, and is intentionally not in scope here.
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const sqlLiterals = src.match(/`[^`]*`/gs) ?? [];
    for (const literal of sqlLiterals) {
      assert.doesNotMatch(
        literal,
        /\bconfirmed_at\b/,
        `${path.relative(path.join(__dirname, '..'), file)} constructs SQL referencing confirmed_at: ${literal}`,
      );
    }
  }
});

// ── Provisioning robustness (incident-derived): a crash mid-provisioning
//    must never lose track of an already-created auth.users row ──────────
//
// Live evidence: workflow run #7 (staging-dryrun, pre-repair commit f5ff48c)
// crashed inside confirmActorEmail's `supabase db query --linked` call,
// AFTER a real signup had already created an auth.users row, but
// provisionVtoActors let that exception escape uncaught — which propagated
// out of runStagingDryRunMode before its cleanup-guaranteeing try/finally
// ever started, orphaning that synthetic user. These tests pin the fix.

test('provisionVtoActors: a per-actor SQL failure after signup preserves that actor\'s userId and does not abort the other actors', async () => {
  const { provisionVtoActors } = await loadProvision();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: `fake-${crypto.randomUUID()}`, confirmed_at: null }),
    });
    let call = 0;
    const runSql = async () => {
      call += 1;
      if (call === 1) throw new Error('simulated transient supabase db query failure');
      return [];
    };
    const result = await provisionVtoActors({ base: 'https://x-staging.supabase.co', publishableKey: 'pk', runSql, runTag: 'integrity-test-tag' });

    const roles = Object.keys(result.evidence);
    assert.equal(roles.length, 3, 'all three roles must still be evaluated even though the first one\'s SQL call threw');

    const failedRole = roles.find((r) => result.evidence[r].provisioningFailed);
    assert.ok(failedRole, 'one role must be recorded as provisioningFailed rather than the whole function throwing');
    assert.ok(result.evidence[failedRole].userId, 'the already-created auth.users id must still be recorded in evidence, not lost');
    assert.ok(result.plan[failedRole].userId, 'actorIdsByRole(plan) must also be able to find it via plan[role].userId');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('provisionVtoActors: actorIdsByRole surfaces a provisioning-failed actor for cleanup exactly like a fully-succeeded one', async () => {
  const { provisionVtoActors, actorIdsByRole } = await loadProvision();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: `fake-${crypto.randomUUID()}`, confirmed_at: null }),
    });
    const runSql = async () => { throw new Error('every SQL call fails this run'); };
    const result = await provisionVtoActors({ base: 'https://x-staging.supabase.co', publishableKey: 'pk', runSql, runTag: 'integrity-test-tag-2' });
    const ids = actorIdsByRole(result.plan);
    assert.equal(Object.keys(ids).length, 3, 'every actor got a real signup id even though every post-signup SQL call failed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Cleanup mode: production guard + fail-closed targeting (incident-derived) ─

test('runCleanupMode: refuses when neither --run-tag nor --user-ids is given, rather than silently no-oping', async () => {
  const { runCleanupMode } = await loadRun();
  await assert.rejects(
    () => runCleanupMode({ runTag: null, userIds: [] }),
    /run-tag.*user-ids|user-ids.*run-tag/i,
  );
});

test('runCleanupMode: refuses a --user-ids value that is not a UUID', async () => {
  const { runCleanupMode } = await loadRun();
  await assert.rejects(
    () => runCleanupMode({ runTag: null, userIds: ['not-a-uuid'] }),
    /not a UUID/,
  );
});

test('runCleanupMode: asserts the staging target itself before touching anything — production is impossible as an accidental target even if the caller\'s env is wrong', async () => {
  const { runCleanupMode } = await loadRun();
  const keys = ['SUPABASE_STAGING_PROJECT_REF', 'SUPABASE_STAGING_URL', 'SUPABASE_STAGING_PUBLISHABLE_KEY'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.SUPABASE_STAGING_PROJECT_REF = 'wyyuqfdxucjksghsmhry'; // production ref, deliberately wrong
    process.env.SUPABASE_STAGING_URL = 'https://wyyuqfdxucjksghsmhry.supabase.co';
    process.env.SUPABASE_STAGING_PUBLISHABLE_KEY = 'not-a-real-key';
    await assert.rejects(
      () => runCleanupMode({ runTag: 'some-tag', userIds: [] }),
      (err) => err.name === 'StagingGuardError',
    );
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});
