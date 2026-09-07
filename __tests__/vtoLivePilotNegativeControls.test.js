// Live VTO pilot negative controls: the asset-key boundary and the Photoreal
// refusal set.
//
// WHY A SEPARATE FILE. `vtoLiveGarmentResolver.test.js` already proves the
// resolver's STATUS ladder (ELIGIBLE / INELIGIBLE / NOT_FOUND / ERROR) very
// thoroughly. What it does not do is attack the ONE string that crosses into
// native and selects a directory on disk: `assetKey`. Mission section 53 asks
// specifically for path traversal and absolute-path refusals, and a control
// that has never been pointed at the attack it exists to stop is not evidence.
//
// The claims:
//   - an assetKey is an ALLOWLIST MEMBERSHIP CHECK, not a path validation, so
//     traversal and absolute paths are refused by construction rather than by
//     a sanitiser somebody has to keep correct;
//   - the SAME allowlist is enforced independently on both native platforms,
//     so a JS-side bypass still meets a closed door;
//   - the Photoreal handoff refuses a stale actor, a stale session, an
//     invalid person frame and a composited preview.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const code = (rel) => stripComments(read(rel));

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
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

const contract = loadTsModule('types/vtoLive.ts');
const registry = loadTsModule('services/vto/vtoLiveGarmentRegistry.ts');

// ── The asset-key boundary (section 53) ─────────────────────────────────────

/**
 * Every shape an attacker would try. None of these is a "weird input" -- each
 * is a specific way of reaching a file the registry never approved.
 */
const HOSTILE_ASSET_KEYS = [
  '../n1b-fixture',
  '../../n1b-fixture',
  'n1b-fixture/../../../etc/passwd',
  './n1b-fixture',
  'n1b-fixture/',
  '/n1b-fixture',
  '//n1b-fixture',
  '/etc/passwd',
  'C:\\Windows\\System32\\config\\SAM',
  '\\\\server\\share\\asset',
  'file:///etc/passwd',
  'n1b-fixture\u0000.png',
  'n1b-fixture%2f..%2f..',
  'N1B-FIXTURE',
  'n1b-fixture ',
  ' n1b-fixture',
  '',
];

test('VTO-NC: a traversal, absolute or otherwise-forged assetKey is REFUSED', () => {
  for (const key of HOSTILE_ASSET_KEYS) {
    assert.equal(
      registry.isLiveVtoAssetKey(key),
      false,
      `${JSON.stringify(key)} was accepted as an asset key`,
    );
  }
  // ...and the two real ones still are, so this is discriminating rather than
  // a function that refuses everything.
  for (const key of registry.LIVE_VTO_ASSET_KEY_ALLOWLIST) {
    assert.equal(registry.isLiveVtoAssetKey(key), true, `${key} must still resolve`);
  }
});

test('the assetKey check is allowlist MEMBERSHIP, not path sanitisation', () => {
  // The distinction is the whole defence. A sanitiser has to anticipate every
  // encoding of "go up a directory"; a membership test does not have to
  // anticipate anything, because a string either IS one of two known names or
  // it is not. This asserts the implementation is the second kind.
  const source = code('services/vto/vtoLiveGarmentRegistry.ts');
  assert.match(source, /ASSET_KEY_SET\.has\(value\)/, 'membership against a fixed Set is the contract');
  for (const sanitiserish of ['replace(', 'normalize(', 'startsWith(', 'resolve(', 'join(']) {
    assert.ok(
      !source.includes(sanitiserish),
      `the registry uses ${sanitiserish} -- that is path sanitisation, and it is the weaker design`,
    );
  }
});

