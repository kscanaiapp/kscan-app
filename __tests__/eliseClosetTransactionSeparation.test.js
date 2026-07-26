// ELISE / CLOSET TRANSACTION SEPARATION — required release gate.
//
// Elise (StyleChat) attachment, Recent Scan persistence, and Closet item
// creation are three DISTINCT top-level transactions. They may share low-level
// utilities (image picking, URI normalization, actor requests, media ids,
// collision handling, file copying, reference-aware cleanup) but Elise must
// never be routed through the Closet persistence orchestrator, and a Closet
// write must never produce an Elise attachment or a Recent Scan.
//
// Elise DOES create a Recent Scan today — that is existing, accepted behavior
// ("SAVE TO CLOSET & ATTACH" writes a saved_scan). This suite pins that it
// keeps doing exactly that and gains no Closet side effect.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const CLOSET_ORCHESTRATOR_MODULES = [
  'closetLibrary',
  'closetPromotion',
  'useCloset',
];

function readIfExists(rel) {
  const full = path.join(ROOT, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

function listFiles(dir, predicate) {
  const out = [];
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return out;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(rel, predicate));
    else if (predicate(entry.name)) out.push(rel);
  }
  return out;
}

// ── Structural separation ────────────────────────────────────────────────────

test('ELISE-DOES-NOT-IMPORT-CLOSET-ORCHESTRATOR', () => {
  const eliseFiles = [
    ...listFiles('components/style-chat', (n) => /\.(ts|tsx|js|jsx)$/.test(n)),
    ...listFiles('services/style-chat', (n) => /\.(ts|tsx|js|jsx)$/.test(n)),
    ...listFiles('app/style-chat', (n) => /\.(ts|tsx|js|jsx)$/.test(n)),
  ].filter((f) => !/\.test\.[jt]sx?$/.test(f));

  assert.ok(eliseFiles.length > 0, 'precondition: Elise source files located');

  for (const file of eliseFiles) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const orchestrator of CLOSET_ORCHESTRATOR_MODULES) {
      assert.ok(
        !new RegExp(`from\\s+['"][^'"]*${orchestrator}['"]`).test(source) &&
          !new RegExp(`require\\(['"][^'"]*${orchestrator}['"]\\)`).test(source),
        `${file} must not route Elise through the Closet orchestrator (${orchestrator})`
      );
    }
  }
});

test('CLOSET-DOES-NOT-IMPORT-ELISE-ORCHESTRATOR', () => {
  for (const rel of ['services/closetLibrary.js', 'services/closetPromotion.js', 'hooks/useCloset.js']) {
    const source = readIfExists(rel);
    assert.ok(source, `${rel} must exist`);
    assert.ok(
      !/style-chat|styleChat|stylechat/i.test(source),
      `${rel} must not depend on Elise/StyleChat`
    );
    assert.ok(
      !/scanIdentification|scan-identify/i.test(source),
      `${rel} must not invoke the Scanner identification pipeline`
    );
  }
});

/** Strip comments so a doc-comment describing what the file does NOT do is
 *  never mistaken for an actual call site. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('CLOSET-INTAKE-DOES-NOT-CALL-SCAN-IDENTIFY-OR-COMMERCE', () => {
  const raw = readIfExists('components/closet/ClosetIntakeModal.tsx');
  assert.ok(raw, 'Closet intake modal must exist');
  const source = stripComments(raw);
  for (const forbidden of [
    'identifyScanImage',
    'scan-identify',
    'purchaseOptions',
    'ProductShelf',
    'secondhand',
    'saveScan',
    'saveScanToCloud',
  ]) {
    assert.ok(
      !new RegExp(forbidden, 'i').test(source),
      `Closet intake must not reference "${forbidden}"`
    );
  }
});

// ── Behavioral separation ────────────────────────────────────────────────────

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

function memfs() {
  const files = new Map();
  return {
    files,
    api: {
      documentDirectory: '/doc/',
      EncodingType: { UTF8: 'utf8' },
      async makeDirectoryAsync() {},
      async getInfoAsync(p) { return { exists: files.has(p) }; },
      async readAsStringAsync(p) {
        if (!files.has(p)) throw new Error('ENOENT');
        return files.get(p);
      },
      async writeAsStringAsync(p, c) { files.set(p, c); },
      async moveAsync({ from, to }) {
        files.set(to, files.get(from) ?? `bytes(${from})`);
        files.delete(from);
      },
      async deleteAsync(p) { files.delete(p); },
    },
  };
}

function runModule(rel, requireShim) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, {
    filename: rel,
  })(mod.exports, mod, requireShim);
  return mod.exports;
}

function load() {
  const m = memfs();
  const actorContext = runModule('services/actorContext.js', () => ({}));
  const cloud = { saved: [] };
  let seq = 0;
  const imageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri) => {
      seq += 1;
      const cacheUri = `/cache/d_${seq}.jpg`;
      m.files.set(cacheUri, `derived-from:${uri}`);
      return { uri: cacheUri };
    },
  };
  const library = runModule('services/library.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === './savedScansCloud') {
      return {
        saveScanToCloud: async (s) => { cloud.saved.push(s); return { ok: true }; },
        softDeleteCloudSavedScan: async () => ({ ok: true }),
      };
    }
    if (spec === './purchaseOptions' || spec === './dressingRoomCommerce') {
      return {
        isPurchaseOptionsSnapshot: (v) => Array.isArray(v),
        normalizePurchaseOptions: (v) => (Array.isArray(v) ? v.slice() : []),
      };
    }
    if (spec === './actorContext') return actorContext;
    return {};
  });
  const closetLibrary = runModule('services/closetLibrary.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === 'react-native') return { Platform: { OS: 'android' } };
    if (spec === './actorContext') return actorContext;
    if (spec === './library') return library;
    return {};
  });
  return { library, closetLibrary, actorContext, m, cloud };
}

/** Elise's accepted attachment transaction: sanitize → identify → saveScan. */
async function eliseAttach(library, actorContext, actorId) {
  if (actorContext.getActorContext().actorId !== actorId) actorContext.advanceActorEpoch(actorId);
  return library.saveScan({
    photoUri: '/tmp/elise-pick.jpg',
    analysis: {
      result: 'Silk blouse',
      metadata: { category: 'Tops' },
      products: [],
      purchaseOptions: [],
    },
    source: 'upload',
    actorRequest: actorContext.createActorRequest(),
  });
}

