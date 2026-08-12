'use strict';

/**
 * Build 29 system-integration contracts.
 *
 * Covers the two cross-feature contracts that only exist once the observability
 * foundation and the product surfaces are in the same tree:
 *
 *   DEF-B29-INT-OBS-P4-001  the correlation response wrapper vs every consumer
 *   DEF-B29-INT-OBS-P4-002  the Sentry transaction boundary
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const policy = require('../services/observabilitySentryPolicy');
// `types/privateDressingRoomElise.ts` is dependency-free TypeScript; the repo's
// established pattern is to transpile it in-process rather than add a build step.
const ts = require('typescript');
const vm = require('node:vm');
const parsePrivateEliseResponse = (() => {
  const source = fs.readFileSync(path.join(ROOT, 'types/privateDressingRoomElise.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, require, console });
  return mod.exports.parsePrivateEliseResponse;
})();

/* ===================================================================== *
 * P4-001 — correlation response contract
 *
 * `withCorrelationResponse` adds a `correlation` key to the JSON body of every
 * wrapped Edge Function. The hostile audit called that intentional and
 * non-breaking; integration has to prove it against the real consumers.
 * ===================================================================== */

const WRAPPED_FUNCTIONS = ['scan-identify', 'stylechat-generate', 'style-outfit-generate'];

test('P4-001: every wrapped Edge Function is actually wrapped', () => {
  for (const fn of WRAPPED_FUNCTIONS) {
    const source = fs.readFileSync(path.join(ROOT, 'supabase/functions', fn, 'index.ts'), 'utf8');
    assert.match(source, /observeEdgeRequest\(/, `${fn} is not wrapped`);
  }
});

test('P4-001: correlation metadata is bounded, content-blind and non-user-derived', () => {
  const shared = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/observability.ts'), 'utf8');

  // Exactly two fields, both K Scan-minted identifiers.
  assert.match(shared, /correlation:\s*\{\s*requestId: context\.requestId,\s*traceId: context\.traceId\s*\}/);

  // Both are CSPRNG-derived, not derived from the user or the request body.
  assert.match(shared, /crypto\.getRandomValues/);
  assert.match(shared, /const REQUEST_ID_RE = \/\^ksr_\[a-f0-9\]\{32\}\$\//);

  // An inbound id is only reused when it matches the minted shape; anything
  // else is replaced rather than echoed, so a caller cannot inject content.
  assert.match(shared, /isValidRequestId\(incomingRequestId\) \? incomingRequestId : createRequestId\(\)/);
  assert.match(shared, /isValidTraceparent\(incomingTraceparent\)/);
});

test('P4-001: no client persists or surfaces correlation metadata as product state', () => {
  const roots = ['services', 'app', 'components', 'contexts', 'hooks', 'stores', 'src'];
  const offenders = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        // Reading `.correlation` off an Edge response would mean the wrapper
        // had become product state rather than transport metadata.
        if (/\bdata\?\.correlation\b|\bresponse\.correlation\b|\bpayload\.correlation\b/.test(text)) {
          offenders.push(path.relative(ROOT, full));
        }
      }
    }
  };
  roots.forEach((r) => walk(path.join(ROOT, r)));
  assert.deepEqual(offenders, [], 'correlation metadata must stay transport-only');
});

test('P4-001: the Elise response parser ignores additive correlation metadata', () => {
  const expected = {
    requestId: 'req-1',
    intent: 'style_advice',
    authorizedRefs: [],
  };
  const base = {
    schemaVersion: 1,
    requestId: 'req-1',
    intent: 'style_advice',
    status: 'ok',
  };

  const without = parsePrivateEliseResponse({ ...base }, expected);
  const withCorrelation = parsePrivateEliseResponse(
    { ...base, correlation: { requestId: `ksr_${'a'.repeat(32)}`, traceId: 'b'.repeat(32) } },
    expected,
  );

  assert.equal(without.ok, withCorrelation.ok, 'correlation changed whether the reply parses');
  if (without.ok) {
    // The parser rebuilds from an allowlist, so the wrapper cannot reach the
    // product object either.
    assert.deepEqual(withCorrelation.value, without.value);
    assert.equal('correlation' in withCorrelation.value, false);
  }
});

