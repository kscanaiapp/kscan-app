/**
 * Phase 2B.1 — scan-identify wiring and legacy response inventory.
 *
 * The activation LOGIC is tested directly in scanIdentifyV2Activation.test.js.
 * What cannot be tested that way is how index.ts is wired: the handler is a
 * `Deno.serve` entry point with remote specifiers and provider dependencies, so
 * instantiating it in Node would mean mocking the entire Edge Function runtime.
 *
 * These are therefore source-level assertions about properties that must hold
 * structurally — import form, ordering of the commerce gate relative to every
 * commerce construction, absence of a silent legacy fallback, and the exact
 * legacy response field inventory. The repository already gates Edge Function
 * source this way (edgeFunctionSourceParity), and an ordering property is
 * precisely the kind of thing a runtime test would not catch reliably anyway.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'supabase', 'functions', 'scan-identify', 'index.ts');
const ACTIVATION_PATH = path.join(ROOT, 'supabase', 'functions', 'scan-identify', 'v2Activation.ts');
const MANIFEST_PATH = path.join(ROOT, 'config', 'edge-function-manifest.json');

const indexSource = fs.readFileSync(INDEX_PATH, 'utf8');
const activationSource = fs.readFileSync(ACTIVATION_PATH, 'utf8');

/** First index of a needle, or Infinity when absent. */
function at(source, needle) {
  const index = source.indexOf(needle);
  return index === -1 ? Infinity : index;
}

// ── Deno import form ─────────────────────────────────────────────────────────

test('activation modules are imported with explicit .ts specifiers', () => {
  // Deno will not resolve an extensionless local specifier at deploy time, and
  // the manifest closure walker also relies on the explicit path.
  assert.match(indexSource, /from '\.\/v2Activation\.ts'/);
  assert.match(indexSource, /from '\.\.\/_shared\/fashionIdentificationV2\.ts'/);
  assert.match(activationSource, /from '\.\.\/_shared\/fashionIdentificationV2\.ts'/);

  // No extensionless local import may creep in anywhere in these two files.
  for (const [label, source] of [['index', indexSource], ['activation', activationSource]]) {
    const extensionless = [...source.matchAll(/from '(\.[^']*)'/g)]
      .map((match) => match[1])
      .filter((specifier) => !specifier.endsWith('.ts') && !specifier.endsWith('.json'));
    assert.deepEqual(extensionless, [], `${label} has extensionless local imports`);
  }
});

test('index.ts delegates rather than reimplementing validation or normalization', () => {
  // The one normalized source of truth is the shared module. If index.ts grew
  // its own copy of these, V1 and V2 could drift apart again.
  for (const symbol of [
    'routeScanIdentifyRequest',
    'resolveCommerceDecision',
    'validateFashionIdentificationResultV2',
    'normalizeToV2',
    'buildTransitionalResponse',
  ]) {
    assert.ok(indexSource.includes(symbol), `index.ts does not use ${symbol}`);
    // Used, never redefined locally.
    assert.ok(
      !new RegExp(`function\\s+${symbol}\\s*\\(`).test(indexSource),
      `index.ts defines its own ${symbol}`,
    );
  }
});

// ── Routing ──────────────────────────────────────────────────────────────────

test('contract routing runs before the request body is interpreted', () => {
  const routing = at(indexSource, 'routeScanIdentifyRequest(body)');
  assert.notEqual(routing, Infinity, 'routing is not wired');

  // Everything that reads the body for behaviour must come after the router.
  for (const consumer of [
    'const multiItemRequested',
    'const requestMode',
    'const selectedCandidate',
  ]) {
    assert.ok(at(indexSource, consumer) > routing, `${consumer} is read before routing`);
  }
});

