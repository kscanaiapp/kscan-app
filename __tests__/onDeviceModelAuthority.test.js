// ON-DEVICE MODEL AUTHORITY — negative controls.
//
// The gate replaced a blanket "no model asset may exist anywhere" rule with a
// byte-bound allowlist (config/on-device-model-authority.json). A permissive
// allowlist is worse than the prohibition it replaced, so these controls exist
// to prove the replacement cannot be bypassed. Each asserts a specific bypass
// FAILS; the positive case (the real repository passes) is asserted by
// __tests__/mirrorExtractionContainment.test.js.
//
// Everything below runs against SYNTHETIC fixtures through the pure
// `auditModelAssets` core — proving a rogue model is rejected never requires
// actually committing one, and these controls cannot leave debris in the tree.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  AUTHORITY_PATH,
  auditModelAssets,
  auditRepository,
  isModelAsset,
} = require('../scripts/check-on-device-model-authority');

const ROOT = path.resolve(__dirname, '..');
const REAL_AUTHORITY = JSON.parse(fs.readFileSync(path.join(ROOT, AUTHORITY_PATH), 'utf8'));

const APPROVED_PATH = 'modules/kscan-live-vto-native/android/src/main/assets/models/pose_landmarker_lite.task';
const APPROVED_SHA = '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a';
// iOS Live VTO native-runtime catch-up: the same governed model, bundled a
// second time for the iOS module. Byte-identical, so it shares APPROVED_SHA
// rather than needing its own constant. baseline() clones REAL_AUTHORITY
// (which now carries both records), so its trackedFiles/hashOf must cover
// both paths or the clone is internally inconsistent -- exactly the failure
// mode "the baseline fixture must pass" exists to catch.
const APPROVED_PATH_IOS = 'modules/kscan-live-vto-native/ios/Assets/models/pose_landmarker_lite.task';

/** A minimal, valid world: the approved models, present, byte-identical. */
function baseline() {
  return {
    trackedFiles: ['package.json', APPROVED_PATH, APPROVED_PATH_IOS],
    authority: JSON.parse(JSON.stringify(REAL_AUTHORITY)),
    hashOf: (rel) => ((rel === APPROVED_PATH || rel === APPROVED_PATH_IOS) ? APPROVED_SHA : 'x'.repeat(64)),
  };
}

function audit(world) {
  return auditModelAssets(world);
}

// ── the fixture itself must be clean, or every control below is vacuous ─────

test('SELF-CHECK: the baseline fixture passes, so each control below fails for its own reason', () => {
  assert.deepEqual(audit(baseline()), []);
});

test('the real repository passes the same auditor the controls exercise', () => {
  assert.deepEqual(auditRepository(ROOT), []);
});

// ── NC-1: an unregistered second model ──────────────────────────────────────

test('NC-1: an unregistered model asset fails', () => {
  const world = baseline();
  world.trackedFiles.push('modules/kscan-live-vto-native/android/src/main/assets/models/rogue.tflite');
  const violations = audit(world);
  assert.ok(
    violations.some((v) => v.includes('rogue.tflite') && v.includes('no authority record')),
    `expected an unregistered-model violation, got: ${JSON.stringify(violations)}`,
  );
});

test('NC-1b: every governed model extension is detected, not just .task', () => {
  // The superseded blanket rule covered seven formats. A repair that quietly
  // narrowed detection to the one format Live VTO happens to use would be a
  // weakening disguised as a fix.
  for (const ext of REAL_AUTHORITY.policy.modelAssetExtensions) {
    const world = baseline();
    const rogue = `modules/kscan-live-vto-native/android/src/main/assets/models/rogue.${ext}`;
    world.trackedFiles.push(rogue);
    const violations = audit(world);
    assert.ok(
      violations.some((v) => v.includes(rogue)),
      `a rogue .${ext} model was not detected`,
    );
  }
  assert.ok(REAL_AUTHORITY.policy.modelAssetExtensions.length >= 7, 'the governed extension list was narrowed');
});

// ── NC-2: mutated bytes / checksum mismatch ─────────────────────────────────

