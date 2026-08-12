'use strict';

/**
 * Build 29 — Sentry provider integration contract.
 *
 * Sentry is the transport. These tests certify that it cannot become the source
 * of truth for release identity, cannot mint a competing request-ID
 * architecture, cannot start replay or structured logs, cannot attach user
 * identity, and cannot carry prompt/image/message/email/token data off device.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const policy = require('../services/observabilitySentryPolicy');

const VALID_DSN = 'https://fb3dbddd65b1309b159028db0693f00d@o4511897245908992.ingest.us.sentry.io/4511897268518912';
const SOURCE_SHA = 'a'.repeat(40);

function observabilityExtra(overrides = {}) {
  return {
    contractVersion: 'build29-observability-v1',
    environment: 'staging',
    releaseId: 'staging-build29-001',
    sourceSha: SOURCE_SHA,
    sourceAttributionState: 'VERIFIABLE',
    replayEnabled: false,
    ...overrides,
  };
}

function enabledInput(overrides = {}) {
  return {
    env: {
      EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENABLED: 'true',
      EXPO_PUBLIC_SENTRY_DSN: VALID_DSN,
      ...(overrides.env || {}),
    },
    observability: observabilityExtra(overrides.observability || {}),
    appVersion: '1.0.1',
    build: '23',
    platform: 'ios',
  };
}

/** A recording stand-in for the Sentry SDK surface the runtime touches. */
function fakeSdk(behaviour = {}) {
  const calls = { init: [], setTags: [], setUser: [], setTag: [], breadcrumbs: [] };
  return {
    calls,
    init(options) {
      if (behaviour.throwOnInit) throw new Error('native SDK unavailable');
      calls.init.push(options);
    },
    setTags(tags) { calls.setTags.push(tags); },
    setUser(user) { calls.setUser.push(user); },
    setTag(key, value) { calls.setTag.push([key, value]); },
    addBreadcrumb(crumb) { calls.breadcrumbs.push(crumb); },
  };
}

test.beforeEach(() => policy.resetProviderForTests());
test.after(() => policy.resetProviderForTests());

/* ------------------------------------------------------------------ */
/* Fail-OFF configuration                                              */
/* ------------------------------------------------------------------ */

test('missing observability flag fails OFF', () => {
  const decision = policy.resolveProviderDecision({
    env: { EXPO_PUBLIC_SENTRY_DSN: VALID_DSN },
    observability: observabilityExtra(),
  });
  assert.equal(decision.enabled, false);
  assert.equal(decision.reason, policy.DECISION_REASONS.FLAG_MISSING);
  assert.equal(decision.dsn, null);
});

test('malformed observability flag fails OFF rather than guessing', () => {
  for (const value of ['1', 'yes', 'on', 'TRUE!', 'enabled', ' ture ']) {
    const decision = policy.resolveProviderDecision({
      ...enabledInput(),
      env: { EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENABLED: value, EXPO_PUBLIC_SENTRY_DSN: VALID_DSN },
    });
    assert.equal(decision.enabled, false, `flag ${JSON.stringify(value)} must not enable`);
    assert.equal(decision.reason, policy.DECISION_REASONS.FLAG_MALFORMED);
  }
});

test('explicit false disables without being treated as malformed', () => {
  const decision = policy.resolveProviderDecision({
    ...enabledInput(),
    env: { EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENABLED: 'false', EXPO_PUBLIC_SENTRY_DSN: VALID_DSN },
  });
  assert.equal(decision.enabled, false);
  assert.equal(decision.reason, policy.DECISION_REASONS.FLAG_OFF);
});

test('missing DSN fails OFF', () => {
  for (const dsn of [undefined, '', '   ']) {
    const input = enabledInput();
    input.env.EXPO_PUBLIC_SENTRY_DSN = dsn;
    const decision = policy.resolveProviderDecision(input);
    assert.equal(decision.enabled, false);
    assert.equal(decision.reason, policy.DECISION_REASONS.DSN_MISSING);
  }
});

