const test = require('node:test');
const assert = require('node:assert/strict');

const { loadEngine, loadPackages } = require('./fixtures/avatarEngineHarness');

const { validateAvatarPackage, deriveCapabilitiesFromPackage } = loadEngine();
const { buildAvatarPackage, resolveAvatarPackage, resetAvatarPackageCacheForTests } = loadPackages();

const SARAH = 'stylist_portrait_05';
const ELISE = 'stylist_portrait_02';

function approved(key) {
  return { key, approval: 'approved' };
}

/** A minimal valid package skeleton; tests attach only the channels they exercise. */
function basePackage(overrides = {}) {
  return {
    packageVersion: 1,
    identity: { avatarId: SARAH, stylistId: SARAH, visualPackageVersion: 1 },
    base: approved('base'),
    registration: { requireUniformOverlayDimensions: true },
    compositing: { mode: 'rigid-overlay', overlayDrawsFullFrame: true },
    fallback: { onMissingMouth: 'static', onMissingEyes: 'static', onMissingBrows: 'static' },
    ...overrides,
  };
}

const MOUTH_REGION = { x: 0.42, y: 0.45, width: 0.17, height: 0.1 };
const MOUTH_ANCHOR = { x: 0.505, y: 0.5 };

function mouthChannel(extra = {}) {
  return {
    region: MOUTH_REGION,
    anchor: MOUTH_ANCHOR,
    closed: approved('closed'),
    halfOpen: approved('halfOpen'),
    open: approved('open'),
    ...extra,
  };
}

// -- Core validation ----------------------------------------------------------

test('a mouth-only package is valid and reports basic lip sync without brows', () => {
  // This is exactly Sarah's shape and the case the first integration depends on.
  const result = validateAvatarPackage(basePackage({ mouth: mouthChannel() }));

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.capabilities, {
    basicLipSync: true,
    roundLipSync: false,
    blink: false,
    brows: false,
    expression: false,
    gaze: false,
  });
  assert.equal(result.assetCapabilities.mouthClosed, true);
  assert.equal(result.assetCapabilities.mouthRound, false);
  assert.equal(result.assetCapabilities.eyes, false);
});

test('a missing optional eye asset does not invalidate a usable mouth package', () => {
  const result = validateAvatarPackage(
    basePackage({
      mouth: mouthChannel(),
      eyes: {
        region: { x: 0.3, y: 0.3, width: 0.4, height: 0.1 },
        anchor: { x: 0.5, y: 0.35 },
        open: approved('eyesOpen'),
        half: approved('eyesHalf'),
        // `closed` is absent — an incomplete blink set.
      },
    }),
  );

  assert.equal(result.valid, true, 'an incomplete optional channel is a warning, not an error');
  assert.equal(result.capabilities.basicLipSync, true);
  assert.equal(result.capabilities.blink, false);
  assert.ok(result.warnings.some((issue) => issue.code === 'eyes-incomplete'));
});

test('a richer package reports round lip sync, blink, brows, expression and gaze', () => {
  const result = validateAvatarPackage(
    basePackage({
      identity: { avatarId: ELISE, stylistId: ELISE, visualPackageVersion: 1 },
      mouth: mouthChannel({ round: approved('round') }),
      eyes: {
        region: { x: 0.3, y: 0.3, width: 0.4, height: 0.1 },
        anchor: { x: 0.5, y: 0.35 },
        open: approved('eyesOpen'),
        half: approved('eyesHalf'),
        closed: approved('eyesClosed'),
      },
      brows: {
        region: { x: 0.3, y: 0.24, width: 0.4, height: 0.08 },
        anchor: { x: 0.5, y: 0.28 },
        neutral: approved('brows'),
        raised: approved('browsRaised'),
        focused: approved('focused'),
      },
    }),
  );

  assert.equal(result.valid, true);
  assert.deepEqual(result.capabilities, {
    basicLipSync: true,
    roundLipSync: true,
    blink: true,
    brows: true,
    expression: true,
    gaze: true,
  });
});

