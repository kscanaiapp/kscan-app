/**
 * Hostile tests for EXACT production Edge Function rollback (B34-BE-G2).
 *
 * The defect these close: deploy-production-function.mjs recorded only the
 * prior version number and bundle hash -- metadata, not bytes -- so when
 * rollback-production-function.mjs was handed a manifest with a prior_version
 * it had nothing to restore from and BOTH branches called fail(). Replacing any
 * existing production Edge Function was a one-way door.
 *
 * The dangerous failure mode for a rollback is not "it refuses". It is "it
 * reports success without restoring the original", so most of what follows
 * attacks the restore path with captures that are subtly wrong: another
 * function's bundle, another project's bundle, files whose bytes changed after
 * capture, an extra file nobody captured, a missing verify_jwt.
 *
 * Every test runs against temp-dir fixtures. Nothing here contacts production,
 * deploys anything, or requires credentials.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(ROOT, 'scripts', 'lib', 'function-bundle-capture.mjs');
const ROLLBACK = path.join(ROOT, 'scripts', 'rollback-production-function.mjs');
const CAPTURE = path.join(ROOT, 'scripts', 'capture-production-function.mjs');
const DEPLOY = path.join(ROOT, 'scripts', 'deploy-production-function.mjs');

const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';
const STAGING_REF = 'yzqjvdfgefveprobvvyw';

function pathToFileUrl(p) {
  const n = path.resolve(p).replace(/\\/g, '/');
  return n.startsWith('/') ? `file://${n}` : `file:///${n}`;
}
const loadLib = () => import(pathToFileUrl(LIB));

const EXPECTED = { productionRef: PRODUCTION_REF, stagingRef: STAGING_REF };

/**
 * Writes a realistic capture on disk and returns its manifest + root.
 * Mirrors exactly what capture-production-function.mjs produces.
 */
