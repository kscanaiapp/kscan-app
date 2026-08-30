/**
 * Recent Scan reopen network isolation (Build 32).
 *
 * The governing product requirement is that a commerce result the user already
 * received reopens WITHOUT re-identification and WITHOUT re-querying retailers.
 * That was previously asserted by grepping app/library.tsx for a comment and
 * for three specific function names — which passes unchanged if someone wires
 * in a fourth, and breaks if someone edits the comment. Neither is a real
 * guard.
 *
 * This file replaces that with two mechanical proofs:
 *
 *   1. RUNTIME COUNTERS. The real reopen data path (services/library.js) runs
 *      against instrumented dependencies. Every network-capable primitive it
 *      could reach — Edge Function invoke, raw fetch/XHR, cloud read, cloud
 *      write — increments a counter. Reopen must leave every counter at zero.
 *
 *   2. MODULE-GRAPH REACHABILITY. The four modules that actually constitute a
 *      reopen (storage, list hook, detail card, commerce panel) are walked
 *      transitively, and none may reach an AI-identification or commerce-
 *      provider authority. Wiring an automatic refresh into reopen requires
 *      importing one of those, so any such change fails here regardless of
 *      what it is named.
 *
 * Scope note: the guard is deliberately anchored on the reopen path rather
 * than on app/library.tsx as a whole. That screen legitimately reaches
 * services/scanIdentification via the Closet intake feature
 * (useClosetCandidates -> closetCandidateClassification), which is a separate,
 * explicitly user-initiated action and not part of reopening a saved scan.
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

const MANIFEST = 'memory://documents/kscan_library/kscan_library.json';

// ── Loader ───────────────────────────────────────────────────────────────────

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

// ── Instrumented environment ─────────────────────────────────────────────────

/**
 * Every counter here represents a class of work that must not happen when a
 * user taps an already-saved scan.
 */
function createCounters() {
  return {
    edgeInvoke: 0,      // supabase.functions.invoke — scan-identify, MODE A/B
    fetch: 0,           // any raw HTTP, including a retailer/provider call
    xhr: 0,
    cloudRead: 0,       // Supabase saved-scan SELECT
    cloudWrite: 0,      // Supabase saved-scan UPSERT / soft delete
    imageWork: 0,       // re-encoding a photo is scan-time work, not reopen work
  };
}

function createEnvironment(counters) {
  const files = new Map();
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
    moveAsync: async ({ from, to }) => {
      if (!files.has(from)) throw new Error(`Missing memory file: ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    deleteAsync: async (uri) => { files.delete(uri); },
  };
  const imageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async () => {
      counters.imageWork += 1;
      const uri = `memory://cache/manipulated-${counters.imageWork}.jpg`;
      files.set(uri, 'image');
      return { uri };
    },
  };
  const savedScansCloud = {
    CLOUD_SAVED_SCANS_ENABLED: false,
    saveScanToCloud: async () => { counters.cloudWrite += 1; return { ok: true }; },
    softDeleteCloudSavedScan: async () => { counters.cloudWrite += 1; return { ok: true }; },
    listCloudSavedScans: async () => { counters.cloudRead += 1; return { ok: true, data: [] }; },
    mergeLocalAndCloudScans: (local) => local,
  };
  const supabase = {
    functions: { invoke: async () => { counters.edgeInvoke += 1; return { data: null, error: null }; } },
    from: () => {
      counters.cloudRead += 1;
      const chain = new Proxy({}, { get: () => () => chain });
      return chain;
    },
  };
  return { files, fileSystem, imageManipulator, savedScansCloud, supabase };
}

function loadLibraryModule(env) {
  return createLoader(ROOT, {
    'expo-file-system/legacy': env.fileSystem,
    'expo-image-manipulator': env.imageManipulator,
    './savedScansCloud': env.savedScansCloud,
    './supabaseClient': { supabase: env.supabase },
    './actorContext': {
      resolveWriteAuthority: () => ({ ok: true, ownerId: null }),
      isActorRequestCurrent: () => true,
    },
  })('services/library.js');
}

/** Count raw network primitives for the duration of one operation. */
async function withNetworkTraps(counters, operation) {
  const originals = { fetch: globalThis.fetch, XMLHttpRequest: globalThis.XMLHttpRequest };
  globalThis.fetch = async (...args) => {
    counters.fetch += 1;
    throw new Error(`Unexpected reopen network call: ${String(args[0])}`);
  };
  globalThis.XMLHttpRequest = function TrappedXHR() {
    counters.xhr += 1;
    throw new Error('Unexpected reopen XMLHttpRequest');
  };
  try {
    return await operation();
  } finally {
    globalThis.fetch = originals.fetch;
    globalThis.XMLHttpRequest = originals.XMLHttpRequest;
  }
}

