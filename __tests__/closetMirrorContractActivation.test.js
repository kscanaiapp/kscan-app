// Build 2.5 Step 2 — `closet_mirror` contract activation (client half).
//
// The backend half lives in
// `supabase/functions/scan-identify/closetMirrorEntryPath.test.ts` and runs
// under Deno against the real Edge Function modules. This file covers what a
// Node test can reach: the JSON schema, the client vocabulary, the three-way
// agreement between them and the backend mirror, the request the client
// actually builds, and the side effects a Mirror intake must still not have.
//
// EVERY vocabulary assertion here reads the REAL authoritative file from disk.
// Nothing is restated from a shared fixture: a test that declared the vocabulary
// once and compared it to itself would pass while the three surfaces drifted,
// which is the precise failure mode the parity gate exists to catch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const SCHEMA_PATH = path.join(ROOT, 'contracts', 'fashion-identification-v2.schema.json');
const BACKEND_MIRROR = path.join(ROOT, 'supabase', 'functions', '_shared', 'fashionIdentificationV2.ts');
const CLIENT_MIRROR = path.join(ROOT, 'types', 'fashionIdentificationV2.ts');

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

const MIRROR = 'closet_mirror';

/** Reads a `const NAME = [ ... ] as const;` string array out of real TS source. */
function readVocabulary(file, name) {
  const source = fs.readFileSync(file, 'utf8');
  const match = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source);
  assert.ok(match, `${name} not found in ${path.relative(ROOT, file)}`);
  return match[1]
    .split(',')
    .map((entry) => entry.replace(/\/\/.*$/gm, '').trim())
    .filter(Boolean)
    .map((entry) => {
      const quoted = /^'([^']*)'$|^"([^"]*)"$/.exec(entry);
      assert.ok(quoted, `${name} carries a non-literal member: ${entry}`);
      return quoted[1] ?? quoted[2];
    });
}

// ── Module loading (mirrors __tests__/closetIdentificationV2.test.js) ─────────

function transpile(rel) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
}

function runModule(rel, requireShim) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, {
    filename: rel,
  })(mod.exports, mod, requireShim);
  return mod.exports;
}

function loadAdapter() {
  let seq = 0;
  const crypto = {
    getRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 256),
    randomUUID: () => {
      seq += 1;
      return `00000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`;
    },
  };
  const contractTypes = runModule('types/fashionIdentificationV2.ts', () => ({}));
  const candidateTypes = runModule('types/closetCandidate.ts', () => ({}));
  const gateway = runModule('services/fashionEvidenceGateway.ts', (spec) =>
    spec === 'expo-crypto' ? crypto : {},
  );
  const core = runModule('services/fashionIdentificationV2Core.ts', (spec) => {
    if (spec === '../types/fashionIdentificationV2') return contractTypes;
    if (spec === './fashionEvidenceGateway') return gateway;
    return {};
  });
  return runModule('services/closetIdentificationV2.ts', (spec) => {
    if (spec === '../types/fashionIdentificationV2') return contractTypes;
    if (spec === '../types/closetCandidate') return candidateTypes;
    if (spec === './fashionEvidenceGateway') return gateway;
    if (spec === './fashionIdentificationV2Core') return core;
    if (spec === '../constants/featureFlags') {
      return { resolveClosetCandidateStagingEnabled: () => true };
    }
    return {};
  });
}

const adapter = loadAdapter();

function mirrorRequest() {
  const built = adapter.buildClosetV2Request({
    evidence: {
      evidenceId: '11111111-2222-4333-8444-555555555555',
      imageBase64: 'QUJDRA==',
      mimeType: 'image/jpeg',
      width: 896,
      height: 1200,
      source: 'gallery',
    },
    entryPath: adapter.closetEntryPathKeyForSource('mirror_extract'),
    platform: 'android',
    requestId: 'req_closet_mirror_1',
  });
  assert.equal(built.kind, 'ok', JSON.stringify(built));
  return built.request;
}

// ── CLOSET-MIRROR-JSON-SCHEMA-ACCEPTED ───────────────────────────────────────

test('CLOSET-MIRROR-JSON-SCHEMA-ACCEPTED: the schema enum carries closet_mirror', () => {
  const paths = schema.definitions.entryPath.enum;
  assert.ok(Array.isArray(paths));
  assert.ok(paths.includes(MIRROR), 'schema entryPath enum is missing closet_mirror');
  // Still an enum, not a free string: the requirement is one new allowed value,
  // not a loosened field.
  assert.equal(schema.definitions.entryPath.type, 'string');
  assert.ok(!schema.definitions.entryPath.pattern, 'entryPath acquired a pattern escape hatch');
  assert.ok(!schema.definitions.entryPath.anyOf, 'entryPath acquired an anyOf escape hatch');
});

