'use strict';

/**
 * Build 29 observability — hostile audit regression suite.
 *
 * Every test here corresponds to a defect that was PROVEN present on
 * c6c0c15 (the Sentry provider integration commit) by executing the shipped
 * code, not by reading it. Each one fails against the pre-fix implementation.
 *
 * The audit trail is deliberate: these are named for the defect they pin, so a
 * later refactor that reintroduces one is recognisable as a regression rather
 * than a new discovery.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const policy = require('../services/observabilitySentryPolicy');
const redaction = require('../services/observabilityRedaction');

const GOOD_DSN = 'https://abc123def456@o123456.ingest.sentry.io/7891011';
const SOURCE_SHA = 'c6c0c15a456065dca475ef4fada71e4ca55332fc';

function decisionInput(overrides = {}) {
  return {
    env: {
      EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENABLED: 'true',
      EXPO_PUBLIC_SENTRY_DSN: GOOD_DSN,
      EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENVIRONMENT: 'staging',
      ...(overrides.env || {}),
    },
    observability: {
      contractVersion: 'build29-observability-v1',
      environment: 'staging',
      releaseId: 'staging-build29-001',
      sourceSha: SOURCE_SHA,
      sourceAttributionState: 'VERIFIABLE',
      ...(overrides.observability || {}),
    },
    appVersion: '1.0.1',
    build: overrides.build === undefined ? '29' : overrides.build,
    platform: 'ios',
  };
}

/* ------------------------------------------------------------------ *
 * DEF-OBS-AUD-001 — an npm lifecycle hook aborted every EAS build.
 * ------------------------------------------------------------------ */

test('DEF-001: no EAS lifecycle hook can fail a build on identity no profile supplies', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const eas = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
  const hooks = Object.keys(pkg.scripts || {}).filter((name) => name.startsWith('eas-build-'));

  const { validateObservabilityBuildEnvironment } = await import(
    pathToFileURL(path.join(ROOT, 'scripts/verify-observability-build-env.mjs'))
  );

  for (const [profileName, profile] of Object.entries(eas.build || {})) {
    // Exactly what an EAS worker has: the profile's own env plus the variables
    // EAS itself injects. Nothing supplies KSCAN_RELEASE_ID.
    const easEnvironment = {
      ...(profile.env || {}),
      EAS_BUILD_PROFILE: profileName,
      EAS_BUILD_ID: '1f2e3d4c-5b6a-7890-abcd-ef0123456789',
      EAS_BUILD_GIT_COMMIT_HASH: SOURCE_SHA,
    };
    const result = validateObservabilityBuildEnvironment(easEnvironment);

    if (hooks.length > 0 && !result.ok) {
      assert.fail(
        `eas.json profile "${profileName}" cannot satisfy ${hooks.join(', ')}: ` +
          `${result.errors.join('; ')}. A build-blocking hook must only assert on ` +
          'identity the build invocation actually supplies.',
      );
    }
  }

  // The validator itself must stay strict — it is still the gate the source-map
  // workflow runs, where the identity IS supplied.
  assert.equal(validateObservabilityBuildEnvironment({}).ok, false);
});

/* ------------------------------------------------------------------ *
 * DEF-OBS-AUD-002 — runtime `dist` could never equal the uploaded `dist`.
 * ------------------------------------------------------------------ */

