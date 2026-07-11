// style-outfit-generate contract tests (AI Stylist expansion).
//
// The Edge Function's pure validation module is transpiled in-process and
// unit-tested directly; index.ts is checked statically for the security
// pattern (server-derived identity, quotas, kill switch, no client candidate
// arrays, metadata-only logging).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const FN_DIR = path.join('supabase', 'functions', 'style-outfit-generate');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier in requireMap) return requireMap[specifier];
      throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

const reasoningEdge = loadTsModule(path.join(FN_DIR, 'reasoningContract.ts'));
const reasoningMobile = loadTsModule('types/fashionReasoning.ts');
const validation = loadTsModule(path.join(FN_DIR, 'validation.ts'), {
  './reasoningContract.ts': reasoningEdge,
});

const indexSource = fs.readFileSync(path.join(ROOT, FN_DIR, 'index.ts'), 'utf8');
const validationSource = fs.readFileSync(path.join(ROOT, FN_DIR, 'validation.ts'), 'utf8');

const A = '11111111-1111-4111-8111-111111111111'; // anchor (blazer/outerwear)
const B = '22222222-2222-4222-8222-222222222222'; // top
const C = '33333333-3333-4333-8333-333333333333'; // bottom
const D = '44444444-4444-4444-8444-444444444444'; // shoes
const E = '55555555-5555-4555-8555-555555555555'; // dress
const FOREIGN = '99999999-9999-4999-8999-999999999999';

function scanRow(id, category, extras = {}) {
  return {
    id,
    user_id: 'owner',
    title: `${category} item`,
    analysis_result: { metadata: { category } },
    deleted_at: null,
    ...extras,
  };
}

const SERVER_ROWS = [
  scanRow(A, 'Blazer'),
  scanRow(B, 'T-Shirt'),
  scanRow(C, 'Jeans'),
  scanRow(D, 'Sneakers'),
  scanRow(E, 'Dress'),
];

function buildPool(requestOverrides = {}) {
  const parse = validation.parseStyleOutfitRequest({
    mode: 'style_event',
    contractVersion: '1',
    ...requestOverrides,
  });
  assert.equal(parse.ok, true, `request parse failed: ${JSON.stringify(parse)}`);
  const candidates = validation.buildCandidatesFromSavedScans(SERVER_ROWS);
  const pool = validation.finalizeCandidatePool(candidates, parse.request);
  return { parse, pool };
}

// ── Contract mirror parity ────────────────────────────────────────────────────

test('edge reasoning contract mirrors the mobile fashion-reasoning contract', () => {
  for (const key of [
    'GARMENT_ROLES',
    'OUTFIT_OCCASIONS',
    'OUTFIT_DRESS_CODES',
    'OUTFIT_SETTINGS',
    'OUTFIT_VARIATIONS',
    'STYLE_OUTFIT_MODES',
    'STYLE_VIBES',
  ]) {
    assert.deepEqual([...reasoningEdge[key]], [...reasoningMobile[key]], `${key} mismatch`);
  }
  assert.equal(
    reasoningEdge.FASHION_REASONING_CONTRACT_VERSION,
    reasoningMobile.FASHION_REASONING_CONTRACT_VERSION,
  );
  assert.equal(reasoningEdge.inferGarmentRole('Blazer'), 'outerwear');
  assert.equal(reasoningMobile.inferGarmentRole('Blazer'), 'outerwear');
});

// ── Request parsing / client candidate arrays ─────────────────────────────────

test('client candidate arrays are ignored: no code path reads them', () => {
  const parse = validation.parseStyleOutfitRequest({
    mode: 'style_event',
    contractVersion: '1',
    closetItems: [{ sourceType: 'saved_scan', sourceId: FOREIGN }],
    candidateItems: [FOREIGN],
    candidateIds: [FOREIGN],
    wardrobe: [FOREIGN],
    eligibleItems: [FOREIGN],
  });
  assert.equal(parse.ok, true);
  const serialized = JSON.stringify(parse.request);
  assert.ok(!serialized.includes(FOREIGN), 'client candidate ids leaked into the parsed request');
  // Static: the validation module never references the candidate field names.
  for (const field of ['closetItems', 'candidateItems', 'candidateIds', 'wardrobe', 'eligibleItems']) {
    const occurrences = validationSource.split(field).length - 1;
    // Allowed only inside comments documenting the rule; never as property access.
    assert.ok(
      !new RegExp(`(record|body)\\s*[.\\[]\\s*['"\`]?${field}`).test(validationSource),
      `validation.ts reads client field ${field}`,
    );
    assert.ok(
      !new RegExp(`\\.${field}\\b`).test(indexSource),
      `index.ts reads client field ${field}`,
    );
    void occurrences;
  }
});