test('malformed DSN fails OFF', () => {
  for (const dsn of ['not-a-dsn', 'http://key@host/1', 'https://sentry.io/1', 'https://key@host/']) {
    const input = enabledInput();
    input.env.EXPO_PUBLIC_SENTRY_DSN = dsn;
    const decision = policy.resolveProviderDecision(input);
    assert.equal(decision.enabled, false, `DSN ${dsn} must not enable`);
    assert.equal(decision.reason, policy.DECISION_REASONS.DSN_MALFORMED);
  }
});

test('unsupported environment fails OFF', () => {
  // Exact match only: `app.config.js` emits one of three canonical values, so a
  // case/whitespace variant means the build stamp was rewritten, not mistyped.
  for (const environment of ['qa', 'prod', '', 'Production ', 'STAGING', ' staging', null, 7]) {
    const decision = policy.resolveProviderDecision(enabledInput({ observability: { environment } }));
    assert.equal(decision.enabled, false, `environment ${JSON.stringify(environment)} must not enable`);
    assert.equal(decision.reason, policy.DECISION_REASONS.ENVIRONMENT_UNSUPPORTED);
  }
});

test('environment mismatch between build stamp and config fails OFF', () => {
  const input = enabledInput();
  input.env.EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENVIRONMENT = 'production';
  const decision = policy.resolveProviderDecision(input);
  assert.equal(decision.enabled, false);
  assert.equal(decision.reason, policy.DECISION_REASONS.ENVIRONMENT_MISMATCH);
});

test('unverifiable or absent release identity fails OFF', () => {
  const cases = [
    { sourceAttributionState: 'NOT_VERIFIABLE' },
    { releaseId: null },
    { releaseId: '' },
    { sourceSha: null },
    { sourceSha: 'not-a-sha' },
  ];
  for (const override of cases) {
    const decision = policy.resolveProviderDecision(enabledInput({ observability: override }));
    assert.equal(decision.enabled, false, `${JSON.stringify(override)} must not enable`);
    assert.equal(decision.reason, policy.DECISION_REASONS.RELEASE_UNVERIFIABLE);
  }
  assert.equal(
    policy.resolveProviderDecision({ env: enabledInput().env, observability: null }).reason,
    policy.DECISION_REASONS.RELEASE_UNVERIFIABLE,
  );
});

test('foreign observability contract version fails OFF', () => {
  const decision = policy.resolveProviderDecision(
    enabledInput({ observability: { contractVersion: 'build30-observability-v1' } }),
  );
  assert.equal(decision.enabled, false);
  assert.equal(decision.reason, policy.DECISION_REASONS.CONTRACT_MISMATCH);
});

/* ------------------------------------------------------------------ */
/* Release identity mapping                                            */
/* ------------------------------------------------------------------ */

test('canonical K Scan release identity maps onto Sentry without a second release id', () => {
  const decision = policy.resolveProviderDecision(enabledInput());
  assert.equal(decision.enabled, true);
  assert.equal(decision.reason, 'ENABLED');

  // Sentry's release/dist ARE the K Scan identifiers.
  assert.equal(decision.release, 'staging-build29-001');
  assert.equal(decision.dist, '23');
  assert.equal(decision.environment, 'staging');

  assert.deepEqual(decision.tags, {
    release_id: 'staging-build29-001',
    source_sha: SOURCE_SHA,
    environment: 'staging',
    platform: 'ios',
    app_version: '1.0.1',
    build: '23',
  });

  const options = policy.buildProviderOptions(decision);
  assert.equal(options.release, 'staging-build29-001');
  assert.equal(options.dist, '23');
  assert.equal(options.environment, 'staging');
  assert.equal(options.dsn, VALID_DSN);
});

/* ------------------------------------------------------------------ */
/* Replay + logs                                                       */
/* ------------------------------------------------------------------ */

test('replay is disabled: no sample rates are ever emitted', () => {
  const options = policy.buildProviderOptions(policy.resolveProviderDecision(enabledInput()));
  assert.equal('replaysSessionSampleRate' in options, false);
  assert.equal('replaysOnErrorSampleRate' in options, false);
  assert.equal('_experiments' in options, false);
  assert.equal(policy.replayCanActivate(options), false);
});

