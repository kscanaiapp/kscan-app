// Tests for supabase/functions/scan-identify/shoppingProvider.ts
// All provider HTTP is mocked. No real network calls are made.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

// Mutable hooks the sandboxed module reads through injected globals.
let ENV = {};
let FETCH_IMPL = async () => {
  throw new Error('fetch not configured');
};

function loadProvider() {
  const filename = path.join(ROOT, 'supabase/functions/scan-identify/shoppingProvider.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
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
    URL,
    AbortController: globalThis.AbortController,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    fetch: (...args) => FETCH_IMPL(...args),
    Deno: { env: { get: (k) => ENV[k] } },
    require: (id) => {
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const provider = loadProvider();

function resetEnv() {
  ENV = { SHOPPING_SERPER_API_KEY: 'serper-test-key', SHOPPING_BRAVE_API_KEY: 'brave-test-key' };
  provider._resetShoppingCache();
}

function serperOk(items) {
  return { ok: true, status: 200, json: async () => ({ shopping: items }) };
}
function braveOk(results) {
  return { ok: true, status: 200, json: async () => ({ web: { results } }) };
}
// Route a mocked fetch by URL.
function routeFetch({ serper, brave }) {
  return async (url) => {
    const u = String(url);
    if (u.includes('serper.dev')) {
      if (typeof serper === 'function') return serper();
      return serper;
    }
    if (u.includes('brave.com')) {
      if (typeof brave === 'function') return brave();
      return brave;
    }
    throw new Error('unexpected url ' + u);
  };
}

// ── buildShoppingQuery ──

test('buildShoppingQuery: prefers search_queries[0]', () => {
  const q = provider.buildShoppingQuery({
    searchQueries: ['navy wool blazer'],
    brand: 'Gucci',
    text: 'something else',
  });
  assert.equal(q, 'navy wool blazer');
});

test('buildShoppingQuery: structured brand+color+category (Burberry example)', () => {
  const q = provider.buildShoppingQuery({
    brand: 'Burberry',
    color: 'tan',
    category: 'trench coat',
    style: 'neon piping',
  });
  assert.equal(q, 'Burberry tan trench coat neon piping');
});

test('buildShoppingQuery: skips unknown structured fields, falls back to text', () => {
  const q = provider.buildShoppingQuery({
    brand: 'unknown',
    color: 'unknown',
    category: 'unknown',
    text: 'red polo shirt',
  });
  assert.equal(q, 'red polo shirt');
});

test('buildShoppingQuery: empty when nothing usable', () => {
  assert.equal(provider.buildShoppingQuery({}), '');
});

// ── normalization helpers ──

test('normalizePrice: strips noisy prefixes and handles numbers', () => {
  assert.equal(provider.normalizePrice('From $45'), '$45');
  assert.equal(provider.normalizePrice('Starting at $80'), '$80');
  assert.equal(provider.normalizePrice('$129.99'), '$129.99');
  assert.equal(provider.normalizePrice(59), '$59.00');
  assert.equal(provider.normalizePrice(''), undefined);
  assert.equal(provider.normalizePrice(undefined), undefined);
});

test('normalizeUrl: drops tracking params, rejects non-http', () => {
  assert.equal(
    provider.normalizeUrl('https://shop.com/x?utm_source=g&id=5&gclid=abc'),
    'https://shop.com/x?id=5',
  );
  assert.equal(provider.normalizeUrl('ftp://x.com'), undefined);
  assert.equal(provider.normalizeUrl('not a url'), undefined);
});

// ── kill switch ──

test('getShoppingResults: SHOPPING_ENABLED=false returns no products', async () => {
  resetEnv();
  ENV.SHOPPING_ENABLED = 'false';
  FETCH_IMPL = async () => {
    throw new Error('should not fetch when disabled');
  };
  const r = await provider.getShoppingResults({ query: 'red polo shirt' });
  assert.equal(r.products.length, 0);
  assert.equal(r.provider, 'none');
  assert.equal(r.errorType, 'disabled');
});

// ── Serper primary ──

test('Serper success returns retail products', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    serper: serperOk([
      { title: 'Navy Blazer', link: 'https://a.com/1', price: '$129.99', imageUrl: 'https://a.com/i.jpg', source: 'A Store' },
    ]),
  });
  const r = await provider.getShoppingResults({ query: 'navy blazer 1' });
  assert.equal(r.provider, 'serper');
  assert.equal(r.products.length, 1);
  assert.equal(r.products[0].type, 'retail');
  assert.equal(r.products[0].title, 'Navy Blazer');
  assert.equal(r.products[0].price, '$129.99');
  assert.equal(r.products[0].productUrl, 'https://a.com/1');
  assert.equal(r.products[0].source, 'A Store');
});

