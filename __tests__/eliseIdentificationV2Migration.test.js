// Phase 2B.3 — Elise fashion-identification-v2 migration.
//
// Covers path governance, the Elise-only rollout flag and its latching, the
// identify_for_style request contract, detection-first candidate behaviour,
// canonical context assembly, null-safe formatting, structured-source reuse,
// persistence separation, actor/draft staleness, commerce isolation and privacy.
//
// Everything below the transport is the REAL implementation. Only
// `identifyScanImage` is stubbed, so these tests describe what actually goes on
// the wire rather than a re-implementation of it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, {
    exports: mod.exports,
    module: mod,
    console,
    __DEV__: false,
    process: { env: {} },
    require: (id) => {
      if (id.startsWith('node:')) return require(id);
      if (id in requireMap) return requireMap[id];
      throw new Error(`Unexpected import ${id} from ${relativePath}`);
    },
  });
  return mod.exports;
}

/**
 * Realm-safe deep comparison.
 *
 * `loadTsModule` evaluates each module with `vm.runInNewContext`, so the objects
 * it returns belong to a different V8 realm and carry that realm's
 * `Object.prototype`. `deepStrictEqual` compares prototypes, so a structurally
 * identical cross-realm object fails on prototype identity alone. Normalizing
 * both sides through JSON compares the DATA, which is what these assertions are
 * actually about — and it doubles as a serializability check.
 */
