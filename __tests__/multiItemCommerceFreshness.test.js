/**
 * RP-111 — multi-item commerce persistence freshness (Build 34 repair Lane E).
 *
 * The multi-item attach effect keyed on `cards.length + shelfStatus`, which is
 * not a statement about content. A refreshed shelf offering three completely
 * different products has the same count and the same status as the shelf it
 * replaces, so the fresher result was read as already-persisted and dropped.
 *
 * What this pins:
 *   - meaningfully changed commerce persists, even at an unchanged count and
 *     an unchanged status;
 *   - RP-110's currency is part of that content, so 29.99 USD and 29.99 EUR are
 *     not the same result;
 *   - identical canonical content still suppresses the duplicate write, so the
 *     repair does not trade stale persistence for a write storm;
 *   - the single-item path and actor/save-id isolation are unchanged.
 *
 * The fingerprint helper and the persistence writer are the real shipping
 * functions; the effect's guard is exercised by replaying the exact keying the
 * effect performs against the real helper, and app.js is asserted to use it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = process.env.KSCAN_COMMERCE_SOURCE_ROOT
  ? path.resolve(process.env.KSCAN_COMMERCE_SOURCE_ROOT)
  : path.resolve(__dirname, '..');

globalThis.__DEV__ = false;

// ── Loader (same pattern as multiItemCommercePersistence.test.js) ───────────

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

function createMemoryStorage() {
  const files = new Map();
  let manipulated = 0;
  const fileSystem = {
    documentDirectory: 'memory://documents/',
    EncodingType: { UTF8: 'utf8' },
    getInfoAsync: async (uri) => ({ exists: files.has(uri), uri }),
    readAsStringAsync: async (uri) => {
      if (!files.has(uri)) throw new Error(`Missing memory file: ${uri}`);
      return files.get(uri);
    },
    writeAsStringAsync: async (uri, value) => { files.set(uri, value); },
    makeDirectoryAsync: async () => undefined,
    moveAsync: async ({ from, to }) => { files.set(to, files.get(from) || 'image'); files.delete(from); },
    deleteAsync: async (uri) => { files.delete(uri); },
  };
  const imageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async () => {
      const uri = `memory://cache/manipulated-${++manipulated}.jpg`;
      files.set(uri, 'image');
      return { uri };
    },
  };
  return { files, fileSystem, imageManipulator };
}

function loadLibrary(storage, actorMocks) {
  const load = createLoader(ROOT, {
    'expo-file-system/legacy': storage.fileSystem,
    'expo-image-manipulator': storage.imageManipulator,
    './savedScansCloud': {
      saveScanToCloud: async () => ({ ok: false, reason: 'disabled' }),
      softDeleteCloudSavedScan: async () => ({ ok: false, reason: 'disabled' }),
    },
    './actorContext': actorMocks ?? {
      resolveWriteAuthority: () => ({ ok: true, ownerId: null }),
      isActorRequestCurrent: () => true,
    },
  });
  return load('services/library.js');
}

const library = loadLibrary(createMemoryStorage());
const { multiItemCommerceFingerprint, purchaseOptionsFingerprint } = library;

// ── Fixtures ───────────────────────────────────────────────────────────────

function offer(id, retailer, price, extra = {}) {
  return {
    id,
    title: `${retailer} ${id}`,
    retailer,
    price,
    currency: 'USD',
    availability: 'in_stock',
    imageUrl: `https://cdn.example.com/${id}.jpg`,
    productUrl: `https://shop.example.com/${id}`,
    ...extra,
  };
}

function card(candidateId, offers, status = 'ready') {
  const [bestMatch, ...alternatives] = offers;
  return { candidateId, status, bestMatch: bestMatch ?? null, alternatives, retryable: false };
}

/** The exact guard the attach effect performs, replayed over a render sequence. */
function writesFor(savedScanId, shelves) {
  let lastKey = null;
  const writes = [];
  for (const shelf of shelves) {
    if (!Array.isArray(shelf) || shelf.length === 0) continue;
    const key = savedScanId + ':' + multiItemCommerceFingerprint(shelf);
    if (lastKey === key) continue;
    lastKey = key;
    writes.push(shelf);
  }
  return writes;
}

const SHELF_A = [
  card('g1', [offer('a', 'Alpha', '$29.99'), offer('b', 'Beta', '$31.00')]),
  card('g2', [offer('c', 'Gamma', '$120.00')]),
  card('g3', [offer('d', 'Delta', '$80.00')]),
];

// ── 1. The defect: same count, same status, different commerce ─────────────

