/**
 * Build 32 — NO_MATCH semantics for multi-item commerce.
 *
 * NO_MATCH may only mean "commerce ran and found nothing acceptable". It must
 * never mean "commerce was disabled, misconfigured, or failed before
 * retrieval" — that condition previously reached the user as the affirmative
 * claim "No strong shopping match found." for a search that never happened.
 *
 * These run the REAL services/commerceHydration.ts normalizer against the
 * literal response bodies supabase/functions/scan-identify/index.ts emits for
 * MODE B, then the REAL services/multiItemCommerce.ts orchestrator, so the
 * assertions are about production behavior rather than source text.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = process.env.KSCAN_COMMERCE_SOURCE_ROOT
  ? path.resolve(process.env.KSCAN_COMMERCE_SOURCE_ROOT)
  : path.resolve(__dirname, '..');

function createLoader(root, mocks = {}) {
  const cache = new Map();
  function resolveFile(candidate) {
    const candidates = path.extname(candidate)
      ? [candidate]
      : [`${candidate}.ts`, `${candidate}.tsx`, `${candidate}.js`];
    return candidates.find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  }
  function loadFile(filename) {
    const resolved = resolveFile(filename);
    if (!resolved) throw new Error(`Unable to resolve production module: ${filename}`);
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const module = { exports: {} };
    cache.set(resolved, module);
    const output = ts.transpileModule(fs.readFileSync(resolved, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        jsx: ts.JsxEmit.React,
      },
      fileName: resolved,
    }).outputText;
    const localRequire = (id) => {
      if (Object.prototype.hasOwnProperty.call(mocks, id)) return mocks[id];
      if (id.startsWith('.')) return loadFile(path.resolve(path.dirname(resolved), id));
      try { return require(id); } catch { return {}; }
    };
    Function('exports', 'require', 'module', '__filename', '__dirname', output)(
      module.exports, localRequire, module, resolved, path.dirname(resolved),
    );
    return module.exports;
  }
  return (relativePath) => loadFile(path.resolve(root, relativePath));
}

const SUPABASE_STUB = {
  './supabaseClient': { supabase: { functions: { invoke: async () => ({ data: null, error: null }) } } },
};

function loadHydration() {
  return createLoader(ROOT, SUPABASE_STUB)('services/commerceHydration.ts');
}

function loadOrchestrator(fetchImpl) {
  return createLoader(ROOT, { './commerceHydration': { fetchDeferredCommerce: fetchImpl } })(
    'services/multiItemCommerce.ts',
  );
}

function candidateFixture(id, label) {
  return {
    id, order: 0, label, category: 'outerwear', subtype: 'jacket', isPrimary: false,
    source: {
      candidateId: id, order: 0, label, category: 'outerwear', subtype: 'jacket',
      identification: { item_type: 'jacket' }, attributes: {},
    },
  };
}

/** The literal body scan-identify returns when getFastCommerceResults throws. */
const PROVIDER_ERROR_BODY = {
  status: 'completed',
  purchaseOptions: [],
  recommendedProducts: [],
  commerce: { available: false, retryable: true, errorType: 'provider_error' },
};

/** The literal body when providers ran and genuinely matched nothing. */
const GENUINE_EMPTY_BODY = {
  status: 'completed',
  purchaseOptions: [],
  recommendedProducts: [],
  canonicalProducts: [],
  commerce: {
    available: false, retryable: true, provider: 'serper',
    providersTried: ['serper', 'brave'], count: 0, errorType: 'no_results',
  },
};

async function statusFor(body) {
  const hydration = loadHydration();
  const { fetchMultiItemCommerce } = loadOrchestrator(
    async () => hydration.normalizeCommerceHydrationResponse(body),
  );
  const cards = await fetchMultiItemCommerce([candidateFixture('c1', 'Item')]);
  return cards.get('c1').status;
}

test('a genuinely empty shelf is a NO_MATCH', async () => {
  assert.equal(await statusFor(GENUINE_EMPTY_BODY), 'no_match');
});

test('a provider failure is NOT reported to the user as a no-match', async () => {
  const status = await statusFor(PROVIDER_ERROR_BODY);
  assert.notEqual(status, 'no_match',
    'commerce that failed before retrieval must never claim the garment had no match');
  assert.equal(status, 'error');
});

test('every non-retrieval empty cause is an error, not a no-match', async () => {
  // The backend surfaces these through commerce.errorType when the shelf is
  // empty. None of them mean "we looked and found nothing".
  for (const errorType of ['provider_error', 'no_key', 'disabled', 'timeout', 'error', 'wrong_mode']) {
    const body = {
      status: 'completed',
      purchaseOptions: [],
      recommendedProducts: [],
      commerce: { available: false, retryable: true, errorType },
    };
    assert.equal(await statusFor(body), 'error', `errorType=${errorType} must not read as NO_MATCH`);
  }
});

test('an empty shelf with no errorType keeps its previous no-match treatment', async () => {
  // Nothing is newly reclassified on a backend that does not report a cause.
  const body = {
    status: 'completed',
    purchaseOptions: [],
    recommendedProducts: [],
    commerce: { available: false, retryable: true },
  };
  assert.equal(await statusFor(body), 'no_match');
});

test('a populated shelf is still ready regardless of reported diagnostics', async () => {
  const body = {
    status: 'completed',
    purchaseOptions: [{ title: 'Jacket', retailer: 'AllSaints', productUrl: 'https://x.example.com/p' }],
    commerce: { available: true, retryable: false, provider: 'serper', count: 1 },
  };
  assert.equal(await statusFor(body), 'ready');
});

test('NEGATIVE CONTROL: collapsing errorType back into empty reproduces the false no-match', async () => {
  // Proves the guard above is load-bearing rather than incidentally true.
  const hydration = loadHydration();
  const regressed = (result) => {
    // The pre-fix mapping: any empty shelf is a no-match.
    if (result.status === 'success') return 'ready';
    if (result.status === 'empty') return 'no_match';
    return 'error';
  };
  const provErr = hydration.normalizeCommerceHydrationResponse(PROVIDER_ERROR_BODY);
  assert.equal(provErr.status, 'empty', 'the failing body really does normalize to an empty shelf');
  assert.equal(provErr.errorType, 'provider_error', 'the failure cause really is carried on the result');
  assert.equal(regressed(provErr), 'no_match',
    'the old mapping mislabels a provider failure — this is the condition the guard prevents');
});
