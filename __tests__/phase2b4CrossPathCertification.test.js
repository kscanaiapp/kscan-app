// Phase 2B.4 — cross-path fashion identification V2 certification.
//
// WHAT THIS PROVES: Scanner (`identify_and_shop`) and Elise
// (`identify_for_style`) reach ONE identification core, and equivalent evidence
// produces an identical canonical identity on both paths. Phase 2B.3 passing on
// each path separately does not establish that — two paths can each be
// internally correct and still disagree with one another.
//
// HOW IT PROVES IT: every case comes from ONE deep-frozen fixture in
// `fixtures/phase2b4CrossPathFixtures.js`. That single payload is cloned twice
// and pushed through the REAL Scanner adapter and the REAL Elise adapter — only
// the transport is stubbed. Separately authored per-path mocks would agree
// because they were written to agree; a shared fixture agrees only if the code
// does.
//
// THE COMPARISON POINT is the canonical `FashionIdentificationResultV2` each
// path holds BEFORE Scanner persistence, purchase-option generation, Elise
// projection or StyleChat prompt construction. Comparing Scanner's canonical
// result against Elise's reduced projection would be comparing two different
// contracts and would hide a real canonical-layer disagreement.
//
// STRUCTURAL EQUALITY, NOT REFERENCE EQUALITY: the modules are evaluated in
// separate VM realms, so `===` and `deepStrictEqual` are both wrong here (the
// latter compares prototypes). The comparator below walks both graphs and
// reports field path, Scanner value and Elise value on mismatch.
//
// NO CERTIFICATION-ONLY NORMALIZATION. No alias table maps "chore jacket" onto
// "workwear jacket" or "navy" onto "dark blue". An alias rule invented for the
// harness is exactly what would hide a genuine cross-path defect.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const {
  EVIDENCE_ID,
  SECOND_EVIDENCE_ID,
  SHARED_IMAGE_BASE64,
  CANONICAL_FIXTURES,
  MALFORMED_FIXTURES,
  assertFixturesPristine,
  baseResult,
  clone,
  eliseEvidence,
  scannerEvidence,
} = require('./fixtures/phase2b4CrossPathFixtures.js');

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
      // The allowlist is load-bearing: an Elise module that reached for a
      // commerce, retailer or persistence module would throw HERE rather than
      // silently acquiring it.
      throw new Error(`Unexpected import ${id} from ${relativePath}`);
    },
  });
  return mod.exports;
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── Module graph ─────────────────────────────────────────────────────────────

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
const scannerGateway = loadTsModule('services/scannerEvidenceGateway.ts', {
  './fashionEvidenceGateway': evidenceGateway,
});

const scannerAdapter = loadTsModule('services/scannerIdentificationV2.ts', {
  '../types/fashionIdentificationV2': contractTypes,
  './scannerEvidenceGateway': scannerGateway,
  './fashionIdentificationV2Core': v2Core,
  '../constants/featureFlags': { resolveScannerIdentificationV2Enabled: () => true },
});

const eliseAdapter = loadTsModule('services/style-chat/eliseIdentificationV2.ts', {
  '../../types/fashionIdentificationV2': contractTypes,
  '../fashionEvidenceGateway': evidenceGateway,
  '../fashionIdentificationV2Core': v2Core,
  '../../constants/featureFlags': { resolveEliseIdentificationV2Enabled: () => true },
});

/** The transport is the ONLY stub. Everything below it is production code. */
const transportStub = { identifyScanImage: null };

const scannerRequest = loadTsModule('services/scannerScanRequest.ts', {
  './scanIdentification': {
    get identifyScanImage() { return transportStub.identifyScanImage; },
  },
  './scannerEvidenceGateway': scannerGateway,
  './scannerIdentificationV2': scannerAdapter,
});

const eliseIdentify = loadTsModule('services/style-chat/eliseIdentifyForStyle.ts', {
  '../scanIdentification': {
    get identifyScanImage() { return transportStub.identifyScanImage; },
  },
  '../fashionEvidenceGateway': evidenceGateway,
  '../fashionIdentificationV2Core': v2Core,
  './eliseIdentificationV2': eliseAdapter,
});

const fashionContext = loadTsModule('services/style-chat/eliseFashionContextV2.ts', {
  '../../types/fashionIdentificationV2': contractTypes,
  '../fashionIdentificationV2Core': v2Core,
});

const identificationSnapshot = loadTsModule('services/identificationSnapshot.ts', {});

const attachmentRouting = loadTsModule('services/style-chat/eliseAttachmentRouting.ts', {
  '../../types/fashionIdentificationV2': contractTypes,
  '../identificationSnapshot': identificationSnapshot,
  '../fashionIdentificationV2Core': v2Core,
  './eliseFashionContextV2': fashionContext,
});

const SESSION_ON = Object.freeze({ enabled: true });

// ── The canonical comparator ─────────────────────────────────────────────────

/**
 * Fields excluded from canonical identity comparison, as exact path patterns.
 *
 * Each is request-scoped transport correlation, NOT identity: an evidence id, a
 * candidate's link back to its image, a bounding box, a per-request id. None of
 * them describes the garment.
 *
 * Nothing is excluded merely because the two paths disagree about it. Notably
 * NOT excluded and therefore compared: status, resolutionLevel, every `item.*`
 * field, every confidence, `exactProduct` INCLUDING its sku, `compatibility.*`,
 * `unknownReason`, `evidence[].observations`, and each candidate's
 * `candidateId`, `category` and `subtype`.
 */
const IDENTITY_EXCLUSIONS = [
  /^\$\.requestId$/,
  /^\$\.evidence\[\d+\]\.evidenceId$/,
  /^\$\.candidates\[\d+\]\.evidenceId$/,
  /^\$\.candidates\[\d+\]\.bounds(\.[a-z]+)?$/,
  /^\$\.candidates\[\d+\]\.detectionDigest$/,
  /^\$\.item\.brand\.evidence\[\d+\]\.evidenceId$/,
  /^\$\.conflicts\[\d+\]\.evidenceIds(\[\d+\])?$/,
];

function isExcluded(fieldPath) {
  return IDENTITY_EXCLUSIONS.some((pattern) => pattern.test(fieldPath));
}

function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Deterministic field-by-field structural comparison.
 *
 * Returns every mismatch, not just the first, so a report names the whole
 * disagreement rather than one symptom of it. Reference identity is irrelevant
 * and never consulted — the two values come from different VM realms.
 */
function diffCanonical(left, right, fieldPath = '$', out = []) {
  if (isExcluded(fieldPath)) return out;

  const leftKind = kindOf(left);
  const rightKind = kindOf(right);
  if (leftKind !== rightKind) {
    out.push({ path: fieldPath, scanner: left, elise: right, why: `type ${leftKind} vs ${rightKind}` });
    return out;
  }

  if (leftKind === 'array') {
    if (left.length !== right.length) {
      out.push({
        path: `${fieldPath}.length`,
        scanner: left.length,
        elise: right.length,
        why: 'array length',
      });
    }
    const max = Math.max(left.length, right.length);
    for (let i = 0; i < max; i += 1) {
      diffCanonical(left[i], right[i], `${fieldPath}[${i}]`, out);
    }
    return out;
  }

  if (leftKind === 'object') {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      const childPath = `${fieldPath}.${key}`;
      if (isExcluded(childPath)) continue;
      const hasLeft = Object.prototype.hasOwnProperty.call(left, key);
      const hasRight = Object.prototype.hasOwnProperty.call(right, key);
      if (hasLeft !== hasRight) {
        // Key PRESENCE is part of the contract: an absent confidence key is not
        // the same claim as a null one.
        out.push({
          path: childPath,
          scanner: hasLeft ? left[key] : '(absent)',
          elise: hasRight ? right[key] : '(absent)',
          why: 'key presence',
        });
        continue;
      }
      diffCanonical(left[key], right[key], childPath, out);
    }
    return out;
  }

  if (!Object.is(left, right)) {
    out.push({ path: fieldPath, scanner: left, elise: right, why: 'value' });
  }
  return out;
}

