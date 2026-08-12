'use strict';

/**
 * Build 29 Sentry provider policy.
 *
 * Sentry is the TRANSPORT for K Scan observability. It is not the source of
 * truth for release identity, request correlation, or what is safe to send.
 * Every decision that governs whether monitoring runs at all, and every payload
 * that could leave the device, is resolved here — in dependency-free CommonJS —
 * so the rules are executable under `node --test` instead of being asserted on
 * as source text through the React Native bundle.
 *
 * `services/observabilitySentry.ts` is the only caller: it hands this module the
 * environment and the governed `extra.observability` block, then applies the
 * result to the SDK. It contributes no policy of its own.
 */

const {
  buildObservabilityContext,
  isSensitiveObservabilityKey,
  redactObservabilityValue,
  safeDiagnosticToken,
  REDACTED,
} = require('./observabilityRedaction');

const OBSERVABILITY_PROVIDER = 'sentry';
const OBSERVABILITY_ENABLED_FLAG = 'EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENABLED';
const OBSERVABILITY_DSN_VAR = 'EXPO_PUBLIC_SENTRY_DSN';
const OBSERVABILITY_CONTRACT_VERSION = 'build29-observability-v1';

const SUPPORTED_ENVIRONMENTS = new Set(['development', 'staging', 'production']);

/** Sentry DSN shape: https://<publicKey>@<host>/<projectId>. */
const DSN_RE = /^https:\/\/[A-Za-z0-9]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/[0-9]+$/;

/**
 * Integrations Build 29 refuses to run, matched on the SDK's integration name.
 *
 * Replay is unauthorised (see BUILD29_SESSION_REPLAY_READINESS.md). Screenshot
 * and ViewHierarchy are refused for the same reason replay is: they attach
 * rendered app surfaces — scanner frames, garment crops, Elise conversations —
 * to ordinary error events.
 */
const FORBIDDEN_INTEGRATION_RE = /replay|screenshot|viewhierarchy/i;

/**
 * Event `contexts` entries permitted to leave the device, by container name.
 *
 * WHY AN ALLOWLIST AND NOT A REDACTOR: `redactObservabilityValue` refuses values
 * by SHAPE. Ordinary prose has no distinguishing shape, so a context container
 * named anything at all (`contexts.scanner.note`, `contexts.response.body`)
 * carried its string values off the device verbatim. Any container not named
 * here is dropped whole, so a future SDK or product integration that starts
 * attaching a new context cannot leak through it by default.
 *
 * These are the SDK's own device/app/runtime containers plus the trace context
 * that carries K Scan's correlation identity. All are content-free.
 */
const ALLOWED_EVENT_CONTEXTS = new Set([
  'device', 'os', 'app', 'runtime', 'culture', 'trace',
  'react_native_context', 'ota_updates', 'browser',
]);

/**
 * Stack-frame fields that can carry application source text rather than
 * structure. `debugSymbolicatorIntegration` populates these in development, and
 * a future integration could populate them elsewhere; frames are otherwise pure
 * structure (file, function, line, column) and are the primary diagnostic value.
 */
const SOURCE_BEARING_FRAME_KEYS = ['pre_context', 'context_line', 'post_context', 'vars'];

/** Event metadata containers that are rebuilt through the allowlist, not trusted. */
const SAFE_TAG_KEYS = [
  'release_id', 'source_sha', 'environment', 'platform', 'app_version', 'build',
  'request_id', 'trace_id', 'operation', 'screen', 'error_category',
  'provider_category', 'function_name', 'status_code', 'retry_count',
  'network_category', 'duration_bucket', 'fallback_used',
];

const DISABLED = Object.freeze({
  ENABLED: 'ENABLED',
  FLAG_MISSING: 'DISABLED_FLAG_MISSING',
  FLAG_OFF: 'DISABLED_FLAG_OFF',
  FLAG_MALFORMED: 'DISABLED_FLAG_MALFORMED',
  CONTRACT_MISMATCH: 'DISABLED_CONTRACT_MISMATCH',
  ENVIRONMENT_UNSUPPORTED: 'DISABLED_UNSUPPORTED_ENVIRONMENT',
  ENVIRONMENT_MISMATCH: 'DISABLED_ENVIRONMENT_MISMATCH',
  RELEASE_UNVERIFIABLE: 'DISABLED_RELEASE_IDENTITY_UNVERIFIABLE',
  DSN_MISSING: 'DISABLED_DSN_MISSING',
  DSN_MALFORMED: 'DISABLED_DSN_MALFORMED',
});

