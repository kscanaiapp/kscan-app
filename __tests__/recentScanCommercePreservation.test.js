// RECENT SCANS COMMERCE PRESERVATION (Build 25 Phase 2 gate).
//
// Recent Scans are the authoritative commerce-bearing record. The Closet is
// owned inventory and carries ZERO commerce. Phase 2 changed Closet intake,
// thumbnail derivation, scan-result UI and Closet state hydration, and none of
// those may weaken that contract.
//
// What is proven here, against the real stores over an in-memory filesystem:
//
//   - a saved scan keeps its retailer, price, currency and destination URL, and
//     still has them after a COLD RELOAD (a fresh module instance re-reading the
//     same bytes — the app-restart path, not a warm in-memory cache);
//   - promotion is NON-DESTRUCTIVE: the source scan and its commerce survive it;
//   - the Closet item created by promotion contains no commerce field at all;
//   - a direct Closet intake creates no Recent Scan and no commerce;
//   - editing or deleting the Closet item never touches the source scan.
//
// NOT in scope: BUG-02 destination quality. These assert the record is
// PRESERVED, never that a URL is a good one.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that literal
// suffix, so a `.test.ts` file would never run in certification.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const LIBRARY_MANIFEST = '/doc/kscan_library/kscan_library.json';

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

/** A disk that survives a module reload, which is what makes cold reload real. */
function createDisk() {
  const files = new Map();
  return {
    files,
    api: {
      documentDirectory: '/doc/',
      EncodingType: { UTF8: 'utf8', Base64: 'base64' },
      async makeDirectoryAsync() {},
      async getInfoAsync(p) {
        if (!files.has(p)) return { exists: false };
        return {
          exists: true,
          size: Buffer.from(String(files.get(p)), 'utf8').length,
          modificationTime: 0,
        };
      },
      async readAsStringAsync(p) {
        if (!files.has(p)) throw new Error('ENOENT');
        return files.get(p);
      },
      async writeAsStringAsync(p, c) {
        files.set(p, c);
      },
      async moveAsync({ from, to }) {
        if (!files.has(from)) throw new Error('ENOENT');
        files.set(to, files.get(from));
        files.delete(from);
      },
      async copyAsync({ from, to }) {
        files.set(to, files.get(from));
      },
      async deleteAsync(p) {
        files.delete(p);
      },
      async readDirectoryAsync() {
        return [];
      },
      async getFreeDiskStorageAsync() {
        return 10 * 1024 * 1024 * 1024;
      },
    },
  };
}

/** Records every network-ish call so "no commerce request ran" is provable. */
function createProviderSpy() {
  const calls = [];
  return {
    calls,
    saveScanToCloud: async (...args) => {
      calls.push({ kind: 'saveScanToCloud', args });
      return null;
    },
    softDeleteCloudSavedScan: async (...args) => {
      calls.push({ kind: 'softDeleteCloudSavedScan', args });
      return null;
    },
  };
}

/**
 * Boot the stores over a given disk. Calling this twice on the SAME disk is a
 * cold reload: new module instances, no retained state, same bytes.
 */
function boot(disk, spy = createProviderSpy()) {
  let derivative = 0;
  const imageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri, actions) => {
      const out = `/cache/derivative-${++derivative}.jpg`;
      disk.files.set(out, Buffer.from(`derived(${uri})`).toString('base64'));
      return { uri: out };
    },
  };
  const actorContext = runModule('services/actorContext.js', () => ({}));
  // PLATFORM DIVERGENCE, deliberate: the Android line normalizes purchase
  // options in services/purchaseOptions.ts, the iOS line in
  // services/dressingRoomCommerce.ts. Resolve whichever this worktree ships so
  // the same contract is proven on both.
  const commerceModule = fs.existsSync(path.join(ROOT, 'services/purchaseOptions.ts'))
    ? 'services/purchaseOptions.ts'
    : 'services/dressingRoomCommerce.ts';
  const purchaseOptions = runModule(commerceModule, () => ({}));
  // The REAL hydrator. It returns { records, corruptedCount } and isolates each
  // record, and a stub returning a bare array silently empties the history.
  const identificationSnapshot = runModule('services/identificationSnapshot.ts', () => ({}));

  const shim = (spec) => {
    if (spec === 'expo-file-system/legacy') return disk.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === 'react-native') return { Platform: { OS: 'android' } };
    if (spec === './actorContext') return actorContext;
    if (spec === './savedScansCloud') return spy;
    if (spec === './purchaseOptions' || spec === './dressingRoomCommerce') return purchaseOptions;
    if (spec === './identificationSnapshot') return identificationSnapshot;
    return {};
  };

  const library = runModule('services/library.js', shim);
  const closetLibrary = runModule('services/closetLibrary.js', (spec) =>
    spec === './library' ? library : shim(spec),
  );
  const closetPromotion = runModule('services/closetPromotion.js', (spec) => {
    if (spec === './closetLibrary') return closetLibrary;
    return shim(spec);
  });

  return { library, closetLibrary, closetPromotion, actorContext, spy };
}

