// Governance tests for Product Match Foundation V1 (Node).
//
// These assert the properties that make this phase SAFE rather than the ones
// that make it work — the behavioural suite lives in Deno alongside the
// function (supabase/functions/product-match/*.test.ts) and is run by
// `node scripts/run-backend-tests.js product-match`.
//
// What is checked here:
//   - the function is dormant: absent from the governed manifest, absent from
//     the deploy allowlist, so no deploy path can reach it
//   - the governed edge-function manifest is untouched by this phase, i.e.
//     scan-identify's deployed closure did not drift
//   - the contract JSON schema and the TypeScript enums agree
//   - the request contract has no image-shaped field
//   - the benchmark case set is sealed and the seal verifies

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FUNCTION_DIR = path.join(ROOT, 'supabase', 'functions', 'product-match');
const SCHEMA_PATH = path.join(ROOT, 'contracts', 'product-match-v1.schema.json');
const BENCH_CASES = path.join(ROOT, 'tools', 'product-match-benchmark', 'cases');

function readFunctionFile(name) {
  return fs.readFileSync(path.join(FUNCTION_DIR, name), 'utf8');
}

/** Pulls a string-literal union's members out of a TypeScript source file. */
function unionMembers(source, typeName) {
  const declaration = new RegExp(`export type ${typeName} =([\\s\\S]*?);`, 'm').exec(source);
  assert.ok(declaration, `could not locate 'export type ${typeName}'`);
  return [...declaration[1].matchAll(/'([a-zA-Z_]+)'/g)].map((match) => match[1]).sort();
}

// ── dormancy ────────────────────────────────────────────────────────────────

test('product-match is absent from the governed edge-function list', () => {
  const lib = fs.readFileSync(path.join(ROOT, 'scripts', 'edge-function-manifest-lib.js'), 'utf8');
  const governed = /const GOVERNED_FUNCTIONS = \[([^\]]+)\]/.exec(lib);
  assert.ok(governed, 'GOVERNED_FUNCTIONS must be a literal list');
  assert.ok(
    !governed[1].includes('product-match'),
    'product-match must stay out of the governed list until it is deployed — '
      + 'scripts/deploy-edge-functions.js deploys everything the manifest governs, '
      + 'so adding it here would make a deploy the default rather than a decision',
  );
});

test('the deploy manifest does not list product-match', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'config', 'edge-function-manifest.json'), 'utf8'),
  );
  assert.ok(!manifest.parity.expectedFunctions.includes('product-match'));
});

test('the governed manifest still describes exactly the previously governed functions', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'config', 'edge-function-manifest.json'), 'utf8'),
  );
  assert.deepEqual(
    [...manifest.parity.expectedFunctions].sort(),
    ['scan-identify', 'style-outfit-generate', 'stylechat-generate'],
  );
});

test('this phase did not change any governed scan-identify file hash', () => {
  // The manifest pins a sha256 per file. Re-hashing them here proves the
  // product-match work did not perturb the deployed scan-identify closure,
  // which is the drift the edge parity gate exists to catch.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'config', 'edge-function-manifest.json'), 'utf8'),
  );
  const scanIdentify = manifest.parity.functions.find((fn) => fn.name === 'scan-identify');
  assert.ok(scanIdentify, 'scan-identify must be present in the manifest');

  const drifted = [];
  for (const file of scanIdentify.files) {
    const absolute = path.join(ROOT, file.path);
    if (!fs.existsSync(absolute)) {
      drifted.push(`${file.path} (missing)`);
      continue;
    }
    const actual = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    if (actual !== file.sha256) drifted.push(file.path);
  }
  assert.deepEqual(drifted, [], 'no governed scan-identify file may change in this phase');
});

test('the feature flag defaults to disabled', () => {
  const config = readFunctionFile('config.ts');
  assert.match(config, /PRODUCT_MATCH_DEFAULT_ENABLED\s*=\s*false/);
});

test('the endpoint fails closed when the internal secret is unset', () => {
  const index = readFunctionFile('index.ts');
  // secretMatches returns false for a null expected secret; assert the guard
  // reads the env var and that nothing bypasses the comparison.
  assert.match(index, /PRODUCT_MATCH_INTERNAL_SECRET/);
  assert.match(index, /if \(!expected \|\| !provided\) return false;/);
});

// ── privacy boundary ────────────────────────────────────────────────────────

test('no request field accepts image data', () => {
  const index = readFunctionFile('index.ts');
  const allowed = /const ALLOWED_QUERY_FIELDS = new Set\(\[([\s\S]*?)\]\)/.exec(index);
  assert.ok(allowed, 'ALLOWED_QUERY_FIELDS must be a literal set');
  const fields = [...allowed[1].matchAll(/'([a-zA-Z]+)'/g)].map((match) => match[1]);
  for (const field of fields) {
    assert.ok(
      !/image|photo|picture|base64|bytes|uri|url/i.test(field),
      `query field '${field}' looks like an image or media reference`,
    );
  }
});