function readFlag(rawValue) {
  if (rawValue === undefined || rawValue === null) return { state: 'missing' };
  const normalized = String(rawValue).trim().toLowerCase();
  if (normalized === '') return { state: 'missing' };
  if (normalized === 'true') return { state: 'on' };
  if (normalized === 'false') return { state: 'off' };
  // Surrounding whitespace and letter case are normalized away first, so
  // `"TRUE "` reads as on. Anything that is not one of those two words —
  // "1", "yes", "on", "enabled" — is refused rather than guessed at.
  return { state: 'malformed' };
}

function disabled(reason) {
  return Object.freeze({
    provider: OBSERVABILITY_PROVIDER,
    enabled: false,
    reason,
    dsn: null,
    environment: null,
    release: null,
    dist: null,
    tags: Object.freeze({}),
  });
}

/**
 * Resolve whether the Sentry transport may run, and under which K Scan identity.
 *
 * Fails OFF — never on — for missing, malformed, or ambiguous configuration.
 * The app must be fully operational in every disabled case.
 */
function resolveProviderDecision(input = {}) {
  const env = input.env || {};
  const observability = input.observability || null;

  const flag = readFlag(env[OBSERVABILITY_ENABLED_FLAG]);
  if (flag.state === 'missing') return disabled(DISABLED.FLAG_MISSING);
  if (flag.state === 'off') return disabled(DISABLED.FLAG_OFF);
  if (flag.state === 'malformed') return disabled(DISABLED.FLAG_MALFORMED);

  if (!observability || typeof observability !== 'object') {
    return disabled(DISABLED.RELEASE_UNVERIFIABLE);
  }
  if (observability.contractVersion !== OBSERVABILITY_CONTRACT_VERSION) {
    return disabled(DISABLED.CONTRACT_MISMATCH);
  }

  // Exact match only. `app.config.js` emits exactly one of the three canonical
  // values, so "Production " or "STAGING" is not a near-miss to be normalized —
  // it means something rewrote the build stamp, and ambiguity fails OFF.
  const environment = observability.environment;
  if (typeof environment !== 'string' || !SUPPORTED_ENVIRONMENTS.has(environment)) {
    return disabled(DISABLED.ENVIRONMENT_UNSUPPORTED);
  }

  // A build stamped for one environment must never report into another. The
  // build-time authority (KSCAN_OBSERVABILITY_ENVIRONMENT) already validated
  // this; re-checking here keeps a repackaged bundle from crossing the line.
  const declaredEnvironment = String(env.EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENVIRONMENT || '')
    .trim()
    .toLowerCase();
  if (declaredEnvironment && declaredEnvironment !== environment) {
    return disabled(DISABLED.ENVIRONMENT_MISMATCH);
  }

  // Release identity comes from the K Scan release contract. There is no second
  // release id: if K Scan cannot verifiably attribute this build, Sentry is off
  // rather than reporting against a provider-invented release.
  const releaseId = String(observability.releaseId || '').trim();
  const sourceSha = String(observability.sourceSha || '').trim().toLowerCase();
  if (
    observability.sourceAttributionState !== 'VERIFIABLE' ||
    !releaseId ||
    !/^[a-f0-9]{40}$/.test(sourceSha)
  ) {
    return disabled(DISABLED.RELEASE_UNVERIFIABLE);
  }

  const rawDsn = env[OBSERVABILITY_DSN_VAR];
  if (rawDsn === undefined || rawDsn === null || String(rawDsn).trim() === '') {
    return disabled(DISABLED.DSN_MISSING);
  }
  const dsn = String(rawDsn).trim();
  if (!DSN_RE.test(dsn)) return disabled(DISABLED.DSN_MALFORMED);

  // `dist` MUST be whatever the source maps were filed under, or symbolication
  // silently never happens. `scripts/upload-observability-sourcemaps.mjs`
  // passes the governed build identifier as `--dist`, so when the build stamped
  // one, that identifier IS the dist. The native build number is only a
  // fallback for builds that never produced uploadable artifacts (the upload
  // refuses to run without a build identifier, so the two cannot disagree).
  const stampedBuildIdentifier = typeof observability.buildIdentifier === 'string'
    ? observability.buildIdentifier.trim()
    : '';
  const nativeBuild = input.build === undefined || input.build === null || input.build === ''
    ? null
    : String(input.build);
  const build = stampedBuildIdentifier || nativeBuild;

  // The `build` TAG stays the native build number — that is the number a human
  // reads off a device. Only `dist` follows the artifact identity.
  const tags = buildObservabilityContext({
    release_id: releaseId,
    source_sha: sourceSha,
    environment,
    platform: input.platform ?? null,
    app_version: input.appVersion ?? null,
    build: nativeBuild,
  });

  return Object.freeze({
    provider: OBSERVABILITY_PROVIDER,
    enabled: true,
    reason: DISABLED.ENABLED,
    dsn,
    environment,
    // Sentry `release`/`dist` ARE the K Scan release identity, not a parallel one.
    release: releaseId,
    dist: build,
    tags: Object.freeze(tags),
  });
}