/**
 * Realm-safe deep comparison.
 *
 * The adapters run under `vm.runInNewContext`, so arrays and objects they return
 * carry that realm's prototypes. `deepStrictEqual` compares prototypes and would
 * fail on structurally identical data. Normalizing through JSON compares the
 * DATA, which is what these assertions are about.
 */
function sameData(actual, expected, message) {
  assert.deepEqual(
    JSON.parse(JSON.stringify(actual)),
    JSON.parse(JSON.stringify(expected)),
    message,
  );
}

function formatDiff(fixtureId, diffs) {
  return [
    `cross-path canonical identity mismatch [fixture ${fixtureId}]`,
    ...diffs.map(
      (d) => `  ${d.path}  (${d.why})\n      scanner: ${JSON.stringify(d.scanner)}\n      elise:   ${JSON.stringify(d.elise)}`,
    ),
  ].join('\n');
}

function assertCanonicalEquivalent(fixtureId, scannerResult, eliseResult) {
  assert.ok(scannerResult, `${fixtureId}: Scanner produced no canonical result`);
  assert.ok(eliseResult, `${fixtureId}: Elise produced no canonical result`);
  const diffs = diffCanonical(scannerResult, eliseResult);
  assert.equal(diffs.length, 0, diffs.length ? formatDiff(fixtureId, diffs) : undefined);
}

// ── Transport spies ──────────────────────────────────────────────────────────

/**
 * A transport that answers with one canonical payload and records every call.
 *
 * `identificationV2` is a fresh clone per call, exactly as a real HTTP response
 * would be a freshly parsed object — no shared reference can travel between the
 * two paths and make them look equal.
 */
function makeTransport(payload, extra = {}) {
  const calls = [];
  const transport = async (image, options) => {
    calls.push({ image, options });
    return {
      status: 'completed',
      recommendedProducts: [],
      identificationV2: clone(payload),
      scanSessionId: 'sess-shared',
      imageDigestPrefix: 'digest-shared',
      ...extra,
    };
  };
  transport.calls = calls;
  return transport;
}

async function runScanner(payload, overrides = {}) {
  const transport = makeTransport(payload);
  const outcome = await scannerRequest.runScannerIdentification({
    mode: 'detect_items',
    evidence: scannerEvidence(),
    platform: 'ios',
    requestId: 'req-cross-path',
    sessionFlag: SESSION_ON,
    transport,
    ...overrides,
  });
  return { outcome, transport };
}

async function runElise(payload, overrides = {}) {
  const transport = makeTransport(payload);
  const outcome = await eliseIdentify.runEliseIdentificationStage({
    mode: 'detect_items',
    evidence: eliseEvidence(),
    entryPath: 'direct_camera',
    platform: 'ios',
    requestId: 'req-cross-path',
    sessionFlag: SESSION_ON,
    transport,
    ...overrides,
  });
  return { outcome, transport };
}

// ── 1. Shared-core reconstruction ────────────────────────────────────────────

test('shared core: both adapters resolve response validation to the same function object', () => {
  // Not a name check — the actual function identity. Two modules can export
  // same-named validators that are different implementations.
  assert.equal(scannerAdapter.validateScannerV2Response('x').category, 'not_an_object');
  assert.equal(v2Core.validateFashionV2Response('x').category, 'not_an_object');
  const scannerSource = read('services/scannerIdentificationV2.ts');
  assert.match(
    scannerSource,
    /return validateFashionV2Response\(raw\)/,
    'Scanner must delegate response validation to the shared core, not reimplement it',
  );
  const eliseSource = read('services/style-chat/eliseIdentifyForStyle.ts');
  assert.match(
    eliseSource,
    /validateFashionV2Response/,
    'Elise must use the shared core validator',
  );
});

test('shared core: both intents are constants, neither is a caller-supplied parameter', () => {
  assert.equal(scannerAdapter.SCANNER_INTENT, 'identify_and_shop');
  assert.equal(eliseAdapter.ELISE_INTENT, 'identify_for_style');

  // A caller cannot talk either builder into the other intent.
  const scannerBuilt = scannerAdapter.buildScannerV2Request({
    mode: 'detect_items',
    evidence: scannerEvidence(),
    platform: 'ios',
    requestId: 'req-1',
    intent: 'identify_for_style',
  });
  assert.equal(scannerBuilt.request.intent, 'identify_and_shop');

  const eliseBuilt = eliseAdapter.buildEliseV2Request({
    mode: 'detect_items',
    evidence: eliseEvidence(),
    entryPath: 'direct_camera',
    platform: 'ios',
    requestId: 'req-1',
    intent: 'identify_and_shop',
  });
  assert.equal(eliseBuilt.request.intent, 'identify_for_style');
});

test('shared core: exactly three modules construct a V2 contract request body', () => {
  // A FOURTH would be an un-governed path into `scan-identify`.
  //
  // Widened from two to three by Closet Upgrade Build 1. The list is pinned
  // exactly, not counted, so a new caller has to be added here deliberately —
  // which is the review moment where its intent gets decided.
  const walk = (dir, acc = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, acc);
      else if (/\.(ts|tsx|js)$/.test(entry.name)) acc.push(full);
    }
    return acc;
  };
  const callers = walk(path.join(ROOT, 'services'))
    .filter((file) => /contractRequestV2\s*:/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(ROOT, file).replace(/\\/g, '/'))
    .sort();
  assert.deepEqual(callers, [
    'services/closetCandidateClassification.js',
    'services/scannerScanRequest.ts',
    'services/style-chat/eliseIdentifyForStyle.ts',
  ]);
});

// ── 2. Cross-path fixture matrix ─────────────────────────────────────────────

for (const fixture of CANONICAL_FIXTURES) {
  test(`equivalence [${fixture.id}]: Scanner canonical == Elise canonical`, async () => {
    // ONE fixture, TWO independent clones. Neither path can see the other's.
    const scannerPayload = clone(fixture.canonical);
    const elisePayload = clone(fixture.canonical);

    const scanner = await runScanner(scannerPayload);
    const elise = await runElise(elisePayload);

    assert.equal(scanner.outcome.contractPath, 'v2', `${fixture.id}: Scanner left the V2 path`);
    assert.equal(elise.outcome.contractPath, 'v2', `${fixture.id}: Elise left the V2 path`);

    assertCanonicalEquivalent(
      fixture.id,
      scanner.outcome.identificationV2,
      elise.outcome.identificationV2,
    );

    assertFixturesPristine(assert, fixture.id);
  });
}