test('the schema still requires entryPath and still forbids a generic source', () => {
  assert.deepEqual(schema.definitions.request.properties.source.required, ['entryPath', 'platform']);
  const paths = schema.definitions.entryPath.enum;
  for (const generic of ['camera', 'upload', 'gallery', 'mirror', 'any', '*']) {
    assert.ok(!paths.includes(generic), `entryPath admitted a generic value: ${generic}`);
  }
});

// A real request, validated field-by-field against the real schema definitions.
// Deliberately narrow rather than a general JSON Schema implementation: adding
// a validator dependency is out of scope for this phase, and a hand-rolled
// general walker would be less trustworthy than explicitly naming what is
// checked.
test('a built Mirror request satisfies every schema enum it touches', () => {
  const request = mirrorRequest();
  const checks = [
    ['contractVersion', request.contractVersion, schema.definitions.contractVersion.enum],
    ['intent', request.intent, schema.definitions.intent.enum],
    ['mode', request.mode, schema.definitions.mode.enum],
    ['source.entryPath', request.source.entryPath, schema.definitions.entryPath.enum],
    ['source.platform', request.source.platform, schema.definitions.platform.enum],
    // `transport` is a oneOf; the base64 branch is the only one a Closet
    // request ever builds.
    ['evidence[0].transport.type', request.evidence[0].transport.type, schema.definitions.transport.oneOf[0].properties.type.enum],
    ['evidence[0].metadata.schemaVersion', request.evidence[0].metadata.schemaVersion, schema.definitions.imageMetadata.properties.schemaVersion.enum],
  ];
  for (const [label, value, allowed] of checks) {
    assert.ok(Array.isArray(allowed), `${label} has no schema enum`);
    assert.ok(allowed.includes(value), `${label}=${value} is not permitted by the schema`);
  }
  for (const field of schema.definitions.privacy.required) {
    assert.equal(request.privacy[field], false, `privacy.${field} is not a truthful false`);
  }
});

// ── CLOSET-MIRROR-CLIENT-VOCABULARY-ACCEPTED ─────────────────────────────────

test('CLOSET-MIRROR-CLIENT-VOCABULARY-ACCEPTED: the client vocabulary carries closet_mirror', () => {
  const client = readVocabulary(CLIENT_MIRROR, 'FASHION_IDENTIFICATION_ENTRY_PATHS');
  assert.ok(client.includes(MIRROR), 'client vocabulary is missing closet_mirror');
});

// ── CLOSET-MIRROR-THREE-WAY-PARITY / EXISTING-ENTRY-PATHS-UNCHANGED ──────────
//
// The repository's own gate is `__tests__/fashionIdentificationContractParity.test.js`,
// which compares the three surfaces positionally. This adds the Build 2.5
// specific claim it does not make: that the difference from Step 1 is exactly
// one appended value, in the Closet group, on all three surfaces at once.

test('CLOSET-MIRROR-THREE-WAY-PARITY: all three real surfaces agree, exactly and in order', () => {
  const expected = [
    'scanner_camera',
    'scanner_gallery',
    'elise_camera',
    'elise_gallery',
    'elise_header_gallery',
    'scanner_handoff',
    'closet_camera',
    'closet_gallery',
    'closet_mirror',
  ];
  assert.deepEqual(schema.definitions.entryPath.enum, expected, 'schema drifted');
  assert.deepEqual(readVocabulary(BACKEND_MIRROR, 'FASHION_IDENTIFICATION_ENTRY_PATHS'), expected, 'backend drifted');
  assert.deepEqual(readVocabulary(CLIENT_MIRROR, 'FASHION_IDENTIFICATION_ENTRY_PATHS'), expected, 'client drifted');
});

test('EXISTING-ENTRY-PATHS-UNCHANGED: Step 1 values are preserved, renamed or removed by nothing', () => {
  const stepOne = [
    'scanner_camera',
    'scanner_gallery',
    'elise_camera',
    'elise_gallery',
    'elise_header_gallery',
    'scanner_handoff',
    'closet_camera',
    'closet_gallery',
  ];
  const now = schema.definitions.entryPath.enum;
  // Every prior value survives, at its original index.
  stepOne.forEach((value, index) => {
    assert.equal(now[index], value, `entry path at index ${index} changed`);
  });
  // And exactly one value was added.
  assert.equal(now.length, stepOne.length + 1);
  assert.equal(now[now.length - 1], MIRROR);
});

// ── Request construction ─────────────────────────────────────────────────────

