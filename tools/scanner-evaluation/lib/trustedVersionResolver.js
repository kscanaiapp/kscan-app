'use strict';

/**
 * Trusted scanner-version resolver — production-neutral reference contract.
 *
 * SCOPE
 *
 * This is a PURE CONTRACT MODULE. It is deliberately NOT wired into the
 * production Edge Function in this phase. It exists so the selection semantics
 * can be specified, tested and reviewed before any deployable source is touched,
 * and so a future integration has one reviewed implementation to adopt rather
 * than an improvised one.
 *
 * IT FAILS CLOSED, IT DOES NOT THROW
 *
 * This is the single most important difference from
 * `candidateRegistry.resolveCandidate`, and the reason both exist.
 *
 * The registry THROWS on an unknown version, which is right for an evaluation
 * runner: a typo in a benchmark invocation must stop the run rather than
 * silently measure the wrong thing.
 *
 * A production request handler must never behave that way. A malformed or stale
 * server configuration must not turn every scan into a 500 — it must serve the
 * certified control. So every failure mode here resolves to `certified-v140`
 * and records WHY, and the caller always receives a usable version.
 *
 * WHAT IT MAY READ
 *
 * Exactly one field, `scannerVersion`, from a trusted server-side configuration
 * object, plus an optional injected registry of supported versions.
 *
 * WHAT IT MAY NEVER READ
 *
 * The request body, headers, query parameters, user metadata, mobile feature
 * flags, deep-link parameters, image metadata and retailer metadata. None of
 * these are parameters, so they cannot be read; and because the most realistic
 * way to breach that boundary is for a caller to pass the wrong object,
 * `looksLikeUntrustedInput` structurally rejects a configuration that carries
 * request-shaped fields. A request body handed to this resolver resolves to the
 * control, even if it contains a valid-looking `scannerVersion`.
 *
 * PURITY
 *
 * No environment access, no globals, no process-level mutable state, no
 * database, no remote configuration, no clock, no network, no provider dispatch.
 * Reading the environment belongs to the FUTURE PRODUCTION ADAPTER, which builds
 * the configuration object and hands it here; keeping that out of this module is
 * what makes the selection semantics testable in isolation.
 */

const candidateRegistry = require('./candidateRegistry');

const TRUSTED_RESOLVER_VERSION = '1.0.0';

/** The field this resolver reads. Nothing else in the configuration is consulted. */
const TRUSTED_SELECTION_FIELD = 'scannerVersion';

/** Why a particular version was resolved. Recorded so a fallback is never silent. */
const RESOLUTION_REASONS = Object.freeze({
  /** No configuration object, or the field is absent. The normal default path. */
  NO_TRUSTED_CONFIGURATION: 'no_trusted_configuration',
  /** The configuration explicitly named the certified control. */
  EXPLICIT_CONTROL: 'explicit_control',
  /** The configuration explicitly named a supported candidate. */
  EXPLICIT_CANDIDATE: 'explicit_candidate',
  /** A syntactically fine string naming a version this build does not support. */
  UNKNOWN_VERSION: 'unknown_version',
  /** The field was present but not a usable string. */
  MALFORMED_VALUE: 'malformed_value',
  /** The configuration itself was not a plain object. */
  MALFORMED_CONFIGURATION: 'malformed_configuration',
  /** The object carried request-shaped fields, so it is not trusted server config. */
  UNTRUSTED_INPUT_REJECTED: 'untrusted_input_rejected',
});

/** Reasons that mean the resolver fell back rather than honouring a selection. */
const FALLBACK_REASONS = Object.freeze([
  RESOLUTION_REASONS.UNKNOWN_VERSION,
  RESOLUTION_REASONS.MALFORMED_VALUE,
  RESOLUTION_REASONS.MALFORMED_CONFIGURATION,
  RESOLUTION_REASONS.UNTRUSTED_INPUT_REJECTED,
]);

/**
 * Fields that only ever appear on a CLIENT REQUEST, never on trusted server
 * configuration.
 *
 * Their presence means the caller passed the wrong object — a request body, a
 * header bag, a deep-link parameter set. That is a wiring mistake, and the safe
 * response is the control plus a recorded reason, not an honoured selection.
 */