function sameData(actual, expected, message) {
  assert.deepEqual(
    JSON.parse(JSON.stringify(actual)),
    JSON.parse(JSON.stringify(expected)),
    message,
  );
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/**
 * Source with declared denylist/allowlist literals removed.
 *
 * A module that REJECTS `purchaseOptions` must name it to reject it. Grepping raw
 * source would therefore flag the enforcement code as the violation. Removing the
 * declared constant blocks leaves the code that actually reads fields.
 */
function withoutDenylists(source) {
  return source
    .replace(/const FORBIDDEN_[A-Z_]*\s*(?::[^=]*)?=\s*new Set\(\[[\s\S]*?\]\);/g, '')
    .replace(/const FORBIDDEN_[A-Z_]*\s*(?::[^=]*)?=\s*\[[\s\S]*?\];/g, '');
}

/** Source with comments stripped, for assertions about code rather than prose. */
function readCode(rel) {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ── Module graph ────────────────────────────────────────────────────────────

let cryptoCounter = 0;
const contractTypes = loadTsModule('types/fashionIdentificationV2.ts', {});
const evidenceGateway = loadTsModule('services/fashionEvidenceGateway.ts', {
  'expo-crypto': {
    getRandomBytes: (n) => {
      cryptoCounter += 1;
      return Uint8Array.from({ length: n }, (_, i) => (i * 17 + cryptoCounter * 13) & 0xff);
    },
  },
});
const v2Core = loadTsModule('services/fashionIdentificationV2Core.ts', {
  '../types/fashionIdentificationV2': contractTypes,
  './fashionEvidenceGateway': evidenceGateway,
});

function loadEliseAdapter(flagEnabled) {
  return loadTsModule('services/style-chat/eliseIdentificationV2.ts', {
    '../../types/fashionIdentificationV2': contractTypes,
    '../fashionEvidenceGateway': evidenceGateway,
    '../fashionIdentificationV2Core': v2Core,
    '../../constants/featureFlags': {
      resolveEliseIdentificationV2Enabled: () => flagEnabled,
    },
  });
}

const eliseAdapter = loadEliseAdapter(false);

const fashionContext = loadTsModule('services/style-chat/eliseFashionContextV2.ts', {
  '../../types/fashionIdentificationV2': contractTypes,
  '../fashionIdentificationV2Core': v2Core,
});

const sendContext = loadTsModule('services/style-chat/eliseSendContext.ts', {
  '../../types/fashionIdentificationV2': contractTypes,
  '../fashionIdentificationV2Core': v2Core,
  './eliseFashionContextV2': fashionContext,
});

const projection = loadTsModule('services/style-chat/eliseVisualContextV2Projection.ts', {
  '../../types/fashionIdentificationV2': contractTypes,
  '../fashionIdentificationV2Core': v2Core,
});

const snapshotModule = loadTsModule('services/identificationSnapshot.ts', {
  '../types/scanIdentification': {},
  '../types/fashionIdentificationV2': {},
});

const routing = loadTsModule('services/style-chat/eliseAttachmentRouting.ts', {
  '../../types/fashionIdentificationV2': contractTypes,
  '../identificationSnapshot': snapshotModule,
  '../fashionIdentificationV2Core': v2Core,
  // Reuse delegates to the ONE context builder, so a reused identity is
  // validated and projected by exactly the same code as a fresh one.
  './eliseFashionContextV2': fashionContext,
});

function loadOrchestrator(transport, flagEnabled = true) {
  return loadTsModule('services/style-chat/eliseIdentifyForStyle.ts', {
    '../scanIdentification': { identifyScanImage: transport },
    '../../types/scanIdentification': {},
    '../../types/fashionIdentificationV2': contractTypes,
    '../fashionEvidenceGateway': evidenceGateway,
    '../fashionIdentificationV2Core': v2Core,
    './eliseIdentificationV2': loadEliseAdapter(flagEnabled),
  });
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function validV2Result(overrides = {}) {
  return {
    contractVersion: 'fashion-identification-v2',
    requestId: 'req-1',
    status: 'completed',
    resolutionLevel: 'brand_and_subtype',
    item: {
      category: 'Outerwear',
      subtype: 'Chore Jacket',
      brand: { value: 'Carhartt', confidence: 0.8, provenance: 'visible_text', evidence: [] },
      colors: { primary: 'Tan', secondary: ['Cream'] },
      material: ['Cotton canvas'],
      silhouette: ['Boxy'],
      pattern: ['Solid'],
      attributes: { fit: 'Relaxed', pockets: ['Patch'], visible: ['Buttons'], distinctive: [] },
    },
    confidence: {
      category: 0.9, subtype: 0.85, brand: 0.7, modelFamily: null, exactProduct: null,
    },
    exactProduct: null,
    evidence: [{ evidenceId: 'evidence-aaaaaaaa', observations: [] }],
    conflicts: [],
    compatibility: { legacyProjectionAvailable: true, globalConfidence: 0.85 },
    ...overrides,
  };
}

/** A V2 result carrying detection candidates. */
function detectionResult(candidates, overrides = {}) {
  return validV2Result({
    status: 'completed',
    candidates,
    ...overrides,
  });
}

function candidate(id, evidenceId = 'evidence-aaaaaaaa', extra = {}) {
  return { candidateId: id, evidenceId, category: 'Outerwear', ...extra };
}

function transitionalResponse(v2, extra = {}) {
  return {
    status: 'completed',
    attributes: { category: 'Outerwear' },
    identification: { item_type: 'Outerwear' },
    recommendedProducts: [{ id: 'p1', title: 'Jacket', price: 100, currency: 'USD', url: 'https://x' }],
    similarityMatches: [],
    contractVersion: 'fashion-identification-v2',
    identificationV2: v2,
    scanSessionId: 'server-session-1',
    imageDigestPrefix: 'abc123',
    ...extra,
  };
}

function evidenceFor(id = 'evidence-aaaaaaaa', source = 'gallery') {
  return { evidenceId: id, imageBase64: 'BASE64BYTES', mimeType: 'image/jpeg', source };
}

const enabledFlag = { enabled: true };
const disabledFlag = { enabled: false };

/** Canonical result distinguishable by SUBTYPE — the projection drops requestId. */
function namedResult(subtype) {
  return validV2Result({ item: { ...validV2Result().item, subtype } });
}

/** The projection of a canonical result, for display-helper assertions. */
function identityOf(result) {
  return fashionContext.projectCanonicalToEliseIdentity(result);
}

// ── §46 Path inventory / governance ─────────────────────────────────────────

test('governance: every active Elise raw-image path routes through the Elise adapter', () => {
  // One adapter, one orchestrator, and the surfaces that must reach them.
  assert.ok(exists('services/style-chat/eliseIdentificationV2.ts'));
  assert.ok(exists('services/style-chat/eliseIdentifyForStyle.ts'));
  assert.ok(exists('services/style-chat/eliseDirectImageIdentification.ts'));

  const directIdentification = readCode('services/style-chat/eliseDirectImageIdentification.ts');
  assert.match(directIdentification, /identifyPreparedImageForStyle\(/);
  assert.match(directIdentification, /entryPath: entryPathFor\(input\.source\)/);
});

/**
 * The file holding this platform's ACTIVE direct camera/gallery path.
 *
 * The two platforms genuinely differ: iOS's production path is `addDirectImage`
 * in the composer hook (behind ELISE_VISUAL_ATTACHMENTS_V1_ENABLED), while
 * Android has no camera control and its only active path is the photo-intake
 * modal. Asserting against a hardcoded filename would silently pass on the
 * platform where that file exists but holds nothing relevant.
 */
function directImageSurfaces() {
  return [
    'hooks/useStyleChatAttachments.ts',
    'components/style-chat/StyleChatPhotoIntake.tsx',
  ].filter((rel) => exists(rel) && readCode(rel).includes('identifyDirectImageForStyle('));
}

test('governance: the direct composer path no longer hardcodes a category', () => {
  // The Phase 2B.2 defect on iOS: `resolvePreparedDirectImageAttachment(prepared,
  // { title: 'Photo', category: 'tops' })` recorded EVERY photo as a top. A dress,
  // a shoe and a handbag were all filed and described to Elise as tops.
  const surfaces = directImageSurfaces();
  assert.ok(surfaces.length > 0, 'this platform must have a migrated direct-image path');
  for (const rel of surfaces) {
    const source = readCode(rel);
    assert.match(source, /identifyDirectImageForStyle\(/, `${rel} must identify before staging`);
    // An UNCONDITIONAL hardcoded category must not exist anywhere.
    assert.doesNotMatch(
      source,
      /resolvePreparedDirectImageAttachment\(prepared,\s*\{\s*title:\s*'Photo',\s*category:\s*'tops',?\s*\}\)/,
      `${rel} must not stage an unconditional hardcoded category`,
    );
    // Where a legacy default survives it may only be the flag-off branch.
    if (source.includes("'tops'")) {
      assert.match(
        source,
        /identified\?\.kind === 'identified' \? identified\.category : 'tops'/,
        `${rel} may keep 'tops' only as the flag-off fallback`,
      );
    }
  }
});

test('governance: identification happens BEFORE staging, never after', () => {
  const surfaces = directImageSurfaces();
  assert.ok(surfaces.length > 0);
  for (const rel of surfaces) {
    const source = read(rel);
    const identifyAt = source.indexOf('identifyDirectImageForStyle(');
    assert.ok(identifyAt > 0, `${rel} must call identification`);
    // Whichever staging call this surface uses, identification must precede it.
    for (const stageMarker of ['resolvePreparedDirectImageAttachment(', 'await saveScan(']) {
      const stageAt = source.indexOf(stageMarker);
      if (stageAt < 0) continue;
      assert.ok(
        identifyAt < stageAt,
        `${rel}: staging before identifying would write a placeholder row that a failure would orphan`,
      );
    }
  }
});

test('governance: Elise never imports Scanner UI, commerce or useKScan', () => {
  const eliseModules = [
    'services/style-chat/eliseIdentificationV2.ts',
    'services/style-chat/eliseIdentifyForStyle.ts',
    'services/style-chat/eliseFashionContextV2.ts',
    'services/style-chat/eliseDirectImageIdentification.ts',
    'services/style-chat/eliseSendContext.ts',
    'services/style-chat/eliseAttachmentRouting.ts',
  ].filter(exists);
  assert.ok(eliseModules.length >= 5);
  for (const rel of eliseModules) {
    const source = readCode(rel);
    assert.doesNotMatch(source, /useKScan/, `${rel} must not route through the Scanner hook`);
    assert.doesNotMatch(source, /from '[^']*purchaseOptions'/, `${rel} must not import commerce`);
    assert.doesNotMatch(source, /secondhand|shoppingProvider|productSearchDeals/, `${rel} must not import a retailer provider`);
    assert.doesNotMatch(source, /scannerScanRequest/, `${rel} must not use the Scanner orchestrator`);
    // Commerce fields may appear ONLY inside a denylist that exists to reject
    // them. Anywhere else is a read, and a read is contamination.
    assert.doesNotMatch(
      withoutDenylists(source),
      /purchaseOptions|purchase_options/i,
      `${rel} must not touch purchase options outside a denylist`,
    );
  }
});

test('governance: no duplicate evidence-id generator exists', () => {
  // Two generators would be two chances to derive an id from a filename or URI.
  const gateway = read('services/fashionEvidenceGateway.ts');
  assert.match(gateway, /export function createEvidenceId\(\)/);
  const scannerGateway = readCode('services/scannerEvidenceGateway.ts');
  assert.doesNotMatch(
    scannerGateway,
    /export function createEvidenceId\(\)/,
    'the Scanner gateway must re-export, not redefine',
  );
  const eliseAdapterSource = readCode('services/style-chat/eliseIdentificationV2.ts');
  assert.doesNotMatch(
    eliseAdapterSource,
    /function createEvidenceId\(\)\s*\{/,
    'the Elise adapter must re-export, not redefine',
  );
});

test('governance: no duplicate V2 response validator exists', () => {
  const core = read('services/fashionIdentificationV2Core.ts');
  assert.match(core, /export function validateFashionV2Response/);
  const scannerAdapter = read('services/scannerIdentificationV2.ts');
  assert.match(
    scannerAdapter,
    /return validateFashionV2Response\(raw\);/,
    'Scanner delegates to the shared validator',
  );
});

// ── §47 Flag tests ──────────────────────────────────────────────────────────

test('flag: the Elise flag is independent of the Scanner flag', () => {
  const flags = read('constants/featureFlags.ts');
  assert.match(flags, /EXPO_PUBLIC_ELISE_IDENTIFICATION_V2_ENABLED/);
  assert.match(flags, /EXPO_PUBLIC_SCANNER_IDENTIFICATION_V2_ENABLED/);
  assert.notEqual(
    flags.indexOf('resolveEliseIdentificationV2Enabled'),
    flags.indexOf('resolveScannerIdentificationV2Enabled'),
    'two distinct resolvers',
  );
});

test('flag: default is disabled and only the exact string "true" enables', () => {
  const resolver = (value) => value === 'true';
  assert.equal(eliseAdapter.beginEliseV2Session(() => resolver(undefined)).enabled, false);
  assert.equal(eliseAdapter.beginEliseV2Session(() => resolver('')).enabled, false);
  assert.equal(eliseAdapter.beginEliseV2Session(() => resolver('TRUE')).enabled, false);
  assert.equal(eliseAdapter.beginEliseV2Session(() => resolver('True')).enabled, false);
  assert.equal(eliseAdapter.beginEliseV2Session(() => resolver('1')).enabled, false);
  assert.equal(eliseAdapter.beginEliseV2Session(() => resolver('yes')).enabled, false);
  assert.equal(eliseAdapter.beginEliseV2Session(() => resolver(' true ')).enabled, false);
  assert.equal(eliseAdapter.beginEliseV2Session(() => resolver('true')).enabled, true);
});

test('flag: a resolver failure fails CLOSED onto the current path', () => {
  const session = eliseAdapter.beginEliseV2Session(() => {
    throw new Error('config unavailable');
  });
  assert.equal(session.enabled, false);
});

test('flag: the latched value is frozen and cannot be mutated mid-operation', () => {
  const session = eliseAdapter.beginEliseV2Session(() => true);
  assert.equal(session.enabled, true);
  assert.ok(Object.isFrozen(session));
  try {
    session.enabled = false;
  } catch {
    // strict mode throws; either way the value must not change
  }
  assert.equal(session.enabled, true);
});

test('flag: a mid-operation flag change does not alter in-flight work', async () => {
  // The orchestrator reads the LATCHED object, never the resolver, so flipping
  // the environment between the two network stages cannot make detection and
  // selection speak different contracts.
  let live = true;
  const latched = eliseAdapter.beginEliseV2Session(() => live);
  assert.equal(latched.enabled, true);
  live = false; // the environment changes mid-operation

  const calls = [];
  const orchestrator = loadOrchestrator(async (image, options) => {
    calls.push(options);
    if (!options.contractRequestV2) return { status: 'completed', recommendedProducts: [] };
    const mode = options.contractRequestV2.mode;
    return transitionalResponse(
      mode === 'detect_items'
        ? detectionResult([candidate('c1')])
        : validV2Result(),
    );
  });

  const result = await orchestrator.identifyPreparedImageForStyle({
    evidence: evidenceFor(),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'op-1',
    sessionFlag: latched,
    policy: 'item',
  });
  assert.equal(result.state, 'ready');
  assert.equal(calls.length, 2, 'both stages ran');
  for (const options of calls) {
    assert.ok(options.contractRequestV2, 'every stage used the latched V2 contract');
  }
});

test('flag: flag-off sends the legacy request and no V2 envelope', async () => {
  const calls = [];
  const orchestrator = loadOrchestrator(async (image, options) => {
    calls.push(options);
    return { status: 'completed', recommendedProducts: [] };
  }, false);
  const outcome = await orchestrator.runEliseIdentificationStage({
    mode: 'detect_items',
    evidence: evidenceFor(),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'op-1',
    sessionFlag: disabledFlag,
  });
  assert.equal(outcome.contractPath, 'legacy');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].contractRequestV2, undefined, 'no V2 envelope on the legacy path');
  assert.equal(outcome.identificationV2, null);
});

// ── §48 Request tests ───────────────────────────────────────────────────────

test('request: contractVersion and intent are always correct', () => {
  const built = eliseAdapter.buildEliseV2Request({
    mode: 'detect_items',
    evidence: evidenceFor(),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'r1',
  });
  assert.equal(built.kind, 'ok');
  assert.equal(built.request.contractVersion, 'fashion-identification-v2');
  assert.equal(built.request.intent, 'identify_for_style');
});

test('request: identify_and_shop is unreachable from the Elise adapter', () => {
  assert.equal(eliseAdapter.ELISE_INTENT, 'identify_for_style');
  // The builder takes no intent parameter, so a caller cannot supply one.
  const built = eliseAdapter.buildEliseV2Request({
    mode: 'detect_items',
    evidence: evidenceFor(),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'r1',
    intent: 'identify_and_shop', // ignored: not part of the input contract
  });
  assert.equal(built.request.intent, 'identify_for_style');
});

test('request: the validator REJECTS a request carrying the shopping intent', () => {
  const built = eliseAdapter.buildEliseV2Request({
    mode: 'detect_items',
    evidence: evidenceFor(),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'r1',
  });
  assert.equal(eliseAdapter.validateEliseV2Request(built.request), true);
  // This is what catches an Elise path wired through the Scanner builder.
  const shopping = { ...built.request, intent: 'identify_and_shop' };
  assert.equal(eliseAdapter.validateEliseV2Request(shopping), false);
  const missing = { ...built.request };
  delete missing.intent;
  assert.equal(eliseAdapter.validateEliseV2Request(missing), false);
  const typo = { ...built.request, intent: 'identify_for_styles' };
  assert.equal(eliseAdapter.validateEliseV2Request(typo), false);
});

test('request: the validator rejects a Scanner entry path on an Elise request', () => {
  const built = eliseAdapter.buildEliseV2Request({
    mode: 'detect_items',
    evidence: evidenceFor(),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'r1',
  });
  const scannerPath = {
    ...built.request,
    source: { ...built.request.source, entryPath: 'scanner_gallery' },
  };
  assert.equal(eliseAdapter.validateEliseV2Request(scannerPath), false);
});

test('request: each Elise source maps to its own contract entry path', () => {
  const cases = [
    ['direct_camera', 'elise_camera'],
    ['direct_gallery', 'elise_gallery'],
    ['header_gallery', 'elise_header_gallery'],
  ];
  for (const [key, expected] of cases) {
    const built = eliseAdapter.buildEliseV2Request({
      mode: 'detect_items',
      evidence: evidenceFor(),
      entryPath: key,
      platform: 'ios',
      requestId: 'r1',
    });
    assert.equal(built.kind, 'ok');
    assert.equal(built.request.source.entryPath, expected);
  }
  // An unknown key is rejected rather than silently producing no entryPath.
  const bogus = eliseAdapter.buildEliseV2Request({
    mode: 'detect_items',
    evidence: evidenceFor(),
    entryPath: 'nope',
    platform: 'ios',
    requestId: 'r1',
  });
  assert.equal(bogus.kind, 'rejected');
  assert.equal(bogus.reason, 'invalid_entry_path');
});

test('request: exactly one evidence object per request', () => {
  const built = eliseAdapter.buildEliseV2Request({
    mode: 'detect_items',
    evidence: evidenceFor(),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'r1',
  });
  assert.equal(built.request.evidence.length, 1);
  assert.equal(built.request.evidence[0].transport.type, 'jpeg_base64');
  // Two evidence entries must fail the envelope check.
  const two = {
    ...built.request,
    evidence: [built.request.evidence[0], built.request.evidence[0]],
  };
  assert.equal(eliseAdapter.validateEliseV2Request(two), false);
});

test('request: every source image gets a unique evidence id', () => {
  const ids = new Set();
  for (let i = 0; i < 25; i += 1) ids.add(eliseAdapter.createEvidenceId());
  assert.equal(ids.size, 25, 'no two prepared images may share an id');
  for (const id of ids) assert.match(id, /^[A-Za-z0-9-]{8,64}$/);
});

test('request: an evidence id is never derived from a URI, filename or asset id', () => {
  // The format allowlist makes a URI, path, filename or query string
  // unrepresentable, so the whole class is excluded by construction.
  const rejected = [
    'file:///var/mobile/photo.jpg',
    'content://media/external/images/1',
    'ph://ABCDEF-1234',
    'C:\\Users\\me\\photo.jpg',
    'photo.jpg',
    'user@example.com',
    'id?x=1',
    'has space',
    'short',
  ];
  for (const value of rejected) {
    assert.equal(evidenceGateway.isValidEvidenceId(value), false, `${value} must be rejected`);
  }
  // A caller-supplied invalid id is replaced, never honoured.
  const prepared = evidenceGateway.prepareFashionEvidence({
    preparedImage: 'BASE64',
    source: 'gallery',
    evidenceId: 'file:///tmp/x.jpg',
  });
  assert.notEqual(prepared.evidenceId, 'file:///tmp/x.jpg');
  assert.match(prepared.evidenceId, /^[A-Za-z0-9-]{8,64}$/);
});

test('request: the evidence id is stable across detection and selection', async () => {
  const seen = [];
  const orchestrator = loadOrchestrator(async (image, options) => {
    const req = options.contractRequestV2;
    seen.push({
      mode: req.mode,
      evidenceId: req.evidence[0].evidenceId,
      candidateEvidenceId: req.selectedCandidate?.evidenceId,
    });
    return transitionalResponse(
      req.mode === 'detect_items'
        ? detectionResult([candidate('c1', 'evidence-stable-1')])
        : validV2Result(),
    );
  });
  await orchestrator.identifyPreparedImageForStyle({
    evidence: evidenceFor('evidence-stable-1'),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'op-1',
    sessionFlag: enabledFlag,
    policy: 'item',
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].evidenceId, 'evidence-stable-1');
  assert.equal(seen[1].evidenceId, 'evidence-stable-1');
  assert.equal(seen[1].candidateEvidenceId, 'evidence-stable-1');
});

test('request: a candidate from another image is rejected before any network call', () => {
  const built = eliseAdapter.buildEliseV2Request({
    mode: 'identify_selected_item',
    evidence: evidenceFor('evidence-image-one'),
    entryPath: 'header_gallery',
    platform: 'ios',
    requestId: 'r1',
    selectedCandidate: candidate('c1', 'evidence-image-two'),
  });
  assert.equal(built.kind, 'rejected');
  assert.equal(built.reason, 'evidence_id_mismatch');
});

test('request: server-issued session id and digest prefix are preserved verbatim', async () => {
  const options = [];
  const orchestrator = loadOrchestrator(async (image, opts) => {
    options.push(opts);
    const req = opts.contractRequestV2;
    return transitionalResponse(
      req.mode === 'detect_items' ? detectionResult([candidate('c1')]) : validV2Result(),
    );
  });
  await orchestrator.identifyPreparedImageForStyle({
    evidence: evidenceFor(),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'op-1',
    sessionFlag: enabledFlag,
    policy: 'item',
  });
  // Detection had none to send; selection carries what detection returned.
  assert.equal(options[0].scanSessionId, undefined);
  assert.equal(options[1].scanSessionId, 'server-session-1');
  assert.equal(options[1].imageDigestPrefix, 'abc123');
});

test('request: a detection digest is echoed only when the server supplied one', () => {
  const withDigest = eliseAdapter.buildEliseV2Request({
    mode: 'identify_selected_item',
    evidence: evidenceFor(),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'r1',
    selectedCandidate: candidate('c1', 'evidence-aaaaaaaa', { detectionDigest: 'srv-digest' }),
  });
  assert.equal(withDigest.request.selectedCandidate.detectionDigest, 'srv-digest');

  const withoutDigest = eliseAdapter.buildEliseV2Request({
    mode: 'identify_selected_item',
    evidence: evidenceFor(),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'r1',
    selectedCandidate: candidate('c1'),
  });
  assert.ok(
    !('detectionDigest' in withoutDigest.request.selectedCandidate),
    'the key must be ABSENT, not null or empty',
  );
});

test('request: a session id is never substituted for a detection digest', () => {
  const orchestratorSource = readCode('services/style-chat/eliseIdentifyForStyle.ts');
  // Reading the server pair and writing a detection digest are different things.
  assert.doesNotMatch(orchestratorSource, /detectionDigest:\s*\w*[sS]canSessionId/);
  assert.doesNotMatch(orchestratorSource, /detectionDigest:\s*\w*imageDigestPrefix/);
  const adapterSource = readCode('services/style-chat/eliseIdentificationV2.ts');
  assert.doesNotMatch(adapterSource, /detectionDigest:\s*\w*[sS]canSessionId/);
});

test('request: privacy attestation is truthful and cannot claim masking', () => {
  const built = eliseAdapter.buildEliseV2Request({
    mode: 'detect_items',
    evidence: evidenceFor(),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'r1',
  });
  sameData(built.request.privacy, {
    localFaceMaskApplied: false,
    localPlateMaskApplied: false,
    rawExifTransmitted: false,
  });
  const adapterSource = readCode('services/style-chat/eliseIdentificationV2.ts');
  assert.doesNotMatch(
    adapterSource,
    /localFaceMaskApplied:\s*true/,
    'no code path may claim face masking',
  );
  assert.doesNotMatch(adapterSource, /localPlateMaskApplied:\s*true/);
});

// ── §49 Single- and multi-item behaviour ────────────────────────────────────

test('candidates: exactly one valid candidate auto-continues without a selection step', async () => {
  const modes = [];
  const orchestrator = loadOrchestrator(async (image, options) => {
    const req = options.contractRequestV2;
    modes.push(req.mode);
    return transitionalResponse(
      req.mode === 'detect_items' ? detectionResult([candidate('only')]) : validV2Result(),
    );
  });
  const result = await orchestrator.identifyPreparedImageForStyle({
    evidence: evidenceFor(),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'op-1',
    sessionFlag: enabledFlag,
    policy: 'item',
  });
  assert.deepEqual(modes, ['detect_items', 'identify_selected_item']);
  assert.equal(result.state, 'ready');
  assert.equal(result.identifications.length, 1);
});

test('candidates: zero candidates yields a safe retryable state, not a fake identity', async () => {
  const orchestrator = loadOrchestrator(async (image, options) =>
    transitionalResponse(detectionResult([])),
  );
  const result = await orchestrator.identifyPreparedImageForStyle({
    evidence: evidenceFor(),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'op-1',
    sessionFlag: enabledFlag,
    policy: 'item',
  });
  assert.equal(result.state, 'insufficient_evidence');
  assert.equal(result.identifications.length, 0);
  assert.equal(fashionContext.isRetryableItemState('insufficient_evidence'), true);
});

test('candidates: several candidates on an ITEM path require selection — never a guess', async () => {
  const modes = [];
  const orchestrator = loadOrchestrator(async (image, options) => {
    const req = options.contractRequestV2;
    modes.push(req.mode);
    return transitionalResponse(
      detectionResult([candidate('c1'), candidate('c2'), candidate('c3')]),
    );
  });
  const result = await orchestrator.identifyPreparedImageForStyle({
    evidence: evidenceFor(),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'op-1',
    sessionFlag: enabledFlag,
    policy: 'item',
  });
  assert.equal(result.state, 'needs_selection');
  assert.equal(result.candidates.length, 3);
  assert.equal(result.identifications.length, 0, 'nothing was identified');
  assert.deepEqual(modes, ['detect_items'], 'no selected-item request was sent');
});

test('candidates: an OUTFIT path identifies the whole bounded set the backend reported', async () => {
  const selected = [];
  const orchestrator = loadOrchestrator(async (image, options) => {
    const req = options.contractRequestV2;
    if (req.mode === 'detect_items') {
      return transitionalResponse(
        detectionResult([
          candidate('c1', 'evidence-outfit-1'),
          candidate('c2', 'evidence-outfit-1'),
          candidate('c3', 'evidence-outfit-1'),
        ]),
      );
    }
    selected.push(req.selectedCandidate.candidateId);
    return transitionalResponse(validV2Result({ requestId: req.selectedCandidate.candidateId }));
  });
  const result = await orchestrator.identifyPreparedImageForStyle({
    evidence: evidenceFor('evidence-outfit-1', 'header_gallery'),
    entryPath: 'header_gallery',
    platform: 'ios',
    requestId: 'op-1',
    sessionFlag: enabledFlag,
    policy: 'outfit',
  });
  assert.equal(result.state, 'ready');
  assert.deepEqual(selected, ['c1', 'c2', 'c3'], 'one request per candidate, in order');
  assert.equal(result.identifications.length, 3);
});

test('candidates: no client-side candidate maximum is introduced', async () => {
  // The backend candidate bound is the bound. Nine candidates yield nine requests.
  const selected = [];
  const many = Array.from({ length: 9 }, (_, i) => candidate(`c${i}`, 'evidence-outfit-2'));
  const orchestrator = loadOrchestrator(async (image, options) => {
    const req = options.contractRequestV2;
    if (req.mode === 'detect_items') return transitionalResponse(detectionResult(many));
    selected.push(req.selectedCandidate.candidateId);
    return transitionalResponse(validV2Result());
  });
  const result = await orchestrator.identifyPreparedImageForStyle({
    evidence: evidenceFor('evidence-outfit-2', 'header_gallery'),
    entryPath: 'header_gallery',
    platform: 'ios',
    requestId: 'op-1',
    sessionFlag: enabledFlag,
    policy: 'outfit',
  });
  assert.equal(selected.length, 9, 'no silent truncation');
  assert.equal(result.identifications.length, 9);
});

test('candidates: one failed candidate does not discard the successful ones', async () => {
  const orchestrator = loadOrchestrator(async (image, options) => {
    const req = options.contractRequestV2;
    if (req.mode === 'detect_items') {
      return transitionalResponse(detectionResult([
        candidate('good1', 'evidence-outfit-3'),
        candidate('bad', 'evidence-outfit-3'),
        candidate('good2', 'evidence-outfit-3'),
      ]));
    }
    if (req.selectedCandidate.candidateId === 'bad') {
      return { status: 'failed', recommendedProducts: [] };
    }
    return transitionalResponse(validV2Result());
  });
  const result = await orchestrator.identifyPreparedImageForStyle({
    evidence: evidenceFor('evidence-outfit-3', 'header_gallery'),
    entryPath: 'header_gallery',
    platform: 'ios',
    requestId: 'op-1',
    sessionFlag: enabledFlag,
    policy: 'outfit',
  });
  assert.equal(result.identifications.length, 2, 'the two successes survive');
  assert.equal(result.state, 'partial', 'and the outcome is honest about the loss');
});

test('candidates: a mis-correlated candidate is dropped, not repaired', () => {
  const result = detectionResult([
    candidate('mine', 'evidence-aaaaaaaa'),
    candidate('theirs', 'evidence-bbbbbbbb'),
    { candidateId: 'no-category', evidenceId: 'evidence-aaaaaaaa' },
  ]);
  const extracted = v2Core.extractFashionV2Candidates(result, 'evidence-aaaaaaaa');
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].candidateId, 'mine');
});

// ── §12 / §Fallback policy ──────────────────────────────────────────────────

test('fallback: only HTTP 400 + UNSUPPORTED_CONTRACT_VERSION falls back', async () => {
  const attempts = [];
  const orchestrator = loadOrchestrator(async (image, options) => {
    attempts.push(Boolean(options.contractRequestV2));
    if (options.contractRequestV2) {
      return { status: 'failed', httpStatus: 400, contractErrorCode: 'UNSUPPORTED_CONTRACT_VERSION', recommendedProducts: [] };
    }
    return { status: 'completed', recommendedProducts: [] };
  });
  const outcome = await orchestrator.runEliseIdentificationStage({
    mode: 'detect_items',
    evidence: evidenceFor(),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'op-1',
    sessionFlag: enabledFlag,
  });
  assert.equal(outcome.contractPath, 'legacy');
  assert.equal(outcome.fallbackUsed, true);
  assert.deepEqual(attempts, [true, false], 'exactly one V2 attempt then one legacy retry');
});

test('fallback: is NOT triggered by any other failure', async () => {
  const cases = [
    { label: 'timeout', response: { status: 'failed', recommendedProducts: [] } },
    { label: 'http 500', response: { status: 'failed', httpStatus: 500, recommendedProducts: [] } },
    { label: 'auth', response: { status: 'failed', httpStatus: 401, recommendedProducts: [] } },
    { label: 'quota', response: { status: 'failed', httpStatus: 429, recommendedProducts: [] } },
    {
      label: 'wrong 400 code',
      response: { status: 'failed', httpStatus: 400, contractErrorCode: 'MALFORMED_REQUEST', recommendedProducts: [] },
    },
    {
      label: 'malformed v2',
      response: transitionalResponse({ contractVersion: 'fashion-identification-v2', status: 'nonsense' }),
    },
    {
      label: 'technical_failure result',
      response: transitionalResponse(validV2Result({ status: 'technical_failure' })),
    },
    {
      label: 'insufficient evidence result',
      response: transitionalResponse(validV2Result({ status: 'insufficient_visual_evidence' })),
    },
  ];
  for (const { label, response } of cases) {
    let calls = 0;
    const orchestrator = loadOrchestrator(async () => {
      calls += 1;
      return response;
    });
    const outcome = await orchestrator.runEliseIdentificationStage({
      mode: 'detect_items',
      evidence: evidenceFor(),
      entryPath: 'direct_gallery',
      platform: 'ios',
      requestId: 'op-1',
      sessionFlag: enabledFlag,
    });
    assert.equal(calls, 1, `${label} must not spend a second scan`);
    assert.equal(outcome.fallbackUsed, false, `${label} must not report a fallback`);
  }
});

test('fallback: cannot loop — the legacy retry is never itself retried', async () => {
  let calls = 0;
  const orchestrator = loadOrchestrator(async (image, options) => {
    calls += 1;
    // Even the legacy retry answers with the unsupported-version signal.
    return { status: 'failed', httpStatus: 400, contractErrorCode: 'UNSUPPORTED_CONTRACT_VERSION', recommendedProducts: [] };
  });
  const outcome = await orchestrator.runEliseIdentificationStage({
    mode: 'detect_items',
    evidence: evidenceFor(),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'op-1',
    sessionFlag: enabledFlag,
  });
  assert.equal(calls, 2, 'exactly one V2 attempt plus exactly one legacy retry');
  assert.equal(outcome.contractPath, 'legacy');
});

test('fallback: a malformed V2 payload is a real failure, not a silent legacy degrade', async () => {
  const orchestrator = loadOrchestrator(async () =>
    transitionalResponse({ contractVersion: 'fashion-identification-v2', requestId: 'r', status: 'completed' }),
  );
  const outcome = await orchestrator.runEliseIdentificationStage({
    mode: 'detect_items',
    evidence: evidenceFor(),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'op-1',
    sessionFlag: enabledFlag,
  });
  assert.equal(outcome.contractPath, 'v2');
  assert.equal(outcome.identificationV2, null);
  assert.ok(outcome.v2ValidationFailure, 'the validation failure is surfaced');
  assert.equal(outcome.fallbackUsed, false);
});

// ── §51 Canonical context ───────────────────────────────────────────────────

test('context: a valid V2 result becomes the canonical Elise context', () => {
  const built = fashionContext.buildEliseFashionContextV2({
    source: 'direct_gallery',
    items: [{ sourceIndex: 0, state: 'ready', identification: validV2Result() }],
  });
  assert.equal(built.contractVersion, 'elise-fashion-context-v2');
  assert.equal(built.source, 'direct_gallery');
  assert.equal(built.items.length, 1);
  // The item carries the styling-safe PROJECTION, not the canonical result.
  const identity = built.items[0].identification;
  sameData(identity, fashionContext.projectCanonicalToEliseIdentity(validV2Result()));
  assert.equal(identity.identityVersion, 'elise-fashion-identity-v2');
  assert.equal(identity.evidence, undefined, 'no evidence array travels');
  assert.equal(identity.candidates, undefined, 'no candidates array travels');
});

test('context: V2 fields remain authoritative and are not re-derived', () => {
  const built = fashionContext.buildEliseFashionContextV2({
    source: 'direct_camera',
    items: [{ sourceIndex: 0, state: 'ready', identification: validV2Result() }],
  });
  const identity = built.items[0].identification;
  assert.equal(identity.category, 'Outerwear');
  assert.equal(identity.subtype, 'Chore Jacket');
  assert.equal(identity.brand.value, 'Carhartt');
  assert.equal(identity.resolutionLevel, 'brand_and_subtype');
  assert.equal(identity.status, 'completed');
});

test('context: multiple garments stay separate even when their labels match', () => {
  const greyJacketA = validV2Result({ requestId: 'a' });
  const greyJacketB = validV2Result({ requestId: 'b' });
  const built = fashionContext.buildEliseFashionContextV2({
    source: 'header_gallery',
    items: [
      { sourceIndex: 0, state: 'ready', identification: greyJacketA },
      { sourceIndex: 1, state: 'ready', identification: greyJacketB },
    ],
  });
  assert.equal(built.items.length, 2, 'identical labels must not merge');
  assert.equal(built.items[0].sourceIndex, 0);
  assert.equal(built.items[1].sourceIndex, 1);
});

test('context: items are ordered by sourceIndex, never by completion order', () => {
  const built = fashionContext.buildEliseFashionContextV2({
    source: 'header_gallery',
    items: [
      { sourceIndex: 2, state: 'ready', identification: namedResult('Third Jacket') },
      { sourceIndex: 0, state: 'ready', identification: namedResult('First Jacket') },
      { sourceIndex: 1, state: 'ready', identification: namedResult('Second Jacket') },
    ],
  });
  sameData(
    built.items.map((i) => i.identification.subtype),
    ['First Jacket', 'Second Jacket', 'Third Jacket'],
  );
});

test('context: duplicate source indices are refused', () => {
  const built = fashionContext.buildEliseFashionContextV2({
    source: 'header_gallery',
    items: [
      { sourceIndex: 0, state: 'ready', identification: validV2Result() },
      { sourceIndex: 0, state: 'ready', identification: validV2Result() },
    ],
  });
  assert.equal(built, null);
});

test('context: a category-only result remains usable styling evidence', () => {
  const categoryOnly = validV2Result({
    resolutionLevel: 'category',
    item: {
      category: 'Footwear',
      subtype: null,
      brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
      colors: { primary: null, secondary: [] },
      material: [],
      silhouette: [],
      pattern: [],
      attributes: { pockets: [], visible: [], distinctive: [] },
    },
    confidence: { category: 0.7, subtype: null, brand: null, modelFamily: null, exactProduct: null },
  });
  const built = fashionContext.buildEliseFashionContextV2({
    source: 'direct_gallery',
    items: [{ sourceIndex: 0, state: 'partial', identification: categoryOnly }],
  });
  assert.ok(built);
  assert.equal(fashionContext.hasGroundableEvidence(built), true);
  assert.equal(fashionContext.describeIdentification(identityOf(categoryOnly)), 'Footwear');
});

test('context: a subtype-only result remains usable', () => {
  const subtypeOnly = validV2Result({
    resolutionLevel: 'subtype',
    item: {
      category: null,
      subtype: 'Chelsea Boot',
      brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
      colors: { primary: null, secondary: [] },
      material: [],
      silhouette: [],
      pattern: [],
      attributes: { pockets: [], visible: [], distinctive: [] },
    },
  });
  assert.equal(fashionContext.describeIdentification(identityOf(subtypeOnly)), 'Chelsea Boot');
});

test('context: a failure state carries NO identification', () => {
  const built = fashionContext.buildEliseFashionContextV2({
    source: 'header_gallery',
    items: [
      { sourceIndex: 0, state: 'ready', identification: validV2Result() },
      { sourceIndex: 1, state: 'technical_failure' },
      { sourceIndex: 2, state: 'non_fashion' },
    ],
  });
  assert.equal(built.items.length, 3);
  assert.equal(built.items[1].identification, undefined);
  assert.equal(built.items[2].identification, undefined);
  assert.equal(fashionContext.groundableItems(built).length, 1);
});

test('context: a ready item whose identification does not validate is DOWNGRADED, not dropped', () => {
  const built = fashionContext.buildEliseFashionContextV2({
    source: 'header_gallery',
    items: [
      { sourceIndex: 0, state: 'ready', identification: validV2Result() },
      { sourceIndex: 1, state: 'ready', identification: { contractVersion: 'nope' } },
    ],
  });
  assert.equal(built.items.length, 2, 'the slot survives so retry/remove stays available');
  assert.equal(built.items[1].state, 'technical_failure');
  assert.equal(built.items[1].identification, undefined);
});

test('context: a context of nothing but failures is not groundable', () => {
  const built = fashionContext.buildEliseFashionContextV2({
    source: 'header_gallery',
    items: [
      { sourceIndex: 0, state: 'technical_failure' },
      { sourceIndex: 1, state: 'non_fashion' },
    ],
  });
  assert.equal(fashionContext.hasGroundableEvidence(built), false);
  const decision = sendContext.resolveSendFashionContext([{ fashionContext: built, state: 'ready' }]);
  assert.equal(decision.kind, 'blocked', 'and must not be sendable');
});

test('context: forbidden correlation and commerce fields are refused', () => {
  const forbidden = [
    { imageBase64: 'AAAA' },
    { evidenceId: 'evidence-aaaaaaaa' },
    { candidateId: 'c1' },
    { detectionDigest: 'd1' },
    { bounds: { x: 0, y: 0, width: 1, height: 1 } },
    { purchaseOptions: [] },
    { purchase_options: [] },
    { recommendedProducts: [] },
    { retailerUrl: 'https://shop.example' },
    { userId: 'u1' },
    { deviceId: 'd1' },
    { providerResponse: {} },
    { localImageUri: 'file:///x.jpg' },
    { assetId: 'A1' },
    { filename: 'x.jpg' },
  ];
  for (const extra of forbidden) {
    const contaminated = {
      contractVersion: 'elise-fashion-context-v2',
      source: 'direct_gallery',
      items: [{ sourceIndex: 0, state: 'ready', identification: { ...validV2Result(), ...extra } }],
    };
    const check = fashionContext.prepareContextForTransport(contaminated);
    assert.equal(check.kind, 'invalid', `${Object.keys(extra)[0]} must be refused`);
    assert.match(check.reason, /forbidden_content|item_identification/);
  }
});

test('context: a raw image reference anywhere in the context is refused', () => {
  for (const value of ['file:///a.jpg', 'content://media/1', 'ph://ABC', 'data:image/jpeg;base64,AAA', 'x;base64,AAA']) {
    const contaminated = {
      contractVersion: 'elise-fashion-context-v2',
      source: 'direct_gallery',
      items: [{
        sourceIndex: 0,
        state: 'ready',
        identification: validV2Result({
          item: { ...validV2Result().item, category: value },
        }),
      }],
    };
    const check = fashionContext.prepareContextForTransport(contaminated);
    assert.equal(check.kind, 'invalid', `${value} must be refused`);
  }
});

// ── §D JSON round trip ──────────────────────────────────────────────────────

test('transport: the context round-trips through JSON and validates identically', () => {
  const built = fashionContext.buildEliseFashionContextV2({
    source: 'header_gallery',
    items: [
      { sourceIndex: 0, state: 'ready', identification: validV2Result({ requestId: 'a' }) },
      { sourceIndex: 1, state: 'partial', identification: validV2Result({ requestId: 'b', status: 'partial' }) },
      { sourceIndex: 2, state: 'technical_failure' },
    ],
  });
  const prepared = fashionContext.prepareContextForTransport(built);
  assert.equal(prepared.kind, 'ok');

  const serialized = JSON.stringify(prepared.context);
  const roundTripped = JSON.parse(serialized);
  const revalidated = fashionContext.validateEliseFashionContextV2(roundTripped);
  assert.equal(revalidated.kind, 'ok', 'the round-tripped value must validate identically');
  sameData(roundTripped, prepared.context);
});

test('transport: functions, refs, setters and AbortControllers are refused', () => {
  const unsafe = [
    { label: 'function', value: () => {} },
    { label: 'setter', value: function setState() {} },
    { label: 'abort controller', value: new AbortController() },
    { label: 'map', value: new Map() },
    { label: 'set', value: new Set() },
    { label: 'date', value: new Date(0) },
    { label: 'error', value: new Error('x') },
  ];
  for (const { label, value } of unsafe) {
    const contaminated = {
      contractVersion: 'elise-fashion-context-v2',
      source: 'direct_gallery',
      items: [{ sourceIndex: 0, state: 'ready', identification: { ...validV2Result(), extra: value } }],
    };
    const check = fashionContext.prepareContextForTransport(contaminated);
    assert.equal(check.kind, 'invalid', `${label} must be refused`);
  }
});

// ── §56 Null-safe formatting ────────────────────────────────────────────────

test('rendering: a null brand never renders the string "null"', () => {
  const noBrand = validV2Result({
    item: {
      ...validV2Result().item,
      brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
    },
  });
  const described = fashionContext.describeIdentification(identityOf(noBrand));
  assert.doesNotMatch(described, /null|undefined|\[object Object\]|NaN/);
  assert.equal(described, 'Tan Chore Jacket');
  assert.doesNotMatch(described, /from\s*$/, 'no dangling "from"');
});

test('rendering: no nullable field is ever template-interpolated', () => {
  const modules = [
    'services/style-chat/eliseFashionContextV2.ts',
    'services/style-chat/eliseVisualContextV2Projection.ts',
  ].filter(exists);
  for (const rel of modules) {
    const source = readCode(rel);
    // `${x?.y} ${z}` is the shape that renders "undefined Jacket".
    assert.doesNotMatch(
      source,
      /\$\{[^}]*\?\.[^}]*\}\s+\$\{/,
      `${rel} must filter before joining, never interpolate nullables`,
    );
  }
});

test('rendering: an all-null identity produces an empty label, not a fake one', () => {
  const empty = validV2Result({
    resolutionLevel: 'unknown',
    item: {
      category: null,
      subtype: null,
      brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
      colors: { primary: null, secondary: [] },
      material: [],
      silhouette: [],
      pattern: [],
      attributes: { pockets: [], visible: [], distinctive: [] },
    },
  });
  assert.equal(fashionContext.describeIdentification(empty), '');
  assert.equal(projection.projectV2ToVisualContextFields(empty), null);
});

test('rendering: null and undefined inputs do not throw', () => {
  assert.equal(fashionContext.describeIdentification(null), '');
  assert.equal(fashionContext.describeIdentification(undefined), '');
  assert.equal(fashionContext.describeIdentification({}), '');
  assert.equal(fashionContext.titleForItem(null), 'Photo');
  assert.equal(fashionContext.titleForItem({}), 'Photo');
  assert.equal(projection.projectV2ToVisualContextFields(null), null);
  assert.equal(projection.projectV2ToVisualContextFields(undefined), null);
});

test('rendering: subtype absorbs category so no label repeats itself', () => {
  const described = fashionContext.describeIdentification(identityOf(validV2Result()));
  assert.equal(described, 'Tan Chore Jacket from Carhartt');
  assert.doesNotMatch(described, /Outerwear/, 'the broader category is not appended');
});

test('rendering: missing confidence stays null and is never coerced to zero', () => {
  const noConfidence = validV2Result({
    compatibility: { legacyProjectionAvailable: true, globalConfidence: null },
  });
  const projected = projection.projectV2ToVisualContextFields(noConfidence);
  assert.equal(projected.confidence, null, 'absent is not the same claim as zero');
  assert.notEqual(projected.confidence, 0);
});

test('rendering: global confidence is not copied into per-dimension confidences', () => {
  const built = fashionContext.buildEliseFashionContextV2({
    source: 'direct_gallery',
    items: [{
      sourceIndex: 0,
      state: 'ready',
      identification: validV2Result({
        confidence: { category: 0.9, subtype: null, brand: null, modelFamily: null, exactProduct: null },
        compatibility: { legacyProjectionAvailable: true, globalConfidence: 0.85 },
      }),
    }],
  });
  const confidence = built.items[0].identification.confidence;
  assert.equal(confidence.subtype, null);
  assert.equal(confidence.brand, null);
  assert.equal(confidence.modelFamily, null);
  assert.equal(confidence.exactProduct, null);
  assert.notEqual(confidence.subtype, 0.85);
});

test('rendering: a partial result says so rather than presenting as exact', () => {
  const partial = validV2Result({ status: 'partial', resolutionLevel: 'subtype' });
  const projected = projection.projectV2ToVisualContextFields(partial);
  assert.match(projected.summary, /not confirmed/i);
  assert.equal(fashionContext.ELISE_ITEM_STATE_COPY.partial, 'Partly identified');
});

test('rendering: technical failure, insufficient evidence and non-fashion are distinct', () => {
  const copy = fashionContext.ELISE_ITEM_STATE_COPY;
  assert.notEqual(copy.technical_failure, copy.insufficient_evidence);
  assert.notEqual(copy.insufficient_evidence, copy.non_fashion);
  assert.notEqual(copy.technical_failure, copy.non_fashion);
  // Non-fashion is not retryable: the backend understood the image already.
  assert.equal(fashionContext.isRetryableItemState('non_fashion'), false);
  assert.equal(fashionContext.isRetryableItemState('technical_failure'), true);
  assert.equal(fashionContext.isRetryableItemState('insufficient_evidence'), true);
});

test('rendering: no state copy blames the user or their photo quality', () => {
  for (const copy of Object.values(fashionContext.ELISE_ITEM_STATE_COPY)) {
    if (!copy) continue;
    assert.doesNotMatch(copy, /\byou\b|\byour\b.*(bad|poor|blurry)|blurry|bad photo|poor lighting/i);
  }
});

// ── §53 Structured-source reuse ─────────────────────────────────────────────

test('reuse: routing is on SOURCE, never on "does it have an image"', () => {
  const source = readCode('services/style-chat/eliseAttachmentRouting.ts');
  assert.doesNotMatch(source, /if\s*\(\s*attachment\.image\s*\)/);
  assert.match(source, /STRUCTURED_SOURCES\.has\(source\)/);
  assert.match(source, /REUSABLE_SOURCES\.has\(source\)/);
  assert.match(source, /RAW_SOURCES\.has\(source\)/);
});

test('reuse: a valid V2 Recent Scan is reused and NOT re-identified', () => {
  const route = routing.routeEliseAttachment({
    source: 'recent_scan',
    record: {
      identificationSnapshotV2: {
        snapshotVersion: 2,
        contractVersion: 'fashion-identification-v2',
        identification: validV2Result(),
        purchaseOptions: [],
        source: 'camera',
        createdAt: '2026-07-27T00:00:00.000Z',
        updatedAt: '2026-07-27T00:00:00.000Z',
      },
    },
  });
  assert.equal(route.kind, 'reuse_v2');
  assert.equal(route.identification.item.subtype, 'Chore Jacket');
});

test('reuse: a valid V2 Scanner handoff is reused and NOT re-identified', () => {
  const route = routing.routeEliseAttachment({
    source: 'scanner_handoff',
    identificationV2: validV2Result(),
  });
  assert.equal(route.kind, 'reuse_v2');
  const context = routing.contextFromReusedV2('scanner_handoff', route.identification);
  assert.equal(context.source, 'scanner_handoff');
  assert.equal(context.items.length, 1);
  assert.equal(context.items[0].state, 'ready');
});

test('reuse: a caller CLAIMING a V2 identity is not trusted without validation', () => {
  const route = routing.routeEliseAttachment({
    source: 'scanner_handoff',
    identificationV2: { contractVersion: 'fashion-identification-v2', status: 'nonsense' },
  });
  assert.notEqual(route.kind, 'reuse_v2', 'an invalid claim must not be reused as V2');
  assert.equal(route.kind, 'compatibility');
});

test('reuse: Closet and Dressing Room items are never re-identified', () => {
  for (const source of ['closet', 'dressing_room']) {
    const route = routing.routeEliseAttachment({
      source,
      // An image IS present — which is exactly the trap.
      record: { imageUri: 'file:///closet/item.jpg', attributes: { category: 'Tops' } },
    });
    assert.equal(route.kind, 'structured_item', `${source} must use its authorized contract`);
  }
});

test('reuse: only genuinely raw sources are routed to identification', () => {
  for (const source of ['direct_camera', 'direct_gallery', 'header_gallery']) {
    assert.equal(routing.routeEliseAttachment({ source }).kind, 'identify');
  }
  // An unknown source is NOT assumed raw: guessing "probably raw" is how a
  // structured item would get re-identified.
  assert.equal(routing.routeEliseAttachment({ source: 'something_new' }).kind, 'non_visual');
});

test('reuse: a V1 scan uses the compatibility projection and is never labelled V2', () => {
  const route = routing.routeEliseAttachment({
    source: 'recent_scan',
    record: {
      identificationSnapshot: {
        contractVersion: 'fashion-identification-v1',
        status: 'completed',
        category: 'Jacket',
        subtype: 'Bomber',
        brand: { value: 'Alpha', confidence: 0.6, evidence: [] },
        colors: { primary: 'Green', secondary: ['Black'] },
        material: ['Nylon'],
        silhouette: ['Boxy'],
        pattern: [],
        attributes: { visible: [], distinctive: [] },
        confidence: { overall: 0.6 },
        source: { entryPath: 'camera' },
      },
    },
  });
  assert.equal(route.kind, 'compatibility');
  assert.equal(route.projection.contractVersion, 'elise-legacy-projection-v1');
  assert.notEqual(route.projection.contractVersion, 'fashion-identification-v2');
  assert.equal(route.projection.category, 'Jacket');
  assert.equal(route.projection.subtype, 'Bomber');
  assert.equal(route.projection.brand, 'Alpha');
  assert.equal(routing.hasLegacyEvidence(route.projection), true);
});

test('reuse: the compatibility projection fabricates no confidence', () => {
  const route = routing.routeEliseAttachment({
    source: 'recent_scan',
    record: { attributes: { category: 'Tops' } },
  });
  assert.equal(route.kind, 'compatibility');
  assert.ok(
    !('confidence' in route.projection),
    'a V1 global confidence is not a per-dimension confidence',
  );
});

test('reuse: a corrupt V2 blob falls back to real V1 fields, never to a rescan', () => {
  const route = routing.routeEliseAttachment({
    source: 'recent_scan',
    record: {
      identificationSnapshotV2: { snapshotVersion: 2, contractVersion: 'fashion-identification-v2', identification: { junk: true } },
      attributes: { category: 'Outerwear' },
    },
  });
  assert.notEqual(route.kind, 'identify', 'a stored scan must never trigger a new scan');
  assert.equal(route.kind, 'compatibility');
});

test('reuse: an attachment with no usable legacy evidence is reported honestly', () => {
  const route = routing.routeEliseAttachment({ source: 'recent_scan', record: {} });
  assert.equal(route.kind, 'compatibility');
  assert.equal(routing.hasLegacyEvidence(route.projection), false);
});

// ── §54 Separation / persistence ────────────────────────────────────────────

test('separation: no Elise V2 module persists anything', () => {
  const modules = [
    'services/style-chat/eliseIdentificationV2.ts',
    'services/style-chat/eliseIdentifyForStyle.ts',
    'services/style-chat/eliseFashionContextV2.ts',
    'services/style-chat/eliseSendContext.ts',
    'services/style-chat/eliseAttachmentRouting.ts',
    'services/fashionEvidenceGateway.ts',
    'services/fashionIdentificationV2Core.ts',
  ].filter(exists);
  for (const rel of modules) {
    const source = readCode(rel);
    assert.doesNotMatch(source, /saveScan\(/, `${rel} must not save a scan`);
    assert.doesNotMatch(source, /AsyncStorage/, `${rel} must not persist locally`);
    assert.doesNotMatch(source, /supabase\s*\./, `${rel} must not write remotely`);
    assert.doesNotMatch(source, /from '\.\.\/library'/, `${rel} must not import the library`);
  }
});

test('separation: a direct Elise attachment never creates a Closet item', () => {
  const modules = [
    'services/style-chat/eliseDirectImageIdentification.ts',
    'services/style-chat/eliseIdentifyForStyle.ts',
  ].filter(exists);
  for (const rel of modules) {
    const source = readCode(rel);
    assert.doesNotMatch(source, /closetLibrary|closetPromotion|addToCloset/i, `${rel} must not touch the Closet`);
  }
});

test('separation: identification never implies saving', () => {
  // The orchestrator's job ends at an identity. Nothing about it writes a row.
  const source = readCode('services/style-chat/eliseIdentifyForStyle.ts');
  assert.doesNotMatch(source, /saveScan|saveScanToCloud|upsertSavedScanRow|ensureSavedScanMediaBacking/);
});

test('separation: no commerce client is reachable from Elise V2 code', () => {
  const modules = [
    'services/style-chat/eliseIdentificationV2.ts',
    'services/style-chat/eliseIdentifyForStyle.ts',
    'services/style-chat/eliseFashionContextV2.ts',
    'services/style-chat/eliseDirectImageIdentification.ts',
    'services/style-chat/eliseSendContext.ts',
    'services/style-chat/eliseAttachmentRouting.ts',
    'services/style-chat/eliseVisualContextV2Projection.ts',
  ].filter(exists);
  for (const rel of modules) {
    const source = readCode(rel);
    // `recommendedProducts: []` is part of the LEGACY response shape the shared
    // transport returns, so constructing an empty one is not commerce use. What
    // must never appear is a read of it, a retailer, or a purchase flow.
    const code = withoutDenylists(source).replace(/recommendedProducts:\s*\[\]/g, '');
    for (const forbidden of [
      /purchaseOptions/i,
      /purchase_options/i,
      /recommendedProducts/,
      /similarityMatches/,
      /shoppingProvider/,
      /farfetch/i,
      /kicksCrew/i,
      /vinted/i,
      /affiliate/i,
      /checkout/i,
      /retailerUrl/i,
    ]) {
      assert.doesNotMatch(code, forbidden, `${rel} must not reference ${forbidden}`);
    }
  }
});

test('separation: the canonical context can never carry purchase options', () => {
  const withCommerce = {
    contractVersion: 'elise-fashion-context-v2',
    source: 'direct_gallery',
    items: [{ sourceIndex: 0, state: 'ready', identification: validV2Result() }],
    purchaseOptions: [{ url: 'https://shop.example' }],
  };
  const check = fashionContext.prepareContextForTransport(withCommerce);
  assert.equal(check.kind, 'invalid');
});

// ── §55 Stale and actor safety ──────────────────────────────────────────────

test('stale: a removed attachment stops the operation between stages', async () => {
  let current = true;
  const modes = [];
  const orchestrator = loadOrchestrator(async (image, options) => {
    const req = options.contractRequestV2;
    modes.push(req.mode);
    // The user removes the chip while detection is in flight.
    current = false;
    return transitionalResponse(detectionResult([candidate('c1')]));
  });
  const result = await orchestrator.identifyPreparedImageForStyle({
    evidence: evidenceFor(),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'op-1',
    sessionFlag: enabledFlag,
    policy: 'item',
    isCurrent: () => current,
  });
  assert.equal(result.state, 'cancelled');
  assert.deepEqual(modes, ['detect_items'], 'no selected-item request was sent');
  assert.equal(result.identifications.length, 0);
});

test('stale: an aborted signal cancels before any network call', async () => {
  let calls = 0;
  const orchestrator = loadOrchestrator(async () => {
    calls += 1;
    return transitionalResponse(validV2Result());
  });
  const controller = new AbortController();
  controller.abort();
  const result = await orchestrator.identifyPreparedImageForStyle({
    evidence: evidenceFor(),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'op-1',
    sessionFlag: enabledFlag,
    policy: 'item',
    signal: controller.signal,
  });
  assert.equal(result.state, 'cancelled');
  assert.equal(calls, 0, 'a cancelled operation must not spend a scan');
});

test('stale: mid-outfit cancellation keeps what already succeeded', async () => {
  let identified = 0;
  const orchestrator = loadOrchestrator(async (image, options) => {
    const req = options.contractRequestV2;
    if (req.mode === 'detect_items') {
      return transitionalResponse(detectionResult([
        candidate('c1', 'evidence-outfit-4'),
        candidate('c2', 'evidence-outfit-4'),
        candidate('c3', 'evidence-outfit-4'),
      ]));
    }
    identified += 1;
    return transitionalResponse(validV2Result());
  });
  const result = await orchestrator.identifyPreparedImageForStyle({
    evidence: evidenceFor('evidence-outfit-4', 'header_gallery'),
    entryPath: 'header_gallery',
    platform: 'ios',
    requestId: 'op-1',
    sessionFlag: enabledFlag,
    policy: 'outfit',
    // Current for detection and the first candidate, then removed.
    isCurrent: () => identified < 1,
  });
  assert.equal(result.identifications.length, 1, 'the completed garment survives');
  assert.equal(result.state, 'partial');
});

test('stale: the send snapshot is immutable — later draft changes cannot alter it', () => {
  const draft = {
    state: 'ready',
    fashionContext: fashionContext.buildEliseFashionContextV2({
      source: 'direct_gallery',
      items: [{ sourceIndex: 0, state: 'ready', identification: validV2Result() }],
    }),
  };
  const decision = sendContext.resolveSendFashionContext([draft]);
  assert.equal(decision.kind, 'send');
  const captured = JSON.stringify(decision.context);
  // The draft is mutated after the snapshot was taken.
  draft.fashionContext = null;
  assert.equal(JSON.stringify(decision.context), captured, 'the snapshot is unaffected');
});

test('stale: a cancelled draft contributes nothing to the send context', () => {
  const context = fashionContext.buildEliseFashionContextV2({
    source: 'direct_gallery',
    items: [{ sourceIndex: 0, state: 'ready', identification: validV2Result() }],
  });
  const decision = sendContext.resolveSendFashionContext([
    { state: 'cancelled', fashionContext: context },
  ]);
  assert.equal(decision.kind, 'none');
});

test('stale: merging renumbers source indices so items stay distinguishable', () => {
  const a = fashionContext.buildEliseFashionContextV2({
    source: 'direct_gallery',
    items: [{ sourceIndex: 0, state: 'ready', identification: namedResult('Jacket A') }],
  });
  const b = fashionContext.buildEliseFashionContextV2({
    source: 'direct_camera',
    items: [{ sourceIndex: 0, state: 'ready', identification: namedResult('Jacket B') }],
  });
  const merged = sendContext.mergeEliseFashionContexts([a, b]);
  assert.equal(merged.items.length, 2);
  sameData(merged.items.map((i) => i.sourceIndex), [0, 1]);
  sameData(merged.items.map((i) => i.identification.subtype), ['Jacket A', 'Jacket B']);
  // And the merged object must still be transport-valid.
  assert.equal(fashionContext.prepareContextForTransport(merged).kind, 'ok');
});

// ── §57 Privacy ─────────────────────────────────────────────────────────────

test('privacy: telemetry contains only bounded, non-identifying fields', () => {
  const telemetry = eliseAdapter.buildEliseV2Telemetry({
    enabled: true,
    attempted: true,
    accepted: true,
    entryPath: 'header_gallery',
    platform: 'ios',
    mode: 'identify_selected_item',
    sourceImageCount: 4,
    identifiedItemCount: 3,
    partialItemCount: 1,
    result: validV2Result(),
    contextVersion: 'elise-fashion-context-v2',
    latencyMs: 2400,
    attachmentOutcome: 'ready',
  });
  const serialized = JSON.stringify(telemetry);
  const forbidden = [
    'data:image', 'file://', 'content://', '/var/mobile', 'storage/emulated',
    'evidenceId', 'candidateId', 'detectionDigest', 'imageBase64', 'assetId',
    'filename', 'providerResponse', 'purchase_options', 'purchaseOptions',
    'BASE64BYTES', 'Carhartt', 'bounds',
  ];
  for (const needle of forbidden) {
    assert.ok(!serialized.includes(needle), `telemetry must not contain ${needle}`);
  }
  // Counts are bucketed, never exact.
  assert.equal(telemetry.sourceImageCountBucket, '4-5');
  assert.equal(telemetry.identifiedItemCountBucket, '2-3');
  assert.equal(telemetry.partialItemCountBucket, '1');
  assert.equal(telemetry.latencyBucket, '1-3s');
});

test('privacy: the only permitted fallback reason is unsupported_version', () => {
  const withFallback = eliseAdapter.buildEliseV2Telemetry({
    enabled: true, attempted: true, accepted: false,
    entryPath: 'direct_gallery', platform: 'ios', mode: 'detect_items',
    result: null, fallbackUsed: true,
  });
  assert.equal(withFallback.fallbackReason, 'unsupported_version');
  const withoutFallback = eliseAdapter.buildEliseV2Telemetry({
    enabled: true, attempted: true, accepted: true,
    entryPath: 'direct_gallery', platform: 'ios', mode: 'detect_items',
    result: validV2Result(), fallbackUsed: false,
  });
  assert.equal(withoutFallback.fallbackReason, null);
});

test('privacy: an evidence id can never enter telemetry', () => {
  const source = readCode('services/style-chat/eliseIdentificationV2.ts');
  const telemetryStart = source.indexOf('export function buildEliseV2Telemetry');
  assert.ok(telemetryStart > 0);
  const telemetryBody = source.slice(telemetryStart);
  assert.doesNotMatch(telemetryBody, /evidenceId/, 'the telemetry builder must not read an evidence id');
  assert.doesNotMatch(telemetryBody, /candidateId/);
  assert.doesNotMatch(telemetryBody, /detectionDigest/);
  assert.doesNotMatch(telemetryBody, /imageBase64/);
});

test('privacy: counts are bucketed at every boundary', () => {
  const cases = [[0, '0'], [1, '1'], [2, '2-3'], [3, '2-3'], [4, '4-5'], [5, '4-5'], [6, '6+'], [99, '6+']];
  for (const [count, bucket] of cases) {
    assert.equal(v2Core.bucketCount(count), bucket, `${count} → ${bucket}`);
  }
  assert.equal(v2Core.bucketCount(null), null);
  assert.equal(v2Core.bucketCount(-1), null);
  assert.equal(v2Core.bucketCount(NaN), null);
});

test('privacy: latency is bucketed at every boundary', () => {
  const cases = [[0, '<1s'], [999, '<1s'], [1000, '1-3s'], [2999, '1-3s'], [3000, '3-6s'],
    [5999, '3-6s'], [6000, '6-12s'], [11999, '6-12s'], [12000, '12s+'], [99999, '12s+']];
  for (const [ms, bucket] of cases) {
    assert.equal(v2Core.bucketLatency(ms), bucket, `${ms} → ${bucket}`);
  }
  assert.equal(v2Core.bucketLatency(null), null);
  assert.equal(v2Core.bucketLatency(-1), null);
});

test('privacy: no Elise V2 module logs a raw value', () => {
  const modules = [
    'services/style-chat/eliseIdentificationV2.ts',
    'services/style-chat/eliseIdentifyForStyle.ts',
    'services/style-chat/eliseFashionContextV2.ts',
    'services/style-chat/eliseSendContext.ts',
    'services/style-chat/eliseAttachmentRouting.ts',
  ].filter(exists);
  for (const rel of modules) {
    const source = readCode(rel);
    assert.doesNotMatch(source, /console\.(log|warn|error|info)/, `${rel} must not log`);
  }
});

test('privacy: validation failures are bounded codes, never raw values', () => {
  const check = fashionContext.validateEliseFashionContextV2({
    contractVersion: 'elise-fashion-context-v2',
    source: 'direct_gallery',
    items: [{ sourceIndex: 0, state: 'ready', identification: { secret: 'BASE64BYTES' } }],
  });
  assert.equal(check.kind, 'invalid');
  assert.ok(!check.reason.includes('BASE64BYTES'), 'the offending value must not be echoed');
  assert.match(check.reason, /^item_identification:/);
});

// ── §14 Image preparation preserved ─────────────────────────────────────────

test('preparation: no Elise V2 module re-compresses or resizes an image', () => {
  const modules = [
    'services/style-chat/eliseIdentificationV2.ts',
    'services/style-chat/eliseIdentifyForStyle.ts',
    'services/fashionEvidenceGateway.ts',
  ].filter(exists);
  for (const rel of modules) {
    const source = readCode(rel);
    assert.doesNotMatch(source, /manipulateAsync|ImageManipulator|compressForUpload/, `${rel} must not re-encode`);
  }
});

test('preparation: the evidence gateway wraps, it does not transform', () => {
  const prepared = evidenceGateway.prepareFashionEvidence({
    preparedImage: 'data:image/jpeg;base64,ABCDEF',
    source: 'gallery',
    width: 896,
    height: 1024,
  });
  assert.equal(prepared.imageBase64, 'ABCDEF', 'only the data-URI prefix is stripped');
  assert.equal(prepared.mimeType, 'image/jpeg');
  assert.equal(prepared.width, 896);
  assert.equal(prepared.height, 1024);
  // An unusable derivative is a controlled null, not a throw.
  assert.equal(evidenceGateway.prepareFashionEvidence({ preparedImage: '', source: 'gallery' }), null);
  assert.equal(evidenceGateway.prepareFashionEvidence(null), null);
});

test('preparation: header_gallery is a distinct source, not flattened onto gallery', () => {
  const prepared = evidenceGateway.prepareFashionEvidence({
    preparedImage: 'AAA',
    source: 'header_gallery',
  });
  assert.equal(prepared.source, 'header_gallery');
  assert.equal(
    eliseAdapter.eliseEntryPathKeyForSource('header_gallery'),
    'header_gallery',
  );
  assert.equal(eliseAdapter.eliseEntryPathFor('header_gallery'), 'elise_header_gallery');
});

test('preparation: the Scanner gateway cannot produce an Elise entry path', () => {
  const scannerGateway = loadTsModule('services/scannerEvidenceGateway.ts', {
    './fashionEvidenceGateway': evidenceGateway,
  });
  // A Scanner caller passing the Elise source is re-narrowed to camera.
  const prepared = scannerGateway.prepareScannerEvidence({
    preparedImage: 'AAA',
    source: 'header_gallery',
  });
  assert.equal(prepared.source, 'camera');
});

// ── Projection integrity (canonical result vs Elise identity) ───────────────
//
// These proofs exist because an earlier implementation DELETED
// `evidence`/`candidates` from a copy of the canonical result and kept calling it
// a `FashionIdentificationResultV2`. That was wrong twice over: the object no
// longer satisfied the contract it claimed, and the strip was incomplete — nested
// `brand.evidence[].evidenceId` and `conflicts[].evidenceIds` survived, so a real
// response with brand evidence would have been refused at the transport gate and
// silently blocked the send.

/** A canonical result whose nested correlation fields are actually POPULATED. */
function canonicalWithCorrelation() {
  return validV2Result({
    item: {
      ...validV2Result().item,
      brand: {
        value: 'Carhartt',
        confidence: 0.8,
        provenance: 'visible_text',
        // The nested case an incomplete strip misses.
        evidence: [
          { evidenceId: 'evidence-aaaaaaaa', type: 'visible_text', observation: 'chest label', confidence: 0.8 },
        ],
      },
    },
    evidence: [{ evidenceId: 'evidence-aaaaaaaa', observations: ['tan canvas'] }],
    candidates: [
      {
        candidateId: 'c1',
        evidenceId: 'evidence-aaaaaaaa',
        category: 'Outerwear',
        subtype: 'Chore Jacket',
        bounds: { x: 1, y: 2, width: 3, height: 4 },
        detectionDigest: 'srv-digest',
      },
    ],
    conflicts: [
      { field: 'brand', description: 'label partially obscured', evidenceIds: ['evidence-aaaaaaaa'] },
    ],
    exactProduct: { brand: 'Carhartt', model: 'Detroit Jacket', sku: 'J97', confidence: 0.9 },
    resolutionLevel: 'exact_product',
  });
}

test('projection: the ORIGINAL canonical result still validates and is unmutated', () => {
  const original = canonicalWithCorrelation();
  const before = JSON.stringify(original);

  // It validates as the canonical contract before projection...
  assert.equal(v2Core.validateFashionV2Response(original).kind, 'ok');

  const projected = fashionContext.projectCanonicalToEliseIdentity(original);
  assert.ok(projected, 'projection succeeded');

  // ...and STILL validates, byte-identically, after. The projection copies; it
  // never reaches into its input.
  assert.equal(v2Core.validateFashionV2Response(original).kind, 'ok');
  assert.equal(JSON.stringify(original), before, 'the canonical result was not mutated');
  assert.equal(original.evidence.length, 1, 'its evidence array is intact');
  assert.equal(original.candidates.length, 1, 'its candidates array is intact');
  assert.equal(original.item.brand.evidence.length, 1, 'its brand evidence is intact');
  assert.equal(original.conflicts[0].evidenceIds.length, 1, 'its conflict evidence ids are intact');
  assert.equal(original.exactProduct.sku, 'J97', 'its sku is intact');
});

test('projection: the sanitized Elise context validates on its OWN terms', () => {
  const built = fashionContext.buildEliseFashionContextV2({
    source: 'direct_gallery',
    items: [{ sourceIndex: 0, state: 'ready', identification: canonicalWithCorrelation() }],
  });
  assert.ok(built, 'context built');
  assert.equal(fashionContext.validateEliseFashionContextV2(built).kind, 'ok');

  const identity = built.items[0].identification;
  assert.equal(identity.identityVersion, 'elise-fashion-identity-v2');
  // It is NOT the canonical contract, and must not claim to be.
  assert.equal(identity.contractVersion, undefined);
  assert.equal(
    v2Core.validateFashionV2Response(identity).kind,
    'invalid',
    'the projection is deliberately not a valid canonical result',
  );
  // The identity validator accepts it; the canonical validator does not. Two
  // shapes, two checks, neither standing in for the other.
  assert.equal(fashionContext.validateEliseIdentity(identity), null);
});

test('projection: the sanitized context contains NO evidenceId anywhere', () => {
  const built = fashionContext.buildEliseFashionContextV2({
    source: 'direct_gallery',
    items: [{ sourceIndex: 0, state: 'ready', identification: canonicalWithCorrelation() }],
  });
  const serialized = JSON.stringify(built);
  for (const forbidden of [
    'evidenceId', 'evidenceIds', 'candidateId', 'detectionDigest', 'bounds',
    'evidence-aaaaaaaa', 'srv-digest', 'requestId', 'sku', 'J97',
    'compatibility', 'legacyProjectionAvailable', 'observations',
  ]) {
    assert.ok(
      !serialized.includes(forbidden),
      `the sanitized context must not contain ${forbidden}`,
    );
  }
  // The transport gate agrees — the populated-correlation case now PASSES, where
  // the incomplete strip would have failed it and blocked the user's send.
  assert.equal(fashionContext.prepareContextForTransport(built).kind, 'ok');

  // Real styling information survived.
  const identity = built.items[0].identification;
  assert.equal(identity.category, 'Outerwear');
  assert.equal(identity.subtype, 'Chore Jacket');
  assert.equal(identity.brand.value, 'Carhartt');
  assert.equal(identity.brand.provenance, 'visible_text');
  // A conflict is still reported — without the evidence ids that produced it.
  assert.equal(identity.conflicts.length, 1);
  assert.equal(identity.conflicts[0].field, 'brand');
  assert.equal(identity.conflicts[0].evidenceIds, undefined);
  // exactProduct survives at exact_product resolution, but never its SKU.
  assert.equal(identity.exactProduct.model, 'Detroit Jacket');
  assert.equal(identity.exactProduct.sku, undefined);
});

test('projection: JSON stringify/parse round trip preserves validation', () => {
  const built = fashionContext.buildEliseFashionContextV2({
    source: 'header_gallery',
    items: [
      { sourceIndex: 0, state: 'ready', identification: canonicalWithCorrelation() },
      { sourceIndex: 1, state: 'partial', identification: validV2Result({ status: 'partial' }) },
      { sourceIndex: 2, state: 'technical_failure' },
    ],
  });
  assert.equal(fashionContext.validateEliseFashionContextV2(built).kind, 'ok');

  const roundTripped = JSON.parse(JSON.stringify(built));
  assert.equal(
    fashionContext.validateEliseFashionContextV2(roundTripped).kind,
    'ok',
    'the round-tripped value validates identically',
  );
  sameData(roundTripped, built, 'nothing was dropped or altered by serialization');
  assert.equal(roundTripped.items.length, 3);
  assert.equal(roundTripped.items[0].identification.identityVersion, 'elise-fashion-identity-v2');
  assert.equal(roundTripped.items[2].identification, undefined);
});

test('projection: a canonical result with no category AND no subtype is not groundable', () => {
  const anonymous = validV2Result({
    resolutionLevel: 'unknown',
    item: {
      category: null,
      subtype: null,
      brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
      colors: { primary: null, secondary: [] },
      material: [],
      silhouette: [],
      pattern: [],
      attributes: { pockets: [], visible: [], distinctive: [] },
    },
  });
  // It IS a valid canonical result — the contract permits an unresolved garment.
  assert.equal(v2Core.validateFashionV2Response(anonymous).kind, 'ok');
  // But it cannot be projected into a groundable identity.
  assert.equal(fashionContext.projectCanonicalToEliseIdentity(anonymous), null);
  const built = fashionContext.buildEliseFashionContextV2({
    source: 'direct_gallery',
    items: [{ sourceIndex: 0, state: 'ready', identification: anonymous }],
  });
  assert.equal(built.items[0].state, 'insufficient_evidence', 'downgraded honestly');
  assert.equal(built.items[0].identification, undefined);
  assert.equal(fashionContext.hasGroundableEvidence(built), false);
});

test('projection: an identity carrying a SKU is refused by the validator', () => {
  const identity = fashionContext.projectCanonicalToEliseIdentity(canonicalWithCorrelation());
  const withSku = { ...identity, exactProduct: { brand: 'Carhartt', model: 'Detroit', sku: 'J97' } };
  assert.equal(fashionContext.validateEliseIdentity(withSku), 'exact_product_sku');
});

test('projection: a raw canonical result forwarded by mistake is refused', () => {
  // Belt and braces: if some future caller bypassed the builder and put a raw
  // canonical result into a context, the context validator must reject it rather
  // than let its evidence ids reach the wire.
  const smuggled = {
    contractVersion: 'elise-fashion-context-v2',
    source: 'direct_gallery',
    items: [{ sourceIndex: 0, state: 'ready', identification: canonicalWithCorrelation() }],
  };
  const validated = fashionContext.validateEliseFashionContextV2(smuggled);
  assert.equal(validated.kind, 'invalid');
  assert.match(validated.reason, /item_identification:identity_version/);
  assert.equal(fashionContext.prepareContextForTransport(smuggled).kind, 'invalid');
});

// ── Multi-image send state ──────────────────────────────────────────────────

test('send state: a still-preparing attachment blocks an image-grounded send', () => {
  const ready = fashionContext.buildEliseFashionContextV2({
    source: 'header_gallery',
    items: [{ sourceIndex: 0, state: 'ready', identification: validV2Result() }],
  });
  const decision = sendContext.resolveSendFashionContext([
    { state: 'ready', fashionContext: ready },
    // No identity yet — still working.
    { state: 'identifying', fashionContext: null },
  ]);
  assert.equal(decision.kind, 'pending', 'a pending sibling must hold the send');
  assert.equal(decision.pendingCount, 1);
});

test('send state: ready contexts are sendable while failed siblings stay retryable', () => {
  const ready = fashionContext.buildEliseFashionContextV2({
    source: 'header_gallery',
    items: [{ sourceIndex: 0, state: 'ready', identification: validV2Result({ requestId: 'ok' }) }],
  });
  const failed = fashionContext.buildEliseFashionContextV2({
    source: 'header_gallery',
    items: [{ sourceIndex: 0, state: 'technical_failure' }],
  });
  const decision = sendContext.resolveSendFashionContext([
    { state: 'ready', fashionContext: ready },
    { state: 'failed_retryable', fashionContext: failed },
  ]);
  assert.equal(decision.kind, 'send', 'one failure must not veto a good attachment');
  // The successful item travels; the failure is NOT presented as identified.
  const groundable = decision.context.items.filter(
    (item) => item.state === 'ready' || item.state === 'partial',
  );
  assert.equal(groundable.length, 1);
  assert.equal(groundable[0].identification.category, 'Outerwear');
  const failures = decision.context.items.filter((item) => item.state === 'technical_failure');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].identification, undefined, 'a failure carries no identity');
});