test('P4-001: no Edge response consumer rejects unknown top-level keys', () => {
  // A consumer that enumerated keys and refused unknowns would break the moment
  // the wrapper added one. None may do so.
  const consumers = [
    'services/scanIdentification.ts',
    'services/style-chat/providers/edgeStyleChatProvider.ts',
    'services/styleOutfits.ts',
    'types/privateDressingRoomElise.ts',
  ];
  for (const rel of consumers) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(
      text,
      /additionalProperties\s*:\s*false|unexpected_key|unknown_key|Object\.keys\([^)]*\)\.length\s*===\s*\d+/,
      `${rel} appears to reject unknown response keys`,
    );
  }
});

/* ===================================================================== *
 * P4-002 — Sentry transaction boundary
 * ===================================================================== */

const SYN = {
  prompt: 'SYNTHPROMPT style me in a red silk dress for a gallery opening',
  email: 'elise.tester@example.invalid',
  signedUrl: 'https://synth.supabase.co/storage/v1/object/sign/closet/u1/g.jpg?token=abc123',
  imagePath: 'closet/3f2a1b4c-5d6e-7f80-9a0b-1c2d3e4f5061/garment-front.jpg',
  sql: "select * from closet_items where user_id = '3f2a1b4c-5d6e-7f80-9a0b-1c2d3e4f5061'",
  bearer: 'Bearer sbp_synthetic0123456789abcdef',
  userUuid: '3f2a1b4c-5d6e-7f80-9a0b-1c2d3e4f5061',
};

function hostileTransaction() {
  return {
    type: 'transaction',
    event_id: 'a'.repeat(32),
    start_timestamp: 1786533232.1,
    timestamp: 1786533233.4,
    platform: 'javascript',
    environment: 'staging',
    release: 'staging-build29-001',
    dist: 'github-4242-1',
    transaction: `/rooms/${SYN.userUuid}/elise`,
    transaction_info: { source: 'url' },
    user: { id: SYN.userUuid, email: SYN.email },
    request: { url: SYN.signedUrl, headers: { Authorization: SYN.bearer } },
    extra: { prompt: SYN.prompt },
    measurements: { custom_user_metric: { value: 1, unit: 'none' } },
    tags: { prompt: SYN.prompt, email: SYN.email, operation: 'elise_request' },
    contexts: {
      trace: {
        trace_id: 'c'.repeat(32),
        span_id: 'd'.repeat(16),
        parent_span_id: 'e'.repeat(16),
        op: 'elise.request',
        status: 'ok',
        data: { 'http.url': SYN.signedUrl, prompt: SYN.prompt },
      },
      device: { model: 'iPhone15,2' },
      elise: { message: SYN.prompt },
    },
    spans: [
      {
        span_id: '1'.repeat(16),
        parent_span_id: 'd'.repeat(16),
        trace_id: 'c'.repeat(32),
        op: 'http.client',
        description: `POST ${SYN.signedUrl}`,
        status: 'ok',
        start_timestamp: 1786533232.2,
        timestamp: 1786533232.9,
        data: { 'http.url': SYN.signedUrl, 'http.request.header.authorization': SYN.bearer },
        tags: { image: SYN.imagePath },
      },
      {
        span_id: '2'.repeat(16),
        trace_id: 'c'.repeat(32),
        op: 'db.query',
        description: SYN.sql,
        start_timestamp: 1786533232.3,
        timestamp: 1786533232.5,
        data: { 'db.statement': SYN.sql },
      },
    ],
  };
}