async function makeCapture({
  functionName = 'process-account-deletions',
  target = PRODUCTION_REF,
  verifyJwt = false,
  liveVersion = 25,
  files = { 'index.ts': 'export default () => new Response("live production bundle");\n' },
  mutateAfter = null,
} = {}) {
  const { buildCaptureManifest, digestTree } = await loadLib();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-cap-'));
  const filesDir = path.join(dir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(filesDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const { files: digested, treeDigest } = digestTree(filesDir);
  const capture = buildCaptureManifest({
    functionName,
    projectRef: target,
    liveVersion,
    verifyJwt,
    ezbrSha256: 'a2c20c459d8cbc08a0bacb04f4bc088a747e1f9a3b4846905cd61e58a0eab2a3',
    status: 'ACTIVE',
    files: digested,
    treeDigest,
  });
  fs.writeFileSync(path.join(dir, 'capture.json'), JSON.stringify(capture, null, 2));
  // Tamper AFTER the digest was taken, to simulate corruption in storage.
  if (mutateAfter) mutateAfter(filesDir);
  return { dir, captureRoot: filesDir, capture };
}

function manifestFor({
  functionName = 'process-account-deletions',
  priorVersion = 25,
  target = PRODUCTION_REF,
} = {}) {
  return {
    function_name: functionName,
    prior_version: priorVersion,
    prior_bundle_hash: 'a2c20c45',
    new_version: 26,
    new_source_commit: 'e10b79c5',
    target,
    verify_jwt: true,
    rollback_strategy: priorVersion ? 'restore_captured_bundle' : 'remove_or_disable_new_function',
  };
}

// ---------------------------------------------- 1, 7. the defect is repaired

test('7. the prior_version path no longer fails unconditionally', () => {
  const src = fs.readFileSync(ROLLBACK, 'utf8');

  // The exact strings of the old dead-end are gone.
  assert.doesNotMatch(src, /prior_version present but prior source is unavailable for exact redeploy/);
  assert.doesNotMatch(src, /production rollback does not redeploy from the current tree/);
  assert.match(src, /RESTORE_CAPTURED_BUNDLE/, 'there is now a real restore action');
  assert.match(src, /restoreCapturedBundle\(/);
});

test('1. a captured existing bundle can be restored', async () => {
  const { planRollback } = await loadLib();
  const { captureRoot, capture } = await makeCapture();

  const plan = planRollback({
    manifest: manifestFor(),
    capture,
    captureRoot,
    expected: EXPECTED,
  });

  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.action, 'RESTORE_CAPTURED_BUNDLE');
  assert.deepEqual(plan.files, ['index.ts']);
  assert.equal(plan.priorVersion, 25);
  assert.ok(plan.capturedAt, 'the plan carries when the bundle was captured');
});

test('1b. a multi-file bundle restores every captured file', async () => {
  const { planRollback } = await loadLib();
  const { captureRoot, capture } = await makeCapture({
    files: {
      'index.ts': 'export default handler;\n',
      'handler.ts': 'export const handler = () => new Response("ok");\n',
      '_shared/deletion/common.ts': 'export const COMMON = 1;\n',
      'config.toml': 'verify_jwt = false\n',
    },
  });

  const plan = planRollback({ manifest: manifestFor(), capture, captureRoot, expected: EXPECTED });
  assert.equal(plan.action, 'RESTORE_CAPTURED_BUNDLE');
  assert.deepEqual(
    plan.files.sort(),
    ['_shared/deletion/common.ts', 'config.toml', 'handler.ts', 'index.ts'],
    'nested files are captured and restored, not just index.ts',
  );
});

// ------------------------------------------------------ 2. verify_jwt

test('2. the ORIGINAL verify_jwt is restored, from the capture, not the manifest', async () => {
  const { planRollback, restoreDeployArgs } = await loadLib();

  // The live function authenticates its own callers (verify_jwt=false, as
  // scan-identify and process-account-deletions do). The failed deploy asked
  // for true. Rolling back must restore FALSE -- the capture's value -- because
  // the manifest records the posture being undone.
  const { captureRoot, capture } = await makeCapture({ verifyJwt: false });
  const manifest = manifestFor();
  assert.equal(manifest.verify_jwt, true, 'the failed deploy wanted verify_jwt=true');

  const plan = planRollback({ manifest, capture, captureRoot, expected: EXPECTED });
  assert.equal(plan.verifyJwt, false, 'restore uses the CAPTURED posture');

  const args = restoreDeployArgs({
    functionName: 'process-account-deletions',
    projectRef: PRODUCTION_REF,
    verifyJwt: plan.verifyJwt,
  });
  assert.ok(args.includes('--no-verify-jwt'), 'a verify_jwt=false function is redeployed with the flag');
  assert.ok(args.includes(PRODUCTION_REF));

  // And the inverse: a verify_jwt=true function must NOT get the flag.
  const jwtTrue = await makeCapture({ functionName: 'handle-user-deletion', verifyJwt: true });
  const plan2 = planRollback({
    manifest: manifestFor({ functionName: 'handle-user-deletion', priorVersion: 84 }),
    capture: jwtTrue.capture,
    captureRoot: jwtTrue.captureRoot,
    expected: EXPECTED,
  });
  assert.equal(plan2.verifyJwt, true);
  assert.ok(
    !restoreDeployArgs({ functionName: 'handle-user-deletion', projectRef: PRODUCTION_REF, verifyJwt: true })
      .includes('--no-verify-jwt'),
  );
});

test('2b. a capture with no boolean verify_jwt is refused', async () => {
  const { planRollback } = await loadLib();
  const { captureRoot, capture } = await makeCapture();
  delete capture.verify_jwt;

  const plan = planRollback({ manifest: manifestFor(), capture, captureRoot, expected: EXPECTED });
  assert.equal(plan.action, null);
  assert.ok(
    plan.blockers.some((b) => b.includes('original auth posture cannot be restored')),
    plan.blockers.join('\n'),
  );
});

test('2c. the restore verifies the live posture afterwards', () => {
  const src = fs.readFileSync(ROLLBACK, 'utf8');
  assert.match(src, /liveVerifyJwt\(fnName\)/);
  assert.match(
    src,
    /The original authentication posture was NOT restored/,
    'a restore that lands the wrong verify_jwt is a failure, not a warning',
  );
});

// --------------------------------------- 3, 4, 5, 6. the capture must fit

test('3. a capture for a DIFFERENT function is refused', async () => {
  const { planRollback } = await loadLib();
  const { captureRoot, capture } = await makeCapture({ functionName: 'handle-user-deletion' });

  const plan = planRollback({
    manifest: manifestFor({ functionName: 'process-account-deletions' }),
    capture,
    captureRoot,
    expected: EXPECTED,
  });

  assert.equal(plan.action, null, 'restoring another function’s bundle would overwrite a healthy function');
  assert.ok(plan.blockers.some((b) => b.includes('handle-user-deletion') && b.includes('process-account-deletions')));
});

test('4. a capture from a DIFFERENT project is refused, and staging especially', async () => {
  const { planRollback } = await loadLib();

  const foreign = await makeCapture({ target: 'zzzzzzzzzzzzzzzzzzzz' });
  const p1 = planRollback({ manifest: manifestFor(), capture: foreign.capture, captureRoot: foreign.captureRoot, expected: EXPECTED });
  assert.equal(p1.action, null);
  assert.ok(p1.blockers.some((b) => b.includes('not production')));

  const staging = await makeCapture({ target: STAGING_REF });
  const p2 = planRollback({ manifest: manifestFor(), capture: staging.capture, captureRoot: staging.captureRoot, expected: EXPECTED });
  assert.equal(p2.action, null);
  assert.ok(p2.blockers.some((b) => b.includes('staging')), p2.blockers.join('\n'));
});

test('5. a missing capture is refused, with an actionable message', async () => {
  const { planRollback } = await loadLib();

  const plan = planRollback({ manifest: manifestFor(), capture: null, captureRoot: null, expected: EXPECTED });
  assert.equal(plan.action, null);
  const msg = plan.blockers.join('\n');
  assert.ok(msg.includes('no captured production bundle was supplied'));
  assert.ok(msg.includes('capture-production-function.mjs'), 'it says how to get one');
  assert.ok(msg.includes('never a substitute'), 'it says the git tree will not be used');

  // A capture path that does not exist is a hard error too.
  const src = fs.readFileSync(ROLLBACK, 'utf8');
  assert.match(src, /Capture manifest not found/);
  assert.match(src, /Capture manifest is unparseable/);
});

test('6. a corrupted or integrity-mismatched bundle is refused', async () => {
  const { planRollback } = await loadLib();

  // Bytes changed after capture.
  const tampered = await makeCapture({
    mutateAfter: (dir) => fs.writeFileSync(path.join(dir, 'index.ts'), 'export default () => new Response("EVIL");\n'),
  });
  const p1 = planRollback({ manifest: manifestFor(), capture: tampered.capture, captureRoot: tampered.captureRoot, expected: EXPECTED });
  assert.equal(p1.action, null);
  assert.ok(p1.blockers.some((b) => b.includes('fails its integrity check')), p1.blockers.join('\n'));

  // A captured file deleted from disk.
  const missing = await makeCapture({ mutateAfter: (dir) => fs.rmSync(path.join(dir, 'index.ts')) });
  const p2 = planRollback({ manifest: manifestFor(), capture: missing.capture, captureRoot: missing.captureRoot, expected: EXPECTED });
  assert.equal(p2.action, null);
  assert.ok(p2.blockers.some((b) => b.includes('missing from disk')));

  // An EXTRA file nobody captured would be deployed along with the restore.
  const extra = await makeCapture({
    mutateAfter: (dir) => fs.writeFileSync(path.join(dir, 'smuggled.ts'), 'export const x = 1;\n'),
  });
  const p3 = planRollback({ manifest: manifestFor(), capture: extra.capture, captureRoot: extra.captureRoot, expected: EXPECTED });
  assert.equal(p3.action, null);
  assert.ok(p3.blockers.some((b) => b.includes('undeclared file')), p3.blockers.join('\n'));

  // A tree digest that does not match its own files.
  const forged = await makeCapture();
  forged.capture.tree_digest = crypto.createHash('sha256').update('not the real digest').digest('hex');
  const p4 = planRollback({ manifest: manifestFor(), capture: forged.capture, captureRoot: forged.captureRoot, expected: EXPECTED });
  assert.equal(p4.action, null);
  assert.ok(p4.blockers.some((b) => b.includes('tree digest mismatch')));

  // An empty capture restores nothing and must not be treated as success.
  const empty = await makeCapture();
  empty.capture.files = [];
  empty.capture.file_count = 0;
  const p5 = planRollback({ manifest: manifestFor(), capture: empty.capture, captureRoot: empty.captureRoot, expected: EXPECTED });
  assert.equal(p5.action, null);
  assert.ok(p5.blockers.some((b) => b.includes('nothing to restore')));

  // A path trying to escape the capture directory.
  const escaping = await makeCapture();
  escaping.capture.files = [{ path: '../../etc/passwd', sha256: 'x'.repeat(64), bytes: 1 }];
  escaping.capture.file_count = 1;
  const p6 = planRollback({ manifest: manifestFor(), capture: escaping.capture, captureRoot: escaping.captureRoot, expected: EXPECTED });
  assert.equal(p6.action, null);
  assert.ok(p6.blockers.some((b) => b.includes('escapes the capture directory')));
});

// ------------------------------------------------- 8. new functions unchanged

test('8. new-function rollback still deletes, and needs no capture', async () => {
  const { planRollback } = await loadLib();

  // A new function is one the deployment manifest records no prior_version for,
  // whether that is an explicit null or the key being absent entirely.
  const newFunctionManifests = [
    { function_name: 'deletion-status', target: PRODUCTION_REF, prior_version: null },
    { function_name: 'deletion-status', target: PRODUCTION_REF },
  ];
  for (const manifest of newFunctionManifests) {
    const plan = planRollback({ manifest, capture: null, captureRoot: null, expected: EXPECTED });
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.action, 'DELETE_NEW_FUNCTION', 'a function that did not exist rolls back by deletion');
  }

  const src = fs.readFileSync(ROLLBACK, 'utf8');
  assert.match(src, /functions', 'delete', fnName/, 'the delete path survives');
  assert.match(src, /deleted_new_function/);
});

// ------------------------------------------------------ 9. staging refusal

test('9. no staging target is accepted, from the manifest either', async () => {
  const { planRollback } = await loadLib();
  const { captureRoot, capture } = await makeCapture();

  const plan = planRollback({
    manifest: manifestFor({ target: STAGING_REF }),
    capture,
    captureRoot,
    expected: EXPECTED,
  });
  assert.equal(plan.action, null);
  assert.ok(plan.blockers.some((b) => b.includes('staging')));

  // The CLI guard is still in place for anything that slips through data.
  const helpers = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'production-helpers.mjs'), 'utf8');
  assert.match(helpers, /assertNoStagingRef/);
  const src = fs.readFileSync(ROLLBACK, 'utf8');
  assert.match(src, /STAGING_PROJECT_REF/);
});