test('BOTH native platforms enforce the SAME allowlist independently of JS', () => {
  // A JS-side bypass must still meet a closed door. Each platform re-declares
  // the allowlist (there is nothing to import across the bridge) and checks it
  // while PARSING the descriptor, before any asset work starts.
  const kotlin = read('modules/kscan-live-vto-native/android/src/main/java/expo/modules/kscanlivevtonative/LiveVtoSessionState.kt');
  const swift = read('modules/kscan-live-vto-native/ios/Core/LiveVtoSessionState.swift');
  for (const key of registry.LIVE_VTO_ASSET_KEY_ALLOWLIST) {
    assert.ok(kotlin.includes(`"${key}"`), `Android's SUPPORTED_ASSET_KEYS is missing ${key}`);
    assert.ok(swift.includes(`"${key}"`), `iOS's supportedAssetKeys is missing ${key}`);
  }
  assert.match(kotlin, /if \(assetKey !in SUPPORTED_ASSET_KEYS\) return null/);
  assert.match(swift, /supportedAssetKeys\.contains\(assetKey\)/);

  // And neither platform builds a path from a caller-supplied string.
  for (const [name, source] of [['Android', kotlin], ['iOS', swift]]) {
    assert.ok(
      !/File\(|URL\(fileURLWithPath|\.\.\//.test(source),
      `${name}'s descriptor parser constructs a path -- the assetKey must stay a NAME`,
    );
  }
});

test('the registry declares exactly the assets that are actually bundled', () => {
  // A registry entry with no asset behind it would resolve ELIGIBLE and then
  // fail at load, which is the "no silent fixture fallback" rule failing on
  // the other side.
  for (const entry of registry.LIVE_VTO_GOVERNED_ASSETS) {
    assert.ok(
      registry.LIVE_VTO_ASSET_KEY_ALLOWLIST.includes(entry.assetKey),
      `${entry.assetKey} is declared but not allowlisted`,
    );
    for (const platformDir of [
      `modules/kscan-live-vto-native/android/src/main/assets/${entry.assetKey}`,
      `modules/kscan-live-vto-native/ios/Assets/${entry.assetKey}`,
    ]) {
      const manifestPath = path.join(ROOT, platformDir, 'manifest.json');
      assert.ok(fs.existsSync(manifestPath), `${platformDir}/manifest.json does not exist`);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.equal(
        manifest.productIdentity?.productRef,
        entry.productRef,
        `${platformDir} declares a different productRef than the registry`,
      );
    }
  }
});

test('PILOT ASSET EXPANSION is BLOCKED on source material, and the registry says so honestly', () => {
  // Section 20/21: the pilot set was NOT expanded, because no additional
  // rights-cleared source imagery exists that could pass through the governed
  // asset factory, and third-party retailer imagery may not be newly bundled.
  // Pinned so a later expansion is a deliberate act with a rights record,
  // never a quiet append.
  assert.equal(
    registry.LIVE_VTO_GOVERNED_ASSETS.length,
    2,
    'the governed pilot set changed. Every added asset needs a recorded rights basis '
      + '(source, licence, product identity, asset id/version, eligibility, QA, hashes, both platform copies).',
  );
  const distinctRefs = new Set(registry.LIVE_VTO_GOVERNED_ASSETS.map((a) => a.productRef));
  assert.equal(distinctRefs.size, 2, 'the two governed assets must address DIFFERENT products');
});

// ── Photoreal refusals (section 52) ─────────────────────────────────────────

test('VTO-NC: a composited PREVIEW can never become a generative input', () => {
  assert.throws(
    () => contract.assertCleanPersonFrame({ captureId: 'c1', kind: 'PREVIEW', localUri: 'file:///p.png' }),
    /PERSON_FRAME/,
  );
  // The guarantee is the DECLARED KIND, not a heuristic. A preview that
  // happened to look clean must still be refused, and a person frame that
  // happened to look composited must still be accepted -- anything else is a
  // proxy that is both defeatable and wrong.
  contract.assertCleanPersonFrame({
    captureId: 'c2', kind: 'PERSON_FRAME', localUri: 'file:///p.png', width: 10, height: 10,
  });
  const handoff = code('services/vto/vtoPhotorealHandoff.ts');
  for (const heuristic of ['width >', 'height >', 'aspect', 'pixel', 'histogram']) {
    assert.ok(
      !handoff.toLowerCase().includes(heuristic.toLowerCase()),
      `the handoff uses a ${heuristic} heuristic -- the clean-frame rule is the declared kind`,
    );
  }
});

test('VTO-NC: an invalid or malformed person frame is refused, never assumed clean', () => {
  for (const bad of [
    null,
    undefined,
    {},
    { captureId: 'c', kind: undefined, localUri: 'x' },
    { captureId: 'c', kind: 'person_frame', localUri: 'x' },
    { captureId: 'c', kind: 'PERSON_FRAME ', localUri: 'x' },
    { captureId: 'c', kind: ['PERSON_FRAME'], localUri: 'x' },
  ]) {
    assert.throws(
      () => contract.assertCleanPersonFrame(bad),
      /PERSON_FRAME/,
      `${JSON.stringify(bad)} passed the clean-frame gate`,
    );
  }
});

test('VTO-NC: every Photoreal failure leaves the LIVE session usable', () => {
  // Not one code is allowed to be a session teardown. This is what makes "a
  // cloud generation failing is not a reason to kill a local session that is
  // still working" a property rather than a promise.
  for (const codeName of contract.PHOTOREAL_FAILURE_CODES) {
    const outcome = contract.handlePhotorealFailure(codeName);
    assert.equal(outcome.code, codeName);
    assert.equal(outcome.liveSessionRemainsUsable, true, `${codeName} tore the session down`);
    assert.equal(outcome.resultingState, 'LIVE_LOCAL', `${codeName} left a dangling intent state`);
  }
  // Including the provider-side ones this lane could not exercise for real.
  for (const required of ['provider_unavailable', 'generation_failed', 'entitlement_missing', 'feature_disabled']) {
    assert.ok(contract.PHOTOREAL_FAILURE_CODES.includes(required), `${required} must be a known failure code`);
  }
});

test('VTO-NC: no provider identity can reach a Photoreal failure message', () => {
  // Section 29: never expose RapidAPI, AILabTools, HTTP 429, reservation ids,
  // a provider slug, or raw backend detail. Checked over the CUSTOMER-facing
  // surfaces, which are the only place a string can be read by a person.
  const surfaces = [
    'components/vto/VtoLivePanel.tsx',
    'types/vtoLive.ts',
    'services/vto/vtoFailures.ts',
  ];
  const banned = ['rapidapi', 'ailabtools', 'tryon-clothes-pro', 'reservation', 'http 429', '429'];
  for (const file of surfaces) {
    const literals = [...code(file).matchAll(/'([^']{4,})'|"([^"]{4,})"/g)]
      .map((m) => m[1] ?? m[2])
      .filter((s) => /\s/.test(s)); // sentences, not identifiers
    for (const literal of literals) {
      for (const token of banned) {
        assert.ok(
          !literal.toLowerCase().includes(token),
          `${file} customer copy "${literal}" leaks ${token}`,
        );
      }
    }
  }
});

test('VTO-NC: the Photoreal handoff still owns no network client of its own', () => {
  // The single most important structural property of the whole boundary: Live
  // reaches the cloud only through the EXISTING generative store action, so
  // there is exactly one governed, quota-counted, idempotency-keyed path.
  const handoff = code('services/vto/vtoPhotorealHandoff.ts');
  for (const network of ['fetch(', 'XMLHttpRequest', 'axios', 'supabase.functions', 'https://']) {
    assert.ok(!handoff.includes(network), `the handoff acquired a network surface: ${network}`);
  }
});