test('MIRROR-EXTRACT-BUILDS-CLOSET-MIRROR-ENTRY-PATH', () => {
  assert.equal(mirrorRequest().source.entryPath, MIRROR);
});

test('MIRROR-EXTRACT-RETAINS-IDENTIFY-FOR-CLOSET and DETECT-ITEMS mode', () => {
  const request = mirrorRequest();
  assert.equal(request.intent, 'identify_for_closet');
  assert.equal(request.mode, 'detect_items');
  assert.equal(request.contractVersion, 'fashion-identification-v2');
});

test('the mirror mapping is one-way: only mirror_extract yields closet_mirror', () => {
  assert.equal(adapter.closetEntryPathKeyForSource('mirror_extract'), 'mirror');
  assert.equal(adapter.CLOSET_ENTRY_PATHS.mirror, MIRROR);
  // The forbidden mappings, stated as the negatives they are.
  assert.notEqual(adapter.CLOSET_ENTRY_PATHS.mirror, 'closet_gallery');
  assert.notEqual(adapter.CLOSET_ENTRY_PATHS.mirror, 'scanner_gallery');
  assert.notEqual(adapter.CLOSET_ENTRY_PATHS.mirror, 'scanner_camera');
  // And camera/gallery were not disturbed by the addition.
  assert.equal(adapter.CLOSET_ENTRY_PATHS.camera, 'closet_camera');
  assert.equal(adapter.CLOSET_ENTRY_PATHS.gallery, 'closet_gallery');
});

test('UNKNOWN-CANDIDATE-SOURCE-STILL-FAILS-CLOSED at the mapping itself', () => {
  for (const unknown of ['mirror', 'closet_mirror', 'mirror_selfie', 'selfie', 'receipt_screenshot', '', null, undefined, 0, {}, []]) {
    assert.equal(
      adapter.closetEntryPathKeyForSource(unknown),
      null,
      `${JSON.stringify(unknown)} resolved to an entry path`,
    );
  }
});

test('buildClosetV2Request rejects an entry-path key outside the closed map', () => {
  for (const badKey of ['mirror_extract', 'closet_mirror', 'scanner', 'toString', '__proto__', null, undefined]) {
    const built = adapter.buildClosetV2Request({
      evidence: {
        evidenceId: '11111111-2222-4333-8444-555555555555',
        imageBase64: 'QUJDRA==',
        mimeType: 'image/jpeg',
      },
      entryPath: badKey,
      platform: 'android',
      requestId: 'req_bad',
    });
    assert.equal(built.kind, 'rejected', `${String(badKey)} built a request`);
    assert.equal(built.reason, 'invalid_entry_path');
  }
});

// ── Domain separation ────────────────────────────────────────────────────────

test('CLOSET-MIRROR-CANNOT-SELECT-SHOPPING-INTENT', () => {
  const built = adapter.buildClosetV2Request({
    evidence: {
      evidenceId: '11111111-2222-4333-8444-555555555555',
      imageBase64: 'QUJDRA==',
      mimeType: 'image/jpeg',
    },
    entryPath: 'mirror',
    platform: 'android',
    requestId: 'req_closet_mirror_1',
    // Hostile: every field a caller might hope confers commerce.
    intent: 'identify_and_shop',
    mode: 'identify_selected_item',
    commerce: true,
    shopping: true,
  });
  assert.equal(built.kind, 'ok');
  assert.equal(built.request.intent, 'identify_for_closet');
  assert.equal(built.request.mode, 'detect_items');
  assert.equal(built.request.commerce, undefined);
  assert.equal(built.request.shopping, undefined);
});

test('CLOSET-MIRROR-DOES-NOT-CALL-SCANNER-ENTRY-PATH: validation rejects one on a Mirror request', () => {
  for (const hostile of [
    'scanner_camera',
    'scanner_gallery',
    'scanner_handoff',
    'elise_camera',
    'elise_gallery',
    'elise_header_gallery',
  ]) {
    const request = mirrorRequest();
    request.source.entryPath = hostile;
    assert.equal(adapter.validateClosetV2Request(request), false, hostile);
  }
  // The Mirror path itself validates.
  assert.equal(adapter.validateClosetV2Request(mirrorRequest()), true);
});

