/**
 * GP-001 — provider-supplied URLs must be classified before the OS opens them.
 *
 * Before this repair, four surfaces passed a backend/provider string straight
 * to Linking.openURL:
 *
 *   app/text-scan/index.tsx                     product.productUrl
 *   components/SecondhandShelf.tsx              item.listingUrl
 *   components/SneakerMatchCard.tsx             marketplaceLinks.*
 *   components/scan-results/SimilarFindsShelf   product.productUrl
 *
 * services/textScan.ts accepts productUrl / product_url / purchaseUrl /
 * purchase_url / url / link / affiliateUrl / affiliate_url from the upstream
 * payload without inspecting the scheme, so the scheme was upstream-controlled.
 *
 * Part 1 exercises services/openExternalUrl.ts behaviourally against a mocked
 * react-native Linking, proving Linking.openURL is never reached for a rejected
 * URL. Part 2 pins the four call sites, because a behavioural test of the
 * helper cannot prove the screens actually route through it — that regression
 * (a re-added direct Linking.openURL) is exactly what reopened the defect.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');

function readSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/** Loads a TS module with `react-native` replaced by a recording double. */
function loadOpener() {
  const opened = [];
  let throwOnOpen = false;

  const requireFn = (id) => {
    if (id === 'react-native') {
      return {
        Linking: {
          openURL: async (url) => {
            opened.push(url);
            if (throwOnOpen) throw new Error('no handler');
            return true;
          },
        },
      };
    }
    if (id === './commerceDestination') {
      return loadPlain('services/commerceDestination.ts');
    }
    return require(id);
  };

  const exports = loadPlain('services/openExternalUrl.ts', requireFn);
  return {
    openExternalUrl: exports.openExternalUrl,
    opened,
    setThrowOnOpen: (value) => {
      throwOnOpen = value;
    },
  };
}

function loadPlain(relativePath, requireFn = require) {
  const { outputText } = ts.transpileModule(readSource(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: relativePath,
  });
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  Function('exports', 'require', 'module', outputText)(module.exports, requireFn, module);
  return module.exports;
}

// ── Part 1: behaviour ────────────────────────────────────────────────────────

const HOSTILE_URLS = [
  'javascript:alert(document.cookie)',
  'data:text/html,<script>1</script>',
  'file:///data/data/com.kscanai.app/databases/session.db',
  'content://com.android.externalstorage/document/primary',
  'intent://scan/#Intent;scheme=zxing;package=com.evil.app;end',
  'market://details?id=com.evil.app',
  'http://www.example.com/product/1',
  'https://user:pass@www.example.com/product/1',
  'https://127.0.0.1/admin',
  'https://localhost/admin',
  'https://10.0.0.5/internal',
  'https://192.168.1.1/router',
  'https://172.16.4.4/internal',
  'https://169.254.169.254/latest/meta-data/',
  'not a url at all',
  '',
];

test('GP-001: no hostile or non-https URL ever reaches Linking.openURL', async () => {
  const { openExternalUrl, opened } = loadOpener();
  for (const url of HOSTILE_URLS) {
    const result = await openExternalUrl(url);
    assert.equal(result, false, `expected rejection for ${JSON.stringify(url)}`);
  }
  assert.deepEqual(opened, [], 'Linking.openURL must not be called for rejected URLs');
});

test('GP-001: non-string inputs are rejected without reaching Linking', async () => {
  const { openExternalUrl, opened } = loadOpener();
  for (const value of [null, undefined, 0, 42, {}, [], true]) {
    assert.equal(await openExternalUrl(value), false);
  }
  assert.deepEqual(opened, []);
});

test('GP-001: a legitimate https retailer URL still opens unchanged', async () => {
  const { openExternalUrl, opened } = loadOpener();
  const url = 'https://www.nordstrom.com/s/wool-coat/7412589?origin=keywordsearch';
  assert.equal(await openExternalUrl(url), true);
  assert.deepEqual(opened, [url], 'the URL must be passed through byte-for-byte');
});

test('GP-001: the Google Shopping search TextScan builds itself is still allowed', async () => {
  const { openExternalUrl, opened } = loadOpener();
  const url = 'https://www.google.com/search?tbm=shop&q=wool%20coat';
  assert.equal(await openExternalUrl(url), true);
  assert.deepEqual(opened, [url]);
});

test('GP-001: a failed OS open reports false rather than throwing', async () => {
  const { openExternalUrl, opened, setThrowOnOpen } = loadOpener();
  setThrowOnOpen(true);
  assert.equal(await openExternalUrl('https://www.vinted.com/items/123'), false);
  assert.deepEqual(opened, ['https://www.vinted.com/items/123']);
});

// ── Part 2: call-site wiring ─────────────────────────────────────────────────

const GUARDED_CALL_SITES = [
  'app/text-scan/index.tsx',
  'components/SecondhandShelf.tsx',
  'components/SneakerMatchCard.tsx',
  'components/scan-results/SimilarFindsShelf.tsx',
];

for (const relativePath of GUARDED_CALL_SITES) {
  test(`GP-001: ${relativePath} opens links only through the shared guard`, () => {
    const source = readSource(relativePath);
    assert.match(
      source,
      /openExternalUrl/,
      `${relativePath} must import and use services/openExternalUrl`,
    );
    assert.ok(
      !/Linking\.openURL/.test(source),
      `${relativePath} must not call Linking.openURL directly`,
    );
  });
}

test('GP-001: the guard itself is the only commerce surface calling Linking.openURL', () => {
  const source = readSource('services/openExternalUrl.ts');
  assert.match(source, /isSafeCommerceUrl/);
  assert.match(source, /Linking\.openURL/);
});