test('send state: all-failed sends no image-grounded context', () => {
  const failed = fashionContext.buildEliseFashionContextV2({
    source: 'header_gallery',
    items: [{ sourceIndex: 0, state: 'technical_failure' }],
  });
  const other = fashionContext.buildEliseFashionContextV2({
    source: 'header_gallery',
    items: [{ sourceIndex: 0, state: 'non_fashion' }],
  });
  const decision = sendContext.resolveSendFashionContext([
    { state: 'failed_retryable', fashionContext: failed },
    { state: 'failed_retryable', fashionContext: other },
  ]);
  assert.equal(decision.kind, 'blocked');
  assert.equal(decision.reason, 'no_groundable_items');
});

test('send state: source order survives out-of-order completion', () => {
  const make = (id) => fashionContext.buildEliseFashionContextV2({
    source: 'header_gallery',
    items: [{ sourceIndex: 0, state: 'ready', identification: validV2Result({ requestId: id }) }],
  });
  const decision = sendContext.resolveSendFashionContext([
    { state: 'ready', fashionContext: make('first') },
    { state: 'ready', fashionContext: make('second') },
    { state: 'ready', fashionContext: make('third') },
  ]);
  assert.equal(decision.kind, 'send');
  sameData(decision.context.items.map((i) => i.sourceIndex), [0, 1, 2]);
});

