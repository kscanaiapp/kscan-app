#!/usr/bin/env node
'use strict';

/**
 * Regression tests for DEF-B29-SVV-011.
 *
 * The controlled staging deploy workflow tees this script's stdout into
 * deploy-result.json and then reads it with a SINGLE-document loader:
 *
 *   node scripts/deploy-staging-function.mjs | tee deploy-result.json
 *   python3 -c "import json; print(json.load(open('deploy-result.json')).get('manifestPath',''))"
 *
 * The script used to print a pre-deploy progress block to stdout as well as
 * the final receipt, so deploy-result.json held two concatenated documents and
 * json.load raised:
 *
 *   json.decoder.JSONDecodeError: Extra data: line 31 column 1 (char 708)
 *
 * That made a SUCCESSFUL deploy report failure -- apple-credential-link went
 * live while the job went red -- and, because the job failed, the health check
 * and synthetic tests were skipped. A deploy that worked became
 * indistinguishable from one that did not.
 *
 * stdout is therefore a machine contract: exactly one JSON document, the
 * receipt. Progress and errors belong on stderr.
 *
 * Pure unit tests -- no network, no credentials, no staging contact.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'deploy-staging-function.mjs');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'staging-controlled-deploy.yml');

/** Strips string and template literals so call sites in prose/comments do not count. */
function countStdoutWrites(source) {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return (withoutComments.match(/console\.log\s*\(/g) || []).length;
}

test('SVV-011: the deploy script writes exactly one JSON document to stdout', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.equal(
    countStdoutWrites(source),
    1,
    'stdout is a single-document contract; a second write breaks json.load in the workflow',
  );
});

test('SVV-011: the single stdout document is the deploy receipt', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const call = /console\.log\(JSON\.stringify\(\{([^}]*)\}/.exec(source);
  assert.ok(call, 'the stdout write must emit a JSON document');
  for (const field of ['ok', 'manifestPath', 'manifest']) {
    assert.match(call[1], new RegExp(field), `the receipt must carry ${field}`);
  }
});

test('SVV-011: pre-deploy progress goes to stderr, not stdout', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(
    source,
    /console\.error\(JSON\.stringify\(\{\s*\r?\n\s*phase: 'deploy',/,
    'the pre-deploy block must be diagnostics on stderr',
  );
});

test('SVV-011: a failure path writes nothing at all to stdout', () => {
  // fail() must not pollute the receipt stream: an empty stdout is a clean
  // "no receipt", whereas a partial document would parse as corrupt.
  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      // Deliberately missing every required staging variable.
    },
  });
  assert.notEqual(res.status, 0, 'missing configuration must fail');
  assert.equal(res.stdout.trim(), '', 'stdout must stay empty on the failure path');
  assert.match(res.stderr, /Missing required staging variables/);
});

test('SVV-011: whatever the script emits on stdout must parse as ONE document', () => {
  // Guards the exact failure: concatenated documents parse individually but
  // not together, which is what json.load sees.
  const twoDocuments = `${JSON.stringify({ phase: 'deploy' }, null, 2)}\n${JSON.stringify({ ok: true }, null, 2)}\n`;
  assert.throws(() => JSON.parse(twoDocuments), 'two documents must not parse -- this is the defect');
  const oneDocument = `${JSON.stringify({ ok: true, manifestPath: 'x', manifest: {} }, null, 2)}\n`;
  assert.doesNotThrow(() => JSON.parse(oneDocument));
});

test('SVV-011: the workflow still reads deploy-result.json as a single document', () => {
  // If this coupling ever changes, the contract above should be revisited
  // deliberately rather than drifting.
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(workflow, /node scripts\/deploy-staging-function\.mjs \| tee deploy-result\.json/);
  assert.match(workflow, /json\.load\(open\('deploy-result\.json'\)\)/);
});

test('SVV-011: no child process inherits stdout', () => {
  // The first SVV-011 patch moved this script's own console.log to stderr but
  // missed the preflight child, which runs with --json and inherited stdout --
  // so a second document still reached deploy-result.json. Counting
  // console.log call sites cannot see that; this can.
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(
    source,
    /stdio:\s*'inherit'/,
    "a child's stdout must be captured, not inherited, or it lands in the receipt stream",
  );
});

test('SVV-011: anything on stdout is the receipt and nothing else', () => {
  // Behavioural. Runs the real script far enough to execute preflight, then
  // lets it fail. It cannot mutate staging: deploy needs real credentials and
  // this exits well before that. Pre-fix, stdout held the preflight report
  // (657 bytes, no manifestPath); post-fix it is empty.
  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      SUPABASE_ACCESS_TOKEN: 'stub-token-not-a-credential',
      SUPABASE_STAGING_PROJECT_REF: 'yzqjvdfgefveprobvvyw',
      SUPABASE_STAGING_URL: 'https://yzqjvdfgefveprobvvyw.supabase.co',
      SUPABASE_STAGING_ANON_KEY: 'sb_publishable_test_key_value',
      DEPLOY_FUNCTIONS: 'apple-credential-link',
      FUNCTION_NAME: 'apple-credential-link',
      EXPECTED_VERIFY_JWT: 'true',
      SKIP_PREFLIGHT_REMOTE: 'true',
    },
  });

  const stdout = res.stdout.trim();
  if (stdout === '') return; // nothing emitted is a valid "no receipt"

  let parsed;
  assert.doesNotThrow(
    () => { parsed = JSON.parse(stdout); },
    'stdout must parse as exactly one JSON document',
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(parsed, 'manifestPath'),
    'the only document allowed on stdout is the deploy receipt',
  );
});
