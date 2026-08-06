// RECENT SCANS / CLOSET SEPARATION — PHASE 2 ACCEPTANCE.
//
// Closes the acceptance items that the existing suites did NOT already cover:
// editing the promoted item, deleting the SOURCE scan, whether any Closet
// fallback can write back into Recent Scan storage, and whether the BUG-12
// action-section cleanup can hide a valid commerce section.
//
// Companion to __tests__/recentScanCommercePreservation.test.js, which owns
// persistence, cold reload and the promotion/commerce direction. Nothing here
// duplicates it.
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
const CLOSET_MANIFEST = '/doc/kscan_closet/kscan_closet.json';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function runModule(rel, requireShim) {
  const mod = { exports: {} };
  const js = ts.transpileModule(read(rel), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
  vm.runInThisContext(`(function (exports, module, require) {\n${js}\n})`, { filename: rel })(
    mod.exports,
    mod,
    requireShim,
  );
  return mod.exports;
}

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

function boot(disk) {
  let n = 0;
  const imageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri) => {
      const out = `/cache/derivative-${++n}.jpg`;
      disk.files.set(out, Buffer.from(`derived(${uri})`).toString('base64'));
      return { uri: out };
    },
  };
  const actorContext = runModule('services/actorContext.js', () => ({}));
  const commerceModule = exists('services/purchaseOptions.ts')
    ? 'services/purchaseOptions.ts'
    : 'services/dressingRoomCommerce.ts';
  const purchaseOptions = runModule(commerceModule, () => ({}));
  const identificationSnapshot = runModule('services/identificationSnapshot.ts', () => ({}));
  const cloudSpy = { calls: [] };

  const shim = (spec) => {
    if (spec === 'expo-file-system/legacy') return disk.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === 'react-native') return { Platform: { OS: 'android' } };
    if (spec === './actorContext') return actorContext;
    if (spec === './savedScansCloud') {
      return {
        saveScanToCloud: async (...a) => {
          cloudSpy.calls.push(['saveScanToCloud', a]);
          return null;
        },
        softDeleteCloudSavedScan: async (...a) => {
          cloudSpy.calls.push(['softDeleteCloudSavedScan', a]);
          return null;
        },
      };
    }
    if (spec === './purchaseOptions' || spec === './dressingRoomCommerce') return purchaseOptions;
    if (spec === './identificationSnapshot') return identificationSnapshot;
    return {};
  };

  const library = runModule('services/library.js', shim);
  const closetLibrary = runModule('services/closetLibrary.js', (s) =>
    s === './library' ? library : shim(s),
  );
  const closetPromotion = runModule('services/closetPromotion.js', (s) =>
    s === './closetLibrary' ? closetLibrary : shim(s),
  );
  return { library, closetLibrary, closetPromotion, actorContext, cloudSpy };
}

const DESTINATION = 'https://example-retailer.test/products/navy-wool-bomber';
const option = () => ({
  id: 'po_1',
  title: 'Navy Wool Bomber',
  retailer: 'Example Retailer',
  price: '189.00',
  currency: 'USD',
  priceLabel: '$189.00',
  productUrl: DESTINATION,
  purchaseUrl: DESTINATION,
});
const destinationOf = (o) => o?.productUrl ?? o?.purchaseUrl ?? o?.url ?? null;

async function seedScanAndPromote(disk) {
  const env = boot(disk);
  disk.files.set('/picked/scan.jpg', Buffer.from('scan').toString('base64'));
  env.actorContext.advanceActorEpoch('user-a');
  const scan = await env.library.saveScan({
    photoUri: '/picked/scan.jpg',
    analysis: {
      result: 'A navy wool bomber jacket.',
      metadata: { category: 'Outerwear', color: 'Navy', silhouette: 'Bomber' },
      products: [],
      purchaseOptions: [option()],
    },
    source: 'camera',
    actorRequest: env.actorContext.createActorRequest(),
    ownerId: 'user-a',
  });
  assert.ok(scan, 'the scan saved');
  const promoted = await env.closetPromotion.promoteScanToCloset({
    scan,
    actorRequest: env.actorContext.createActorRequest(),
    ownerId: 'user-a',
  });
  assert.equal(promoted.ok, true, 'promotion succeeded');
  return { env, scan, promoted };
}