/**
 * One real commerce option, in the shape services/purchaseOptions.ts actually
 * normalizes — the destination lives on productUrl/purchaseUrl, not `url`.
 */
const DESTINATION = 'https://example-retailer.test/products/navy-wool-bomber';

function purchaseOption() {
  return {
    id: 'po_1',
    title: 'Navy Wool Bomber',
    retailer: 'Example Retailer',
    price: '189.00',
    currency: 'USD',
    priceLabel: '$189.00',
    productUrl: DESTINATION,
    purchaseUrl: DESTINATION,
    imageUrl: 'https://example-retailer.test/img/navy.jpg',
  };
}

/** The retailer destination, whichever key this platform canonicalizes it to. */
function destinationOf(option) {
  return option?.productUrl ?? option?.purchaseUrl ?? option?.url ?? null;
}

async function saveScanWithCommerce(env, disk) {
  disk.files.set('/picked/scan.jpg', Buffer.from('scan').toString('base64'));
  env.actorContext.advanceActorEpoch('user-a');
  const scan = await env.library.saveScan({
    photoUri: '/picked/scan.jpg',
    analysis: {
      result: 'A navy wool bomber jacket.',
      metadata: { category: 'Outerwear', color: 'Navy', silhouette: 'Bomber' },
      products: [],
      purchaseOptions: [purchaseOption()],
    },
    source: 'camera',
    actorRequest: env.actorContext.createActorRequest(),
    ownerId: 'user-a',
  });
  assert.ok(scan, 'the scan saved');
  return scan;
}

const COMMERCE_KEYS = [
  'purchaseOptions',
  'products',
  'retailer',
  'price',
  'currency',
  'url',
  'affiliateUrl',
  'merchantUrl',
  'sku',
  'availability',
];

/** Deep search for any commerce-shaped key or an http(s) URL value. */
function findCommerce(value, trail = '$') {
  const hits = [];
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) hits.push(`${trail} = ${value}`);
    return hits;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => hits.push(...findCommerce(entry, `${trail}[${i}]`)));
    return hits;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (COMMERCE_KEYS.includes(key)) hits.push(`${trail}.${key}`);
    hits.push(...findCommerce(entry, `${trail}.${key}`));
  }
  return hits;
}

// ── The record survives, including across a cold reload ──────────────────────