test('the telemetry event has no user identifier field', () => {
  const telemetry = readFunctionFile('telemetry.ts');
  const eventType = /export type ProductMatchEvent = \{([\s\S]*?)\n\};/.exec(telemetry);
  assert.ok(eventType, 'ProductMatchEvent must be a literal type');
  assert.ok(!/user_id|scan_id|image_hash|email/.test(eventType[1]));
});

test('the migration creating the telemetry table is not wired into any deploy path', () => {
  const migration = path.join(ROOT, 'supabase', 'migrations', '20260803120000_product_match_events.sql');
  assert.ok(fs.existsSync(migration), 'the migration ships with the branch');
  const sql = fs.readFileSync(migration, 'utf8');
  assert.match(sql, /NOT APPLIED/, 'the migration must state that it is unapplied');
  // Nothing in this branch writes to the table. Naming it in a comment is
  // fine and in fact desirable — what must not exist is a client call or an
  // INSERT reaching it, so the assertion targets those forms rather than the
  // bare string.
  const functionSources = fs.readdirSync(FUNCTION_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFunctionFile(name))
    .join('\n');
  const writeShapes = [
    /\.from\(\s*['"`]product_match_events['"`]\s*\)/,
    /insert\s+into\s+[\w.]*product_match_events/i,
    /rest\(\s*['"`]product_match_events/,
  ];
  for (const shape of writeShapes) {
    assert.ok(
      !shape.test(functionSources),
      `a write path to product_match_events exists (${shape}) while writes are unauthorized`,
    );
  }

  // And no telemetry writer is wired by default.
  assert.match(
    readFunctionFile('index.ts'),
    /emitProductMatchEvent\(event, null\)/,
    'the endpoint must emit with a null writer',
  );
});

// ── contract agreement ──────────────────────────────────────────────────────

test('the JSON schema tier enum matches the TypeScript union', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const contracts = readFunctionFile('contracts.ts');
  assert.deepEqual(
    [...schema.definitions.matchTier.enum].sort(),
    unionMembers(contracts, 'MatchTier'),
  );
});

test('the JSON schema source enum matches the TypeScript union', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const contracts = readFunctionFile('contracts.ts');
  assert.deepEqual(
    [...schema.definitions.productSource.enum].sort(),
    unionMembers(contracts, 'ProductSource'),
  );
});

test('the JSON schema evidence enum matches the TypeScript union', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const contracts = readFunctionFile('contracts.ts');
  assert.deepEqual(
    [...schema.definitions.evidenceKind.enum].sort(),
    unionMembers(contracts, 'EvidenceKind'),
  );
});

test('the schema query definition matches the endpoint allowlist exactly', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const index = readFunctionFile('index.ts');
  const allowed = /const ALLOWED_QUERY_FIELDS = new Set\(\[([\s\S]*?)\]\)/.exec(index);
  const fields = [...allowed[1].matchAll(/'([a-zA-Z]+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(Object.keys(schema.definitions.productMatchQuery.properties).sort(), fields);
});

// ── benchmark governance ────────────────────────────────────────────────────

test('the benchmark case set is sealed and the seal verifies', () => {
  const manifestPath = path.join(BENCH_CASES, 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'the benchmark must ship a sealed manifest');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const caseFiles = fs.readdirSync(BENCH_CASES)
    .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
    .sort();
  assert.deepEqual(caseFiles, manifest.cases);

  const hash = crypto.createHash('sha256');
  for (const name of caseFiles) {
    const content = fs.readFileSync(path.join(BENCH_CASES, name), 'utf8').replace(/\r\n/g, '\n');
    hash.update(`${name}:${crypto.createHash('sha256').update(content).digest('hex')}\n`);
  }
  assert.equal(hash.digest('hex'), manifest.sealHash);
});

test('the benchmark runner refuses non-local imports and grants no fetch', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'scripts', 'product-match-benchmark.js'), 'utf8');
  assert.match(runner, /benchmark sandbox refuses non-local import/);
  const sandbox = /const sandbox = \{([\s\S]*?)\n  \};/.exec(runner);
  assert.ok(sandbox, 'the sandbox must be a literal object');
  assert.ok(
    !/(^|[^.\w])fetch\s*[,:]/.test(sandbox[1]),
    'the benchmark sandbox must not expose fetch',
  );
});

test('the benchmark runs offline and reports what it actually measured', () => {
  const output = execFileSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'product-match-benchmark.js'), '--json'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const summary = JSON.parse(output);
  assert.equal(summary.manifestVersion, 'product-match-benchmark-v1');
  assert.ok(summary.caseCount >= 1);
  // A run with no labelled cases must report null, never a fabricated 1.0.
  if (summary.labelledCount === 0) assert.equal(summary.accuracy, null);
  else assert.equal(summary.accuracy, summary.passedCount / summary.labelledCount);
});
