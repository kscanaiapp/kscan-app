/**
 * Trusted scanner version resolution (Build 4 Phase 2C).
 *
 * Follows the same env-gate pattern as BACKEND_QUALITY_TUNE_ENABLED and
 * BACKEND_SCANNER_INTELLIGENCE_ENABLED: a server-owned environment variable,
 * an injectable reader for tests, and rollback without redeploy.
 *
 *   unset / anything unrecognised → certified-v140  (the committed default)
 *   BACKEND_SCANNER_VERSION=phase2a-v1.0.0 → the Build 4 candidate
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT FAILS CLOSED, IT NEVER THROWS
 *
 * A stale, malformed or unreadable configuration must not turn every scan into
 * a 500. Every failure mode below resolves to the certified control and records
 * WHY, so a misconfiguration is visible in telemetry instead of silent — but the
 * request still succeeds on certified behaviour.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS CANNOT BE DRIVEN BY A CLIENT
 *
 * Not by policy — by signature. This module's only input is an environment
 * reader. There is no parameter for a request, a body, a header, a query
 * string, a user, a session or a device, so no client-controlled value has a
 * path to reach it. A caller cannot pass one in even by mistake, and a future
 * edit that tried to would have to change the function signature, which the
 * tests pin.
 *
 * The resolved version is also deliberately NOT part of any public request or
 * response schema: the client neither names a version nor is told which one ran.
 * That is what keeps rollback free of any mobile change.
 */

import {
  CERTIFIED_CONTROL_VERSION,
  PHASE2A_CANDIDATE_VERSION,
  SUPPORTED_SCANNER_VERSIONS,
  type ScannerVersion,
} from './scannerCandidateArtifact.ts';

/** The single server-owned switch. Server-side only; never a client input. */
export const SCANNER_VERSION_ENV_KEY = 'BACKEND_SCANNER_VERSION' as const;

/**
 * The committed default.
 *
 * This is the rollback target and the dormant state. Changing this constant is
 * an activation decision and requires the separate owner-approved activation
 * phase — it is not a configuration change.
 */
export const SCANNER_VERSION_DEFAULT: ScannerVersion = CERTIFIED_CONTROL_VERSION;

/** Why a version was resolved. Recorded so a fallback is never silent. */
export type ScannerVersionReason =
  | 'no_trusted_configuration'
  | 'explicit_control'
  | 'explicit_candidate'
  | 'unknown_version'
  | 'malformed_value'
  | 'configuration_unavailable';

export interface ScannerVersionResolution {
  readonly resolvedVersion: ScannerVersion;
  readonly controlVersion: ScannerVersion;
  readonly reason: ScannerVersionReason;
  readonly isControl: boolean;
  readonly fellBackToControl: boolean;
  /** Bounded, type-tagged echo of a rejected value. Safe for logs. */
  readonly observedValue: string | null;
}

/** Reasons that mean the resolver fell back rather than honouring a selection. */
const FALLBACK_REASONS: readonly ScannerVersionReason[] = Object.freeze([
  'unknown_version',
  'malformed_value',
  'configuration_unavailable',
]);

const defaultEnvGet = (key: string): string | undefined => {
  try {
    return Deno.env.get(key);
  } catch {
    // Deno may deny env access. Unreadable configuration is not a reason to
    // fail a scan; it is a reason to serve the certified control.
    return undefined;
  }
};

/**
 * A value safe to record in telemetry.
 *
 * The rejected value is echoed so an operator can see WHAT was misconfigured,
 * but it is truncated and type-tagged rather than passed through — this string
 * reaches logs, and an operator-supplied value of unbounded length must not.
 */
function sanitizeObservedValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return `<${typeof value}>`;
  const trimmed = value.trim();
  if (trimmed === '') return '<empty>';
  return trimmed.length > 64 ? `${trimmed.slice(0, 64)}…` : trimmed;
}

function finish(
  resolvedVersion: ScannerVersion,
  reason: ScannerVersionReason,
  observed: unknown,
): ScannerVersionResolution {
  return Object.freeze({
    resolvedVersion,
    controlVersion: CERTIFIED_CONTROL_VERSION,
    reason,
    isControl: resolvedVersion === CERTIFIED_CONTROL_VERSION,
    fellBackToControl: FALLBACK_REASONS.includes(reason),
    observedValue: sanitizeObservedValue(observed),
  });
}

/**
 * Resolve the scanner version from trusted server configuration.
 *
 * Always returns a supported version. Never throws.
 *
 * @param envGet injectable environment reader; defaults to Deno.env.get
 */
export function resolveScannerVersion(
  envGet: (key: string) => string | undefined = defaultEnvGet,
): ScannerVersionResolution {
  let raw: string | undefined;
  try {
    raw = envGet(SCANNER_VERSION_ENV_KEY);
  } catch {
    // An injected reader that throws is a configuration fault, not a request
    // fault. Serve the control and say so.
    return finish(CERTIFIED_CONTROL_VERSION, 'configuration_unavailable', '<unreadable>');
  }

  if (raw === undefined || raw === null) {
    return finish(CERTIFIED_CONTROL_VERSION, 'no_trusted_configuration', undefined);
  }
  if (typeof raw !== 'string') {
    return finish(CERTIFIED_CONTROL_VERSION, 'malformed_value', raw);
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return finish(CERTIFIED_CONTROL_VERSION, 'no_trusted_configuration', undefined);
  }

  // Exact match only. No case folding, no aliasing, no "nearly right" repair:
  // a configuration that is almost correct is still incorrect, and guessing at
  // operator intent is how an unintended version reaches live traffic.
  if (!SUPPORTED_SCANNER_VERSIONS.includes(trimmed as ScannerVersion)) {
    return finish(CERTIFIED_CONTROL_VERSION, 'unknown_version', trimmed);
  }
  if (trimmed === CERTIFIED_CONTROL_VERSION) {
    return finish(CERTIFIED_CONTROL_VERSION, 'explicit_control', trimmed);
  }
  return finish(PHASE2A_CANDIDATE_VERSION, 'explicit_candidate', trimmed);
}

/**
 * Seal one request's scanner version.
 *
 * Resolved once, eagerly, and frozen. A later environment change — or a second
 * call inside the same request — cannot alter what this request already
 * committed to, so the version cannot shift between prompt construction,
 * dispatch and telemetry. That property is what makes request identity,
 * result attribution and cache keys coherent.
 */
export function createScannerVersionResolution(
  envGet: (key: string) => string | undefined = defaultEnvGet,
): {
  readonly resolution: ScannerVersionResolution;
  readonly version: ScannerVersion;
  readonly resolve: () => ScannerVersionResolution;
} {
  const resolution = resolveScannerVersion(envGet);
  return Object.freeze({
    resolution,
    version: resolution.resolvedVersion,
    resolve: () => resolution,
  });
}

/**
 * Sanitized selection metadata for internal telemetry.
 *
 * Ids, an enum reason and booleans only. Never the environment value, never an
 * instruction, never a prompt. This is internal observability — it is NOT added
 * to any public response schema.
 */
export function scannerVersionTelemetry(resolution: ScannerVersionResolution): {
  scannerVersion: ScannerVersion;
  scannerVersionReason: ScannerVersionReason;
  scannerVersionIsControl: boolean;
  scannerVersionFellBack: boolean;
} {
  return {
    scannerVersion: resolution.resolvedVersion,
    scannerVersionReason: resolution.reason,
    scannerVersionIsControl: resolution.isControl,
    scannerVersionFellBack: resolution.fellBackToControl,
  };
}