test('a contract error returns HTTP 400 and never continues to legacy', () => {
  assert.match(
    indexSource,
    /if \(contractRoute\.kind === 'contract_error'\) \{\s*\n\s*return json\(contractRoute\.body, contractRoute\.httpStatus\);/,
    'contract errors must return immediately with the bounded body',
  );
  // The bounded status is fixed at 400 in the activation layer.
  assert.match(activationSource, /httpStatus: 400/);
  assert.ok(
    !/httpStatus: 500/.test(activationSource),
    'client validation must never be reported as a server error',
  );
});

test('no client-validation path returns a raw error, body or stack', () => {
  // The only builder of a client error body takes a bounded code and nothing
  // else, so a message cannot be assembled from request or exception content.
  assert.match(
    activationSource,
    /export function buildContractErrorBody\(code: V2ErrorCode\): V2ContractErrorBody/,
  );
  for (const forbidden of ['error.stack', 'JSON.stringify(body)', 'String(err)', '`${body']) {
    assert.ok(!activationSource.includes(forbidden), `activation layer leaks ${forbidden}`);
  }
});

// ── Commerce ordering: the property that matters most ────────────────────────

test('the commerce decision is resolved before ANY commerce construction', () => {
  const decision = at(indexSource, 'resolveCommerceDecision({');
  assert.notEqual(decision, Infinity, 'commerce decision is not wired');

  // Every commerce entry point must appear after the gate. This is the whole
  // point of a "hard" short-circuit: starting a provider and discarding it
  // later still spends the quota, the latency and the third-party call.
  const constructions = [
    'getScanCommerceResults({',
    'buildImageSimilarityMatches({',
    'getShoppingResults(',
  ];
  for (const construction of constructions) {
    const position = at(indexSource, construction);
    if (position === Infinity) continue;
    assert.ok(
      position > decision,
      `${construction} is constructed before the commerce gate`,
    );
  }
});

test('the style-intent skip branch constructs no provider of any kind', () => {
  const branch = indexSource.match(
    /\} else if \(isV2Request && !commerceDecision\.run\) \{([\s\S]*?)\n    \} else if/,
  );
  assert.ok(branch, 'the v2 commerce short-circuit branch is missing');
  // Strip comments: the branch DESCRIBES what it must not construct, and a
  // naive scan would match the prose rather than the code.
  const body = branch[1].replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  for (const forbidden of [
    'getScanCommerceResults',
    'buildImageSimilarityMatches',
    'findSimilarityMatches',
    'getShoppingResults',
    'fetchCatalogCandidates',
    'product_catalog',
    'await',
    'Promise',
  ]) {
    assert.ok(!body.includes(forbidden), `the skip branch references ${forbidden}`);
  }
  // It must still produce commerce-compatible empty arrays.
  assert.match(body, /finalRecommendedProducts = \[\];/);
  assert.match(body, /finalSimilarityMatches = \[\];/);
  assert.match(body, /commerceSkipped: true/);
});

test('the legacy detection commerce skip is preserved', () => {
  // Legacy detection already skipped commerce before Phase 2B.1; activation
  // must not have replaced or bypassed that branch.
  assert.match(indexSource, /reason: 'multi_item_detection_only'/);
  assert.match(indexSource, /\} else if \(useMultiItemDetectionProvider\) \{/);
});

test('the v2 commerce short-circuit cannot alter legacy behaviour', () => {
  // Gated on isV2Request precisely so a legacy request keeps whatever commerce
  // behaviour it had before activation.
  assert.match(indexSource, /\} else if \(isV2Request && !commerceDecision\.run\) \{/);
});

// ── Response ─────────────────────────────────────────────────────────────────

