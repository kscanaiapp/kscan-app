#!/usr/bin/env node
'use strict';

/**
 * Regression tests for DEF-B29-SVV-004.
 *
 * Phase 7 ships dark and needs SCAN_IDENTIFICATION_RECHECK_ENABLED=true in the
 * staging Edge Function environment, but no governed path existed to set it.
 * The two shortcuts were refused: the KSCAN release-metadata writer describes
 * release IDENTITY, not behaviour, and a generic key/value setter would be an
 * arbitrary write primitive aimed at a live backend.
 *
 * These tests pin the resulting authority as deliberately narrow: one
 * allowlisted key, one allowlisted value, staging only, confirmation required,
 * and no secret material anywhere in its output.
 *
 * No network: the Supabase CLI is injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const MODULE_URL = pathToFileURL(path.join(ROOT, 'security', 'release', 'set-staging-runtime-flag.mjs')).href;
const load = () => import(MODULE_URL);

const STAGING = 'yzqjvdfgefveprobvvyw';
const PRODUCTION = 'wyyuqfdxucjksghsmhry';
const CONFIRM = 'SET-STAGING-RUNTIME-FLAG';
const FLAG = 'SCAN_IDENTIFICATION_RECHECK_ENABLED';

/** Records every CLI invocation so tests can assert what was and was not run. */
function recorder(status = 0) {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status, stdout: '', stderr: '' };
  };
  return { calls, exec };
}

const baseEnv = { SUPABASE_ACCESS_TOKEN: 'sbp_' + 'a'.repeat(40) };

test('SVV-004: the approved flag, value and staging ref is allowed', async () => {
  const { setStagingRuntimeFlag } = await load();
  const { calls, exec } = recorder();
  const result = setStagingRuntimeFlag({
    key: FLAG, value: 'true', projectRef: STAGING, confirm: CONFIRM, env: baseEnv, exec,
  });
  assert.equal(result.ok, true);
  assert.equal(result.written, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 2), ['secrets', 'set']);
  assert.ok(calls[0].args.includes('--project-ref'));
  assert.ok(calls[0].args.includes(STAGING));
});

test('SVV-004: an unknown flag is refused', async () => {
  const { setStagingRuntimeFlag } = await load();
  const { calls, exec } = recorder();
  assert.throws(
    () => setStagingRuntimeFlag({ key: 'SOME_OTHER_FLAG', value: 'true', projectRef: STAGING, confirm: CONFIRM, env: baseEnv, exec }),
    (err) => err.code === 'FLAG_NOT_ALLOWLISTED',
  );
  assert.equal(calls.length, 0, 'nothing may be executed for an unknown flag');
});

test('SVV-004: the approved flag with an unapproved value is refused', async () => {
  const { setStagingRuntimeFlag } = await load();
  const { calls, exec } = recorder();
  for (const value of ['false', '1', 'TRUE', '', 'yes']) {
    assert.throws(
      () => setStagingRuntimeFlag({ key: FLAG, value, projectRef: STAGING, confirm: CONFIRM, env: baseEnv, exec }),
      (err) => err.code === 'FLAG_VALUE_NOT_ALLOWLISTED',
      `value ${JSON.stringify(value)} must be refused on this activation path`,
    );
  }
  assert.equal(calls.length, 0);
});

test('SVV-004: the production project is explicitly rejected', async () => {
  const { setStagingRuntimeFlag } = await load();
  const { calls, exec } = recorder();
  assert.throws(
    () => setStagingRuntimeFlag({ key: FLAG, value: 'true', projectRef: PRODUCTION, confirm: CONFIRM, env: baseEnv, exec }),
    (err) => err.code === 'PRODUCTION_TARGET_REJECTED',
  );
  assert.equal(calls.length, 0, 'no command may be built for production');
});

test('SVV-004: an unknown project ref is rejected', async () => {
  const { setStagingRuntimeFlag } = await load();
  const { calls, exec } = recorder();
  assert.throws(() => setStagingRuntimeFlag({
    key: FLAG, value: 'true', projectRef: 'notaproject', confirm: CONFIRM, env: baseEnv, exec,
  }));
  assert.equal(calls.length, 0);
});

test('SVV-004: missing confirmation is refused', async () => {
  const { setStagingRuntimeFlag } = await load();
  const { calls, exec } = recorder();
  for (const confirm of ['', 'yes', 'set-staging-runtime-flag']) {
    assert.throws(
      () => setStagingRuntimeFlag({ key: FLAG, value: 'true', projectRef: STAGING, confirm, env: baseEnv, exec }),
      (err) => err.code === 'CONFIRMATION_REQUIRED',
    );
  }
  assert.equal(calls.length, 0);
});

test('SVV-004: missing Supabase authority is refused', async () => {
  const { setStagingRuntimeFlag } = await load();
  const { calls, exec } = recorder();
  assert.throws(
    () => setStagingRuntimeFlag({ key: FLAG, value: 'true', projectRef: STAGING, confirm: CONFIRM, env: {}, exec }),
    (err) => err.code === 'MISSING_SUPABASE_AUTHORITY',
  );
  assert.equal(calls.length, 0);
});