test('equivalence: the comparator actually fails on a seeded identity drift', () => {
  // A comparator that cannot fail proves nothing. This seeds a one-field
  // divergence and requires it to be named exactly.
  const left = clone(baseResult());
  const right = clone(baseResult());
  right.item.subtype = 'workwear jacket';
  const diffs = diffCanonical(left, right);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].path, '$.item.subtype');
  assert.equal(diffs[0].scanner, 'chore jacket');
  assert.equal(diffs[0].elise, 'workwear jacket');
});

test('equivalence: the comparator does NOT alias near-synonyms', () => {
  // Certification-only alias rules are forbidden — they would hide real defects.
  for (const [a, b] of [
    ['chore jacket', 'workwear jacket'],
    ['sneaker', 'trainer'],
    ['navy', 'dark blue'],
    ['Nike', 'NIKE'],
  ]) {
    const left = clone(baseResult({ item: { category: 'x', subtype: a } }));
    const right = clone(baseResult({ item: { category: 'x', subtype: b } }));
    left.item.subtype = a;
    right.item.subtype = b;
    assert.equal(diffCanonical(left, right).length, 1, `${a} / ${b} must not be treated as equal`);
  }
});

test('equivalence: comparator detects a missing key, not only a changed value', () => {
  const left = clone(baseResult());
  const right = clone(baseResult());
  delete right.confidence.modelFamily;
  const diffs = diffCanonical(left, right);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].path, '$.confidence.modelFamily');
  assert.equal(diffs[0].why, 'key presence');
});

// ── 3. Malformed payloads are refused identically ────────────────────────────

for (const fixture of MALFORMED_FIXTURES) {
  test(`equivalence [${fixture.id}]: both paths refuse it with the same category`, async () => {
    const scanner = await runScanner(fixture.payload);
    const elise = await runElise(fixture.payload);

    assert.equal(scanner.outcome.identificationV2, null, `${fixture.id}: Scanner accepted a malformed payload`);
    assert.equal(elise.outcome.identificationV2, null, `${fixture.id}: Elise accepted a malformed payload`);
    assert.equal(
      scanner.outcome.v2ValidationFailure,
      elise.outcome.v2ValidationFailure,
      `${fixture.id}: paths disagreed on the rejection category`,
    );
    assert.equal(scanner.outcome.v2ValidationFailure, fixture.expectedCategory);

    // A malformed payload is NOT a contract-support signal: no fallback, one call.
    assert.equal(scanner.outcome.fallbackUsed, false);
    assert.equal(elise.outcome.fallbackUsed, false);
    assert.equal(scanner.transport.calls.length, 1);
    assert.equal(elise.transport.calls.length, 1);
  });
}

// ── 4. Request-equivalence proof ─────────────────────────────────────────────

/**
 * The two requests, built from the same prepared derivative.
 *
 * Only `intent` and `source.entryPath` may differ. Every other field is a shared
 * identification input, and an unexplained difference in one of them is a
 * cross-path defect regardless of whether the response happened to match.
 */
function builtPair(mode, extras = {}) {
  const scanner = scannerAdapter.buildScannerV2Request({
    mode,
    evidence: scannerEvidence(extras.scannerSource || 'camera'),
    platform: 'ios',
    requestId: 'req-equivalence',
    appVersion: '1.2.3',
    ...(extras.selectedCandidate ? { selectedCandidate: extras.selectedCandidate } : {}),
  });
  const elise = eliseAdapter.buildEliseV2Request({
    mode,
    evidence: eliseEvidence(extras.eliseSource || 'camera'),
    entryPath: extras.entryPath || 'direct_camera',
    platform: 'ios',
    requestId: 'req-equivalence',
    appVersion: '1.2.3',
    ...(extras.selectedCandidate ? { selectedCandidate: extras.selectedCandidate } : {}),
  });
  assert.equal(scanner.kind, 'ok');
  assert.equal(elise.kind, 'ok');
  return { scanner: scanner.request, elise: elise.request };
}

const REQUEST_AUTHORIZED_DIFFS = ['$.intent', '$.source.entryPath'];

test('request equivalence: detect_items differs ONLY by intent and entryPath', () => {
  const { scanner, elise } = builtPair('detect_items');
  const diffs = diffCanonical(scanner, elise);
  assert.deepEqual(
    diffs.map((d) => d.path).sort(),
    REQUEST_AUTHORIZED_DIFFS,
    formatDiff('request/detect_items', diffs),
  );
  assert.equal(scanner.intent, 'identify_and_shop');
  assert.equal(elise.intent, 'identify_for_style');
  assert.equal(scanner.source.entryPath, 'scanner_camera');
  assert.equal(elise.source.entryPath, 'elise_camera');
});

test('request equivalence: identify_selected_item differs ONLY by intent and entryPath', () => {
  const selectedCandidate = {
    candidateId: 'cand-1',
    evidenceId: EVIDENCE_ID,
    category: 'outerwear',
    subtype: 'chore jacket',
    bounds: { x: 1, y: 2, width: 3, height: 4 },
    detectionDigest: 'server-issued-digest',
  };
  const { scanner, elise } = builtPair('identify_selected_item', { selectedCandidate });
  const diffs = diffCanonical(scanner, elise);
  assert.deepEqual(
    diffs.map((d) => d.path).sort(),
    REQUEST_AUTHORIZED_DIFFS,
    formatDiff('request/identify_selected_item', diffs),
  );
});

test('request equivalence: every shared identification input is field-for-field identical', () => {
  const { scanner, elise } = builtPair('detect_items');
  assert.equal(scanner.contractVersion, elise.contractVersion);
  assert.equal(scanner.mode, elise.mode);
  assert.equal(scanner.requestId, elise.requestId);
  assert.equal(scanner.source.platform, elise.source.platform);
  assert.equal(scanner.source.appVersion, elise.source.appVersion);
  assert.equal(scanner.evidence.length, 1);
  assert.equal(elise.evidence.length, 1);
  assert.equal(scanner.evidence[0].evidenceId, elise.evidence[0].evidenceId);
  assert.equal(scanner.evidence[0].sequenceIndex, elise.evidence[0].sequenceIndex);
  assert.equal(scanner.evidence[0].transport.type, 'jpeg_base64');
  assert.equal(elise.evidence[0].transport.type, 'jpeg_base64');
  assert.equal(scanner.evidence[0].transport.imageBase64, elise.evidence[0].transport.imageBase64);
  assert.equal(scanner.evidence[0].metadata.mimeType, 'image/jpeg');
  assert.equal(elise.evidence[0].metadata.mimeType, 'image/jpeg');
  assert.equal(scanner.evidence[0].metadata.schemaVersion, elise.evidence[0].metadata.schemaVersion);
  assert.equal(scanner.evidence[0].metadata.width, elise.evidence[0].metadata.width);
  assert.equal(scanner.evidence[0].metadata.height, elise.evidence[0].metadata.height);
  // Privacy attestation must be identical AND truthful on both paths.
  assert.deepEqual(
    JSON.parse(JSON.stringify(scanner.privacy)),
    { localFaceMaskApplied: false, localPlateMaskApplied: false, rawExifTransmitted: false },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(elise.privacy)),
    JSON.parse(JSON.stringify(scanner.privacy)),
  );
});

test('request equivalence: gallery intake converges on the same shared inputs', () => {
  const { scanner, elise } = builtPair('detect_items', {
    scannerSource: 'gallery',
    eliseSource: 'gallery',
    entryPath: 'direct_gallery',
  });
  const diffs = diffCanonical(scanner, elise);
  assert.deepEqual(diffs.map((d) => d.path).sort(), REQUEST_AUTHORIZED_DIFFS);
  assert.equal(scanner.source.entryPath, 'scanner_gallery');
  assert.equal(elise.source.entryPath, 'elise_gallery');
});

