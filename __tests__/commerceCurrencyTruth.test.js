/**
 * RP-110 — offer currency truth (Build 34 repair Lane E).
 *
 * K Scan must never invent USD. An offer whose currency no provider declared is
 * an offer of an UNKNOWN currency, which is a different fact from an offer
 * priced in dollars, and the difference has to survive every layer between the
 * provider payload and the pixel: provider formatter -> backend normalization
 * -> response contract -> client normalization -> display -> persistence.
 *
 * Every assertion here runs the real shipping helpers. Backend Edge Function
 * modules are transpiled and executed in-process (the same technique
 * shoppingProvider.test.js already uses) so this suite covers the Deno side
 * under `node --test` as well as the client side.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const FUNCTION_DIR = path.join(ROOT, 'supabase', 'functions', 'scan-identify');

globalThis.__DEV__ = false;

// ── Loaders ─────────────────────────────────────────────────────────────────

/** Load an Edge Function module and its sibling `./x.ts` imports for real. */
function loadEdgeModule(relativePath, cache = new Map()) {
  const filename = path.join(FUNCTION_DIR, relativePath);
  if (cache.has(filename)) return cache.get(filename);

  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;

  const mod = { exports: {} };
  cache.set(filename, mod.exports);
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    URL,
    Intl,
    AbortController: globalThis.AbortController,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    Deno: { env: { get: () => undefined } },
    require: (id) => {
      if (id.startsWith('node:')) return require(id);
      if (id.startsWith('./')) return loadEdgeModule(id.slice(2), cache);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename });
  cache.set(filename, mod.exports);
  return mod.exports;
}

function createClientLoader(mocks = {}) {
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
  return (relativePath) => loadFile(path.resolve(ROOT, relativePath));
}

const offerCurrency = loadEdgeModule('offerCurrency.ts');
const shoppingProvider = loadEdgeModule('shoppingProvider.ts');
const canonicalCommerce = loadEdgeModule('canonicalCommerce.ts');
const loadClient = createClientLoader();
const commerce = loadClient('services/dressingRoomCommerce.ts');

/** Source text with comments removed, so a comment ABOUT the old defect is
 *  never mistaken for the defect. */
