/**
 * Build 34 Scanner audit — the Item A invariant, at the commerce boundary.
 *
 * Section 8 / section 40 of the audit: Item A's card must carry Item A's
 * commerce, and only Item A's. The negative control for this
 * (SCAN-NC-005 — key a card to the wrong candidateId) passed every existing
 * suite, so the single most important binding in the multi-item shelf had no
 * test. This is that test.
 *
 * It drives the real services/multiItemCommerce.ts with a stub transport that
 * answers each candidate with a result that is uniquely attributable to it,
 * so a swapped, dropped, or reused binding is visible rather than plausible.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

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

/** Three genuinely different garments, as multi-item detection produces them. */
const CANDIDATES = [
  {
    id: 'garment-1-outerwear-leather-jacket', order: 0, label: 'leather jacket',
    category: 'outerwear', subtype: 'leather jacket', isPrimary: true,
    source: {
      candidateId: 'garment-1-outerwear-leather-jacket',
      identification: { item_type: 'outerwear', subtype: 'leather jacket', primary_color: 'black' },
      attributes: { category: 'outerwear', colorPalette: ['black'] },
    },
  },
  {
    id: 'garment-2-footwear-chelsea-boot', order: 1, label: 'chelsea boot',
    category: 'footwear', subtype: 'chelsea boot', isPrimary: false,
    source: {
      candidateId: 'garment-2-footwear-chelsea-boot',
      identification: { item_type: 'footwear', subtype: 'chelsea boot', primary_color: 'brown' },
      attributes: { category: 'footwear', colorPalette: ['brown'] },
    },
  },
  {
    id: 'garment-3-bag-crossbody-bag', order: 2, label: 'crossbody bag',
    category: 'bag', subtype: 'crossbody bag', isPrimary: false,
    source: {
      candidateId: 'garment-3-bag-crossbody-bag',
      identification: { item_type: 'bag', subtype: 'crossbody bag', primary_color: 'blue' },
      attributes: { category: 'bag', colorPalette: ['blue'] },
    },
  },
];

/**
 * Answers each request with an offer that names the garment it was asked
 * about, and records what evidence it was actually asked with.
 */
function bindingTransport(calls, options = {}) {
  return async (evidence) => {
    const subtype = evidence?.identification?.subtype ?? 'unknown';
    calls.push({ candidateId: evidence?.candidateId, subtype, evidence });
    if (options.delayFor && options.delayFor[subtype]) {
      await new Promise((r) => setTimeout(r, options.delayFor[subtype]));
    }
    return {
      status: 'success',
      purchaseOptions: [
        { id: `best-${subtype}`, title: `BEST ${subtype}`, retailer: 'R', productUrl: `https://r.example/${subtype}/1` },
        { id: `alt-${subtype}`, title: `ALT ${subtype}`, retailer: 'R', productUrl: `https://r.example/${subtype}/2` },
      ],
      enrichmentCandidates: [],
      retryable: false,
    };
  };
}

function load(transport) {
  return createLoader(ROOT, { './commerceHydration': { fetchDeferredCommerce: transport } })(
    'services/multiItemCommerce.ts',
  );
}

test('every card is keyed to, and carries, its own candidate', async () => {
  const calls = [];
  const { fetchMultiItemCommerce } = load(bindingTransport(calls));
  const cards = await fetchMultiItemCommerce(CANDIDATES);

  assert.equal(cards.size, CANDIDATES.length, 'one card per candidate');
  for (const candidate of CANDIDATES) {
    const card = cards.get(candidate.id);
    assert.ok(card, `no card keyed to ${candidate.id}`);
    assert.equal(card.candidateId, candidate.id,
      'the map key and the card body must name the same candidate');
    assert.ok(
      card.bestMatch.title.endsWith(candidate.subtype),
      `${candidate.id} shows a best match for "${card.bestMatch.title}", not for its own ${candidate.subtype}`,
    );
    for (const alt of card.alternatives) {
      assert.ok(alt.title.endsWith(candidate.subtype),
        `${candidate.id} shows an alternative belonging to another garment: ${alt.title}`);
    }
  }
});