// --------------------------------- 10. never silently fall back to git source

test('10. rollback can never silently fall back to the current git source', async () => {
  const { planRollback } = await loadLib();
  const src = fs.readFileSync(ROLLBACK, 'utf8');

  // The restore copies from the CAPTURE ROOT and nowhere else.
  assert.match(src, /fs\.copyFileSync\(path\.join\(captureRoot, rel\), dest\)/);

  // It never reads the repository's own function source.
  assert.doesNotMatch(
    src,
    /path\.join\('supabase', 'functions', fnName/,
    'the repo tree is never a restore source',
  );

  // With a prior_version and no capture, the only outcome is refusal — there is
  // no branch that proceeds using whatever happens to be checked out.
  const plan = planRollback({ manifest: manifestFor(), capture: null, captureRoot: null, expected: EXPECTED });
  assert.equal(plan.action, null);
  assert.equal(plan.files, undefined, 'no files are offered for restore without a capture');

  // The intent is stated where the next maintainer will read it.
  const lib = fs.readFileSync(LIB, 'utf8');
  assert.match(lib, /never a substitute/i);
  assert.match(
    lib.replace(/\n \* /g, ' '),
    /no-op dressed as a recovery/i,
    'the reason the git tree is not a fallback is written down',
  );
});

// --------------------------------------------- capture + pre-deploy plumbing

test('the capture writes bytes, digests and metadata, in an isolated directory', () => {
  const src = fs.readFileSync(CAPTURE, 'utf8');

  assert.match(src, /'functions', 'download', functionName/, 'it downloads the live bundle');
  assert.match(src, /mkdtempSync/, 'it downloads into a scratch directory');
  assert.match(
    src.replace(/\n \* /g, ' '),
    /pointing it at the repo would overwrite the governed source/,
    'the reason for the scratch directory is recorded',
  );
  assert.match(src, /verifyJwt: live\.verify_jwt === true/, 'the live verify_jwt is captured');
  assert.match(src, /ezbrSha256: live\.ezbr_sha256/, 'the CLI-reported digest is captured');
  assert.match(src, /liveVersion: live\.version/, 'the live version is captured');
  assert.match(src, /Refusing to record an empty capture/);
  assert.match(src, /Capture failed its own verification/, 'the capture verifies what it just wrote');
});

test('an existing function cannot be replaced without a capture', () => {
  const src = fs.readFileSync(DEPLOY, 'utf8');

  assert.match(src, /AD-PRE-001/, 'the gate is named');
  assert.match(src, /capture-production-function\.mjs/, 'the deploy invokes the capture');
  assert.match(
    src,
    /Refusing to replace an existing production function without exact rollback material/,
  );
  assert.match(src, /capture_path: capturePath/, 'the manifest carries the capture path');
  assert.match(src, /rollback_strategy: priorVersion \? 'restore_captured_bundle'/);

  // The capture runs only for an EXISTING function, and BEFORE the deploy.
  assert.ok(src.indexOf('if (prior) {') < src.indexOf('runSupabaseProduction(deployArgs)'));

  // Automatic rollback carries the capture through.
  assert.match(src, /\.\.\.\(capturePath \? \['--capture', capturePath\] : \[\]\)/);
});

test('the chain is capture -> verify -> deploy -> validate -> restore -> validate', () => {
  const deploy = fs.readFileSync(DEPLOY, 'utf8');
  const rollback = fs.readFileSync(ROLLBACK, 'utf8');

  const order = [
    deploy.indexOf('capture-production-function.mjs'),
    deploy.indexOf('runSupabaseProduction(deployArgs)'),
    deploy.indexOf('await shallowHealthCheck(fnName'),
    deploy.indexOf('rollback-production-function.mjs'),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the deploy runs the chain in order');
  for (const i of order) assert.ok(i > -1, 'every link in the chain is present');

  // And the restore validates afterwards rather than assuming.
  assert.ok(
    rollback.indexOf('restoreCapturedBundle(') < rollback.indexOf('liveVerifyJwt(fnName)'),
    'the posture check happens after the restore',
  );
  assert.match(rollback, /shallowCheck\(fnName\)/);
  assert.match(rollback, /authNegativeCheck\(fnName\)/);
});

test('importing the rollback script does not roll anything back', async () => {
  // It used to call main() at import time, which made it untestable and made an
  // accidental import a production action.
  const mod = await import(pathToFileUrl(ROLLBACK));
  assert.ok(typeof mod.loadCapture === 'function');
  const src = fs.readFileSync(ROLLBACK, 'utf8');
  assert.match(src, /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
});
