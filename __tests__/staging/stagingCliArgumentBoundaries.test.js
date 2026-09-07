#!/usr/bin/env node
'use strict';

/**
 * RP-114 negative controls — Supabase/Deno CLI argument boundaries.
 *
 * The defect these pin down: the staging helpers invoked execFileSync with
 * `shell: process.platform === 'win32'`, and Node builds a cmd.exe command line
 * by joining the file and its arguments with a single space and no quoting. Any
 * argument holding a space was silently re-split, and any argument holding `&`
 * or `|` was executed as command syntax -- with cmd returning the LAST
 * command's status, so a wrong-argument invocation could still exit 0.
 *
 * These tests are hostile on purpose: every argument below is one the governed
 * staging scripts can genuinely receive from data rather than code (a checkout
 * path with a space, an operator-supplied FUNCTION_NAME, a function name read
 * out of a deployment manifest by the rollback script).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const EXEC_URL = pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'win-safe-exec.mjs')).href;
const HELPERS_URL = pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'staging-helpers.mjs')).href;

/** Arguments that must survive transport unchanged, as one argv entry each. */
const HOSTILE_ARGS = [
  'C:\\Users\\Ada Lovelace\\kscan-app\\supabase\\migrations\\20260905170749_x.sql',
  'select version from supabase_migrations.schema_migrations order by version',
  'staging-health & echo pwned',
  'staging-health | type C:\\secrets.txt',
  'staging-health --project-ref wyyuqfdxucjksghsmhry',
  'a"quoted"name',
  'trailing\\backslash\\',
  'redirect > out.txt',
  'sub(shell)name',
  '',
];

test('runWinSafe delivers every hostile argument as exactly one argv entry', async () => {
  const { runWinSafe } = await import(EXEC_URL);
  // The child prints its own argv with a separator no test argument contains,
  // so any re-splitting or shell interpretation shows up as a mismatch.
  const printer = 'process.stdout.write(process.argv.slice(1).join("\\u0000"))';
  const out = runWinSafe(process.execPath, ['-e', printer, ...HOSTILE_ARGS], { encoding: 'utf8' });
  assert.deepEqual(out.split('\u0000'), HOSTILE_ARGS);
});

test('runWinSafe preserves a non-zero exit status and stderr instead of masking it', async () => {
  const { runWinSafe } = await import(EXEC_URL);
  // Under the old shell path, `arg & something-that-succeeds` could return the
  // successful command's status. A real argv cannot do that.
  assert.throws(
    () => runWinSafe(process.execPath, ['-e', 'console.error("boom"); process.exit(3)']),
    (error) => {
      assert.equal(error.status, 3);
      assert.match(String(error.stderr), /boom/);
      return true;
    },
  );
});

test('runWinSafe reports a missing executable as ENOENT, not as a failed run', async () => {
  const { runWinSafe } = await import(EXEC_URL);
  // runDenoCheck distinguishes "deno is not installed" from "deno rejected the
  // source" by this code; routing the absence through a shell would lose it.
  assert.throws(
    () => runWinSafe('kscan-no-such-executable-rp114', ['--version']),
    (error) => error.code === 'ENOENT',
  );
});

test('assertTransportableArgs rejects what argv cannot carry', async () => {
  const { assertTransportableArgs, ArgumentBoundaryError } = await import(EXEC_URL);
  assert.doesNotThrow(() => assertTransportableArgs(['db', 'query', 'select 1']));
  for (const bad of [['a\0b'], ['a\nb'], ['a\rb'], [42], [null]]) {
    assert.throws(() => assertTransportableArgs(bad), ArgumentBoundaryError);
  }
  assert.throws(() => assertTransportableArgs('db query'), ArgumentBoundaryError);
});

test('quoteForCmd round-trips hostile arguments through cmd + CRT parsing', async () => {
  const { quoteForCmd } = await import(EXEC_URL);

  /** cmd.exe: consume a caret, take the next character literally. */
  const stripCarets = (line) => {
    let out = '';
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === '^' && i + 1 < line.length) { out += line[i + 1]; i += 1; } else { out += line[i]; }
    }
    return out;
  };

  /** Windows CRT argv splitting: backslashes are only special before a quote. */
  const parseCrt = (line) => {
    const argv = [];
    let current = '';
    let quoted = false;
    let started = false;
    let backslashes = 0;
    const flushBackslashes = (beforeQuote) => {
      current += '\\'.repeat(beforeQuote ? backslashes >> 1 : backslashes);
      backslashes = 0;
    };
    for (const ch of line) {
      if (ch === '\\') { backslashes += 1; started = true; continue; }
      if (ch === '"') {
        const literal = backslashes % 2 === 1;
        flushBackslashes(true);
        if (literal) current += '"'; else quoted = !quoted;
        started = true;
        continue;
      }
      flushBackslashes(false);
      if (ch === ' ' && !quoted) {
        if (started) { argv.push(current); current = ''; started = false; }
        continue;
      }
      current += ch;
      started = true;
    }
    flushBackslashes(false);
    if (started) argv.push(current);
    return argv;
  };

  const quotable = HOSTILE_ARGS.filter((a) => !a.includes('%'));
  const commandLine = quotable.map(quoteForCmd).join(' ');
  assert.deepEqual(parseCrt(stripCarets(commandLine)), quotable);
});

test('quoteForCmd refuses "%" rather than delivering an expanded argument', async () => {
  const { quoteForCmd, ArgumentBoundaryError } = await import(EXEC_URL);
  // cmd expands %NAME% while parsing, before any caret can protect it, so there
  // is no escaping that makes a literal "%" survive. Failing closed is the only
  // honest option.
  assert.throws(() => quoteForCmd('%SUPABASE_ACCESS_TOKEN%'), ArgumentBoundaryError);
  assert.throws(() => quoteForCmd('100% done'), ArgumentBoundaryError);
});

test('runSupabase refuses any argument naming the production project', async () => {
  const helpers = await import(HELPERS_URL);
  const { runSupabase, PRODUCTION_PROJECT_REF, STAGING_PROJECT_REF, StagingGuardError } = helpers;
  assert.equal(PRODUCTION_PROJECT_REF, 'wyyuqfdxucjksghsmhry');

  const attempts = [
    ['functions', 'deploy', 'staging-health', '--project-ref', PRODUCTION_PROJECT_REF],
    // A hostile FUNCTION_NAME / manifest function_name trying to append its own
    // target. With argv boundaries intact this is one argument, and the guard
    // rejects it before the CLI is ever spawned.
    ['functions', 'deploy', `staging-health --project-ref ${PRODUCTION_PROJECT_REF}`,
      '--project-ref', STAGING_PROJECT_REF],
    ['db', 'query', `select * from x where ref = '${PRODUCTION_PROJECT_REF}'`, '--linked'],
  ];

  for (const args of attempts) {
    assert.throws(() => runSupabase(args), StagingGuardError,
      `production ref was not refused in: ${args.join(' ')}`);
  }
});

test('runSupabase still reaches the CLI for a legitimate staging invocation', async () => {
  const { runSupabase, STAGING_PROJECT_REF, StagingGuardError } = await import(HELPERS_URL);
  // The guard must not be so broad that it blocks ordinary staging work: this
  // gets past it and fails only because the Supabase CLI is absent here.
  assert.throws(
    () => runSupabase(['link', '--project-ref', STAGING_PROJECT_REF, '--yes']),
    (error) => {
      assert.ok(!(error instanceof StagingGuardError), 'staging invocation was wrongly refused');
      return error.code === 'ENOENT' || typeof error.status === 'number';
    },
  );
});