test('RP-111 CHANGE CONTROL: 3 products replaced by 3 DIFFERENT products persists', () => {
  const before = [card('g1', [offer('a', 'Alpha', '$29.99')])];
  const after = [card('g1', [offer('z', 'Zeta', '$29.99')])];

  assert.equal(before.length, after.length, 'fixture does not model an equal-count refresh');
  assert.equal(before[0].status, after[0].status, 'fixture does not model an unchanged status');
  assert.notEqual(
    multiItemCommerceFingerprint(before), multiItemCommerceFingerprint(after),
    'fingerprints are equal — the fresher shelf will be discarded',
  );
  assert.equal(writesFor('scan-1', [before, after]).length, 2, 'the refreshed shelf did not persist');

  // The whole-shelf case the audit describes: A,B,C -> D,E,F.
  const abc = [card('g1', [offer('a', 'Alpha', '$10')]), card('g2', [offer('b', 'Beta', '$20')]), card('g3', [offer('c', 'Gamma', '$30')])];
  const def = [card('g1', [offer('d', 'Delta', '$10')]), card('g2', [offer('e', 'Epsilon', '$20')]), card('g3', [offer('f', 'Zeta', '$30')])];
  assert.equal(abc.length, def.length);
  assert.notEqual(multiItemCommerceFingerprint(abc), multiItemCommerceFingerprint(def));
  assert.equal(writesFor('scan-1', [abc, def]).length, 2);
});

test('RP-111: a changed price persists at an unchanged count and status', () => {
  const before = [card('g1', [offer('a', 'Alpha', '$29.99')])];
  const after = [card('g1', [offer('a', 'Alpha', '$24.99')])];
  assert.notEqual(multiItemCommerceFingerprint(before), multiItemCommerceFingerprint(after));
  assert.equal(writesFor('scan-1', [before, after]).length, 2);
});

test('RP-110/RP-111 INTERACTION: 29.99 USD and 29.99 EUR are not the same result', () => {
  const usd = [card('g1', [offer('a', 'Alpha', '29.99', { currency: 'USD' })])];
  const eur = [card('g1', [offer('a', 'Alpha', '29.99', { currency: 'EUR' })])];

  assert.equal(usd[0].bestMatch.price, eur[0].bestMatch.price, 'fixture must hold the amount constant');
  assert.notEqual(
    multiItemCommerceFingerprint(usd), multiItemCommerceFingerprint(eur),
    'currency is absent from the fingerprint — a currency correction cannot persist',
  );
  assert.equal(writesFor('scan-1', [usd, eur]).length, 2);

  // Same failure mode on the single-item shelf.
  assert.notEqual(
    purchaseOptionsFingerprint([{ price: '29.99', currency: 'USD' }]),
    purchaseOptionsFingerprint([{ price: '29.99', currency: 'EUR' }]),
  );
});

test('RP-111: a changed merchant or destination persists', () => {
  const base = [card('g1', [offer('a', 'Alpha', '$29.99')])];
  const merchant = [card('g1', [offer('a', 'Omega', '$29.99')])];
  const destination = [card('g1', [offer('a', 'Alpha', '$29.99', { productUrl: 'https://other.example.com/a' })])];
  const affiliate = [card('g1', [offer('a', 'Alpha', '$29.99', { affiliateUrl: 'https://aff.example.com/a' })])];
  const availability = [card('g1', [offer('a', 'Alpha', '$29.99', { availability: 'sold_out' })])];

  for (const [label, shelf] of [['merchant', merchant], ['destination', destination], ['affiliate', affiliate], ['availability', availability]]) {
    assert.notEqual(
      multiItemCommerceFingerprint(base), multiItemCommerceFingerprint(shelf),
      `a changed ${label} does not persist`,
    );
  }
});

test('RP-111: a changed count and a changed per-card status both persist', () => {
  const one = [card('g1', [offer('a', 'Alpha', '$29.99')])];
  const two = [...one, card('g2', [offer('b', 'Beta', '$40.00')])];
  assert.notEqual(multiItemCommerceFingerprint(one), multiItemCommerceFingerprint(two));

  const ready = [card('g1', [], 'ready')];
  const noMatch = [card('g1', [], 'no_match')];
  const error = [card('g1', [], 'error')];
  assert.notEqual(multiItemCommerceFingerprint(ready), multiItemCommerceFingerprint(noMatch));
  assert.notEqual(multiItemCommerceFingerprint(noMatch), multiItemCommerceFingerprint(error));
});

// ── 2. Write-storm protection ──────────────────────────────────────────────

test('RP-111 NO-OP CONTROL: identical canonical content suppresses the duplicate write', () => {
  const clone = () => JSON.parse(JSON.stringify(SHELF_A));
  assert.equal(multiItemCommerceFingerprint(SHELF_A), multiItemCommerceFingerprint(clone()));

  // Re-render, re-render, re-render — with a fresh array identity each time,
  // which is what the hook actually produces.
  const writes = writesFor('scan-1', [SHELF_A, clone(), clone(), clone(), clone()]);
  assert.equal(writes.length, 1, 'identical content wrote more than once — this is a write storm');
});