test('replay integration is stripped even if the SDK offers it', () => {
  const defaults = [
    { name: 'ReactNativeErrorHandlers' },
    { name: 'MobileReplay' },
    { name: 'MobileReplayNetworkDetails' },
    { name: 'MobileReplayNetworkBodies' },
    { name: 'Screenshot' },
    { name: 'ViewHierarchy' },
    { name: 'Dedupe' },
  ];
  const kept = policy.filterProviderIntegrations(defaults).map((i) => i.name);
  assert.deepEqual(kept, ['ReactNativeErrorHandlers', 'Dedupe']);

  // The options object wires the filter itself, so the SDK's own defaults pass
  // through it at init time rather than being trusted.
  const options = policy.buildProviderOptions(policy.resolveProviderDecision(enabledInput()));
  assert.equal(typeof options.integrations, 'function');
  assert.deepEqual(options.integrations(defaults).map((i) => i.name), ['ReactNativeErrorHandlers', 'Dedupe']);
});

test('replay sample rates cannot accidentally activate replay', () => {
  // The SDK installs mobileReplayIntegration only when a replay sample rate is
  // a number. Both routes are detected, including the _experiments alias.
  assert.equal(policy.replayCanActivate({ replaysSessionSampleRate: 0.1 }), true);
  assert.equal(policy.replayCanActivate({ replaysOnErrorSampleRate: 1 }), true);
  assert.equal(policy.replayCanActivate({ _experiments: { replaysSessionSampleRate: 0.1 } }), true);
  assert.equal(policy.replayCanActivate({ integrations: [{ name: 'MobileReplay' }] }), true);
  assert.equal(policy.replayCanActivate({ replaysSessionSampleRate: undefined }), false);

  // And a replay event that somehow existed still has no path off the device.
  assert.equal(policy.sanitizeProviderEvent({ type: 'replay_event', event_id: 'x' }), null);
  assert.equal(policy.sanitizeProviderEvent({ type: 'replay_video', event_id: 'x' }), null);
});

