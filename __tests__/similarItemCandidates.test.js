// Checkpoint 4.5 — on-device candidate selection, pruning, prioritization,
// deduplication, bounding, request shape and the failure contract.
//
// The scoring ENGINE is not exercised here — that is Checkpoint 4's Deno
// suite. These tests only prove which records reach the wire, in what order,
// and that nothing here can fail a scan.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/** Loads a client TypeScript module without pulling in React Native. */
function loadModule(relative, requireMap = {}) {
  const filename = path.join(ROOT, relative);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  const sandbox = {
    console, exports: mod.exports, module: mod, JSON, Math, Date, TextEncoder,
    Object, Array, Set, Map, String, Number, Boolean, Error, RegExp, Promise,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    process: { env: {} },
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('./') || id.startsWith('../')) {
        return loadModule(path.join(path.dirname(relative), id), requireMap);
      }
      throw new Error(`unexpected import '${id}'`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const selection = loadModule('services/similarItemCandidates.ts');
const adapters = loadModule('services/similarItemCandidateAdapters.ts');

const SNEAKER_QUERY = {
  brand: 'Nike',
  visibleBrandText: 'Nike',
  model: 'Air Force 1',
  canonicalCategory: 'footwear',
  color: 'white',
};

function closetRecord(overrides = {}) {
  return {
    id: 'closet-1',
    source: 'closet',
    brand: 'Nike',
    canonicalCategory: 'footwear',
    color: 'white',
    ...overrides,
  };
}

function recentRecord(overrides = {}) {
  return {
    id: 'recent-1',
    source: 'recent_scan',
    brand: 'Nike',
    canonicalCategory: 'footwear',
    color: 'white',
    ...overrides,
  };
}

function select(input) {
  return selection.selectComparisonCandidates({
    query: SNEAKER_QUERY,
    closetRecords: [],
    recentScanRecords: [],
    config: { cap: selection.DEFAULT_CLIENT_CANDIDATE_CAP },
    ...input,
  });
}

// ── configuration ───────────────────────────────────────────────────────────

test('the client cap never exceeds the transport ceiling', () => {
  assert.ok(selection.DEFAULT_CLIENT_CANDIDATE_CAP <= selection.TRANSPORT_CANDIDATE_CEILING);
  // And it matches the backend's scoring cap: a 21st candidate is payload the
  // backend is contractually guaranteed to discard before scoring.
  const backend = fs.readFileSync(
    path.join(ROOT, 'supabase/functions/product-match/candidateRetrieval.ts'),
    'utf8',
  );
  const backendCap = /MAX_CANDIDATES_SCORED\s*=\s*(\d+)/.exec(backend);
  assert.ok(backendCap, 'the backend must declare its scoring cap as a literal');
  assert.equal(
    selection.DEFAULT_CLIENT_CANDIDATE_CAP,
    Number(backendCap[1]),
    'client cap must equal the backend scoring cap — see DEFAULT_CLIENT_CANDIDATE_CAP',
  );
});

test('a configured cap is clamped to a sane range rather than trusted', () => {
  const env = selection.CLIENT_CANDIDATE_CAP_ENV;
  assert.equal(selection.readCandidateSelectionConfig({}).cap, selection.DEFAULT_CLIENT_CANDIDATE_CAP);
  assert.equal(selection.readCandidateSelectionConfig({ [env]: '5' }).cap, 5);
  assert.equal(selection.readCandidateSelectionConfig({ [env]: '0' }).cap, 1);
  assert.equal(
    selection.readCandidateSelectionConfig({ [env]: '9999' }).cap,
    selection.TRANSPORT_CANDIDATE_CEILING,
    'an over-large cap would be rejected wholesale by the sanitizer',
  );
  assert.equal(
    selection.readCandidateSelectionConfig({ [env]: 'banana' }).cap,
    selection.DEFAULT_CLIENT_CANDIDATE_CAP,
  );
});

// ── pruning ─────────────────────────────────────────────────────────────────

test('an empty device produces no candidates and an honest report', () => {
  const { candidates, report } = select({});
  assert.deepEqual([...candidates], []);
  assert.equal(report.recordsLoaded.total, 0);
  assert.equal(report.recordsConsidered, 0);
  assert.equal(report.recordsTransmitted, 0);
  assert.deepEqual([...report.recordsRejected], []);
});

test('a record with no id or an unknown source is rejected as unusable', () => {
  const { report } = select({
    closetRecords: [
      closetRecord({ id: '' }),
      closetRecord({ id: 'ok' }),
      { id: 'x', source: 'wardrobe', brand: 'Nike' },
      null,
    ],
  });
  const byReason = Object.fromEntries(report.recordsRejected.map((r) => [r.reason, r.count]));
  assert.equal(byReason.unusable_record, 3);
  assert.equal(report.recordsConsidered, 1);
});

test('archived and soft-deleted records never reach the wire', () => {
  const { candidates, report } = select({
    closetRecords: [
      closetRecord({ id: 'live' }),
      closetRecord({ id: 'gone', status: 'deleted' }),
      closetRecord({ id: 'archived', status: 'archived' }),
    ],
  });
  assert.deepEqual([...candidates.map((c) => c.id)], ['live']);
  const byReason = Object.fromEntries(report.recordsRejected.map((r) => [r.reason, r.count]));
  assert.equal(byReason.record_not_active, 2);
});

test('unfinished intake records are excluded, but an absent status means active', () => {
  const { candidates } = select({
    closetRecords: [
      closetRecord({ id: 'pending', status: 'pending' }),
      closetRecord({ id: 'failed', status: 'failed' }),
      closetRecord({ id: 'legacy', status: undefined }),
      closetRecord({ id: 'explicit', status: 'active' }),
    ],
  });
  assert.deepEqual([...candidates.map((c) => c.id)].sort(), ['explicit', 'legacy']);
});

test('a record with nothing comparable is rejected before transport', () => {
  const { candidates, report } = select({
    closetRecords: [{ id: 'bare', source: 'closet', label: 'Something' }],
  });
  assert.equal(candidates.length, 0);
  const byReason = Object.fromEntries(report.recordsRejected.map((r) => [r.reason, r.count]));
  assert.equal(byReason.no_comparable_fields, 1);
});

test('a structural category conflict is pruned on device, matching the backend veto', () => {
  const { candidates, report } = select({
    closetRecords: [
      closetRecord({ id: 'shoe', canonicalCategory: 'footwear' }),
      closetRecord({ id: 'coat', canonicalCategory: 'outerwear' }),
    ],
  });
  assert.deepEqual([...candidates.map((c) => c.id)], ['shoe']);
  const byReason = Object.fromEntries(report.recordsRejected.map((r) => [r.reason, r.count]));
  assert.equal(byReason.category_conflict, 1);
});

test('pruning is CONSERVATIVE: an unknown category on either side keeps the record', () => {
  const { candidates } = select({
    closetRecords: [closetRecord({ id: 'unknown-cat', canonicalCategory: null })],
  });
  assert.equal(candidates.length, 1, 'the validated backend scorer decides, not the client');

  const noQueryCategory = selection.selectComparisonCandidates({
    query: { brand: 'Nike' },
    closetRecords: [closetRecord({ id: 'any', canonicalCategory: 'outerwear' })],
    recentScanRecords: [],
    config: { cap: 20 },
  });
  assert.equal(noQueryCategory.candidates.length, 1);
});

// ── deduplication across sources ────────────────────────────────────────────

test('one garment in both lists collapses to a single candidate', () => {
  // The Closet item was promoted from the scan, so it stores the scan's
  // lineage id; the scan presents its own lineage id as its identity.
  const { candidates, report } = select({
    closetRecords: [closetRecord({ id: 'closet-af1', mirrorOfId: 'local:scan-9' })],
    recentScanRecords: [recentRecord({ id: 'scan-9', mirrorOfId: 'local:scan-9' })],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, 'closet', 'the Closet copy is the curated one');
  const byReason = Object.fromEntries(report.recordsRejected.map((r) => [r.reason, r.count]));
  assert.equal(byReason.duplicate_record, 1);
});

test('a literal id collision across the two lists also collapses', () => {
  const { candidates } = select({
    closetRecords: [closetRecord({ id: 'shared-id' })],
    recentScanRecords: [recentRecord({ id: 'shared-id' })],
  });
  assert.equal(candidates.length, 1);
});

test('distinct items are never collapsed', () => {
  const { candidates } = select({
    closetRecords: [closetRecord({ id: 'a' }), closetRecord({ id: 'b' })],
    recentScanRecords: [recentRecord({ id: 'c' })],
  });
  assert.equal(candidates.length, 3);
});

// ── prioritization ──────────────────────────────────────────────────────────

test('prioritization is a coarse tier ladder, strongest evidence first', () => {
  const tierOf = (record) => selection.priorityTierOf(SNEAKER_QUERY, record);

  // An identifier present on only ONE side grants no identifier tier — the
  // record falls through to whatever else it genuinely agrees on.
  assert.equal(
    tierOf(closetRecord({ authoritativeId: 'SKU-1' })),
    selection.PRIORITY_TIERS.BRAND_AND_CATEGORY,
    'a one-sided identifier is not agreement; brand+category still applies',
  );
  assert.equal(
    tierOf({ id: 'lonely', source: 'closet', authoritativeId: 'SKU-1' }),
    selection.PRIORITY_TIERS.RESIDUAL,
    'with nothing else agreeing, a one-sided identifier leaves the record residual',
  );

  const withQueryId = { ...SNEAKER_QUERY, authoritativeId: 'SKU-1' };
  assert.equal(
    selection.priorityTierOf(withQueryId, closetRecord({ authoritativeId: 'SKU-1' })),
    selection.PRIORITY_TIERS.AUTHORITATIVE_ID,
  );
  assert.equal(
    selection.priorityTierOf(withQueryId, closetRecord({ authoritativeId: 'SKU-OTHER' })),
    selection.PRIORITY_TIERS.BRAND_AND_CATEGORY,
    'a DISAGREEING identifier must not grant the top tier',
  );

  assert.equal(
    tierOf(closetRecord({ model: 'Air Force 1' })),
    selection.PRIORITY_TIERS.BRAND_AND_MODEL,
  );
  assert.equal(tierOf(closetRecord({})), selection.PRIORITY_TIERS.BRAND_AND_CATEGORY);
  assert.equal(
    tierOf(closetRecord({ brand: 'Adidas', subtype: 'sneaker' })),
    selection.PRIORITY_TIERS.CATEGORY,
  );
  // The ladder is ordered: every tier constant is strictly increasing.
  const ordered = [
    selection.PRIORITY_TIERS.AUTHORITATIVE_ID,
    selection.PRIORITY_TIERS.PRODUCT_URL,
    selection.PRIORITY_TIERS.BRAND_AND_MODEL,
    selection.PRIORITY_TIERS.BRAND_AND_CATEGORY,
    selection.PRIORITY_TIERS.CATEGORY_AND_SUBTYPE,
    selection.PRIORITY_TIERS.CATEGORY,
    selection.PRIORITY_TIERS.RESIDUAL,
  ];
  for (let i = 1; i < ordered.length; i += 1) {
    assert.ok(ordered[i] > ordered[i - 1], 'tiers must be strictly ordered');
  }
});

test('when more candidates are eligible than fit, the strongest tiers are kept', () => {
  const weak = Array.from({ length: 30 }, (_, i) =>
    closetRecord({ id: `weak-${i}`, brand: 'Adidas' }));
  const strong = closetRecord({ id: 'strong', model: 'Air Force 1' });
  const { candidates, report } = select({
    closetRecords: [...weak, strong],
    config: { cap: 3 },
  });
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].id, 'strong', 'the strongest tier must survive the cap');
  const byReason = Object.fromEntries(report.recordsRejected.map((r) => [r.reason, r.count]));
  assert.equal(byReason.over_client_cap, 28);
});

test('selection is deterministic — identical input yields an identical request', () => {
  const build = () => select({
    closetRecords: [
      closetRecord({ id: 'b', updatedAtMs: 100 }),
      closetRecord({ id: 'a', updatedAtMs: 100 }),
      closetRecord({ id: 'c', updatedAtMs: 200 }),
    ],
    recentScanRecords: [recentRecord({ id: 'd' })],
  });
  const first = build();
  const second = build();
  assert.equal(JSON.stringify(first.candidates), JSON.stringify(second.candidates));
  // Recency orders within a tier, then id breaks the remaining tie.
  assert.deepEqual([...first.candidates.map((c) => c.id)], ['c', 'a', 'b', 'd']);
});

test('Closet outranks Recent Scans within the same tier, but never excludes it', () => {
  const { candidates } = select({
    closetRecords: [closetRecord({ id: 'from-closet' })],
    recentScanRecords: [recentRecord({ id: 'from-recent' })],
  });
  assert.deepEqual([...candidates.map((c) => c.source)], ['closet', 'recent_scan']);
});

// ── transmitted shape ───────────────────────────────────────────────────────

test('the transmitted payload carries only allowlisted fields', () => {
  const { candidates } = select({
    closetRecords: [closetRecord({
      id: 'c1',
      label: 'White AF1',
      imageUri: 'file:///closet/af1.jpg',
      status: 'active',
      updatedAtMs: 12345,
      mirrorOfId: 'local:scan-1',
      subtype: 'sneaker',
      ownerId: 'user-secret',
      notes: 'private note',
    })],
  });
  const keys = Object.keys(candidates[0]).sort();
  for (const forbidden of ['status', 'updatedAtMs', 'mirrorOfId', 'subtype', 'ownerId', 'notes']) {
    assert.ok(!keys.includes(forbidden), `${forbidden} must not be transmitted`);
  }
  assert.ok(keys.includes('id') && keys.includes('source'));
});

test('the transmitted payload never contains image bytes or a data URI', () => {
  const { candidates } = select({
    closetRecords: [closetRecord({ imageUri: 'file:///closet/af1.jpg' })],
  });
  const serialized = JSON.stringify(candidates);
  assert.ok(!/data:image/i.test(serialized), 'no inline image data may be transmitted');
  assert.ok(!/base64/i.test(serialized));
});

test('empty fields are omitted rather than sent as null', () => {
  const { candidates } = select({
    closetRecords: [{ id: 'sparse', source: 'closet', brand: 'Nike', color: '   ' }],
  });
  const candidate = candidates[0];
  assert.ok(!('color' in candidate), 'a blank field must not occupy payload');
  assert.ok(!('material' in candidate));
  assert.equal(candidate.brand, 'Nike');
});

test('payload size is measured, and a sparse record is materially smaller', () => {
  const rich = select({
    closetRecords: [closetRecord({
      id: 'rich', label: 'White AF1', imageUri: 'file:///closet/af1.jpg',
      model: 'Air Force 1', material: 'leather', silhouette: 'low-top', pattern: 'solid',
    })],
  });
  const sparse = select({ closetRecords: [{ id: 'sparse', source: 'closet', brand: 'Nike' }] });
  const richBytes = selection.candidatePayloadBytes(rich.candidates);
  const sparseBytes = selection.candidatePayloadBytes(sparse.candidates);
  assert.ok(richBytes > sparseBytes);
  assert.ok(sparseBytes > 0);
});

// ── reporting ───────────────────────────────────────────────────────────────

test('every stage is counted, and rejections sum to the drop', () => {
  const { report } = select({
    closetRecords: [
      closetRecord({ id: 'keep-1' }),
      closetRecord({ id: 'keep-2', model: 'Air Force 1' }),
      closetRecord({ id: 'conflict', canonicalCategory: 'dress' }),
      closetRecord({ id: 'dead', status: 'deleted' }),
      { id: '', source: 'closet' },
    ],
    recentScanRecords: [recentRecord({ id: 'keep-3' })],
  });
  assert.equal(report.recordsLoaded.closet, 5);
  assert.equal(report.recordsLoaded.recent_scan, 1);
  assert.equal(report.recordsLoaded.total, 6);
  assert.equal(report.recordsConsidered, 5, 'the id-less record never entered pruning');

  const dropped = report.recordsRejected.reduce((sum, r) => sum + r.count, 0);
  assert.equal(
    report.recordsLoaded.total - dropped,
    report.recordsTransmitted,
    'loaded minus every named rejection must equal what was sent',
  );
  assert.deepEqual({ ...report.sourceCounts }, { closet: 2, recent_scan: 1 });
  assert.equal(report.prioritizationVersion, selection.CANDIDATE_PRIORITIZATION_VERSION);
});

test('stage timings are reported and non-negative', () => {
  const { report } = select({ closetRecords: [closetRecord()] });
  for (const key of ['normalizeMs', 'pruneMs', 'prioritizeMs', 'dedupeMs', 'totalMs']) {
    assert.equal(typeof report.timings[key], 'number', `${key} must be measured`);
    assert.ok(report.timings[key] >= 0);
  }
});

// ── adapters ────────────────────────────────────────────────────────────────

test('a raw Closet record maps to the fields the Closet schema actually has', () => {
  const mapped = adapters.closetRecordToCandidate({
    id: 'closet-1',
    title: 'White AF1',
    category: 'footwear',
    clothingType: 'sneaker',
    subtype: 'low-top',
    brand: 'Nike',
    primaryColor: 'white',
    material: ['leather', 'rubber'],
    thumbnailUri: 'file:///thumb.jpg',
    imageUri: 'file:///full.jpg',
    updatedAt: '2026-08-01T00:00:00.000Z',
    sourceLineageId: 'local:scan-9',
  });
  assert.equal(mapped.source, 'closet');
  assert.equal(mapped.brand, 'Nike');
  assert.equal(mapped.canonicalCategory, 'footwear');
  assert.equal(mapped.subtype, 'low-top');
  assert.equal(mapped.color, 'white');
  assert.equal(mapped.material, 'leather', 'the first material only');
  assert.equal(mapped.imageUri, 'file:///thumb.jpg', 'thumbnail is preferred over the full image');
  assert.equal(mapped.mirrorOfId, 'local:scan-9');
  assert.equal(mapped.status, 'active');
  // The Closet schema is commerce-free by construction.
  assert.equal(mapped.productUrl, null);
  assert.equal(mapped.authoritativeId, null);
  assert.equal(mapped.model, null);
  assert.equal(mapped.pattern, null);
  assert.equal(mapped.silhouette, null);
});

test('a soft-deleted Closet record maps to a non-active status', () => {
  const mapped = adapters.closetRecordToCandidate({
    id: 'c1', category: 'footwear', deletedAt: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(mapped.status, 'deleted');
});

test('a Recent Scan reads identification strongest-first across all three layers', () => {
  const legacyOnly = adapters.recentScanRecordToCandidate({
    id: 'scan-1',
    attributes: { category: 'footwear', silhouette: 'low-top', color_palette: ['white'], material_estimate: 'leather' },
  });
  assert.equal(legacyOnly.canonicalCategory, 'footwear');
  assert.equal(legacyOnly.color, 'white');
  assert.equal(legacyOnly.silhouette, 'low-top');
  assert.equal(legacyOnly.brand, null, 'the legacy attributes layer has no brand');

  const withV2 = adapters.recentScanRecordToCandidate({
    id: 'scan-2',
    attributes: { category: 'footwear', color_palette: ['grey'] },
    identificationSnapshot: { brand: { value: 'OldBrand' }, category: 'footwear' },
    identificationSnapshotV2: {
      item: {
        category: 'footwear', subtype: 'low-top',
        brand: { value: 'Nike' }, colors: { primary: 'white' },
        material: ['leather'], silhouette: ['low-top'], pattern: ['solid'],
      },
      exactProduct: { brand: 'Nike', model: 'Air Force 1', sku: 'CW2288-111' },
    },
    purchaseOptions: [{ productUrl: 'https://nike.com/t/af1' }],
  });
  assert.equal(withV2.brand, 'Nike', 'V2 outranks the V1 snapshot');
  assert.equal(withV2.color, 'white', 'V2 outranks the legacy palette');
  assert.equal(withV2.model, 'Air Force 1', 'model exists only via exactProduct');
  assert.equal(withV2.authoritativeId, 'CW2288-111');
  assert.equal(withV2.productUrl, 'https://nike.com/t/af1');
  assert.equal(withV2.pattern, 'solid');
});

test('scan lineage ids match the promotion module’s format exactly', () => {
  assert.equal(adapters.scanLineageIdOf({ id: 'scan_123' }), 'local:scan_123');
  assert.equal(
    adapters.scanLineageIdOf({ id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', cloudId: 'abc' }),
    'cloud:abc',
  );
  assert.equal(adapters.scanLineageIdOf({}), null);
});

test('adapters never throw on malformed input', () => {
  for (const junk of [null, undefined, 42, 'string', [], { nope: true }]) {
    assert.equal(adapters.closetRecordToCandidate(junk), null);
    assert.equal(adapters.recentScanRecordToCandidate(junk), null);
  }
  assert.deepEqual([...adapters.closetRecordsToCandidates(null)], []);
  assert.deepEqual([...adapters.recentScanRecordsToCandidates('nope')], []);
});