test('a package with no approved closed mouth disables the whole mouth channel', () => {
  const result = validateAvatarPackage(
    basePackage({
      mouth: {
        region: MOUTH_REGION,
        anchor: MOUTH_ANCHOR,
        closed: { key: 'closed', approval: 'reference' },
        halfOpen: approved('halfOpen'),
        open: approved('open'),
      },
    }),
  );

  assert.equal(result.valid, true);
  assert.equal(result.capabilities.basicLipSync, false);
  assert.equal(result.assetCapabilities.mouthOpen, false, 'no neutral state to return to');
  assert.ok(result.warnings.some((issue) => issue.code === 'mouth-incomplete'));
});

test('reference-grade artwork never enables a capability', () => {
  const result = validateAvatarPackage(
    basePackage({
      mouth: {
        region: MOUTH_REGION,
        anchor: MOUTH_ANCHOR,
        closed: approved('closed'),
        halfOpen: { key: 'halfOpen', approval: 'reference' },
        open: { key: 'open', approval: 'reference' },
      },
    }),
  );
  assert.equal(result.capabilities.basicLipSync, false);
});

// -- Fail closed --------------------------------------------------------------

test('an invalid required asset fails the package closed', () => {
  const result = validateAvatarPackage(basePackage({ base: { key: 'base', approval: 'missing' } }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((issue) => issue.code === 'base-not-approved'));
  assert.equal(result.capabilities.basicLipSync, false);
  assert.equal(result.assetCapabilities.mouthClosed, false);
  assert.equal(result.assetCapabilities.compositeMotion, false);
});

test('an unsupported package version, identity, compositing or fallback fails closed', () => {
  const cases = [
    [basePackage({ packageVersion: 99 }), 'package-version-unsupported'],
    [basePackage({ identity: { avatarId: '', stylistId: '', visualPackageVersion: 0 } }), 'identity-missing'],
    [basePackage({ compositing: { mode: 'mesh-warp', overlayDrawsFullFrame: true } }), 'compositing-unsupported'],
    [basePackage({ fallback: { onMissingMouth: 'animate', onMissingEyes: 'static', onMissingBrows: 'static' } }), 'fallback-policy-invalid'],
  ];
  for (const [pkg, code] of cases) {
    const result = validateAvatarPackage(pkg);
    assert.equal(result.valid, false, `${code} must invalidate the package`);
    assert.ok(result.errors.some((issue) => issue.code === code));
  }
});

test('a region outside the normalized frame is an error', () => {
  const result = validateAvatarPackage(
    basePackage({ mouth: { ...mouthChannel(), region: { x: 0.9, y: 0.9, width: 0.5, height: 0.5 } } }),
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((issue) => issue.code === 'region-invalid'));
});

test('declared dimensions that disagree with the base are fatal for that channel', () => {
  const result = validateAvatarPackage(
    basePackage({
      base: { key: 'base', approval: 'approved', widthPx: 1024, heightPx: 1024 },
      mouth: {
        region: MOUTH_REGION,
        anchor: MOUTH_ANCHOR,
        closed: { key: 'closed', approval: 'approved', widthPx: 1024, heightPx: 1024 },
        halfOpen: { key: 'halfOpen', approval: 'approved', widthPx: 2048, heightPx: 2048 },
        open: { key: 'open', approval: 'approved', widthPx: 1024, heightPx: 1024 },
      },
    }),
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((issue) => issue.code === 'dimensions-mismatch'));
});

test('undeclared dimensions warn but do not disqualify', () => {
  const result = validateAvatarPackage(basePackage({ mouth: mouthChannel() }));
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((issue) => issue.code === 'dimensions-unverified'));
});

test('validation never trusts a declared capability', () => {
  const result = validateAvatarPackage(
    basePackage({ declaredCapabilities: { eyes: true, brows: true, mouthRound: true } }),
  );
  assert.equal(result.assetCapabilities.eyes, false);
  assert.equal(result.assetCapabilities.brows, false);
  assert.equal(result.assetCapabilities.mouthRound, false);
  assert.equal(result.warnings.filter((issue) => issue.code === 'capability-overdeclared').length, 3);
});

test('a garbage package yields the static capability set instead of throwing', () => {
  for (const bad of [null, undefined, 42, 'nonsense', {}, []]) {
    const capabilities = deriveCapabilitiesFromPackage(bad);
    assert.equal(capabilities.mouthClosed, false);
    assert.equal(capabilities.eyes, false);
    assert.equal(capabilities.compositeMotion, false);
  }
});