test('Sentry structured logs are disabled and no logger call sites exist', () => {
  const options = policy.buildProviderOptions(policy.resolveProviderDecision(enabledInput()));
  assert.equal(options.enableLogs, false);

  for (const file of [
    'services/observabilitySentry.ts',
    'services/observabilitySentryPolicy.js',
    'app/_layout.tsx',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(source, /Sentry\.logger/, `${file} must not call Sentry.logger`);
    assert.doesNotMatch(source, /enableLogs:\s*true/, `${file} must not enable Sentry logs`);
  }
});

test('screenshot and view-hierarchy attachment stay off', () => {
  const options = policy.buildProviderOptions(policy.resolveProviderDecision(enabledInput()));
  assert.equal(options.attachScreenshot, false);
  assert.equal(options.attachViewHierarchy, false);
  assert.equal(options.sendDefaultPii, false);
});

/* ------------------------------------------------------------------ */
/* Request / trace correlation                                         */
/* ------------------------------------------------------------------ */

test('Sentry tracing cannot create a competing K Scan request-ID architecture', () => {
  const options = policy.buildProviderOptions(policy.resolveProviderDecision(enabledInput()));
  // Empty propagation targets => the SDK never injects sentry-trace/baggage
  // onto K Scan requests, leaving X-KScan-Request-ID and W3C traceparent as the
  // only correlation headers.
  assert.deepEqual(options.tracePropagationTargets, []);
  assert.equal(typeof options.tracesSampleRate, 'number');

  const source = fs.readFileSync(path.join(ROOT, 'services/observability.ts'), 'utf8');
  assert.match(source, /export const REQUEST_ID_HEADER = 'X-KScan-Request-ID'/);
  assert.match(source, /export const TRACEPARENT_HEADER = 'traceparent'/);
});

test('request_id and safe trace context are preserved onto provider events', () => {
  const sdk = fakeSdk();
  let observer = null;
  policy.initializeProvider(sdk, enabledInput(), { onCorrelation: (fn) => { observer = fn; } });

  assert.equal(typeof observer, 'function');
  observer({ requestId: `ksr_${'a'.repeat(32)}`, traceId: 'b'.repeat(32), traceparent: 'x', epoch: 0 });

  const tags = Object.fromEntries(sdk.calls.setTag);
  assert.equal(tags.request_id, `ksr_${'a'.repeat(32)}`);
  assert.equal(tags.trace_id, 'b'.repeat(32));
});

test('request_id and trace_id survive the outbound event boundary', () => {
  const sanitized = policy.sanitizeProviderEvent({
    event_id: 'abc',
    tags: { request_id: `ksr_${'c'.repeat(32)}`, trace_id: 'd'.repeat(32), operation: 'scan_identify' },
    contexts: { trace: { trace_id: 'd'.repeat(32), span_id: 'e'.repeat(16) } },
  });
  assert.equal(sanitized.tags.request_id, `ksr_${'c'.repeat(32)}`);
  assert.equal(sanitized.tags.trace_id, 'd'.repeat(32));
  assert.equal(sanitized.tags.operation, 'scan_identify');
  assert.equal(sanitized.contexts.trace.trace_id, 'd'.repeat(32));
});

/* ------------------------------------------------------------------ */
/* Initialization: once, and never fatal                               */
/* ------------------------------------------------------------------ */

test('Sentry initializes at most once', () => {
  const sdk = fakeSdk();
  const first = policy.initializeProvider(sdk, enabledInput());
  const second = policy.initializeProvider(sdk, enabledInput());
  const third = policy.initializeProvider(sdk, enabledInput());

  assert.equal(first.enabled, true);
  assert.equal(second.enabled, true);
  assert.equal(third.enabled, true);
  assert.equal(sdk.calls.init.length, 1);
  assert.equal(policy.providerInitCallCount(), 1);
});

test('a disabled decision performs no SDK init at all', () => {
  const sdk = fakeSdk();
  const input = enabledInput();
  delete input.env.EXPO_PUBLIC_SENTRY_DSN;
  const state = policy.initializeProvider(sdk, input);

  assert.equal(state.enabled, false);
  assert.equal(state.reason, policy.DECISION_REASONS.DSN_MISSING);
  assert.equal(sdk.calls.init.length, 0);
  assert.equal(policy.providerInitCallCount(), 0);
});

test('Sentry failure does not crash the app and leaves the provider disabled', () => {
  const sdk = fakeSdk({ throwOnInit: true });
  let state;
  assert.doesNotThrow(() => { state = policy.initializeProvider(sdk, enabledInput()); });
  assert.equal(state.enabled, false);
  assert.equal(state.reason, 'DISABLED_PROVIDER_INIT_FAILED');

  // A subsequent call must not retry into the same failure either.
  assert.doesNotThrow(() => policy.initializeProvider(sdk, enabledInput()));
  assert.equal(policy.getProviderState().enabled, false);
});

test('a hostile SDK surface cannot escalate into an app crash', () => {
  const hostile = {
    init() {},
    setTags() { throw new Error('boom'); },
    setUser() {},
    setTag() {},
    addBreadcrumb() {},
  };
  let state;
  assert.doesNotThrow(() => { state = policy.initializeProvider(hostile, enabledInput()); });
  assert.equal(state.enabled, false);
  assert.equal(state.reason, 'DISABLED_PROVIDER_INIT_FAILED');
});

test('the router root wraps only when the provider actually enabled', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/observabilitySentry.ts'), 'utf8');
  assert.match(source, /if \(!getProviderState\(\)\.enabled\) return RootComponent;/);
  assert.match(source, /catch \{\s*return RootComponent;/);
});

/* ------------------------------------------------------------------ */
/* Entrypoint authority                                                */
/* ------------------------------------------------------------------ */

test('initialization lives on the authoritative expo-router root, not the legacy app.js', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'expo-router/entry');

  const layout = fs.readFileSync(path.join(ROOT, 'app/_layout.tsx'), 'utf8');
  assert.match(layout, /initializeObservabilityProvider\(\);/);
  assert.match(layout, /export default withObservabilityRoot\(Layout\);/);

  // The wizard's edits to the non-entrypoint app.js must not have survived —
  // a second Sentry.init there would be a second, unmanaged initialization.
  const legacy = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.doesNotMatch(legacy, /Sentry/, 'app.js is not the entrypoint and must hold no Sentry code');

  // No direct `Sentry.init(` call site survives anywhere in application source:
  // the SDK is only ever started through the guarded, injected runtime, which
  // holds the one and only init call.
  // `--untracked` so the check is identical before and after these files are
  // staged; without it a brand-new init call site would be invisible.
  const grep = (pattern) => {
    try {
      return execFileSync(
        'git',
        ['grep', '-l', '--untracked', pattern, '--', '*.ts', '*.tsx', '*.js', ':(exclude)__tests__'],
        { cwd: ROOT, encoding: 'utf8' },
      ).trim().split('\n').filter(Boolean);
    } catch (err) {
      if (err.status === 1) return []; // git grep exits 1 when nothing matches
      throw err;
    }
  };
  assert.deepEqual(grep('Sentry\\.init('), [], 'no direct Sentry.init call site may exist');
  assert.deepEqual(grep('sdk\\.init('), ['services/observabilitySentryPolicy.js']);
});

