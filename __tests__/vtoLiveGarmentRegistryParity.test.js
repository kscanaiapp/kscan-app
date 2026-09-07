// Mechanical drift guard for services/vto/vtoLiveGarmentRegistry.ts.
//
// The registry re-declares identity fields from the REAL, committed
// Phase-4-generated manifests that are bundled as native fixtures under
// modules/kscan-live-vto-native/{android/src/main/assets,ios/Assets}/
// {n1b-fixture,n1c-asym-fixture}/manifest.json -- the same pattern this
// codebase already uses for the .ksgarment contract itself (re-declare,
// cite, don't cross-import a package the runtime does not depend on). A
// hand-authored re-declaration that nothing checks against reality is a
// liability, not documentation, so this file reads the ACTUAL files off
// disk (fs/crypto -- fine here, this is a Node test, not application
// runtime code subject to the Metro bundle boundary) and asserts:
//
//   1. every registry entry's declared fields match its real manifest.json
//   2. Android's and iOS's copies of each fixture are byte-identical
//      (asset parity -- mission section 17/device-agnostic contract)
//   3. the two fixtures are REAL, DIFFERENT assets, not the same asset
//      committed twice under two names (texture.png sha256 differs;
//      productRef/assetId differ) -- the mechanical half of "prove A and B
//      are actually different underlying assets"

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readBuf = (rel) => fs.readFileSync(path.join(ROOT, rel));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(read(relativePath), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console, exports: mod.exports, module: mod,
    URL, Math, Number, Set, Map, Object, Array, JSON, Date, RangeError, String, Promise,
    __DEV__: false, process: { env: {} },
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) return requireMap[specifier];
      throw new Error(`Unexpected import in ${path.basename(filename)}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

const registry = loadTsModule('services/vto/vtoLiveGarmentRegistry.ts');
const { LIVE_VTO_GOVERNED_ASSETS, LIVE_VTO_ASSET_KEY_ALLOWLIST } = registry;

const ANDROID_ASSETS_ROOT = 'modules/kscan-live-vto-native/android/src/main/assets';
const IOS_ASSETS_ROOT = 'modules/kscan-live-vto-native/ios/Assets';

function readRealManifest(assetKey) {
  return JSON.parse(read(`${ANDROID_ASSETS_ROOT}/${assetKey}/manifest.json`));
}

// ── Every allowlisted key must be a real, bundled fixture directory ─────────

for (const assetKey of LIVE_VTO_ASSET_KEY_ALLOWLIST) {
  test(`allowlisted assetKey "${assetKey}" is a real bundled fixture on BOTH platforms`, () => {
    for (const root of [ANDROID_ASSETS_ROOT, IOS_ASSETS_ROOT]) {
      assert.ok(fs.existsSync(path.join(ROOT, root, assetKey, 'manifest.json')), `${root}/${assetKey}/manifest.json must exist`);
      assert.ok(fs.existsSync(path.join(ROOT, root, assetKey, 'texture.png')), `${root}/${assetKey}/texture.png must exist`);
      assert.ok(fs.existsSync(path.join(ROOT, root, assetKey, 'alpha.png')), `${root}/${assetKey}/alpha.png must exist`);
    }
  });
}

// ── Every registry entry's declared identity matches the real manifest ──────

for (const entry of LIVE_VTO_GOVERNED_ASSETS) {
  test(`registry entry "${entry.assetKey}" matches its real committed manifest.json field-for-field`, () => {
    const manifest = readRealManifest(entry.assetKey);
    assert.equal(entry.assetId, manifest.assetId);
    assert.equal(entry.assetVersion, manifest.assetVersion);
    assert.equal(entry.ksgarmentSchemaVersion, manifest.ksgarment.version);
    assert.equal(entry.productRef, manifest.productIdentity.productRef);
    assert.equal(entry.canonicalCategory, manifest.productIdentity.category);
    assert.equal(entry.eligible, manifest.eligibility.live2d);
    assert.equal(entry.ineligibleReason, manifest.eligibility.reason);
    assert.equal(entry.qaPassed, manifest.qa.passed);
    assert.equal(entry.sourceSha256, manifest.source.sha256);
    // assetVersion is carried both at the manifest root AND inside the
    // ksgarment block (LiveVtoGarment.kt/.swift's KsgarmentManifest.parse
    // reads it from the ksgarment block specifically) -- both must agree,
    // or native's post-load version cross-check has nothing meaningful to
    // compare against.
    assert.equal(manifest.assetVersion, manifest.ksgarment.assetVersion);
  });

  test(`registry entry "${entry.assetKey}"'s Android and iOS bundled files are byte-identical (asset parity)`, () => {
    for (const file of ['manifest.json', 'texture.png', 'alpha.png']) {
      const androidBytes = readBuf(`${ANDROID_ASSETS_ROOT}/${entry.assetKey}/${file}`);
      const iosBytes = readBuf(`${IOS_ASSETS_ROOT}/${entry.assetKey}/${file}`);
      assert.equal(sha256(androidBytes), sha256(iosBytes), `${entry.assetKey}/${file} must be byte-identical on both platforms`);
    }
  });
}

// ── The two fixtures are REAL, different assets ──────────────────────────────

test('n1b-fixture and n1c-asym-fixture are materially different assets: different productRef/assetId and different texture bytes', () => {
  const b = LIVE_VTO_GOVERNED_ASSETS.find((e) => e.assetKey === 'n1b-fixture');
  const c = LIVE_VTO_GOVERNED_ASSETS.find((e) => e.assetKey === 'n1c-asym-fixture');
  assert.ok(b && c, 'both fixtures must be registered');
  assert.notEqual(b.productRef, c.productRef);
  assert.notEqual(b.assetId, c.assetId);

  const bTexture = readBuf(`${ANDROID_ASSETS_ROOT}/n1b-fixture/texture.png`);
  const cTexture = readBuf(`${ANDROID_ASSETS_ROOT}/n1c-asym-fixture/texture.png`);
  const bHash = sha256(bTexture);
  const cHash = sha256(cTexture);
  assert.notEqual(bHash, cHash, 'texture.png must differ between the two governed assets');
  // Pin the actual bytes, not just "they differ" -- a future accidental
  // revert of n1c's texture back to n1b's would still trip "differ" against
  // whatever it got reverted to UNLESS it's an exact revert, which pinned
  // hashes catch and a mere inequality check would not.
  assert.equal(bHash, '5deca90a677b8ab31f01108b865641eccafb2f3f8f3c21083944acc9adec4393');
  assert.equal(cHash, '9c0e24fd94f10477c80677061ad7c49fbcd2237959dd0e30565fc840cbdb67f8');
});

test('every registry assetKey is drawn from the allowlist (no entry can smuggle an unlisted key)', () => {
  const allowed = new Set(LIVE_VTO_ASSET_KEY_ALLOWLIST);
  for (const entry of LIVE_VTO_GOVERNED_ASSETS) {
    assert.ok(allowed.has(entry.assetKey), `${entry.assetKey} must be in LIVE_VTO_ASSET_KEY_ALLOWLIST`);
  }
});

test('the allowlist contains no path-traversal-shaped or absolute-path-shaped entries', () => {
  for (const key of LIVE_VTO_ASSET_KEY_ALLOWLIST) {
    assert.ok(!key.includes('..'), `${key} must not contain ..`);
    assert.ok(!key.includes('/'), `${key} must not contain /`);
    assert.ok(!key.includes('\\'), `${key} must not contain a backslash`);
    assert.ok(!path.isAbsolute(key), `${key} must not be an absolute path`);
  }
});
