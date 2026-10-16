// supabase/functions/_shared/net/publicHost.ts holds a VERBATIM copy of the host
// check in safeRemoteMedia.ts (the paid-provider boundary for vto-generate, which
// this work deliberately leaves untouched) so the mobile app can import the check
// without the server-side media fetcher. Two copies of a security predicate are
// only acceptable while they cannot drift, so this pins both source and behaviour.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\r\n').join('\n');
const COPY = 'supabase/functions/_shared/net/publicHost.ts';
const ORIGINAL = 'supabase/functions/_shared/net/safeRemoteMedia.ts';

function body(text) {
  const start = text.indexOf('export function isNonPublicHost');
  assert.ok(start >= 0, 'function not found');
  const end = text.indexOf('\n}\n', start);
  assert.ok(end > start, 'function end not found');
  return text.slice(start, end + 3);
}

function load(rel) {
  const out = ts.transpileModule(read(rel), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', 'URL', 'URLSearchParams', out)(mod, mod.exports, () => { throw new Error('no imports expected'); }, URL, URLSearchParams);
  return mod.exports;
}

test('the copy is source-identical to the original function', () => {
  assert.equal(body(read(COPY)), body(read(ORIGINAL)));
});

test('the copy behaves exactly like the original on a broad host corpus', () => {
  const copy = load(COPY).isNonPublicHost;
  // safeRemoteMedia has no imports, so it loads standalone.
  const original = load(ORIGINAL).isNonPublicHost;
  const hosts = [
    'localhost', 'app.localhost', 'intranet', '', '   ', '127.0.0.1', '10.0.0.5', '172.16.0.1', '172.32.0.1',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.128.0.1', '0.0.0.0', '224.0.0.1', '8.8.8.8', '256.1.1.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '[::1]', '[::ffff:127.0.0.1]', '::ffff:7f00:1', '::ffff:808:808',
    '2001:4860:4860::8888', '2130706433', '0x7f000001', '017700000001', 'example.com', 'shop.example.co.uk',
    'www.google.com', 'EXAMPLE.COM', ' Example.com ',
  ];
  for (const host of hosts) assert.equal(copy(host), original(host), JSON.stringify(host));
});

test('the paid-provider boundary file is not part of the Scanner change', () => {
  // A source-level reminder: matchTier and shoppingProvider read the COPY, and
  // nothing in the Scanner tree imports the protected file for this purpose.
  for (const file of ['matchTier.ts', 'shoppingProvider.ts']) {
    const text = read(`supabase/functions/scan-identify/${file}`);
    assert.ok(text.includes("_shared/net/publicHost.ts"), `${file} uses the copy`);
    assert.ok(!text.includes('safeRemoteMedia'), `${file} does not import the protected boundary file`);
  }
});