test('ELISE-UPLOAD-SUCCEEDS-AND-CREATES-NO-CLOSET-ITEM', async () => {
  const { library, closetLibrary, actorContext, m } = load();

  const attached = await eliseAttach(library, actorContext, 'A');
  assert.ok(attached, 'Elise attachment must still succeed');
  assert.equal((await library.loadLibrary('A')).length, 1, 'Elise still creates its Recent Scan');

  assert.deepEqual(await closetLibrary.loadCloset('A'), [], 'Elise must not create a Closet item');
  assert.equal(
    m.files.has('/doc/kscan_closet/kscan_closet.json'),
    false,
    'Elise must not even create the Closet manifest'
  );
});

test('CLOSET-WRITE-CREATES-NO-ELISE-ATTACHMENT-OR-RECENT-SCAN', async () => {
  const { library, closetLibrary, actorContext, cloud, m } = load();
  actorContext.advanceActorEpoch('A');

  const created = await closetLibrary.createClosetItem({
    sourceUri: '/tmp/closet-pick.jpg',
    draft: { title: 'Wool coat' },
    actorRequest: actorContext.createActorRequest(),
  });

  assert.equal(created.ok, true, created.reason);
  assert.deepEqual(await library.loadLibrary('A'), [], 'no Recent Scan side effect');
  assert.equal(m.files.has('/doc/kscan_library/kscan_library.json'), false);
  assert.deepEqual(cloud.saved, [], 'no cloud saved-scan created');
});

test('STALE-ELISE-DURABLE-WRITE-REJECTED', async () => {
  const { library, actorContext } = load();
  actorContext.advanceActorEpoch('A');
  const staleRequest = actorContext.createActorRequest();
  actorContext.advanceActorEpoch('B');

  const saved = await library.saveScan({
    photoUri: '/tmp/elise-pick.jpg',
    analysis: { result: 'r', metadata: {}, products: [], purchaseOptions: [] },
    source: 'upload',
    actorRequest: staleRequest,
  });

  assert.equal(saved, null, 'a stale Elise durable write must be rejected');
  assert.deepEqual(await library.loadLibrary('A'), []);
  assert.deepEqual(await library.loadLibrary('B'), []);
});

test('CLOSET-UTILITIES-DO-NOT-BREAK-ELISE-MEDIA', async () => {
  const { library, closetLibrary, actorContext, m } = load();

  const attached = await eliseAttach(library, actorContext, 'A');
  assert.ok(attached.imageUri && m.files.has(attached.imageUri));

  // Create and then delete a Closet item; Elise's media must be untouched
  // even though both stores share the reference-aware unlink helper.
  const created = await closetLibrary.createClosetItem({
    sourceUri: '/tmp/closet-pick.jpg',
    draft: { title: 'Wool coat' },
    actorRequest: actorContext.createActorRequest(),
  });
  assert.equal(created.ok, true, created.reason);
  await closetLibrary.deleteClosetItem(created.item.id, { ownerId: 'A' });

  assert.ok(m.files.has(attached.imageUri), 'Elise/Recent Scan media must survive Closet churn');
  assert.equal((await library.loadLibrary('A')).length, 1);
});

test('NULL-CLOSET-MEDIA-IS-NOT-TREATED-AS-SUCCESS', async () => {
  const m = memfs();
  const actorContext = runModule('services/actorContext.js', () => ({}));
  // Manipulator "succeeds" but yields no usable uri — must not become an item.
  const nullManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async () => ({ uri: undefined }),
  };
  const library = runModule('services/library.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return nullManipulator;
    if (spec === './actorContext') return actorContext;
    if (spec === './savedScansCloud') {
      return { saveScanToCloud: async () => ({ ok: true }), softDeleteCloudSavedScan: async () => ({ ok: true }) };
    }
    if (spec === './purchaseOptions' || spec === './dressingRoomCommerce') {
      return { isPurchaseOptionsSnapshot: () => false, normalizePurchaseOptions: () => [] };
    }
    return {};
  });
  const closetLibrary = runModule('services/closetLibrary.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return nullManipulator;
    if (spec === 'react-native') return { Platform: { OS: 'android' } };
    if (spec === './actorContext') return actorContext;
    if (spec === './library') return library;
    return {};
  });

  actorContext.advanceActorEpoch('A');
  const result = await closetLibrary.createClosetItem({
    sourceUri: '/tmp/pick.jpg',
    draft: { title: 'Coat' },
    actorRequest: actorContext.createActorRequest(),
  });

  assert.equal(result.ok, false, 'null media must not be reported as a successful save');
  assert.deepEqual(await closetLibrary.loadCloset('A'), []);
});