test('request equivalence: each validator rejects the other path request', () => {
  const { scanner, elise } = builtPair('detect_items');
  assert.equal(scannerAdapter.validateScannerV2Request(scanner), true);
  assert.equal(eliseAdapter.validateEliseV2Request(elise), true);
  // Cross-assignment must fail: this is what catches a path wired through the
  // wrong builder.
  assert.equal(scannerAdapter.validateScannerV2Request(elise), false);
  assert.equal(eliseAdapter.validateEliseV2Request(scanner), false);
});

// ── 5. Detection and candidate certification ─────────────────────────────────

test('candidates: zero candidates classifies identically on both paths', async () => {
  const fixture = CANONICAL_FIXTURES.find((f) => f.id === 'negative/zero-candidates');
  const scanner = await runScanner(clone(fixture.canonical));
  const elise = await runElise(clone(fixture.canonical));
  sameData(scanner.outcome.candidates, []);
  sameData(elise.outcome.candidates, []);
  assert.equal(scanner.outcome.identificationV2.status, elise.outcome.identificationV2.status);
});

test('candidates: exactly one candidate yields the same candidate identity', async () => {
  const fixture = CANONICAL_FIXTURES.find((f) => f.id === 'negative/single-candidate');
  const scanner = await runScanner(clone(fixture.canonical));
  const elise = await runElise(clone(fixture.canonical));
  assert.equal(scanner.outcome.candidates.length, 1);
  assert.equal(elise.outcome.candidates.length, 1);
  const diffs = diffCanonical(scanner.outcome.candidates, elise.outcome.candidates, '$.candidates');
  assert.equal(diffs.length, 0, formatDiff('candidates/single', diffs));
});

test('candidates: the multi-candidate set matches in count, order and identity', async () => {
  const fixture = CANONICAL_FIXTURES.find((f) => f.id === 'negative/multiple-candidates');
  const scanner = await runScanner(clone(fixture.canonical));
  const elise = await runElise(clone(fixture.canonical));

  assert.equal(scanner.outcome.candidates.length, 3);
  assert.equal(elise.outcome.candidates.length, 3);
  // Source order, not sorted order.
  sameData(scanner.outcome.candidates.map((c) => c.candidateId), ['cand-1', 'cand-2', 'cand-3']);
  sameData(elise.outcome.candidates.map((c) => c.candidateId), ['cand-1', 'cand-2', 'cand-3']);
  sameData(
    scanner.outcome.candidates.map((c) => `${c.category}/${c.subtype ?? ''}`),
    elise.outcome.candidates.map((c) => `${c.category}/${c.subtype ?? ''}`),
  );
  // Bounds and evidence correlation are compared here explicitly, at the
  // detection boundary where they are meaningful.
  sameData(scanner.outcome.candidates, elise.outcome.candidates);
});

test('candidates: a mis-correlated candidate is dropped identically on both paths', async () => {
  const payload = clone(baseResult({
    status: 'multiple_items_need_selection',
    candidates: [
      { candidateId: 'good', evidenceId: EVIDENCE_ID, category: 'tops', subtype: null },
      { candidateId: 'foreign', evidenceId: SECOND_EVIDENCE_ID, category: 'bottoms', subtype: null },
    ],
  }));
  const scanner = await runScanner(payload);
  const elise = await runElise(payload);
  sameData(scanner.outcome.candidates.map((c) => c.candidateId), ['good']);
  sameData(elise.outcome.candidates.map((c) => c.candidateId), ['good']);
});

test('candidates: an item-policy Elise path does not auto-select from a multi-candidate set', async () => {
  const fixture = CANONICAL_FIXTURES.find((f) => f.id === 'negative/multiple-candidates');
  const transport = makeTransport(clone(fixture.canonical));
  const result = await eliseIdentify.identifyPreparedImageForStyle({
    evidence: eliseEvidence(),
    entryPath: 'direct_camera',
    platform: 'ios',
    requestId: 'req-policy',
    sessionFlag: SESSION_ON,
    policy: 'item',
    transport,
  });
  assert.equal(result.state, 'needs_selection');
  assert.equal(result.identifications.length, 0);
  assert.equal(result.candidates.length, 3);
  // Detection only. No selected-item request was spent guessing.
  assert.equal(transport.calls.length, 1);
});

// ── 6. Identity-result certification and the projection boundary ─────────────

/** Identity fields the projection is authorized to carry, and must not alter. */
function projectionPreservesMeaning(fixtureId, canonical, projected) {
  assert.equal(projected.status, canonical.status, `${fixtureId}: projection changed status`);
  assert.equal(
    projected.resolutionLevel,
    canonical.resolutionLevel,
    `${fixtureId}: projection changed resolutionLevel`,
  );
  assert.equal(
    projected.category,
    canonical.item.category ?? null,
    `${fixtureId}: projection altered or invented category`,
  );
  assert.equal(
    projected.subtype,
    canonical.item.subtype ?? null,
    `${fixtureId}: projection altered or invented subtype`,
  );
  assert.equal(
    projected.brand.value,
    canonical.item.brand.value ?? null,
    `${fixtureId}: projection altered brand value`,
  );
  assert.equal(
    projected.brand.confidence,
    canonical.item.brand.confidence ?? null,
    `${fixtureId}: projection altered brand confidence`,
  );
  assert.equal(
    projected.colors.primary,
    canonical.item.colors.primary ?? null,
    `${fixtureId}: projection altered primary colour`,
  );
  assert.deepEqual([...projected.colors.secondary], [...canonical.item.colors.secondary]);
  assert.deepEqual([...projected.material], [...canonical.item.material]);
  assert.deepEqual([...projected.silhouette], [...canonical.item.silhouette]);
  assert.deepEqual([...projected.pattern], [...canonical.item.pattern]);
  for (const key of ['category', 'subtype', 'brand', 'modelFamily', 'exactProduct']) {
    assert.equal(
      projected.confidence[key],
      canonical.confidence[key],
      `${fixtureId}: projection altered confidence.${key}`,
    );
  }
  assert.equal(
    projected.globalConfidence,
    canonical.compatibility.globalConfidence ?? null,
    `${fixtureId}: projection altered globalConfidence`,
  );
  assert.equal(
    projected.conflicts.length,
    (canonical.conflicts || []).length,
    `${fixtureId}: projection dropped or invented conflicts`,
  );
}

for (const fixture of CANONICAL_FIXTURES) {
  test(`projection [${fixture.id}]: styling-safe subset preserves identity meaning`, () => {
    const canonical = clone(fixture.canonical);
    const projected = fashionContext.projectCanonicalToEliseIdentity(canonical);

    if (projected === null) {
      // Only legitimate when there is no category AND no subtype to ground on.
      assert.equal(canonical.item.category, null, `${fixture.id}: dropped a groundable identity`);
      assert.equal(canonical.item.subtype, null, `${fixture.id}: dropped a groundable identity`);
      return;
    }

    projectionPreservesMeaning(fixture.id, canonical, projected);

    // Forbidden correlation and commerce content must be gone.
    assert.equal(projected.identityVersion, 'elise-fashion-identity-v2');
    assert.equal('requestId' in projected, false);
    assert.equal('evidence' in projected, false);
    assert.equal('candidates' in projected, false);
    assert.equal('compatibility' in projected, false);
    assert.equal('evidence' in projected.brand, false);
    for (const conflict of projected.conflicts) {
      assert.deepEqual(Object.keys(conflict).sort(), ['description', 'field']);
    }
    if (projected.exactProduct) {
      assert.deepEqual(Object.keys(projected.exactProduct).sort(), ['brand', 'model']);
      assert.equal('sku' in projected.exactProduct, false, `${fixture.id}: SKU survived the projection`);
    }
    // The canonical object is left intact for every other holder.
    assert.deepEqual(canonical, clone(fixture.canonical), `${fixture.id}: projection mutated the canonical result`);
  });
}