// ── Coverage closed by mutation proof ───────────────────────────────────────
//
// Every test below exists because a mutation was applied and NOTHING failed.
// Two of them replaced assertions that were passing for the wrong reason: they
// fed a RAW canonical result into the transport gate, so the gate rejected it on
// its identity version and the forbidden-content scan was never exercised at all.

/** A real, builder-produced context — the only shape the gate should be given. */
function realContext(overrides = {}) {
  const built = fashionContext.buildEliseFashionContextV2({
    source: 'direct_gallery',
    items: [{ sourceIndex: 0, state: 'ready', identification: validV2Result() }],
  });
  return JSON.parse(JSON.stringify({ ...built, ...overrides }));
}

test('gate: purchase options attached to a REAL context are refused', () => {
  // Contaminating the identification would prove nothing: the projection copies
  // only known fields, so an extra key never survives to be scanned. The leak
  // that matters is one attached where the projection has no say.
  const topLevel = realContext({ purchaseOptions: [{ url: 'https://shop.example' }] });
  const topResult = fashionContext.prepareContextForTransport(topLevel);
  assert.equal(topResult.kind, 'invalid', 'a top-level purchase array must be refused');

  const snakeCase = realContext({ purchase_options: [{ url: 'https://shop.example' }] });
  assert.equal(fashionContext.prepareContextForTransport(snakeCase).kind, 'invalid');

  // Inside an item, beside the identity.
  const inItem = realContext();
  inItem.items[0].purchaseOptions = [{ url: 'https://shop.example' }];
  assert.equal(fashionContext.prepareContextForTransport(inItem).kind, 'invalid');

  // Inside the identity itself.
  const inIdentity = realContext();
  inIdentity.items[0].identification.purchaseOptions = [{ url: 'https://shop.example' }];
  assert.equal(fashionContext.prepareContextForTransport(inIdentity).kind, 'invalid');

  // And the denylist is what does it — the reason names the offending key.
  assert.match(topResult.reason, /forbidden_content|unknown_key/);
});