test('the transitional response is only built for v2 requests', () => {
  assert.match(indexSource, /let finalResponse: Record<string, unknown> = legacyFinalResponse;/);
  assert.match(indexSource, /if \(isV2Request\) \{/);
  // A legacy caller must not receive the additive fields.
  const legacyOnly = indexSource.slice(0, at(indexSource, 'if (isV2Request) {'));
  assert.ok(!legacyOnly.includes('identificationV2:'), 'legacy path attaches identificationV2');
});

test('the v2 result is validated and JSON-checked before it is attached', () => {
  const validate = at(indexSource, 'validateFashionIdentificationResultV2(v2Result)');
  const jsonCheck = at(indexSource, 'findJsonUnsafePath(v2Result)');
  const attach = at(indexSource, 'buildTransitionalResponse(legacyFinalResponse, v2Result)');
  assert.ok(validate < attach, 'result attached before validation');
  assert.ok(jsonCheck < attach, 'result attached before the JSON-safety check');
  // A failure still yields a parseable v2 contract, not a 500.
  assert.match(indexSource, /buildTechnicalFailureResultV2\(/);
});

test('attaching the v2 result is CONDITIONAL on both checks, not merely ordered', () => {
  // Ordering alone is not enough: computing the validation and then attaching
  // unconditionally would satisfy an ordering assertion while shipping a
  // malformed identificationV2. The guard must actually consume both results.
  const guard = indexSource.match(/\n\s*if \(([^)]*)\) \{\s*\n\s*finalResponse = buildTransitionalResponse\(legacyFinalResponse, v2Result\);/);
  assert.ok(guard, 'the v2 attach is not guarded');
  assert.match(guard[1], /v2Validation\.ok/, 'guard ignores the validation result');
  assert.match(guard[1], /unsafePath === null/, 'guard ignores the JSON-safety result');

  // And the failure path must substitute the bounded technical-failure result.
  assert.match(
    indexSource,
    /\} else \{[\s\S]*?buildTechnicalFailureResultV2\(/,
    'a failed validation does not fall back to a technical-failure contract',
  );
});

test('validation-failure logging records a category, never the value', () => {
  const warn = indexSource.match(/v2_response_validation_failed[^;]*;/);
  assert.ok(warn, 'no scrubbed validation-failure log');
  assert.ok(!warn[0].includes('v2Result,'), 'the failing result is logged verbatim');
  assert.ok(!warn[0].includes('JSON.stringify'), 'the failing result is serialized into a log');
});

// ── Evidence handling ────────────────────────────────────────────────────────

test('index.ts never silently reduces a multi-evidence request to the first entry', () => {
  assert.ok(
    !/evidence\[0\]/.test(indexSource),
    'index.ts indexes evidence[0] directly instead of using the validated request',
  );
  // The rejection lives in the validator and is surfaced as a bounded code.
  assert.ok(activationSource.includes('MULTIPLE_EVIDENCE_NOT_SUPPORTED'));
});

test('the existing payload guard is untouched by activation', () => {
  // Activation must not raise the limit or bypass the base64/magic-byte checks.
  assert.match(indexSource, /validateImageBase64\(/);
  assert.ok(!/MAX_IMAGE_BASE64|maxBodyBytes/.test(activationSource),
    'activation layer redefines a payload limit');
});

// ── Legacy response inventory ────────────────────────────────────────────────

/**
 * The legacy field inventory, derived from source rather than hand-listed.
 *
 * `normalized()` and `withSafeImageArrays()` are where every legacy image
 * response gets its shape, so their key sets ARE the contract legacy clients
 * depend on. Snapshotting them here means an accidental rename or removal
 * during a later refactor fails loudly instead of silently breaking a client
 * that cannot be updated retroactively.
 */
/**
 * Reads the keys of a single object literal, starting at `opener` and stopping
 * at the matching close brace. Handles shorthand (`status,`) as well as
 * `key: value`, because the legacy response uses both and a regex that only
 * saw colons would silently under-report the inventory.
 */
function extractObjectKeys(source, opener) {
  const start = source.indexOf(opener);
  assert.notEqual(start, -1, `missing ${opener}`);
  let depth = 0;
  let end = start;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = source.slice(source.indexOf('{', start) + 1, end);
  const keys = new Set();
  for (const line of body.split('\n')) {
    // Only top-level entries of this literal (a single indent step in).
    const match = /^\s{4}(?:\.\.\.)?(\w+)\s*[,:]/.exec(line);
    if (match) keys.add(match[1]);
  }
  return [...keys].sort();
}

test('the legacy normalized() response inventory is unchanged', () => {
  // Anchored inside normalized() — the same literal opener appears earlier in
  // buildDisplayResult(), where it is an empty object.
  const scoped = indexSource.slice(indexSource.indexOf('function normalized('));
  const keys = extractObjectKeys(scoped, 'const out: Record<string, unknown> = {');
  assert.deepEqual(keys, [
    'attributes',
    'identification',
    'products',
    'purchaseOptions',
    'recommendedProducts',
    'shoppingMeta',
    'similarityMatches',
    'status',
    'userMessage',
  ]);
});

test('withSafeImageArrays still guarantees array-typed commerce fields', () => {
  const start = indexSource.indexOf('function withSafeImageArrays(');
  const returnStart = indexSource.indexOf('  return {', start);
  const keys = extractObjectKeys(indexSource.slice(returnStart), '  return {');
  assert.deepEqual(keys, [
    'products',
    'purchaseOptions',
    'recommendedProducts',
    'response',
    'shoppingMeta',
    'similarityMatches',
  ]);
  // Empty must stay [] rather than becoming undefined when commerce is skipped.
  const slice = indexSource.slice(start, returnStart);
  assert.match(slice, /:\s*\[\]/, 'array fallbacks were removed');
});

test('activation adds exactly two response fields and renames none', () => {
  const added = [...activationSource.matchAll(
    /return \{\s*\n\s*\.\.\.legacyResponse,\s*\n\s*(\w+):[\s\S]*?\n\s*(\w+):/g,
  )];
  assert.equal(added.length, 1, 'transitional response shape changed');
  assert.deepEqual([added[0][1], added[0][2]].sort(), ['contractVersion', 'identificationV2']);
});

// ── Governed closure ─────────────────────────────────────────────────────────

test('both v2 modules are inside the governed scan-identify deployable closure', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const parity = manifest.parity ?? manifest;
  const fn = parity.functions.find((entry) => entry.name === 'scan-identify');
  assert.ok(fn, 'scan-identify missing from the manifest');

  const bundle = fn.files.filter((file) => file.bundle).map((file) => file.path);
  for (const required of [
    'supabase/functions/_shared/fashionIdentificationV2.ts',
    'supabase/functions/scan-identify/v2Activation.ts',
  ]) {
    assert.ok(
      bundle.includes(required),
      `${required} is not in the deployable closure — the parity gate would not cover it`,
    );
  }
});