/**
 * Drop every integration Build 29 refuses to run.
 *
 * Replay is additionally never requested (see `buildProviderOptions`, which
 * omits both replay sample rates — the SDK only installs the replay integration
 * when one of them is a number). This filter is the second, independent barrier
 * so a future sample-rate regression still cannot activate capture.
 */
function filterProviderIntegrations(integrations) {
  if (!Array.isArray(integrations)) return [];
  return integrations.filter((integration) => {
    const name = integration && typeof integration.name === 'string' ? integration.name : '';
    return !FORBIDDEN_INTEGRATION_RE.test(name);
  });
}

/** True when a set of resolved init options could ever start replay capture. */
function replayCanActivate(options) {
  if (!options || typeof options !== 'object') return false;
  const experiments = options._experiments && typeof options._experiments === 'object'
    ? options._experiments
    : {};
  const rates = [
    options.replaysSessionSampleRate,
    options.replaysOnErrorSampleRate,
    experiments.replaysSessionSampleRate,
    experiments.replaysOnErrorSampleRate,
  ];
  if (rates.some((rate) => typeof rate === 'number')) return true;
  return filterProviderIntegrations(options.integrations || []).length
    !== (Array.isArray(options.integrations) ? options.integrations.length : 0);
}

function sanitizeTagBag(bag) {
  const safe = {};
  if (!bag || typeof bag !== 'object') return safe;
  for (const key of SAFE_TAG_KEYS) {
    if (!(key in bag)) continue;
    const scoped = buildObservabilityContext({ [key]: bag[key] });
    if (key in scoped) safe[key] = scoped[key];
  }
  return safe;
}

/** Strip any source text a symbolicating integration attached to a frame. */
function sanitizeStacktrace(stacktrace) {
  if (!stacktrace || typeof stacktrace !== 'object') return stacktrace;
  if (!Array.isArray(stacktrace.frames)) return stacktrace;
  return {
    ...stacktrace,
    frames: stacktrace.frames.map((frame) => {
      if (!frame || typeof frame !== 'object') return frame;
      const next = { ...frame };
      for (const key of SOURCE_BEARING_FRAME_KEYS) delete next[key];
      return next;
    }),
  };
}

/**
 * `value` and `type` are free-text and reach the device from anywhere an `Error`
 * is constructed, including provider SDKs that put a response body in the
 * message. Both are reduced to a diagnostic token; the frames survive intact.
 */
function sanitizeExceptionValues(exception) {
  if (!exception || typeof exception !== 'object') return exception;
  const values = Array.isArray(exception.values) ? exception.values : null;
  if (!values) return exception;
  return {
    ...exception,
    values: values.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const next = { ...entry };
      if ('value' in next) next.value = safeDiagnosticToken(next.value);
      if ('type' in next) next.type = safeDiagnosticToken(next.type);
      if (next.stacktrace) next.stacktrace = sanitizeStacktrace(next.stacktrace);
      return next;
    }),
  };
}

/**
 * The `beforeSend` boundary: rebuild every outbound event from the allowlist.
 *
 * Anything not explicitly re-added is dropped, so a future SDK version that
 * starts attaching a new payload cannot leak it by default.
 */