/* ------------------------------------------------------------------ */
/* Privacy: identity, prompts, images, messages, email, tokens         */
/* ------------------------------------------------------------------ */

test('user identity is never attached', () => {
  const sdk = fakeSdk();
  policy.initializeProvider(sdk, enabledInput());
  assert.deepEqual(sdk.calls.setUser, [null]);

  const sanitized = policy.sanitizeProviderEvent({
    event_id: 'abc',
    user: {
      id: '8f14e45f-ceea-467a-9575-1d0a5b2a1234',
      email: 'justin.landes@gmail.com',
      ip_address: '203.0.113.9',
      username: 'justin',
    },
  });
  assert.equal('user' in sanitized, false);
});

test('prompt, AI response, image, message, email, and token metadata are rejected', () => {
  const sanitized = policy.sanitizeProviderEvent({
    event_id: 'abc',
    tags: {
      prompt: 'style me a winter outfit',
      ai_response: 'try the wool coat',
      image_url: 'https://storage.example.com/scan.jpg?token=abc123',
      message: 'private dressing room note',
      email: 'justin.landes@gmail.com',
      access_token: 'eyJhbGciOiJIUzI1NiJ9.payload.sig',
      refresh_token: 'rt_secret_value',
      storage_path: 'scans/user-uuid/frame.jpg',
      user_id: '8f14e45f-ceea-467a-9575-1d0a5b2a1234',
      raw_sql: 'select * from profiles where email = $1',
      face_signature: 'abc',
      operation: 'scan_identify',
    },
    extra: { prompt: 'leak me', image: 'data:image/jpeg;base64,/9j/4AAQ' },
    request: { url: 'https://x.test/?token=abc', data: { prompt: 'leak me' }, headers: { Authorization: 'Bearer abc' } },
  });

  // Only allowlisted operational keys survive; everything else is absent.
  assert.deepEqual(Object.keys(sanitized.tags), ['operation']);
  assert.equal(sanitized.tags.operation, 'scan_identify');
  assert.equal('extra' in sanitized, false);
  assert.equal('request' in sanitized, false);

  const serialized = JSON.stringify(sanitized);
  for (const forbidden of [
    'style me a winter outfit', 'try the wool coat', 'scan.jpg', 'private dressing room note',
    'justin.landes@gmail.com', 'eyJhbGciOiJIUzI1NiJ9', 'rt_secret_value',
    'scans/user-uuid', '8f14e45f-ceea-467a-9575-1d0a5b2a1234', 'select * from profiles',
    'Bearer abc', 'data:image/jpeg',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `event leaked: ${forbidden}`);
  }
});

test('nested unsafe metadata is redacted at depth', () => {
  const sanitized = policy.sanitizeProviderEvent({
    event_id: 'abc',
    contexts: {
      app: { app_name: 'K Scan' },
      custom: {
        level_one: {
          level_two: {
            prompt: 'nested prompt leak',
            email: 'someone@example.com',
            signed_url: 'https://cdn.test/a.jpg?signature=deadbeef',
            nested_image: 'data:image/png;base64,iVBORw0KGgo',
            safe_marker: 'ok',
          },
        },
      },
    },
  });

  const serialized = JSON.stringify(sanitized);
  for (const forbidden of [
    'nested prompt leak', 'someone@example.com', 'signature=deadbeef', 'data:image/png',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `nested leak: ${forbidden}`);
  }
  // A container the allowlist does not name is dropped WHOLE rather than
  // recursively redacted. Recursive redaction refuses values by shape, and
  // prose has no shape — `contexts.custom.note = "<a prompt>"` survived it.
  assert.equal(sanitized.contexts.custom, undefined);
  assert.equal(sanitized.contexts.app.app_name, 'K Scan');
});