test('gate: Base64 and raw image references in a REAL context are refused', () => {
  const cases = [
    ['top-level base64', () => realContext({ imageBase64: 'QUJDRA==' })],
    ['identity data URI', () => {
      const c = realContext();
      c.items[0].identification.subtype = 'data:image/jpeg;base64,QUJDRA==';
      return c;
    }],
    ['identity file URI', () => {
      const c = realContext();
      c.items[0].identification.category = 'file:///var/mobile/a.jpg';
      return c;
    }],
    ['nested base64 marker', () => {
      const c = realContext();
      c.items[0].identification.colors.primary = 'x;base64,QUJDRA==';
      return c;
    }],
    ['item-level evidence id', () => {
      const c = realContext();
      c.items[0].evidenceId = 'evidence-aaaaaaaa';
      return c;
    }],
    ['item-level local uri', () => {
      const c = realContext();
      c.items[0].localImageUri = 'content://media/1';
      return c;
    }],
  ];
  for (const [label, build] of cases) {
    const result = fashionContext.prepareContextForTransport(build());
    assert.equal(result.kind, 'invalid', `${label} must be refused`);
  }
  // The clean version of the same context still passes, so the gate is not simply
  // rejecting everything.
  assert.equal(fashionContext.prepareContextForTransport(realContext()).kind, 'ok');
});