test('a saved scan keeps retailer, price, currency and destination URL', async () => {
  const disk = createDisk();
  const env = boot(disk);
  const scan = await saveScanWithCommerce(env, disk);

  assert.equal(scan.purchaseOptions.length, 1);
  const [option] = scan.purchaseOptions;
  assert.equal(option.retailer, 'Example Retailer');
  assert.equal(option.price, '189.00');
  assert.equal(option.currency, 'USD');
  // PLATFORM DIVERGENCE, deliberate: the Android line keeps productUrl and
  // purchaseUrl as supplied; the iOS canonicalizer collapses them into a single
  // productUrl. What must be equivalent is that the DESTINATION survives, not
  // which key carries it.
  assert.equal(destinationOf(option), DESTINATION);
  assert.match(destinationOf(option), /^https:\/\//, 'the destination must remain an HTTPS URL');
});

test('commerce survives a COLD RELOAD, not just a warm read', async () => {
  const disk = createDisk();
  await saveScanWithCommerce(boot(disk), disk);

  // Fresh module instances over the same bytes: the app-restart path.
  const reloaded = boot(disk);
  const scans = await reloaded.library.loadLibrary('user-a');
  assert.equal(scans.length, 1, 'the scan is still there after a restart');

  const [option] = scans[0].purchaseOptions;
  assert.equal(option.retailer, 'Example Retailer');
  assert.equal(option.price, '189.00');
  assert.equal(option.currency, 'USD');
  assert.equal(destinationOf(option), DESTINATION);
});

test('the reopened scan carries full commerce, not a lightweight list projection', async () => {
  const disk = createDisk();
  await saveScanWithCommerce(boot(disk), disk);
  const [scan] = await boot(disk).library.loadLibrary('user-a');

  // A detail view that only got id/title/thumbnail would render no commerce.
  for (const field of ['retailer', 'price', 'currency']) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(scan.purchaseOptions[0], field),
      `${field} must survive into the reopened record`,
    );
  }
  assert.equal(destinationOf(scan.purchaseOptions[0]), DESTINATION);
});

// ── Promotion is non-destructive and commerce-free ───────────────────────────

test('promotion leaves the source Recent Scan and its commerce untouched', async () => {
  const disk = createDisk();
  const env = boot(disk);
  const scan = await saveScanWithCommerce(env, disk);
  const before = JSON.stringify(scan.purchaseOptions);

  const promoted = await env.closetPromotion.promoteScanToCloset({
    scan,
    actorRequest: env.actorContext.createActorRequest(),
    ownerId: 'user-a',
  });
  assert.equal(promoted.ok, true, 'promotion succeeded');

  const scans = await env.library.loadLibrary('user-a');
  assert.equal(scans.length, 1, 'the source Recent Scan is still present');
  assert.equal(
    JSON.stringify(scans[0].purchaseOptions),
    before,
    'promotion must not alter the source commerce',
  );
});

test('the promoted Closet item contains NO commerce of any kind', async () => {
  const disk = createDisk();
  const env = boot(disk);
  const scan = await saveScanWithCommerce(env, disk);

  const promoted = await env.closetPromotion.promoteScanToCloset({
    scan,
    actorRequest: env.actorContext.createActorRequest(),
    ownerId: 'user-a',
  });

  const hits = findCommerce(promoted.item);
  assert.deepEqual(hits, [], `the Closet item leaked commerce: ${hits.join(', ')}`);
});

test('the persisted Closet manifest holds no commerce either', async () => {
  const disk = createDisk();
  const env = boot(disk);
  const scan = await saveScanWithCommerce(env, disk);
  await env.closetPromotion.promoteScanToCloset({
    scan,
    actorRequest: env.actorContext.createActorRequest(),
    ownerId: 'user-a',
  });

  // Serialization is the boundary that actually ships. A field dropped from the
  // projection but written to disk is still a leak.
  const raw = disk.files.get('/doc/kscan_closet/kscan_closet.json');
  const hits = findCommerce(JSON.parse(raw));
  assert.deepEqual(hits, [], `the Closet manifest leaked commerce: ${hits.join(', ')}`);
});

test('promotion runs no commerce request', async () => {
  const disk = createDisk();
  const env = boot(disk);
  const scan = await saveScanWithCommerce(env, disk);
  env.spy.calls.length = 0;

  await env.closetPromotion.promoteScanToCloset({
    scan,
    actorRequest: env.actorContext.createActorRequest(),
    ownerId: 'user-a',
  });

  assert.deepEqual(env.spy.calls, [], 'promoting an owned item must not call out anywhere');
});

