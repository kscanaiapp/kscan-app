/**
 * Sanitized scanner-version observability (Build 4 Phase 2C).
 *
 * WHAT PROBLEM THIS SOLVES
 *
 * The certified control and the Build 4 candidate run the SAME provider, the
 * same models, the same routing and the same timeouts. That is deliberate — it
 * is what makes them comparable — but it also means that once a scan is over,
 * nothing in the existing telemetry says which of the two produced it. Without
 * that attribution, a rollout cannot be read, a regression cannot be traced to
 * a version, and a kill-switch flip cannot be confirmed.
 *
 * This module supplies exactly that missing field, and nothing else.
 *
 * WHY A PICK-LIST INSTEAD OF AN OBJECT SPREAD
 *
 * The natural way to add telemetry is to spread whatever is in scope into a log
 * line. That is how prompts, provider payloads, image bytes and account
 * identifiers end up in logs — not by anyone deciding to log them, but by
 * nobody deciding not to. So this module cannot spread: it accepts named
 * scalars, drops anything that is not a string, number or boolean, and emits a
 * fixed key set. A caller that passes a whole request, response, error or
 * provider object gets those fields ignored rather than serialized.
 *
 * NO ALERT THRESHOLDS ARE DEFINED HERE.
 *
 * Acceptance and rollback thresholds require measured certified and candidate
 * results, which do not exist yet. Inventing numbers now would produce values
 * that later get treated as findings. They remain:
 *   TBD FROM MEASURED CERTIFIED AND CANDIDATE RESULTS
 */

import type { ScannerVersion } from './scannerCandidateArtifact.ts';
import type { ScannerVersionReason } from './scannerVersionResolver.ts';

/**
 * Terminal outcome categories, as a closed set.
 *
 * These mirror categories the function already distinguishes in its logs; this
 * type exists so an outcome cannot be recorded as free text.
 */
export type ScannerOutcomeCategory =
  | 'success'
  | 'provider_http_error'
  | 'provider_timeout'
  | 'provider_exhausted'
  | 'output_invalid'
  | 'non_fashion'
  | 'ai_disabled';

/** The exact keys this module may emit. Nothing else can reach a log line. */
export const SCANNER_OBSERVABILITY_KEYS = Object.freeze([
  'scannerVersion',
  'scannerVersionReason',
  'scannerVersionFellBack',
  'outcome',
  'providerFailureKind',
  'attemptCount',
  'fallbackUsed',
  'latencyMs',
  'promptTokenCount',
  'candidatesTokenCount',
  'totalTokenCount',
] as const);

export type ScannerObservabilityKey = typeof SCANNER_OBSERVABILITY_KEYS[number];

export type ScannerObservabilityRecord = Readonly<
  Partial<Record<ScannerObservabilityKey, string | number | boolean>>
>;

export interface ScannerObservabilityInput {
  version: ScannerVersion;
  versionReason: ScannerVersionReason;
  versionFellBack: boolean;
  outcome: ScannerOutcomeCategory;
  /** Certified provider failure kind, when one applies. */
  providerFailureKind?: string | null;
  attemptCount?: number | null;
  /** True when the certified fallback model served the request. */
  fallbackUsed?: boolean | null;
  latencyMs?: number | null;
  /**
   * Token usage, ONLY when the provider already returned it.
   *
   * The deployed scan-identify path does not currently parse usageMetadata, so
   * these are normally absent. They are accepted rather than fetched: this
   * module must never cause an extra provider call or an extra parse to
   * populate a metric.
   */
  promptTokenCount?: number | null;
  candidatesTokenCount?: number | null;
  totalTokenCount?: number | null;
}

/** A finite number, or undefined. Rejects NaN, Infinity and non-numbers. */
function finiteOrNothing(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A short, bounded enum-ish string, or undefined. */
function shortStringOrNothing(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  // Bounded: a failure kind is an enum, so anything long is a mistake, and a
  // mistake must not become an unbounded log line.
  return trimmed.length > 48 ? trimmed.slice(0, 48) : trimmed;
}

/**
 * Build the sanitized operational record.
 *
 * Every value is validated by type before it is included. Absent and invalid
 * values are OMITTED rather than emitted as null, so a log line never claims to
 * have measured something it did not.
 */
export function scannerOperationalMetadata(
  input: ScannerObservabilityInput,
): ScannerObservabilityRecord {
  const record: Partial<Record<ScannerObservabilityKey, string | number | boolean>> = {
    scannerVersion: input.version,
    scannerVersionReason: input.versionReason,
    scannerVersionFellBack: input.versionFellBack === true,
    outcome: input.outcome,
  };

  const failureKind = shortStringOrNothing(input.providerFailureKind);
  if (failureKind !== undefined) record.providerFailureKind = failureKind;

  const attempts = finiteOrNothing(input.attemptCount);
  if (attempts !== undefined) record.attemptCount = attempts;

  if (typeof input.fallbackUsed === 'boolean') record.fallbackUsed = input.fallbackUsed;

  const latency = finiteOrNothing(input.latencyMs);
  if (latency !== undefined) record.latencyMs = latency;

  const prompt = finiteOrNothing(input.promptTokenCount);
  if (prompt !== undefined) record.promptTokenCount = prompt;

  const candidates = finiteOrNothing(input.candidatesTokenCount);
  if (candidates !== undefined) record.candidatesTokenCount = candidates;

  const total = finiteOrNothing(input.totalTokenCount);
  if (total !== undefined) record.totalTokenCount = total;

  return Object.freeze(record);
}

/**
 * Render the record as a compact `key=value` string for the existing
 * console-log telemetry style.
 *
 * Iterates the fixed key list rather than the record's own keys, so a value
 * smuggled onto the object by a caller cannot be printed.
 */
export function formatScannerOperationalMetadata(
  record: ScannerObservabilityRecord,
): string {
  const parts: string[] = [];
  for (const key of SCANNER_OBSERVABILITY_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      continue;
    }
    parts.push(`${key}=${String(value)}`);
  }
  return parts.join(' ');
}