test('RP-111: excluded provider bookkeeping does not schedule a write', () => {
  const base = [card('g1', [offer('a', 'Alpha', '$29.99')])];
  const churned = [card('g1', [offer('a', 'Alpha', '$29.99', {
    matchScore: 0.91,
    confidence: 0.77,
    similarityPercentage: 88,
    provider: 'serper',
    productId: 'provider-internal-99',
  })])];
  assert.equal(
    multiItemCommerceFingerprint(base), multiItemCommerceFingerprint(churned),
    'volatile provider metadata leaked into the fingerprint',
  );
  assert.equal(writesFor('scan-1', [base, churned]).length, 1);
});

// ── 3. Order semantics (documented, not guessed) ───────────────────────────

test('RP-111 ORDER: offer order within a card is content; card array order is not', () => {
  // Within a card, index 0 is BEST MATCH and the rest render as ALTERNATIVES in
  // order (services/multiItemCommerce.ts splitBestMatchAndAlternatives), so a
  // reordered shelf presents a different offer first and must persist.
  const forward = [card('g1', [offer('a', 'Alpha', '$10'), offer('b', 'Beta', '$20'), offer('c', 'Gamma', '$30')])];
  const reversed = [card('g1', [offer('c', 'Gamma', '$30'), offer('b', 'Beta', '$20'), offer('a', 'Alpha', '$10')])];
  assert.notEqual(
    multiItemCommerceFingerprint(forward), multiItemCommerceFingerprint(reversed),
    'offer order is not fingerprinted — a re-ranked shelf would not persist',
  );

  // The card ARRAY order is invisible: MultiItemCommerceSection renders one card
  // per detected candidate via cardsByCandidateId.get(candidate.id). Writing
  // again for a reshuffled array would change nothing on screen.
  const shuffled = [SHELF_A[2], SHELF_A[0], SHELF_A[1]];
  assert.equal(
    multiItemCommerceFingerprint(SHELF_A), multiItemCommerceFingerprint(shuffled),
    'card array order leaked into the fingerprint — needless writes',
  );

  // The evidence for both halves of that decision, pinned.
  const section = fs.readFileSync(path.join(ROOT, 'components', 'scan-results', 'MultiItemCommerceSection.tsx'), 'utf8');
  assert.ok(
    section.includes('cardsByCandidateId.get(candidate.id)'),
    'cards are no longer rendered by candidate lookup — re-decide card order sensitivity',
  );
  const service = fs.readFileSync(path.join(ROOT, 'services', 'multiItemCommerce.ts'), 'utf8');
  assert.ok(
    service.includes('const [bestMatch, ...alternatives] = purchaseOptions'),
    'offer position is no longer decisive — re-decide offer order sensitivity',
  );
});

// ── 4. Wiring, and the guard the effect actually uses ──────────────────────

test('RP-111: the multi-item attach key is content-derived, not count-derived', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const start = app.indexOf('attachedMultiItemCommerceRef');
  assert.ok(start > 0, 'no multi-item attach effect');
  const body = app.slice(start, start + 1200);

  assert.ok(
    body.includes('multiItemCommerceFingerprint(multiItemCommerce)'),
    'multi-item attach key is not content-derived — refreshed commerce will not persist',
  );
  // The empty-shelf guard legitimately reads `.length`; the KEY must not.
  const keyLine = body.split('\n').find((line) => line.includes('const key ='));
  assert.ok(keyLine, 'no attach key in the multi-item effect');
  assert.equal(
    /multiItemCommerce\.length|multiItemCommerceStatus/.test(keyLine), false,
    'multi-item attach key still uses the card count or the shelf status',
  );
  assert.ok(
    app.includes('multiItemCommerceFingerprint,\n} from \'./services/library\''),
    'the fingerprint helper is used without being imported',
  );
  // The single-item effect keeps its own content key.
  const single = app.slice(app.indexOf('attachedCommerceRef'), app.indexOf('attachedCommerceRef') + 1400);
  assert.ok(single.includes('purchaseOptionsFingerprint(options)'), 'single-item attach key regressed');
});

test('RP-111: the shared single-item helper is reused, not re-implemented', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services', 'library.js'), 'utf8');
  const start = src.indexOf('export function multiItemCommerceFingerprint');
  assert.ok(start > 0, 'no multi-item fingerprint helper');
  const body = src.slice(start, start + 1200);
  assert.ok(
    body.includes('purchaseOptionsFingerprint('),
    'multi-item fingerprint invented a second offer-content convention',
  );
  assert.equal(multiItemCommerceFingerprint([]), '');
  assert.equal(multiItemCommerceFingerprint(null), '');
  assert.equal(multiItemCommerceFingerprint([null, 'junk', 42]), '');
});