function sanitizeProviderEvent(event) {
  if (!event || typeof event !== 'object') return null;

  // Replay envelopes have no authorised path off the device in Build 29.
  if (event.type === 'replay_event' || event.type === 'replay_video') return null;

  const safe = {
    event_id: typeof event.event_id === 'string' ? event.event_id : undefined,
    timestamp: typeof event.timestamp === 'number' ? event.timestamp : undefined,
    platform: typeof event.platform === 'string' ? event.platform : undefined,
    level: typeof event.level === 'string' ? event.level : undefined,
    environment: typeof event.environment === 'string' ? event.environment : undefined,
    release: typeof event.release === 'string' ? event.release : undefined,
    dist: typeof event.dist === 'string' ? event.dist : undefined,
    type: typeof event.type === 'string' ? event.type : undefined,
    transaction: typeof event.transaction === 'string'
      ? safeDiagnosticToken(event.transaction)
      : undefined,
    logger: typeof event.logger === 'string' ? event.logger : undefined,
    sdk: event.sdk,
    tags: sanitizeTagBag(event.tags),
    contexts: sanitizeEventContexts(event.contexts),
    breadcrumbs: Array.isArray(event.breadcrumbs)
      ? event.breadcrumbs.map(sanitizeProviderBreadcrumb).filter(Boolean).slice(-50)
      : undefined,
  };

  if (typeof event.message === 'string') {
    safe.message = safeDiagnosticToken(event.message);
  } else if (event.message && typeof event.message === 'object') {
    safe.message = redactObservabilityValue(event.message);
  }
  if (event.exception) safe.exception = sanitizeExceptionValues(event.exception);
  if (event.stacktrace) safe.stacktrace = sanitizeStacktrace(event.stacktrace);
  if (Array.isArray(event.threads?.values)) {
    safe.threads = {
      ...event.threads,
      values: event.threads.values.map((thread) => (
        thread && typeof thread === 'object' && thread.stacktrace
          ? { ...thread, stacktrace: sanitizeStacktrace(thread.stacktrace) }
          : thread
      )),
    };
  }

  // No user identity, ever — not id, not email, not IP, not username.
  // `extra`, `request`, `user`, and `attachments` are intentionally never copied.
  for (const key of Object.keys(safe)) {
    if (safe[key] === undefined) delete safe[key];
  }
  return safe;
}

/**
 * Device/app/os/runtime contexts are useful and content-free; every other
 * container is dropped whole.
 *
 * The surviving containers are still rebuilt through the redactor, so a nested
 * token, image URI, or signed URL inside an otherwise-allowed container cannot
 * ride along either.
 */
function sanitizeEventContexts(contexts) {
  if (!contexts || typeof contexts !== 'object') return undefined;
  const safe = {};
  for (const [name, value] of Object.entries(contexts)) {
    if (!ALLOWED_EVENT_CONTEXTS.has(name)) continue;
    if (FORBIDDEN_INTEGRATION_RE.test(name) || isSensitiveObservabilityKey(name)) continue;
    safe[name] = redactObservabilityValue(value);
  }
  return safe;
}

/** The `beforeBreadcrumb` boundary. */
function sanitizeProviderBreadcrumb(breadcrumb) {
  if (!breadcrumb || typeof breadcrumb !== 'object') return null;
  const category = typeof breadcrumb.category === 'string' ? breadcrumb.category : undefined;

  // Console/network breadcrumbs carry raw request bodies, prompts, and signed
  // URLs. K Scan emits its own allowlisted breadcrumbs instead.
  if (category === 'console' || category === 'xhr' || category === 'fetch') return null;

  const safe = {
    type: typeof breadcrumb.type === 'string' ? breadcrumb.type : undefined,
    category,
    level: typeof breadcrumb.level === 'string' ? breadcrumb.level : undefined,
    timestamp: typeof breadcrumb.timestamp === 'number' ? breadcrumb.timestamp : undefined,
    data: sanitizeTagBag(breadcrumb.data),
  };
  if (typeof breadcrumb.message === 'string') {
    safe.message = safeDiagnosticToken(breadcrumb.message);
  }
  for (const key of Object.keys(safe)) {
    if (safe[key] === undefined) delete safe[key];
  }
  return safe;
}

/**
 * The complete Sentry init options for an enabled decision.
 *
 * Notable absences are deliberate and load-bearing:
 *   - no `replaysSessionSampleRate` / `replaysOnErrorSampleRate` → the SDK never
 *     installs the replay integration (see getDefaultIntegrations)
 *   - no `enableLogs` → Build 29 uses the governed observability context, not
 *     provider structured logs
 *   - `tracePropagationTargets: []` → Sentry never injects sentry-trace/baggage
 *     headers, so X-KScan-Request-ID and W3C traceparent stay the only
 *     correlation architecture on K Scan requests
 */
function buildProviderOptions(decision) {
  if (!decision || !decision.enabled) return null;
  return {
    dsn: decision.dsn,
    environment: decision.environment,
    release: decision.release,
    dist: decision.dist === null ? undefined : decision.dist,
    enabled: true,

    // Privacy posture.
    sendDefaultPii: false,
    attachScreenshot: false,
    attachViewHierarchy: false,
    attachStacktrace: true,
    enableLogs: false,
    enableCaptureFailedRequests: false,
    maxBreadcrumbs: 50,

    // Errors and tracing only.
    tracesSampleRate: decision.environment === 'production' ? 0.05 : 0.2,
    tracePropagationTargets: [],

    integrations: filterProviderIntegrations,
    beforeSend: sanitizeProviderEvent,
    beforeSendTransaction: sanitizeProviderEvent,
    beforeBreadcrumb: sanitizeProviderBreadcrumb,
  };
}