test('deleting the Closet copy leaves the source scan commerce intact', async () => {
  const disk = createDisk();
  const env = boot(disk);
  const scan = await saveScanWithCommerce(env, disk);
  const before = JSON.stringify(scan.purchaseOptions);

  const promoted = await env.closetPromotion.promoteScanToCloset({
    scan,
    actorRequest: env.actorContext.createActorRequest(),
    ownerId: 'user-a',
  });
  await env.closetLibrary.deleteClosetItem(promoted.item.id, { ownerId: 'user-a' });

  const scans = await env.library.loadLibrary('user-a');
  assert.equal(scans.length, 1, 'deleting an owned item must not delete the scan');
  assert.equal(JSON.stringify(scans[0].purchaseOptions), before);
});

// ── Direct Closet intake bypasses commerce entirely ──────────────────────────

test('a direct Closet intake creates no Recent Scan and no commerce', async () => {
  const disk = createDisk();
  const env = boot(disk);
  disk.files.set('/picked/owned.jpg', Buffer.from('owned').toString('base64'));
  env.actorContext.advanceActorEpoch('user-a');

  const created = await env.closetLibrary.createClosetItem({
    sourceUri: '/picked/owned.jpg',
    draft: { title: 'My Own Jacket', category: 'Outerwear', origin: 'direct_intake' },
    actorRequest: env.actorContext.createActorRequest(),
    ownerId: 'user-a',
  });
  assert.equal(created.ok, true);

  assert.equal(
    disk.files.has(LIBRARY_MANIFEST),
    false,
    'Closet intake must not write a Recent Scan',
  );
  assert.deepEqual(env.spy.calls, [], 'Closet intake must not reach any provider');
  assert.deepEqual(findCommerce(created.item), []);
});

// ── Negative controls ────────────────────────────────────────────────────────

test('NEGATIVE CONTROL: a commerce-bearing Closet item is detected', async () => {
  const disk = createDisk();
  const env = boot(disk);
  const scan = await saveScanWithCommerce(env, disk);
  const promoted = await env.closetPromotion.promoteScanToCloset({
    scan,
    actorRequest: env.actorContext.createActorRequest(),
    ownerId: 'user-a',
  });

  // If promotion ever copied the commerce across, this is what it would look
  // like — and the detector must catch every shape of it.
  const leaked = { ...promoted.item, purchaseOptions: [purchaseOption()] };
  const hits = findCommerce(leaked);
  assert.ok(hits.includes('$.purchaseOptions'), 'the commerce key must be caught');
  assert.ok(
    hits.some((h) => h.includes('example-retailer.test')),
    'the retailer URL must be caught even under a renamed key',
  );

  // A bare retailer URL smuggled onto an innocuous field is caught too.
  assert.ok(findCommerce({ ...promoted.item, notes: 'https://example-retailer.test/x' }).length > 0);
});

test('NEGATIVE CONTROL: a promotion that emptied the source would be detected', async () => {
  const disk = createDisk();
  const env = boot(disk);
  const scan = await saveScanWithCommerce(env, disk);
  const before = JSON.stringify(scan.purchaseOptions);

  // Simulate the destructive variant: rewrite the manifest with commerce
  // stripped, exactly as a promotion that "moved" rather than copied would.
  const raw = JSON.parse(disk.files.get(LIBRARY_MANIFEST));
  raw[0].purchaseOptions = [];
  disk.files.set(LIBRARY_MANIFEST, JSON.stringify(raw));

  const scans = await boot(disk).library.loadLibrary('user-a');
  assert.notEqual(
    JSON.stringify(scans[0].purchaseOptions),
    before,
    'the assertion used by the preservation tests must detect a stripped source',
  );
});

test('NEGATIVE CONTROL: a lost destination URL after reload would be detected', async () => {
  const disk = createDisk();
  await saveScanWithCommerce(boot(disk), disk);

  const raw = JSON.parse(disk.files.get(LIBRARY_MANIFEST));
  delete raw[0].purchaseOptions[0].productUrl;
  delete raw[0].purchaseOptions[0].purchaseUrl;
  disk.files.set(LIBRARY_MANIFEST, JSON.stringify(raw));

  const scans = await boot(disk).library.loadLibrary('user-a');
  const option = scans[0].purchaseOptions[0];
  assert.notEqual(
    destinationOf(option),
    DESTINATION,
    'a dropped merchant URL must not read as preserved',
  );
});