test('NC-2: an approved model whose bytes changed fails', () => {
  const world = baseline();
  world.hashOf = () => 'a'.repeat(64); // one byte changed => a different digest
  const violations = audit(world);
  assert.ok(
    violations.some((v) => v.includes(APPROVED_PATH) && v.includes('bytes changed')),
    `expected a checksum-mismatch violation, got: ${JSON.stringify(violations)}`,
  );
});

test('NC-2b: a malformed checksum is rejected rather than silently never matching', () => {
  // A truncated digest (63 chars) is the realistic version of this mistake --
  // it can never equal a real digest, so without this check the entry would
  // deny forever and look like a byte mismatch instead of a bad record.
  const world = baseline();
  world.authority.approvedModels[0].sha256 = APPROVED_SHA.slice(0, 63);
  const violations = audit(world);
  assert.ok(
    violations.some((v) => v.includes('64 lowercase hex')),
    `expected a malformed-checksum violation, got: ${JSON.stringify(violations)}`,
  );
});

// ── NC-3: the approved path moved ───────────────────────────────────────────

test('NC-3: the same approved model at a different path fails', () => {
  const world = baseline();
  const moved = 'modules/kscan-live-vto-native/android/src/main/assets/pose_landmarker_lite.task';
  world.trackedFiles = ['package.json', moved];
  world.hashOf = () => APPROVED_SHA; // identical bytes, different location
  const violations = audit(world);
  assert.ok(
    violations.some((v) => v.includes(moved) && v.includes('no authority record')),
    `a relocated model must not inherit approval, got: ${JSON.stringify(violations)}`,
  );
  assert.ok(
    violations.some((v) => v.includes('not tracked in the repository')),
    'the now-dangling authority record must also be reported',
  );
});

test('NC-3b: an approved model copied to a second path fails at the copy', () => {
  const world = baseline();
  const copy = 'assets/pose_landmarker_lite.task';
  world.trackedFiles.push(copy);
  world.hashOf = () => APPROVED_SHA; // a byte-identical duplicate
  const violations = audit(world);
  assert.ok(
    violations.some((v) => v.includes(copy) && v.includes('no authority record')),
    `a duplicate copy must fail even with identical bytes, got: ${JSON.stringify(violations)}`,
  );
});

// ── NC-4: wildcard / broad approval ─────────────────────────────────────────

test('NC-4: a wildcard approval is rejected', () => {
  for (const glob of [
    'modules/kscan-live-vto-native/**/*.task',
    'modules/kscan-live-vto-native/android/src/main/assets/models/*',
    'modules/**',
  ]) {
    const world = baseline();
    world.authority.approvedModels[0].path = glob;
    const violations = audit(world);
    assert.ok(
      violations.some((v) => v.includes('wildcard')),
      `wildcard approval "${glob}" was accepted`,
    );
  }
});

test('NC-4b: the policy cannot declare wildcards allowed', () => {
  const world = baseline();
  world.authority.policy.wildcardsAllowed = true;
  const violations = audit(world);
  assert.ok(violations.some((v) => v.includes('wildcardsAllowed must be false')));
});

test('NC-4c: the policy cannot flip its default posture to allow', () => {
  const world = baseline();
  world.authority.policy.defaultPosture = 'ALLOW';
  const violations = audit(world);
  assert.ok(violations.some((v) => v.includes('defaultPosture must be "DENY"')));
});

// ── NC-5: authority record removed, model kept ──────────────────────────────

test('NC-5: removing the authority record while keeping the model fails', () => {
  const world = baseline();
  world.authority.approvedModels = [];
  const violations = audit(world);
  assert.ok(
    violations.some((v) => v.includes(APPROVED_PATH) && v.includes('no authority record')),
    `expected the model to lose approval, got: ${JSON.stringify(violations)}`,
  );
});

test('NC-5b: an empty or missing extension list fails closed, not open', () => {
  // If the gate cannot tell what a model asset is, it must refuse — otherwise
  // deleting one policy line would silently disable the whole check.
  for (const mutate of [
    (a) => { a.policy.modelAssetExtensions = []; },
    (a) => { delete a.policy.modelAssetExtensions; },
    (a) => { delete a.policy; },
  ]) {
    const world = baseline();
    mutate(world.authority);
    const violations = audit(world);
    assert.ok(violations.length > 0, 'a gutted policy must fail closed');
  }
});