test('DEF-002: the dist events report is the dist source maps are filed under', async () => {
  const { validateObservabilityBuildEnvironment } = await import(
    pathToFileURL(path.join(ROOT, 'scripts/verify-observability-build-env.mjs'))
  );

  const previous = { ...process.env };
  try {
    // One build environment, evaluated by BOTH sides of the contract.
    process.env.KSCAN_OBSERVABILITY_ENVIRONMENT = 'staging';
    process.env.KSCAN_RELEASE_ID = 'staging-build29-001';
    process.env.KSCAN_SOURCE_SHA = SOURCE_SHA;
    process.env.KSCAN_OBSERVABILITY_DISTRIBUTION = 'staging';
    process.env.KSCAN_BUILD_IDENTIFIER = 'github-4242-1';
    delete process.env.EAS_BUILD_ID;
    delete process.env.EAS_BUILD_PROFILE;
    delete process.env.GITHUB_RUN_ID;

    // Upload side: what `--dist` the provider handoff passes to sentry-cli.
    const validation = validateObservabilityBuildEnvironment(process.env);
    assert.equal(validation.ok, true, validation.errors.join('; '));
    const uploadedDist = validation.identity.buildIdentifier;

    // Runtime side: what the installed app reports as `dist`.
    delete require.cache[require.resolve('../app.config.js')];
    const resolveConfig = require('../app.config.js');
    const config = resolveConfig({ config: { version: '1.0.1', extra: {} } });

    const decision = policy.resolveProviderDecision({
      ...decisionInput({ observability: config.extra.observability }),
      build: '29', // the native version code, deliberately different
    });

    assert.equal(decision.enabled, true, decision.reason);
    assert.equal(
      decision.dist,
      uploadedDist,
      'Sentry matches an event to its source maps on (release, dist). A runtime ' +
        'dist that differs from the uploaded dist means nothing ever symbolicates.',
    );
    assert.equal(decision.release, validation.identity.releaseId);
    // The human-readable native build number survives as a tag.
    assert.equal(decision.tags.build, '29');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    delete require.cache[require.resolve('../app.config.js')];
  }
});

test('DEF-002: with no governed build identifier the native build number is used', () => {
  const decision = policy.resolveProviderDecision(
    decisionInput({ observability: { buildIdentifier: null } }),
  );
  assert.equal(decision.enabled, true);
  assert.equal(decision.dist, '29');
});

/* ------------------------------------------------------------------ *
 * DEF-OBS-AUD-003 — the outbound envelope was not content-blind.
 * ------------------------------------------------------------------ */

const PROMPT = 'SYNTHPROMPT style me in a red silk dress for a gallery opening tonight';
const AI_REPLY = 'SYNTHAIRESP I would pair the red silk with gold heels and a clutch';
const STORAGE_PATH = 'closet/3f2a1b4c-5d6e-7f80-9a0b-1c2d3e4f5061/garment-front.jpg';

test('DEF-003: an unlisted context container is dropped whole, not shape-redacted', () => {
  const event = policy.sanitizeProviderEvent({
    event_id: 'a'.repeat(32),
    contexts: {
      device: { model: 'iPhone15,2', memory_size: 6000000000 },
      os: { name: 'iOS', version: '17.5' },
      // Prose has no redactable SHAPE. Only an allowlist can refuse it.
      scanner: { note: PROMPT },
      response: { body: AI_REPLY },
      elise: { storagePath: STORAGE_PATH },
    },
  });

  assert.deepEqual(Object.keys(event.contexts).sort(), ['device', 'os']);
  const serialized = JSON.stringify(event);
  assert.ok(!serialized.includes(PROMPT), 'prompt text reached the envelope');
  assert.ok(!serialized.includes(AI_REPLY), 'AI response text reached the envelope');
  assert.ok(!serialized.includes(STORAGE_PATH), 'storage path reached the envelope');
});

test('DEF-003: exception values and types are reduced to diagnostic tokens', () => {
  const event = policy.sanitizeProviderEvent({
    exception: {
      values: [
        { type: 'Error', value: `${PROMPT} || ${AI_REPLY}` },
        { type: 'TEXTSCAN_TIMEOUT', value: 'MALFORMED_EDGE_RESPONSE' },
      ],
    },
  });

  // Free prose is refused outright...
  assert.equal(event.exception.values[0].value, redaction.REDACTED);
  // ...while K Scan's own error contract survives intact.
  assert.equal(event.exception.values[1].type, 'TEXTSCAN_TIMEOUT');
  assert.equal(event.exception.values[1].value, 'MALFORMED_EDGE_RESPONSE');
  assert.ok(!JSON.stringify(event).includes('SYNTHPROMPT'));
});