test('each request carries only its own garment evidence', async () => {
  const calls = [];
  const { fetchMultiItemCommerce } = load(bindingTransport(calls));
  await fetchMultiItemCommerce(CANDIDATES);

  assert.equal(calls.length, CANDIDATES.length, 'one request per eligible candidate, no fan-out');
  for (const candidate of CANDIDATES) {
    const call = calls.find((c) => c.candidateId === candidate.id);
    assert.ok(call, `no request was made for ${candidate.id}`);
    assert.equal(call.evidence.identification.subtype, candidate.subtype);
    assert.equal(call.evidence.identification.primary_color,
      candidate.source.identification.primary_color,
      'a garment must never be searched with another garment colour');
  }
  assert.equal(new Set(calls.map((c) => c.candidateId)).size, CANDIDATES.length,
    'no candidateId may be requested twice');
});

test('out-of-order completion does not rebind cards', async () => {
  // Garment 1 answers last; garment 3 answers first.
  const calls = [];
  const { fetchMultiItemCommerce } = load(
    bindingTransport(calls, { delayFor: { 'leather jacket': 40, 'chelsea boot': 20, 'crossbody bag': 1 } }),
  );
  const cards = await fetchMultiItemCommerce(CANDIDATES);

  for (const candidate of CANDIDATES) {
    const card = cards.get(candidate.id);
    assert.ok(card.bestMatch.title.endsWith(candidate.subtype),
      `late/early completion rebound ${candidate.id} to ${card.bestMatch.title}`);
  }
});

test('a failing garment leaves the others bound to themselves and produces no card of its own', async () => {
  const calls = [];
  const base = bindingTransport(calls);
  const { fetchMultiItemCommerce } = load(async (evidence) => {
    if (evidence?.identification?.subtype === 'chelsea boot') {
      throw new Error('injected provider failure for the boot only');
    }
    return base(evidence);
  });

  const cards = await fetchMultiItemCommerce(CANDIDATES);

  assert.equal(cards.has('garment-2-footwear-chelsea-boot'), false,
    'a garment whose request rejected must not receive a card — and above all must not ' +
    "receive another garment's card");
  assert.equal(cards.size, 2, 'the two healthy garments still have their cards');
  assert.ok(cards.get('garment-1-outerwear-leather-jacket').bestMatch.title.endsWith('leather jacket'));
  assert.ok(cards.get('garment-3-bag-crossbody-bag').bestMatch.title.endsWith('crossbody bag'));
});

test('an ineligible garment is absent, never filled from a sibling', async () => {
  const calls = [];
  const withIneligible = [
    CANDIDATES[0],
    { ...CANDIDATES[1], source: { ...CANDIDATES[1].source, identification: {} } },
    CANDIDATES[2],
  ];
  const { fetchMultiItemCommerce } = load(bindingTransport(calls));
  const cards = await fetchMultiItemCommerce(withIneligible);

  assert.equal(cards.has('garment-2-footwear-chelsea-boot'), false);
  assert.equal(calls.length, 2, 'no request is issued for an ineligible garment');
  assert.ok(cards.get('garment-1-outerwear-leather-jacket').bestMatch.title.endsWith('leather jacket'));
  assert.ok(cards.get('garment-3-bag-crossbody-bag').bestMatch.title.endsWith('crossbody bag'));
});

test('duplicate detected labels still resolve to distinct cards', async () => {
  // Two genuinely different garments the model happened to label the same way.
  const twins = [
    { ...CANDIDATES[1], id: 'garment-1-footwear-boot', label: 'boot',
      source: { ...CANDIDATES[1].source, candidateId: 'garment-1-footwear-boot',
        identification: { item_type: 'footwear', subtype: 'left boot', primary_color: 'brown' } } },
    { ...CANDIDATES[1], id: 'garment-2-footwear-boot', label: 'boot',
      source: { ...CANDIDATES[1].source, candidateId: 'garment-2-footwear-boot',
        identification: { item_type: 'footwear', subtype: 'right boot', primary_color: 'black' } } },
  ];
  const calls = [];
  const { fetchMultiItemCommerce } = load(bindingTransport(calls));
  const cards = await fetchMultiItemCommerce(twins);

  assert.equal(cards.size, 2, 'a shared label must not collapse two garments onto one card');
  assert.ok(cards.get('garment-1-footwear-boot').bestMatch.title.endsWith('left boot'));
  assert.ok(cards.get('garment-2-footwear-boot').bestMatch.title.endsWith('right boot'));
});