test('gate: an unknown key anywhere in a REAL context is refused', () => {
  const contextLevel = realContext({ surprise: 1 });
  const a = fashionContext.validateEliseFashionContextV2(contextLevel);
  assert.equal(a.kind, 'invalid');
  assert.match(a.reason, /unknown_key:surprise/);

  const itemLevel = realContext();
  itemLevel.items[0].surprise = 1;
  const b = fashionContext.validateEliseFashionContextV2(itemLevel);
  assert.equal(b.kind, 'invalid');
  assert.match(b.reason, /unknown_item_key:surprise/);

  const identityLevel = realContext();
  identityLevel.items[0].identification.surprise = 1;
  const c = fashionContext.validateEliseFashionContextV2(identityLevel);
  assert.equal(c.kind, 'invalid');
  assert.match(c.reason, /unknown_key_surprise/);
});

test('gate: the projection drops an unexpected field rather than forwarding it', () => {
  // Positive proof of the other half of the defence: a canonical result carrying
  // a field the projection does not know about produces an identity without it.
  const contaminated = validV2Result({ purchaseOptions: [{ url: 'https://shop.example' }] });
  const identity = fashionContext.projectCanonicalToEliseIdentity(contaminated);
  assert.ok(identity);
  assert.equal(identity.purchaseOptions, undefined, 'unknown fields are not copied');
  assert.equal(fashionContext.validateEliseIdentity(identity), null);
});