test('P4-002: a transaction keeps the structure the provider contract requires', () => {
  const out = policy.sanitizeProviderTransaction(hostileTransaction());
  assert.ok(out, 'a well-formed transaction must not be dropped');
  assert.equal(out.type, 'transaction');
  // start_timestamp and spans are exactly what the error sanitizer dropped.
  assert.equal(typeof out.start_timestamp, 'number');
  assert.equal(typeof out.timestamp, 'number');
  assert.ok(Array.isArray(out.spans) && out.spans.length === 2);
  assert.equal(out.contexts.trace.trace_id, 'c'.repeat(32));
  assert.equal(out.contexts.trace.span_id, 'd'.repeat(16));
  assert.equal(out.contexts.trace.parent_span_id, 'e'.repeat(16));
  assert.equal(out.spans[0].parent_span_id, 'd'.repeat(16));
  assert.equal(typeof out.spans[0].start_timestamp, 'number');
  assert.equal(typeof out.spans[0].timestamp, 'number');
  assert.equal(out.release, 'staging-build29-001');
  assert.equal(out.dist, 'github-4242-1');
});

test('P4-002: no synthetic private marker survives a hostile transaction', () => {
  const serialized = JSON.stringify(policy.sanitizeProviderTransaction(hostileTransaction()));
  for (const [name, value] of Object.entries(SYN)) {
    assert.equal(serialized.includes(value), false, `transaction leaked ${name}`);
  }
  // And the containers those markers arrived in are gone outright.
  const out = JSON.parse(serialized);
  assert.equal(out.user, undefined);
  assert.equal(out.request, undefined);
  assert.equal(out.extra, undefined);
  assert.equal(out.measurements, undefined);
  assert.equal(out.contexts.elise, undefined);
  assert.equal(out.contexts.trace.data, undefined);
  for (const span of out.spans) {
    assert.equal(span.description, undefined);
    assert.equal(span.data, undefined);
    assert.equal(span.tags, undefined);
  }
});

test('P4-002: transaction identity is de-identified and bounded', () => {
  const out = policy.sanitizeProviderTransaction(hostileTransaction());
  assert.equal(out.transaction.includes(SYN.userUuid), false);
  assert.match(out.transaction, /:id/);
  assert.ok(out.transaction.length <= 80);
  assert.equal(out.transaction_info.source, 'custom');

  // A free-prose transaction name cannot pass the diagnostic-token rule.
  const prose = policy.sanitizeProviderTransaction({
    ...hostileTransaction(),
    transaction: SYN.prompt,
  });
  assert.equal(prose.transaction.includes('SYNTHPROMPT'), false);
});

test('P4-002: operation labels are a bounded allowlist', () => {
  assert.equal(policy.normalizeSpanOp('http.client'), 'http.client');
  assert.equal(policy.normalizeSpanOp('elise.request'), 'elise.request');
  // Arbitrary, user-influenced or high-cardinality ops collapse.
  assert.equal(policy.normalizeSpanOp(`GET ${SYN.signedUrl}`), 'other');
  assert.equal(policy.normalizeSpanOp(SYN.prompt), 'other');
  assert.equal(policy.normalizeSpanOp('closet.rpc'), 'closet.rpc');
  assert.ok(policy.ALLOWED_SPAN_OPS.size > 0);
});

test('P4-002: tags on a transaction are still allowlisted', () => {
  const out = policy.sanitizeProviderTransaction(hostileTransaction());
  assert.deepEqual(Object.keys(out.tags), ['operation']);
});

test('P4-002: a transaction that cannot be attributed fails closed', () => {
  const noTrace = hostileTransaction();
  delete noTrace.contexts.trace;
  assert.equal(policy.sanitizeProviderTransaction(noTrace), null);

  const noStart = hostileTransaction();
  delete noStart.start_timestamp;
  assert.equal(policy.sanitizeProviderTransaction(noStart), null);

  assert.equal(policy.sanitizeProviderTransaction(null), null);
  assert.equal(policy.sanitizeProviderTransaction('nope'), null);
  assert.equal(policy.sanitizeProviderTransaction({ type: 'replay_event' }), null);
});