test('SVV-004: every KSCAN release-identity key is rejected outright', async () => {
  const { setStagingRuntimeFlag, RELEASE_METADATA_KEYS } = await load();
  const { calls, exec } = recorder();
  assert.ok(RELEASE_METADATA_KEYS.includes('KSCAN_RELEASE_ID'));
  for (const key of RELEASE_METADATA_KEYS) {
    assert.throws(
      () => setStagingRuntimeFlag({ key, value: 'true', projectRef: STAGING, confirm: CONFIRM, env: baseEnv, exec }),
      (err) => err.code === 'RELEASE_METADATA_KEY_REJECTED',
      `${key} must never be writable here`,
    );
  }
  assert.equal(calls.length, 0);
});

test('SVV-004: the allowlist is exactly the reviewed keys and their exact values', async () => {
  // This assertion is the tripwire for silent widening, and it has now done its
  // job twice: adding the E4.1 gate failed it, and so did the Closet V2 / S7
  // widening below. Both are recorded here rather than merely appearing in the
  // writer.
  //
  // Still pinned exhaustively, key AND value: a new flag, or a new value on an
  // existing flag, must fail this test and be justified in its own review.
  const CLOSET_INTELLIGENCE = [
    'ELISE_ADVICE_INTENTS_V1_ENABLED',
    'ELISE_CLOSET_RETRIEVAL_V1_ENABLED',
    'ELISE_COMPATIBILITY_SCORING_V1_ENABLED',
    'ELISE_WARDROBE_GAP_V1_ENABLED',
    'ELISE_PURCHASE_ADVICE_V1_ENABLED',
    'ELISE_MULTI_LOOK_V1_ENABLED',
  ];

  const { ALLOWED_FLAGS } = await load();
  assert.deepEqual(
    Object.keys(ALLOWED_FLAGS).sort(),
    ['ELISE_ROOM_INTELLIGENCE_V1_ENABLED', FLAG, ...CLOSET_INTELLIGENCE].sort(),
    'widening requires a reviewed change',
  );
  assert.deepEqual(ALLOWED_FLAGS[FLAG], ['true']);
  // E4.1 is reversible on purpose: if staging certification fails, turning it
  // back OFF must go through this same governed writer, not a manual edit.
  assert.deepEqual(ALLOWED_FLAGS.ELISE_ROOM_INTELLIGENCE_V1_ENABLED, ['true', 'false']);
  // The Closet intelligence flags are reversible for the same reason: staging
  // activation is an experiment, and one that cannot be switched off through
  // this path would have to be undone by hand against a live project.
  for (const key of CLOSET_INTELLIGENCE) {
    assert.deepEqual(ALLOWED_FLAGS[key], ['true', 'false'], `${key} must be reversible`);
  }
});

test('SVV-004: the allowlist admits no wildcard or prefix rule', async () => {
  // The value of this writer is that widening costs a review. A prefix rule
  // such as /^ELISE_/ would silently pre-approve every future flag someone
  // happens to name that way, which is the failure this whole control exists
  // to prevent.
  const source = require('node:fs').readFileSync(
    path.join(ROOT, 'security', 'release', 'set-staging-runtime-flag.mjs'),
    'utf8',
  );
  assert.doesNotMatch(source, /startsWith\(\s*['"]ELISE_/, 'no prefix matching');
  assert.doesNotMatch(source, /RegExp|\/\^ELISE/, 'no pattern matching on flag names');
  assert.doesNotMatch(source, /Object\.keys\(process\.env\)/, 'no env enumeration');
});

test('SVV-004: the scanner flag did not inherit a reversible value set', async () => {
  // Guards against the E4.1 widening being copy-pasted onto the other flag.
  const { ALLOWED_FLAGS } = await load();
  assert.ok(
    !ALLOWED_FLAGS[FLAG].includes('false'),
    'SCAN_IDENTIFICATION_RECHECK_ENABLED must remain one-way',
  );
});

test('SVV-004: every reversible Elise gate is offered by the governed workflow', async () => {
  // A writer allowlist nobody can reach is not a governed path. The workflow
  // dropdown must offer the flag and the value, or activation would still
  // require a manual secret write.
  const fs = require('node:fs');
  const path = require('node:path');
  const workflow = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '.github', 'workflows', 'staging-runtime-flag.yml'),
    'utf8',
  );
  const reversibleEliseFlags = [
    'ELISE_ROOM_INTELLIGENCE_V1_ENABLED',
    'ELISE_ADVICE_INTENTS_V1_ENABLED',
    'ELISE_CLOSET_RETRIEVAL_V1_ENABLED',
    'ELISE_COMPATIBILITY_SCORING_V1_ENABLED',
    'ELISE_WARDROBE_GAP_V1_ENABLED',
    'ELISE_PURCHASE_ADVICE_V1_ENABLED',
    'ELISE_MULTI_LOOK_V1_ENABLED',
  ];
  for (const key of reversibleEliseFlags) {
    assert.match(workflow, new RegExp(`- ${key}`), `${key} must be reachable from the workflow`);
  }
  assert.match(workflow, /- 'false'/, 'rollback must be reachable from the workflow');
});

test('SVV-004: the token is never an argv element and the value never reaches the command line', async () => {
  const { setStagingRuntimeFlag } = await load();
  const { calls, exec } = recorder();
  setStagingRuntimeFlag({ key: FLAG, value: 'true', projectRef: STAGING, confirm: CONFIRM, env: baseEnv, exec });

  const argv = calls[0].args.join(' ');
  assert.ok(!argv.includes(baseEnv.SUPABASE_ACCESS_TOKEN), 'token must not be in argv');
  assert.ok(!argv.includes('sbp_'), 'no token shape in argv');
  assert.match(argv, /--env-file/, 'the value is delivered through an env file');
  assert.ok(!/(^|\s)true(\s|$)/.test(argv), 'the value itself must not be an argv element');
  // The token still reaches the CLI, through the environment only.
  assert.equal(calls[0].opts.env.SUPABASE_ACCESS_TOKEN, baseEnv.SUPABASE_ACCESS_TOKEN);
});

test('SVV-004: the ephemeral env file is removed even on failure', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { setStagingRuntimeFlag } = await load();
  const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('kscan-runtime-flag-'));
  const { exec } = recorder(1);
  assert.throws(
    () => setStagingRuntimeFlag({ key: FLAG, value: 'true', projectRef: STAGING, confirm: CONFIRM, env: baseEnv, exec }),
    (err) => err.code === 'FLAG_WRITE_FAILED',
  );
  const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('kscan-runtime-flag-'));
  assert.deepEqual(after, before, 'no env file may survive a failed write');
});