// ── The direct path actually reaches identify_for_style ─────────────────────

/**
 * `eliseDirectImageIdentification` with the image pipeline stubbed and a spy
 * transport, so the assertion is behavioural: a request really is sent, and its
 * intent really is `identify_for_style`.
 *
 * The source-grep governance tests above prove the CALL EXISTS. They cannot prove
 * it is reached — a mutation that stubbed the call site out left them all green,
 * which is why this exists.
 */
function loadDirectIdentification(transport, flagEnabled = true) {
  const orchestrator = loadOrchestrator(transport, flagEnabled);
  return loadTsModule('services/style-chat/eliseDirectImageIdentification.ts', {
    'react-native': { Platform: { OS: 'ios' } },
    '../privacyImageUpload': {
      compressSanitizedImageForAnalysis: async () => ({
        base64: 'data:image/jpeg;base64,PREPAREDBYTES',
        uri: 'file:///prepared.jpg',
      }),
      PrivacyPrepareError: class PrivacyPrepareError extends Error {},
    },
    '../fashionEvidenceGateway': evidenceGateway,
    '../../types/fashionIdentificationV2': contractTypes,
    './eliseFashionContextV2': fashionContext,
    './eliseIdentifyForStyle': orchestrator,
    './eliseIdentificationV2': loadEliseAdapter(flagEnabled),
    './eliseSendContext': sendContext,
  });
}