// ── 5. The write path itself: freshness, isolation, failure ────────────────

test('RP-111: a refreshed shelf of equal length actually replaces the stored one', async () => {
  const storage = createMemoryStorage();
  const lib = loadLibrary(storage);
  const saved = await lib.saveMultiItemScan({
    photoUri: 'memory://capture.jpg',
    analysis: { result: 'ok', metadata: {} },
    candidates: [{ id: 'g1', label: 'Biker Jacket', category: 'outerwear', confidenceScore: 0.8 }],
    source: 'camera',
  });

  assert.equal(await lib.attachScanMultiItemCommerce(saved.id, [card('g1', [offer('a', 'Alpha', '$29.99')])]), true);
  let reopened = (await lib.loadLibrary(undefined)).find((s) => s.id === saved.id);
  assert.equal(reopened.multiItemCommerce[0].bestMatch.retailer, 'Alpha');
  assert.equal(reopened.multiItemCommerce[0].bestMatch.price, '$29.99');

  // Same count, same status, different commerce — the case that used to be lost.
  assert.equal(await lib.attachScanMultiItemCommerce(saved.id, [card('g1', [offer('z', 'Omega', '$24.99')])]), true);
  reopened = (await lib.loadLibrary(undefined)).find((s) => s.id === saved.id);
  assert.equal(reopened.multiItemCommerce.length, 1, 'replaced wholesale, never appended');
  assert.equal(reopened.multiItemCommerce[0].bestMatch.retailer, 'Omega');
  assert.equal(reopened.multiItemCommerce[0].bestMatch.price, '$24.99');
  // RP-110: the declared currency survived persistence.
  assert.equal(reopened.multiItemCommerce[0].bestMatch.currency, 'USD');
});

test('RP-111: a superseded actor cannot land commerce, and the failure destroys nothing', async () => {
  const storage = createMemoryStorage();
  let actorIsCurrent = true;
  const lib = loadLibrary(storage, {
    resolveWriteAuthority: () => ({ ok: true, ownerId: null }),
    isActorRequestCurrent: () => actorIsCurrent,
  });
  const saved = await lib.saveMultiItemScan({
    photoUri: 'memory://capture.jpg',
    analysis: { result: 'ok', metadata: {} },
    candidates: [{ id: 'g1', label: 'Biker Jacket', category: 'outerwear', confidenceScore: 0.8 }],
    source: 'camera',
  });

  const live = [card('g1', [offer('a', 'Alpha', '$29.99')])];
  assert.equal(await lib.attachScanMultiItemCommerce(saved.id, live, { actorRequest: { actorId: null } }), true);

  // The actor changed while the refreshed commerce was in flight.
  actorIsCurrent = false;
  assert.equal(
    await lib.attachScanMultiItemCommerce(saved.id, [card('g1', [offer('z', 'Omega', '$24.99')])], { actorRequest: { actorId: null } }),
    false,
    'a superseded actor was allowed to write',
  );

  // A rejected write leaves the record exactly as it was, and the live shelf the
  // caller still holds is untouched — persistence failure never edits state.
  const reopened = (await lib.loadLibrary(undefined)).find((s) => s.id === saved.id);
  assert.equal(reopened.multiItemCommerce[0].bestMatch.retailer, 'Alpha');
  assert.equal(live[0].bestMatch.retailer, 'Alpha');
  assert.equal(live[0].bestMatch.price, '$29.99');

  // An unknown save id is simply not written, and reports so.
  actorIsCurrent = true;
  assert.equal(await lib.attachScanMultiItemCommerce('no-such-scan', live), false);
  assert.equal((await lib.loadLibrary(undefined)).length, 1);
});

// ── 6. Single-item regression ──────────────────────────────────────────────

test('RP-111: the single-item fingerprint still distinguishes an enriched shelf', () => {
  const discovery = [
    { title: 'Moto Jacket', productUrl: 'https://s.test/a', price: '$450', imageUrl: '' },
    { title: 'Suede Bomber', productUrl: 'https://s.test/b', price: '$300', imageUrl: '' },
  ];
  const enriched = [
    { title: 'Moto Jacket', productUrl: 'https://s.test/a', price: '$399', imageUrl: 'https://c.test/a.jpg' },
    { title: 'Suede Bomber', productUrl: 'https://s.test/b', price: '$300', imageUrl: '' },
  ];
  assert.equal(discovery.length, enriched.length);
  assert.notEqual(purchaseOptionsFingerprint(discovery), purchaseOptionsFingerprint(enriched));
  assert.equal(purchaseOptionsFingerprint(discovery), purchaseOptionsFingerprint(discovery.map((o) => ({ ...o }))));
  assert.equal(purchaseOptionsFingerprint([]), '');
});