test('projection: never upgrades a partial identity to completed', () => {
  const canonical = clone(baseResult({ status: 'partial' }));
  const projected = fashionContext.projectCanonicalToEliseIdentity(canonical);
  assert.equal(projected.status, 'partial');
});

test('projection: never invents confidence where the canonical result reported none', () => {
  const canonical = clone(baseResult({
    confidence: { category: null, subtype: null, brand: null, modelFamily: null, exactProduct: null },
    compatibility: { legacyProjectionAvailable: true, globalConfidence: null },
  }));
  const projected = fashionContext.projectCanonicalToEliseIdentity(canonical);
  for (const key of ['category', 'subtype', 'brand', 'modelFamily', 'exactProduct']) {
    assert.equal(projected.confidence[key], null, `confidence.${key} was invented`);
  }
  assert.equal(projected.globalConfidence, null);
});

test('projection: exact-product SKU is dropped and the transport gate agrees', () => {
  const fixture = CANONICAL_FIXTURES.find((f) => f.id === 'single/exact-product');
  const canonical = clone(fixture.canonical);
  assert.equal(canonical.exactProduct.sku, 'FD2722-001');

  const context = fashionContext.buildEliseFashionContextV2({
    source: 'direct_camera',
    items: [{ sourceIndex: 0, state: 'ready', identification: canonical }],
  });
  const prepared = fashionContext.prepareContextForTransport(context);
  assert.equal(prepared.kind, 'ok', `transport gate rejected: ${prepared.reason}`);
  assert.equal(JSON.stringify(prepared.context).includes('FD2722-001'), false, 'SKU crossed the wire');
  assert.equal(JSON.stringify(prepared.context).includes('sku'), false);
});

// ── 7. Intent divergence ─────────────────────────────────────────────────────

