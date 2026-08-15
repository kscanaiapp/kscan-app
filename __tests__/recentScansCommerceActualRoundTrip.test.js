const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = process.env.KSCAN_COMMERCE_SOURCE_ROOT
  ? path.resolve(process.env.KSCAN_COMMERCE_SOURCE_ROOT)
  : path.resolve(__dirname, '..');

globalThis.__DEV__ = false;

function createLoader(root, mocks = {}) {
  const cache = new Map();

  function resolveFile(candidate) {
    const candidates = path.extname(candidate)
      ? [candidate]
      : [`${candidate}.ts`, `${candidate}.tsx`, `${candidate}.js`];
    return candidates.find((filename) => fs.existsSync(filename) && fs.statSync(filename).isFile());
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
    moveAsync: async ({ from, to }) => {
      files.set(to, files.get(from) || 'image');
      files.delete(from);
    },
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

function loadLibrary(storage) {
  const load = createLoader(ROOT, {
    'expo-file-system/legacy': storage.fileSystem,
    'expo-image-manipulator': storage.imageManipulator,
    './savedScansCloud': {
      saveScanToCloud: async () => ({ ok: false, reason: 'disabled' }),
      softDeleteCloudSavedScan: async () => ({ ok: false, reason: 'disabled' }),
    },
    // Ownership authority is covered by recentScanAccountIsolation.test.js.
    // These cases exercise commerce persistence under a valid signed-out
    // (ownerless) context, so the authority check is doubled out here.
    './actorContext': {
      resolveWriteAuthority: () => ({ ok: true, ownerId: null }),
      isActorRequestCurrent: () => true,
    },
  });
  return load('services/library.js');
}

function offer(id, retailer, price, extra = {}) {
  return {
    id,
    title: `${retailer} offer`,
    retailer,
    price,
    currency: 'USD',
    imageUrl: `https://cdn.example.com/${id}.jpg`,
    purchaseUrl: `https://shop.example.com/${id}?affiliate=kscan`,
    ...extra,
  };
}

function backendResponse(recommendedProducts) {
  return {
    status: 'completed',
    scanId: 'scan-commerce-roundtrip',
    identification: { visual_observation: 'Black leather biker jacket', confidence_score: 0.91 },
    attributes: { category: 'outerwear', color: 'black' },
    similarityMatches: [
      offer('similar-1', 'Catalog One', 210),
      offer('similar-2', 'Catalog Two', 230),
    ],
    recommendedProducts,
    userMessage: 'ok',
  };
}

function mappedAnalysis(recommendedProducts) {
  const load = createLoader(ROOT, { './supabaseClient': { supabase: {} } });
  const { mapScanIdentifyToAnalysis } = load('services/scanIdentificationMapper.ts');
  return mapScanIdentifyToAnalysis(backendResponse(recommendedProducts));
}

test('real saveScan/loadLibrary survives a fresh module cache with distinct commerce', async () => {
  const storage = createMemoryStorage();
  const options = [
    offer('buy-1', 'AllSaints', 519, { availability: 'in_stock' }),
    offer('buy-2', 'Schott NYC', 890),
    offer('buy-3', 'Mr Porter', 1100),
  ];
  const analysis = mappedAnalysis(options);
  assert.equal(analysis.products.length, 2, 'catalog similarity results remain separate');
  assert.equal(analysis.purchaseOptions.length, 3, 'backend offers enter the commerce channel');

  const firstProcess = loadLibrary(storage);
  const saved = await firstProcess.saveScan({ photoUri: 'memory://capture.jpg', analysis, source: 'camera' });
  assert.ok(saved?.id);
  assert.equal(saved.purchaseOptions.length, 3);

  // Recreate the transpiled module cache while retaining only persisted files.
  const relaunchedProcess = loadLibrary(storage);
  const [reopened] = await relaunchedProcess.loadLibrary();
  assert.equal(reopened.id, saved.id);
  assert.notEqual(reopened, saved, 'reopened value came from JSON, not the same object reference');
  assert.deepEqual(reopened.purchaseOptions.map((item) => item.retailer), [
    'AllSaints',
    'Schott NYC',
    'Mr Porter',
  ]);
  assert.equal(reopened.products.length, 2);
  assert.deepEqual(
    {
      retailer: reopened.purchaseOptions[0].retailer,
      title: reopened.purchaseOptions[0].title,
      price: reopened.purchaseOptions[0].price,
      currency: reopened.purchaseOptions[0].currency,
      productUrl: reopened.purchaseOptions[0].productUrl,
      availability: reopened.purchaseOptions[0].availability,
      imageUrl: reopened.purchaseOptions[0].imageUrl,
      productId: reopened.purchaseOptions[0].productId,
    },
    {
      retailer: 'AllSaints',
      title: 'AllSaints offer',
      price: '519',
      currency: 'USD',
      productUrl: 'https://shop.example.com/buy-1?affiliate=kscan',
      availability: 'in_stock',
      imageUrl: 'https://cdn.example.com/buy-1.jpg',
      productId: 'buy-1',
    },
  );
});

test('real storage round trip handles zero, one, and the bounded maximum options', async () => {
  const storage = createMemoryStorage();
  const library = loadLibrary(storage);
  const cases = [
    { source: 'zero', count: 0, options: [] },
    { source: 'one', count: 1, options: [offer('one', 'One Store', 10)] },
    {
      source: 'maximum',
      count: 24,
      options: Array.from({ length: 60 }, (_, index) => offer(`max-${index}`, `Store ${index}`, index + 1)),
    },
  ];

  for (const scenario of cases) {
    const saved = await library.saveScan({
      photoUri: 'memory://capture.jpg',
      analysis: mappedAnalysis(scenario.options),
      source: scenario.source,
    });
    assert.equal(saved.purchaseOptions.length, scenario.count);
  }

  const reopened = await loadLibrary(storage).loadLibrary();
  for (const scenario of cases) {
    const scan = reopened.find((item) => item.source === scenario.source);
    assert.equal(scan.purchaseOptions.length, scenario.count, scenario.source);
  }
});

test('persisted options reach the real safe-link helper without transient callbacks', async () => {
  const storage = createMemoryStorage();
  const library = loadLibrary(storage);
  await library.saveScan({
    photoUri: 'memory://capture.jpg',
    analysis: mappedAnalysis([
      offer('first', 'First Store', 10),
      offer('second', 'Second Store', 20),
    ]),
    source: 'actionability',
  });
  const [reopened] = await loadLibrary(storage).loadLibrary();
  const { openPersistedCommerceUrl } = createLoader(ROOT)('services/dressingRoomCommerce.ts');
  const opened = [];

  for (const option of reopened.purchaseOptions) {
    const didOpen = await openPersistedCommerceUrl(option.productUrl, async (url) => {
      opened.push(url);
    });
    assert.equal(didOpen, true);
  }
  assert.deepEqual(opened, [
    'https://shop.example.com/first?affiliate=kscan',
    'https://shop.example.com/second?affiliate=kscan',
  ]);

  assert.equal(
    await openPersistedCommerceUrl('file:///tmp/item', async (url) => opened.push(url)),
    false,
  );
  assert.equal(
    await openPersistedCommerceUrl('https://shop.example.com/fails', async () => {
      throw new Error('simulated Linking rejection');
    }),
    false,
    'handler rejection is contained',
  );
  assert.equal(opened.length, 2, 'invalid URL never reaches the handler');
});

test('two real persisted scan IDs retain their own commerce association', async () => {
  const storage = createMemoryStorage();
  const library = loadLibrary(storage);
  const jacket = await library.saveScan({
    photoUri: 'memory://jacket.jpg',
    analysis: mappedAnalysis([offer('jacket', 'AllSaints', 519)]),
    source: 'jacket',
  });
  const boots = await library.saveScan({
    photoUri: 'memory://boots.jpg',
    analysis: mappedAnalysis([offer('boots', 'Dr Martens', 180)]),
    source: 'boots',
  });

  const reopened = await loadLibrary(storage).loadLibrary();
  const reopenedJacket = reopened.find((scan) => scan.id === jacket.id);
  const reopenedBoots = reopened.find((scan) => scan.id === boots.id);
  assert.equal(reopenedJacket.purchaseOptions[0].productId, 'jacket');
  assert.equal(reopenedBoots.purchaseOptions[0].productId, 'boots');
  assert.notDeepEqual(reopenedJacket.purchaseOptions, reopenedBoots.purchaseOptions);
});

test('real loadLibrary normalizes legacy aliases, junk, and signed URLs', async () => {
  const storage = createMemoryStorage();
  const libraryPath = 'memory://documents/kscan_library/kscan_library.json';
  storage.files.set(libraryPath, JSON.stringify([
    { id: 'legacy', products: [], result: 'legacy' },
    { id: 'null', purchaseOptions: null },
    { id: 'empty', purchaseOptions: [] },
    { id: 'junk', purchaseOptions: [null, 3, 'bad', { nope: true }] },
    { id: 'recommended-only', recommendedProducts: [offer('recommended', 'Legacy', 100)] },
    { id: 'products-only', products: [offer('similar', 'Catalog', 90)] },
    {
      id: 'both',
      products: [offer('similar-both', 'Catalog', 90)],
      purchaseOptions: [offer('buy-both', 'Merchant', 100, { rawProviderResponse: { secret: true } })],
    },
    {
      id: 'snake',
      purchase_options: [
        offer('snake', 'Ssense', 300),
        offer('signed-product', 'Unsafe', 5, {
          purchaseUrl: 'https://shop.example.com/p?access_token=secret',
          imageUrl: 'https://project.supabase.co/storage/v1/object/sign/private/x.jpg?token=secret',
        }),
        offer('aws-image', 'AWS', 8, {
          imageUrl: 'https://cdn.example.com/x.jpg?X-Amz-Signature=secret&X-Amz-Expires=60',
        }),
      ],
    },
  ]));

  const scans = await loadLibrary(storage).loadLibrary();
  assert.deepEqual(scans.find((scan) => scan.id === 'legacy').purchaseOptions, []);
  assert.deepEqual(scans.find((scan) => scan.id === 'null').purchaseOptions, []);
  assert.deepEqual(scans.find((scan) => scan.id === 'empty').purchaseOptions, []);
  assert.deepEqual(scans.find((scan) => scan.id === 'junk').purchaseOptions, []);
  assert.deepEqual(scans.find((scan) => scan.id === 'recommended-only').purchaseOptions, []);
  assert.deepEqual(scans.find((scan) => scan.id === 'products-only').purchaseOptions, []);
  const both = scans.find((scan) => scan.id === 'both');
  assert.equal(both.products[0].id, 'similar-both');
  assert.equal(both.purchaseOptions[0].productId, 'buy-both');
  assert.doesNotMatch(JSON.stringify(both.purchaseOptions), /rawProviderResponse|secret/);
  const snake = scans.find((scan) => scan.id === 'snake').purchaseOptions;
  assert.equal(snake[0].productUrl, 'https://shop.example.com/snake?affiliate=kscan');
  const serialized = JSON.stringify(snake);
  assert.doesNotMatch(serialized, /secret|access_token|X-Amz-|\/object\/sign\//i);
});

test('production commerce helpers reject credentials and retain price currency semantics', () => {
  const load = createLoader(ROOT);
  const {
    formatCommercePrice,
    normalizePersistedCommerceUrl,
    normalizePurchaseOptions,
  } = load('services/dressingRoomCommerce.ts');

  const hostile = [
    'http://shop.example.com/item',
    'file:///tmp/item',
    'blob:https://shop.example.com/temporary',
    'data:text/plain,temporary',
    '/local/item',
    'https://user:password@shop.example.com/item',
    'https://shop.example.com/item?access_token=secret',
    'https://project.supabase.co/storage/v1/object/sign/private/x.jpg?token=secret',
    'https://cdn.example.com/x.jpg?X-Amz-Signature=secret&X-Amz-Expires=60',
    'https://cdn.example.com/x.jpg?GoogleAccessId=svc&Expires=99&Signature=abc',
    'https://cdn.example.com/x.jpg?Key-Pair-Id=APKA&Policy=eyJ&Signature=abc',
    'https://shop.example.com/item?jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
  ];
  for (const url of hostile) assert.equal(normalizePersistedCommerceUrl(url), null, url);

  // KSB29-025 / DEF-032 — DELIBERATE POLICY CHANGE.
  //
  // These were previously rejected, because the filter refused any URL whose
  // query or fragment contained a key named `token`, `sig`, `signature`,
  // `expires`, `expires_at` or `policy`. Legitimate commerce providers use
  // signed and expiring product links as a matter of course, so that rule
  // silently emptied the purchase options on valid scans — real merchandise the
  // user could have bought, discarded to guard a boundary that lives elsewhere.
  //
  // The boundary is the DESTINATION (protocol, host, embedded credentials,
  // private-network targets) plus the value-shaped rules, not a parameter name.
  // K Scan's own signed URLs are still refused above, by the object-storage
  // signing parameters and the Supabase signed-object path — which is what this
  // filter exists to keep out of a shareable snapshot.
  const legitimate = [
    'https://shop.example.com/item?affiliate=kscan&utm_source=app',
    'https://shop.example.com/p/12345?token=abc123',
    'https://shop.example.com/p/12345?sig=abc&expires=1799999999',
    'https://go.retailer.example/deeplink?signature=abc&policy=standard',
  ];
  for (const url of legitimate) {
    assert.equal(normalizePersistedCommerceUrl(url), url, `must survive persistence: ${url}`);
  }
  assert.equal(formatCommercePrice('519', 'USD'), '$519.00');
  assert.match(formatCommercePrice('519', 'EUR'), /519/);

  const [canonical] = normalizePurchaseOptions([offer('stable-id', 'Store', 519)]);
  assert.equal(canonical.productId, 'stable-id');
  assert.equal(canonical.currency, 'USD');
  assert.equal(
    normalizePurchaseOptions([
      offer('first-url', 'Same Store', 100),
      offer('second-url', 'Same Store', 100),
      offer('first-url', 'Same Store', 100),
    ]).length,
    2,
    'distinct product URLs survive while exact duplicate fingerprints collapse',
  );
});

test('real persisted payload remains bounded for a 25-scan maximum library', async (t) => {
  const storage = createMemoryStorage();
  const library = loadLibrary(storage);
  const maximumOptions = Array.from(
    { length: 60 },
    (_, index) => offer(`bounded-${index}`, `Retailer ${index}`, 100 + index),
  );
  const analysis = mappedAnalysis(maximumOptions);

  const first = await library.saveScan({
    photoUri: 'memory://capture.jpg',
    analysis,
    source: 'bounded-0',
  });
  const oneScanBytes = Buffer.byteLength(JSON.stringify(first), 'utf8');
  for (let index = 1; index < 25; index += 1) {
    await library.saveScan({
      photoUri: 'memory://capture.jpg',
      analysis,
      source: `bounded-${index}`,
    });
  }
  const libraryJson = storage.files.get('memory://documents/kscan_library/kscan_library.json');
  const fullLibraryBytes = Buffer.byteLength(libraryJson, 'utf8');
  t.diagnostic(`realistic-max one scan: ${oneScanBytes} bytes; 25 scans: ${fullLibraryBytes} bytes`);
  assert.equal((JSON.parse(libraryJson)[0].purchaseOptions || []).length, 24);
  assert.ok(oneScanBytes < 40_000);
  assert.ok(fullLibraryBytes < 1_000_000);
});

test('KSB29-025: no commerce surface opens a destination outside the safety layer', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');

  // Every surface that can launch a purchase destination. PurchaseOptionsPanel
  // called `Linking.openURL(option.productUrl!)` directly, so the centralized
  // selector/opener -- HTTPS only, no embedded credentials, no loopback or
  // private-network target, no javascript:/file:/data: -- was simply not in the
  // path for the primary Scan Results purchase control.
  const surfaces = [
    'components/scan-results/PurchaseOptionsPanel.tsx',
    'components/ProductShelf.tsx',
  ];

  for (const relativePath of surfaces) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');

    // A raw openURL on provider-supplied metadata is the defect itself.
    const rawOpens = source.match(/Linking\.openURL\([^)]*\)/g) || [];
    for (const call of rawOpens) {
      assert.doesNotMatch(
        call,
        /productUrl|affiliateUrl|purchaseUrl|option\./,
        `${relativePath} opens provider metadata without the safety layer: ${call}`,
      );
    }

    assert.match(
      source,
      /openPersistedCommerceUrl\(/,
      `${relativePath} must open destinations through the centralized opener`,
    );
  }
});