test('P4-002: beforeSendTransaction is bound to the transaction sanitizer, not the event one', () => {
  const decision = policy.resolveProviderDecision({
    env: {
      EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENABLED: 'true',
      EXPO_PUBLIC_SENTRY_DSN: 'https://abc123def456@o123456.ingest.sentry.io/7891011',
      EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENVIRONMENT: 'staging',
    },
    observability: {
      contractVersion: 'build29-observability-v1',
      environment: 'staging',
      releaseId: 'staging-build29-001',
      sourceSha: 'c6c0c15a456065dca475ef4fada71e4ca55332fc',
      sourceAttributionState: 'VERIFIABLE',
    },
    appVersion: '1.0.1',
    build: '29',
    platform: 'ios',
  });
  const options = policy.buildProviderOptions(decision);
  assert.equal(options.beforeSendTransaction, policy.sanitizeProviderTransaction);
  assert.equal(options.beforeSend, policy.sanitizeProviderEvent);

  // Regression pin: the error sanitizer must NOT be able to serve as the
  // transaction boundary, because it drops the required fields.
  const asEvent = policy.sanitizeProviderEvent(hostileTransaction());
  assert.equal(asEvent.start_timestamp, undefined);
  assert.equal(asEvent.spans, undefined);
});

test('P4-002: tracing activation is unchanged by this repair', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/observabilitySentryPolicy.js'), 'utf8');
  assert.match(source, /tracesSampleRate: decision\.environment === 'production' \? 0\.05 : 0\.2/);
  // Still no replay, still no structured logs.
  assert.match(source, /enableLogs: false/);
  assert.doesNotMatch(source, /replaysSessionSampleRate:/);
  assert.doesNotMatch(source, /replaysOnErrorSampleRate:/);
});

/* ===================================================================== *
 * Cross-feature: observability instrumentation still reaches the product
 * surfaces PR #111 restored.
 * ===================================================================== */

test('integration: actor-switch cleanup still resets correlation identity', () => {
  const auth = fs.readFileSync(path.join(ROOT, 'contexts/AuthSessionContext.tsx'), 'utf8');
  const fn = auth.slice(auth.indexOf('function resetActorScopedRuntimeState'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /advanceActorEpoch\(/);
  assert.match(body, /resetCorrelationContext\(\)/);
  // And it is the function every actor transition funnels through.
  assert.ok(
    (auth.match(/resetActorScopedRuntimeState\(/g) || []).length >= 4,
    'actor transitions must funnel through one cleanup path',
  );
});

test('integration: every correlated call site sends both correlation headers', () => {
  const callSites = [
    'services/scanIdentification.ts',
    'services/textScanEdge.ts',
    'services/styleOutfits.ts',
    'services/style-chat/providers/edgeStyleChatProvider.ts',
    'services/privateDressingRoomEliseClient.ts',
  ];
  for (const rel of callSites) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(text, /createCorrelationContext\(\)/, `${rel} mints no correlation context`);
    assert.match(text, /headers: correlationHeaders\(correlation\)/, `${rel} does not send the headers`);
  }
});

test('integration: every correlated Edge Function accepts the correlation headers through CORS', () => {
  for (const fn of WRAPPED_FUNCTIONS) {
    const source = fs.readFileSync(path.join(ROOT, 'supabase/functions', fn, 'index.ts'), 'utf8');
    const cors = /'Access-Control-Allow-Headers': '([^']*)'/.exec(source);
    assert.ok(cors, `${fn} declares no Access-Control-Allow-Headers`);
    assert.match(cors[1], /x-kscan-request-id/, `${fn} would reject the request-id header on preflight`);
    assert.match(cors[1], /traceparent/, `${fn} would reject traceparent on preflight`);
  }
});

test('integration: the restored Apple functions are release-classified', () => {
  const gov = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'security/release/edge-function-governance.json'), 'utf8'),
  );
  const dirs = fs
    .readdirSync(path.join(ROOT, 'supabase/functions'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '_shared')
    .map((e) => e.name);
  const unclassified = dirs.filter((name) => !gov.functions[name]);
  assert.deepEqual(unclassified, [], 'every repository Edge Function needs an explicit classification');
  assert.equal(gov.functions['apple-credential-link'].class, 'GOVERNED');
  assert.equal(gov.functions['apple-revoke-credential'].class, 'GOVERNED');
});
