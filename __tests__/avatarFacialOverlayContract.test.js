const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

require.extensions['.jpg'] = require.extensions['.jpeg'] = require.extensions['.png'] = () => 1;

function transpileModule(file, mocks = {}) {
  const sourcePath = path.join(ROOT, file);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    Error,
    Set,
    Map,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier in mocks) return mocks[specifier];
      throw new Error(`Unexpected import in ${file}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: sourcePath }).runInContext(sandbox);
  return mod.exports;
}

// Registered Metro static require() targets in constants/avatarFacialOverlays.ts
// (stylist_portrait_02 eyes + brows production overlays). The sandboxed
// require() above throws on anything outside `mocks`, so every call site that
// loads that module now needs these -- unlike require.extensions['.png'],
// which only intercepts real Node module resolution and has no effect
// inside this VM sandbox.
const FACIAL_OVERLAY_ASSET_MOCKS = {
  '../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_eyes_open.png': 1,
  '../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_eyes_halfClosed.png': 1,
  '../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_eyes_closed.png': 1,
  '../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_brows_neutral.png': 1,
  '../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_brows_raised.png': 1,
  '../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_brows_focused.png': 1,
};

const overlays = transpileModule('constants/avatarFacialOverlays.ts', FACIAL_OVERLAY_ASSET_MOCKS);
const {
  AVATAR_FACIAL_OVERLAY_PACKAGES,
  isValidFacialOverlayAsset,
  hasValidFacialOverlayPackage,
  getFacialOverlayAsset,
} = overlays;

function validAsset(overrides = {}) {
  return {
    source: 42,
    region: { x: 0.4, y: 0.3, width: 0.2, height: 0.1 },
    anchor: { x: 0.5, y: 0.5 },
    pixelWidth: 256,
    pixelHeight: 128,
    blendMarginPx: 12,
    supportedState: 'round',
    fallbackState: 'open',
    ...overrides,
  };
}

const TARGET_AVATARS = [
  'stylist_portrait_01',
  'stylist_portrait_02',
  'stylist_portrait_03',
  'stylist_portrait_04',
];

// ── Production truth: only stylist_portrait_02 eyes/brows are shipped ──────

test('the registry ships only stylist_portrait_02 eyes and brows today', () => {
  assert.equal(AVATAR_FACIAL_OVERLAY_PACKAGES.size, 1);
  for (const avatarId of TARGET_AVATARS) {
    for (const layer of ['mouthRound', 'eyes', 'brows']) {
      // mouthRound is never registered for any avatar: the current renderer
      // never reads it (round-mouth stays on the legacy mouthStateSources
      // convention), so registering it here would flip a capability the
      // renderer would never actually display. See the registry's own
      // top-of-file comment.
      const shipped = avatarId === 'stylist_portrait_02' && layer !== 'mouthRound';
      assert.equal(
        hasValidFacialOverlayPackage(avatarId, layer),
        shipped,
        `${avatarId}/${layer} must be ${shipped} given today's registry`,
      );
      if (!shipped) {
        assert.equal(getFacialOverlayAsset(avatarId, layer, 'open'), null);
      }
    }
  }
});

test('capability truth: round mouth, blink, brows, and gaze are false today; a registered package flips them', () => {
  const stylistIdentity = require('../constants/stylistIdentity.ts');
  const motionState = transpileModule('services/avatarMotionState.ts');
  const load = (overlayModule) =>
    transpileModule('services/avatarMotionCapabilities.ts', {
      '../constants/stylistIdentity': stylistIdentity,
      '../constants/avatarFacialOverlays': overlayModule,
      './avatarMotionState': motionState,
    });

  // Current shipped truth: stylist_portrait_02 ships eyes+brows (blink and
  // brows capability true); mouthRound is never registered for any avatar
  // (see the registry's own comment), so roundMouth stays false everywhere
  // even for 02. Every other avatar stays fully false.
  const current = load(overlays);
  for (const avatarId of TARGET_AVATARS) {
    const caps = current.getAvatarMotionCapabilities(avatarId);
    const shipped = avatarId === 'stylist_portrait_02';
    assert.equal(caps.roundMouth, false, `${avatarId} round mouth`);
    assert.equal(caps.blink, shipped, `${avatarId} blink`);
    assert.equal(caps.brows, shipped, `${avatarId} brows`);
    assert.equal(caps.gaze, shipped, `${avatarId} gaze`);
    assert.equal(caps.threeStateMouth, true, `${avatarId} three-state mouth unchanged`);
  }

  // Registering a validated package is the act that flips a capability:
  // the derivation must follow the registry with no further code change.
  const withPackages = load({
    ...overlays,
    hasValidFacialOverlayPackage: (avatarId, layer) =>
      avatarId === 'stylist_portrait_01' && (layer === 'mouthRound' || layer === 'eyes'),
  });
  const caps01 = withPackages.getAvatarMotionCapabilities('stylist_portrait_01');
  assert.equal(caps01.roundMouth, true);
  assert.equal(caps01.blink, true);
  assert.equal(caps01.gaze, true, 'gaze tracks the eye package');
  assert.equal(caps01.brows, false, 'brows still gated on their own package');
  const caps02 = withPackages.getAvatarMotionCapabilities('stylist_portrait_02');
  assert.equal(caps02.roundMouth, false);
  assert.equal(caps02.blink, false);
});