test('DEF-003: stack frames keep structure but never carry source text', () => {
  const event = policy.sanitizeProviderEvent({
    exception: {
      values: [{
        type: 'Error',
        value: 'boom',
        stacktrace: {
          frames: [{
            filename: 'app:///src/screens/Elise.tsx',
            function: 'sendMessage',
            lineno: 42,
            colno: 7,
            in_app: true,
            pre_context: [`const prompt = "${PROMPT}";`],
            context_line: `await send("${AI_REPLY}");`,
            post_context: ['}'],
            vars: { prompt: PROMPT },
          }],
        },
      }],
    },
    threads: { values: [{ stacktrace: { frames: [{ context_line: PROMPT }] } }] },
  });

  const frame = event.exception.values[0].stacktrace.frames[0];
  assert.equal(frame.filename, 'app:///src/screens/Elise.tsx');
  assert.equal(frame.function, 'sendMessage');
  assert.equal(frame.lineno, 42);
  for (const key of policy.SOURCE_BEARING_FRAME_KEYS) {
    assert.ok(!(key in frame), `frame retained source-bearing field ${key}`);
  }
  assert.ok(!JSON.stringify(event).includes('SYNTHPROMPT'));
  assert.ok(!JSON.stringify(event).includes('SYNTHAIRESP'));
});

test('DEF-003: camelCase spellings of sensitive keys are recognised', () => {
  for (const key of ['storagePath', 'storage_path', 'signedUrl', 'signed_url', 'accessToken', 'apiKey']) {
    assert.equal(
      redaction.isSensitiveObservabilityKey(key),
      true,
      `${key} was not recognised as sensitive`,
    );
  }
  // Backend parity: `sql` is on the backend list and must be on this one too.
  assert.equal(redaction.isSensitiveObservabilityKey('sql'), true);
  assert.equal(redaction.isSensitiveObservabilityKey('rawSql'), true);
});

test('DEF-003: the mobile and backend sensitive-key lists have not drifted', () => {
  const backend = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/observability.ts'), 'utf8');
  const block = /const SENSITIVE_KEY_FRAGMENTS[^=]*=\s*\[([\s\S]*?)\]/.exec(backend);
  assert.ok(block, 'backend fragment list not found');
  const backendFragments = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    [...redaction.SENSITIVE_KEY_FRAGMENTS].sort(),
    backendFragments,
    'one privacy boundary means one list; these two have diverged',
  );
});

/* ------------------------------------------------------------------ *
 * DEF-OBS-AUD-004 — redaction silently destroyed correlation identity.
 * ------------------------------------------------------------------ */

test('DEF-004: correlation identifiers survive redaction', () => {
  // This exact id is destroyed by the phone-number heuristic without the
  // correlation-identifier exemption: it contains a 10-digit run.
  const hostile = 'a1234567890bcdef0123456789abcdef';
  assert.equal(/\+?\d[\d\s().-]{7,}\d/.test(hostile), true, 'fixture no longer exercises the heuristic');
  assert.equal(redaction.redactObservabilityValue(hostile), hostile);

  const context = redaction.buildObservabilityContext({
    trace_id: hostile,
    request_id: `ksr_${hostile}`,
    source_sha: SOURCE_SHA,
  });
  assert.equal(context.trace_id, hostile);
  assert.equal(context.request_id, `ksr_${hostile}`);
  assert.equal(context.source_sha, SOURCE_SHA);
});

test('DEF-004: no randomly generated correlation id is lost', () => {
  let lost = 0;
  for (let i = 0; i < 5000; i += 1) {
    const traceId = crypto.randomBytes(16).toString('hex');
    const requestId = `ksr_${crypto.randomBytes(16).toString('hex')}`;
    const context = redaction.buildObservabilityContext({ trace_id: traceId, request_id: requestId });
    if (context.trace_id !== traceId || context.request_id !== requestId) lost += 1;
  }
  assert.equal(lost, 0, `${lost}/5000 correlation contexts lost their identity`);
});

test('DEF-004: the exemption is shape-bound and does not weaken redaction', () => {
  // A bearer token, a JWT and an email are still refused.
  assert.equal(redaction.redactObservabilityValue('Bearer sbp_abcdef0123456789'), redaction.REDACTED);
  assert.equal(redaction.redactObservabilityValue('eyJhbGciOiJIUzI1NiJ9.abc'), redaction.REDACTED);
  assert.equal(redaction.redactObservabilityValue('a@b.co'), redaction.REDACTED);
  // Hex of the wrong length is not a K Scan identifier and gets no exemption.
  assert.equal(redaction.isCorrelationIdentifier('a'.repeat(33)), false);
  assert.equal(redaction.isCorrelationIdentifier('ksr_' + 'a'.repeat(31)), false);
  assert.equal(redaction.isCorrelationIdentifier('DEADBEEF'.repeat(4)), false); // uppercase
});

