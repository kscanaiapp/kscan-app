#!/usr/bin/env node
'use strict';

/**
 * Regression tests for DEF-B29-SVV-010.
 *
 * resolveVerifyJwt() documented root supabase/config.toml as the governing
 * authority for a function's JWT posture, but only ever reached it "populated
 * from" that file via the manifest entry - and nothing populates that. The
 * manifest is environmentScope ENVIRONMENT_NEUTRAL (DEF-REL-006) and carries no
 * verifyJwt key for any function, so the root-config step never fired. Every
 * governed function except staging-health - the only one with a per-function
 * config.toml - was undeployable through the controlled staging deploy path,
 * which refused rather than guessed.
 *
 * These exercise the real parser against the real committed config.toml.
 * No network, no credentials, no staging contact.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const CORE = pathToFileURL(path.join(ROOT, 'security', 'release', 'staging-deploy-core.mjs')).href;
const load = () => import(CORE);

const ROOT_CONFIG_EXPECTATIONS = [
  ['apple-credential-link', true],
  ['apple-revoke-credential', false],
  ['scan-identify', false],
  ['stylechat-generate', true],
  ['restore-account', false],
  ['privacy-data-export', true],
];

for (const [functionName, expected] of ROOT_CONFIG_EXPECTATIONS) {
  test('SVV-010: root config governs verify_jwt for ' + functionName, async () => {
    const { resolveVerifyJwt } = await load();
    const resolved = resolveVerifyJwt({ manifestEntry: null, candidateRoot: ROOT, functionName });
    assert.equal(resolved.verifyJwt, expected);
    assert.equal(resolved.source, 'root-config.toml');
  });
}

test('SVV-010: an explicit manifest entry still outranks root config', async () => {
  const { resolveVerifyJwt } = await load();
  const resolved = resolveVerifyJwt({
    manifestEntry: { verifyJwt: true },
    candidateRoot: ROOT,
    functionName: 'scan-identify',
  });
  assert.equal(resolved.verifyJwt, true);
  assert.equal(resolved.source, 'manifest/root-config');
});

test('SVV-010: the per-function fallback still resolves staging-health', async () => {
  const { resolveVerifyJwt } = await load();
  const rootToml = fs.readFileSync(path.join(ROOT, 'supabase', 'config.toml'), 'utf8');
  assert.equal(
    rootToml.includes('[functions.staging-health]'),
    false,
    'staging-health must stay out of root config for this fallback to be meaningful',
  );
  const resolved = resolveVerifyJwt({ manifestEntry: null, candidateRoot: ROOT, functionName: 'staging-health' });
  assert.equal(resolved.verifyJwt, false);
  assert.equal(resolved.source, 'function-config.toml');
});

test('SVV-010: an undeclared function fails closed with VERIFY_JWT_UNRESOLVED', async () => {
  const { resolveVerifyJwt } = await load();
  assert.throws(
    () => resolveVerifyJwt({ manifestEntry: null, candidateRoot: ROOT, functionName: 'not-a-governed-function' }),
    (err) => err.code === 'VERIFY_JWT_UNRESOLVED',
  );
});

test('SVV-010: a neighbouring table is never read as this function posture', async () => {
  const { resolveVerifyJwt } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-cfg-'));
  fs.mkdirSync(path.join(dir, 'supabase'), { recursive: true });
  const toml = [
    '[functions.alpha]',
    'import_map = "./map.json"',
    '',
    '[functions.beta]',
    'verify_jwt = true',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'supabase', 'config.toml'), toml, 'utf8');

  assert.throws(
    () => resolveVerifyJwt({ manifestEntry: null, candidateRoot: dir, functionName: 'alpha' }),
    (err) => err.code === 'VERIFY_JWT_UNRESOLVED',
    'alpha declares no posture and must not inherit beta',
  );
  const beta = resolveVerifyJwt({ manifestEntry: null, candidateRoot: dir, functionName: 'beta' });
  assert.equal(beta.verifyJwt, true);
});

test('SVV-010: a missing root config does not become a permissive default', async () => {
  const { resolveVerifyJwt } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-nocfg-'));
  assert.throws(
    () => resolveVerifyJwt({ manifestEntry: null, candidateRoot: dir, functionName: 'scan-identify' }),
    (err) => err.code === 'VERIFY_JWT_UNRESOLVED',
  );
});

test('SVV-010: the deploy command still refuses a non-boolean posture', async () => {
  const { buildDeployArgs } = await load();
  const bad = [undefined, null, 'true', 1];
  for (const value of bad) {
    assert.throws(
      () => buildDeployArgs({ functionName: 'scan-identify', projectRef: 'yzqjvdfgefveprobvvyw', verifyJwt: value }),
      (err) => err.code === 'VERIFY_JWT_UNRESOLVED',
    );
  }
  const args = buildDeployArgs({ functionName: 'scan-identify', projectRef: 'yzqjvdfgefveprobvvyw', verifyJwt: false });
  assert.ok(args.includes('--no-verify-jwt'));
});

test('SVV-010: the controlled deploy cross-checks EXPECTED_VERIFY_JWT', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy-staging-function.mjs'), 'utf8');
  assert.match(src, /resolveVerifyJwt\(\{/);
  assert.match(src, /governed\.verifyJwt !== verifyJwt/);
  assert.match(src, /contradicts governed configuration/);
});

test('SVV-010: production remains rejected by environment authority', async () => {
  const helpersUrl = pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'staging-helpers.mjs')).href;
  const helpers = await import(helpersUrl);
  assert.equal(helpers.PRODUCTION_PROJECT_REF, 'wyyuqfdxucjksghsmhry');
  assert.equal(helpers.STAGING_PROJECT_REF, 'yzqjvdfgefveprobvvyw');
  assert.throws(() => helpers.assertStagingTarget({
    projectRef: helpers.PRODUCTION_PROJECT_REF,
    url: 'https://' + helpers.PRODUCTION_PROJECT_REF + '.supabase.co',
    anonKey: 'sb_publishable_test_key_value',
  }));
});

test('SVV-010: quarantined and heritage functions stay outside the release set', () => {
  const governancePath = path.join(ROOT, 'security', 'release', 'edge-function-governance.json');
  const governance = JSON.parse(fs.readFileSync(governancePath, 'utf8'));
  assert.equal(governance.functions['product-match'].class, 'QUARANTINED');
  assert.equal(governance.functions['privacy-controls'].class, 'HERITAGE_UNMANAGED');
  assert.equal(governance.functions['public-sale-share-opt-out'].class, 'HERITAGE_UNMANAGED');

  const governed = Object.keys(governance.functions).filter(
    (name) => governance.functions[name].class === 'GOVERNED',
  );
  assert.equal(governed.length, 19, 'the governed set must remain exactly 19');
  const forbidden = ['product-match', 'privacy-controls', 'public-sale-share-opt-out'];
  for (const name of forbidden) {
    assert.ok(!governed.includes(name), name + ' must never be governed');
  }
});

test('SVV-010: every governed function now resolves a posture', async () => {
  const { resolveVerifyJwt } = await load();
  const governancePath = path.join(ROOT, 'security', 'release', 'edge-function-governance.json');
  const governance = JSON.parse(fs.readFileSync(governancePath, 'utf8'));
  const unresolved = [];
  for (const name of Object.keys(governance.functions)) {
    if (governance.functions[name].class !== 'GOVERNED') continue;
    try {
      resolveVerifyJwt({ manifestEntry: null, candidateRoot: ROOT, functionName: name });
    } catch (err) {
      unresolved.push(name);
    }
  }
  assert.deepEqual(unresolved, [], 'no governed function may be undeployable for want of a declared posture');
});