/* ------------------------------------------------------------------------- *
 * Provider runtime
 *
 * The initialization sequence lives here rather than in the TypeScript binding
 * so that "initializes at most once" and "a failing SDK does not crash the app"
 * are executable assertions driven against an injected SDK, not source-text
 * claims about code that only runs inside a React Native bundle.
 * ------------------------------------------------------------------------- */

const INITIAL_STATE = Object.freeze({
  initialized: false,
  enabled: false,
  reason: DISABLED.FLAG_MISSING,
});

let runtimeState = INITIAL_STATE;
let initCallCount = 0;

function getProviderState() {
  return { ...runtimeState };
}

/** How many times the SDK's own `init` was actually invoked. */
function providerInitCallCount() {
  return initCallCount;
}

function resetProviderForTests() {
  runtimeState = INITIAL_STATE;
  initCallCount = 0;
}

/**
 * Bring the provider up exactly once.
 *
 * `sdk` is the injected Sentry surface (init/setTags/setUser/addBreadcrumb/
 * setTag). `hooks.onCorrelation` and `hooks.onSink` receive the callbacks the
 * caller should register with the K Scan observability pipeline.
 *
 * Any throw anywhere in the sequence leaves the provider disabled and the app
 * untouched: monitoring is never a runtime dependency.
 */
function initializeProvider(sdk, input = {}, hooks = {}) {
  if (runtimeState.initialized) return getProviderState();
  runtimeState = { ...runtimeState, initialized: true };

  try {
    const decision = resolveProviderDecision(input);
    runtimeState = { initialized: true, enabled: decision.enabled, reason: decision.reason };
    if (!decision.enabled) return getProviderState();

    const options = buildProviderOptions(decision);
    if (!options) {
      runtimeState = { initialized: true, enabled: false, reason: DISABLED.FLAG_MALFORMED };
      return getProviderState();
    }

    initCallCount += 1;
    sdk.init(options);
    sdk.setTags(decision.tags);

    // No user identity, ever — asserted here as well as in `beforeSend`, so a
    // provider default that starts populating it still cannot take effect.
    sdk.setUser(null);

    if (typeof hooks.onCorrelation === 'function') {
      hooks.onCorrelation((correlation) => {
        const safe = buildObservabilityContext({
          request_id: correlation && correlation.requestId,
          trace_id: correlation && correlation.traceId,
        });
        if (typeof safe.request_id === 'string') sdk.setTag('request_id', safe.request_id);
        if (typeof safe.trace_id === 'string') sdk.setTag('trace_id', safe.trace_id);
      });
    }

    if (typeof hooks.onSink === 'function') {
      hooks.onSink((eventName, context) => {
        sdk.addBreadcrumb({
          category: 'kscan.observability',
          level: 'info',
          message: eventName,
          data: context,
        });
      });
    }

    // Terminal handled failures raise a real event. `beforeSend` still rebuilds
    // it from the allowlist, so the exception message cannot carry content.
    if (typeof hooks.onException === 'function') {
      hooks.onException((error, context) => {
        sdk.captureException(error, {
          tags: sanitizeTagBag(context),
          level: 'error',
        });
      });
    }

    return getProviderState();
  } catch {
    runtimeState = { initialized: true, enabled: false, reason: 'DISABLED_PROVIDER_INIT_FAILED' };
    return getProviderState();
  }
}

module.exports = {
  getProviderState,
  providerInitCallCount,
  resetProviderForTests,
  initializeProvider,
  OBSERVABILITY_PROVIDER,
  OBSERVABILITY_ENABLED_FLAG,
  OBSERVABILITY_DSN_VAR,
  OBSERVABILITY_CONTRACT_VERSION,
  SUPPORTED_ENVIRONMENTS,
  FORBIDDEN_INTEGRATION_RE,
  ALLOWED_EVENT_CONTEXTS,
  SOURCE_BEARING_FRAME_KEYS,
  DECISION_REASONS: DISABLED,
  resolveProviderDecision,
  filterProviderIntegrations,
  replayCanActivate,
  buildProviderOptions,
  sanitizeProviderEvent,
  sanitizeProviderBreadcrumb,
};