test('exception values and messages are redacted, not forwarded raw', () => {
  const sanitized = policy.sanitizeProviderEvent({
    event_id: 'abc',
    message: 'failed for justin.landes@gmail.com',
    exception: {
      values: [{
        type: 'HttpError',
        value: 'POST failed with Bearer sb_secret_abcdefghijklmno',
        stacktrace: { frames: [] },
      }],
    },
  });
  assert.equal(sanitized.message, '[REDACTED]');
  assert.equal(sanitized.exception.values[0].value, '[REDACTED]');
  assert.equal(sanitized.exception.values[0].type, 'HttpError');
});

test('console, fetch, and xhr breadcrumbs are dropped entirely', () => {
  for (const category of ['console', 'fetch', 'xhr']) {
    assert.equal(
      policy.sanitizeProviderBreadcrumb({ category, message: 'prompt: leak me', data: { url: 'https://x/?token=1' } }),
      null,
      `${category} breadcrumbs must not be transmitted`,
    );
  }
  const kept = policy.sanitizeProviderBreadcrumb({
    category: 'kscan.observability',
    level: 'info',
    message: 'mobile.error',
    data: { operation: 'scan_identify', prompt: 'leak me', email: 'a@b.com' },
  });
  assert.equal(kept.message, 'mobile.error');
  assert.deepEqual(Object.keys(kept.data), ['operation']);
});

test('the provider reuses the single K Scan redaction boundary', () => {
  // One allowlist, one redactor: the TypeScript pipeline and the provider
  // adapter must not drift apart.
  const observability = fs.readFileSync(path.join(ROOT, 'services/observability.ts'), 'utf8');
  assert.match(observability, /from '\.\/observabilityRedaction'/);
  const providerSource = fs.readFileSync(path.join(ROOT, 'services/observabilitySentryPolicy.js'), 'utf8');
  assert.match(providerSource, /require\('\.\/observabilityRedaction'\)/);
});

test('sanitizers never throw on hostile or malformed input', () => {
  const hostile = [null, undefined, 0, 'string', [], { tags: 'not-an-object' }, { contexts: 7 }];
  for (const input of hostile) {
    assert.doesNotThrow(() => policy.sanitizeProviderEvent(input));
    assert.doesNotThrow(() => policy.sanitizeProviderBreadcrumb(input));
  }
  const cyclic = { event_id: 'x', contexts: { custom: {} } };
  cyclic.contexts.custom.self = cyclic.contexts.custom;
  assert.doesNotThrow(() => policy.sanitizeProviderEvent(cyclic));
});

/* ------------------------------------------------------------------ */
/* Token security                                                      */
/* ------------------------------------------------------------------ */

test('no Sentry auth token can be found in tracked files', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const TOKEN_SHAPES = [
    /\bsntrys_[A-Za-z0-9_.-]{16,}/,
    /\bsntryu_[A-Za-z0-9_.-]{16,}/,
    /^\s*auth\.token\s*=\s*\S/m,
    /SENTRY_AUTH_TOKEN\s*=\s*["']?[A-Za-z0-9_.-]{16,}/,
  ];

  const offenders = [];
  for (const file of tracked) {
    const absolute = path.join(ROOT, file);
    let contents;
    try {
      contents = fs.readFileSync(absolute);
    } catch {
      continue; // deleted or unreadable in this worktree
    }
    if (contents.includes(0)) continue; // binary
    const text = contents.toString('utf8');
    if (TOKEN_SHAPES.some((shape) => shape.test(text))) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'a Sentry auth token shape is present in tracked files');
});