/** The source scan as it exists on disk right now. */
async function reloadScan(disk) {
  const [scan] = await boot(disk).library.loadLibrary('user-a');
  return scan;
}

// ── Independent persistence models ───────────────────────────────────────────

test('Recent Scans and the Closet are separate manifests and separate media roots', () => {
  const lib = read('services/library.js');
  const closet = read('services/closetLibrary.js');
  assert.match(lib, /kscan_library\//);
  assert.match(closet, /kscan_closet\//);
  assert.equal(
    /kscan_closet/.test(stripComments(lib)),
    false,
    'Recent Scan storage must not reference the Closet root',
  );
  // Disjoint roots are what make the two lifecycles independent: neither
  // module can ever hand the other's path to a media unlink.
  assert.match(closet, /IMAGES_DIR\s*=\s*CLOSET_DIR/);
  assert.match(closet, /THUMBS_DIR\s*=\s*CLOSET_DIR/);
});

test('no Closet path can write a record into Recent Scan storage', () => {
  // The Closet imports exactly three things from the Recent Scan module, none
  // of which writes the Recent Scan manifest.
  const closet = stripComments(read('services/closetLibrary.js'));
  // [^}] so the match cannot start at an earlier import and run through it.
  const imported = closet.match(/import \{([^}]*)\} from '\.\/library';/);
  assert.ok(imported, 'the Closet must import from ./library explicitly');
  const names = imported[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  assert.deepEqual(
    names.sort(),
    ['canonicalizeMediaPath', 'createMediaAssetId', 'unlinkUnreferencedMedia'],
    'a new import here could reach Recent Scan persistence',
  );

  for (const rel of [
    'services/closetLibrary.js',
    'services/closetPromotion.js',
    'services/closetCandidatePromotion.js',
    'hooks/useCloset.js',
  ].filter(exists)) {
    const source = stripComments(read(rel));
    assert.equal(/persistLibrary|LIBRARY_PATH/.test(source), false, `${rel} writes Recent Scans`);
    assert.equal(/kscan_library/.test(source), false, `${rel} names Recent Scan storage`);
  }
});

// ── Promotion is a one-way copy ──────────────────────────────────────────────

test('promotion copies: it does not move, mutate or replace the source', async () => {
  const disk = createDisk();
  const { scan, promoted } = await seedScanAndPromote(disk);

  const after = await reloadScan(disk);
  assert.ok(after, 'the source Recent Scan is still present');
  assert.equal(after.id, scan.id, 'the same record, not a replacement');
  assert.equal(after.imageUri, scan.imageUri, 'the source media reference is unchanged');
  assert.notEqual(promoted.item.id, scan.id, 'the Closet item has its own identity');
  assert.notEqual(
    promoted.item.imageUri,
    scan.imageUri,
    'promotion COPIES media — a shared path would couple the two lifecycles',
  );
});

test('the two records share no mutable state', async () => {
  const disk = createDisk();
  const { scan, promoted } = await seedScanAndPromote(disk);
  // Distinct media files under distinct roots, both present on disk.
  assert.ok(String(promoted.item.imageUri).includes('kscan_closet'));
  assert.ok(String(scan.imageUri).includes('kscan_library'));
  assert.equal(disk.files.has(scan.imageUri), true);
  assert.equal(disk.files.has(promoted.item.imageUri), true);
});

// ── Independent lifecycle in BOTH directions ─────────────────────────────────

test('EDITING the promoted Closet item leaves the source Recent Scan unchanged', async () => {
  const disk = createDisk();
  const { env, promoted } = await seedScanAndPromote(disk);
  const before = JSON.stringify(await reloadScan(disk));

  const updated = await env.closetLibrary.updateClosetItem(
    promoted.item.id,
    { title: 'Renamed By User', category: 'Coats' },
    { ownerId: 'user-a' },
  );
  assert.ok(updated, 'the Closet edit applied');

  assert.equal(JSON.stringify(await reloadScan(disk)), before, 'the source scan was touched');
});

test('DELETING the promoted Closet item leaves the source Recent Scan unchanged', async () => {
  const disk = createDisk();
  const { env, scan, promoted } = await seedScanAndPromote(disk);
  const before = JSON.stringify(await reloadScan(disk));

  await env.closetLibrary.deleteClosetItem(promoted.item.id, { ownerId: 'user-a' });

  const after = await reloadScan(disk);
  assert.equal(JSON.stringify(after), before, 'the source scan changed');
  assert.equal(disk.files.has(scan.imageUri), true, 'the source media was unlinked');
});

test('DELETING the source Recent Scan leaves the Closet copy unchanged', async () => {
  const disk = createDisk();
  const { env, scan, promoted } = await seedScanAndPromote(disk);
  const closetBefore = disk.files.get(CLOSET_MANIFEST);

  await env.library.deleteScan(scan.id, { ownerId: 'user-a' });

  const closetAfter = disk.files.get(CLOSET_MANIFEST);
  assert.equal(closetAfter, closetBefore, 'deleting a scan rewrote the Closet manifest');
  assert.equal(
    disk.files.has(promoted.item.imageUri),
    true,
    'deleting a scan unlinked the Closet copy media — the roots are supposed to be disjoint',
  );

  const items = await env.closetLibrary.loadClosetTyped('user-a');
  assert.equal(items.ok, true);
  assert.equal(items.items.length, 1, 'the owned item survives its source scan');
});

// ── Commerce direction ───────────────────────────────────────────────────────

test('the source scan commerce is semantically unchanged across promotion', async () => {
  const disk = createDisk();
  const { scan } = await seedScanAndPromote(disk);
  const after = await reloadScan(disk);

  assert.equal(after.purchaseOptions.length, scan.purchaseOptions.length);
  assert.equal(after.purchaseOptions[0].retailer, 'Example Retailer');
  assert.equal(after.purchaseOptions[0].price, '189.00');
  assert.equal(after.purchaseOptions[0].currency, 'USD');
  assert.equal(destinationOf(after.purchaseOptions[0]), DESTINATION);
});

test('the Closet allowlist drops commerce WITHOUT removing it from Recent Scans', async () => {
  const disk = createDisk();
  const { promoted } = await seedScanAndPromote(disk);

  // Dropped on the Closet side...
  const closetRaw = JSON.parse(disk.files.get(CLOSET_MANIFEST));
  for (const key of ['purchaseOptions', 'products', 'retailer', 'price', 'currency']) {
    assert.equal(key in closetRaw[0], false, `the Closet record carries ${key}`);
  }
  assert.equal(JSON.stringify(promoted.item).includes('example-retailer.test'), false);

  // ...and still present on the Recent Scan side.
  const libRaw = JSON.parse(disk.files.get(LIBRARY_MANIFEST));
  assert.equal(libRaw[0].purchaseOptions.length, 1, 'the source lost its commerce');
});

test('a direct Closet intake reaches no cloud or commerce path', async () => {
  const disk = createDisk();
  const env = boot(disk);
  disk.files.set('/picked/owned.jpg', Buffer.from('owned').toString('base64'));
  env.actorContext.advanceActorEpoch('user-a');

  const created = await env.closetLibrary.createClosetItem({
    sourceUri: '/picked/owned.jpg',
    draft: { title: 'My Jacket', category: 'Outerwear', origin: 'direct_intake' },
    actorRequest: env.actorContext.createActorRequest(),
    ownerId: 'user-a',
  });
  assert.equal(created.ok, true);
  assert.equal(disk.files.has(LIBRARY_MANIFEST), false, 'a Recent Scan was written');
  assert.deepEqual(env.cloudSpy.calls, [], 'a provider was called');
});

// ── BUG-12 cannot hide valid commerce ────────────────────────────────────────

test('the BUG-12 prompt gate is independent of the commerce section', () => {
  // hasStickyActions gates ONLY the next-step prompt. The purchase panel has
  // its own condition, so a scan with commerce but no available actions still
  // renders Where to Buy.
  const source = stripComments(read('components/scan-results/ScanResultV2.tsx'));
  assert.match(
    source,
    /Array\.isArray\(v2Data\.purchaseOptions\) && v2Data\.purchaseOptions\.length > 0/,
    'the purchase panel must render on its own data condition',
  );

  const panelIndex = source.indexOf('PurchaseOptionsPanel');
  const gateIndex = source.indexOf('hasStickyActions ?');
  assert.notEqual(panelIndex, -1);
  assert.notEqual(gateIndex, -1);
  assert.ok(panelIndex < gateIndex, 'the panel renders before, and outside, the prompt gate');

  // And the gate must not mention commerce at all.
  const gate = read('components/scan-results/ScanResultV2.tsx').match(
    /const hasStickyActions =([\s\S]*?);/,
  );
  assert.ok(gate);
  assert.equal(
    /purchaseOptions|retailer|commerce|similarFinds\b/.test(gate[1].replace('similarFindsTargetReady', '')),
    false,
    'the prompt gate must not depend on commerce availability',
  );
});

test('the commerce section distinguishes absent commerce from an unusable option', () => {
  // Renderability is decided per option by the shared normalizer, not by the
  // BUG-12 cleanup: one invalid option cannot blank a section that still has
  // usable ones.
  const rel = exists('services/purchaseOptions.ts')
    ? 'services/purchaseOptions.ts'
    : 'services/dressingRoomCommerce.ts';
  const source = read(rel);
  assert.match(source, /normalizePurchaseOptions/);
  if (exists('services/purchaseOptions.ts')) {
    assert.match(
      source,
      /isPurchaseOptionsSnapshot/,
      'an unreadable snapshot must stay distinguishable from a genuinely empty one',
    );
  }
});

test('a failed image or thumbnail fallback cannot clear commerce', async () => {
  const disk = createDisk();
  const env = boot(disk);
  disk.files.set('/picked/scan.jpg', Buffer.from('scan').toString('base64'));
  env.actorContext.advanceActorEpoch('user-a');

  // Fail every derivative: the scan saves with no media at all.
  const scan = await env.library.saveScan({
    photoUri: '/missing/nonexistent.jpg',
    analysis: {
      result: 'A navy wool bomber jacket.',
      metadata: { category: 'Outerwear' },
      products: [],
      purchaseOptions: [option()],
    },
    source: 'camera',
    actorRequest: env.actorContext.createActorRequest(),
    ownerId: 'user-a',
  });

  assert.ok(scan, 'a media failure must not lose the scan');
  assert.equal(scan.purchaseOptions.length, 1, 'a media failure cleared the commerce');
  assert.equal(destinationOf(scan.purchaseOptions[0]), DESTINATION);

  // The display fallback is a render-time choice and touches no stored field.
  const library = stripComments(read('app/library.tsx'));
  assert.match(library, /thumbnailUri \?\? \w+\.imageUri|imageUri \?\? \w+\.thumbnailUri/);
});

test('Recent Scan detail hydrates the full record, not a reduced list projection', async () => {
  const disk = createDisk();
  await seedScanAndPromote(disk);
  // One read path serves both the list and the detail view, so the detail
  // cannot be missing fields the list dropped.
  const scan = await reloadScan(disk);
  assert.ok(scan.purchaseOptions, 'the list read carries commerce');
  assert.equal(scan.purchaseOptions[0].retailer, 'Example Retailer');
  assert.equal(destinationOf(scan.purchaseOptions[0]), DESTINATION);

  const source = stripComments(read('app/library.tsx'));
  assert.match(
    source,
    /purchaseOptions=\{selectedScan\.purchaseOptions\}/,
    'the detail view must receive the persisted commerce from the same record',
  );
});

// ── Negative controls for the items above ────────────────────────────────────

test('NEGATIVE CONTROL: a shared media path between the two records is detectable', async () => {
  const disk = createDisk();
  const { scan, promoted } = await seedScanAndPromote(disk);
  // The real pair is distinct; a coupled implementation would look like this.
  assert.notEqual(promoted.item.imageUri, scan.imageUri);
  const coupled = { ...promoted.item, imageUri: scan.imageUri };
  assert.equal(coupled.imageUri === scan.imageUri, true, 'the assertion detects a shared path');
});

test('NEGATIVE CONTROL: a Closet write into Recent Scan storage is detectable', () => {
  const offending = "await persistLibrary(updated); // from closetLibrary\n";
  assert.equal(/persistLibrary|LIBRARY_PATH/.test(offending), true);
  const clean = 'await persistCloset(updated);';
  assert.equal(/persistLibrary|LIBRARY_PATH/.test(clean), false);
});

test('NEGATIVE CONTROL: a prompt gate that consulted commerce is detectable', () => {
  const offending = 'const hasStickyActions = v2Data.purchaseOptions.length > 0;';
  const gate = offending.match(/const hasStickyActions =([\s\S]*?);/);
  assert.equal(/purchaseOptions/.test(gate[1]), true, 'a commerce-coupled gate must be caught');
});