test('anchor is required for style_item and swap_item modes', () => {
  const noAnchor = validation.parseStyleOutfitRequest({ mode: 'style_item', contractVersion: '1' });
  assert.equal(noAnchor.ok, false);
  const swapNoAnchor = validation.parseStyleOutfitRequest({ mode: 'swap_item', contractVersion: '1' });
  assert.equal(swapNoAnchor.ok, false);
  const withAnchor = validation.parseStyleOutfitRequest({
    mode: 'style_item',
    contractVersion: '1',
    anchorItem: { sourceType: 'saved_scan', sourceId: A },
  });
  assert.equal(withAnchor.ok, true);
});

test('unsupported mode and contract version are rejected', () => {
  assert.equal(validation.parseStyleOutfitRequest({ mode: 'style_shopping', contractVersion: '1' }).ok, false);
  assert.equal(validation.parseStyleOutfitRequest({ mode: 'style_event', contractVersion: '99' }).ok, false);
});

// ── Candidate pool ────────────────────────────────────────────────────────────

test('server pool excludes deleted rows and rows without category metadata', () => {
  const candidates = validation.buildCandidatesFromSavedScans([
    scanRow(A, 'Blazer'),
    scanRow(B, 'T-Shirt', { deleted_at: '2026-07-01T00:00:00Z' }),
    { id: C, user_id: 'owner', title: 'no metadata', analysis_result: {}, deleted_at: null },
    { id: 'not-a-uuid', user_id: 'owner', analysis_result: { metadata: { category: 'Shoes' } }, deleted_at: null },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceId, A);
});

test('foreign/deleted anchor is rejected against the server pool', () => {
  const { pool } = buildPool({
    mode: 'style_item',
    anchorItem: { sourceType: 'saved_scan', sourceId: FOREIGN },
  });
  assert.equal(pool.ok, false);
  assert.equal(pool.reason, 'anchor_not_owned');
});

test('insufficient closet yields a structured no-result reason (no products inserted)', () => {
  const parse = validation.parseStyleOutfitRequest({ mode: 'style_event', contractVersion: '1' });
  const candidates = validation.buildCandidatesFromSavedScans([scanRow(A, 'Blazer')]);
  const pool = validation.finalizeCandidatePool(candidates, parse.request);
  assert.equal(pool.ok, false);
  assert.equal(pool.reason, 'insufficient_closet');
});

test('excludeItems only narrow the pool and never remove the anchor', () => {
  const { pool } = buildPool({
    mode: 'style_item',
    anchorItem: { sourceType: 'saved_scan', sourceId: A },
    excludeItems: [
      { sourceType: 'saved_scan', sourceId: A }, // anchor: ignored
      { sourceType: 'saved_scan', sourceId: E }, // dress: removed
      { sourceType: 'saved_scan', sourceId: FOREIGN }, // foreign: harmless
    ],
  });
  assert.equal(pool.ok, true);
  assert.ok(pool.pool.has(`saved_scan:${A}`));
  assert.ok(!pool.pool.has(`saved_scan:${E}`));
});

// ── Provider output validation ────────────────────────────────────────────────

function providerOutfit(variation, ids, extras = {}) {
  return {
    variation,
    itemRefs: ids.map((id) => ({ sourceType: 'saved_scan', sourceId: id })),
    reason: 'A balanced combination.',
    confidence: 'high',
    ...extras,
  };
}

test('valid outfits pass and anchor is preserved in every result', () => {
  const { pool } = buildPool({
    mode: 'style_item',
    anchorItem: { sourceType: 'saved_scan', sourceId: A },
  });
  assert.equal(pool.ok, true);
  const outfits = validation.validateProviderOutfits(
    {
      outfits: [
        providerOutfit('reliable', [A, B, C, D]),
        providerOutfit('elevated', [B, C, D]), // missing anchor → dropped
      ],
    },
    pool.pool,
    pool.anchor,
    3,
  );
  assert.equal(outfits.length, 1);
  assert.equal(outfits[0].variation, 'reliable');
  assert.ok(outfits[0].itemRefs.some((ref) => ref.sourceId === A));
});

test('invented, foreign, and duplicate ids are rejected', () => {
  const { pool } = buildPool();
  assert.equal(pool.ok, true);
  const outfits = validation.validateProviderOutfits(
    {
      outfits: [
        providerOutfit('reliable', [FOREIGN, B, D]), // foreign/invented id
        providerOutfit('elevated', [B, B, D]), // duplicate id inside outfit
      ],
    },
    pool.pool,
    null,
    3,
  );
  assert.equal(outfits.length, 0);
});

test('retailer/commerce items can never enter a validated outfit', () => {
  const { pool } = buildPool();
  const outfits = validation.validateProviderOutfits(
    {
      outfits: [
        {
          variation: 'reliable',
          itemRefs: [
            { sourceType: 'product_match', sourceId: A },
            { sourceType: 'saved_scan', sourceId: D },
          ],
          reason: 'buy this',
        },
      ],
    },
    pool.pool,
    null,
    3,
  );
  assert.equal(outfits.length, 0);
});

test('invalid outfit structure is rejected; roles come from server inference', () => {
  const { pool } = buildPool();
  const outfits = validation.validateProviderOutfits(
    {
      outfits: [
        // top + bottom, no shoes → invalid structure
        providerOutfit('reliable', [B, C]),
        // dress + bottom + shoes → conflicting bases → invalid
        providerOutfit('elevated', [E, C, D]),
        // provider claims wrong roles; server roles still validate dress+shoes
        {
          variation: 'something_different',
          itemRefs: [
            { sourceType: 'saved_scan', sourceId: E, role: 'accessory' },
            { sourceType: 'saved_scan', sourceId: D, role: 'bag' },
          ],
          reason: 'dress and sneakers',
        },
      ],
    },
    pool.pool,
    null,
    3,
  );
  assert.equal(outfits.length, 1);
  assert.equal(outfits[0].variation, 'something_different');
  // VM-realm arrays are not reference-equal to host arrays; compare via JSON.
  assert.equal(
    JSON.stringify(Array.from(outfits[0].itemRefs, (ref) => ref.role).sort()),
    JSON.stringify(['dress', 'shoes']),
  );
});

test('variation order is normalized and fewer than three results are allowed', () => {
  const { pool } = buildPool();
  const outfits = validation.validateProviderOutfits(
    {
      outfits: [
        providerOutfit('something_different', [E, D]),
        providerOutfit('reliable', [B, C, D]),
      ],
    },
    pool.pool,
    null,
    3,
  );
  assert.equal(outfits.length, 2);
  assert.equal(
    JSON.stringify(Array.from(outfits, (outfit) => outfit.variation)),
    JSON.stringify(['reliable', 'something_different']),
  );
  // Zero-based deterministic item positions.
  assert.equal(
    JSON.stringify(Array.from(outfits[0].itemRefs, (ref) => ref.position)),
    JSON.stringify([0, 1, 2]),
  );
});

test('malformed provider output is rejected without throwing', () => {
  const { pool } = buildPool();
  for (const malformed of [null, 'text', 42, {}, { outfits: 'nope' }, { outfits: [null, 7, 'x'] }]) {
    const outfits = validation.validateProviderOutfits(malformed, pool.pool, null, 3);
    assert.ok(Array.isArray(outfits));
    assert.equal(outfits.length, 0);
  }
});

test('duplicate suggestion item-sets are dropped instead of filling slots', () => {
  const { pool } = buildPool();
  const outfits = validation.validateProviderOutfits(
    {
      outfits: [
        providerOutfit('reliable', [B, C, D]),
        providerOutfit('elevated', [D, C, B]), // same set, different order
      ],
    },
    pool.pool,
    null,
    3,
  );
  assert.equal(outfits.length, 1);
});

// ── index.ts security pattern (static) ────────────────────────────────────────

test('edge function derives identity from JWT and never from the body', () => {
  assert.match(indexSource, /npm:@supabase\/supabase-js@2\.105\.4/);
  assert.match(indexSource, /auth\.getUser\(\)/);
  assert.match(indexSource, /const userId = user\.id/);
  assert.doesNotMatch(indexSource, /body\.(userId|user_id)/);
});

test('edge function enforces burst then daily quota via SECURITY DEFINER RPCs', () => {
  assert.match(indexSource, /check_and_increment_style_outfit_burst/);
  assert.match(indexSource, /increment_style_outfit_daily_usage/);
  assert.ok(
    indexSource.indexOf('check_and_increment_style_outfit_burst') <
      indexSource.indexOf('increment_style_outfit_daily_usage'),
    'burst check must run before daily quota',
  );
  assert.match(indexSource, /STYLE_OUTFIT_DAILY_LIMIT/);
  assert.match(indexSource, /STYLE_OUTFIT_BURST_LIMIT_PER_MINUTE/);
});

test('edge function has a kill switch and safe provider errors', () => {
  assert.match(indexSource, /STYLE_OUTFIT_AI_ENABLED/);
  assert.match(indexSource, /provider_unavailable/);
  assert.doesNotMatch(indexSource, /error\.stack/);
});

test('edge function queries only the caller\'s active saved_scans for the pool', () => {
  assert.match(indexSource, /from\('saved_scans'\)/);
  assert.match(indexSource, /\.eq\('user_id', userId\)/);
  assert.match(indexSource, /\.is\('deleted_at', null\)/);
});

test('edge function logs metadata only (no closet contents, notes, or images)', () => {
  const logLines = indexSource.match(/console\.(log|warn|error)\([^;]*\)/g) ?? [];
  for (const line of logLines) {
    assert.ok(!/analysis_result|imageUri|image_uri|note|candidates\b.*JSON/.test(line), `unsafe log: ${line}`);
  }
  assert.match(indexSource, /poolSize=%d/);
});

test('no-result response inserts no shopping products', () => {
  assert.match(indexSource, /couldn't build a complete option from your closet yet/);
  assert.match(indexSource, /closetGaps: \[\]/);
  // Responses never carry commerce fields ("retailer" appears only in the
  // prompt/comments forbidding it).
  assert.doesNotMatch(indexSource, /product_url|affiliateUrl|purchase_url/);
});