test('android/sentry.properties cannot expose auth.token through Git', () => {
  const ignoreCheck = (candidate) => {
    try {
      execFileSync('git', ['check-ignore', '-q', candidate], { cwd: ROOT });
      return true;
    } catch {
      return false;
    }
  };
  for (const candidate of ['android/sentry.properties', 'ios/sentry.properties', '.env.local']) {
    assert.equal(ignoreCheck(candidate), true, `${candidate} must be gitignored`);
  }

  // Not tracked, in the index, or anywhere in history on this branch.
  const tracked = execFileSync('git', ['ls-files', '--', '*sentry.properties'], { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.equal(tracked, '', 'sentry.properties must never be tracked');

  const history = execFileSync('git', ['log', '--all', '--oneline', '--', '*sentry.properties'], {
    cwd: ROOT, encoding: 'utf8',
  }).trim();
  assert.equal(history, '', 'sentry.properties must never appear in history');

  // The local worktree copy, if present, must carry no token.
  const local = path.join(ROOT, 'android/sentry.properties');
  if (fs.existsSync(local)) {
    assert.doesNotMatch(fs.readFileSync(local, 'utf8'), /^\s*auth\.token\s*=/m);
  }
});

/* ------------------------------------------------------------------ */
/* Source-map identity + credential gate                               */
/* ------------------------------------------------------------------ */

test('source-map upload requires an environment credential', async () => {
  const upload = await import(pathToFileURL(path.join(ROOT, 'scripts/upload-observability-sourcemaps.mjs')));

  assert.deepEqual(upload.resolveUploadCredential({}).missing, ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT']);
  assert.equal(upload.resolveUploadCredential({ SENTRY_AUTH_TOKEN: 't' }).ok, false);
  assert.equal(
    upload.resolveUploadCredential({ SENTRY_AUTH_TOKEN: 't', SENTRY_ORG: 'k-scan-ai', SENTRY_PROJECT: 'react-native' }).ok,
    true,
  );

  const exportScript = await import(pathToFileURL(path.join(ROOT, 'scripts/export-observability-sourcemaps.mjs')));
  assert.equal(exportScript.resolveProviderUploadState({}).uploadState, 'BLOCKED_MISSING_PROVIDER_CREDENTIAL');
  assert.equal(
    exportScript.resolveProviderUploadState({ SENTRY_AUTH_TOKEN: 't' }).uploadState,
    'BLOCKED_MISSING_PROVIDER_TARGET',
  );
  assert.equal(
    exportScript.resolveProviderUploadState({ SENTRY_AUTH_TOKEN: 't', SENTRY_ORG: 'o', SENTRY_PROJECT: 'p' }).uploadState,
    'READY_FOR_PROVIDER_UPLOAD',
  );

  // The manifest records readiness but never the credential itself. The probe
  // value is assembled at runtime so this file never contains a token-shaped
  // literal for secret scanners to trip over.
  const syntheticToken = ['sntrys', 'NOT', 'A', 'REAL', 'TOKEN'].join('_');
  const state = exportScript.resolveProviderUploadState({
    SENTRY_AUTH_TOKEN: syntheticToken, SENTRY_ORG: 'o', SENTRY_PROJECT: 'p',
  });
  assert.equal(JSON.stringify(state).includes(syntheticToken), false);
  assert.equal(JSON.stringify(state).includes('sntrys'), false);
});

test('source-map identity still binds release, source, environment, distribution, and build', async () => {
  const exportScript = await import(pathToFileURL(path.join(ROOT, 'scripts/export-observability-sourcemaps.mjs')));
  const upload = await import(pathToFileURL(path.join(ROOT, 'scripts/upload-observability-sourcemaps.mjs')));

  const identity = {
    releaseId: 'staging-build29-001',
    sourceSha: SOURCE_SHA,
    environment: 'staging',
    distribution: 'staging',
    buildIdentifier: 'eas-build-1',
  };

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-sentry-maps-'));
  try {
    fs.writeFileSync(path.join(temp, 'index.js'), 'console.log("ok")');
    fs.writeFileSync(path.join(temp, 'index.js.map'), JSON.stringify({ version: 3, sources: ['app.ts'] }));

    const manifest = exportScript.buildSourceMapManifest(temp, identity, {
      provider: 'sentry', uploadState: 'READY_FOR_PROVIDER_UPLOAD', org: 'k-scan-ai', project: 'react-native',
    });

    assert.equal(manifest.releaseId, identity.releaseId);
    assert.equal(manifest.sourceSha, identity.sourceSha);
    assert.equal(manifest.environment, identity.environment);
    assert.equal(manifest.distribution, identity.distribution);
    assert.equal(manifest.buildIdentifier, identity.buildIdentifier);
    assert.equal(manifest.provider, 'sentry');
    assert.ok(manifest.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));

    // Identity binding survives the provider handoff.
    assert.equal(upload.assertManifestIdentityMatches(manifest, identity).ok, true);
    for (const field of ['releaseId', 'sourceSha', 'environment', 'distribution', 'buildIdentifier']) {
      const drifted = { ...identity, [field]: 'drifted' };
      const result = upload.assertManifestIdentityMatches(manifest, drifted);
      assert.equal(result.ok, false, `${field} drift must block upload`);
      assert.match(result.mismatches.join('|'), new RegExp(field));
    }

    // Local checksum verification is retained, not replaced by the provider.
    assert.equal(upload.verifyManifestChecksums(temp, manifest).ok, true);
    fs.writeFileSync(path.join(temp, 'index.js'), 'console.log("tampered")');
    const tampered = upload.verifyManifestChecksums(temp, manifest);
    assert.equal(tampered.ok, false);
    assert.match(tampered.failures.join('|'), /checksum mismatch|size mismatch/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Build configuration                                                 */
/* ------------------------------------------------------------------ */

test('EAS profiles authorize the provider only where Build 29 permits', () => {
  const eas = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
  const expected = {
    preview: { environment: 'staging', enabled: 'true' },
    staging: { environment: 'staging', enabled: 'true' },
    development: { environment: 'development', enabled: 'false' },
    production: { environment: 'production', enabled: 'false' },
  };
  for (const [profile, want] of Object.entries(expected)) {
    const env = eas.build[profile].env;
    assert.equal(env.KSCAN_OBSERVABILITY_ENVIRONMENT, want.environment, `${profile} environment`);
    assert.equal(env.EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENVIRONMENT, want.environment, `${profile} mirrored environment`);
    assert.equal(env.EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENABLED, want.enabled, `${profile} enable flag`);
    // The DSN is never committed: it must come from an EAS environment secret.
    assert.equal('EXPO_PUBLIC_SENTRY_DSN' in env, false, `${profile} must not commit a DSN`);
  }
});

test('the Expo Sentry plugin declares only non-secret provider targeting', () => {
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  const plugin = appJson.expo.plugins.find(
    (entry) => Array.isArray(entry) && entry[0] === '@sentry/react-native/expo',
  );
  assert.ok(plugin, 'the Expo Sentry plugin must remain registered for native symbol upload');
  assert.deepEqual(Object.keys(plugin[1]).sort(), ['organization', 'project', 'url']);
  assert.equal(plugin[1].organization, 'k-scan-ai');
  assert.equal(plugin[1].project, 'react-native');
  assert.doesNotMatch(JSON.stringify(appJson), /authToken|auth_token|sntrys_/i);
});

test('the governed dynamic config still owns release identity and replay-off', () => {
  const previous = {
    KSCAN_RELEASE_ID: process.env.KSCAN_RELEASE_ID,
    KSCAN_SOURCE_SHA: process.env.KSCAN_SOURCE_SHA,
    KSCAN_OBSERVABILITY_ENVIRONMENT: process.env.KSCAN_OBSERVABILITY_ENVIRONMENT,
  };
  try {
    process.env.KSCAN_RELEASE_ID = 'staging-build29-001';
    process.env.KSCAN_SOURCE_SHA = SOURCE_SHA;
    process.env.KSCAN_OBSERVABILITY_ENVIRONMENT = 'staging';
    delete require.cache[require.resolve('../app.config.js')];
    const config = require('../app.config.js')({ config: { extra: {} } });

    assert.equal(config.extra.observability.replayEnabled, false);

    // The config the app ships is exactly what the provider decision consumes.
    const decision = policy.resolveProviderDecision({
      env: { EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENABLED: 'true', EXPO_PUBLIC_SENTRY_DSN: VALID_DSN },
      observability: config.extra.observability,
      appVersion: '1.0.1',
      build: '23',
      platform: 'android',
    });
    assert.equal(decision.enabled, true);
    assert.equal(decision.release, 'staging-build29-001');
    assert.equal(decision.tags.source_sha, SOURCE_SHA);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