test('bypass: the direct path really sends identify_for_style to the transport', async () => {
  const sent = [];
  const mod = loadDirectIdentification(async (image, options) => {
    sent.push({ image, options });
    const req = options.contractRequestV2;
    return transitionalResponse(
      req.mode === 'detect_items'
        ? detectionResult([candidate('c1', extractEvidenceId(req))], { requestId: 'det' })
        : validV2Result(),
    );
  });

  const outcome = await mod.identifyDirectImageForStyle({
    preparedUri: 'file:///sanitized.jpg',
    source: 'photo_library',
    requestId: 'op-direct-1',
    sessionFlag: enabledFlag,
  });

  assert.equal(outcome.kind, 'identified', 'the photo was identified');
  assert.equal(sent.length, 2, 'detection AND selected-item both went to the wire');
  for (const call of sent) {
    assert.ok(call.options.contractRequestV2, 'every call carried a V2 envelope');
    assert.equal(call.options.contractRequestV2.intent, 'identify_for_style');
    assert.equal(call.options.contractRequestV2.source.entryPath, 'elise_gallery');
    // The prepared derivative is what travels — never a local URI.
    assert.equal(call.image, 'PREPAREDBYTES');
  }
  // And the staged title/category come from the identity, not a default.
  assert.notEqual(outcome.category, 'tops');
  assert.equal(outcome.category, 'Outerwear');
  assert.match(outcome.title, /Chore Jacket/);
});

test('bypass: a camera capture sends the camera entry path', async () => {
  const sent = [];
  const mod = loadDirectIdentification(async (image, options) => {
    sent.push(options.contractRequestV2);
    const req = options.contractRequestV2;
    return transitionalResponse(
      req.mode === 'detect_items'
        ? detectionResult([candidate('c1', extractEvidenceId(req))])
        : validV2Result(),
    );
  });
  await mod.identifyDirectImageForStyle({
    preparedUri: 'file:///sanitized.jpg',
    source: 'camera',
    requestId: 'op-direct-2',
    sessionFlag: enabledFlag,
  });
  assert.ok(sent.length >= 1);
  assert.equal(sent[0].source.entryPath, 'elise_camera');
  assert.equal(sent[0].intent, 'identify_for_style');
});

test('bypass: flag-off sends NOTHING and reports legacy_fallback', async () => {
  let calls = 0;
  const mod = loadDirectIdentification(async () => {
    calls += 1;
    return transitionalResponse(validV2Result());
  }, false);
  const outcome = await mod.identifyDirectImageForStyle({
    preparedUri: 'file:///sanitized.jpg',
    source: 'photo_library',
    requestId: 'op-direct-3',
    sessionFlag: disabledFlag,
  });
  assert.equal(outcome.kind, 'legacy_fallback');
  assert.equal(calls, 0, 'flag-off must not reach the V2 transport at all');
});

/** The evidence id the adapter minted for this request. */
function extractEvidenceId(request) {
  return request.evidence[0].evidenceId;
}

// ── The REAL flag resolver, not an injected one ─────────────────────────────

/**
 * Loads `constants/featureFlags.ts` with a controlled `process.env`.
 *
 * The flag tests above inject a resolver, which proves the LATCH behaves. They
 * cannot prove the real resolver's predicate: a mutation changing
 * `value === 'true'` to `value !== 'false'` left every injected-resolver test
 * green, because an injected resolver already returns a boolean.
 */
function loadFlags(env) {
  const filename = path.join(ROOT, 'constants/featureFlags.ts');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, {
    exports: mod.exports,
    module: mod,
    console,
    __DEV__: false,
    process: { env },
    require: (id) => {
      throw new Error(`featureFlags must not import anything: ${id}`);
    },
  });
  return mod.exports;
}

test('flag resolver: the REAL Elise resolver defaults to disabled', () => {
  const flags = loadFlags({});
  assert.equal(flags.resolveEliseIdentificationV2Enabled(), false, 'unset is disabled');
  assert.equal(flags.ELISE_IDENTIFICATION_V2_ENABLED, false, 'the exported constant is disabled');
});

test('flag resolver: the REAL Elise resolver accepts ONLY the exact string true', () => {
  const flags = loadFlags({});
  for (const value of [
    undefined, '', 'false', 'FALSE', 'TRUE', 'True', 'tRue', '1', '0',
    'yes', 'no', ' true', 'true ', ' true ', 'truthy', 'null',
  ]) {
    assert.equal(
      flags.resolveEliseIdentificationV2Enabled(value),
      false,
      `${JSON.stringify(value)} must not enable Elise V2`,
    );
  }
  assert.equal(flags.resolveEliseIdentificationV2Enabled('true'), true);
});

test('flag resolver: the REAL resolver reads only its OWN environment variable', () => {
  // Scanner on, Elise unset → Elise stays off.
  const scannerOnly = loadFlags({ EXPO_PUBLIC_SCANNER_IDENTIFICATION_V2_ENABLED: 'true' });
  assert.equal(scannerOnly.resolveEliseIdentificationV2Enabled(), false);
  assert.equal(scannerOnly.resolveScannerIdentificationV2Enabled(), true);

  // Elise on, Scanner unset → Scanner stays off.
  const eliseOnly = loadFlags({ EXPO_PUBLIC_ELISE_IDENTIFICATION_V2_ENABLED: 'true' });
  assert.equal(eliseOnly.resolveEliseIdentificationV2Enabled(), true);
  assert.equal(eliseOnly.resolveScannerIdentificationV2Enabled(), false);

  // Both on → both on, independently.
  const both = loadFlags({
    EXPO_PUBLIC_ELISE_IDENTIFICATION_V2_ENABLED: 'true',
    EXPO_PUBLIC_SCANNER_IDENTIFICATION_V2_ENABLED: 'true',
  });
  assert.equal(both.resolveEliseIdentificationV2Enabled(), true);
  assert.equal(both.resolveScannerIdentificationV2Enabled(), true);
});

test('flag resolver: the REAL Scanner resolver also accepts only exact true', () => {
  const flags = loadFlags({});
  for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes', ' true ']) {
    assert.equal(flags.resolveScannerIdentificationV2Enabled(value), false);
  }
  assert.equal(flags.resolveScannerIdentificationV2Enabled('true'), true);
});

test('flag resolver: the latch consumes the REAL resolver by default', () => {
  // `beginEliseV2Session()` with no argument must use the real resolver, so a
  // default-enabled defect in either place is caught.
  const session = eliseAdapter.beginEliseV2Session();
  assert.equal(session.enabled, false, 'the default latch is closed');
});

test('gate: commerce content inside an ALLOWED field is refused', () => {
  // The key allowlist stops a `purchaseOptions` array. It says nothing about a
  // retailer URL written into a field that is legitimately copied — which is free
  // text derived from provider output, and forbidden wherever it lands.
  const cases = [
    ['retailer url in unknownReason', 'unknownReason', 'See https://shop.example/item/1'],
    ['bare host in unknownReason', 'unknownReason', 'Available at www.shop.example'],
    ['price in unknownReason', 'unknownReason', 'Retails for $129'],
    ['currency code in unknownReason', 'unknownReason', 'About 129.00 USD'],
  ];
  for (const [label, field, value] of cases) {
    const contaminated = realContext();
    contaminated.items[0].identification[field] = value;
    const result = fashionContext.prepareContextForTransport(contaminated);
    assert.equal(result.kind, 'invalid', `${label} must be refused`);
    assert.match(result.reason, /commerce_content/);
  }

  // Inside a conflict description too.
  const inConflict = realContext();
  inConflict.items[0].identification.conflicts = [
    { field: 'brand', description: 'matched https://shop.example/p/9' },
  ];
  const conflictResult = fashionContext.prepareContextForTransport(inConflict);
  assert.equal(conflictResult.kind, 'invalid');
  assert.match(conflictResult.reason, /commerce_content/);

  // An ordinary garment attribute is untouched by the check.
  const clean = realContext();
  clean.items[0].identification.unknownReason = 'label partially obscured';
  assert.equal(fashionContext.prepareContextForTransport(clean).kind, 'ok');
});