/* ------------------------------------------------------------------ *
 * DEF-OBS-AUD-005 — errors caught by the boundary reached no provider.
 * ------------------------------------------------------------------ */

test('DEF-005: a handled exception raises a provider event, not just a breadcrumb', () => {
  policy.resetProviderForTests();
  const captured = [];
  const breadcrumbs = [];
  let exceptionSink = null;

  const state = policy.initializeProvider(
    {
      init() {},
      setTags() {},
      setUser() {},
      setTag() {},
      addBreadcrumb(bc) { breadcrumbs.push(bc); },
      captureException(error, hint) { captured.push({ error, hint }); },
    },
    decisionInput(),
    {
      onSink() {},
      onException(fn) { exceptionSink = fn; },
    },
  );

  assert.equal(state.enabled, true, state.reason);
  assert.equal(typeof exceptionSink, 'function', 'no exception sink was registered');

  const boundaryError = new Error('MALFORMED_EDGE_RESPONSE');
  exceptionSink(boundaryError, {
    operation: 'error_boundary_render',
    error_category: 'TypeError',
    request_id: `ksr_${'a'.repeat(32)}`,
  });

  assert.equal(captured.length, 1, 'the boundary failure produced no provider event');
  assert.equal(captured[0].error, boundaryError);
  assert.equal(captured[0].hint.level, 'error');
  assert.equal(captured[0].hint.tags.operation, 'error_boundary_render');
  assert.equal(captured[0].hint.tags.error_category, 'TypeError');
  policy.resetProviderForTests();
});

test('DEF-005: the render-error boundary is wired to the capture path', () => {
  // The executable proof of the mechanism is the test above; this pins the one
  // call site that a boundary swallows and nothing else can observe.
  const source = fs.readFileSync(path.join(ROOT, 'src/components/ErrorBoundary.tsx'), 'utf8');
  const didCatch = source.slice(source.indexOf('componentDidCatch'));
  assert.match(
    didCatch.slice(0, didCatch.indexOf('\n  }')),
    /captureHandledException\(/,
    'componentDidCatch must raise an event: React boundaries swallow the error, ' +
      'ErrorUtils never sees it, and Sentry.wrap installs no boundary of its own',
  );
});

test('DEF-005: capture tags are still allowlisted', () => {
  policy.resetProviderForTests();
  const captured = [];
  let exceptionSink = null;
  policy.initializeProvider(
    {
      init() {}, setTags() {}, setUser() {}, setTag() {}, addBreadcrumb() {},
      captureException(error, hint) { captured.push(hint); },
    },
    decisionInput(),
    { onException(fn) { exceptionSink = fn; } },
  );
  exceptionSink(new Error('x'), { operation: 'error_boundary_render', prompt: PROMPT, email: 'a@b.co' });
  assert.deepEqual(Object.keys(captured[0].tags), ['operation']);
  policy.resetProviderForTests();
});

/* ------------------------------------------------------------------ *
 * DEF-OBS-AUD-006 — profiles that need no DSN gained a variable source.
 * ------------------------------------------------------------------ */

test('DEF-006: only provider-enabled profiles declare an EAS environment', () => {
  const eas = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
  for (const [name, profile] of Object.entries(eas.build || {})) {
    const enabled = (profile.env || {}).EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENABLED === 'true';
    if (!enabled) {
      assert.equal(
        profile.environment,
        undefined,
        `profile "${name}" runs with the provider OFF and needs no DSN, so it must ` +
          'not pull an EAS-hosted variable set this change never reviewed',
      );
    }
  }
  // Production specifically stays OFF for Build 29.
  assert.equal(eas.build.production.env.EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENABLED, 'false');
  assert.equal(eas.build.production.environment, undefined);
});
