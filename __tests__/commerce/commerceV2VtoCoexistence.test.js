/**
 * Commerce V2 × VTO V2 coexistence (post-#411 rebase).
 *
 * WHY THIS FILE EXISTS. The two lanes never touch the same file — and they
 * still meet, in exactly one place. Commerce V2's chat shelf renders through
 * `ProductShelf`, and #411 gave `ProductShelf` a Try It On entry built from
 * every card it renders. So the moment both lanes are on one branch, the
 * products shelf memory selects become try-on candidates, without either lane
 * having written a line about the other.
 *
 * That seam is invisible to both lanes' own suites: Commerce V2's tests stop
 * at the block, and VTO's tests feed it scan products. A rebase that quietly
 * broke it would be green on both sides. This file feeds REAL Commerce V2
 * output — including the shelves that "different", "another" and "go back"
 * produce — into #411's real garment mapper.
 *
 * It asserts REACH and IDENTITY, not styling, and is modelled on
 * `__tests__/vtoShippedSurfaceReach.test.js`, whose module loader it reuses.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadTsModule(relativePath, requireMap = {}) {
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
    __DEV__: false, console, Date, Intl, URL, URLSearchParams,
    exports: mod.exports, module: mod,
    require: (specifier) => {
      if (specifier in requireMap) return requireMap[specifier];
      throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

const commerceDestination = loadTsModule('services/commerceDestination.ts', {});
const dressingRoomCommerce = loadTsModule('services/dressingRoomCommerce.ts', {});
const { buildVtoGarmentFromCommerceRecord } = loadTsModule('services/vto/vtoCommerceGarment.ts', {
  '../commerceDestination': commerceDestination,
  '../dressingRoomCommerce': dressingRoomCommerce,
  '../../types/vto': {},
});

const h = require(path.join(ROOT, 'tools/commerce-v2/v2Journey.js'));

test('every product a Commerce V2 shelf renders is reachable by Try It On', async () => {
  const c = h.conversation();
  const t1 = await c.say('Find black loafers for these trousers under $150.', {
    category: 'loafers', color: 'black', budgetAmount: 150, budgetCurrency: 'USD',
  });
  assert.ok(t1.productDetail.length > 0, 'the shelf has products at all');

  for (const product of t1.productDetail) {
    const garment = buildVtoGarmentFromCommerceRecord(product);
    assert.ok(garment, `no VTO garment for ${product.title}`);
    assert.equal(garment.imageUrl, product.imageUrl, 'the try-on uses THIS card\'s image');
  }
});

test('the shelves shelf memory produces are try-on candidates too', async () => {
  const c = h.conversation();
  const first = await c.say('Show me black loafers under $150.', {
    category: 'loafers', color: 'black', budgetAmount: 150, budgetCurrency: 'USD',
  });

  // "Different" replaces the products entirely. The replacements must carry
  // the try-on just as the originals did — a shelf assembled from retained
  // candidates is not a lesser shelf.
  const different = await c.say('Show me different ones.');
  assert.ok(different.productDetail.length > 0);
  for (const product of different.productDetail) {
    assert.ok(buildVtoGarmentFromCommerceRecord(product), `no garment after "different": ${product.title}`);
  }

  // "Another" returns a single unseen candidate.
  const another = await c.say('Another.');
  for (const product of another.productDetail) {
    assert.ok(buildVtoGarmentFromCommerceRecord(product), `no garment after "another": ${product.title}`);
  }

  // A RESTORED product is the interesting one: its commercial facts may have
  // been stripped as unverifiable, and the try-on must still identify it,
  // because identity is what was restored and price is what was not.
  const restored = await c.say('Go back to the first one.');
  const product = restored.productDetail[0];
  assert.ok(product, 'the reference resolved');
  const garment = buildVtoGarmentFromCommerceRecord(product);
  assert.ok(garment, 'a restored product is still a try-on candidate');
  assert.equal(
    garment.imageUrl,
    first.productDetail[0].imageUrl,
    'and it is the garment from the shelf they referred to',
  );
});

test('neither lane reaches into the other', () => {
  // Commerce V2 owns conversational shelf state; VTO V2 owns the try-on. The
  // seam between them is ProductShelf, and it stays one-directional.
  for (const file of [
    'services/style-chat/commerceShelfMemory.ts',
    'services/commerce/productIdentity.ts',
    'services/style-chat/commerceActivation.ts',
    'supabase/functions/stylechat-generate/eliseCommerceIntent.ts',
  ]) {
    const source = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.equal(/\bvto\b|VirtualTryOn|TryItOn|vtoMode/i.test(source), false,
      `${file} must not reach into VTO`);
  }

  for (const file of ['services/vto/vtoModeAuthority.ts', 'services/vto/vtoEntryContract.ts']) {
    const source = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.equal(/shelfMemory|commerceShelfMemory|productShelfIdentity|candidateUniverse/.test(source), false,
      `${file} must not reach into Commerce V2 shelf memory`);
  }
});

test('#411\'s ProductShelf and PurchaseOptionsPanel VTO wiring survived the rebase', () => {
  const shelf = read('components/ProductShelf.tsx');
  assert.match(shelf, /import \{ TryItOnEntry \} from '\.\/vto\/TryItOnEntry'/);
  assert.match(shelf, /<TryItOnEntry/, 'the shelf still renders the entry');
  assert.match(shelf, /onWatch=\{canWatch \? \(\) => setWatchModalProduct\(p\) : undefined\}/,
    '#411 wired Watch through to the try-on result');

  const panel = read('components/scan-results/PurchaseOptionsPanel.tsx');
  assert.match(panel, /import \{ TryItOnEntry \} from '\.\.\/vto\/TryItOnEntry'/);
  assert.match(panel, /<TryItOnEntry/, 'the shipped scan surface still renders the entry');
  assert.match(panel, /onWatch=/, 'with its Watch action intact');
});