// CLOSET-MIRROR-CREATES-NO-COMMERCE-RESULT /
// CLOSET-MIRROR-CREATES-NO-RECENT-SCAN /
// CLOSET-MIRROR-CREATES-NO-CLOSET-ITEM-BEFORE-PROMOTION /
// CLOSET-MIRROR-DOES-NOT-AUTO-PROMOTE-CANDIDATE
//
// Source-level, because the only trustworthy proof that a side effect does not
// happen is that no call site for it exists. Activating an entry path could not
// itself create one — which is exactly the claim under test, since "additive
// vocabulary only" is the whole scope of this step.
test('the Mirror staging module reaches no commerce, Recent Scan, or Closet-commit surface', () => {
  const mirrorSource = fs.readFileSync(path.join(ROOT, 'services', 'closetMirrorStaging.ts'), 'utf8');
  const forbidden = [
    'identify_and_shop',
    'identify_for_style',
    'scanCommerceRouter',
    'shoppingProvider',
    'purchaseOptions',
    'saveRecentScan',
    'recordRecentScan',
    'createRecentScan',
    'saveScanToCloud',
    'addClosetItem',
    'saveClosetItem',
    'commitClosetItem',
    'promoteClosetCandidate',
  ];
  for (const symbol of forbidden) {
    assert.ok(
      !mirrorSource.includes(symbol),
      `closetMirrorStaging.ts references a forbidden surface: ${symbol}`,
    );
  }
});

test('no Mirror or Closet-candidate module auto-promotes a candidate into the Closet', () => {
  const modules = [
    'services/closetMirrorStaging.ts',
    'services/closetCandidateClassification.js',
    'services/closetIdentificationV2.ts',
  ];
  for (const rel of modules) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const symbol of ['promoteClosetCandidate', 'promoteCandidate', 'commitToCloset']) {
      assert.ok(!source.includes(symbol), `${rel} calls ${symbol}`);
    }
  }
});

// ── Feature-flag state ───────────────────────────────────────────────────────
//
// Step 2 activates the CONTRACT, not user reachability. The deployed backend
// still predates `closet_mirror`, and Steps 3-5 (capture, extraction,
// end-to-end certification) have not run.

test('MIRROR FEATURE FLAG DEFAULT: false, and only the exact string "true" opts in', () => {
  const flags = fs.readFileSync(path.join(ROOT, 'constants', 'featureFlags.ts'), 'utf8');
  assert.ok(
    /export function resolveMirrorSelfieV1Enabled\([\s\S]*?\)\s*:\s*boolean\s*\{\s*return value === 'true';/.test(flags),
    'the Mirror flag resolver is no longer an exact "true" opt-in',
  );
  assert.ok(
    flags.includes('MIRROR_SELFIE_V1 && CLOSET_CANDIDATE_STAGING_ACTIVE && CLOSET_BATCH_REVIEW_V2_ACTIVE'),
    'MIRROR_SELFIE_V1_ACTIVE no longer requires all three parents',
  );
  // Nothing hard-enables it.
  assert.ok(!/MIRROR_SELFIE_V1\s*=\s*true/.test(flags));
});

test('MIRROR PRODUCTION PROFILE ENABLEMENT: none — no build profile sets the flag', () => {
  const eas = fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8');
  assert.ok(
    !eas.includes('MIRROR_SELFIE'),
    'eas.json now sets a Mirror flag; Step 2 must not enable the feature',
  );
});

/**
 * Strip comments before matching a forbidden symbol.
 *
 * The Mirror sources NAME the symbols they must never call, in prose, so that
 * the boundary is legible where the code is. A naive substring match over the
 * whole file therefore fails on the very documentation that records the rule.
 * Reachability is a property of code, so only code is searched.
 */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('MIRROR UI REACHABILITY: no screen or component reaches the Mirror STAGING API', () => {
  // NARROWED BY BUILD 2.5 STEP 3, deliberately.
  //
  // This test was written when no Mirror UI existed at all, so it asserted that
  // nothing under app/ or components/ mentioned Mirror in any form. Step 3 adds
  // the extraction sheet and its Closet entry point, both gated on
  // MIRROR_SELFIE_V1_ACTIVE, so a blanket ban is no longer the property worth
  // holding.
  //
  // What still matters — and is what this now checks — is that NO UI reaches
  // the STAGING adapter. Staging creates Closet candidates, and wiring a screen
  // to it would jump Step 3 straight past Step 4's review into the candidate
  // pipeline. Flag containment itself is proved separately, by
  // __tests__/mirrorExtractionContainment.test.js.
  const roots = ['app', 'components'];
  const offenders = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      const source = codeOnly(fs.readFileSync(full, 'utf8'));
      if (
        source.includes('closetMirrorStaging') ||
        source.includes('stageMirrorSelfieGarmentCrops') ||
        source.includes('addMirrorGarmentCrops')
      ) {
        offenders.push(path.relative(ROOT, full));
      }
    }
  };
  for (const root of roots) walk(path.join(ROOT, root));
  assert.deepEqual(offenders, [], 'a UI surface reached the Mirror STAGING API');
});