const UNTRUSTED_INPUT_MARKERS = Object.freeze([
  // Scanner request contract.
  'contractVersion', 'requestId', 'intent', 'mode', 'evidence', 'source',
  'selectedCandidate', 'scanSessionId', 'imageDigestPrefix', 'privacy',
  // Transport and client surfaces.
  'headers', 'query', 'params', 'body', 'cookies', 'url', 'method',
  // Identity and client state.
  'userId', 'user', 'session', 'accessToken', 'apikey', 'authorization',
  'deepLink', 'featureFlags', 'appVersion', 'platform', 'deviceId',
  // Media and commerce metadata.
  'imageBase64', 'imageMetadata', 'exif', 'retailer', 'retailerId', 'commerce',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Does this object look like something a client controls?
 *
 * @param {object} config
 * @returns {string|null} the marker field found, or null
 */
function looksLikeUntrustedInput(config) {
  if (!isPlainObject(config)) return null;
  for (const marker of UNTRUSTED_INPUT_MARKERS) {
    // `hasOwnProperty` tests for presence without READING the property, so a
    // hostile accessor cannot run here.
    try {
      if (Object.prototype.hasOwnProperty.call(config, marker)) return marker;
    } catch {
      // A Proxy can trap even `has`. An object that resists inspection is not
      // trusted configuration.
      return marker;
    }
  }
  return null;
}

/**
 * A value safe to record in telemetry.
 *
 * The rejected value is echoed back so an operator can see WHAT was misconfigured,
 * but it is truncated and type-tagged rather than passed through, because this
 * string reaches logs and an unbounded attacker-influenced value must not.
 */
function sanitizeObservedValue(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string') return `<${Array.isArray(value) ? 'array' : typeof value}>`;
  const trimmed = value.trim();
  if (trimmed === '') return '<empty>';
  return trimmed.length > 64 ? `${trimmed.slice(0, 64)}…` : trimmed;
}

/**
 * Resolve the scanner version for one execution.
 *
 * Always returns a frozen resolution naming a supported version. Never throws.
 *
 * @param {object|null|undefined} trustedConfig trusted SERVER-SIDE configuration
 * @param {{ supportedVersions?: string[] }} [options] injected registry, for tests
 */
function resolveTrustedVersion(trustedConfig, options = {}) {
  const control = candidateRegistry.CONTROL_VERSION;
  const supported = Array.isArray(options.supportedVersions) && options.supportedVersions.length > 0
    ? options.supportedVersions
    : candidateRegistry.versions();

  const finish = (resolvedVersion, reason, observedValue) => Object.freeze({
    resolverVersion: TRUSTED_RESOLVER_VERSION,
    resolvedVersion,
    controlVersion: control,
    reason,
    isControl: resolvedVersion === control,
    fellBackToControl: FALLBACK_REASONS.includes(reason),
    observedValue: sanitizeObservedValue(observedValue),
    supportedVersions: Object.freeze([...supported]),
  });

  // Absent configuration is the NORMAL path, not an error: production runs the
  // certified control until an operator deliberately configures otherwise.
  if (trustedConfig === null || trustedConfig === undefined) {
    return finish(control, RESOLUTION_REASONS.NO_TRUSTED_CONFIGURATION, undefined);
  }
  if (!isPlainObject(trustedConfig)) {
    return finish(control, RESOLUTION_REASONS.MALFORMED_CONFIGURATION, trustedConfig);
  }

  // Wrong-object guard. Checked BEFORE the field is read, so a request body
  // carrying a valid-looking scannerVersion cannot activate a candidate.
  const untrustedMarker = looksLikeUntrustedInput(trustedConfig);
  if (untrustedMarker) {
    return finish(control, RESOLUTION_REASONS.UNTRUSTED_INPUT_REJECTED, untrustedMarker);
  }

  if (!Object.prototype.hasOwnProperty.call(trustedConfig, TRUSTED_SELECTION_FIELD)) {
    return finish(control, RESOLUTION_REASONS.NO_TRUSTED_CONFIGURATION, undefined);
  }

  // Reading a property can execute code: an accessor, or a Proxy trap. Trusted
  // configuration is normally plain parsed JSON, but "normally" is not a
  // guarantee this module gets to rely on, and the whole contract here is that a
  // production request handler never throws on bad configuration. A read that
  // explodes is treated as a malformed value, exactly like any other unusable one.
  let requested;
  try {
    requested = trustedConfig[TRUSTED_SELECTION_FIELD];
  } catch {
    return finish(control, RESOLUTION_REASONS.MALFORMED_VALUE, '<unreadable>');
  }
  if (typeof requested !== 'string' || requested.trim() === '') {
    return finish(control, RESOLUTION_REASONS.MALFORMED_VALUE, requested);
  }

  // Exact match only. No trimming-into-validity, no case folding, no alias
  // resolution: a configuration that is nearly right is still wrong, and
  // guessing at intent is how an unintended version reaches production traffic.
  if (!supported.includes(requested)) {
    return finish(control, RESOLUTION_REASONS.UNKNOWN_VERSION, requested);
  }
  if (requested === control) {
    return finish(control, RESOLUTION_REASONS.EXPLICIT_CONTROL, requested);
  }
  return finish(requested, RESOLUTION_REASONS.EXPLICIT_CANDIDATE, requested);
}

/**
 * Seal one execution's resolved version.
 *
 * The version must be immutable for the life of a single request. A handle that
 * resolved once and returns the same frozen answer forever makes that structural
 * rather than a convention: a caller cannot re-resolve mid-execution and get a
 * different answer, even if the configuration object it originally passed is
 * mutated afterwards.
 *
 * @param {object|null|undefined} trustedConfig
 * @param {{ supportedVersions?: string[] }} [options]
 */
function createExecutionResolution(trustedConfig, options = {}) {
  // Resolved eagerly and captured, so later mutation of `trustedConfig` cannot
  // change what this execution runs.
  const resolution = resolveTrustedVersion(trustedConfig, options);
  return Object.freeze({
    resolution,
    resolvedVersion: resolution.resolvedVersion,
    isControl: resolution.isControl,
    /** Always the same frozen resolution. */
    resolve: () => resolution,
  });
}

/**
 * The sanitized selection metadata a future production response or telemetry
 * event may carry.
 *
 * Ids, a reason and booleans only — never the configuration object, never an
 * instruction, never a prompt.
 */
function selectionTelemetry(resolution) {
  return Object.freeze({
    scannerVersion: resolution.resolvedVersion,
    scannerVersionReason: resolution.reason,
    scannerVersionIsControl: resolution.isControl,
    scannerVersionFellBack: resolution.fellBackToControl,
    trustedResolverVersion: resolution.resolverVersion,
  });
}

module.exports = {
  TRUSTED_RESOLVER_VERSION,
  TRUSTED_SELECTION_FIELD,
  RESOLUTION_REASONS,
  FALLBACK_REASONS,
  UNTRUSTED_INPUT_MARKERS,
  looksLikeUntrustedInput,
  sanitizeObservedValue,
  resolveTrustedVersion,
  createExecutionResolution,
  selectionTelemetry,
};
