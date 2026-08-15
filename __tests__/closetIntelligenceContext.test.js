const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) {
        return requireMap[specifier];
      }
      throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

function makeHarness() {
  let current = true;
  let loadResult = { ok: true, items: [], skipped: 0 };
  const module = loadTsModule('services/style-chat/closetIntelligenceContext.ts', {
    '../actorContext': {
      createActorRequest: () => ({ actorId: 'actor', epoch: 1 }),
      isActorRequestCurrent: () => current,
    },
    '../closetItemProjection': {
      getClosetItemProjections: (items) => items,
    },
    '../closetLibrary': {
      loadClosetTyped: async () => loadResult,
    },
  });
  return {
    module,
    setCurrent(value) { current = value; },
    setLoadResult(value) { loadResult = value; },
  };
}

test('S7 client snapshot sends only bounded committed-Closet metadata and opaque refs', async () => {
  const h = makeHarness();
  h.setLoadResult({
    ok: true,
    skipped: 0,
    items: [{
      id: 'device-local-secret-id',
      ownerId: 'actor',
      title: 'Navy jacket',
      category: 'jacket',
      clothingType: 'outerwear',
      subtype: 'blazer',
      brand: 'Observed Brand',
      primaryColor: 'navy',
      secondaryColors: ['white'],
      material: ['wool'],
      imageUri: 'file:///private/image.jpg',
      deletedAt: null,
      price: 120,
      retailer: 'Never send',
      url: 'https://retailer.invalid/item',
    }],
  });
  const context = await h.module.buildClosetIntelligenceContext('actor');
  assert.equal(context.inventoryState, 'complete');
  assert.deepEqual(Object.keys(context.items[0]).sort(), [
    'brand',
    'category',
    'clothingType',
    'materials',
    'primaryColor',
    'ref',
    'secondaryColors',
    'subtype',
    'title',
  ].sort());
  assert.equal(context.items[0].ref, 'closet_1');
  assert.doesNotMatch(JSON.stringify(context), /device-local-secret-id|file:\/\/|retailer|price|url/i);
});

test('S7 client snapshot distinguishes empty, partial, unavailable, and stale actor states', async () => {
  const h = makeHarness();

  h.setLoadResult({ ok: true, items: [], skipped: 0 });
  assert.equal((await h.module.buildClosetIntelligenceContext('actor')).inventoryState, 'complete');

  h.setLoadResult({
    ok: true,
    skipped: 1,
    items: [{
      title: 'Readable item', category: 'top', clothingType: null, subtype: null,
      brand: null, primaryColor: null, secondaryColors: [], material: [],
    }],
  });
  assert.equal((await h.module.buildClosetIntelligenceContext('actor')).inventoryState, 'partial');

  h.setLoadResult({ ok: false, items: [], skipped: 0 });
  assert.equal((await h.module.buildClosetIntelligenceContext('actor')).inventoryState, 'unavailable');

  h.setLoadResult({ ok: true, items: [], skipped: 0 });
  h.setCurrent(false);
  assert.equal((await h.module.buildClosetIntelligenceContext('actor')).inventoryState, 'unavailable');
});

test('S7 committed-Closet snapshot is wired into sends while saved_scans remains Recent Scan', () => {
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
  const provider = fs.readFileSync(
    path.join(ROOT, 'services', 'style-chat', 'providers', 'edgeStyleChatProvider.ts'),
    'utf8',
  );
  const retrieval = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', 'stylechat-generate', 'eliseWardrobeRetrieval.ts'),
    'utf8',
  );
  assert.match(hook, /buildClosetIntelligenceContext\(\s*actorIdRef\.current/);
  assert.match(provider, /closetIntelligenceContext:\s*input\.closetIntelligenceContext/);
  assert.match(retrieval, /sourceType:\s*'recent_scan'/);
  assert.match(retrieval, /actorRelationship:\s*'scanned'/);
  assert.doesNotMatch(retrieval, /candidate\.actorRelationship\s*=\s*'owned'/);
  assert.doesNotMatch(retrieval, /candidate\.sourceType\s*=\s*'closet'/);
});