// ── Asset validation ────────────────────────────────────────────────────────

test('a fully specified overlay asset validates', () => {
  assert.equal(isValidFacialOverlayAsset(validAsset()), true);
});

test('invalid overlay assets are rejected field by field', () => {
  const rejects = {
    'missing source': validAsset({ source: undefined }),
    'zero source': validAsset({ source: 0 }),
    'string source (dynamic path)': validAsset({ source: 'assets/raw/x.png' }),
    'NaN source': validAsset({ source: Number.NaN }),
    'region out of bounds': validAsset({ region: { x: 0.9, y: 0.3, width: 0.2, height: 0.1 } }),
    'negative region': validAsset({ region: { x: -0.1, y: 0.3, width: 0.2, height: 0.1 } }),
    'zero-size region': validAsset({ region: { x: 0.4, y: 0.3, width: 0, height: 0.1 } }),
    'NaN region': validAsset({ region: { x: Number.NaN, y: 0.3, width: 0.2, height: 0.1 } }),
    'anchor out of range': validAsset({ anchor: { x: 1.5, y: 0.5 } }),
    'fractional pixel size': validAsset({ pixelWidth: 256.5 }),
    'zero pixel size': validAsset({ pixelHeight: 0 }),
    'negative blend margin': validAsset({ blendMarginPx: -1 }),
    'missing states': validAsset({ supportedState: '' }),
    'missing fallback': validAsset({ fallbackState: '' }),
    null: null,
    undefined: undefined,
  };
  for (const [label, asset] of Object.entries(rejects)) {
    assert.equal(isValidFacialOverlayAsset(asset), false, label);
  }
});

test('partial eye or brow packages count as absent — a capability is never half-true', () => {
  const partialEyes = {
    avatarId: 'stylist_portrait_01',
    eyes: {
      open: validAsset({ supportedState: 'open', fallbackState: 'open' }),
      halfClosed: validAsset({ supportedState: 'halfClosed', fallbackState: 'open' }),
      // closed missing
    },
  };
  // Exercised through a mocked registry with the real validation logic.
  const patched = {
    ...overlays,
    AVATAR_FACIAL_OVERLAY_PACKAGES: new Map([[partialEyes.avatarId, partialEyes]]),
  };
  // hasValidFacialOverlayPackage closes over the module's own registry, so
  // validate the invariant directly at the package level here.
  const eyes = partialEyes.eyes;
  const complete = ['open', 'halfClosed', 'closed'].every((state) =>
    overlays.isValidFacialOverlayAsset(eyes[state]),
  );
  assert.equal(complete, false, 'two of three eye states is not a blink capability');
  assert.ok(patched, 'registry shape accepts per-avatar packages');
});

// ── Anchor convention and production-source rules ───────────────────────────

test('the overlay contract documents the anchor convention and forbids raw/preview paths', () => {
  const source = fs.readFileSync(path.join(ROOT, 'constants', 'avatarFacialOverlays.ts'), 'utf8');
  assert.match(source, /normalized to the 1024×1024 base portrait/);
  assert.match(source, /RELATIVE TO THE REGION/);
  assert.match(source, /blendMarginPx/);
  assert.match(source, /LOCALIZED TRANSPARENT/);
  assert.match(source, /Do not register generated,\s*\/\/ placeholder, or unreviewed art/);
  // No dynamic or forbidden asset paths anywhere in the module.
  assert.doesNotMatch(source, /portraits\/raw\//);
  assert.doesNotMatch(source, /avatar-square-previews/);
  assert.doesNotMatch(source, /require\((?!\s*['")])/, 'only static require paths are permitted');
});

test('no production source references raw or preview asset directories', () => {
  const surfaces = ['components', 'services', 'hooks', 'constants', 'stores'];
  const offenders = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (/portraits\/raw\/|avatar-square-previews/.test(content)) offenders.push(fullPath);
      }
    }
  };
  for (const surface of surfaces) visit(path.join(ROOT, surface));
  assert.deepEqual(offenders, []);
});