const COMMERCE = [
  { title: 'Biker Jacket', retailer: 'AllSaints', price: '519', currency: 'USD',
    productUrl: 'https://shop.example.com/a1', imageUrl: 'https://cdn.example.com/a1.jpg',
    availability: 'in_stock' },
  { title: 'Leather Jacket', retailer: 'Schott NYC', price: '890', currency: 'USD',
    productUrl: 'https://shop.example.com/a2' },
];

// ── 1. Runtime counters ──────────────────────────────────────────────────────

test('reopening a saved commerce scan issues zero AI, provider and cloud calls', async () => {
  const counters = createCounters();
  const env = createEnvironment(counters);

  // Phase 1 — the original scan. Work here is expected and not what we count.
  const scanner = loadLibraryModule(env);
  const saved = await scanner.saveScan({
    photoUri: 'memory://capture.jpg',
    analysis: {
      result: 'Black leather biker jacket',
      metadata: { category: 'outerwear', color: 'black' },
      products: [],
      purchaseOptions: COMMERCE,
    },
    source: 'camera',
  });
  assert.ok(saved?.id);
  assert.equal(saved.purchaseOptions.length, 2);

  // Phase 2 — a cold relaunch, then the reopen itself. Everything from here on
  // must be pure local reads.
  const relaunched = loadLibraryModule(env);
  const baseline = { ...counters };

  const reopened = await withNetworkTraps(counters, async () => {
    const scans = await relaunched.loadLibrary(null);       // Recent Scans list
    const record = scans.find((s) => s.id === saved.id);    // user taps the card
    // Exactly what the detail surface is handed.
    return {
      result: record.result,
      purchaseOptions: record.purchaseOptions,
      products: record.products,
      imageUri: record.imageUri,
    };
  });

  assert.equal(counters.edgeInvoke - baseline.edgeInvoke, 0, 'Gemini / scan-identify calls');
  assert.equal(counters.fetch - baseline.fetch, 0, 'raw provider or retailer fetches');
  assert.equal(counters.xhr - baseline.xhr, 0, 'XHR');
  assert.equal(counters.cloudRead - baseline.cloudRead, 0, 'cloud reads');
  assert.equal(counters.cloudWrite - baseline.cloudWrite, 0, 'cloud writes');
  assert.equal(counters.imageWork - baseline.imageWork, 0, 're-encoded images');

  // And the user actually got their commerce back.
  assert.equal(reopened.purchaseOptions.length, 2);
  assert.deepEqual(
    reopened.purchaseOptions.map((o) => o.retailer),
    ['AllSaints', 'Schott NYC'],
  );
  assert.equal(reopened.purchaseOptions[0].price, '519');
  assert.equal(reopened.purchaseOptions[0].productUrl, 'https://shop.example.com/a1');
});

test('reopening a legacy scan with no commerce still issues zero calls', async () => {
  const counters = createCounters();
  const env = createEnvironment(counters);
  env.files.set(MANIFEST, JSON.stringify([{
    id: 'legacy-1', createdAt: '2024-01-01T00:00:00.000Z', result: 'old scan',
    attributes: { category: 'top' }, source: 'scan',
  }]));

  const library = loadLibraryModule(env);
  const baseline = { ...counters };
  const scans = await withNetworkTraps(counters, () => library.loadLibrary(null));

  assert.equal(scans.length, 1);
  assert.deepEqual(scans[0].purchaseOptions, [],
    'an empty shelf is rendered as empty — never refetched to fill it');
  assert.equal(counters.edgeInvoke - baseline.edgeInvoke, 0);
  assert.equal(counters.fetch - baseline.fetch, 0);
  assert.equal(counters.cloudRead - baseline.cloudRead, 0);
  assert.equal(counters.cloudWrite - baseline.cloudWrite, 0);
});

