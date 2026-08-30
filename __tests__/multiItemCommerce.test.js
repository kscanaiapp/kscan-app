/**
 * Build 32 — multi-item commerce orchestration (services/multiItemCommerce.ts).
 *
 * Loads the real module with a mocked commerceHydration so no network call
 * happens. The hostile case this pins: one candidate's fetch throwing must
 * never remove or corrupt another candidate's result (Section 22/23 of the
 * Build 32 spec — partial-item failure isolation).
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
    return candidates.find((filename) => fs.existsSync(filename) && fs.statSync(filename).isFile());
  }

  function loadFile(filename, importerDir) {
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
      try {
        return require(id);
      } catch {
        return {};
      }
    };
    Function('exports', 'require', 'module', '__filename', '__dirname', output)(
      module.exports,
      localRequire,
      module,
      resolved,
      path.dirname(resolved),
    );
    return module.exports;
  }

  return (relativePath) => loadFile(path.resolve(root, relativePath));
}

function candidateFixture(id, label, identification) {
  return {
    id,
    order: 0,
    label,
    category: 'outerwear',
    subtype: 'jacket',
    isPrimary: false,
    source: {
      candidateId: id,
      order: 0,
      label,
      category: 'outerwear',
      subtype: 'jacket',
      identification,
      attributes: {},
    },
  };
}

function loadModule(fetchDeferredCommerceImpl) {
  const load = createLoader(ROOT, {
    './commerceHydration': {
      fetchDeferredCommerce: fetchDeferredCommerceImpl,
    },
  });
  return load('services/multiItemCommerce.ts');
}

test('isCandidateCommerceEligible requires non-empty identification', () => {
  const { isCandidateCommerceEligible } = loadModule(async () => ({ status: 'empty', purchaseOptions: [], enrichmentCandidates: [], cacheHit: false, retryable: true }));

  assert.equal(isCandidateCommerceEligible(candidateFixture('g1', 'Jacket', { item_type: 'jacket' })), true);
  assert.equal(isCandidateCommerceEligible(candidateFixture('g2', 'Mystery', {})), false);
  assert.equal(isCandidateCommerceEligible(candidateFixture('g3', 'NoIdent', undefined)), false);
});

test('splitBestMatchAndAlternatives never fabricates a Best Match and never re-sorts', () => {
  const { splitBestMatchAndAlternatives } = loadModule(async () => ({ status: 'empty', purchaseOptions: [], enrichmentCandidates: [], cacheHit: false, retryable: true }));

  assert.deepEqual(splitBestMatchAndAlternatives([]), { bestMatch: null, alternatives: [] });

  const one = { id: 'p1', title: 'Only offer' };
  assert.deepEqual(splitBestMatchAndAlternatives([one]), { bestMatch: one, alternatives: [] });

  const first = { id: 'p1', title: 'First' };
  const second = { id: 'p2', title: 'Second' };
  const third = { id: 'p3', title: 'Third' };
  const { bestMatch, alternatives } = splitBestMatchAndAlternatives([first, second, third]);
  assert.equal(bestMatch, first);
  assert.deepEqual(alternatives, [second, third]);
});

test('one candidate throwing never removes or corrupts the others (partial-success isolation)', async () => {
  const calls = [];
  const { fetchMultiItemCommerce } = loadModule(async (evidence) => {
    calls.push(evidence.candidateId);
    if (evidence.candidateId === 'jacket') {
      return { status: 'success', purchaseOptions: [{ id: 'j1', title: 'Jacket offer', retailer: 'AllSaints' }, { id: 'j2', title: 'Alt', retailer: 'Schott' }], enrichmentCandidates: [], cacheHit: false, retryable: false, candidateId: 'jacket' };
    }
    if (evidence.candidateId === 'boots') {
      return { status: 'empty', purchaseOptions: [], enrichmentCandidates: [], cacheHit: false, retryable: true, candidateId: 'boots' };
    }
    if (evidence.candidateId === 'scarf') {
      throw new Error('simulated network failure');
    }
    throw new Error(`unexpected candidateId ${evidence.candidateId}`);
  });

  const candidates = [
    candidateFixture('jacket', 'Biker Jacket', { item_type: 'jacket' }),
    candidateFixture('boots', 'Chelsea Boot', { item_type: 'boot' }),
    candidateFixture('scarf', 'Wool Scarf', { item_type: 'scarf' }),
    // No identification at all — must never reach fetchDeferredCommerce.
    candidateFixture('unknown', 'Unidentified Item', {}),
  ];

  const result = await fetchMultiItemCommerce(candidates);

  assert.deepEqual(calls.sort(), ['boots', 'jacket', 'scarf'], 'ineligible candidate is never dispatched');

  const jacketCard = result.get('jacket');
  assert.equal(jacketCard.status, 'ready');
  assert.equal(jacketCard.bestMatch.retailer, 'AllSaints');
  assert.equal(jacketCard.alternatives.length, 1);
  assert.equal(jacketCard.alternatives[0].retailer, 'Schott');

  const bootsCard = result.get('boots');
  assert.equal(bootsCard.status, 'no_match');
  assert.equal(bootsCard.bestMatch, null);

  // The failing candidate is simply absent — it does not throw the whole
  // orchestration and does not appear as a corrupted/partial entry.
  assert.equal(result.has('scarf'), false);
  assert.equal(result.has('unknown'), false);
  assert.equal(result.size, 2);
});

test('all candidates dispatch in parallel, not serially', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const { fetchMultiItemCommerce } = loadModule(async (evidence) => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 10));
    concurrent -= 1;
    return { status: 'success', purchaseOptions: [{ id: `${evidence.candidateId}-1`, title: 'offer', retailer: 'X' }], enrichmentCandidates: [], cacheHit: false, retryable: false };
  });

  const candidates = [
    candidateFixture('a', 'A', { item_type: 'a' }),
    candidateFixture('b', 'B', { item_type: 'b' }),
    candidateFixture('c', 'C', { item_type: 'c' }),
  ];

  await fetchMultiItemCommerce(candidates);
  assert.equal(maxConcurrent, 3, 'all three in-flight simultaneously, not one-at-a-time');
});