test('Serper missing price/image is safe', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    serper: serperOk([{ title: 'Plain Tee', link: 'https://a.com/2' }]),
  });
  const r = await provider.getShoppingResults({ query: 'plain tee 2' });
  assert.equal(r.provider, 'serper');
  assert.equal(r.products[0].price, undefined);
  assert.equal(r.products[0].imageUrl, undefined);
  assert.equal(r.products[0].productUrl, 'https://a.com/2');
});

test('Serper products without productUrl are skipped', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    serper: serperOk([
      { title: 'No URL', price: '$10' },
      { title: 'Has URL', link: 'https://a.com/ok' },
    ]),
    brave: braveOk([]),
  });
  const r = await provider.getShoppingResults({ query: 'skip url 3' });
  assert.equal(r.products.length, 1);
  assert.equal(r.products[0].title, 'Has URL');
});

test('Serper duplicate product URLs are deduped', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    serper: serperOk([
      { title: 'One', link: 'https://a.com/dup' },
      { title: 'One dup', link: 'https://a.com/dup' },
    ]),
    brave: braveOk([]),
  });
  const r = await provider.getShoppingResults({ query: 'dedupe 4' });
  assert.equal(r.products.length, 1);
});

// ── Brave fallback ──

test('Serper empty result triggers Brave fallback (similar links)', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    serper: serperOk([]),
    brave: braveOk([{ title: 'Style Guide', url: 'https://blog.com/style', profile: { name: 'Blog' } }]),
  });
  const r = await provider.getShoppingResults({ query: 'empty then brave 5' });
  assert.equal(r.provider, 'brave');
  assert.equal(r.products.length, 1);
  assert.equal(r.products[0].type, 'similar');
  assert.equal(r.products[0].price, undefined);
  assert.equal(r.products[0].imageUrl, undefined);
  assert.equal(r.products[0].productUrl, 'https://blog.com/style');
  assert.equal(r.products[0].source, 'Blog');
});

test('Serper HTTP failure triggers Brave fallback', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    serper: { ok: false, status: 500, json: async () => ({}) },
    brave: braveOk([{ title: 'Fallback', url: 'https://shop2.com/x' }]),
  });
  const r = await provider.getShoppingResults({ query: 'serper 500 then brave 6' });
  assert.equal(r.provider, 'brave');
  assert.equal(r.products[0].source, 'shop2.com');
});

test('Serper timeout triggers Brave fallback', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    serper: () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    },
    brave: braveOk([{ title: 'Fallback', url: 'https://shop3.com/x' }]),
  });
  const r = await provider.getShoppingResults({ query: 'serper timeout then brave 7' });
  assert.equal(r.provider, 'brave');
  assert.equal(r.products.length, 1);
});

test('Both providers fail returns empty products', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    serper: serperOk([]),
    brave: braveOk([]),
  });
  const r = await provider.getShoppingResults({ query: 'both fail 8' });
  assert.equal(r.provider, 'none');
  assert.equal(r.products.length, 0);
});

test('Brave low-value hosts (wikipedia) are filtered out', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    serper: serperOk([]),
    brave: braveOk([
      { title: 'Wiki', url: 'https://en.wikipedia.org/wiki/Coat' },
      { title: 'Retailer', url: 'https://store.com/coat' },
    ]),
  });
  const r = await provider.getShoppingResults({ query: 'wiki filter 9' });
  assert.equal(r.products.length, 1);
  assert.equal(r.products[0].source, 'store.com');
});

test('successful results are cached (second call does not fetch)', async () => {
  resetEnv();
  let calls = 0;
  FETCH_IMPL = async (url) => {
    calls++;
    return serperOk([{ title: 'Cached', link: 'https://a.com/c' }]);
  };
  const q = 'cache me 10';
  const first = await provider.getShoppingResults({ query: q });
  const second = await provider.getShoppingResults({ query: q });
  assert.equal(first.provider, 'serper');
  assert.equal(second.provider, 'serper');
  assert.equal(calls, 1, 'second call should hit cache');
});