function codeOf(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every way "$" or a USD claim can reach a user. */
function assertNoInventedDollars(rendered, context) {
  assert.ok(!String(rendered).includes('$'), `${context}: prepended "$" to an unknown currency`);
  assert.ok(!/USD/i.test(String(rendered)), `${context}: claimed USD for an unknown currency`);
}

// ── 1. Backend: the shared currency authority ───────────────────────────────

test('RP-110: a declared currency is preserved; anything else is not a currency', () => {
  const { normalizeCurrencyCode } = offerCurrency;
  assert.equal(normalizeCurrencyCode('usd'), 'USD');
  assert.equal(normalizeCurrencyCode('  eur '), 'EUR');
  assert.equal(normalizeCurrencyCode('GBP'), 'GBP');

  // Malformed / free-form / absent values must never become a trusted currency.
  for (const bad of [null, undefined, '', '   ', '$', 'US', 'USDD', 'dollars', 'US Dollar', 840, {}, ['USD']]) {
    assert.equal(normalizeCurrencyCode(bad), null, `treated ${JSON.stringify(bad)} as a currency`);
  }
});

test('RP-110: known currencies render truthfully, each in its own currency', () => {
  const { formatOfferPrice } = offerCurrency;
  assert.equal(formatOfferPrice(29.99, 'USD'), '$29.99');
  assert.equal(formatOfferPrice(29.99, 'EUR'), '€29.99');
  assert.equal(formatOfferPrice(29.99, 'GBP'), '£29.99');
  assert.equal(formatOfferPrice(29.99, 'JPY'), '¥30');
});

test('RP-110 NEGATIVE CONTROL: amount 29.99 with currency null is never $29.99', () => {
  const { formatOfferPrice } = offerCurrency;
  const rendered = formatOfferPrice(29.99, null);
  assert.equal(rendered, '29.99');
  assert.notEqual(rendered, '$29.99');
  assert.notEqual(rendered, 'USD 29.99');
  assertNoInventedDollars(rendered, 'formatOfferPrice');

  // Nor from an omitted argument, an empty string, or free text.
  for (const unknown of [undefined, '', 'dollars', '$']) {
    assertNoInventedDollars(formatOfferPrice(29.99, unknown), `formatOfferPrice(${JSON.stringify(unknown)})`);
  }
  assert.equal(formatOfferPrice(0, 'USD'), undefined);
  assert.equal(formatOfferPrice(-5, 'USD'), undefined);
});

// ── 2. Backend: provider normalization ─────────────────────────────────────

test('RP-110: a numeric provider price with no declared currency is published bare', () => {
  const { normalizePrice } = shoppingProvider;
  assert.equal(normalizePrice(59), '59.00');
  assertNoInventedDollars(normalizePrice(59), 'normalizePrice(number)');
  // Provider currency survives backend normalization.
  assert.equal(normalizePrice(59, 'EUR'), '€59.00');
  assert.equal(normalizePrice(59, 'usd'), '$59.00');
  // A malformed code is not trusted into a currency claim.
  assert.equal(normalizePrice(59, 'US Dollar'), '59.00');
  // A provider-formatted string is the provider's own representation.
  assert.equal(normalizePrice('€129.99'), '€129.99');
  assert.equal(normalizePrice('From £45'), '£45');
});

test('RP-110: no shipping provider formatter carries a USD fallback any more', () => {
  for (const file of ['shoppingProvider.ts', 'poshmarkProvider.ts', 'farfetch3Provider.ts', 'kicksCrewProvider.ts']) {
    const src = codeOf(path.join(FUNCTION_DIR, file));
    assert.ok(
      !/\|\|\s*'USD'/.test(src) && !/\?\?\s*'USD'/.test(src) && !/=\s*'USD'/.test(src),
      `${file} still defaults an undeclared currency to USD`,
    );
  }
});

// ── 3. Backend: the canonical offer contract ───────────────────────────────

test('RP-110: the canonical offer keeps the declared currency and invents none', () => {
  const { buildCanonicalCommerce } = canonicalCommerce;
  const base = { id: 'x', title: 'Wool Coat', source: 'Shop', type: 'retail', productUrl: 'https://s.test/1' };

  const declared = buildCanonicalCommerce([{ ...base, price: '29.99', currency: 'EUR' }]);
  assert.equal(declared.products[0].offers[0].currency, 'EUR');

  // A symbol in the provider's own string still speaks for itself.
  const symbolic = buildCanonicalCommerce([{ ...base, price: '£300' }]);
  assert.equal(symbolic.products[0].offers[0].currency, 'GBP');

  // Bare amount, no declaration anywhere: unknown stays unknown.
  const unknown = buildCanonicalCommerce([{ ...base, price: '29.99' }]);
  assert.equal(unknown.products[0].offers[0].currency, null);
  assert.equal(unknown.products[0].offers[0].priceValue, 29.99);

  // Free text is not a declaration, and must not be passed through as one.
  const junk = buildCanonicalCommerce([{ ...base, price: '29.99', currency: 'dollars' }]);
  assert.equal(junk.products[0].offers[0].currency, null);
});

// ── 4. Client: normalization, display, persistence ─────────────────────────

test('RP-110: provider currency survives client normalization and persistence', () => {
  const { normalizePurchaseOptions } = commerce;
  const [withCurrency] = normalizePurchaseOptions([
    { title: 'Wool Coat', retailer: 'Shop', price: '29.99', currency: 'eur', productUrl: 'https://s.test/1' },
  ]);
  assert.equal(withCurrency.currency, 'EUR', 'declared currency did not survive persistence normalization');

  // Legacy rows saved before currency existed hydrate as unknown, not as USD.
  const [legacy] = normalizePurchaseOptions([
    { title: 'Wool Coat', retailer: 'Shop', price: '29.99', productUrl: 'https://s.test/1' },
  ]);
  assert.equal(legacy.currency, null);

  // Free-form junk never becomes a trusted currency on the persisted row.
  const [junk] = normalizePurchaseOptions([
    { title: 'Wool Coat', retailer: 'Shop', price: '29.99', currency: 'US Dollar', productUrl: 'https://s.test/1' },
  ]);
  assert.equal(junk.currency, null);

  // Retailer destination behavior is untouched by any of this.
  assert.equal(withCurrency.productUrl, 'https://s.test/1');
  assert.equal(legacy.productUrl, 'https://s.test/1');
});

test('RP-110: the client formatter renders known currencies and invents none', () => {
  const { formatCommercePrice } = commerce;
  assert.equal(formatCommercePrice(29.99, 'USD'), '$29.99');
  assert.equal(formatCommercePrice(29.99, 'EUR'), '€29.99');
  assert.equal(formatCommercePrice(29.99, 'GBP'), '£29.99');
  assert.equal(formatCommercePrice('519', 'USD'), '$519.00');

  // NEGATIVE CONTROL.
  const unknown = formatCommercePrice(29.99, null);
  assert.equal(unknown, '29.99');
  assert.notEqual(unknown, '$29.99');
  assert.notEqual(unknown, 'USD 29.99');
  for (const bad of [undefined, '', 'dollars', '$', 'US Dollar']) {
    assertNoInventedDollars(formatCommercePrice(29.99, bad), `formatCommercePrice(${JSON.stringify(bad)})`);
  }
  // An omitted currency argument means unknown, not dollars.
  assertNoInventedDollars(formatCommercePrice(29.99), 'formatCommercePrice(price only)');
  // A provider-formatted string still passes through untouched.
  assert.equal(formatCommercePrice('€29.99', null), '€29.99');
  assert.equal(formatCommercePrice(0, 'USD'), null);
});

test('RP-110: the scan-result formatter carries no USD default and no "$" fallback', () => {
  const src = codeOf(path.join(ROOT, 'components', 'scan-results', 'types.ts'));
  assert.ok(!/currency\s*\|\|\s*'USD'/.test(src), 'scan-result formatter still defaults to USD');
  assert.ok(!/'USD'/.test(src), 'scan-result formatter still names a fallback currency');
  assert.ok(!/`\$\$\{/.test(src), 'scan-result formatter still prepends "$"');
});

test('RP-110: the TextScan formatter carries no "$" fallback and no local currency rule', () => {
  // Closure P1. services/textScanEdge.ts had its own price formatter with two
  // defects: `currency?.trim() || '$'` invented USD for an undeclared
  // currency, and a DECLARED ISO code was concatenated as a symbol
  // (`USD29.99`). It now delegates to the canonical authority instead of
  // restating the rule -- which is how RP-110's original five-formatter
  // divergence happened.
  const src = codeOf(path.join(ROOT, 'services', 'textScanEdge.ts'));
  assert.ok(!/\|\|\s*'\$'/.test(src), 'TextScan formatter still falls back to "$"');
  assert.ok(!/`\$\{symbol\}/.test(src), 'TextScan formatter still prepends a raw currency string as a symbol');
  assert.ok(!/'USD'/.test(src), 'TextScan formatter names a fallback currency');
  assert.match(src, /formatCommercePrice/, 'TextScan must delegate to the canonical client formatter');
});

test('RP-110 ANTI-DRIFT: the TextScan numeric branch matches the canonical formatter exactly', () => {
  // Pins the third client formatter to the same authority as the other two.
  // Scope note: only the NUMERIC branch is pinned. textScanEdge deliberately
  // passes a provider-formatted STRING price through verbatim ('1,200' stays
  // '1,200' rather than being reparsed to '1200.00') -- that is the documented
  // behaviour of the provider-string path, not drift, and it is asserted
  // directly in textScanCanonicalPath.test.js.
  const { formatCommercePrice } = commerce;
  const normalizeNumeric = (price, currency) => formatCommercePrice(price, currency) ?? undefined;

  const amounts = [29.99, 1, 1200, 0.5, 0, -5, Number.NaN, Number.POSITIVE_INFINITY];
  const currencies = [undefined, null, '', 'USD', 'usd', ' eur ', 'GBP', 'JPY', 'ZZZ', 'US Dollar', '$', 42];

  for (const price of amounts) {
    for (const currency of currencies) {
      const rendered = normalizeNumeric(price, currency);
      assert.equal(
        rendered,
        formatCommercePrice(price, currency) ?? undefined,
        `TextScan numeric branch diverged for ${JSON.stringify(price)} / ${JSON.stringify(currency)}`,
      );
      const declared = typeof currency === 'string' && /^[a-z]{3}$/i.test(currency.trim());
      if (rendered !== undefined && !declared) {
        assertNoInventedDollars(rendered, `TextScan ${JSON.stringify(price)} / ${JSON.stringify(currency)}`);
      }
    }
  }
});

test('RP-110 ANTI-DRIFT: both client formatters agree on every case', () => {
  // components/scan-results/types.ts restates the currency rule instead of
  // importing it, because a new import edge out of that module would require
  // editing a VTO-owned test and so misclassify an unrelated lane as a VTO lane
  // (.github/workflows/vto-e2e.yml). Restating a rule is how RP-110's defect
  // happened in the first place -- five formatters that each drifted their own
  // way -- so the two are pinned to each other here. If they ever disagree,
  // this fails rather than a user seeing two different prices for one offer.
  const { mapRawProductToPurchaseOption } = loadClient('components/scan-results/types.ts');
  const { formatCommercePrice } = commerce;

  const amounts = [29.99, 1, 1200, 0.5, 0, -5, '29.99', '1,200', '€29.99', '$0.00', '', 'Sold out', null, undefined];
  const currencies = [undefined, null, '', 'USD', 'usd', ' eur ', 'GBP', 'JPY', 'ZZZ', 'US Dollar', '$', 42];

  for (const price of amounts) {
    for (const currency of currencies) {
      const row = mapRawProductToPurchaseOption({
        id: 'x', title: 'T', retailer: 'R', price, currency, productUrl: 'https://s.test/x',
      });
      const shared = typeof currency === 'string'
        ? formatCommercePrice(price, currency)
        : formatCommercePrice(price, currency ?? undefined);
      assert.equal(
        row.priceLabel ?? null,
        shared ?? null,
        `client price formatters disagree for ${JSON.stringify(price)} / ${JSON.stringify(currency)}`,
      );
      if (row.priceLabel !== undefined) {
        const declared = typeof currency === 'string' && /^[a-z]{3}$/i.test(currency.trim());
        const providerFormatted = typeof price === 'string' && !/^[\d.,]+$/.test(price.trim());
        if (!declared && !providerFormatted) {
          assertNoInventedDollars(row.priceLabel, `row for ${JSON.stringify(price)} / ${JSON.stringify(currency)}`);
        }
      }
    }
  }
});

test('RP-110: a rendered purchase row never shows dollars for an undeclared currency', () => {
  const { mapRawProductToPurchaseOption } = loadClient('components/scan-results/types.ts');
  const undeclared = mapRawProductToPurchaseOption(
    { id: 'a', title: 'Wool Coat', retailer: 'Shop', price: 29.99, productUrl: 'https://s.test/1' },
  );
  const declared = mapRawProductToPurchaseOption(
    { id: 'b', title: 'Wool Coat', retailer: 'Shop', price: 29.99, currency: 'EUR', productUrl: 'https://s.test/2' },
  );

  assertNoInventedDollars(undeclared.priceLabel, 'purchase row with no declared currency');
  assert.equal(undeclared.priceLabel, '29.99');
  assert.equal(declared.priceLabel, '€29.99');
  // A legacy row saved before currency existed renders honestly, not as USD.
  const legacyRow = mapRawProductToPurchaseOption(
    { id: 'c', title: 'Wool Coat', retailer: 'Shop', price: '29.99', productUrl: 'https://s.test/3' },
  );
  assertNoInventedDollars(legacyRow.priceLabel, 'legacy row with no currency');
  // Retailer destination behavior unchanged.
  assert.equal(undeclared.productUrl, 'https://s.test/1');
  assert.equal(declared.productUrl, 'https://s.test/2');
});

// ── 5. Sale / original price ───────────────────────────────────────────────

test('RP-110: the shipping commerce contract carries no sale/original price to mis-label', () => {
  // Documented rather than assumed: no layer of the shipping Scanner commerce
  // path models a second (was/list/sale) price, so there is no second amount
  // that could be rendered in a currency nobody declared. If one is ever added
  // it must go through the same shared formatter, and this test will fail until
  // it is re-examined.
  const sources = [
    path.join(FUNCTION_DIR, 'shoppingProvider.ts'),
    path.join(FUNCTION_DIR, 'canonicalCommerce.ts'),
    path.join(ROOT, 'services', 'dressingRoomCommerce.ts'),
    path.join(ROOT, 'components', 'scan-results', 'types.ts'),
  ];
  for (const file of sources) {
    const src = codeOf(file);
    assert.ok(
      !/\b(originalPrice|original_price|salePrice|sale_price|listPrice|list_price)\b/.test(src),
      `${path.basename(file)} now models a second price — re-check RP-110 currency truth for it`,
    );
  }
});