test('reopening the same scan repeatedly never escalates into a refresh', async () => {
  const counters = createCounters();
  const env = createEnvironment(counters);
  const scanner = loadLibraryModule(env);
  await scanner.saveScan({
    photoUri: 'memory://capture.jpg',
    analysis: { result: 'x', metadata: {}, products: [], purchaseOptions: COMMERCE },
    source: 'camera',
  });

  const library = loadLibraryModule(env);
  const baseline = { ...counters };
  await withNetworkTraps(counters, async () => {
    for (let i = 0; i < 5; i += 1) {
      const scans = await library.loadLibrary(null);
      assert.equal(scans[0].purchaseOptions.length, 2, `reopen ${i + 1} still renders stored commerce`);
    }
  });

  assert.equal(counters.edgeInvoke - baseline.edgeInvoke, 0);
  assert.equal(counters.fetch - baseline.fetch, 0);
  assert.equal(counters.cloudRead - baseline.cloudRead, 0);
  assert.equal(counters.cloudWrite - baseline.cloudWrite, 0,
    'reading history never writes back to the cloud');
});

// ── 2. Module-graph reachability ─────────────────────────────────────────────

/**
 * Authorities that perform AI identification or commerce-provider work. If a
 * reopen-path module can reach one of these, an automatic refresh is one call
 * away — which is exactly the regression this file exists to prevent.
 */
const PROHIBITED_ON_REOPEN = [
  { label: 'deferred commerce hydration (MODE B)', pattern: /services[/\\]commerceHydration/ },
  { label: 'scan identification client', pattern: /services[/\\]scanIdentification\./ },
  { label: 'scanner identification V2', pattern: /services[/\\]scannerIdentificationV2/ },
  { label: 'scanner scan request', pattern: /services[/\\]scannerScanRequest/ },
  { label: 'text scan edge client', pattern: /services[/\\]textScanEdge/ },
  { label: 'live scan hook', pattern: /hooks[/\\]useKScan/ },
];

/** The modules a Recent Scan reopen is actually made of. */
const REOPEN_PATH_ENTRIES = [
  'services/library.js',
  'hooks/useLibrary.js',
  'components/AnalysisCard.tsx',
  'components/scan-results/PurchaseOptionsPanel.tsx',
];

function normalize(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }

function resolveModule(candidate) {
  const candidates = path.extname(candidate)
    ? [candidate]
    : [`${candidate}.ts`, `${candidate}.tsx`, `${candidate}.js`, `${candidate}.jsx`,
       path.join(candidate, 'index.ts'), path.join(candidate, 'index.tsx'),
       path.join(candidate, 'index.js')];
  return candidates.find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
}

function reachableFrom(entry) {
  const seen = new Set();
  const violations = [];
  (function walk(file, chain) {
    const resolved = resolveModule(file);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    const rel = normalize(resolved);
    for (const banned of PROHIBITED_ON_REOPEN) {
      if (banned.pattern.test(rel)) {
        violations.push(`${banned.label}: ${chain.concat(rel).slice(-4).join(' -> ')}`);
      }
    }
    const source = fs.readFileSync(resolved, 'utf8');
    const importRe = /(?:from\s*|require\(\s*)['"](\.[^'"]+)['"]/g;
    let match;
    while ((match = importRe.exec(source))) {
      walk(path.resolve(path.dirname(resolved), match[1]), chain.concat(rel));
    }
  })(path.resolve(ROOT, entry), []);
  return { seen, violations };
}

for (const entry of REOPEN_PATH_ENTRIES) {
  test(`${entry} cannot reach any AI or commerce provider authority`, () => {
    const { seen, violations } = reachableFrom(entry);
    assert.ok(seen.size > 1, `${entry}: the graph walk actually resolved imports`);
    assert.deepEqual(
      violations, [],
      `${entry} can now reach identification/commerce work on reopen:\n  ${violations.join('\n  ')}`,
    );
  });
}

test('the reopen graph contains no scan-identify Edge Function invocation', () => {
  const offenders = [];
  for (const entry of REOPEN_PATH_ENTRIES) {
    for (const file of reachableFrom(entry).seen) {
      const source = fs.readFileSync(file, 'utf8');
      if (/functions\s*\.\s*invoke\s*\(\s*['"]scan-identify['"]/.test(source)
          || /EDGE_FN\s*=\s*['"]scan-identify['"]/.test(source)) {
        offenders.push(normalize(file));
      }
    }
  }
  assert.deepEqual([...new Set(offenders)], [],
    'a reopen-path module now invokes scan-identify');
});

test('the guard itself is wired to the modules it claims to cover', () => {
  // A reachability assertion that silently walks nothing would pass forever.
  for (const entry of REOPEN_PATH_ENTRIES) {
    assert.ok(resolveModule(path.resolve(ROOT, entry)), `${entry} exists`);
  }
  assert.ok(reachableFrom('services/library.js').seen.size >= 5);
  assert.ok(reachableFrom('components/AnalysisCard.tsx').seen.size >= 20);
});