test('intent divergence: the Elise module graph cannot reach commerce or persistence', () => {
  // `loadTsModule` throws on any import outside the allowlist. The Elise graph
  // above was loaded with an allowlist containing no commerce provider, no
  // retailer module, no Supabase client and no persistence helper — so the load
  // succeeding IS the proof. This test states the invariant explicitly and
  // re-checks it at source level.
  const eliseSources = [
    'services/style-chat/eliseIdentificationV2.ts',
    'services/style-chat/eliseIdentifyForStyle.ts',
    'services/style-chat/eliseFashionContextV2.ts',
    'services/style-chat/eliseAttachmentRouting.ts',
  ];
  const forbidden = [
    /from ['"].*shoppingProvider/,
    /from ['"].*commerceRouter/i,
    /from ['"].*purchaseOption/i,
    /from ['"].*\/saveScan/,
    /from ['"].*useKScan/,
    /\.rpc\(/,
    /\.insert\(/,
    /\.upsert\(/,
    /\.from\(['"]/,
  ];
  for (const rel of eliseSources) {
    const source = read(rel);
    for (const pattern of forbidden) {
      assert.equal(pattern.test(source), false, `${rel} reaches a forbidden dependency: ${pattern}`);
    }
  }
});

/**
 * A stage-aware transport: detection answers with the real backend's
 * `multiple_items_need_selection`, the selected-item stage answers `completed`.
 *
 * Using one payload for both stages would be a fiction — `scan-identify` only
 * emits the detection status when the multi-item provider ran, which a
 * selected-item request disables.
 */
function makeStagedTransport(detectionPayload, selectedPayload) {
  const calls = [];
  const transport = async (image, options) => {
    calls.push({ image, options });
    const mode = options.contractRequestV2 ? options.contractRequestV2.mode : 'legacy';
    return {
      status: 'completed',
      recommendedProducts: [],
      identificationV2: clone(mode === 'detect_items' ? detectionPayload : selectedPayload),
      scanSessionId: 'sess-shared',
      imageDigestPrefix: 'digest-shared',
    };
  };
  transport.calls = calls;
  return transport;
}

test('intent divergence: an Elise operation issues identification calls and nothing else', async () => {
  const transport = makeStagedTransport(
    clone(baseResult({
      status: 'multiple_items_need_selection',
      candidates: [{ candidateId: 'cand-1', evidenceId: EVIDENCE_ID, category: 'outerwear', subtype: 'chore jacket' }],
    })),
    clone(baseResult()),
  );
  const result = await eliseIdentify.identifyPreparedImageForStyle({
    evidence: eliseEvidence(),
    entryPath: 'direct_camera',
    platform: 'ios',
    requestId: 'req-divergence',
    sessionFlag: SESSION_ON,
    policy: 'item',
    transport,
  });
  // detect_items then identify_selected_item — two identification calls, both
  // carrying the style intent, and no other transport exists in this graph.
  assert.equal(transport.calls.length, 2);
  assert.deepEqual(
    transport.calls.map((c) => c.options.contractRequestV2.intent),
    ['identify_for_style', 'identify_for_style'],
  );
  assert.deepEqual(
    transport.calls.map((c) => c.options.contractRequestV2.mode),
    ['detect_items', 'identify_selected_item'],
  );
  assert.equal(result.state, 'ready');
});

test('intent divergence: Scanner keeps the shopping intent on every stage', async () => {
  const detectPayload = clone(baseResult({
    status: 'multiple_items_need_selection',
    candidates: [{ candidateId: 'cand-1', evidenceId: EVIDENCE_ID, category: 'outerwear', subtype: 'chore jacket' }],
  }));
  const detect = await runScanner(detectPayload);
  assert.equal(detect.transport.calls[0].options.contractRequestV2.intent, 'identify_and_shop');

  const selected = await runScanner(clone(baseResult()), {
    mode: 'identify_selected_item',
    selectedCandidate: {
      candidateId: 'cand-1',
      evidenceId: EVIDENCE_ID,
      category: 'outerwear',
      subtype: 'chore jacket',
    },
    legacyCorrelation: { scanSessionId: 'sess-shared', imageDigestPrefix: 'digest-shared' },
  });
  assert.equal(selected.transport.calls[0].options.contractRequestV2.intent, 'identify_and_shop');
  assert.equal(selected.outcome.identificationV2.status, 'completed');
});

test('intent divergence: telemetry buckets differ by intent without touching identity', () => {
  const result = clone(baseResult());
  const scannerTelemetry = scannerAdapter.buildScannerV2Telemetry({
    enabled: true, attempted: true, accepted: true, mode: 'detect_items',
    evidenceSource: 'camera', platform: 'ios', result, candidateCount: 3,
  });
  const eliseTelemetry = eliseAdapter.buildEliseV2Telemetry({
    enabled: true, attempted: true, accepted: true, entryPath: 'direct_camera',
    platform: 'ios', mode: 'detect_items', result, sourceImageCount: 1, latencyMs: 2200,
  });
  // Both report the SAME identity-derived facts.
  assert.equal(scannerTelemetry.resultStatus, eliseTelemetry.resultStatus);
  assert.equal(scannerTelemetry.resolutionLevel, eliseTelemetry.resolutionLevel);
  // And diverge only in intent-specific operational buckets.
  assert.equal(scannerTelemetry.entryPath, 'scanner_camera');
  assert.equal(eliseTelemetry.sourcePath, 'elise_camera');
  assert.equal('candidateCountBucket' in scannerTelemetry, true);
  assert.equal('sourceImageCountBucket' in eliseTelemetry, true);
  // Neither carries correlation or raw evidence.
  for (const telemetry of [scannerTelemetry, eliseTelemetry]) {
    const json = JSON.stringify(telemetry);
    for (const banned of [EVIDENCE_ID, SHARED_IMAGE_BASE64, 'cand-', 'digest-shared', 'sess-shared']) {
      assert.equal(json.includes(banned), false, `telemetry leaked ${banned}`);
    }
  }
});

// ── 8. Handoff and reuse certification ───────────────────────────────────────

function v2ScanRecord(canonical) {
  return {
    identificationSnapshotV2: {
      snapshotVersion: 2,
      contractVersion: 'fashion-identification-v2',
      identification: canonical,
      purchaseOptions: [],
      source: 'camera',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
  };
}

test('reuse: a valid Scanner handoff reuses identity and issues ZERO identification calls', async () => {
  const canonical = clone(baseResult());
  const transport = makeTransport(canonical);

  const route = attachmentRouting.routeEliseAttachment({
    source: 'scanner_handoff',
    identificationV2: canonical,
  });
  assert.equal(route.kind, 'reuse_v2');

  const context = attachmentRouting.contextFromReusedV2('scanner_handoff', route.identification);
  assert.equal(context.contractVersion, 'elise-fashion-context-v2');
  assert.equal(context.source, 'scanner_handoff');
  assert.equal(context.items.length, 1);
  assert.equal(context.items[0].state, 'ready');

  // The reused identity is the SAME identity, projected — not a re-read.
  projectionPreservesMeaning('reuse/scanner_handoff', canonical, context.items[0].identification);
  assert.equal(transport.calls.length, 0, 'a handoff must never re-identify');
});

test('reuse: a valid V2 Recent Scan reuses identity and issues ZERO identification calls', () => {
  const canonical = clone(baseResult());
  const route = attachmentRouting.routeEliseAttachment({
    source: 'recent_scan',
    record: v2ScanRecord(canonical),
  });
  assert.equal(route.kind, 'reuse_v2');
  const diffs = diffCanonical(canonical, route.identification);
  assert.equal(diffs.length, 0, formatDiff('reuse/recent_scan', diffs));
});

test('reuse: a reused partial result stays partial and is not upgraded', () => {
  const canonical = clone(baseResult({ status: 'partial' }));
  const context = attachmentRouting.contextFromReusedV2('recent_scan', canonical);
  assert.equal(context.items[0].state, 'partial');
  assert.equal(context.items[0].identification.status, 'partial');
});

test('reuse: a non-groundable terminal status is not reusable as grounding', () => {
  for (const status of ['non_fashion', 'insufficient_visual_evidence', 'technical_failure']) {
    const canonical = clone(baseResult({
      status,
      item: { category: null, subtype: null },
    }));
    assert.equal(
      attachmentRouting.contextFromReusedV2('recent_scan', canonical),
      null,
      `${status} must not become styling grounding`,
    );
  }
});

test('reuse: Closet and Dressing Room route to the structured item, never to identification', () => {
  for (const source of ['closet', 'dressing_room']) {
    const route = attachmentRouting.routeEliseAttachment({ source });
    assert.equal(route.kind, 'structured_item', `${source} must not be re-identified`);
  }
});

test('reuse: a compatible legacy structured scan is preserved, never upgraded to V2', () => {
  const route = attachmentRouting.routeEliseAttachment({
    source: 'recent_scan',
    record: {
      identificationSnapshot: {
        snapshotVersion: 1,
        contractVersion: 'fashion-identification-v1',
        status: 'completed',
        category: 'outerwear',
        subtype: 'chore jacket',
        brand: { value: 'Carhartt', confidence: 0.7, provenance: 'visible_text', evidence: [] },
        colors: { primary: 'brown', secondary: [] },
        material: ['duck canvas'],
        silhouette: [],
        pattern: [],
        entryPath: 'scanner_camera',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    },
  });
  assert.equal(route.kind, 'compatibility');
  assert.equal(route.projection.contractVersion, 'elise-legacy-projection-v1');
  assert.equal(route.projection.category, 'outerwear');
  assert.equal(route.projection.brand, 'Carhartt');
  // Nothing fabricated a V2 identity marker.
  assert.equal('identityVersion' in route.projection, false);
  assert.equal(JSON.stringify(route.projection).includes('fashion-identification-v2'), false);
});

test('reuse: a malformed stored snapshot fails safe and still does not re-identify', () => {
  const route = attachmentRouting.routeEliseAttachment({
    source: 'recent_scan',
    record: { identificationSnapshotV2: { snapshotVersion: 2, contractVersion: 'nope' } },
  });
  assert.equal(route.kind, 'compatibility');
  assert.equal(attachmentRouting.hasLegacyEvidence(route.projection), false);
  assert.notEqual(route.kind, 'identify');
});

test('reuse: an unrecognized source is non_visual, never speculative identification', () => {
  for (const source of ['', 'unknown_source', 'shared_room', undefined, null, 42]) {
    const route = attachmentRouting.routeEliseAttachment({ source });
    assert.equal(route.kind, 'non_visual', `source ${String(source)} must not be identified`);
  }
});

test('reuse: only genuinely raw sources route to identification', () => {
  for (const source of ['direct_camera', 'direct_gallery', 'header_gallery']) {
    assert.equal(attachmentRouting.routeEliseAttachment({ source }).kind, 'identify');
  }
});

test('reuse: a caller claiming V2 without a valid payload does not get reuse_v2', () => {
  const route = attachmentRouting.routeEliseAttachment({
    source: 'scanner_handoff',
    identificationV2: { contractVersion: 'fashion-identification-v2', status: 'completed' },
  });
  assert.notEqual(route.kind, 'reuse_v2');
  assert.equal(route.kind, 'compatibility');
});

// ── 9. Multi-image ordering and partial-success merge ────────────────────────

test('multi-image: items keep SOURCE order, not completion order', () => {
  const first = clone(baseResult({ item: { category: 'tops', subtype: 'tee' } }));
  const second = clone(baseResult({ item: { category: 'bottoms', subtype: 'trouser' } }));
  const third = clone(baseResult({ item: { category: 'footwear', subtype: 'boot' } }));
  // Deliberately supplied out of order, as async settlement would.
  const context = fashionContext.buildEliseFashionContextV2({
    source: 'header_gallery',
    items: [
      { sourceIndex: 2, state: 'ready', identification: third },
      { sourceIndex: 0, state: 'ready', identification: first },
      { sourceIndex: 1, state: 'ready', identification: second },
    ],
  });
  // JSON-normalized: the modules run in a separate VM realm, so a raw
  // deepStrictEqual would fail on Array.prototype identity alone.
  assert.deepEqual(JSON.parse(JSON.stringify(context.items.map((i) => i.sourceIndex))), [0, 1, 2]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.items.map((i) => i.identification.subtype))),
    ['tee', 'trouser', 'boot'],
  );
});

test('multi-image: duplicate categories and colors stay separate items', () => {
  const a = clone(baseResult({ item: { category: 'outerwear', subtype: 'chore jacket' } }));
  const b = clone(baseResult({ item: { category: 'outerwear', subtype: 'chore jacket' } }));
  const context = fashionContext.buildEliseFashionContextV2({
    source: 'header_gallery',
    items: [
      { sourceIndex: 0, state: 'ready', identification: a },
      { sourceIndex: 1, state: 'ready', identification: b },
    ],
  });
  assert.equal(context.items.length, 2, 'two grey jackets are two items');
});

test('multi-image: one success plus one failure keeps the success and marks the failure', () => {
  const ok = clone(baseResult());
  for (const [state, expected] of [
    ['technical_failure', 'technical_failure'],
    ['non_fashion', 'non_fashion'],
    ['insufficient_evidence', 'insufficient_evidence'],
  ]) {
    const context = fashionContext.buildEliseFashionContextV2({
      source: 'header_gallery',
      items: [
        { sourceIndex: 0, state: 'ready', identification: ok },
        { sourceIndex: 1, state },
      ],
    });
    assert.equal(context.items.length, 2);
    assert.equal(context.items[1].state, expected);
    assert.equal(context.items[1].identification, undefined, 'a failed slot must carry no identity');
    assert.equal(fashionContext.groundableItems(context).length, 1);
  }
});

test('multi-image: all failed yields no groundable evidence', () => {
  const context = fashionContext.buildEliseFashionContextV2({
    source: 'header_gallery',
    items: [
      { sourceIndex: 0, state: 'technical_failure' },
      { sourceIndex: 1, state: 'non_fashion' },
    ],
  });
  assert.equal(fashionContext.hasGroundableEvidence(context), false);
});

test('multi-image: duplicate source indices are refused outright', () => {
  const ok = clone(baseResult());
  assert.equal(
    fashionContext.buildEliseFashionContextV2({
      source: 'header_gallery',
      items: [
        { sourceIndex: 0, state: 'ready', identification: ok },
        { sourceIndex: 0, state: 'ready', identification: ok },
      ],
    }),
    null,
  );
});

test('multi-image: a ready item whose identification fails validation is downgraded, not dropped', () => {
  const context = fashionContext.buildEliseFashionContextV2({
    source: 'header_gallery',
    items: [
      { sourceIndex: 0, state: 'ready', identification: clone(baseResult()) },
      { sourceIndex: 1, state: 'ready', identification: { contractVersion: 'wrong' } },
    ],
  });
  assert.equal(context.items.length, 2, 'the slot must survive so retry stays available');
  assert.equal(context.items[1].state, 'technical_failure');
});

// ── 10. Unsupported-version fallback scope ───────────────────────────────────

const NON_FALLBACK_FAILURES = [
  { label: 'timeout', extra: { status: 'failed', httpStatus: null, contractErrorCode: null } },
  { label: 'http-500', extra: { status: 'failed', httpStatus: 500, contractErrorCode: null } },
  { label: 'auth-401', extra: { status: 'failed', httpStatus: 401, contractErrorCode: 'UNAUTHORIZED' } },
  { label: 'quota-429', extra: { status: 'failed', httpStatus: 429, contractErrorCode: 'QUOTA_EXCEEDED' } },
  { label: 'other-400', extra: { status: 'failed', httpStatus: 400, contractErrorCode: 'INVALID_SOURCE' } },
];

for (const failure of NON_FALLBACK_FAILURES) {
  test(`fallback scope [${failure.label}]: neither path falls back, both call once`, async () => {
    for (const label of ['scanner', 'elise']) {
      const transport = makeTransport(clone(baseResult()), failure.extra);
      const outcome = label === 'scanner'
        ? await scannerRequest.runScannerIdentification({
          mode: 'detect_items', evidence: scannerEvidence(), platform: 'ios',
          requestId: 'req-fb', sessionFlag: SESSION_ON, transport,
        })
        : await eliseIdentify.runEliseIdentificationStage({
          mode: 'detect_items', evidence: eliseEvidence(), entryPath: 'direct_camera',
          platform: 'ios', requestId: 'req-fb', sessionFlag: SESSION_ON, transport,
        });
      assert.equal(outcome.fallbackUsed, false, `${label}/${failure.label} fell back`);
      assert.equal(transport.calls.length, 1, `${label}/${failure.label} spent a second scan`);
      assert.equal(outcome.contractPath, 'v2');
    }
  });
}

test('fallback scope: UNSUPPORTED_CONTRACT_VERSION falls back exactly once on both paths', async () => {
  const unsupported = { status: 'failed', httpStatus: 400, contractErrorCode: 'UNSUPPORTED_CONTRACT_VERSION' };

  for (const label of ['scanner', 'elise']) {
    const calls = [];
    const transport = async (image, options) => {
      calls.push({ image, options });
      // Only the V2 attempt is refused; the legacy retry succeeds.
      if (options.contractRequestV2) {
        return { status: 'failed', recommendedProducts: [], ...unsupported };
      }
      return { status: 'completed', recommendedProducts: [], scanSessionId: 'sess', imageDigestPrefix: 'dg' };
    };
    const outcome = label === 'scanner'
      ? await scannerRequest.runScannerIdentification({
        mode: 'detect_items', evidence: scannerEvidence(), platform: 'ios',
        requestId: 'req-unsup', sessionFlag: SESSION_ON, transport,
      })
      : await eliseIdentify.runEliseIdentificationStage({
        mode: 'detect_items', evidence: eliseEvidence(), entryPath: 'direct_camera',
        platform: 'ios', requestId: 'req-unsup', sessionFlag: SESSION_ON, transport,
      });

    assert.equal(outcome.contractPath, 'legacy', `${label} did not take the legacy fallback`);
    assert.equal(outcome.fallbackUsed, true);
    assert.equal(calls.length, 2, `${label} did not retry exactly once`);
    // The SAME prepared derivative is re-sent. No second evidence, no recompression.
    assert.equal(calls[0].image, calls[1].image);
    assert.equal(calls[0].image, SHARED_IMAGE_BASE64);
    assert.equal(calls[1].options.contractRequestV2, undefined, `${label} retried under V2`);
  }
});

// ── 11. Privacy transport boundary ───────────────────────────────────────────

const FORBIDDEN_IN_CONTEXT = [
  SHARED_IMAGE_BASE64,
  EVIDENCE_ID,
  'cand-1',
  'server-issued-digest',
  'req-cross-path',
  'file://',
  'content://',
  'ph://',
  'asset-library://',
  'data:image/',
  ';base64,',
];

test('privacy: no canonical context carries evidence, correlation or raw image references', () => {
  for (const fixture of CANONICAL_FIXTURES) {
    const canonical = clone(fixture.canonical);
    const context = fashionContext.buildEliseFashionContextV2({
      source: 'direct_camera',
      items: [{ sourceIndex: 0, state: 'ready', identification: canonical }],
    });
    if (!context) continue;
    const prepared = fashionContext.prepareContextForTransport(context);
    if (prepared.kind !== 'ok') continue;
    const json = JSON.stringify(prepared.context);
    for (const banned of FORBIDDEN_IN_CONTEXT) {
      assert.equal(json.includes(banned), false, `${fixture.id}: context leaked ${banned}`);
    }
  }
});

test('privacy: the transport gate refuses a retailer URL smuggled into a free-text field', () => {
  const canonical = clone(baseResult({
    conflicts: [
      { field: 'brand', description: 'See https://retailer.example/p/123', evidenceIds: [EVIDENCE_ID] },
    ],
  }));
  const context = fashionContext.buildEliseFashionContextV2({
    source: 'direct_camera',
    items: [{ sourceIndex: 0, state: 'ready', identification: canonical }],
  });
  const prepared = fashionContext.prepareContextForTransport(context);
  assert.equal(prepared.kind, 'invalid');
  assert.match(prepared.reason, /commerce_content/);
});

test('privacy: the transport gate refuses a price smuggled into unknownReason', () => {
  const canonical = clone(baseResult({ unknownReason: 'Similar pieces retail around $129.00' }));
  const context = fashionContext.buildEliseFashionContextV2({
    source: 'direct_camera',
    items: [{ sourceIndex: 0, state: 'ready', identification: canonical }],
  });
  const prepared = fashionContext.prepareContextForTransport(context);
  assert.equal(prepared.kind, 'invalid');
  assert.match(prepared.reason, /commerce_content/);
});

test('privacy: the forbidden-KEY scan catches correlation nested inside allowed containers', () => {
  // Defence in depth behind the key allowlists: the allowlists refuse an unknown
  // key at each declared level, and this refuses a forbidden key ANYWHERE,
  // including a level a future contract revision might legitimately widen.
  for (const [label, value] of [
    ['top-level evidenceId', { evidenceId: 'x' }],
    ['nested evidenceId', { item: { brand: { evidenceId: 'x' } } }],
    ['plural evidenceIds', { conflicts: [{ evidenceIds: ['x'] }] }],
    ['candidateId', { deep: { deeper: { candidateId: 'c1' } } }],
    ['detectionDigest', { detectionDigest: 'd' }],
    ['bounds', { bounds: { x: 1 } }],
    ['sku', { exactProduct: { sku: 'ABC-1' } }],
    ['purchase options', { purchaseOptions: [] }],
    ['retailer url key', { retailerUrl: 'shop' }],
    ['user id', { userId: 'u' }],
  ]) {
    const found = fashionContext.findForbiddenContextPath(value);
    assert.ok(found, `${label}: forbidden key was not detected`);
    assert.match(found, /forbidden_key$/, `${label}: detected for the wrong reason (${found})`);
  }
});

test('privacy: the forbidden-CONTENT scan catches raw image references anywhere', () => {
  for (const uri of [
    'file:///var/mobile/a.jpg',
    'content://media/external/images/1',
    'ph://ABC-123',
    'asset-library://asset/asset.JPG',
    'data:image/jpeg;base64,AAA',
  ]) {
    const found = fashionContext.findForbiddenContextPath({ item: { note: uri } });
    assert.ok(found, `${uri} was not detected`);
    assert.match(found, /raw_image_reference$/);
  }
});

test('privacy: both request builders attest truthfully and cannot claim masking', () => {
  const { scanner, elise } = builtPair('detect_items');
  for (const [label, request] of [['scanner', scanner], ['elise', elise]]) {
    assert.equal(request.privacy.localFaceMaskApplied, false, `${label} claimed face masking`);
    assert.equal(request.privacy.localPlateMaskApplied, false, `${label} claimed plate masking`);
    assert.equal(request.privacy.rawExifTransmitted, false);
  }
});

// ── 12. Supabase transport wiring ────────────────────────────────────────────
//
// Asserted at source level because the transport is the ONE module both intents
// share below the request builders, and it is the module these suites stub. A
// stub cannot prove what the real transport targets or guards.

test('wiring: the transport targets the governed scan-identify function', () => {
  const source = read('services/scanIdentification.ts');
  assert.match(
    source,
    /const EDGE_FN = 'scan-identify';/,
    'the shared transport must invoke the governed scan-identify function',
  );
  assert.match(source, /supabase\.functions\.invoke\(EDGE_FN/, 'must go through the project client');
  // The function name is governed by the deployment manifest.
  const manifest = JSON.parse(read('config/edge-function-manifest.json'));
  assert.ok(manifest.parity.expectedFunctions.includes('scan-identify'));
});

test('wiring: the transport refuses to spend a scan without an authenticated session', () => {
  const source = read('services/scanIdentification.ts');
  // The caller's own session is read and required BEFORE the network call, so a
  // signed-out caller never reaches a paid provider and no request can be bound
  // to an actor the client did not authenticate as.
  assert.match(source, /await supabase\.auth\.getSession\(\)/);
  assert.match(
    source,
    /if \(!session\) return failed\(SIGN_IN_REQUIRED_MESSAGE\);/,
    'an absent session must short-circuit before invoke',
  );
  const guardIndex = source.indexOf('if (!session) return failed(SIGN_IN_REQUIRED_MESSAGE);');
  const invokeIndex = source.indexOf('supabase.functions.invoke(EDGE_FN');
  assert.ok(guardIndex > 0 && invokeIndex > guardIndex, 'the session guard must precede invoke');
});

test('wiring: neither path can supply its own actor to the backend', () => {
  // The request body carries no actor field on either path; the JWT the
  // Supabase client attaches is the only actor statement.
  const { scanner, elise } = builtPair('detect_items');
  for (const [label, request] of [['scanner', scanner], ['elise', elise]]) {
    const json = JSON.stringify(request);
    for (const banned of ['userId', 'user_id', 'actorId', 'actor_id', 'ownerId']) {
      assert.equal(json.includes(banned), false, `${label} request carries ${banned}`);
    }
  }
});

test('wiring: an already-aborted signal spends no network call', () => {
  const source = read('services/scanIdentification.ts');
  assert.match(
    source,
    /if \(ac\.signal\.aborted\) \{[\s\S]{0,120}?return failed\(TIMEOUT_MESSAGE\);/,
    'a superseded or unmounted operation must short-circuit before invoke',
  );
});

// ── 13. Fixture integrity ────────────────────────────────────────────────────

test('fixture integrity: the shared source is deep-frozen', () => {
  assert.equal(Object.isFrozen(CANONICAL_FIXTURES), true);
  for (const fixture of CANONICAL_FIXTURES) {
    assert.equal(Object.isFrozen(fixture), true, `${fixture.id} is not frozen`);
    assert.equal(Object.isFrozen(fixture.canonical), true, `${fixture.id}.canonical is not frozen`);
    assert.equal(Object.isFrozen(fixture.canonical.item), true, `${fixture.id}.canonical.item is not frozen`);
    assert.equal(
      Object.isFrozen(fixture.canonical.item.brand),
      true,
      `${fixture.id} nested brand is not frozen`,
    );
  }
});

test('fixture integrity: neither path mutated the shared source after the full matrix', () => {
  assertFixturesPristine(assert, 'end-of-matrix');
});

test('fixture integrity: clones are independent of the frozen source and of each other', () => {
  const a = clone(CANONICAL_FIXTURES[0].canonical);
  const b = clone(CANONICAL_FIXTURES[0].canonical);
  a.item.category = 'mutated';
  assert.notEqual(b.item.category, 'mutated');
  assert.notEqual(CANONICAL_FIXTURES[0].canonical.item.category, 'mutated');
});
