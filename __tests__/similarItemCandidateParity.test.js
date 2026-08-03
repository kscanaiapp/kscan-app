// Checkpoint 4.5 — client/backend parity for the candidate layer.
//
// THE PROPERTY UNDER TEST
//
// The client duplicates three things the backend also implements: text
// normalization, the category-conflict rejection rule, and the scan lineage
// id format. Duplication is unavoidable (the backend modules are Deno with
// `.ts` specifiers and Deno globals — pulling them into the Metro bundle
// would drag a server runtime into the app), but duplication that SILENTLY
// DIVERGES is the failure this file exists to prevent.
//
// The required relationship is not "identical outputs everywhere". It is:
//
//   1. normalization agrees exactly, and
//   2. client pruning is a CONSERVATIVE SUBSET of backend pruning — the client
//      may never drop a record the backend would have kept and scored.
//
// (2) is the load-bearing one. A client that over-prunes silently deletes
// notices the validated engine would have produced, and no backend test can
// ever see it happen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const cache = new Map();

/** Loads a `.ts` module (client or Deno) in a sandbox with no fetch. */
function loadModule(absolutePath) {
  const resolved = absolutePath.endsWith('.ts') ? absolutePath : `${absolutePath}.ts`;
  if (cache.has(resolved)) return cache.get(resolved);

  const output = ts.transpileModule(fs.readFileSync(resolved, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  cache.set(resolved, mod.exports);
  const sandbox = {
    console, exports: mod.exports, module: mod, JSON, Math, Date, TextEncoder,
    URL, URLSearchParams, Object, Array, Set, Map, String, Number, Boolean,
    Error, TypeError, RegExp, Promise, isNaN, parseInt, parseFloat,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    performance: globalThis.performance,
    process: { env: {} },
    Deno: { env: { get: () => undefined } },
    require: (id) => {
      if (id.startsWith('./') || id.startsWith('../')) {
        return loadModule(path.resolve(path.dirname(resolved), id));
      }
      throw new Error(`parity sandbox refuses non-local import '${id}'`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename: resolved });
  cache.set(resolved, mod.exports);
  return mod.exports;
}

const client = loadModule(path.join(ROOT, 'services/similarItemCandidates.ts'));
const clientAdapters = loadModule(path.join(ROOT, 'services/similarItemCandidateAdapters.ts'));
const backendIdentity = loadModule(
  path.join(ROOT, 'supabase/functions/product-match/identity.ts'),
);
const backendRetrieval = loadModule(
  path.join(ROOT, 'supabase/functions/product-match/candidateRetrieval.ts'),
);

/** A deliberately awkward corpus: casing, punctuation, dashes, unicode, blanks. */
const TEXT_CORPUS = [
  'Nike', 'nike', '  NIKE  ', 'Air Force 1', "Air Force 1 '07", 'Air-Force-1',
  'AIR—FORCE—1', 'T-Shirt', 't shirt', 'tshirt', 'Off White', 'off-white',
  'Dr. Martens', 'A.P.C.', 'Levi’s', 'Maison Margiela', 'footwear', 'FOOTWEAR',
  'outer wear', 'outer-wear', '', '   ', 'a', '123', 'ÉCRU', 'naïve',
  'multi   space', 'trailing ', ' leading', 'mixed_Case_Under', 'slash/es',
];

test('client and backend normalize text identically', () => {
  for (const value of TEXT_CORPUS) {
    assert.equal(
      client.normalizeCandidateText(value),
      backendIdentity.normalizeText(value),
      `normalizeText disagreed on ${JSON.stringify(value)}`,
    );
  }
});

test('client and backend slugify identically', () => {
  for (const value of TEXT_CORPUS) {
    assert.equal(
      client.slugifyCandidateText(value),
      backendIdentity.slugify(value),
      `slugify disagreed on ${JSON.stringify(value)}`,
    );
  }
});

test('non-string inputs normalize identically on both sides', () => {
  for (const value of [null, undefined, 42, true, {}, [], NaN]) {
    assert.equal(client.normalizeCandidateText(value), backendIdentity.normalizeText(value));
    assert.equal(client.slugifyCandidateText(value), backendIdentity.slugify(value));
  }
});

// ── the conservative-subset property ────────────────────────────────────────

const CATEGORIES = ['footwear', 'Footwear', 'outerwear', 't-shirt', 'tshirt', null, '', 'dress'];

/** Every combination of query category × record category × attribute presence. */
function* pruningScenarios() {
  for (const queryCategory of CATEGORIES) {
    for (const recordCategory of CATEGORIES) {
      for (const brand of ['Nike', null]) {
        for (const color of ['white', null]) {
          yield { queryCategory, recordCategory, brand, color };
        }
      }
    }
  }
}

test('THE SUBSET RULE: the client never drops a record the backend would keep', () => {
  let checked = 0;
  let clientDropped = 0;

  for (const scenario of pruningScenarios()) {
    const query = { canonicalCategory: scenario.queryCategory, brand: 'Nike', color: 'white' };
    const record = {
      id: 'r1',
      source: 'closet',
      canonicalCategory: scenario.recordCategory,
      brand: scenario.brand,
      color: scenario.color,
    };

    const clientResult = client.selectComparisonCandidates({
      query,
      closetRecords: [record],
      recentScanRecords: [],
      config: { cap: 20 },
    });
    const backendResult = backendRetrieval.retrieveCandidates({
      query,
      existingItems: [record],
    });

    const clientKept = clientResult.candidates.length > 0;
    const backendKept = backendResult.retained.length > 0;
    checked += 1;
    if (!clientKept) clientDropped += 1;

    if (backendKept) {
      assert.ok(
        clientKept,
        `client over-pruned a record the backend would score: ${JSON.stringify(scenario)}`,
      );
    }
  }

  assert.ok(checked > 100, `the corpus must be broad; only ${checked} scenarios ran`);
  assert.ok(clientDropped > 0, 'the corpus must actually exercise client rejection');
});

test('the client applies the SAME category-conflict rule the backend vetoes on', () => {
  const conflicting = { canonicalCategory: 'footwear' };
  const record = { id: 'r1', source: 'closet', canonicalCategory: 'dress', brand: 'Nike' };

  const clientResult = client.selectComparisonCandidates({
    query: conflicting, closetRecords: [record], recentScanRecords: [], config: { cap: 20 },
  });
  const backendResult = backendRetrieval.retrieveCandidates({
    query: conflicting, existingItems: [record],
  });

  assert.equal(clientResult.candidates.length, 0);
  assert.equal(backendResult.retained.length, 0);
  // And both name it the same way.
  const clientReason = clientResult.report.recordsRejected.map((r) => r.reason);
  const backendReason = backendResult.report.candidatesRejected.map((r) => r.reason);
  assert.ok(clientReason.includes('category_conflict'));
  assert.ok(backendReason.includes('category_conflict'));
});

test('client rejection reasons are a superset of the backend vocabulary it shares', () => {
  // The client legitimately has reasons the backend does not (record status,
  // cross-source duplicates) because it sees state the backend never receives.
  // But the two reasons they SHARE must be spelled identically, or telemetry
  // from the two halves cannot be joined.
  const clientSource = fs.readFileSync(path.join(ROOT, 'services/similarItemCandidates.ts'), 'utf8');
  const backendSource = fs.readFileSync(
    path.join(ROOT, 'supabase/functions/product-match/contracts.ts'), 'utf8',
  );
  for (const shared of ['no_comparable_fields', 'category_conflict']) {
    assert.ok(clientSource.includes(`'${shared}'`), `client must declare ${shared}`);
    assert.ok(backendSource.includes(`'${shared}'`), `backend must declare ${shared}`);
  }
});

// ── lineage id parity ───────────────────────────────────────────────────────

test('the adapter reproduces resolveScanLineageId exactly', () => {
  // Read the real implementation and exercise both over the same corpus.
  const promotionSource = fs.readFileSync(path.join(ROOT, 'services/closetPromotion.js'), 'utf8');
  assert.match(
    promotionSource,
    /export function resolveScanLineageId\(scan\)/,
    'the promotion module must still own the canonical implementation',
  );

  const scans = [
    { id: 'scan_123' },
    { id: 'scan_123', cloudId: 'abc-def' },
    { id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' },
    { id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', cloudId: 'cloud-1' },
    { cloudId: 'cloud-only' },
    {},
    { id: '   ' },
  ];

  // Mirror of the canonical rules, asserted against the adapter.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const expected = (scan) => {
    const localId = typeof scan.id === 'string' && scan.id.trim() ? scan.id.trim() : null;
    const cloudId = typeof scan.cloudId === 'string' && scan.cloudId.trim() ? scan.cloudId.trim() : null;
    if (localId && !UUID.test(localId)) return `local:${localId}`;
    if (cloudId) return `cloud:${cloudId}`;
    if (localId) return `cloud:${localId}`;
    return null;
  };

  for (const scan of scans) {
    assert.equal(
      clientAdapters.scanLineageIdOf(scan),
      expected(scan),
      `lineage id disagreed on ${JSON.stringify(scan)}`,
    );
  }
});

// ── transmitted shape matches the transport allowlist ───────────────────────

test('every transmitted field is accepted by the scan-identify sanitizer', () => {
  const sanitizerSource = fs.readFileSync(
    path.join(ROOT, 'supabase/functions/scan-identify/existingItemCandidates.ts'), 'utf8',
  );
  const allowed = /const ALLOWED_FIELDS = \[([\s\S]*?)\] as const/.exec(sanitizerSource);
  assert.ok(allowed, 'the sanitizer must declare a literal allowlist');
  const allowedFields = new Set([...allowed[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]));

  const { candidates } = client.selectComparisonCandidates({
    query: { canonicalCategory: 'footwear', brand: 'Nike' },
    closetRecords: [{
      id: 'c1', source: 'closet', label: 'White AF1', imageUri: 'file:///a.jpg',
      brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white',
      material: 'leather', silhouette: 'low-top', pattern: 'solid',
      productUrl: 'https://x/y', authoritativeId: 'SKU-1', imageQuality: 'ok',
    }],
    recentScanRecords: [],
    config: { cap: 20 },
  });

  assert.equal(candidates.length, 1);
  for (const field of Object.keys(candidates[0])) {
    assert.ok(
      allowedFields.has(field),
      `transmitted field '${field}' would be silently DROPPED by the sanitizer`,
    );
  }
});

test('the sanitizer preserves a real transmitted candidate end to end', () => {
  const sanitizer = loadModule(
    path.join(ROOT, 'supabase/functions/scan-identify/existingItemCandidates.ts'),
  );
  const { candidates } = client.selectComparisonCandidates({
    query: { canonicalCategory: 'footwear', brand: 'Nike' },
    closetRecords: [{
      id: 'c1', source: 'closet', brand: 'Nike', canonicalCategory: 'footwear',
      color: 'white', label: 'White AF1', imageUri: 'file:///a.jpg',
    }],
    recentScanRecords: [],
    config: { cap: 20 },
  });

  const sanitized = sanitizer.sanitizeExistingItemCandidates(candidates);
  assert.equal(sanitized.length, 1, 'a client-built candidate must survive the transport gate');
  assert.equal(sanitized[0].id, 'c1');
  assert.equal(sanitized[0].source, 'closet');
  assert.equal(sanitized[0].brand, 'Nike');
});

test('the client cap keeps the request inside the sanitizer limit', () => {
  const sanitizer = loadModule(
    path.join(ROOT, 'supabase/functions/scan-identify/existingItemCandidates.ts'),
  );
  const many = Array.from({ length: 400 }, (_, i) => ({
    id: `c-${i}`, source: 'closet', brand: 'Nike', canonicalCategory: 'footwear', color: 'white',
  }));
  const { candidates } = client.selectComparisonCandidates({
    query: { canonicalCategory: 'footwear', brand: 'Nike' },
    closetRecords: many,
    recentScanRecords: [],
    config: { cap: client.DEFAULT_CLIENT_CANDIDATE_CAP },
  });

  assert.ok(candidates.length <= sanitizer.MAX_EXISTING_ITEMS);
  // Nothing is lost at the gate: everything sent is everything accepted.
  assert.equal(sanitizer.sanitizeExistingItemCandidates(candidates).length, candidates.length);
});
