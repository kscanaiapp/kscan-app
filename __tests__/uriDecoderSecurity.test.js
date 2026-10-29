const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');

function malformedRuns(count) {
  let input = '';
  for (let i = 0; i < count; i++) input += `%${Math.floor(i / 256).toString(16).padStart(2, '0')}%${(i % 256).toString(16).padStart(2, '0')}x`;
  return input + '%zz';
}
test('actual navigation query consumer decodes malformed runs with bounded full-string replacement passes', () => {
  const queryString = require('query-string');
  const payload = malformedRuns(1024);
  const original = String.prototype.replace;
  let calls = 0;
  const started = performance.now();
  let result;
  try {
    String.prototype.replace = function (...args) { calls++; return original.apply(this, args); };
    result = queryString.parse('item=' + payload);
  } finally { String.prototype.replace = original; }
  console.log(JSON.stringify({ probe: 'navigation malformed URI', payloadBytes: payload.length, replacementCalls: calls, elapsedMs: performance.now() - started }));
  assert.equal(typeof result.item, 'string');
  assert.ok(calls <= 16, `decoding must not rescan the full input for every distinct run: ${calls} replace calls`);
});
test('legacy CommonJS consumer and normal/partial Unicode query semantics remain usable', () => {
  const decode = require('decode-uri-component');
  const query = require('query-string');
  assert.equal(typeof decode, 'function', 'the old SDK requires a callable CommonJS export');
  assert.equal(decode('st%C3%A5le'), 'ståle');
  assert.equal(decode('a+b'), 'a b', 'retain the installed legacy decoder plus convention');
  assert.equal(decode('%st%C3%A5le%'), '%ståle%');
  assert.equal(decode('%FE%FF'), '\uFFFD\uFFFD');
  assert.equal(decode('%C2'), '\uFFFD');
  assert.deepEqual({ ...query.parse('q=Deep+Space&brand=K%2B&name=st%C3%A5le') }, { brand: 'K+', name: 'ståle', q: 'Deep Space' });
  assert.throws(() => decode(null), TypeError);
});
test('vendored decoder is the exact upstream security algorithm with only documented module/legacy-plus adaptation', () => {
  const dir = path.join(ROOT, 'vendor/decode-uri-component');
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'provenance.json'), 'utf8'));
  const source = fs.readFileSync(path.join(dir, 'index.cjs'), 'utf8').replace(/\r\n/g, '\n');
  const restored = source.replace('module.exports = function decodeUriComponent(encodedURI) {',
    'export default function decodeUriComponent(encodedURI) {')
    .replace("\n\tencodedURI = encodedURI.replace(/\\+/g, ' ');", '');
  assert.equal(crypto.createHash('sha256').update(restored).digest('hex'), record.upstreamIndexSha256);
  assert.equal(record.upstreamVersion, '0.5.1');
  assert.match(fs.readFileSync(path.join(dir, 'license'), 'utf8'), /MIT/);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['decode-uri-component'], 'file:./vendor/decode-uri-component');
  assert.equal(manifest.overrides['decode-uri-component'], '$decode-uri-component');
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['vendor/decode-uri-component'].version, '0.5.1');
  assert.equal(lock.packages['node_modules/decode-uri-component'].link, true);
});