// ── NC-6: model removed, authority record kept ──────────────────────────────

test('NC-6: an authority record pointing at a missing file fails', () => {
  const world = baseline();
  world.trackedFiles = ['package.json']; // model deleted, record left behind
  const violations = audit(world);
  assert.ok(
    violations.some((v) => v.includes('not tracked in the repository')),
    `expected a dangling-record violation, got: ${JSON.stringify(violations)}`,
  );
});

// ── the Mirror containment contract is now categorical, not incidental ──────

test('NC-7: a model asset inside a model-free module fails even WITH an authority record', () => {
  // The strengthening this repair adds. `modules/kscan-pii-native` must use an
  // OS-resident runtime; under the superseded blanket rule that was protected
  // only because everything was banned. Here the registry itself cannot
  // authorize it.
  const rogue = 'modules/kscan-pii-native/android/src/main/assets/pose.tflite';
  const world = baseline();
  world.trackedFiles.push(rogue);
  world.authority.approvedModels.push({
    ...REAL_AUTHORITY.approvedModels[0],
    id: 'attempted-mirror-model',
    path: rogue,
    sha256: 'b'.repeat(64),
  });
  world.hashOf = (rel) => (rel === rogue ? 'b'.repeat(64) : APPROVED_SHA);

  const violations = audit(world);
  assert.ok(
    violations.some((v) => v.includes(rogue) && v.includes('model-free module')),
    `a model-free module must reject the asset itself, got: ${JSON.stringify(violations)}`,
  );
  assert.ok(
    violations.some((v) => v.includes('attempted-mirror-model') && v.includes('model-free module')),
    'the authority record attempting the authorization must also be rejected',
  );
});

test('NC-7b: the Mirror module is still declared model-free', () => {
  assert.ok(
    REAL_AUTHORITY.policy.modelFreeModules.includes('modules/kscan-pii-native'),
    'removing the Mirror module from modelFreeModules would silently undo the containment contract',
  );
});

// ── the on-device invariants cannot be relaxed through the registry ─────────

test('NC-8: an approved model may not declare runtime download or cloud inference', () => {
  for (const [field, value] of [
    ['runtimeDownload', true],
    ['networkInference', true],
    ['execution', 'cloud'],
  ]) {
    const world = baseline();
    world.authority.approvedModels[0][field] = value;
    const violations = audit(world);
    assert.ok(
      violations.some((v) => v.includes(field)),
      `${field}=${JSON.stringify(value)} was accepted`,
    );
  }
});

test('NC-9: an unapproved status does not authorize the asset', () => {
  for (const status of ['pending', 'revoked', 'draft', undefined]) {
    const world = baseline();
    world.authority.approvedModels[0].status = status;
    const violations = audit(world);
    assert.ok(violations.some((v) => v.includes('status must be "approved"')), `status ${status} was accepted`);
  }
});

test('NC-10: provenance fields are mandatory, so an anonymous model cannot be approved', () => {
  for (const field of ['id', 'provider', 'model', 'purpose', 'frameworkLicense', 'modelLicense']) {
    const world = baseline();
    delete world.authority.approvedModels[0][field];
    const violations = audit(world);
    assert.ok(
      violations.some((v) => v.includes(`"${field}"`)),
      `a record missing ${field} was accepted`,
    );
  }
});

test('NC-11: two records cannot claim the same path', () => {
  const world = baseline();
  world.authority.approvedModels.push({ ...REAL_AUTHORITY.approvedModels[0], id: 'duplicate-entry' });
  const violations = audit(world);
  assert.ok(violations.some((v) => v.includes('duplicate authority record')));
});

// ── detection helper ────────────────────────────────────────────────────────

test('extension matching is case-insensitive and anchored to the real extension', () => {
  const ext = REAL_AUTHORITY.policy.modelAssetExtensions;
  assert.ok(isModelAsset('a/b/model.TFLITE', ext), 'uppercase extensions must still be detected');
  assert.ok(isModelAsset('a/b/model.task', ext));
  assert.ok(!isModelAsset('a/b/task', ext), 'a file merely named like an extension is not a model');
  assert.ok(!isModelAsset('a/b/model.task.txt', ext), 'only the real trailing extension counts');
});