test('validation reports no personal or identifying data', () => {
  const result = validateAvatarPackage(basePackage({ mouth: mouthChannel() }));
  for (const issue of [...result.errors, ...result.warnings]) {
    assert.ok(['package', 'base', 'mouth', 'eyes', 'brows'].includes(issue.channel));
    assert.equal(typeof issue.code, 'string');
    assert.equal(typeof issue.detail, 'string');
  }
});

// -- Against the real K Scan registry -----------------------------------------

test('the real Sarah registry entry validates as a mouth-only package', () => {
  resetAvatarPackageCacheForTests();
  const resolution = resolveAvatarPackage(SARAH);

  assert.ok(resolution.package, 'Sarah must resolve to a package');
  assert.equal(resolution.validation.valid, true);
  assert.equal(resolution.validation.capabilities.basicLipSync, true);
  assert.equal(
    resolution.validation.capabilities.roundLipSync,
    false,
    'Sarah ships no round mouth artwork',
  );
  assert.equal(resolution.validation.capabilities.blink, false);
  assert.equal(resolution.validation.capabilities.brows, false);
});

test('the real Elise registry entry adds round lip sync but still no calibrated eyes or brows', () => {
  resetAvatarPackageCacheForTests();
  const resolution = resolveAvatarPackage(ELISE);

  assert.equal(resolution.validation.valid, true);
  assert.equal(resolution.validation.capabilities.basicLipSync, true);
  assert.equal(resolution.validation.capabilities.roundLipSync, true);
  // Eye and brow artwork exists for this portrait, but no eye or brow REGION is
  // calibrated in the registry, so those channels must stay off rather than be
  // composited at a guessed position.
  assert.equal(resolution.validation.capabilities.blink, false);
  assert.equal(resolution.validation.capabilities.brows, false);
  assert.equal(resolution.validation.capabilities.gaze, false);
});

test('a portrait without mouth assets resolves to a valid static package', () => {
  resetAvatarPackageCacheForTests();
  const resolution = resolveAvatarPackage('stylist_portrait_01');
  assert.ok(resolution.package);
  assert.equal(resolution.validation.valid, true);
  assert.equal(resolution.validation.capabilities.basicLipSync, false);
});

test('an abstract preset or unknown id has no package and animates nothing', () => {
  resetAvatarPackageCacheForTests();
  for (const id of ['elise_default', 'not_a_real_avatar', '', null]) {
    const resolution = resolveAvatarPackage(id);
    assert.equal(resolution.package, null);
    assert.equal(resolution.validation.valid, false);
    assert.equal(resolution.validation.assetCapabilities.mouthClosed, false);
  }
});

test('package building contains no avatar-specific branching', () => {
  // Capability differences must come from registry data, never from an
  // `if (avatarId === ...)` fork in the engine or its translation layer.
  const { executableSource } = require('./fixtures/avatarEngineHarness');
  const text = executableSource('services/avatars/avatarEnginePackages.ts');
  assert.equal(/avatarId\s*===\s*['"]/.test(text), false, 'no avatar-id equality fork allowed');
  assert.equal(/sarah|elise|henry/i.test(text), false, 'no stylist name may appear in code');
});

test('package resolution is memoized so validation never runs on a render path', () => {
  resetAvatarPackageCacheForTests();
  const first = resolveAvatarPackage(SARAH);
  const second = resolveAvatarPackage(SARAH);
  assert.equal(first, second, 'the same resolution object must be returned');
});

test('buildAvatarPackage emits metadata references only, never loaded assets', () => {
  const pkg = buildAvatarPackage(SARAH);
  const serialized = JSON.stringify(pkg);

  // No asset path, URI or Metro module id may cross into engine territory.
  for (const pattern of [/\.png/i, /\.jpe?g/i, /require\s*\(/, /file:/i, /https?:/i]) {
    assert.equal(pattern.test(serialized), false, `package payload must not contain ${pattern}`);
  }

  // Every asset descriptor is a key plus an approval, and nothing else.
  const descriptors = [pkg.base, ...Object.values(pkg.mouth).filter((v) => v && 'approval' in v)];
  for (const descriptor of descriptors) {
    assert.equal(typeof descriptor.key, 'string');
    assert.ok(['approved', 'reference', 'missing'].includes(descriptor.approval));
    assert.equal('source' in descriptor, false, 'no module reference may reach the engine');
    assert.equal('uri' in descriptor, false, 'no asset URI may reach the engine');
  }
});
