/**
 * Android v26 LLM routing regressions.
 *
 * Covers the frozen model allowlist, per-surface routing, TextScan's
 * no-escalation retry policy, transient-vs-permanent failure classification,
 * account-state enforcement ordering, and telemetry/error privacy.
 *
 * Evidence class: AUTOMATED — DETERMINISTIC MOCK / STATIC. No production
 * behaviour is asserted here.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadDenoModule(relativePath) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    output,
    { exports: module.exports, module, Set, Map, Math, Number, Error, JSON, String },
    { filename },
  );
  return module.exports;
}

const routing = loadDenoModule('supabase/functions/_shared/llmModelRouting.ts');

const scanSource = fs.readFileSync(
  path.join(ROOT, 'supabase/functions/scan-identify/index.ts'),
  'utf8',
);
const eliseSource = fs.readFileSync(
  path.join(ROOT, 'supabase/functions/stylechat-generate/index.ts'),
  'utf8',
);
const eliseRoutingSource = fs.readFileSync(
  path.join(ROOT, 'supabase/functions/stylechat-generate/modelRouting.ts'),
  'utf8',
);
const configToml = fs.readFileSync(path.join(ROOT, 'supabase/config.toml'), 'utf8');

const APPROVED = ['gemini-3.6-flash', 'gemini-3.5-flash-lite'];

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

test('only the two approved models are routable', () => {
  assert.deepEqual([...routing.APPROVED_MODELS].sort(), [...APPROVED].sort());
  for (const model of APPROVED) assert.equal(routing.isApprovedModelId(model), true);
});

test('retired and unapproved identifiers can never be selected', () => {
  const rejected = [
    'gemini-1.5-flash',
    'gemini-2.0-flash-exp',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-pro',
    'gemini-exp-1206',
    'gemini-3.6-flash-preview',
    'gpt-4o',
    '',
    '   ',
    undefined,
    null,
  ];
  for (const candidate of rejected) {
    assert.equal(
      routing.resolveAllowedModel(candidate, 'gemini-3.6-flash'),
      'gemini-3.6-flash',
      `${String(candidate)} must fail closed to the approved default`,
    );
  }
  for (const retired of ['gemini-1.5-flash', 'gemini-2.0-flash-exp', 'gemini-2.5-flash']) {
    assert.equal(routing.isRetiredModelId(retired), true);
  }
});

test('an approved identifier is honoured, and an unapproved default is refused outright', () => {
  assert.equal(
    routing.resolveAllowedModel('gemini-3.5-flash-lite', 'gemini-3.6-flash'),
    'gemini-3.5-flash-lite',
  );
  assert.throws(() => routing.resolveAllowedModel('gemini-3.6-flash', 'gemini-1.5-flash'));
});

// ---------------------------------------------------------------------------
// Per-surface routing
// ---------------------------------------------------------------------------

test('Scanner runs Flash with exactly one approved Lite fallback', () => {
  const plan = routing.resolveRoutePlan('scanner', () => undefined);
  assert.equal(plan.primaryModel, 'gemini-3.6-flash');
  assert.equal(plan.fallbackModel, 'gemini-3.5-flash-lite');
  assert.equal(plan.maxAttempts, 2);
  assert.equal(routing.nextAttemptModel(plan, 1), 'gemini-3.6-flash');
  assert.equal(routing.nextAttemptModel(plan, 2), 'gemini-3.5-flash-lite');
  assert.equal(routing.nextAttemptModel(plan, 3), null, 'no third attempt, no loop');
});

test('Elise runs Flash with exactly one approved Lite fallback', () => {
  const plan = routing.resolveRoutePlan('elise', () => undefined);
  assert.equal(plan.primaryModel, 'gemini-3.6-flash');
  assert.equal(plan.fallbackModel, 'gemini-3.5-flash-lite');
  assert.equal(routing.nextAttemptModel(plan, 3), null);
});

test('TextScan is pinned to Lite and never escalates', () => {
  const plan = routing.resolveRoutePlan('textscan', () => undefined);
  assert.equal(plan.primaryModel, 'gemini-3.5-flash-lite');
  assert.equal(plan.fallbackModel, null, 'no escalation target exists');
  assert.equal(plan.maxAttempts, 2, 'one retry only');
  assert.equal(routing.nextAttemptModel(plan, 1), 'gemini-3.5-flash-lite');
  assert.equal(routing.nextAttemptModel(plan, 2), 'gemini-3.5-flash-lite', 'same model retry');
  assert.equal(routing.nextAttemptModel(plan, 3), null, 'no third attempt');
});

test('no environment value can move TextScan to Flash or introduce a new model', () => {
  const hostile = {
    SCAN_GEMINI_MODEL: 'gemini-3.6-flash',
    SCAN_GEMINI_FALLBACK_MODEL: 'gemini-1.5-flash',
    STYLECHAT_GEMINI_MODEL: 'gpt-4o',
    GEMINI_MODEL: 'gemini-2.5-flash',
    TEXTSCAN_GEMINI_MODEL: 'gemini-3.6-flash',
  };
  const getEnv = (k) => hostile[k];

  const textscan = routing.resolveRoutePlan('textscan', getEnv);
  assert.equal(textscan.primaryModel, 'gemini-3.5-flash-lite', 'TextScan is not overridable');
  assert.equal(textscan.fallbackModel, null);

  const scanner = routing.resolveRoutePlan('scanner', getEnv);
  assert.equal(scanner.primaryModel, 'gemini-3.6-flash');
  assert.equal(scanner.fallbackModel, 'gemini-3.5-flash-lite', 'retired override rejected');

  const elise = routing.resolveRoutePlan('elise', getEnv);
  assert.equal(elise.primaryModel, 'gemini-3.6-flash', 'foreign model rejected');
});

// ---------------------------------------------------------------------------
// Failure classification — a status code alone is never sufficient
// ---------------------------------------------------------------------------

test('transient provider conditions are retry-eligible', () => {
  const eligible = [
    [408, {}],
    [429, { message: 'Too many requests, please slow down' }],
    [500, {}],
    [502, {}],
    [503, { status: 'UNAVAILABLE' }],
    [504, { status: 'DEADLINE_EXCEEDED' }],
  ];
  for (const [status, meta] of eligible) {
    const kind = routing.classifyProviderHttpFailure(status, meta);
    assert.equal(
      routing.isRetryableProviderFailure(kind),
      true,
      `HTTP ${status} (${kind}) should be retry-eligible`,
    );
  }
});

test('permanent conditions are never retried, including 429 quota and 504 oversized', () => {
  const permanent = [
    [400, {}, 'http_client_error'],
    [400, { message: 'input is too long for this model' }, 'oversized_context'],
    [401, {}, 'auth_error'],
    [403, {}, 'auth_error'],
    [404, {}, 'invalid_model'],
    [429, { status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota' }, 'http_429_quota'],
    [429, { message: 'billing account not configured' }, 'http_429_quota'],
    [504, { message: 'request exceeds the maximum context length' }, 'oversized_context'],
    [400, { message: 'model gemini-9 not found' }, 'invalid_model'],
  ];
  for (const [status, meta, expectedKind] of permanent) {
    const kind = routing.classifyProviderHttpFailure(status, meta);
    assert.equal(kind, expectedKind, `HTTP ${status} should classify as ${expectedKind}`);
    assert.equal(
      routing.isRetryableProviderFailure(kind),
      false,
      `HTTP ${status} (${kind}) must never be retried`,
    );
  }
});

test('the same status splits on provider detail, not on the code alone', () => {
  const transient429 = routing.classifyProviderHttpFailure(429, { message: 'rate limit' });
  const quota429 = routing.classifyProviderHttpFailure(429, { message: 'exceeded your current quota' });
  assert.notEqual(transient429, quota429);
  assert.equal(routing.isRetryableProviderFailure(transient429), true);
  assert.equal(routing.isRetryableProviderFailure(quota429), false);

  const transient504 = routing.classifyProviderHttpFailure(504, {});
  const oversized504 = routing.classifyProviderHttpFailure(504, { message: 'token count too large' });
  assert.equal(routing.isRetryableProviderFailure(transient504), true);
  assert.equal(routing.isRetryableProviderFailure(oversized504), false);
});

test('retry delay honours Retry-After and stays bounded with jitter', () => {
  assert.equal(routing.resolveRetryDelayMs(1, '1', { maxDelayMs: 2000 }), 1000);
  assert.equal(routing.resolveRetryDelayMs(1, '99', { maxDelayMs: 2000 }), 2000, 'clamped');
  assert.equal(routing.resolveRetryDelayMs(1, '0', { maxDelayMs: 2000 }), 0);

  for (const attempt of [1, 2, 3, 8]) {
    const delay = routing.resolveRetryDelayMs(attempt, null, { random: () => 1 });
    assert.ok(delay >= 0 && delay <= 2000, `attempt ${attempt} delay ${delay} must be bounded`);
  }
  const noJitter = routing.resolveRetryDelayMs(1, null, { random: () => 0 });
  const fullJitter = routing.resolveRetryDelayMs(1, null, { random: () => 1 });
  assert.ok(fullJitter > noJitter, 'jitter is applied');
});

// ---------------------------------------------------------------------------
// scan-identify wiring
// ---------------------------------------------------------------------------

test('scan-identify carries no retired model and no generic GEMINI_MODEL override', () => {
  assert.doesNotMatch(scanSource, /gemini-1\.5|gemini-2\.0|gemini-2\.5/);
  assert.doesNotMatch(
    scanSource,
    /readTrimmedEnv\('GEMINI_MODEL'\)/,
    'the generic variable must not control routing',
  );
  assert.doesNotMatch(scanSource, /const DEFAULT_MODEL/);
  assert.match(scanSource, /resolveRoutePlan\(mode === 'text' \? 'textscan' : 'scanner'/);
});

test('scan-identify selects every attempt model through the allowlist', () => {
  // The URL builder is the only place a model reaches the provider, and it is
  // only ever fed by nextAttemptModel(), which is allowlist-bound.
  assert.match(scanSource, /const buildGeminiUrl = \(model: string\)/);
  const urlCallers = scanSource.match(/buildGeminiUrl\(([^)]*)\)/g) || [];
  assert.deepEqual(
    urlCallers.filter((c) => !c.includes('model: string')),
    ['buildGeminiUrl(attemptModel)'],
    'exactly one provider URL call site, fed by the routing plan',
  );
  assert.match(scanSource, /const attemptModel = nextAttemptModel\(routePlan, attempt\);/);
  assert.match(scanSource, /if \(!attemptModel\) break;/);
});

test('scan-identify retries only eligible failures and never loops', () => {
  assert.match(scanSource, /while \(attempt < routePlan\.maxAttempts\)/);
  assert.match(
    scanSource,
    /isRetryableProviderFailure\(lastFailureKind\)\s*\n?\s*&& attempt < routePlan\.maxAttempts/,
    'retry requires an eligible class AND a remaining bounded attempt',
  );
  assert.match(scanSource, /if \(!canRetry\) break;/);
  assert.match(scanSource, /resolveRetryDelayMs\(attempt, res\.headers\.get\('retry-after'\)\)/);
});

// ---------------------------------------------------------------------------
// Account-state enforcement ordering
// ---------------------------------------------------------------------------

test('scan-identify gates account state before quota or any provider call', () => {
  assert.match(scanSource, /assertAccountActiveIfAuthenticated\(req\)/);
  const gateIndex = scanSource.indexOf('assertAccountActiveIfAuthenticated(req)');
  const bodyParseIndex = scanSource.indexOf('await req.json()');
  const providerIndex = scanSource.indexOf('buildGeminiUrl(attemptModel)');
  assert.ok(gateIndex > 0, 'the guard is present');
  assert.ok(gateIndex < bodyParseIndex, 'guard runs before request parsing');
  assert.ok(gateIndex < providerIndex, 'guard runs before the provider');
  assert.match(scanSource, /if \(accountGate\) return accountGate;/);
});

test('Elise uses the shared guard, not a local status list', () => {
  assert.match(eliseSource, /import \{ assertAccountActive \} from '\.\.\/_shared\/deletion\/common\.ts'/);
  assert.match(eliseSource, /await assertAccountActive\(userId\)/);
  assert.doesNotMatch(
    eliseSource,
    /accountStatus === 'pending_deletion' \|\| accountStatus === 'locked'/,
    'the partial two-status list is gone',
  );
  const guardIndex = eliseSource.indexOf('await assertAccountActive(userId)');
  const quotaIndex = eliseSource.indexOf(".rpc('increment_stylechat_daily_usage");
  const reserveIndex = eliseSource.indexOf('reserveGenerationOperation({');
  assert.ok(guardIndex > 0 && guardIndex < reserveIndex, 'guard precedes operation reservation');
  assert.ok(guardIndex < quotaIndex, 'guard precedes daily quota');
});

test('the shared guard fails closed and never reactivates an account', () => {
  const guard = fs.readFileSync(
    path.join(ROOT, 'supabase/functions/_shared/deletion/common.ts'),
    'utf8',
  );
  // Profile present: anything other than an unlocked active account is denied.
  assert.match(guard, /profile\.account_status !== 'active' \|\| profile\.account_locked_at/);
  // Missing profile is resolved against the Auth record and the CURRENT
  // EFFECTIVE deletion state, not treated as active.
  assert.match(guard, /isAuthUserActive/);
  assert.match(guard, /order=requested_at\.desc\.nullslast,id\.desc&limit=1/);
  assert.match(guard, /Fail closed if we cannot determine the effective deletion state/);
  for (const blocking of [
    'pending', 'processing', 'completed', 'deactivated', 'purging', 'legal_hold', 'failed',
  ]) {
    assert.match(guard, new RegExp(`'${blocking}'`), `${blocking} is a blocking state`);
  }
  // The guard may provision a missing row, but must never set a status.
  assert.doesNotMatch(guard, /account_status:\s*'active'/);
});

// ---------------------------------------------------------------------------
// Single authoritative allowlist + deployment posture
// ---------------------------------------------------------------------------

test('Elise sources its allowlist from the shared module so surfaces cannot drift', () => {
  assert.match(eliseRoutingSource, /from '\.\.\/_shared\/llmModelRouting\.ts'/);
  assert.match(eliseRoutingSource, /export const ALLOWED_MODELS = APPROVED_MODELS;/);
  assert.doesNotMatch(eliseRoutingSource, /const RETIRED_PREFIXES/, 'no second retired list');
});

test('config.toml pins JWT posture so a deploy cannot silently change it', () => {
  assert.match(configToml, /project_id = "wyyuqfdxucjksghsmhry"/);
  assert.match(configToml, /\[functions\.scan-identify\][\s\S]{0,80}verify_jwt = false/);
  assert.match(configToml, /\[functions\.stylechat-generate\][\s\S]{0,80}verify_jwt = true/);
  assert.doesNotMatch(configToml, /style-outfit-generate/, 'never declared for deployment');
});

// ---------------------------------------------------------------------------
// Telemetry and error privacy
// ---------------------------------------------------------------------------

test('routing telemetry records the route without credentials or content', () => {
  const attemptLogs = scanSource.match(/console\.(warn|log)\(\s*'\[scan-identify\] gemini_[^']*'/g) || [];
  assert.ok(attemptLogs.length >= 2, 'attempt and success routing telemetry exist');
  for (const forbidden of [
    'geminiKey',
    'imageBase64',
    'textQuery',
    'Authorization',
    'apikey',
    'access_token',
    'refresh_token',
  ]) {
    const logLines = scanSource
      .split('\n')
      .filter((l) => /console\.(log|warn|error)/.test(l) && l.includes(forbidden))
      // A size or presence measurement is not the value itself.
      .filter((l) => !new RegExp(`${forbidden}\\.length`).test(l))
      .filter((l) => !new RegExp(`Boolean\\(${forbidden}\\)`).test(l));
    assert.deepEqual(logLines, [], `${forbidden} must never be logged as a value`);
  }
});

test('provider failures never reach the user as raw provider or model detail', () => {
  // The failure response is a fixed safe message, not the provider payload.
  assert.match(scanSource, /return json\(normalized\('failed', safeFailed\), 200\);/);
  const failureBlock = scanSource.slice(
    scanSource.indexOf("console.warn(\n        '[scan-identify] gemini_http_error"),
    scanSource.indexOf('gemini_success'),
  );
  assert.doesNotMatch(failureBlock, /raw/, 'the raw provider body is not returned');
  assert.doesNotMatch(scanSource, /json\(\{[^}]*geminiUrl/);
  assert.doesNotMatch(scanSource, /json\(\{[^}]*geminiKey/);
});