test('SVV-004: a failed write reports no token material', async () => {
  const { setStagingRuntimeFlag } = await load();
  const exec = () => ({ status: 1, stdout: '', stderr: `boom ${baseEnv.SUPABASE_ACCESS_TOKEN}` });
  try {
    setStagingRuntimeFlag({ key: FLAG, value: 'true', projectRef: STAGING, confirm: CONFIRM, env: baseEnv, exec });
    assert.fail('expected a failure');
  } catch (err) {
    const serialized = JSON.stringify({ message: err.message, detail: err.detail });
    assert.ok(!serialized.includes(baseEnv.SUPABASE_ACCESS_TOKEN), 'the token must be redacted');
    assert.match(serialized, /\[redacted\]/);
  }
});

test('SVV-004: plan-only performs no write', async () => {
  const { setStagingRuntimeFlag } = await load();
  const { calls, exec } = recorder();
  const result = setStagingRuntimeFlag({
    key: FLAG, value: 'true', projectRef: STAGING, confirm: CONFIRM, env: baseEnv, exec, planOnly: true,
  });
  assert.equal(result.written, false);
  assert.equal(calls.length, 0);
});

// ── Last-moment write-target assertion (S7 owner tightening) ────────────────

test('SVV-004: the staging apply path re-proves its target immediately before the write', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(
    path.join(ROOT, 'scripts', 'apply-staging-migration.mjs'),
    'utf8',
  );

  // The preflight runs BEFORE `supabase link` and before the remote ledger
  // reads. Trusting it at write time means the ref that gets mutated is not
  // necessarily the ref that was verified. The owner asked for a last-moment
  // assertion after the label defect was found, and this pins it.
  assert.match(
    src,
    /assertLinkedTargetImmediatelyBeforeWrite/,
    'a last-moment target assertion must exist',
  );

  const assertAt = src.indexOf('assertLinkedTargetImmediatelyBeforeWrite(STAGING_PROJECT_REF)');
  const writeAt = src.indexOf("runSupabase(['db', 'query', '--linked'");
  assert.ok(assertAt > 0 && writeAt > 0, 'both the assertion and the write must be present');
  assert.ok(
    assertAt < writeAt,
    'the assertion must run BEFORE the mutating query, not after it',
  );

  // It must read the CLI's own live link state, not a variable carried down
  // from the preflight.
  assert.match(src, /supabase', '\.temp', 'project-ref'/, 'must read the real link state');
  // And it must fail closed on production specifically.
  assert.match(src, /linked === PRODUCTION_REF/, 'production must be an explicit deny');
  assert.match(
    src,
    /assertExpectedEnvironment\('staging', linked\)/,
    'the shared authority module must give an independent second opinion',
  );
});

test('SVV-004: the apply path derives refs from the shared authority, not a local copy', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(
    path.join(ROOT, 'scripts', 'apply-staging-migration.mjs'),
    'utf8',
  );
  assert.match(
    src,
    /environment-authority\.js/,
    'a locally redeclared ref constant is how the production ref got into staging-labelled headers',
  );
  assert.doesNotMatch(
    src,
    /const PRODUCTION_REF = ['"][a-z0-9]{20}['"]/,
    'the production ref must not be hardcoded here',
  );
});
